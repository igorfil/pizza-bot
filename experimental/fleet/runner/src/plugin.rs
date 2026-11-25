//! Harness plugins run external agents. A plugin is a folder `<plugins>/<id>/plugin.toml` naming a
//! long-lived program the runner talks to over JSON lines on stdin/stdout (plugins/README.md).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

use crate::manifest::{self, AgentSpec, DEFAULT_TIMEOUT_SECS, Host, InputSpec};

#[derive(Debug, Clone, Deserialize)]
struct PluginToml {
    name: String,
    command: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PluginDef {
    pub id: String,
    pub name: String,
    pub dir: PathBuf,
    pub command: String,
    pub env: BTreeMap<String, String>,
}

pub fn parse_def(id: &str, dir: &Path, toml_text: &str) -> Result<PluginDef, String> {
    if !manifest::valid_id(id) {
        return Err(format!("plugin folder {id:?} must be lowercase letters, digits, - or _"));
    }
    let t: PluginToml = toml::from_str(toml_text).map_err(|e| format!("{id}/plugin.toml: {e}"))?;
    Ok(PluginDef { id: id.to_string(), name: t.name, dir: dir.to_path_buf(), command: t.command, env: t.env })
}

/// Every `<dir>/<id>/plugin.toml`; a folder that doesn't parse is skipped with a warning, and no folder means no plugins.
pub fn load_defs(dir: &Path) -> Vec<PluginDef> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut defs: Vec<PluginDef> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("plugin.toml").is_file())
        .filter_map(|p| {
            let id = p.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let parsed = std::fs::read_to_string(p.join("plugin.toml")).map_err(|e| e.to_string()).and_then(|t| parse_def(&id, &p, &t));
            parsed.map_err(|e| tracing::warn!(plugin = %id, "skipping plugin: {e}")).ok()
        })
        .collect();
    defs.sort_by(|a, b| a.id.cmp(&b.id));
    defs
}

/// What a plugin reports about one of its runs.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskEvent {
    Status(String),
    Artifact { name: String, text: String },
    Error(String),
    Done,
}

/// One stdout line from a plugin: the answer to a request, or news about a run.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Reply { id: u64, result: Result<Value, String> },
    Task { task_id: String, event: TaskEvent },
}

pub fn parse_line(line: &str) -> Option<Line> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    if let Some(id) = obj.get("id").and_then(Value::as_u64) {
        let result = match obj.get("error") {
            Some(e) => Err(e.as_str().map_or_else(|| e.to_string(), str::to_string)),
            None => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Some(Line::Reply { id, result });
    }
    let task_id = obj.get("taskId")?.as_str()?.to_string();
    let event = if let Some(s) = obj.get("status").and_then(Value::as_str) {
        TaskEvent::Status(s.to_string())
    } else if let Some(e) = obj.get("error").and_then(Value::as_str) {
        TaskEvent::Error(e.to_string())
    } else if let Some(a) = obj.get("artifact").and_then(Value::as_object) {
        TaskEvent::Artifact {
            name: a.get("name").and_then(Value::as_str).unwrap_or("result").to_string(),
            text: a.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
        }
    } else if obj.get("done").and_then(Value::as_bool) == Some(true) {
        TaskEvent::Done
    } else {
        return None;
    };
    Some(Line::Task { task_id, event })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentJson {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    input: Option<InputSpec>,
    timeout_secs: Option<u64>,
}

/// The agents a plugin offers, as specs it hosts; ids unsafe for URLs are dropped.
pub fn agents_from(plugin: &str, result: &Value) -> Vec<AgentSpec> {
    let list: Vec<AgentJson> = result.get("agents").cloned().and_then(|a| serde_json::from_value(a).ok()).unwrap_or_default();
    list.into_iter()
        .filter(|a| manifest::valid_id(&a.id))
        .map(|a| AgentSpec {
            id: a.id,
            name: a.name,
            description: a.description,
            timeout_secs: a.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS),
            input: a.input,
            host: Host::Plugin(plugin.to_string()),
        })
        .collect()
}

/// What the index says about a plugin.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub healthy: bool,
    pub detail: String,
}

struct Conn {
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    tasks: Mutex<HashMap<String, mpsc::UnboundedSender<TaskEvent>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    _child: Mutex<Child>,
}

impl Conn {
    /// The plugin is gone: every waiting request fails, and every run ends with the reason.
    fn close(&self, why: &str) {
        self.alive.store(false, Ordering::SeqCst);
        self.pending.lock().unwrap().drain().for_each(|(_, tx)| {
            let _ = tx.send(Err(why.to_string()));
        });
        self.tasks.lock().unwrap().drain().for_each(|(_, tx)| {
            let _ = tx.send(TaskEvent::Error(why.to_string()));
            let _ = tx.send(TaskEvent::Done);
        });
    }

    fn route(&self, line: Line) {
        match line {
            Line::Reply { id, result } => {
                if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(result);
                }
            }
            Line::Task { task_id, event } => {
                let mut tasks = self.tasks.lock().unwrap();
                let done = event == TaskEvent::Done;
                if let Some(tx) = tasks.get(&task_id) {
                    let _ = tx.send(event);
                }
                if done {
                    tasks.remove(&task_id);
                }
            }
        }
    }
}

pub struct Plugin {
    pub def: PluginDef,
    conn: tokio::sync::Mutex<Option<Arc<Conn>>>,
    info: RwLock<PluginInfo>,
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

impl Plugin {
    pub fn new(def: PluginDef) -> Self {
        let info = PluginInfo {
            id: def.id.clone(),
            name: def.name.clone(),
            version: String::new(),
            capabilities: vec![],
            healthy: false,
            detail: "starting".to_string(),
        };
        Self { def, conn: tokio::sync::Mutex::new(None), info: RwLock::new(info) }
    }

    pub fn info(&self) -> PluginInfo {
        self.info.read().unwrap().clone()
    }

    fn set_health(&self, healthy: bool, detail: String) {
        let mut info = self.info.write().unwrap();
        info.healthy = healthy;
        info.detail = detail;
    }

    fn spawn(&self) -> Result<Arc<Conn>, String> {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(&self.def.command)
            .current_dir(&self.def.dir)
            .envs(&self.def.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("could not start the {} plugin ({:?}): {e}", self.def.id, self.def.command))?;
        let stdin = child.stdin.take().ok_or("the plugin's stdin isn't piped")?;
        let stdout = child.stdout.take().ok_or("the plugin's stdout isn't piped")?;
        if let Some(stderr) = child.stderr.take() {
            let plugin = self.def.id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(plugin = %plugin, "{line}");
                }
            });
        }
        let conn = Arc::new(Conn {
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            _child: Mutex::new(child),
        });
        let (reader, plugin) = (conn.clone(), self.def.id.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match parse_line(&line) {
                    Some(l) => reader.route(l),
                    None => tracing::debug!(plugin = %plugin, "ignored stdout line: {line}"),
                }
            }
            tracing::warn!(plugin = %plugin, "plugin exited");
            reader.close(&format!("the {plugin} plugin stopped"));
        });
        Ok(conn)
    }

    /// The running plugin, started again if it exited.
    async fn conn(&self) -> Result<Arc<Conn>, String> {
        let mut slot = self.conn.lock().await;
        if let Some(c) = slot.as_ref().filter(|c| c.alive.load(Ordering::SeqCst)) {
            return Ok(c.clone());
        }
        let c = self.spawn()?;
        *slot = Some(c.clone());
        Ok(c)
    }

    async fn send(conn: &Conn, message: &Value) -> Result<(), String> {
        let mut stdin = conn.stdin.lock().await;
        let line = format!("{message}\n");
        stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let conn = self.conn().await?;
        let id = conn.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        conn.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = Self::send(&conn, &json!({ "id": id, "method": method, "params": params })).await {
            conn.pending.lock().unwrap().remove(&id);
            return Err(format!("the {} plugin isn't listening: {e}", self.def.id));
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("the {} plugin stopped", self.def.id)),
            Err(_) => {
                conn.pending.lock().unwrap().remove(&id);
                Err(format!("the {} plugin didn't answer {method} within {}s", self.def.id, REQUEST_TIMEOUT.as_secs()))
            }
        }
    }

    /// Asks for its name, version and capabilities, then its health; the index shows the outcome.
    pub async fn check(&self) {
        let described = self.request("describe", json!({})).await;
        if let Ok(d) = &described {
            let mut info = self.info.write().unwrap();
            info.name = d.get("name").and_then(Value::as_str).unwrap_or(&self.def.name).to_string();
            info.version = d.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
            info.capabilities = d.get("capabilities").cloned().and_then(|c| serde_json::from_value(c).ok()).unwrap_or_default();
        }
        let health = match described {
            Err(e) => Err(e),
            Ok(_) => self.request("health", json!({})).await,
        };
        match health {
            Ok(h) => self.set_health(
                h.get("ok").and_then(Value::as_bool).unwrap_or(false),
                h.get("detail").and_then(Value::as_str).unwrap_or_default().to_string(),
            ),
            Err(e) => self.set_health(false, e),
        }
    }

    pub async fn agents(&self) -> Result<Vec<AgentSpec>, String> {
        self.request("agents", json!({})).await.map(|r| agents_from(&self.def.id, &r))
    }

    /// Starts a run; its events arrive on the receiver, ending with `Done`.
    pub async fn run(&self, task_id: &str, context_id: &str, agent: &str, input: &str) -> Result<mpsc::UnboundedReceiver<TaskEvent>, String> {
        let conn = self.conn().await?;
        let (tx, rx) = mpsc::unbounded_channel();
        conn.tasks.lock().unwrap().insert(task_id.to_string(), tx);
        let started = self.request("run", json!({ "taskId": task_id, "contextId": context_id, "agent": agent, "input": input })).await;
        if let Err(e) = started {
            conn.tasks.lock().unwrap().remove(task_id);
            return Err(e);
        }
        Ok(rx)
    }

    pub async fn cancel(&self, task_id: &str) {
        if let Err(e) = self.request("cancel", json!({ "taskId": task_id })).await {
            tracing::warn!(plugin = %self.def.id, task = %task_id, "cancel failed: {e}");
        }
    }
}

/// Every plugin the runner loaded, by id.
#[derive(Clone, Default)]
pub struct Plugins(Arc<BTreeMap<String, Arc<Plugin>>>);

impl Plugins {
    pub fn new(defs: Vec<PluginDef>) -> Self {
        Self(Arc::new(defs.into_iter().map(|d| (d.id.clone(), Arc::new(Plugin::new(d)))).collect()))
    }

    pub fn get(&self, id: &str) -> Option<Arc<Plugin>> {
        self.0.get(id).cloned()
    }

    pub fn all(&self) -> Vec<Arc<Plugin>> {
        self.0.values().cloned().collect()
    }

    pub fn infos(&self) -> Vec<PluginInfo> {
        self.0.values().map(|p| p.info()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_reply() {
        assert_eq!(parse_line(r#"{"id":3,"result":{"ok":true}}"#), Some(Line::Reply { id: 3, result: Ok(json!({"ok": true})) }));
    }

    #[test]
    fn parses_a_refusal() {
        assert_eq!(parse_line(r#"{"id":4,"error":"no agent x"}"#), Some(Line::Reply { id: 4, result: Err("no agent x".into()) }));
    }

    #[test]
    fn parses_run_events() {
        let lines = [
            r#"{"taskId":"t","status":"step 1"}"#,
            r#"{"taskId":"t","artifact":{"name":"r","text":"hi"}}"#,
            r#"{"taskId":"t","error":"boom"}"#,
            r#"{"taskId":"t","done":true}"#,
        ];
        let events: Vec<Option<Line>> = lines.iter().map(|l| parse_line(l)).collect();
        let task = |event| Some(Line::Task { task_id: "t".into(), event });
        assert_eq!(
            events,
            vec![
                task(TaskEvent::Status("step 1".into())),
                task(TaskEvent::Artifact { name: "r".into(), text: "hi".into() }),
                task(TaskEvent::Error("boom".into())),
                task(TaskEvent::Done),
            ]
        );
    }

    #[test]
    fn ignores_noise() {
        assert_eq!([parse_line("Installed 3 packages"), parse_line(r#"{"taskId":"t","progress":1}"#)], [None, None]);
    }

    #[test]
    fn reads_the_plugin_folder() {
        let def = parse_def("python", Path::new("/p"), "name = \"Python\"\ncommand = \"python3 plugin.py\"\n[env]\nX = \"1\"").unwrap();
        assert_eq!((def.name.as_str(), def.command.as_str(), def.env["X"].as_str()), ("Python", "python3 plugin.py", "1"));
    }

    #[test]
    fn turns_listed_agents_into_specs_it_hosts() {
        let result = json!({"agents": [
            {"id": "slow", "name": "Slow", "timeoutSecs": 30, "input": {"label": "Plan"}},
            {"id": "Bad Id", "name": "x"}
        ]});
        let specs = agents_from("python", &result);
        let s = &specs[0];
        assert_eq!(
            (specs.len(), s.id.as_str(), s.timeout_secs, s.input.as_ref().map(|i| i.label.as_str()), &s.host),
            (1, "slow", 30, Some("Plan"), &Host::Plugin("python".into()))
        );
    }

    #[test]
    fn skips_a_plugin_folder_that_doesnt_parse() {
        let dir = std::env::temp_dir().join(format!("fleet-plugins-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("good")).unwrap();
        std::fs::create_dir_all(dir.join("bad")).unwrap();
        std::fs::write(dir.join("good/plugin.toml"), "name = \"Good\"\ncommand = \"true\"").unwrap();
        std::fs::write(dir.join("bad/plugin.toml"), "name = ").unwrap();
        let ids: Vec<String> = load_defs(&dir).into_iter().map(|d| d.id).collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(ids, vec!["good".to_string()]);
    }

    #[tokio::test]
    async fn talks_to_a_plugin_process() {
        let dir = std::env::temp_dir().join(format!("fleet-plugin-echo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A plugin in shell: answers describe, health and agents, and runs one task to completion.
        let script = r#"while read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"describe"'*) echo "{\"id\":$id,\"result\":{\"name\":\"Echo\",\"version\":\"1\",\"capabilities\":[\"cancel\"]}}" ;;
    *'"health"'*) echo "{\"id\":$id,\"result\":{\"ok\":true,\"detail\":\"fine\"}}" ;;
    *'"agents"'*) echo "{\"id\":$id,\"result\":{\"agents\":[{\"id\":\"echo\",\"name\":\"Echo\"}]}}" ;;
    *'"run"'*) echo "{\"id\":$id,\"result\":{}}"; echo '{"taskId":"t1","status":"working"}'; echo '{"taskId":"t1","artifact":{"name":"reply","text":"hi"}}'; echo '{"taskId":"t1","done":true}' ;;
  esac
done"#;
        std::fs::write(dir.join("plugin.sh"), script).unwrap();
        let plugin = Plugin::new(PluginDef { id: "echo".into(), name: "Echo".into(), dir: dir.clone(), command: "sh plugin.sh".into(), env: BTreeMap::new() });
        plugin.check().await;
        let agents: Vec<String> = plugin.agents().await.unwrap().into_iter().map(|a| a.id).collect();
        let mut rx = plugin.run("t1", "c1", "echo", "hello").await.unwrap();
        let mut events = vec![];
        while let Some(e) = rx.recv().await {
            let done = e == TaskEvent::Done;
            events.push(e);
            if done {
                break;
            }
        }
        let info = plugin.info();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            (info.healthy, info.version.as_str(), info.capabilities, agents, events),
            (
                true,
                "1",
                vec!["cancel".to_string()],
                vec!["echo".to_string()],
                vec![TaskEvent::Status("working".into()), TaskEvent::Artifact { name: "reply".into(), text: "hi".into() }, TaskEvent::Done]
            )
        );
    }

    #[tokio::test]
    async fn a_plugin_that_exits_ends_its_runs_with_the_reason() {
        let dir = std::env::temp_dir().join(format!("fleet-plugin-crash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.sh"), "read -r line; id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([0-9]*\\).*/\\1/p'); echo \"{\\\"id\\\":$id,\\\"result\\\":{}}\"; exit 3").unwrap();
        let plugin = Plugin::new(PluginDef { id: "crash".into(), name: "Crash".into(), dir: dir.clone(), command: "sh plugin.sh".into(), env: BTreeMap::new() });
        let mut rx = plugin.run("t1", "c1", "x", "").await.unwrap();
        let (first, second) = (rx.recv().await, rx.recv().await);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((first, second), (Some(TaskEvent::Error("the crash plugin stopped".into())), Some(TaskEvent::Done)));
    }
}
