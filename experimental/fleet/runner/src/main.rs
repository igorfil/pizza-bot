mod created;
mod events;
mod exec;
mod manifest;
mod store;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, RwLock};

use a2a::*;
use a2a_server::agent_card::agent_card_router;
use a2a_server::jsonrpc::jsonrpc_router;
use a2a_server::{DefaultRequestHandler, StaticAgentCard};
use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get};
use serde_json::{Value, json};
use tower::ServiceExt;

use manifest::AgentSpec;

struct Config {
    name: String,
    bind: String,
    public_url: String,
    token: String,
    db: String,
    agents_dir: PathBuf,
    /// Agents made over `POST /agents`; outside `agents_dir`, which an upgrade replaces.
    created_dir: PathBuf,
    only: Option<Vec<String>>,
    location: Option<String>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_config() -> Result<Config, String> {
    let bind = env_or("RUNNER_BIND", "127.0.0.1:9000");
    let db = env_or("RUNNER_DB", "runner.db");
    let beside_db = FsPath::new(&db).parent().unwrap_or(FsPath::new(".")).join("created-agents");
    Ok(Config {
        name: env_or("RUNNER_NAME", "runner"),
        public_url: env_or("RUNNER_PUBLIC_URL", &format!("http://{bind}")),
        token: std::env::var("RUNNER_TOKEN").map_err(|_| "RUNNER_TOKEN is required".to_string())?,
        agents_dir: PathBuf::from(env_or("RUNNER_AGENTS_DIR", "agents")),
        created_dir: std::env::var("RUNNER_CREATED_AGENTS_DIR").map(PathBuf::from).unwrap_or(beside_db),
        db,
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

fn is_created(cfg: &Config, s: &AgentSpec) -> bool {
    s.dir.starts_with(&cfg.created_dir)
}

/// Created agents also carry their model and system prompt, so a UI can edit them.
fn agent_json(cfg: &Config, s: &AgentSpec) -> Value {
    let mut v = json!({
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "input": s.input,
        "url": agent_url(cfg, s),
        "created": is_created(cfg, s),
    });
    if is_created(cfg, s) {
        v["model"] = json!(s.env.get("MODEL"));
        v["systemPrompt"] = json!(std::fs::read_to_string(s.dir.join("system.md")).unwrap_or_default());
    }
    v
}

fn authorized(headers: &HeaderMap, expected: &str) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok()).is_some_and(|v| v == expected)
}

async fn require_bearer(expected: Arc<String>, req: Request, next: Next) -> Result<Response, StatusCode> {
    if authorized(req.headers(), &expected) { Ok(next.run(req).await) } else { Err(StatusCode::UNAUTHORIZED) }
}

type ApiError = (StatusCode, Json<Value>);

fn api_error(status: StatusCode, error: impl Into<String>) -> ApiError {
    (status, Json(json!({ "error": error.into() })))
}

/// Every agent the runner knows, which of them it serves, and one A2A router per agent.
struct Agents {
    specs: Vec<AgentSpec>,
    served: BTreeSet<String>,
    routers: HashMap<String, axum::Router>,
}

struct App {
    cfg: Config,
    sqlite: Arc<store::SqliteTaskStore>,
    store: store::SharedStore,
    runs: exec::Runs,
    bearer: Arc<String>,
    agents: RwLock<Agents>,
}

impl App {
    fn agent_router(&self, spec: &AgentSpec) -> axum::Router {
        let executor = exec::ExecAgent { spec: Arc::new(spec.clone()), runs: self.runs.clone() };
        let handler = Arc::new(DefaultRequestHandler::new(executor, self.store.clone()).with_capabilities(capabilities()));
        let bearer = self.bearer.clone();
        let rpc = jsonrpc_router(handler).layer(middleware::from_fn(move |req, next| require_bearer(bearer.clone(), req, next)));
        axum::Router::new()
            .nest("/jsonrpc", rpc)
            .merge(agent_card_router(Arc::new(StaticAgentCard::new(agent_card(&self.cfg, spec)))))
    }

    /// Discovery for the Controller; also its health check. Public, like agent cards.
    /// `available` lists agents the runner has but doesn't serve; `PUT /agents` turns them on.
    /// `canCreate` tells the Controller this runner takes `POST /agents`.
    fn index(&self) -> Value {
        let agents = self.agents.read().unwrap();
        let (on, off): (Vec<&AgentSpec>, Vec<&AgentSpec>) = agents.specs.iter().partition(|s| agents.served.contains(&s.id));
        json!({
            "runner": self.cfg.name,
            "location": self.cfg.location,
            "agents": on.iter().map(|s| agent_json(&self.cfg, s)).collect::<Vec<_>>(),
            "available": off.iter().map(|s| agent_json(&self.cfg, s)).collect::<Vec<_>>(),
            "canCreate": true,
        })
    }

    fn save_served(&self, served: &BTreeSet<String>) -> Result<(), ApiError> {
        let ids: Vec<String> = served.iter().cloned().collect();
        self.sqlite.set_served_agents(&ids).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    }

    /// Replaces the served set and keeps it across restarts.
    fn set_served(&self, body: &Value) -> Result<Value, ApiError> {
        let ids: Vec<String> = body
            .get("agents")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().map(|v| v.as_str().map(str::to_string)).collect())
            .ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "body must be {\"agents\": [\"<id>\", ...]}"))?;
        let next: BTreeSet<String> = {
            let agents = self.agents.read().unwrap();
            if let Some(missing) = manifest::unknown(&agents.specs, &ids) {
                return Err(api_error(StatusCode::BAD_REQUEST, format!("this runner has no agent {missing:?}")));
            }
            ids.into_iter().collect()
        };
        self.save_served(&next)?;
        tracing::info!(agents = ?next, "served agents changed");
        self.agents.write().unwrap().served = next;
        Ok(self.index())
    }

    /// Writes a new prompt agent into the created-agents folder and serves it right away.
    fn create(&self, body: &Value) -> Result<Value, ApiError> {
        let agent = created::parse_request(body).map_err(|e| api_error(StatusCode::BAD_REQUEST, e))?;
        if self.agents.read().unwrap().specs.iter().any(|s| s.id == agent.id) {
            return Err(api_error(StatusCode::CONFLICT, format!("this runner already has an agent {:?}", agent.id)));
        }
        let folder = created::write(&self.cfg.created_dir, &agent).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let spec = manifest::parse(&agent.id, &folder, &created::manifest_toml(&agent)).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let router = self.agent_router(&spec);
        let served = {
            let mut agents = self.agents.write().unwrap();
            agents.routers.insert(spec.id.clone(), router);
            agents.specs.push(spec);
            agents.specs.sort_by(|a, b| a.id.cmp(&b.id));
            agents.served.insert(agent.id.clone());
            agents.served.clone()
        };
        self.save_served(&served)?;
        tracing::info!(agent = %agent.id, model = %agent.model, "agent created");
        let mut index = self.index();
        index["created"] = json!(agent.id);
        Ok(index)
    }

    /// Rewrites a created agent under the same id, so its URL and run history stay; runs in flight keep the old spec.
    fn edit(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let folder = {
            let agents = self.agents.read().unwrap();
            let spec = agents.specs.iter().find(|s| s.id == id).ok_or_else(|| api_error(StatusCode::NOT_FOUND, format!("this runner has no agent {id:?}")))?;
            if !is_created(&self.cfg, spec) {
                return Err(api_error(StatusCode::CONFLICT, format!("{id:?} ships with the runner; only agents created here can be edited")));
            }
            spec.dir.clone()
        };
        let mut request = body.as_object().cloned().unwrap_or_default();
        request.insert("id".into(), json!(id));
        let agent = created::parse_request(&Value::Object(request)).map_err(|e| api_error(StatusCode::BAD_REQUEST, e))?;
        created::rewrite(&folder, &agent).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let spec = manifest::parse(id, &folder, &created::manifest_toml(&agent)).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let router = self.agent_router(&spec);
        {
            let mut agents = self.agents.write().unwrap();
            agents.routers.insert(spec.id.clone(), router);
            agents.specs.retain(|s| s.id != id);
            agents.specs.push(spec);
            agents.specs.sort_by(|a, b| a.id.cmp(&b.id));
        }
        tracing::info!(agent = %id, model = %agent.model, "agent edited");
        Ok(self.index())
    }

    /// A created agent's folder is deleted; a shipped one is only turned off, so it can be added back.
    fn delete(&self, id: &str) -> Result<Value, ApiError> {
        let folder = {
            let agents = self.agents.read().unwrap();
            let spec = agents.specs.iter().find(|s| s.id == id).ok_or_else(|| api_error(StatusCode::NOT_FOUND, format!("this runner has no agent {id:?}")))?;
            is_created(&self.cfg, spec).then(|| spec.dir.clone())
        };
        if let Some(folder) = &folder {
            std::fs::remove_dir_all(folder).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{}: {e}", folder.display())))?;
        }
        let served = {
            let mut agents = self.agents.write().unwrap();
            if folder.is_some() {
                agents.specs.retain(|s| s.id != id);
                agents.routers.remove(id);
            }
            agents.served.remove(id);
            agents.served.clone()
        };
        self.save_served(&served)?;
        tracing::info!(agent = %id, deleted = folder.is_some(), "agent removed");
        Ok(self.index())
    }
}

async fn put_agents(State(app): State<Arc<App>>, headers: HeaderMap, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    if !authorized(&headers, &app.bearer) {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    app.set_served(&body).map(Json)
}

async fn post_agents(State(app): State<Arc<App>>, headers: HeaderMap, Json(body): Json<Value>) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !authorized(&headers, &app.bearer) {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    app.create(&body).map(|index| (StatusCode::CREATED, Json(index)))
}

async fn put_agent(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    if !authorized(&headers, &app.bearer) {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    app.edit(&id, &body).map(Json)
}

async fn delete_agent(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if !authorized(&headers, &app.bearer) {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    app.delete(&id).map(Json)
}

/// Routes `/agents/<id>/<rest>` to that agent's router, so agents can be added while the runner runs.
/// One the runner doesn't serve answers 404, card included.
async fn agent_request(State(app): State<Arc<App>>, Path((id, rest)): Path<(String, String)>, req: Request) -> Response {
    let router = {
        let agents = app.agents.read().unwrap();
        agents.served.contains(&id).then(|| agents.routers.get(&id).cloned()).flatten()
    };
    let Some(router) = router else { return StatusCode::NOT_FOUND.into_response() };
    let (mut parts, body) = req.into_parts();
    let query = parts.uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let Ok(uri) = format!("/{rest}{query}").parse() else { return StatusCode::BAD_REQUEST.into_response() };
    parts.uri = uri;
    match router.oneshot(Request::from_parts(parts, body)).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
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

/// Shipped agents, then created ones; a created agent can't shadow a shipped one.
fn load_specs(cfg: &Config) -> Result<Vec<AgentSpec>, String> {
    let shipped = manifest::load(&cfg.agents_dir)?;
    let made = if cfg.created_dir.is_dir() { manifest::load(&cfg.created_dir)? } else { vec![] };
    let (fresh, shadowed): (Vec<AgentSpec>, Vec<AgentSpec>) = made.into_iter().partition(|c| !shipped.iter().any(|s| s.id == c.id));
    for s in &shadowed {
        tracing::warn!(agent = %s.id, "created agent has the id of a shipped one; ignored");
    }
    let mut specs: Vec<AgentSpec> = shipped.into_iter().chain(fresh).collect();
    specs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(specs)
}

#[tokio::main]
async fn main() -> Result<(), String> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = load_config()?;
    let refreshed = created::refresh_harness(&cfg.created_dir);
    if refreshed > 0 {
        tracing::info!(refreshed, "updated the harness of created agents");
    }
    let specs = load_specs(&cfg)?;

    let sqlite = Arc::new(store::SqliteTaskStore::open(&cfg.db).map_err(|e| e.to_string())?);
    let orphans = sqlite.fail_orphans().map_err(|e| e.to_string())?;
    if orphans > 0 {
        tracing::warn!(orphans, "marked tasks interrupted by restart as failed");
    }
    let served = initial_served(&cfg, &specs, sqlite.served_agents().map_err(|e| e.to_string())?)?;
    let app = Arc::new(App {
        bearer: Arc::new(format!("Bearer {}", cfg.token)),
        store: store::SharedStore(sqlite.clone()),
        sqlite,
        runs: exec::Runs::default(),
        agents: RwLock::new(Agents { specs: vec![], served, routers: HashMap::new() }),
        cfg,
    });
    let routers: HashMap<String, axum::Router> = specs.iter().map(|s| (s.id.clone(), app.agent_router(s))).collect();
    {
        let mut agents = app.agents.write().unwrap();
        agents.specs = specs;
        agents.routers = routers;
    }

    let router = axum::Router::new()
        .route("/agents", get(|State(app): State<Arc<App>>| async move { Json(app.index()) }).put(put_agents).post(post_agents))
        .route("/agents/{id}", delete(delete_agent).put(put_agent))
        .route("/agents/{id}/{*rest}", any(agent_request))
        .with_state(app.clone());

    let listener = tokio::net::TcpListener::bind(&app.cfg.bind).await.map_err(|e| e.to_string())?;
    let ids: Vec<String> = app.agents.read().unwrap().served.iter().cloned().collect();
    tracing::info!(name = %app.cfg.name, agents = ?ids, bind = %app.cfg.bind, public_url = %app.cfg.public_url, "runner listening");
    axum::serve(listener, router).await.map_err(|e| e.to_string())
}
