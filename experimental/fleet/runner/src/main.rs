mod events;
mod exec;
mod manifest;
mod store;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use a2a::*;
use a2a_server::agent_card::agent_card_router;
use a2a_server::jsonrpc::jsonrpc_router;
use a2a_server::{DefaultRequestHandler, StaticAgentCard};
use axum::Json;
use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode};
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

type Served = Arc<RwLock<BTreeSet<String>>>;

fn agent_json(cfg: &Config, s: &AgentSpec) -> Value {
    json!({
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "input": s.input,
        "url": agent_url(cfg, s),
    })
}

/// Discovery for the Controller; also its health check. Public, like agent cards.
/// `available` lists agents on disk that the Controller can turn on with `PUT /agents`.
fn agents_index(cfg: &Config, specs: &[AgentSpec], served: &BTreeSet<String>) -> Value {
    let (on, off): (Vec<&AgentSpec>, Vec<&AgentSpec>) = specs.iter().partition(|s| served.contains(&s.id));
    json!({
        "runner": cfg.name,
        "location": cfg.location,
        "agents": on.iter().map(|s| agent_json(cfg, s)).collect::<Vec<_>>(),
        "available": off.iter().map(|s| agent_json(cfg, s)).collect::<Vec<_>>(),
    })
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok()).is_some_and(|v| v == expected)
}

async fn require_bearer(expected: Arc<String>, req: Request, next: Next) -> Result<Response, StatusCode> {
    if authorized(req.headers(), &expected) { Ok(next.run(req).await) } else { Err(StatusCode::UNAUTHORIZED) }
}

/// Every agent on disk is mounted; one the runner doesn't serve answers 404, card included.
async fn require_served(id: Arc<String>, served: Served, req: Request, next: Next) -> Result<Response, StatusCode> {
    if served.read().unwrap().contains(id.as_str()) { Ok(next.run(req).await) } else { Err(StatusCode::NOT_FOUND) }
}

fn agent_router(cfg: &Config, spec: &AgentSpec, store: store::SharedStore, runs: exec::Runs, bearer: Arc<String>, served: Served) -> axum::Router {
    let executor = exec::ExecAgent { spec: Arc::new(spec.clone()), runs };
    let handler = Arc::new(DefaultRequestHandler::new(executor, store).with_capabilities(capabilities()));
    let rpc = jsonrpc_router(handler).layer(middleware::from_fn(move |req, next| require_bearer(bearer.clone(), req, next)));
    let id = Arc::new(spec.id.clone());
    axum::Router::new()
        .nest("/jsonrpc", rpc)
        .merge(agent_card_router(Arc::new(StaticAgentCard::new(agent_card(cfg, spec)))))
        .layer(middleware::from_fn(move |req, next| require_served(id.clone(), served.clone(), req, next)))
}

fn bad_request(error: String) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": error })))
}

/// Replaces the served set and keeps it across restarts; answers with the new index.
fn set_agents(
    cfg: &Config,
    specs: &[AgentSpec],
    served: &Served,
    store: &store::SqliteTaskStore,
    body: &Value,
) -> Result<Value, (StatusCode, Json<Value>)> {
    let ids: Vec<String> = body
        .get("agents")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().map(|v| v.as_str().map(str::to_string)).collect())
        .ok_or_else(|| bad_request("body must be {\"agents\": [\"<id>\", ...]}".to_string()))?;
    if let Some(missing) = manifest::unknown(specs, &ids) {
        return Err(bad_request(format!("no agent {missing:?} in {}", cfg.agents_dir.display())));
    }
    store
        .set_served_agents(&ids)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))))?;
    let next: BTreeSet<String> = ids.into_iter().collect();
    tracing::info!(agents = ?next, "served agents changed");
    *served.write().unwrap() = next;
    Ok(agents_index(cfg, specs, &served.read().unwrap()))
}

/// Saved choice first, then RUNNER_AGENTS, else everything on disk.
fn initial_served(cfg: &Config, specs: &[AgentSpec], saved: Option<Vec<String>>) -> Result<BTreeSet<String>, String> {
    if let Some(saved) = saved {
        return Ok(saved.into_iter().filter(|id| specs.iter().any(|s| &s.id == id)).collect());
    }
    if let Some(only) = &cfg.only {
        if let Some(missing) = manifest::unknown(specs, only) {
            return Err(format!("RUNNER_AGENTS lists {missing:?}, but {} has no such agent", cfg.agents_dir.display()));
        }
        return Ok(only.iter().cloned().collect());
    }
    Ok(specs.iter().map(|s| s.id.clone()).collect())
}

#[tokio::main]
async fn main() -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = Arc::new(load_config()?);
    let specs = Arc::new(manifest::load(&cfg.agents_dir)?);
    if specs.is_empty() {
        return Err(format!("no agents found in {}", cfg.agents_dir.display()));
    }

    let sqlite = Arc::new(store::SqliteTaskStore::open(&cfg.db).map_err(|e| e.to_string())?);
    let orphans = sqlite.fail_orphans().map_err(|e| e.to_string())?;
    if orphans > 0 {
        tracing::warn!(orphans, "marked tasks interrupted by restart as failed");
    }
    let served: Served = Arc::new(RwLock::new(initial_served(&cfg, &specs, sqlite.served_agents().map_err(|e| e.to_string())?)?));
    let store = store::SharedStore(sqlite.clone());
    let runs = exec::Runs::default();
    let bearer = Arc::new(format!("Bearer {}", cfg.token));

    let index = {
        let (cfg, specs, served) = (cfg.clone(), specs.clone(), served.clone());
        move || {
            let index = agents_index(&cfg, &specs, &served.read().unwrap());
            async move { Json(index) }
        }
    };
    let update = {
        let (cfg, specs, served, sqlite, bearer) = (cfg.clone(), specs.clone(), served.clone(), sqlite.clone(), bearer.clone());
        move |headers: HeaderMap, Json(body): Json<Value>| {
            let result = if authorized(&headers, &bearer) {
                set_agents(&cfg, &specs, &served, &sqlite, &body).map(Json)
            } else {
                Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))))
            };
            async move { result }
        }
    };
    let app = specs.iter().fold(axum::Router::new().route("/agents", get(index).put(update)), |app, spec| {
        app.nest(&format!("/agents/{}", spec.id), agent_router(&cfg, spec, store.clone(), runs.clone(), bearer.clone(), served.clone()))
    });

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await.map_err(|e| e.to_string())?;
    let ids: Vec<String> = served.read().unwrap().iter().cloned().collect();
    tracing::info!(name = %cfg.name, agents = ?ids, bind = %cfg.bind, public_url = %cfg.public_url, "runner listening");
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}
