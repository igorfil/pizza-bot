//! Agents made over `POST /agents`: a folder with agent.toml and system.md, run by the `pizza-bot`
//! harness when the runner has one, else by the built-in single-call prompt script.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::harness::PIZZA_BOT;
use crate::manifest;

const HARNESS: &str = include_str!("prompt_agent.py");
const MAX_NAME: usize = 60;
const MAX_PROMPT: usize = 20_000;

#[derive(Debug, Clone, PartialEq)]
pub struct NewAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub system_prompt: String,
}

/// "Release notes bot!" → "release-notes-bot".
pub fn slug(name: &str) -> String {
    let dashed: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    dashed.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}

fn text(body: &Value, key: &str) -> String {
    body.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 200 && model.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

/// `{name, model, systemPrompt, id?, description?}`; the id defaults to the name's slug.
pub fn parse_request(body: &Value) -> Result<NewAgent, String> {
    let name = text(body, "name");
    let model = text(body, "model");
    let system_prompt = text(body, "systemPrompt");
    let id = Some(text(body, "id")).filter(|id| !id.is_empty()).unwrap_or_else(|| slug(&name));
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(format!("name must be 1-{MAX_NAME} characters"));
    }
    if !manifest::valid_id(&id) {
        return Err(format!("id {id:?} must be lowercase letters, digits, - or _"));
    }
    if !valid_model(&model) {
        return Err("model must be a Bedrock model or inference profile id".to_string());
    }
    if system_prompt.chars().count() > MAX_PROMPT {
        return Err(format!("the system prompt is longer than {MAX_PROMPT} characters"));
    }
    let description = Some(text(body, "description")).filter(|d| !d.is_empty()).unwrap_or_else(|| format!("Answers with {model}."));
    Ok(NewAgent { id, name, description, model, system_prompt })
}

/// `pizza_bot`: run with the `pizza-bot` harness instead of the `agent.py` prompt script.
pub fn manifest_toml(agent: &NewAgent, pizza_bot: bool) -> String {
    let mut input = toml::Table::new();
    input.insert("label".into(), "Message".into());
    input.insert("hint".into(), "optional; leave empty to just run it".into());
    let mut env = toml::Table::new();
    env.insert("MODEL".into(), agent.model.clone().into());
    let mut doc = toml::Table::new();
    doc.insert("name".into(), agent.name.clone().into());
    doc.insert("description".into(), agent.description.clone().into());
    if pizza_bot {
        doc.insert("harness".into(), PIZZA_BOT.into());
    } else {
        doc.insert("command".into(), "uv run --quiet agent.py".into());
    }
    doc.insert("timeout_secs".into(), 300.into());
    doc.insert("input".into(), input.into());
    doc.insert("env".into(), env.into());
    toml::to_string(&doc).unwrap_or_default()
}

/// Writes `<dir>/<id>/` and returns the folder; refuses to overwrite one that exists.
pub fn write(dir: &Path, agent: &NewAgent, pizza_bot: bool) -> Result<PathBuf, String> {
    let folder = dir.join(&agent.id);
    if folder.exists() {
        return Err(format!("an agent folder {} already exists", folder.display()));
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    rewrite(&folder, agent, pizza_bot)?;
    Ok(folder)
}

/// Replaces the manifest, system prompt and harness of an existing agent folder.
pub fn rewrite(folder: &Path, agent: &NewAgent, pizza_bot: bool) -> Result<(), String> {
    let io = |e: std::io::Error| format!("{}: {e}", folder.display());
    std::fs::write(folder.join("agent.toml"), manifest_toml(agent, pizza_bot)).map_err(io)?;
    std::fs::write(folder.join("system.md"), &agent.system_prompt).map_err(io)?;
    let script = folder.join("agent.py");
    if pizza_bot {
        if script.exists() {
            std::fs::remove_file(&script).map_err(io)?;
        }
    } else {
        std::fs::write(&script, HARNESS).map_err(io)?;
    }
    Ok(())
}

/// Brings every created agent's `agent.py` up to the harness in this binary; returns how many changed.
pub fn refresh_harness(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .filter_map(|e| e.ok())
        .map(|e| e.path().join("agent.py"))
        .filter(|p| p.is_file() && std::fs::read_to_string(p).is_ok_and(|text| text != HARNESS))
        .filter(|p| std::fs::write(p, HARNESS).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slugs_names_into_ids() {
        assert_eq!(slug("  Release notes bot! v2 "), "release-notes-bot-v2");
    }

    #[test]
    fn derives_the_id_and_description() {
        let a = parse_request(&json!({"name": "Release notes", "model": "us.anthropic.claude-haiku-5-5", "systemPrompt": "Be brief."})).unwrap();
        assert_eq!((a.id.as_str(), a.description.as_str()), ("release-notes", "Answers with us.anthropic.claude-haiku-5-5."));
    }

    #[test]
    fn rejects_a_model_id_with_shell_characters() {
        assert!(parse_request(&json!({"name": "x", "model": "m; rm -rf /", "systemPrompt": ""})).is_err());
    }

    #[test]
    fn rejects_a_name_with_no_usable_id() {
        assert!(parse_request(&json!({"name": "!!!", "model": "m", "systemPrompt": ""})).is_err());
    }

    #[test]
    fn the_manifest_reads_back_as_an_agent_with_its_model() {
        let a = parse_request(&json!({"name": "Say \"hi\"", "model": "us.openai.gpt-5.5", "systemPrompt": ""})).unwrap();
        let spec = manifest::parse(&a.id, Path::new("/x"), &manifest_toml(&a, false)).unwrap();
        assert_eq!((spec.name.as_str(), spec.env["MODEL"].as_str()), ("Say \"hi\"", "us.openai.gpt-5.5"));
    }

    #[test]
    fn a_pizza_bot_agent_names_the_harness_and_has_no_script() {
        let dir = std::env::temp_dir().join(format!("fleet-pizza-{}", std::process::id()));
        let a = parse_request(&json!({"name": "Researcher", "model": "m", "systemPrompt": ""})).unwrap();
        let folder = write(&dir, &a, false).unwrap();
        rewrite(&folder, &a, true).unwrap();
        let spec = manifest::parse(&a.id, &folder, &std::fs::read_to_string(folder.join("agent.toml")).unwrap()).unwrap();
        let script = folder.join("agent.py").exists();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((spec.launch, script), (manifest::Launch::Harness(PIZZA_BOT.into()), false));
    }

    #[test]
    fn refreshes_an_outdated_harness() {
        let dir = std::env::temp_dir().join(format!("fleet-refresh-{}", std::process::id()));
        let a = parse_request(&json!({"name": "Old", "model": "m", "systemPrompt": ""})).unwrap();
        let folder = write(&dir, &a, false).unwrap();
        std::fs::write(folder.join("agent.py"), "old harness").unwrap();
        let (first, second) = (refresh_harness(&dir), refresh_harness(&dir));
        let text = std::fs::read_to_string(folder.join("agent.py")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((first, second, text == HARNESS), (1, 0, true));
    }

    #[test]
    fn writes_a_runnable_folder_once() {
        let dir = std::env::temp_dir().join(format!("fleet-created-{}", std::process::id()));
        let a = parse_request(&json!({"name": "Tester", "model": "m", "systemPrompt": "Be kind."})).unwrap();
        let folder = write(&dir, &a, false).unwrap();
        let files = ["agent.toml", "system.md", "agent.py"].map(|f| folder.join(f).is_file());
        let again = write(&dir, &a, false).is_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((files, again), ([true, true, true], true));
    }

    #[test]
    fn rewrites_an_agent_in_place() {
        let dir = std::env::temp_dir().join(format!("fleet-rewrite-{}", std::process::id()));
        let a = parse_request(&json!({"name": "Tester", "model": "m", "systemPrompt": "Be kind."})).unwrap();
        let folder = write(&dir, &a, false).unwrap();
        let b = parse_request(&json!({"id": "tester", "name": "Renamed", "model": "m2", "systemPrompt": "Be brief."})).unwrap();
        rewrite(&folder, &b, false).unwrap();
        let spec = manifest::parse("tester", &folder, &std::fs::read_to_string(folder.join("agent.toml")).unwrap()).unwrap();
        let prompt = std::fs::read_to_string(folder.join("system.md")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((spec.name.as_str(), spec.env["MODEL"].as_str(), prompt.as_str()), ("Renamed", "m2", "Be brief."));
    }
}
