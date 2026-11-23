import type { Arch } from "./port.js";

export type InstallOptions = { release: string; arch: Arch; token: string; name: string; region: string; port: number };

const binaryName = (arch: Arch): string => `fleet-runner-${arch === "arm64" ? "aarch64" : "x86_64"}-linux-musl`;

export const AGENTS_TARBALL = "fleet-agents.tar.gz";

/**
 * Bootstrap run as root over SSM RunCommand. Idempotent: running it again upgrades in place.
 * The runner starts serving no agents; the Controller turns them on with `PUT /agents`.
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
RUNNER_AGENTS=
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

for dir in "$AGENTS_DIR"/*/; do
  if grep -q '^# /// script' "$dir/agent.py" 2>/dev/null; then
    sudo -u fleet-runner -H bash -c "cd '$dir' && uv sync --script agent.py -q"
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

/**
 * Reports a runner that is installed and answering, with the token and port the Controller needs.
 * The token passes through SSM command output, like the install script's does through its input.
 */
export const detectScript = (): string => `#!/bin/bash
set -uo pipefail
ENV_FILE=/etc/fleet-runner.env
if [ ! -r "$ENV_FILE" ] || [ ! -x /usr/local/bin/fleet-runner ]; then echo FLEET_RUNNER=absent; exit 0; fi
TOKEN=$(sed -n 's/^RUNNER_TOKEN=//p' "$ENV_FILE" | tail -n 1)
BIND=$(sed -n 's/^RUNNER_BIND=//p' "$ENV_FILE" | tail -n 1)
PORT=\${BIND##*:}
PORT=\${PORT:-9000}
if [ -n "$TOKEN" ] && curl -fs "http://127.0.0.1:$PORT/agents" >/dev/null; then
  echo FLEET_RUNNER=present
  echo "FLEET_RUNNER_PORT=$PORT"
  echo "FLEET_RUNNER_TOKEN=$TOKEN"
else
  echo FLEET_RUNNER=absent
fi
`;

export type ExistingRunner = { port: number; token: string };

const field = (output: string, name: string): string | null => new RegExp(`^${name}=(\\S+)\\s*$`, "m").exec(output)?.[1] ?? null;

/** null unless the output reports a running runner with a usable token and port. */
export const parseDetect = (output: string): ExistingRunner | null => {
  if (field(output, "FLEET_RUNNER") !== "present") return null;
  const port = Number(field(output, "FLEET_RUNNER_PORT"));
  const token = field(output, "FLEET_RUNNER_TOKEN");
  return token && /^[A-Za-z0-9._~+/=-]+$/.test(token) && Number.isInteger(port) && port > 0 && port < 65_536 ? { port, token } : null;
};

export const uninstallScript = (): string => `#!/bin/bash
set -uo pipefail
systemctl disable --now fleet-runner
rm -f /etc/systemd/system/fleet-runner.service /etc/fleet-runner.env /usr/local/bin/fleet-runner
rm -rf /opt/fleet-agents
userdel -r fleet-runner
systemctl daemon-reload
echo uninstalled
`;
