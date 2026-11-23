use std::sync::{Arc, Mutex};

use a2a::*;
use a2a_server::TaskStore;
use a2a_server::task_store::TaskVersion;
use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension, params};

/// One SQLite store shared by every agent the runner hosts; task ids are unique across agents.
#[derive(Clone)]
pub struct SharedStore(pub Arc<SqliteTaskStore>);

#[async_trait]
impl TaskStore for SharedStore {
    async fn create(&self, task: Task) -> Result<TaskVersion, A2AError> {
        self.0.create(task).await
    }
    async fn update(&self, task: Task) -> Result<TaskVersion, A2AError> {
        self.0.update(task).await
    }
    async fn get(&self, task_id: &str) -> Result<Option<Task>, A2AError> {
        self.0.get(task_id).await
    }
    async fn list(&self, req: &ListTasksRequest) -> Result<ListTasksResponse, A2AError> {
        self.0.list(req).await
    }
    async fn begin_cancel(&self, task_id: &str) -> Result<Task, A2AError> {
        self.0.begin_cancel(task_id).await
    }
}

pub struct SqliteTaskStore {
    conn: Mutex<Connection>,
}

fn db_err(e: impl std::fmt::Display) -> A2AError {
    tracing::error!(error = %e, "task store error");
    A2AError::internal("task store error")
}

fn decode(json: &str) -> Result<Task, A2AError> {
    serde_json::from_str(json).map_err(db_err)
}

fn encode(task: &Task) -> Result<String, A2AError> {
    serde_json::to_string(task).map_err(db_err)
}

fn truncate_history(mut task: Task, history_length: Option<i32>) -> Task {
    if let (Some(n), Some(history)) = (history_length, task.history.as_mut()) {
        let keep = n.max(0) as usize;
        if history.len() > keep {
            history.drain(..history.len() - keep);
        }
    }
    task
}

impl SqliteTaskStore {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS tasks (
               id TEXT PRIMARY KEY,
               version INTEGER NOT NULL,
               json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// The agents last chosen over `PUT /agents`; None until the Controller first sets them.
    pub fn served_agents(&self) -> rusqlite::Result<Option<Vec<String>>> {
        let conn = self.conn.lock().unwrap();
        let value: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'served_agents'", [], |r| r.get(0))
            .optional()?;
        Ok(value.map(|v| serde_json::from_str(&v).unwrap_or_default()))
    }

    pub fn set_served_agents(&self, ids: &[String]) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('served_agents', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![serde_json::to_string(ids).unwrap_or_default()],
        )?;
        Ok(())
    }

    /// Work that was running when the process died cannot be resumed by the fake agent,
    /// so it is failed rather than left `working` forever.
    pub fn fail_orphans(&self) -> Result<usize, A2AError> {
        let conn = self.conn.lock().unwrap();
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT id, json FROM tasks")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect()
            })
            .map_err(db_err)?;
        let orphans: Vec<Task> = rows
            .iter()
            .map(|(_, json)| decode(json))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|t| matches!(t.status.state, TaskState::Submitted | TaskState::Working))
            .map(|mut t| {
                t.status = TaskStatus {
                    state: TaskState::Failed,
                    message: Some(Message::new(
                        Role::Agent,
                        vec![Part::text("runner restarted while task was running")],
                    )),
                    timestamp: Some(chrono::Utc::now()),
                };
                t
            })
            .collect();
        for t in &orphans {
            conn.execute(
                "UPDATE tasks SET json = ?1, version = version + 1 WHERE id = ?2",
                params![encode(t)?, t.id],
            )
            .map_err(db_err)?;
        }
        Ok(orphans.len())
    }
}

#[async_trait]
impl TaskStore for SqliteTaskStore {
    async fn create(&self, task: Task) -> Result<TaskVersion, A2AError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tasks (id, version, json) VALUES (?1, 1, ?2)",
            params![task.id, encode(&task)?],
        )
        .map_err(db_err)?;
        Ok(1)
    }

    async fn update(&self, task: Task) -> Result<TaskVersion, A2AError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(db_err)?;
        let existing: Option<(i64, String)> = tx
            .query_row(
                "SELECT version, json FROM tasks WHERE id = ?1",
                params![task.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        let (version, json) = existing.ok_or_else(|| A2AError::task_not_found(&task.id))?;
        let current = decode(&json)?;
        if current.status.state.is_terminal() && current.status.state != task.status.state {
            return Err(A2AError::invalid_request(format!(
                "task {} is terminal and cannot change state",
                task.id
            )));
        }
        let next = version + 1;
        tx.execute(
            "UPDATE tasks SET json = ?1, version = ?2 WHERE id = ?3",
            params![encode(&task)?, next, task.id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(next as TaskVersion)
    }

    async fn get(&self, task_id: &str) -> Result<Option<Task>, A2AError> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT json FROM tasks WHERE id = ?1",
            params![task_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(db_err)?
        .map(|json| decode(&json))
        .transpose()
    }

    async fn list(&self, req: &ListTasksRequest) -> Result<ListTasksResponse, A2AError> {
        let conn = self.conn.lock().unwrap();
        let jsons: Vec<String> = conn
            .prepare("SELECT json FROM tasks ORDER BY id")
            .and_then(|mut stmt| stmt.query_map([], |r| r.get(0))?.collect())
            .map_err(db_err)?;
        let tasks: Vec<Task> = jsons
            .iter()
            .map(|j| decode(j))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|t| req.context_id.as_ref().is_none_or(|c| &t.context_id == c))
            .filter(|t| req.status.as_ref().is_none_or(|s| &t.status.state == s))
            .collect();
        let total = tasks.len();
        let page_size = req.page_size.filter(|n| *n > 0).unwrap_or(50) as usize;
        let start = req
            .page_token
            .as_deref()
            .filter(|t| !t.is_empty())
            .map(|t| t.parse::<usize>())
            .transpose()
            .map_err(|_| A2AError::invalid_params("invalid page token"))?
            .unwrap_or(0)
            .min(total);
        let end = (start + page_size).min(total);
        Ok(ListTasksResponse {
            tasks: tasks[start..end]
                .iter()
                .cloned()
                .map(|t| truncate_history(t, req.history_length))
                .collect(),
            next_page_token: if end < total {
                end.to_string()
            } else {
                String::new()
            },
            page_size: page_size as i32,
            total_size: total as i32,
        })
    }

    async fn begin_cancel(&self, task_id: &str) -> Result<Task, A2AError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(db_err)?;
        let json: String = tx
            .query_row(
                "SELECT json FROM tasks WHERE id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .ok_or_else(|| A2AError::task_not_found(task_id))?;
        let mut task = decode(&json)?;
        if task.status.state.is_terminal() {
            return Err(A2AError::task_not_cancelable(task_id));
        }
        task.status.state = TaskState::Canceled;
        task.status.timestamp = Some(chrono::Utc::now());
        tx.execute(
            "UPDATE tasks SET json = ?1, version = version + 1 WHERE id = ?2",
            params![encode(&task)?, task_id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(task)
    }
}
