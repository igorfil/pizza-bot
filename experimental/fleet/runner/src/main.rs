mod events;
mod exec;
mod manifest;
mod store;

use std::path::PathBuf;
use std::sync::Arc;

use a2a::*;
use a2a_server::agent_card::agent_card_router;
use a2a_server::jsonrpc::jsonrpc_router;
use a2a_server::{DefaultRequestHandler, StaticAgentCard};
use axum::Json;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use serde_json::{Value, json};

use manifest::AgentSpec;

struct Config {
    name: String,
    bind: String,
    public_url: String,
    token: String,
    db: String,
    agents_dir: PathBuf,
    only: Option<Vec<String>>,
    location: Option<String>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_config() -> Result<Config, String> {
    let bind = env_or("RUNNER_BIND", "127.0.0.1:9000");
    Ok(Config {
        name: env_or("RUNNER_NAME", "runner"),
        public_url: env_or("RUNNER_PUBLIC_URL", &format!("http://{bind}")),
        token: std::env::var("RUNNER_TOKEN").map_err(|_| "RUNNER_TOKEN is required".to_string())?,
        db: env_or("RUNNER_DB", "runner.db"),
        agents_dir: PathBuf::from(env_or("RUNNER_AGENTS_DIR", "agents")),
        only: std::env::var("RUNNER_AGENTS")
            .ok()
            .map(|s| s.split(',').map(|id| id.trim().to_string()).filter(|id| !id.is_empty()).collect()),
        location: std::env::var("RUNNER_LOCATION").ok().filter(|l| !l.is_empty()),
        bind,
    })
}

fn capabilities() -> AgentCapabilities {
    AgentCapabilities {
        streaming: Some(true),
        push_notifications: Some(false),
        extensions: None,
        extended_agent_card: None,
    }
}

fn agent_url(cfg: &Config, spec: &AgentSpec) -> String {
    format!("{}/agents/{}", cfg.public_url, spec.id)
}

fn agent_card(cfg: &Config, spec: &AgentSpec) -> AgentCard {
    AgentCard {
        name: spec.name.clone(),
        description: spec.description.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        // The Controller shows `organization` as where the agent runs.
        provider: cfg.location.as_ref().map(|location| AgentProvider {
            organization: location.clone(),
            url: cfg.public_url.clone(),
        }),
        capabilities: capabilities(),
        skills: vec![AgentSkill {
            id: spec.id.clone(),
            name: spec.input.as_ref().map_or_else(|| spec.name.clone(), |i| i.label.clone()),
            description: spec.input.as_ref().map(|i| i.hint.clone()).unwrap_or_default(),
            tags: vec![],
            examples: spec.input.as_ref().map(|i| vec![i.example.clone()]),
            input_modes: None,
            output_modes: None,
            security_requirements: None,
        }],
        default_input_modes: vec!["text/plain".to_string()],
        default_output_modes: vec!["text/plain".to_string()],
        supported_interfaces: vec![AgentInterface::new(format!("{}/jsonrpc", agent_url(cfg, spec)), TRANSPORT_PROTOCOL_JSONRPC)],
        security_schemes: None,
        security_requirements: None,
        documentation_url: None,
        icon_url: None,
        signatures: None,
    }
}

/// Discovery for the Controller; also its health check. Public, like agent cards.
fn agents_index(cfg: &Config, specs: &[AgentSpec]) -> Value {
    json!({
        "runner": cfg.name,
        "location": cfg.location,
        "agents": specs.iter().map(|s| json!({
            "id": s.id,
            "name": s.name,
            "description": s.description,
            "input": s.input,
            "url": agent_url(cfg, s),
        })).collect::<Vec<_>>(),
    })
}

async fn require_bearer(expected: Arc<String>, req: Request, next: Next) -> Result<Response, StatusCode> {
    let ok = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == expected.as_str());
    if ok { Ok(next.run(req).await) } else { Err(StatusCode::UNAUTHORIZED) }
}

fn agent_router(cfg: &Config, spec: &AgentSpec, store: store::SharedStore, runs: exec::Runs, bearer: Arc<String>) -> axum::Router {
    let executor = exec::ExecAgent { spec: Arc::new(spec.clone()), runs };
    let handler = Arc::new(DefaultRequestHandler::new(executor, store).with_capabilities(capabilities()));
    let rpc = jsonrpc_router(handler).layer(middleware::from_fn(move |req, next| require_bearer(bearer.clone(), req, next)));
    axum::Router::new()
        .nest("/jsonrpc", rpc)
        .merge(agent_card_router(Arc::new(StaticAgentCard::new(agent_card(cfg, spec)))))
}

#[tokio::main]
async fn main() -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = load_config()?;
    let specs = manifest::load(&cfg.agents_dir, cfg.only.as_deref())?;
    if specs.is_empty() {
        return Err(format!("no agents found in {}", cfg.agents_dir.display()));
    }

    let sqlite = store::SqliteTaskStore::open(&cfg.db).map_err(|e| e.to_string())?;
    let orphans = sqlite.fail_orphans().map_err(|e| e.to_string())?;
    if orphans > 0 {
        tracing::warn!(orphans, "marked tasks interrupted by restart as failed");
    }
    let store = store::SharedStore(Arc::new(sqlite));
    let runs = exec::Runs::default();
    let bearer = Arc::new(format!("Bearer {}", cfg.token));

    let index = Arc::new(agents_index(&cfg, &specs));
    let app = specs.iter().fold(
        axum::Router::new().route("/agents", get(move || { let index = index.clone(); async move { Json((*index).clone()) } })),
        |app, spec| app.nest(&format!("/agents/{}", spec.id), agent_router(&cfg, spec, store.clone(), runs.clone(), bearer.clone())),
    );

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await.map_err(|e| e.to_string())?;
    let ids: Vec<&str> = specs.iter().map(|s| s.id.as_str()).collect();
    tracing::info!(name = %cfg.name, agents = ?ids, bind = %cfg.bind, public_url = %cfg.public_url, "runner listening");
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}
