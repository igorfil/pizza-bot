use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use a2a::event::StreamResponse;
use a2a::*;
use a2a_server::{AgentExecutor, ExecutorContext};
use futures::stream::BoxStream;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Notify;

use crate::engine::Engine;
use crate::events::{artifact, prompt_text, status};
use crate::manifest::{AgentSpec, EngineAgent, Host};
use crate::plugin::{Plugins, TaskEvent};

const KILL_GRACE: Duration = Duration::from_secs(5);
const STDERR_TAIL: usize = 20;

/// One stdout line of the agent contract (agents/README.md).
#[derive(Debug, PartialEq)]
pub enum Event {
    Status(String),
    Artifact { name: String, text: String },
    Error(String),
}

pub fn parse_line(line: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = v.as_object()?;
    if let Some(s) = obj.get("status").and_then(Value::as_str) {
        return Some(Event::Status(s.to_string()));
    }
    if let Some(e) = obj.get("error").and_then(Value::as_str) {
        return Some(Event::Error(e.to_string()));
    }
    let a = obj.get("artifact")?.as_object()?;
    Some(Event::Artifact {
        name: a.get("name").and_then(Value::as_str).unwrap_or("result").to_string(),
        text: a.get("text").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

/// Final state from how the process ended. `None` code = killed by a signal.
pub fn outcome(code: Option<i32>, error: Option<&str>, last_stderr: Option<&str>, last_status: Option<&str>) -> (TaskState, String) {
    match (code, error) {
        (Some(0), None) => (TaskState::Completed, last_status.unwrap_or("done").to_string()),
        (_, Some(e)) => (TaskState::Failed, e.to_string()),
        (code, None) => {
            let fallback = code.map_or("killed by a signal".to_string(), |c| format!("exited with code {c}"));
            (TaskState::Failed, last_stderr.map(str::to_string).unwrap_or(fallback))
        }
    }
}

/// Live runs by task id, so `cancel` can reach the process.
#[derive(Clone, Default)]
pub struct Runs(Arc<Mutex<HashMap<String, Arc<Notify>>>>);

impl Runs {
    fn register(&self, task_id: &str) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        self.0.lock().unwrap().insert(task_id.to_string(), notify.clone());
        notify
    }

    fn finish(&self, task_id: &str) {
        self.0.lock().unwrap().remove(task_id);
    }

    fn cancel(&self, task_id: &str) {
        if let Some(n) = self.0.lock().unwrap().get(task_id) {
            n.notify_one();
        }
    }
}

pub struct ExecAgent {
    pub spec: Arc<AgentSpec>,
    pub runs: Runs,
    pub engine: Arc<Engine>,
    pub plugins: Plugins,
    pub mcp_config: Arc<PathBuf>,
}

fn signal_group(child: &Child, signal: i32) {
    if let Some(pid) = child.id() {
        // The agent runs in its own process group, so `uv run` and the Python it starts both get the signal.
        unsafe {
            libc::kill(-(pid as i32), signal);
        }
    }
}

async fn stop(child: &mut Child) {
    signal_group(child, libc::SIGTERM);
    if tokio::time::timeout(KILL_GRACE, child.wait()).await.is_err() {
        signal_group(child, libc::SIGKILL);
        let _ = child.wait().await;
    }
}

/// What an engine run gets on top of the runner's environment, including the runner's MCP library and the agent's picks.
pub fn run_env(agent: &EngineAgent, task_id: &str, mcp_config: &Path) -> Vec<(String, String)> {
    let extra = [
        ("FLEET_TASK_ID", task_id.to_string()),
        ("FLEET_MCP_CONFIG", mcp_config.display().to_string()),
        ("FLEET_MCP_SERVERS", agent.mcp.join(",")),
    ];
    agent.env.iter().map(|(k, v)| (k.clone(), v.clone())).chain(extra.map(|(k, v)| (k.to_string(), v))).collect()
}

fn spawn(agent: &EngineAgent, command: &str, task_id: &str, mcp_config: &Path) -> std::io::Result<Child> {
    Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(&agent.dir)
        .envs(run_env(agent, task_id, mcp_config))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
}

type Events = BoxStream<'static, Result<StreamResponse, A2AError>>;

impl ExecAgent {
    /// One engine process per run, speaking the agent contract (agents/README.md).
    fn run_on_engine(&self, agent: EngineAgent, task_id: String, context_id: String, input: String) -> Events {
        let spec = self.spec.clone();
        let runs = self.runs.clone();
        let command = self.engine.command();
        let mcp_config = self.mcp_config.clone();

        Box::pin(async_stream::stream! {
            let command = match command {
                Ok(c) => c,
                Err(e) => {
                    yield Ok(status(&task_id, &context_id, TaskState::Failed, &e));
                    return;
                }
            };
            let mut child = match spawn(&agent, &command, &task_id, &mcp_config) {
                Ok(c) => c,
                Err(e) => {
                    yield Ok(status(&task_id, &context_id, TaskState::Failed, &format!("could not start {command:?}: {e}")));
                    return;
                }
            };
            let cancelled = runs.register(&task_id);
            yield Ok(status(&task_id, &context_id, TaskState::Working, "starting"));

            if let Some(mut stdin) = child.stdin.take() {
                let payload = json!({ "taskId": task_id, "contextId": context_id, "input": input }).to_string();
                let _ = stdin.write_all(payload.as_bytes()).await;
            }

            let tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
            if let Some(stderr) = child.stderr.take() {
                let (tail, agent) = (tail.clone(), spec.id.clone());
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        tracing::info!(agent = %agent, "{line}");
                        let mut t = tail.lock().unwrap();
                        if t.len() == STDERR_TAIL { t.pop_front(); }
                        t.push_back(line);
                    }
                });
            }

            let mut stdout = BufReader::new(child.stdout.take().expect("stdout is piped")).lines();
            let deadline = tokio::time::sleep(Duration::from_secs(spec.timeout_secs));
            tokio::pin!(deadline);
            let (mut error, mut last_status) = (None::<String>, None::<String>);

            loop {
                tokio::select! {
                    line = stdout.next_line() => match line {
                        Ok(Some(line)) => match parse_line(&line) {
                            Some(Event::Status(s)) => {
                                last_status = Some(s.clone());
                                yield Ok(status(&task_id, &context_id, TaskState::Working, &s));
                            }
                            Some(Event::Artifact { name, text }) => yield Ok(artifact(&task_id, &context_id, &name, text)),
                            Some(Event::Error(e)) => error = Some(e),
                            None => tracing::debug!(agent = %spec.id, "ignored stdout line: {line}"),
                        },
                        _ => break,
                    },
                    _ = cancelled.notified() => {
                        stop(&mut child).await;
                        runs.finish(&task_id);
                        return;
                    }
                    _ = &mut deadline => {
                        stop(&mut child).await;
                        runs.finish(&task_id);
                        yield Ok(status(&task_id, &context_id, TaskState::Failed, &format!("timed out after {}s", spec.timeout_secs)));
                        return;
                    }
                }
            }

            let code = child.wait().await.ok().and_then(|s| s.code());
            runs.finish(&task_id);
            let last_stderr = tail.lock().unwrap().back().cloned();
            let (state, text) = outcome(code, error.as_deref(), last_stderr.as_deref(), last_status.as_deref());
            yield Ok(status(&task_id, &context_id, state, &text));
        })
    }

    /// The plugin runs it; the runner relays its events and still owns the timeout.
    fn run_on_plugin(&self, plugin_id: String, task_id: String, context_id: String, input: String) -> Events {
        let spec = self.spec.clone();
        let runs = self.runs.clone();
        let plugin = self.plugins.get(&plugin_id);

        Box::pin(async_stream::stream! {
            let Some(plugin) = plugin else {
                yield Ok(status(&task_id, &context_id, TaskState::Failed, &format!("this runner has no {plugin_id} plugin")));
                return;
            };
            let mut events = match plugin.run(&task_id, &context_id, &spec.id, &input).await {
                Ok(rx) => rx,
                Err(e) => {
                    yield Ok(status(&task_id, &context_id, TaskState::Failed, &e));
                    return;
                }
            };
            let cancelled = runs.register(&task_id);
            yield Ok(status(&task_id, &context_id, TaskState::Working, "starting"));
            let deadline = tokio::time::sleep(Duration::from_secs(spec.timeout_secs));
            tokio::pin!(deadline);
            let (mut error, mut last_status) = (None::<String>, None::<String>);

            loop {
                tokio::select! {
                    event = events.recv() => match event {
                        Some(TaskEvent::Status(s)) => {
                            last_status = Some(s.clone());
                            yield Ok(status(&task_id, &context_id, TaskState::Working, &s));
                        }
                        Some(TaskEvent::Artifact { name, text }) => yield Ok(artifact(&task_id, &context_id, &name, text)),
                        Some(TaskEvent::Error(e)) => error = Some(e),
                        Some(TaskEvent::Done) | None => break,
                    },
                    _ = cancelled.notified() => {
                        plugin.cancel(&task_id).await;
                        runs.finish(&task_id);
                        return;
                    }
                    _ = &mut deadline => {
                        plugin.cancel(&task_id).await;
                        runs.finish(&task_id);
                        yield Ok(status(&task_id, &context_id, TaskState::Failed, &format!("timed out after {}s", spec.timeout_secs)));
                        return;
                    }
                }
            }

            runs.finish(&task_id);
            let (state, text) = match error {
                Some(e) => (TaskState::Failed, e),
                None => (TaskState::Completed, last_status.unwrap_or_else(|| "done".to_string())),
            };
            yield Ok(status(&task_id, &context_id, state, &text));
        })
    }
}

impl AgentExecutor for ExecAgent {
    fn execute(&self, ctx: ExecutorContext) -> Events {
        let (task_id, context_id) = ctx.task_info();
        let input = prompt_text(&ctx);
        match self.spec.host.clone() {
            Host::Engine(agent) => self.run_on_engine(agent, task_id, context_id, input),
            Host::Plugin(plugin) => self.run_on_plugin(plugin, task_id, context_id, input),
        }
    }

    fn cancel(&self, ctx: ExecutorContext) -> Events {
        let (task_id, context_id) = ctx.task_info();
        self.runs.cancel(&task_id);
        let event = status(&task_id, &context_id, TaskState::Canceled, "canceled");
        Box::pin(futures::stream::once(async move { Ok(event) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status() {
        assert_eq!(parse_line(r#"{"status":"reading"}"#), Some(Event::Status("reading".into())));
    }

    #[test]
    fn parses_artifact() {
        assert_eq!(
            parse_line(r#"{"artifact":{"name":"jokes","text":"ha"}}"#),
            Some(Event::Artifact { name: "jokes".into(), text: "ha".into() })
        );
    }

    #[test]
    fn parses_error() {
        assert_eq!(parse_line(r#"{"error":"boom"}"#), Some(Event::Error("boom".into())));
    }

    #[test]
    fn ignores_non_json_lines() {
        assert_eq!(parse_line("Resolved 3 packages in 2ms"), None);
    }

    #[test]
    fn ignores_unknown_objects() {
        assert_eq!(parse_line(r#"{"progress":0.5}"#), None);
    }

    #[test]
    fn clean_exit_completes_with_last_status() {
        assert_eq!(outcome(Some(0), None, None, Some("jokes delivered")), (TaskState::Completed, "jokes delivered".into()));
    }

    #[test]
    fn error_event_fails_even_on_clean_exit() {
        assert_eq!(outcome(Some(0), Some("bad"), None, None), (TaskState::Failed, "bad".into()));
    }

    #[test]
    fn crash_reports_the_last_stderr_line() {
        assert_eq!(outcome(Some(1), None, Some("KeyError: x"), None), (TaskState::Failed, "KeyError: x".into()));
    }

    #[test]
    fn an_engine_run_gets_the_runner_mcp_library_and_its_picks() {
        let spec = crate::manifest::parse("a", Path::new("/a"), "name = \"A\"\nharness = \"pizza-bot\"\nmcp = [\"fetch\", \"github\"]\n[env]\nMODEL = \"m\"").unwrap();
        let env = run_env(spec.engine().unwrap(), "t1", Path::new("/data/mcp.json"));
        assert_eq!(
            env,
            [("MODEL", "m"), ("FLEET_TASK_ID", "t1"), ("FLEET_MCP_CONFIG", "/data/mcp.json"), ("FLEET_MCP_SERVERS", "fetch,github")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
        );
    }

    #[test]
    fn signal_without_stderr_says_so() {
        assert_eq!(outcome(None, None, None, None), (TaskState::Failed, "killed by a signal".into()));
    }
}
