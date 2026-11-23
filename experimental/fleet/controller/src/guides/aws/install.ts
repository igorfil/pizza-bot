import type { Arch } from "./port.js";

export type InstallOptions = { release: string; arch: Arch; token: string; agents: string; name: string; region: string; port: number };

const binaryName = (arch: Arch): string => `fleet-runner-${arch === "arm64" ? "aarch64" : "x86_64"}-linux-musl`;

export const AGENTS_TARBALL = "fleet-agents.tar.gz";

/**
 * Bootstrap run as root over SSM RunCommand. Idempotent: running it again upgrades in place.
 * Every interpolated value is validated by the guide (names, agent ids, hex token, URL).
 */
export const installScript = (o: InstallOptions): string => `#!/bin/bash
set -euo pipefail
RELEASE='${o.release}'
AGENTS_DIR=/opt/fleet-agents

curl -fsSL "$RELEASE/${binaryName(o.arch)}" -o /usr/local/bin/fleet-runner.new
install -m 755 /usr/local/bin/fleet-runner.new /usr/local/bin/fleet-runner
rm -f /usr/local/bin/fleet-runner.new

command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

curl -fsSL "$RELEASE/${AGENTS_TARBALL}" -o /tmp/${AGENTS_TARBALL}
rm -rf "$AGENTS_DIR.new" && mkdir -p "$AGENTS_DIR.new"
tar -xzf /tmp/${AGENTS_TARBALL} -C "$AGENTS_DIR.new"
rm -rf "$AGENTS_DIR" && mv "$AGENTS_DIR.new" "$AGENTS_DIR"

id fleet-runner >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fleet-runner --create-home fleet-runner

umask 077
cat > /etc/fleet-runner.env <<'EOF'
RUNNER_NAME=${o.name}
RUNNER_LOCATION=EC2 ${o.region}
RUNNER_AGENTS_DIR=/opt/fleet-agents
RUNNER_AGENTS=${o.agents}
AWS_REGION=${o.region}
RUNNER_TOKEN=${o.token}
RUNNER_BIND=127.0.0.1:${o.port}
RUNNER_DB=/var/lib/fleet-runner/runner.db
EOF
umask 022

cat > /etc/systemd/system/fleet-runner.service <<'EOF'
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

for agent in $(echo '${o.agents}' | tr ',' ' '); do
  if grep -q '^# /// script' "$AGENTS_DIR/$agent/agent.py" 2>/dev/null; then
    sudo -u fleet-runner -H bash -c "cd $AGENTS_DIR/$agent && uv sync --script agent.py -q"
  fi
done

systemctl daemon-reload
systemctl enable fleet-runner
systemctl restart fleet-runner
for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:${o.port}/agents" && exit 0
  sleep 1
done
echo "the runner did not answer on port ${o.port}" >&2
journalctl -u fleet-runner -n 20 --no-pager >&2
exit 1
`;

export const uninstallScript = (): string => `#!/bin/bash
set -uo pipefail
systemctl disable --now fleet-runner
rm -f /etc/systemd/system/fleet-runner.service /etc/fleet-runner.env /usr/local/bin/fleet-runner
rm -rf /opt/fleet-agents
userdel -r fleet-runner
systemctl daemon-reload
echo uninstalled
`;
