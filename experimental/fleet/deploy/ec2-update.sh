#!/bin/bash
# Run on the EC2 box (sudo) to install or update the runner from S3.
# Usage: sudo BUCKET=agent-fleet-poc-<acct> bash ec2-update.sh
set -euo pipefail
BUCKET="${BUCKET:?set BUCKET}"

if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

aws s3 cp --quiet "s3://$BUCKET/fleet-runner-arm64" /usr/local/bin/fleet-runner.new
install -m 755 /usr/local/bin/fleet-runner.new /usr/local/bin/fleet-runner && rm /usr/local/bin/fleet-runner.new

ENV=/etc/fleet-runner.env
sed -i '/^RUNNER_AGENT=/d; /^RUNNER_MODEL=/d; /^RUNNER_AGENTS_DIR=/d; /^RUNNER_AGENTS=/d' "$ENV"
printf 'AWS_REGION=us-west-2\n' >> "$ENV"
grep -q '^AWS_REGION=' "$ENV" && awk '!seen[$0]++' "$ENV" > "$ENV.tmp" && mv "$ENV.tmp" "$ENV" && chmod 600 "$ENV"

systemctl restart fleet-runner
sleep 2
systemctl is-active fleet-runner
curl -s localhost:9000/agents
