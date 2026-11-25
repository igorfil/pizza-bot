//! Agents made over `POST /agents`: a folder with agent.toml, system.md and skills, run on the
//! runner's built-in engine (the `pizza-bot` harness).

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde_json::{Value, json};

use crate::harness::PIZZA_BOT;
use crate::manifest;

const MAX_NAME: usize = 60;
const MAX_PROMPT: usize = 20_000;
const MAX_SKILLS: usize = 20;
const MAX_SKILL_BYTES: usize = 2_000_000;
/// Agents written before the runner kept an MCP library had their own; agents now pick from the runner's.
const LEGACY_MCP_FILE: &str = ".mcp.json";
/// Agents created on a runner without the engine ran this single-call script instead.
const LEGACY_SCRIPT: &str = "agent.py";
const SKILLS_DIR: &str = "skills";
const SKILL_FILE: &str = "SKILL.md";

/// One file of a skill copy, relative to the skill folder.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillFile {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
}

/// An agent's skills are copies: a new copy carries its files, an attached one is kept as it is.
#[derive(Debug, Clone, PartialEq)]
pub enum SkillCopy {
    Keep(String),
    Copy { id: String, files: Vec<SkillFile> },
}

impl SkillCopy {
    fn id(&self) -> &str {
        match self {
            SkillCopy::Keep(id) | SkillCopy::Copy { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model: String,
    pub system_prompt: String,
    /// Ids of the runner's MCP servers.
    pub mcp: Vec<String>,
    pub skills: Vec<SkillCopy>,
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

/// `{name, model, systemPrompt, id?, description?, mcp?, skills?}`; the id defaults to the name's slug.
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
    let mcp = parse_mcp(body.get("mcp"))?;
    let skills = parse_skills(body.get("skills"))?;
    Ok(NewAgent { id, name, description, model, system_prompt, mcp, skills })
}

fn parse_mcp(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(vec![]) };
    let ids: Vec<String> = value
        .as_array()
        .and_then(|a| a.iter().map(|v| v.as_str().map(str::to_string)).collect())
        .ok_or("mcp must be a list of the runner's MCP server ids")?;
    match ids.iter().find(|id| !manifest::valid_id(id)) {
        Some(id) => Err(format!("MCP server id {id:?} must be lowercase letters, digits, - or _")),
        None => Ok(ids.into_iter().collect::<BTreeSet<_>>().into_iter().collect()),
    }
}

/// A path that stays inside the skill folder.
fn relative_path(path: &str) -> Option<PathBuf> {
    let p = PathBuf::from(path);
    let inside = !path.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)));
    inside.then_some(p)
}

fn parse_file(file: &Value) -> Result<SkillFile, String> {
    let path = file.get("path").and_then(Value::as_str).unwrap_or_default();
    let rel = relative_path(path).ok_or_else(|| format!("skill file path {path:?} must stay inside the skill folder"))?;
    let content = file.get("content").and_then(Value::as_str).unwrap_or_default();
    let bytes = match file.get("encoding").and_then(Value::as_str) {
        Some("base64") => base64::engine::general_purpose::STANDARD.decode(content).map_err(|e| format!("{path}: {e}"))?,
        _ => content.as_bytes().to_vec(),
    };
    Ok(SkillFile { path: rel, bytes })
}

/// `{id}` keeps the agent's copy; `{id, files: [{path, content, encoding?}]}` replaces it.
fn parse_skill(value: &Value) -> Result<SkillCopy, String> {
    let id = text(value, "id");
    if !manifest::valid_id(&id) {
        return Err(format!("skill id {id:?} must be lowercase letters, digits, - or _"));
    }
    let Some(files) = value.get("files").and_then(Value::as_array) else { return Ok(SkillCopy::Keep(id)) };
    let files: Vec<SkillFile> = files.iter().map(parse_file).collect::<Result<_, _>>()?;
    if !files.iter().any(|f| f.path == Path::new(SKILL_FILE)) {
        return Err(format!("skill {id:?} has no {SKILL_FILE}"));
    }
    if files.iter().map(|f| f.bytes.len()).sum::<usize>() > MAX_SKILL_BYTES {
        return Err(format!("skill {id:?} is larger than {MAX_SKILL_BYTES} bytes"));
    }
    Ok(SkillCopy::Copy { id, files })
}

fn parse_skills(value: Option<&Value>) -> Result<Vec<SkillCopy>, String> {
    let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(vec![]) };
    let list = value.as_array().ok_or("skills must be a list")?;
    if list.len() > MAX_SKILLS {
        return Err(format!("an agent can have at most {MAX_SKILLS} skills"));
    }
    let skills: Vec<SkillCopy> = list.iter().map(parse_skill).collect::<Result<_, _>>()?;
    match skills.iter().enumerate().find(|(i, s)| skills[..*i].iter().any(|t| t.id() == s.id())) {
        Some((_, s)) => Err(format!("two skills are named {:?}", s.id())),
        None => Ok(skills),
    }
}

/// `name` and `description` from a SKILL.md's frontmatter, for listing.
fn frontmatter_field(skill_md: &str, key: &str) -> String {
    let Some(rest) = skill_md.strip_prefix("---") else { return String::new() };
    rest.lines()
        .take_while(|line| line.trim() != "---")
        .find_map(|line| line.strip_prefix(&format!("{key}:")))
        .map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .unwrap_or_default()
}

/// The skills a created agent holds, for UIs to list and keep.
pub fn skills_json(folder: &Path) -> Value {
    let mut skills: Vec<Value> = std::fs::read_dir(folder.join(SKILLS_DIR))
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_string();
            let skill_md = std::fs::read_to_string(e.path().join(SKILL_FILE)).ok()?;
            Some(json!({ "id": id, "name": frontmatter_field(&skill_md, "name"), "description": frontmatter_field(&skill_md, "description") }))
        })
        .collect();
    skills.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Value::Array(skills)
}

pub fn manifest_toml(agent: &NewAgent) -> String {
    let mut input = toml::Table::new();
    input.insert("label".into(), "Message".into());
    input.insert("hint".into(), "optional; leave empty to just run it".into());
    let mut env = toml::Table::new();
    env.insert("MODEL".into(), agent.model.clone().into());
    let mut doc = toml::Table::new();
    doc.insert("name".into(), agent.name.clone().into());
    doc.insert("description".into(), agent.description.clone().into());
    doc.insert("harness".into(), PIZZA_BOT.into());
    doc.insert("timeout_secs".into(), 300.into());
    if !agent.mcp.is_empty() {
        doc.insert("mcp".into(), toml::Value::Array(agent.mcp.iter().cloned().map(Into::into).collect()));
    }
    doc.insert("input".into(), input.into());
    doc.insert("env".into(), env.into());
    toml::to_string(&doc).unwrap_or_default()
}

/// Writes `<dir>/<id>/` and returns the folder; refuses to overwrite one that exists.
pub fn write(dir: &Path, agent: &NewAgent) -> Result<PathBuf, String> {
    let folder = dir.join(&agent.id);
    if folder.exists() {
        return Err(format!("an agent folder {} already exists", folder.display()));
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    if let Err(e) = rewrite(&folder, agent) {
        let _ = std::fs::remove_dir_all(&folder);
        return Err(e);
    }
    Ok(folder)
}

/// Replaces the manifest, system prompt and skills of an existing agent folder.
pub fn rewrite(folder: &Path, agent: &NewAgent) -> Result<(), String> {
    let io = |e: std::io::Error| format!("{}: {e}", folder.display());
    write_skills(folder, &agent.skills)?;
    std::fs::write(folder.join("agent.toml"), manifest_toml(agent)).map_err(io)?;
    std::fs::write(folder.join("system.md"), &agent.system_prompt).map_err(io)?;
    [LEGACY_MCP_FILE, LEGACY_SCRIPT]
        .map(|f| folder.join(f))
        .iter()
        .filter(|p| p.exists())
        .try_for_each(|p| std::fs::remove_file(p).map_err(io))
}

/// Builds the new `skills/` beside the old one, then swaps, so a failed write leaves the agent as it was.
fn write_skills(folder: &Path, skills: &[SkillCopy]) -> Result<(), String> {
    let current = folder.join(SKILLS_DIR);
    let next = folder.join("skills.next");
    let io = |e: std::io::Error| format!("{}: {e}", next.display());
    if let Some(missing) = skills.iter().find(|s| matches!(s, SkillCopy::Keep(id) if !current.join(id).join(SKILL_FILE).is_file())) {
        return Err(format!("this agent has no skill {:?} to keep; attach it again", missing.id()));
    }
    if next.exists() {
        std::fs::remove_dir_all(&next).map_err(io)?;
    }
    std::fs::create_dir_all(&next).map_err(io)?;
    for skill in skills {
        match skill {
            SkillCopy::Keep(id) => copy_dir(&current.join(id), &next.join(id)).map_err(io)?,
            SkillCopy::Copy { id, files } => {
                for file in files {
                    let target = next.join(id).join(&file.path);
                    std::fs::create_dir_all(target.parent().unwrap_or(&next)).map_err(io)?;
                    std::fs::write(&target, &file.bytes).map_err(io)?;
                }
            }
        }
    }
    if current.exists() {
        std::fs::remove_dir_all(&current).map_err(io)?;
    }
    std::fs::rename(&next, &current).map_err(io)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Moves created agents still on the single-call script to the engine; returns how many moved.
pub fn migrate_to_engine(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries.filter_map(|e| e.ok()).filter(|e| move_to_engine(&e.path()).unwrap_or(false)).count()
}

fn move_to_engine(folder: &Path) -> Result<bool, String> {
    let manifest = folder.join("agent.toml");
    let Ok(text) = std::fs::read_to_string(&manifest) else { return Ok(false) };
    let mut doc: toml::Table = toml::from_str(&text).map_err(|e| e.to_string())?;
    if doc.remove("command").is_none() {
        return Ok(false);
    }
    doc.insert("harness".into(), PIZZA_BOT.into());
    std::fs::write(&manifest, toml::to_string(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let script = folder.join(LEGACY_SCRIPT);
    if script.exists() {
        std::fs::remove_file(&script).map_err(|e| e.to_string())?;
    }
    Ok(true)
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
        let spec = manifest::parse(&a.id, Path::new("/x"), &manifest_toml(&a)).unwrap();
        assert_eq!((spec.name.as_str(), spec.env["MODEL"].as_str()), ("Say \"hi\"", "us.openai.gpt-5.5"));
    }

    fn skill_md(name: &str) -> String {
        format!("---\nname: {name}\ndescription: Briefs on pages.\n---\nBe brief.")
    }

    fn copy(id: &str) -> Value {
        json!({"id": id, "files": [{"path": "SKILL.md", "content": skill_md(id)}, {"path": "references/style.md", "content": "short"}]})
    }

    fn agent(skills: Value, mcp: Value) -> NewAgent {
        parse_request(&json!({"id": "r", "name": "R", "model": "m", "systemPrompt": "", "skills": skills, "mcp": mcp})).unwrap()
    }

    #[test]
    fn writes_a_skill_copy_with_its_files() {
        let dir = std::env::temp_dir().join(format!("fleet-skillcopy-{}", std::process::id()));
        let folder = write(&dir, &agent(json!([copy("brief")]), json!([]))).unwrap();
        let reference = std::fs::read_to_string(folder.join("skills/brief/references/style.md")).unwrap();
        let listed = skills_json(&folder);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((reference.as_str(), listed), ("short", json!([{"id": "brief", "name": "brief", "description": "Briefs on pages."}])));
    }

    #[test]
    fn keeps_an_attached_copy_and_drops_a_detached_one() {
        let dir = std::env::temp_dir().join(format!("fleet-skillkeep-{}", std::process::id()));
        let folder = write(&dir, &agent(json!([copy("brief"), copy("other")]), json!([]))).unwrap();
        rewrite(&folder, &agent(json!([{"id": "brief"}]), json!([]))).unwrap();
        let ids: Vec<String> = skills_json(&folder).as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect();
        let reference = folder.join("skills/brief/references/style.md").is_file();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((ids, reference), (vec!["brief".to_string()], true));
    }

    #[test]
    fn refuses_to_keep_a_skill_the_agent_doesnt_have() {
        let dir = std::env::temp_dir().join(format!("fleet-skillmissing-{}", std::process::id()));
        let result = write(&dir, &agent(json!([{"id": "brief"}]), json!([])));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(result.is_err());
    }

    #[test]
    fn refuses_a_skill_file_outside_its_folder() {
        let body = json!({"name": "R", "model": "m", "systemPrompt": "", "skills": [{"id": "a", "files": [{"path": "SKILL.md", "content": "x"}, {"path": "../../agent.toml", "content": "x"}]}]});
        assert!(parse_request(&body).is_err());
    }

    #[test]
    fn decodes_a_binary_skill_file() {
        let body = json!({"name": "R", "model": "m", "systemPrompt": "", "skills": [{"id": "a", "files": [{"path": "SKILL.md", "content": "x"}, {"path": "logo.png", "content": "AAE=", "encoding": "base64"}]}]});
        let SkillCopy::Copy { files, .. } = &parse_request(&body).unwrap().skills[0] else { panic!("expected a copy") };
        assert_eq!(files[1].bytes, vec![0u8, 1u8]);
    }

    #[test]
    fn rejects_two_skills_with_one_id() {
        let body = json!({"name": "R", "model": "m", "systemPrompt": "", "skills": [copy("a"), {"id": "a"}]});
        assert!(parse_request(&body).is_err());
    }

    #[test]
    fn names_the_runner_mcp_servers_it_uses_in_the_manifest() {
        let a = agent(json!([]), json!(["fetch", "github"]));
        let spec = manifest::parse("r", Path::new("/x"), &manifest_toml(&a)).unwrap();
        assert_eq!(spec.mcp, vec!["fetch".to_string(), "github".to_string()]);
    }

    #[test]
    fn a_created_agent_runs_on_the_engine() {
        let a = parse_request(&json!({"name": "Researcher", "model": "m", "systemPrompt": ""})).unwrap();
        let spec = manifest::parse(&a.id, Path::new("/x"), &manifest_toml(&a)).unwrap();
        assert_eq!(spec.launch, manifest::Launch::Harness(PIZZA_BOT.into()));
    }

    #[test]
    fn rewriting_drops_the_old_single_call_script() {
        let dir = std::env::temp_dir().join(format!("fleet-dropscript-{}", std::process::id()));
        let a = parse_request(&json!({"name": "Old", "model": "m", "systemPrompt": ""})).unwrap();
        let folder = write(&dir, &a).unwrap();
        std::fs::write(folder.join("agent.py"), "print()").unwrap();
        rewrite(&folder, &a).unwrap();
        let script = folder.join("agent.py").exists();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!script);
    }

    #[test]
    fn moves_an_agent_on_the_single_call_script_to_the_engine_once() {
        let dir = std::env::temp_dir().join(format!("fleet-migrate-{}", std::process::id()));
        let folder = dir.join("old");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("agent.toml"), "name = \"Old\"\ncommand = \"uv run --quiet agent.py\"\n[env]\nMODEL = \"m\"\n").unwrap();
        std::fs::write(folder.join("agent.py"), "print()").unwrap();
        let (first, second) = (migrate_to_engine(&dir), migrate_to_engine(&dir));
        let spec = manifest::parse("old", &folder, &std::fs::read_to_string(folder.join("agent.toml")).unwrap()).unwrap();
        let script = folder.join("agent.py").exists();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((first, second, spec.launch, spec.env["MODEL"].as_str(), script), (1, 0, manifest::Launch::Harness(PIZZA_BOT.into()), "m", false));
    }

    #[test]
    fn writes_a_runnable_folder_once() {
        let dir = std::env::temp_dir().join(format!("fleet-created-{}", std::process::id()));
        let a = parse_request(&json!({"name": "Tester", "model": "m", "systemPrompt": "Be kind."})).unwrap();
        let folder = write(&dir, &a).unwrap();
        let files = ["agent.toml", "system.md"].map(|f| folder.join(f).is_file());
        let again = write(&dir, &a).is_err();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((files, again), ([true, true], true));
    }

    #[test]
    fn rewrites_an_agent_in_place() {
        let dir = std::env::temp_dir().join(format!("fleet-rewrite-{}", std::process::id()));
        let a = parse_request(&json!({"name": "Tester", "model": "m", "systemPrompt": "Be kind."})).unwrap();
        let folder = write(&dir, &a).unwrap();
        let b = parse_request(&json!({"id": "tester", "name": "Renamed", "model": "m2", "systemPrompt": "Be brief."})).unwrap();
        rewrite(&folder, &b).unwrap();
        let spec = manifest::parse("tester", &folder, &std::fs::read_to_string(folder.join("agent.toml")).unwrap()).unwrap();
        let prompt = std::fs::read_to_string(folder.join("system.md")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((spec.name.as_str(), spec.env["MODEL"].as_str(), prompt.as_str()), ("Renamed", "m2", "Be brief."));
    }
}
