use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const DEFAULT_TIMEOUT_SECS: u64 = 600;

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

/// How a run starts: the agent's own command, or a harness the runner provides (e.g. `pizza-bot`).
#[derive(Debug, Clone, PartialEq)]
pub enum Launch {
    Command(String),
    Harness(String),
}

/// One agent folder, as the runner serves it. See agents/README.md for the contract.
#[derive(Debug, Clone)]
pub struct AgentSpec {
    pub id: String,
    pub dir: PathBuf,
    pub name: String,
    pub description: String,
    pub launch: Launch,
    pub timeout_secs: u64,
    pub input: Option<InputSpec>,
    pub env: BTreeMap<String, String>,
    /// Ids of the runner's MCP servers the agent uses.
    pub mcp: Vec<String>,
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

pub fn parse(id: &str, dir: &Path, toml_text: &str) -> Result<AgentSpec, String> {
    if !valid_id(id) {
        return Err(format!("agent folder {id:?} must be lowercase letters, digits, - or _"));
    }
    let m: Manifest = toml::from_str(toml_text).map_err(|e| format!("{id}/agent.toml: {e}"))?;
    let launch = match (m.command, m.harness) {
        (Some(command), None) => Launch::Command(command),
        (None, Some(harness)) => Launch::Harness(harness),
        _ => return Err(format!("{id}/agent.toml needs either command or harness")),
    };
    Ok(AgentSpec {
        id: id.to_string(),
        dir: dir.to_path_buf(),
        name: m.name,
        description: m.description,
        launch,
        timeout_secs: m.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS),
        input: m.input,
        env: m.env,
        mcp: m.mcp,
    })
}

/// Every `<dir>/<id>/agent.toml`, sorted by id.
pub fn load(dir: &Path) -> Result<Vec<AgentSpec>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read agents dir {}: {e}", dir.display()))?;
    let mut specs: Vec<AgentSpec> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("agent.toml").is_file())
        .map(|p| {
            let id = p.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let text = std::fs::read_to_string(p.join("agent.toml")).map_err(|e| format!("{id}/agent.toml: {e}"))?;
            parse(&id, &p, &text)
        })
        .collect::<Result<_, _>>()?;
    specs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(specs)
}

/// The first id with no agent folder, so a typo never silently serves nothing.
pub fn unknown<'a>(specs: &[AgentSpec], ids: &'a [String]) -> Option<&'a String> {
    ids.iter().find(|id| !specs.iter().any(|s| &s.id == *id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
name = "Dad jokes"
description = "Writes jokes."
command = "uv run agent.py"
timeout_secs = 30
[input]
label = "Topic"
hint = "about what"
example = "tacos"
[env]
MODEL = "m"
"#;

    #[test]
    fn parses_a_full_manifest() {
        let s = parse("dadjokes", Path::new("/a"), FULL).unwrap();
        assert_eq!(
            (s.name.as_str(), s.timeout_secs, s.input.unwrap().label, s.env["MODEL"].as_str()),
            ("Dad jokes", 30, "Topic".to_string(), "m")
        );
    }

    #[test]
    fn defaults_the_timeout() {
        let s = parse("x", Path::new("/a"), "name = \"X\"\ncommand = \"true\"").unwrap();
        assert_eq!(s.timeout_secs, DEFAULT_TIMEOUT_SECS);
    }

    #[test]
    fn requires_a_command() {
        assert!(parse("x", Path::new("/a"), "name = \"X\"").is_err());
    }

    #[test]
    fn takes_a_harness_instead_of_a_command() {
        let s = parse("x", Path::new("/a"), "name = \"X\"\nharness = \"pizza-bot\"").unwrap();
        assert_eq!(s.launch, Launch::Harness("pizza-bot".into()));
    }

    #[test]
    fn refuses_both_a_command_and_a_harness() {
        assert!(parse("x", Path::new("/a"), "name = \"X\"\ncommand = \"true\"\nharness = \"pizza-bot\"").is_err());
    }

    #[test]
    fn rejects_ids_unsafe_for_urls() {
        assert!(parse("My Agent", Path::new("/a"), "name = \"X\"\ncommand = \"true\"").is_err());
    }

    #[test]
    fn names_the_first_id_without_a_folder() {
        let specs = vec![parse("a", Path::new("/a"), "name = \"A\"\ncommand = \"true\"").unwrap()];
        let ids = vec!["a".to_string(), "typo".to_string()];
        assert_eq!(unknown(&specs, &ids), Some(&"typo".to_string()));
    }
}
