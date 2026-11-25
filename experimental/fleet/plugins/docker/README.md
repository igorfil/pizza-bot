# Docker plugin

Runs container agents. Each folder in `agents/` (or `DOCKER_AGENTS_DIR`) is one agent: an image run
with `docker run --rm -i --init` once per task. The container speaks the same one-shot contract as a
Python agent ([python/README.md](../python/README.md#the-agent-contract)): one JSON input on stdin,
status, artifact and error lines on stdout, and its exit code. Cancel and timeout run `docker kill`
on the run's container (`fleet-<task id>`).

```toml
name = "Hello container"                  # shown in UIs
description = "Answers from an Alpine container …"
image = "alpine:3.21"                     # required
command = ["sh", "-c", "…"]               # optional; replaces the image's command
args = ["--network", "none"]              # optional; extra `docker run` flags, before the image
timeout_secs = 120                        # optional, default 600

[input]                                   # optional; how UIs label the input box
label = "Topic"

[env]                                     # passed into the container with --env
MODEL = "us.anthropic.claude-haiku-5-5"
```

The container gets only `[env]` and `FLEET_TASK_ID`, not the runner's environment; pass anything
else (credentials, mounts) with `args`. The plugin is healthy when `docker version` reaches a daemon.
`DOCKER` overrides the CLI it calls (e.g. `podman`).

The runner's user must be allowed to use Docker. On Linux that usually means the `docker` group,
which is root on that machine in all but name: give it only to a runner you trust like root, or use
rootless Docker or Podman.

## The agents here

| id | Does |
|---|---|
| `hello` | answers from an Alpine container with the machine's architecture; no LLM |

## Testing

```bash
npm test -w @pizza-bot/fleet-plugins   # src/docker.test.ts runs a fake docker; no daemon needed
```
