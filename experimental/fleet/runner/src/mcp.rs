//! The runner's MCP servers: one Claude-format `mcp.json` that agents pick servers from by id.
//! Servers run on this machine, so the library belongs to the runner, not to an agent.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value, json};

use crate::manifest;

const MAX_SERVERS: usize = 50;

pub struct McpLibrary {
    path: PathBuf,
    /// Serializes read-modify-write of the file.
    lock: Mutex<()>,
}

/// A server needs a `command` (stdio) or a `url` (HTTP); the harness checks the rest when it connects.
pub fn parse_entry(id: &str, entry: &Value) -> Result<Value, String> {
    if !manifest::valid_id(id) {
        return Err(format!("MCP server id {id:?} must be lowercase letters, digits, - or _"));
    }
    let obj = entry.as_object().ok_or_else(|| format!("MCP server {id:?} must be an object"))?;
    let has = |key: &str| obj.get(key).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
    if !has("command") && !has("url") {
        return Err(format!("MCP server {id:?} needs a command or a url"));
    }
    Ok(entry.clone())
}

impl McpLibrary {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    /// Every server by id; a missing or unreadable file is an empty library.
    pub fn servers(&self) -> Map<String, Value> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|v| v.get("mcpServers").and_then(Value::as_object).cloned())
            .unwrap_or_default()
    }

    pub fn ids(&self) -> Vec<String> {
        self.servers().keys().cloned().collect()
    }

    /// Adds the server, or replaces the one with that id.
    pub fn put(&self, id: &str, entry: &Value) -> Result<(), String> {
        let entry = parse_entry(id, entry)?;
        let _guard = self.lock.lock().unwrap();
        let mut servers = self.servers();
        if !servers.contains_key(id) && servers.len() >= MAX_SERVERS {
            return Err(format!("a runner can have at most {MAX_SERVERS} MCP servers"));
        }
        servers.insert(id.to_string(), entry);
        self.save(servers)
    }

    /// Ok(false) when there was no such server.
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let _guard = self.lock.lock().unwrap();
        let mut servers = self.servers();
        let removed = servers.remove(id).is_some();
        if removed {
            self.save(servers)?;
        }
        Ok(removed)
    }

    fn save(&self, servers: Map<String, Value>) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&json!({ "mcpServers": servers })).unwrap_or_default();
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text)
            .and_then(|()| std::fs::rename(&tmp, &self.path))
            .map_err(|e| format!("{}: {e}", self.path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(name: &str) -> McpLibrary {
        let path = std::env::temp_dir().join(format!("fleet-mcp-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        McpLibrary::new(path)
    }

    #[test]
    fn keeps_what_it_was_given() {
        let lib = library("put");
        lib.put("fetch", &json!({"command": "uvx", "args": ["mcp-server-fetch"]})).unwrap();
        let servers = lib.servers();
        let _ = std::fs::remove_file(&lib.path);
        assert_eq!(Value::Object(servers), json!({"fetch": {"command": "uvx", "args": ["mcp-server-fetch"]}}));
    }

    #[test]
    fn removes_a_server() {
        let lib = library("remove");
        lib.put("fetch", &json!({"url": "http://x"})).unwrap();
        let removed = lib.remove("fetch").unwrap();
        let ids = lib.ids();
        let _ = std::fs::remove_file(&lib.path);
        assert_eq!((removed, ids), (true, Vec::<String>::new()));
    }

    #[test]
    fn refuses_a_server_with_nothing_to_start() {
        assert!(parse_entry("fetch", &json!({"args": []})).is_err());
    }

    #[test]
    fn refuses_an_id_unsafe_for_urls() {
        assert!(parse_entry("My Server", &json!({"command": "x"})).is_err());
    }
}
