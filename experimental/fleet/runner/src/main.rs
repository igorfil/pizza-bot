mod created;
mod engine;
mod events;
mod exec;
mod manifest;
mod mcp;
mod plugin;
mod store;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use a2a::*;
use a2a_server::agent_card::agent_card_router;
use a2a_server::jsonrpc::jsonrpc_router;
use a2a_server::{DefaultRequestHandler, StaticAgentCard};
use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post, put};
use serde_json::{Value, json};
use tower::ServiceExt;

use engine::{Engine, PIZZA_BOT};
use manifest::{AgentSpec, Host};
use plugin::Plugins;

const PLUGIN_CHECK_EVERY: Duration = Duration::from_secs(30);

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
    engine: Arc<Engine>,
    /// Harness plugins for external agents (plugins/README.md); none when the folder is missing.
    plugins_dir: PathBuf,
    /// One writable folder per plugin, beside the task store: `<data>/plugins/<id>`.
    plugin_data: PathBuf,
    /// The runner's MCP library; beside the task store unless `RUNNER_MCP_CONFIG` says otherwise.
    mcp_config: PathBuf,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_config() -> Result<Config, String> {
    let bind = env_or("RUNNER_BIND", "127.0.0.1:9000");
    let db = env_or("RUNNER_DB", "runner.db");
    let data_dir = FsPath::new(&db).parent().unwrap_or(FsPath::new(".")).to_path_buf();
    let beside_db = data_dir.join("created-agents");
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
        engine: Arc::new(Engine::from_vars(std::env::vars())),
        plugins_dir: PathBuf::from(env_or("RUNNER_PLUGINS_DIR", "plugins")),
        plugin_data: data_dir.join("plugins"),
        mcp_config: std::env::var("RUNNER_MCP_CONFIG").map(PathBuf::from).unwrap_or_else(|_| data_dir.join("mcp.json")),
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

fn created_dir_of<'a>(cfg: &Config, s: &'a AgentSpec) -> Option<&'a PathBuf> {
    s.engine().map(|e| &e.dir).filter(|dir| dir.starts_with(&cfg.created_dir))
}

fn is_created(cfg: &Config, s: &AgentSpec) -> bool {
    created_dir_of(cfg, s).is_some()
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
        "added": s.added,
        "kind": if s.builtin() { "builtin" } else { "external" },
        "harness": match &s.host { Host::Engine(_) => PIZZA_BOT, Host::Plugin(plugin) => plugin },
        "mcp": s.engine().map(|e| e.mcp.clone()).unwrap_or_default(),
    });
    if let Some(e) = s.engine().filter(|_| is_created(cfg, s)) {
        v["model"] = json!(e.env.get("MODEL"));
        v["systemPrompt"] = json!(std::fs::read_to_string(e.dir.join("system.md")).unwrap_or_default());
        v["skills"] = created::skills_json(&e.dir);
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
    plugins: Plugins,
    mcp: mcp::McpLibrary,
    bearer: Arc<String>,
    agents: RwLock<Agents>,
}

impl App {
    fn agent_router(&self, spec: &AgentSpec) -> axum::Router {
        let executor = exec::ExecAgent {
            spec: Arc::new(spec.clone()),
            runs: self.runs.clone(),
            engine: self.cfg.engine.clone(),
            plugins: self.plugins.clone(),
            mcp_config: Arc::new(self.cfg.mcp_config.clone()),
        };
        let handler = Arc::new(DefaultRequestHandler::new(executor, self.store.clone()).with_capabilities(capabilities()));
        let bearer = self.bearer.clone();
        let rpc = jsonrpc_router(handler).layer(middleware::from_fn(move |req, next| require_bearer(bearer.clone(), req, next)));
        axum::Router::new()
            .nest("/jsonrpc", rpc)
            .merge(agent_card_router(Arc::new(StaticAgentCard::new(agent_card(&self.cfg, spec)))))
    }

    /// Discovery for the Controller; also its health check. Public, like agent cards.
    /// `available` lists agents the runner has but doesn't serve; `PUT /agents` turns them on.
    /// `canCreate`: the runner has the built-in engine, so it takes `POST /agents`.
    fn index(&self) -> Value {
        let agents = self.agents.read().unwrap();
        let (on, off): (Vec<&AgentSpec>, Vec<&AgentSpec>) = agents.specs.iter().partition(|s| agents.served.contains(&s.id));
        json!({
            "runner": self.cfg.name,
            "location": self.cfg.location,
            "agents": on.iter().map(|s| agent_json(&self.cfg, s)).collect::<Vec<_>>(),
            "available": off.iter().map(|s| agent_json(&self.cfg, s)).collect::<Vec<_>>(),
            "canCreate": self.pizza_bot(),
            "harnesses": if self.pizza_bot() { vec![PIZZA_BOT] } else { vec![] },
            "plugins": self.plugins.infos(),
            "mcpServers": self.mcp.servers(),
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

    fn pizza_bot(&self) -> bool {
        self.cfg.engine.available()
    }

    /// Replaces a plugin's agents with what it lists now; one whose id another agent has is skipped.
    fn set_plugin_agents(&self, plugin: &str, listed: Vec<AgentSpec>) {
        let ours = |s: &AgentSpec| matches!(&s.host, Host::Plugin(p) if p == plugin);
        let fresh: Vec<AgentSpec> = {
            let agents = self.agents.read().unwrap();
            let current: Vec<&String> = agents.specs.iter().filter(|s| ours(s)).map(|s| &s.id).collect();
            if listed.len() == current.len() && listed.iter().all(|s| current.contains(&&s.id)) {
                return;
            }
            listed
                .into_iter()
                .filter(|s| {
                    let taken = agents.specs.iter().any(|t| t.id == s.id && !ours(t));
                    if taken {
                        tracing::warn!(plugin = %plugin, agent = %s.id, "plugin agent has the id of another agent; ignored");
                    }
                    !taken
                })
                .collect()
        };
        let routers: Vec<(String, axum::Router)> = fresh.iter().map(|s| (s.id.clone(), self.agent_router(s))).collect();
        let mut agents = self.agents.write().unwrap();
        let gone: Vec<String> = agents.specs.iter().filter(|s| ours(s)).map(|s| s.id.clone()).collect();
        gone.iter().for_each(|id| {
            agents.routers.remove(id);
        });
        agents.specs.retain(|s| !ours(s));
        agents.routers.extend(routers);
        agents.specs.extend(fresh);
        agents.specs.sort_by(|a, b| a.id.cmp(&b.id));
        tracing::info!(plugin = %plugin, agents = ?agents.specs.iter().filter(|s| ours(s)).map(|s| &s.id).collect::<Vec<_>>(), "plugin agents changed");
    }

    /// A plugin's health and agent list; a plugin that exited starts again here.
    async fn check_plugin(&self, plugin: &plugin::Plugin) {
        plugin.check().await;
        match plugin.agents().await {
            Ok(listed) => self.set_plugin_agents(&plugin.def.id, listed),
            Err(e) => tracing::warn!(plugin = %plugin.def.id, "couldn't list agents: {e}"),
        }
    }

    async fn check_plugins(&self) {
        for plugin in self.plugins.all() {
            self.check_plugin(&plugin).await;
        }
    }

    /// Adds an agent through its plugin from what a UI filled in, and serves it right away.
    async fn add_plugin_agent(&self, plugin_id: &str, body: &Value) -> Result<Value, ApiError> {
        let plugin = self.plugins.get(plugin_id).ok_or_else(|| api_error(StatusCode::NOT_FOUND, format!("this runner has no {plugin_id} plugin")))?;
        let fields = body.get("fields").filter(|f| f.is_object()).ok_or_else(|| api_error(StatusCode::BAD_REQUEST, "body must be {\"fields\": {...}}"))?;
        let id = plugin.add(fields).await.map_err(|e| api_error(StatusCode::BAD_REQUEST, e))?;
        self.check_plugin(&plugin).await;
        let served = {
            let mut agents = self.agents.write().unwrap();
            if !agents.specs.iter().any(|s| s.id == id) {
                return Err(api_error(StatusCode::CONFLICT, format!("the {plugin_id} plugin added {id:?}, but another agent already has that id")));
            }
            agents.served.insert(id.clone());
            agents.served.clone()
        };
        self.save_served(&served)?;
        tracing::info!(plugin = %plugin_id, agent = %id, "plugin agent added");
        let mut index = self.index();
        index["created"] = json!(id);
        Ok(index)
    }

    /// The plugin that added this agent, when it was added from the Fleet page; removing it deletes it there.
    fn added_through(&self, id: &str) -> Option<Arc<plugin::Plugin>> {
        let agents = self.agents.read().unwrap();
        let spec = agents.specs.iter().find(|s| s.id == id && s.added)?;
        match &spec.host {
            Host::Plugin(p) => self.plugins.get(p),
            Host::Engine(_) => None,
        }
    }

    async fn remove_plugin_agent(&self, plugin: &plugin::Plugin, id: &str) -> Result<Value, ApiError> {
        plugin.remove(id).await.map_err(|e| api_error(StatusCode::BAD_REQUEST, e))?;
        self.check_plugin(plugin).await;
        let served = {
            let mut agents = self.agents.write().unwrap();
            agents.served.remove(id);
            agents.served.clone()
        };
        self.save_served(&served)?;
        tracing::info!(plugin = %plugin.def.id, agent = %id, "plugin agent removed");
        Ok(self.index())
    }

    fn parse_agent(&self, body: &Value) -> Result<created::NewAgent, ApiError> {
        if !self.pizza_bot() {
            return Err(api_error(StatusCode::CONFLICT, "this runner has no built-in engine to run created agents; set RUNNER_HARNESS_PIZZA_BOT"));
        }
        let agent = created::parse_request(body).map_err(|e| api_error(StatusCode::BAD_REQUEST, e))?;
        let known = self.mcp.ids();
        if let Some(missing) = agent.mcp.iter().find(|id| !known.contains(id)) {
            return Err(api_error(StatusCode::BAD_REQUEST, format!("this runner has no MCP server {missing:?}")));
        }
        Ok(agent)
    }

    /// Writes a new prompt agent into the created-agents folder and serves it right away.
    fn create(&self, body: &Value) -> Result<Value, ApiError> {
        let agent = self.parse_agent(body)?;
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
            created_dir_of(&self.cfg, spec)
                .cloned()
                .ok_or_else(|| api_error(StatusCode::CONFLICT, format!("{id:?} ships with the runner or a plugin; only agents created here can be edited")))?
        };
        let mut request = body.as_object().cloned().unwrap_or_default();
        request.insert("id".into(), json!(id));
        let agent = self.parse_agent(&Value::Object(request))?;
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
            created_dir_of(&self.cfg, spec).cloned()
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

async fn put_mcp_server(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    if !authorized(&headers, &app.bearer) {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    app.mcp.put(&id, &body).map_err(|e| api_error(StatusCode::BAD_REQUEST, e))?;
    tracing::info!(server = %id, "MCP server saved");
    Ok(Json(app.index()))
}

/// Agents that name a removed server still run; the harness reports it as unavailable.
async fn delete_mcp_server(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if !authorized(&headers, &app.bearer) {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    if !app.mcp.remove(&id).map_err(|e| api_error(StatusCode::INTERNAL_SERVER_ERROR, e))? {
        return Err(api_error(StatusCode::NOT_FOUND, format!("this runner has no MCP server {id:?}")));
    }
    tracing::info!(server = %id, "MCP server removed");
    Ok(Json(app.index()))
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
    match app.added_through(&id) {
        Some(plugin) => app.remove_plugin_agent(&plugin, &id).await.map(Json),
        None => app.delete(&id).map(Json),
    }
}

async fn post_plugin_agent(State(app): State<Arc<App>>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<Value>) -> Result<(StatusCode, Json<Value>), ApiError> {
    if !authorized(&headers, &app.bearer) {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    app.add_plugin_agent(&id, &body).await.map(|index| (StatusCode::CREATED, Json(index)))
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
            return Err(format!("RUNNER_AGENTS lists {missing:?}, but neither {} nor a plugin has such an agent", cfg.agents_dir.display()));
        }
        return Ok(only.iter().cloned().collect());
    }
    Ok(specs.iter().map(|s| s.id.clone()).collect())
}

/// Shipped agents, then created ones; a created agent can't shadow a shipped one. A runner may ship none.
fn load_specs(cfg: &Config) -> Result<Vec<AgentSpec>, String> {
    let shipped = if cfg.agents_dir.is_dir() { manifest::load(&cfg.agents_dir)? } else { vec![] };
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
    let moved = created::migrate_to_engine(&cfg.created_dir);
    if moved > 0 {
        tracing::info!(moved, "moved created agents to the built-in engine");
    }
    let specs = load_specs(&cfg)?;

    let sqlite = Arc::new(store::SqliteTaskStore::open(&cfg.db).map_err(|e| e.to_string())?);
    let orphans = sqlite.fail_orphans().map_err(|e| e.to_string())?;
    if orphans > 0 {
        tracing::warn!(orphans, "marked tasks interrupted by restart as failed");
    }
    let plugins = Plugins::new(plugin::load_defs(&cfg.plugins_dir, &cfg.plugin_data));
    let saved = sqlite.served_agents().map_err(|e| e.to_string())?;
    let app = Arc::new(App {
        bearer: Arc::new(format!("Bearer {}", cfg.token)),
        store: store::SharedStore(sqlite.clone()),
        sqlite,
        runs: exec::Runs::default(),
        plugins,
        mcp: mcp::McpLibrary::new(cfg.mcp_config.clone()),
        agents: RwLock::new(Agents { specs: vec![], served: BTreeSet::new(), routers: HashMap::new() }),
        cfg,
    });
    let routers: HashMap<String, axum::Router> = specs.iter().map(|s| (s.id.clone(), app.agent_router(s))).collect();
    {
        let mut agents = app.agents.write().unwrap();
        agents.specs = specs;
        agents.routers = routers;
    }
    app.check_plugins().await;
    let served = initial_served(&app.cfg, &app.agents.read().unwrap().specs, saved)?;
    app.agents.write().unwrap().served = served;
    let checker = app.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(PLUGIN_CHECK_EVERY);
        every.tick().await;
        loop {
            every.tick().await;
            checker.check_plugins().await;
        }
    });

    let router = axum::Router::new()
        .route("/agents", get(|State(app): State<Arc<App>>| async move { Json(app.index()) }).put(put_agents).post(post_agents))
        .route("/agents/{id}", delete(delete_agent).put(put_agent))
        .route("/mcp-servers/{id}", put(put_mcp_server).delete(delete_mcp_server))
        .route("/plugins/{id}/agents", post(post_plugin_agent))
        .route("/agents/{id}/{*rest}", any(agent_request))
        .with_state(app.clone());

    let listener = tokio::net::TcpListener::bind(&app.cfg.bind).await.map_err(|e| e.to_string())?;
    let ids: Vec<String> = app.agents.read().unwrap().served.iter().cloned().collect();
    let plugin_ids: Vec<String> = app.plugins.all().iter().map(|p| p.def.id.clone()).collect();
    tracing::info!(name = %app.cfg.name, agents = ?ids, engine = app.pizza_bot(), plugins = ?plugin_ids, bind = %app.cfg.bind, public_url = %app.cfg.public_url, "runner listening");
    axum::serve(listener, router).await.map_err(|e| e.to_string())
}
