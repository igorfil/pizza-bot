//! The built-in engine runs the runner's own agents: the command in `RUNNER_HARNESS_PIZZA_BOT`.

pub const PIZZA_BOT: &str = "pizza-bot";

const VAR: &str = "RUNNER_HARNESS_PIZZA_BOT";

#[derive(Debug, Clone, Default)]
pub struct Engine(Option<String>);

impl Engine {
    /// `RUNNER_HARNESS_PIZZA_BOT="node …/main.js"` gives the runner its engine.
    pub fn from_vars(mut vars: impl Iterator<Item = (String, String)>) -> Self {
        Self(vars.find(|(key, _)| key == VAR).map(|(_, command)| command).filter(|c| !c.trim().is_empty()))
    }

    pub fn available(&self) -> bool {
        self.0.is_some()
    }

    /// The shell command that starts one run.
    pub fn command(&self) -> Result<String, String> {
        self.0.clone().ok_or_else(|| format!("this runner has no built-in engine; set {VAR}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Engine {
        Engine::from_vars(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
    }

    #[test]
    fn takes_the_engine_command_from_its_variable() {
        assert_eq!(vars(&[("RUNNER_TOKEN", "t"), (VAR, "node main.js")]).command(), Ok("node main.js".to_string()));
    }

    #[test]
    fn a_blank_variable_is_no_engine() {
        assert!(!vars(&[(VAR, " ")]).available());
    }

    #[test]
    fn says_which_variable_a_missing_engine_needs() {
        assert!(vars(&[]).command().unwrap_err().contains(VAR));
    }
}
