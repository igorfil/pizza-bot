use std::time::Duration;

use a2a::event::StreamResponse;
use a2a::*;
use a2a_server::{AgentExecutor, ExecutorContext};
use futures::stream::BoxStream;

use crate::events::{Cancellations, artifact, status};

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub steps: u32,
    pub every_secs: u64,
    pub text: String,
}

/// Prompt format: `steps=N every=S <free text>`. Missing keys use defaults.
pub fn parse_plan(prompt: &str) -> Plan {
    let value = |key: &str| {
        prompt
            .split_whitespace()
            .find_map(|w| w.strip_prefix(key))
            .and_then(|v| v.parse::<u64>().ok())
    };
    let text = prompt
        .split_whitespace()
        .filter(|w| !w.starts_with("steps=") && !w.starts_with("every="))
        .collect::<Vec<_>>()
        .join(" ");
    Plan {
        steps: value("steps=").unwrap_or(10) as u32,
        every_secs: value("every=").unwrap_or(3),
        text,
    }
}

#[derive(Clone, Default)]
pub struct FakeAgent {
    canceled: Cancellations,
}

impl AgentExecutor for FakeAgent {
    fn execute(&self, ctx: ExecutorContext) -> BoxStream<'static, Result<StreamResponse, A2AError>> {
        let (task_id, context_id) = ctx.task_info();
        let plan = parse_plan(ctx.message.as_ref().and_then(Message::text).unwrap_or_default());
        let canceled = self.canceled.clone();
        let is_canceled = move |id: &str| canceled.is_requested(id);

        Box::pin(async_stream::stream! {
            for step in 1..=plan.steps {
                if is_canceled(&task_id) { return; }
                yield Ok(status(&task_id, &context_id, TaskState::Working,
                    &format!("step {step}/{}", plan.steps)));
                tokio::time::sleep(Duration::from_secs(plan.every_secs)).await;
            }
            if is_canceled(&task_id) { return; }
            yield Ok(artifact(&task_id, &context_id, "result", format!(
                "done: {} ({} steps, finished {})", plan.text, plan.steps, chrono::Utc::now().to_rfc3339())));
            yield Ok(status(&task_id, &context_id, TaskState::Completed, "completed"));
        })
    }

    fn cancel(&self, ctx: ExecutorContext) -> BoxStream<'static, Result<StreamResponse, A2AError>> {
        let (task_id, context_id) = ctx.task_info();
        self.canceled.request(&task_id);
        let event = status(&task_id, &context_id, TaskState::Canceled, "canceled");
        Box::pin(futures::stream::once(async move { Ok(event) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_steps_every_and_text() {
        assert_eq!(
            parse_plan("steps=4 every=2 build the thing"),
            Plan { steps: 4, every_secs: 2, text: "build the thing".into() }
        );
    }

    #[test]
    fn uses_defaults_when_keys_missing() {
        assert_eq!(
            parse_plan("hello"),
            Plan { steps: 10, every_secs: 3, text: "hello".into() }
        );
    }
}
