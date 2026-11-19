use aws_config::BehaviorVersion;
use aws_config::meta::region::RegionProviderChain;
use aws_sdk_bedrockruntime::Client;
use aws_sdk_bedrockruntime::types::{
    ContentBlock, ConversationRole, InferenceConfiguration, Message, SystemContentBlock,
};

#[derive(Clone)]
pub struct Bedrock {
    client: Client,
    model: String,
}

impl Bedrock {
    pub async fn new(model: String) -> Self {
        let region = RegionProviderChain::default_provider().or_else("us-west-2");
        let config = aws_config::defaults(BehaviorVersion::latest())
            .region(region)
            .load()
            .await;
        Self {
            client: Client::new(&config),
            model,
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub async fn ask(&self, system: &str, user: &str) -> Result<String, String> {
        let message = Message::builder()
            .role(ConversationRole::User)
            .content(ContentBlock::Text(user.to_string()))
            .build()
            .map_err(|e| e.to_string())?;
        let response = self
            .client
            .converse()
            .model_id(&self.model)
            .system(SystemContentBlock::Text(system.to_string()))
            .messages(message)
            .inference_config(InferenceConfiguration::builder().max_tokens(1000).build())
            .send()
            .await
            .map_err(|e| format!("bedrock: {}", aws_sdk_bedrockruntime::error::DisplayErrorContext(e)))?;
        let text = response
            .output()
            .and_then(|o| o.as_message().ok())
            .map(|m| {
                m.content()
                    .iter()
                    .filter_map(|b| b.as_text().ok().cloned())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if text.trim().is_empty() {
            Err("bedrock returned no text".to_string())
        } else {
            Ok(text.trim().to_string())
        }
    }
}
