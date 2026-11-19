use a2a::event::StreamResponse;
use a2a::*;
use a2a_server::{AgentExecutor, ExecutorContext};
use futures::stream::BoxStream;

use crate::bedrock::Bedrock;
use crate::events::{Cancellations, artifact, prompt_text, status};

/// Built into the binary so deployment stays a single file; `RUNNER_SCRIPT` overrides it.
const DEFAULT_SCRIPT: &str = include_str!("../scripts/sysinfo.sh");

const SYSTEM: &str = "You are a concise SRE. You get a raw utilization snapshot of one machine. \
Reply with: one headline line (overall health: OK / WATCH / HOT), then 3-5 short bullets covering \
CPU, memory, disk and any notable processes. Plain text, no markdown headers. \
If the user asks a specific question, answer it first.";

pub struct SysReport {
    pub bedrock: Bedrock,
    pub script: Option<String>,
    pub canceled: Cancellations,
}

async fn collect(script: Option<String>) -> Result<String, String> {
    let output = match script {
        Some(path) => tokio::process::Command::new("sh").arg(path).output().await,
        None => tokio::process::Command::new("sh").arg("-c").arg(DEFAULT_SCRIPT).output().await,
    }
    .map_err(|e| format!("could not run metrics script: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        Err(format!("metrics script printed nothing: {}", String::from_utf8_lossy(&output.stderr)))
    } else {
        Ok(text)
    }
}

impl AgentExecutor for SysReport {
    fn execute(&self, ctx: ExecutorContext) -> BoxStream<'static, Result<StreamResponse, A2AError>> {
        let (task_id, context_id) = ctx.task_info();
        let question = prompt_text(&ctx);
        let bedrock = self.bedrock.clone();
        let script = self.script.clone();
        let canceled = self.canceled.clone();

        Box::pin(async_stream::stream! {
            yield Ok(status(&task_id, &context_id, TaskState::Working, "collecting metrics"));
            let metrics = match collect(script).await {
                Ok(m) => m,
                Err(e) => { yield Ok(status(&task_id, &context_id, TaskState::Failed, &e)); return; }
            };
            yield Ok(artifact(&task_id, &context_id, "metrics", metrics.clone()));
            if canceled.is_requested(&task_id) { return; }

            yield Ok(status(&task_id, &context_id, TaskState::Working,
                &format!("summarizing with {}", bedrock.model())));
            let user = if question.is_empty() {
                format!("Snapshot:\n{metrics}")
            } else {
                format!("Question: {question}\n\nSnapshot:\n{metrics}")
            };
            let answer = bedrock.ask(SYSTEM, &user).await;
            if canceled.is_requested(&task_id) { return; }
            match answer {
                Ok(summary) => {
                    yield Ok(artifact(&task_id, &context_id, "summary", summary));
                    yield Ok(status(&task_id, &context_id, TaskState::Completed, "report ready"));
                }
                Err(e) => yield Ok(status(&task_id, &context_id, TaskState::Failed, &e)),
            }
        })
    }

    fn cancel(&self, ctx: ExecutorContext) -> BoxStream<'static, Result<StreamResponse, A2AError>> {
        let (task_id, context_id) = ctx.task_info();
        self.canceled.request(&task_id);
        let event = status(&task_id, &context_id, TaskState::Canceled, "canceled");
        Box::pin(futures::stream::once(async move { Ok(event) }))
    }
}
