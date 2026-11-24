//! Harnesses run agents that name one instead of their own command; each is a command from `RUNNER_HARNESS_<NAME>`.

use std::collections::BTreeMap;

use crate::manifest::Launch;

const PREFIX: &str = "RUNNER_HARNESS_";

pub const PIZZA_BOT: &str = "pizza-bot";

#[derive(Debug, Clone, Default)]
pub struct Harnesses(BTreeMap<String, String>);

impl Harnesses {
    /// `RUNNER_HARNESS_PIZZA_BOT="node …/main.js"` offers the `pizza-bot` harness.
    pub fn from_vars(vars: impl Iterator<Item = (String, String)>) -> Self {
        Self(
            vars.filter_map(|(key, command)| {
                let name = key.strip_prefix(PREFIX)?.to_lowercase().replace('_', "-");
                (!name.is_empty() && !command.trim().is_empty()).then_some((name, command))
            })
            .collect(),
        )
    }

    pub fn names(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }

    pub fn has(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }

    /// The shell command that starts a run.
    pub fn command(&self, launch: &Launch) -> Result<String, String> {
        match launch {
            Launch::Command(command) => Ok(command.clone()),
            Launch::Harness(name) => self.0.get(name).cloned().ok_or_else(|| {
                format!("this runner has no {name:?} harness; set {PREFIX}{}", name.to_uppercase().replace('-', "_"))
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Harnesses {
        Harnesses::from_vars(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
    }

    #[test]
    fn names_harnesses_from_their_variables() {
        let h = vars(&[("RUNNER_HARNESS_PIZZA_BOT", "node main.js"), ("RUNNER_TOKEN", "t"), ("RUNNER_HARNESS_EMPTY", " ")]);
        assert_eq!(h.names(), vec!["pizza-bot".to_string()]);
    }

    #[test]
    fn starts_a_harness_agent_with_the_harness_command() {
        let h = vars(&[("RUNNER_HARNESS_PIZZA_BOT", "node main.js")]);
        assert_eq!(h.command(&Launch::Harness(PIZZA_BOT.into())), Ok("node main.js".to_string()));
    }

    #[test]
    fn says_which_variable_a_missing_harness_needs() {
        let err = vars(&[]).command(&Launch::Harness(PIZZA_BOT.into())).unwrap_err();
        assert!(err.contains("RUNNER_HARNESS_PIZZA_BOT"), "{err}");
    }
}
