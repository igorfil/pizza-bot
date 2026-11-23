#!/bin/bash
# Fleet only, without pizza-bot: Controller, the laptop runner (hosting agents/), and the tunnel to the EC2 runner.
# For both backends plus the web app, run `npm run dev:both` from the repo root.
# Uses a fixed dev token so UIs (TUI, pizza-bot Agent Fleet screen) connect without setup.
set -u
cd "$(dirname "$0")"

export FLEET_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:5273"
EC2_INSTANCE="${EC2_INSTANCE:-}"
DEV_TOKEN="fleet-dev-token"

mkdir -p "$HOME/.agent-fleet"
printf '%s' "$DEV_TOKEN" > "$HOME/.agent-fleet/token"
chmod 600 "$HOME/.agent-fleet/token"

if [ ! -x runner/target/debug/fleet-runner ]; then
  (cd runner && "${CARGO:-$HOME/.cargo/bin/cargo}" build) || exit 1
fi

trap 'kill 0' EXIT INT TERM

# One runner for the laptop, hosting every laptop agent in agents/. dadjokes runs on EC2 instead.
# ~/.toolbox/bin is on PATH because morningbrief calls aws-outlook-mcp (installed by aim/toolbox).
PATH="$HOME/.toolbox/bin:$PATH" RUNNER_NAME=laptop RUNNER_TOKEN=localtoken RUNNER_LOCATION="this laptop" \
  RUNNER_AGENTS_DIR=agents RUNNER_AGENTS=sysreport,morningbrief,slow \
  RUNNER_DB="$HOME/.agent-fleet/laptop-runner.db" RUNNER_BIND=127.0.0.1:9301 AWS_REGION=us-west-2 \
  ./runner/target/debug/fleet-runner &

[ -n "$EC2_INSTANCE" ] && ./deploy/tunnel.sh "$EC2_INSTANCE" &

(cd controller && npx tsx src/main.ts) &

echo "agent-fleet dev: controller http://127.0.0.1:7700  token=$DEV_TOKEN  (Ctrl-C stops everything)"
wait
