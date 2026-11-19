mod bedrock;
mod dadjokes;
mod events;
mod fake;
mod store;
mod sysreport;

use std::sync::Arc;

use a2a::*;
use a2a_server::agent_card::agent_card_router;
use a2a_server::jsonrpc::jsonrpc_router;
use a2a_server::{DefaultRequestHandler, StaticAgentCard, TaskStore};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;

#[derive(Clone, Copy, Debug)]
enum AgentKind {
    Fake,
    DadJokes,
    SysReport,
}

impl AgentKind {
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "fake" => Ok(Self::Fake),
            "dadjokes" => Ok(Self::DadJokes),
            "sysreport" => Ok(Self::SysReport),
            other => Err(format!("unknown RUNNER_AGENT {other:?} (fake | dadjokes | sysreport)")),
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Self::DadJokes => "us.openai.gpt-6.1-terra",
            _ => "us.anthropic.claude-haiku-5-5",
        }
    }

    /// (card description, skill name, skill description = input hint, example input)
    fn describe(self, model: &str) -> (String, &'static str, &'static str, &'static str) {
        match self {
            Self::Fake => (
                "Fake agent for testing: reports progress N times, then returns a result.".into(),
                "Fake work",
                "steps=N every=S <text>",
                "steps=5 every=2 hello",
            ),
            Self::DadJokes => (
                format!("Writes 5 dad jokes about any topic ({model} on Bedrock)."),
                "Topic",
                "what the jokes should be about",
                "kubernetes",
            ),
            Self::SysReport => (
                format!("Collects CPU, memory and disk usage on this machine and summarizes it ({model} on Bedrock)."),
                "Focus",
                "optional question, e.g. is memory ok? (leave empty for a general report)",
                "anything to worry about?",
            ),
        }
    }
}

struct Config {
    name: String,
    bind: String,
    public_url: String,
    token: String,
    db: String,
    agent: AgentKind,
    model: String,
    script: Option<String>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_config() -> Result<Config, String> {
    let bind = env_or("RUNNER_BIND", "127.0.0.1:9000");
    let agent = AgentKind::parse(&env_or("RUNNER_AGENT", "fake"))?;
    Ok(Config {
        name: env_or("RUNNER_NAME", "runner"),
        public_url: env_or("RUNNER_PUBLIC_URL", &format!("http://{bind}")),
        token: std::env::var("RUNNER_TOKEN").map_err(|_| "RUNNER_TOKEN is required".to_string())?,
        db: env_or("RUNNER_DB", "runner.db"),
        model: env_or("RUNNER_MODEL", agent.default_model()),
        script: std::env::var("RUNNER_SCRIPT").ok(),
        agent,
        bind,
    })
}

fn agent_card(cfg: &Config) -> AgentCard {
    let (description, skill_name, skill_description, example) = cfg.agent.describe(&cfg.model);
    AgentCard {
        name: cfg.name.clone(),
        description,
        version: env!("CARGO_PKG_VERSION").to_string(),
        provider: None,
        capabilities: AgentCapabilities {
            streaming: Some(true),
            push_notifications: Some(false),
            extensions: None,
            extended_agent_card: None,
        },
        skills: vec![AgentSkill {
            id: format!("{:?}", cfg.agent).to_lowercase(),
            name: skill_name.to_string(),
            description: skill_description.to_string(),
            tags: vec![],
            examples: Some(vec![example.to_string()]),
            input_modes: None,
            output_modes: None,
            security_requirements: None,
        }],
        default_input_modes: vec!["text/plain".to_string()],
        default_output_modes: vec!["text/plain".to_string()],
        supported_interfaces: vec![AgentInterface::new(
            format!("{}/jsonrpc", cfg.public_url),
            TRANSPORT_PROTOCOL_JSONRPC,
        )],
        security_schemes: None,
        security_requirements: None,
        documentation_url: None,
        icon_url: None,
        signatures: None,
    }
}

async fn build_handler(cfg: &Config, store: impl TaskStore) -> DefaultRequestHandler {
    match cfg.agent {
        AgentKind::Fake => DefaultRequestHandler::new(fake::FakeAgent::default(), store),
        AgentKind::DadJokes => DefaultRequestHandler::new(
            dadjokes::DadJokes {
                bedrock: bedrock::Bedrock::new(cfg.model.clone()).await,
                canceled: Default::default(),
            },
            store,
        ),
        AgentKind::SysReport => DefaultRequestHandler::new(
            sysreport::SysReport {
                bedrock: bedrock::Bedrock::new(cfg.model.clone()).await,
                script: cfg.script.clone(),
                canceled: Default::default(),
            },
            store,
        ),
    }
}

async fn require_bearer(expected: Arc<String>, req: Request, next: Next) -> Result<Response, StatusCode> {
    let ok = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == expected.as_str());
    if ok { Ok(next.run(req).await) } else { Err(StatusCode::UNAUTHORIZED) }
}

#[tokio::main]
async fn main() -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = load_config()?;
    let store = store::SqliteTaskStore::open(&cfg.db).map_err(|e| e.to_string())?;
    let orphans = store.fail_orphans().map_err(|e| e.to_string())?;
    if orphans > 0 {
        tracing::warn!(orphans, "marked tasks interrupted by restart as failed");
    }

    let card = agent_card(&cfg);
    let handler = Arc::new(build_handler(&cfg, store).await.with_capabilities(card.capabilities.clone()));
    let bearer = Arc::new(format!("Bearer {}", cfg.token));
    let rpc = jsonrpc_router(handler).layer(middleware::from_fn(move |req, next| {
        require_bearer(bearer.clone(), req, next)
    }));
    let app = axum::Router::new()
        .nest("/jsonrpc", rpc)
        .merge(agent_card_router(Arc::new(StaticAgentCard::new(card))));

    let listener = tokio::net::TcpListener::bind(&cfg.bind)
        .await
        .map_err(|e| e.to_string())?;
    tracing::info!(name = %cfg.name, agent = ?cfg.agent, model = %cfg.model, bind = %cfg.bind, public_url = %cfg.public_url, "runner listening");
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}
