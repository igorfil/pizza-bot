use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::PIZZA_BOT;

pub const DEFAULT_TIMEOUT_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct InputSpec {
    pub label: String,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub example: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    name: String,
    #[serde(default)]
    description: String,
    command: Option<String>,
    harness: Option<String>,
    timeout_secs: Option<u64>,
    input: Option<InputSpec>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    mcp: Vec<String>,
}

/// A built-in agent's folder: the engine runs it with its `[env]`, and its picks from the runner's MCP servers.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineAgent {
    pub dir: PathBuf,
    pub env: BTreeMap<String, String>,
    pub mcp: Vec<String>,
}

/// Built-in agents run on the runner's engine, which configures them; plugin agents are external and bring their own tools.
#[derive(Debug, Clone, PartialEq)]
pub enum Host {
    Engine(EngineAgent),
    Plugin(String),
}

/// One agent, as the runner serves it. See agents/README.md and plugins/README.md.
#[derive(Debug, Clone)]
pub struct AgentSpec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub timeout_secs: u64,
    pub input: Option<InputSpec>,
    pub host: Host,
    /// Added from the Fleet page through its plugin, so removing it deletes it instead of only disabling it.
    pub added: bool,
}

impl AgentSpec {
    pub fn engine(&self) -> Option<&EngineAgent> {
        match &self.host {
            Host::Engine(e) => Some(e),
            Host::Plugin(_) => None,
        }
    }

    pub fn builtin(&self) -> bool {
        self.engine().is_some()
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// A built-in agent folder; anything else runs through a plugin.
pub fn parse(id: &str, dir: &Path, toml_text: &str) -> Result<AgentSpec, String> {
    if !valid_id(id) {
        return Err(format!("agent folder {id:?} must be lowercase letters, digits, - or _"));
    }
    let m: Manifest = toml::from_str(toml_text).map_err(|e| format!("{id}/agent.toml: {e}"))?;
    if m.command.is_some() || m.harness.as_deref() != Some(PIZZA_BOT) {
        return Err(format!(
            "{id}/agent.toml: agent folders run on the built-in engine (harness = \"{PIZZA_BOT}\"); run other agents through a plugin (plugins/README.md)"
        ));
    }
    Ok(AgentSpec {
        id: id.to_string(),
        name: m.name,
        description: m.description,
        timeout_secs: m.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS),
        input: m.input,
        host: Host::Engine(EngineAgent { dir: dir.to_path_buf(), env: m.env, mcp: m.mcp }),
        added: false,
    })
}

/// Every `<dir>/<id>/agent.toml`, sorted by id; a folder that doesn't parse is skipped with a warning,
/// so one stale agent can't keep the runner from starting.
pub fn load(dir: &Path) -> Result<Vec<AgentSpec>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read agents dir {}: {e}", dir.display()))?;
    let mut specs: Vec<AgentSpec> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("agent.toml").is_file())
        .filter_map(|p| {
            let id = p.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let parsed = std::fs::read_to_string(p.join("agent.toml")).map_err(|e| format!("{id}/agent.toml: {e}")).and_then(|t| parse(&id, &p, &t));
            parsed.map_err(|e| tracing::warn!(agent = %id, "skipping agent: {e}")).ok()
        })
        .collect();
    specs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(specs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
name = "Web research"
description = "Reads pages."
harness = "pizza-bot"
timeout_secs = 30
mcp = ["fetch"]
[input]
label = "Question"
hint = "about what"
example = "tacos"
[env]
MODEL = "m"
"#;

    #[test]
    fn parses_a_full_manifest() {
        let s = parse("webresearch", Path::new("/a"), FULL).unwrap();
        let e = s.engine().unwrap();
        assert_eq!(
            (s.name.as_str(), s.timeout_secs, s.input.as_ref().map(|i| i.label.as_str()), e.env["MODEL"].as_str(), e.mcp.clone()),
            ("Web research", 30, Some("Question"), "m", vec!["fetch".to_string()])
        );
    }

    #[test]
    fn defaults_the_timeout() {
        let s = parse("x", Path::new("/a"), "name = \"X\"\nharness = \"pizza-bot\"").unwrap();
        assert_eq!(s.timeout_secs, DEFAULT_TIMEOUT_SECS);
    }

    #[test]
    fn an_agent_folder_is_builtin() {
        assert!(parse("x", Path::new("/a"), "name = \"X\"\nharness = \"pizza-bot\"").unwrap().builtin());
    }

    #[test]
    fn sends_a_command_agent_to_a_plugin() {
        let err = parse("x", Path::new("/a"), "name = \"X\"\ncommand = \"true\"").unwrap_err();
        assert!(err.contains("plugin"), "{err}");
    }

    #[test]
    fn refuses_another_harness() {
        assert!(parse("x", Path::new("/a"), "name = \"X\"\nharness = \"docker\"").is_err());
    }

    #[test]
    fn requires_a_harness() {
        assert!(parse("x", Path::new("/a"), "name = \"X\"").is_err());
    }

    #[test]
    fn rejects_ids_unsafe_for_urls() {
        assert!(parse("My Agent", Path::new("/a"), "name = \"X\"\nharness = \"pizza-bot\"").is_err());
    }

    #[test]
    fn skips_an_agent_folder_that_isnt_for_the_engine() {
        let dir = std::env::temp_dir().join(format!("fleet-agents-load-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("good")).unwrap();
        std::fs::create_dir_all(dir.join("old")).unwrap();
        std::fs::write(dir.join("good/agent.toml"), "name = \"Good\"\nharness = \"pizza-bot\"").unwrap();
        std::fs::write(dir.join("old/agent.toml"), "name = \"Old\"\ncommand = \"uv run agent.py\"").unwrap();
        let ids: Vec<String> = load(&dir).unwrap().into_iter().map(|s| s.id).collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(ids, vec!["good".to_string()]);
    }
}
