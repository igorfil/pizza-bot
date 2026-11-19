use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use a2a::event::{StreamResponse, TaskArtifactUpdateEvent, TaskStatusUpdateEvent};
use a2a::*;

pub fn status(task_id: &str, context_id: &str, state: TaskState, text: &str) -> StreamResponse {
    StreamResponse::StatusUpdate(TaskStatusUpdateEvent {
        task_id: task_id.to_string(),
        context_id: context_id.to_string(),
        status: TaskStatus {
            state,
            message: Some(Message::new(Role::Agent, vec![Part::text(text)])),
            timestamp: Some(chrono::Utc::now()),
        },
        metadata: None,
    })
}

pub fn artifact(task_id: &str, context_id: &str, id: &str, text: String) -> StreamResponse {
    StreamResponse::ArtifactUpdate(TaskArtifactUpdateEvent {
        task_id: task_id.to_string(),
        context_id: context_id.to_string(),
        artifact: Artifact {
            artifact_id: id.to_string(),
            name: Some(id.to_string()),
            description: None,
            parts: vec![Part::text(text)],
            metadata: None,
            extensions: None,
        },
        append: Some(false),
        last_chunk: Some(true),
        metadata: None,
    })
}

/// Task ids whose cancel was requested; executors check it between steps.
#[derive(Clone, Default)]
pub struct Cancellations(Arc<Mutex<HashSet<String>>>);

impl Cancellations {
    pub fn request(&self, task_id: &str) {
        self.0.lock().unwrap().insert(task_id.to_string());
    }

    pub fn is_requested(&self, task_id: &str) -> bool {
        self.0.lock().unwrap().contains(task_id)
    }
}

pub fn prompt_text(ctx: &a2a_server::ExecutorContext) -> String {
    ctx.message
        .as_ref()
        .and_then(Message::text)
        .unwrap_or_default()
        .trim()
        .to_string()
}
