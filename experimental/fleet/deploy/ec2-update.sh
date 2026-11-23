#!/bin/bash
# Run on the EC2 box (sudo) to install or update the runner and its agents from S3.
# Usage: sudo BUCKET=agent-fleet-poc-<acct> bash ec2-update.sh
set -euo pipefail
BUCKET="${BUCKET:?set BUCKET}"
AGENTS_DIR=/opt/fleet-agents

if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

aws s3 cp --quiet "s3://$BUCKET/fleet-runner-arm64" /usr/local/bin/fleet-runner.new
install -m 755 /usr/local/bin/fleet-runner.new /usr/local/bin/fleet-runner && rm /usr/local/bin/fleet-runner.new

aws s3 cp --quiet "s3://$BUCKET/agents-ec2.tar.gz" /tmp/agents-ec2.tar.gz
rm -rf "$AGENTS_DIR.new" && mkdir -p "$AGENTS_DIR.new"
tar -xzf /tmp/agents-ec2.tar.gz -C "$AGENTS_DIR.new"
rm -rf "$AGENTS_DIR" && mv "$AGENTS_DIR.new" "$AGENTS_DIR"

ENV=/etc/fleet-runner.env
sed -i '/^RUNNER_AGENT=/d; /^RUNNER_MODEL=/d; /^RUNNER_AGENTS_DIR=/d; /^RUNNER_AGENTS=/d' "$ENV"
printf 'RUNNER_AGENTS_DIR=%s\nRUNNER_AGENTS=\nAWS_REGION=us-west-2\n' "$AGENTS_DIR" >> "$ENV"
grep -q '^AWS_REGION=' "$ENV" && awk '!seen[$0]++' "$ENV" > "$ENV.tmp" && mv "$ENV.tmp" "$ENV" && chmod 600 "$ENV"

# First `uv run` downloads Python and boto3; do it now, as the service user, so the first real run is fast.
for dir in "$AGENTS_DIR"/*/; do
  grep -q '^# /// script' "$dir/agent.py" 2>/dev/null && sudo -u fleet-runner -H bash -c "cd '$dir' && uv sync --script agent.py -q"
done

systemctl restart fleet-runner
sleep 2
systemctl is-active fleet-runner
curl -s localhost:9000/agents
