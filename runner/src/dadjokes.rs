use a2a::event::StreamResponse;
use a2a::*;
use a2a_server::{AgentExecutor, ExecutorContext};
use futures::stream::BoxStream;

use crate::bedrock::Bedrock;
use crate::events::{Cancellations, artifact, prompt_text, status};

const SYSTEM: &str = "You are a dad-joke machine. Given a topic, reply with exactly 5 short, \
groan-worthy dad jokes about it, one per line, numbered 1-5. No intro, no outro.";

pub struct DadJokes {
    pub bedrock: Bedrock,
    pub canceled: Cancellations,
}

impl AgentExecutor for DadJokes {
    fn execute(&self, ctx: ExecutorContext) -> BoxStream<'static, Result<StreamResponse, A2AError>> {
        let (task_id, context_id) = ctx.task_info();
        let topic = Some(prompt_text(&ctx)).filter(|t| !t.is_empty()).unwrap_or_else(|| "anything".into());
        let bedrock = self.bedrock.clone();
        let canceled = self.canceled.clone();

        Box::pin(async_stream::stream! {
            yield Ok(status(&task_id, &context_id, TaskState::Working,
                &format!("asking {} for jokes about {topic}", bedrock.model())));
            let answer = bedrock.ask(SYSTEM, &format!("Topic: {topic}")).await;
            if canceled.is_requested(&task_id) { return; }
            match answer {
                Ok(jokes) => {
                    yield Ok(artifact(&task_id, &context_id, "jokes", jokes));
                    yield Ok(status(&task_id, &context_id, TaskState::Completed, "jokes delivered"));
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
