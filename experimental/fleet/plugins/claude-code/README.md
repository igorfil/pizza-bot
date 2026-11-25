# Claude Code plugin

Runs Claude Code agents. Each folder in `agents/` (or `CLAUDE_CODE_AGENTS_DIR`) is one agent: a
project folder Claude Code works in, run with `claude -p … --output-format stream-json` once per task.
Claude Code brings its own tools, MCP servers, settings and login; the runner's MCP servers never
reach it.

Progress shows as the run's status (what Claude says, or the tool it uses), and the final answer is
the `reply` artifact. A follow-up from the Fleet page (same `contextId`) resumes the earlier Claude
Code session with `--resume`, so it remembers the conversation. Sessions are kept in
`~/.local/state/fleet-claude-code/sessions.json` (`CLAUDE_CODE_STATE`). Cancel and timeout stop the
`claude` process.

```toml
name = "Ask Claude Code"                  # shown in UIs
description = "Answers with Claude Code …"
project = "."                             # the folder it works in; relative to the agent folder, or absolute
model = "sonnet"                          # optional; --model
allowed_tools = ["Read", "Grep"]          # optional; --allowedTools
permission_mode = "acceptEdits"           # optional; --permission-mode
system_prompt = "Be brief."               # optional; --append-system-prompt
max_turns = 3                             # optional; --max-turns
timeout_secs = 300                        # optional, default 600

[input]                                   # optional; how UIs label the input box
label = "Question"

[env]                                     # optional extra environment for claude
```

An empty input is sent as "Go.". Without `allowed_tools` or `permission_mode`, Claude Code can't use
tools that need permission, since nobody is there to approve them. The plugin is healthy when
`claude --version` works; `CLAUDE` overrides the command. The runner's user needs Claude Code
installed and logged in.

## The agents here

| id | Does |
|---|---|
| `ask` | answers questions in this folder; follow-ups continue the conversation |

## Testing

```bash
npm test -w @pizza-bot/fleet-plugins   # src/claude-code.test.ts runs a fake claude; no login needed
```
