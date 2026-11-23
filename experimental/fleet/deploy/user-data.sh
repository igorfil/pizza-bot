#!/bin/bash
# EC2 user-data for the POC runner. TOKEN, PUBKEY and BUCKET placeholders are filled in at launch.
set -euo pipefail

install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh
echo "__PUBKEY__" >> /home/ec2-user/.ssh/authorized_keys
chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys
chmod 600 /home/ec2-user/.ssh/authorized_keys

aws s3 cp "s3://__BUCKET__/fleet-runner-arm64" /usr/local/bin/fleet-runner
chmod 755 /usr/local/bin/fleet-runner

# Agents are folders run as subprocesses (agents/README.md); Python ones need uv.
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
mkdir -p /opt/fleet-agents
aws s3 cp "s3://__BUCKET__/agents-ec2.tar.gz" /tmp/agents-ec2.tar.gz
tar -xzf /tmp/agents-ec2.tar.gz -C /opt/fleet-agents

useradd --system --home-dir /var/lib/fleet-runner --create-home fleet-runner

umask 077
cat > /etc/fleet-runner.env <<EOF
RUNNER_NAME=ec2
RUNNER_LOCATION=EC2 us-west-2
RUNNER_AGENTS_DIR=/opt/fleet-agents
RUNNER_AGENTS=
AWS_REGION=us-west-2
RUNNER_TOKEN=__TOKEN__
RUNNER_BIND=127.0.0.1:9000
# The card must advertise the URL the Controller sees, i.e. the laptop end of the SSH tunnel.
RUNNER_PUBLIC_URL=http://127.0.0.1:9471
RUNNER_DB=/var/lib/fleet-runner/runner.db
EOF

cat > /etc/systemd/system/fleet-runner.service <<EOF
[Unit]
Description=agent-fleet runner
After=network-online.target

[Service]
User=fleet-runner
EnvironmentFile=/etc/fleet-runner.env
ExecStart=/usr/local/bin/fleet-runner
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now fleet-runner
