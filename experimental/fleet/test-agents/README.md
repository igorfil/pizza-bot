# Test agents

Runners and plugins ship no agents. These are for trying the fleet out and for tests; `add.mjs`
adds them to a runner through the Controller, with the same intents the Fleet page sends.

```bash
node experimental/fleet/test-agents/add.mjs                     # all of them, on the laptop runner
node experimental/fleet/test-agents/add.mjs slow webresearch    # some
node experimental/fleet/test-agents/add.mjs --runner ec2 webresearch
```

It talks to the Controller at `FLEET_URL` (default `http://127.0.0.1:7700`) with `FLEET_TOKEN`
(default: `~/.agent-fleet/token`, or `$FLEET_HOME/token`). An agent the runner already has is
skipped. Each one is an ordinary agent afterwards: edit or delete it on the Fleet page.

| name | added as | needs |
|---|---|---|
| `webresearch` | a created agent on the built-in engine: [system.md](webresearch/system.md), the [page-brief](webresearch/skills/page-brief) skill, and the runner's `fetch` MCP server (`uvx mcp-server-fetch`), which the script adds if it's missing | the engine, `uv`, Bedrock access to Claude Haiku 5.5 |
| `slow` | a Python plugin agent running [slow/agent.py](slow/agent.py): `steps=N every=S <text>` reports N progress steps, S seconds apart. For disconnect tests; no LLM | the Python plugin; this folder on the runner's machine |
| `hello` | a Docker plugin agent: an `alpine:3.21` container that answers with the machine's architecture; no LLM | the Docker plugin and Docker |
| `ask` | a Claude Code plugin agent working in this folder | the Claude Code plugin and `claude` |

`slow` and `ask` point at folders in this checkout, so they only work on a runner on this machine.
