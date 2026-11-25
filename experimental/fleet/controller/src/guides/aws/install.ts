import type { Arch } from "./port.js";

export type InstallOptions = { release: string; arch: Arch; token: string; name: string; region: string; port: number };

const binaryName = (arch: Arch): string => `fleet-runner-${arch === "arm64" ? "aarch64" : "x86_64"}-linux-musl`;

export const AGENTS_TARBALL = "fleet-agents.tar.gz";

/** The built-in engine: Node and the Pizza Bot agent runtime (deploy/dev-build.sh). */
export const engineTarball = (arch: Arch): string => `fleet-engine-${arch === "arm64" ? "arm64" : "x64"}-linux.tar.gz`;

const ENGINE_DIR = "/opt/fleet-engine";

/**
 * Bootstrap run as root over SSM RunCommand. Idempotent: running it again upgrades in place.
 * A fresh runner serves no agents; they are created on, or turned on from, the Fleet page.
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

curl -fsSL "$RELEASE/${engineTarball(o.arch)}" -o /tmp/${engineTarball(o.arch)}
rm -rf ${ENGINE_DIR}.new && mkdir -p ${ENGINE_DIR}.new
tar -xzf /tmp/${engineTarball(o.arch)} -C ${ENGINE_DIR}.new
rm -rf ${ENGINE_DIR} && mv ${ENGINE_DIR}.new ${ENGINE_DIR}

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
RUNNER_HARNESS_PIZZA_BOT=${ENGINE_DIR}/node/bin/node ${ENGINE_DIR}/fleet-agent/main.js
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

/**
 * Calls each model once from the instance, with its own credentials (the instance role), the way agents will.
 * Prints `FLEET_BEDROCK <model> <ok | error code>` per model. Model ids come from AGENT_MODELS.
 */
export const bedrockScript = (models: readonly string[], region: string): string => `#!/bin/bash
set -uo pipefail
UV=$(command -v uv || echo /usr/local/bin/uv)
[ -x "$UV" ] || { echo "uv is not installed on the instance" >&2; exit 1; }
AWS_REGION='${region}' "$UV" run --quiet --no-project --with boto3 python3 - <<'PY'
import os
import boto3
from botocore.exceptions import ClientError

client = boto3.client("bedrock-runtime", region_name=os.environ["AWS_REGION"])
for model in ${JSON.stringify(models)}:
    try:
        client.converse(modelId=model, messages=[{"role": "user", "content": [{"text": "ping"}]}], inferenceConfig={"maxTokens": 1})
        print(f"FLEET_BEDROCK {model} ok", flush=True)
    except ClientError as e:
        print(f"FLEET_BEDROCK {model} {e.response['Error']['Code']}", flush=True)
    except Exception as e:
        print(f"FLEET_BEDROCK {model} {type(e).__name__}", flush=True)
PY
`;

/** A model counts as usable unless Bedrock refused the caller or doesn't know it; a rejected request still proves access. */
const USABLE = new Set(["ok", "ValidationException", "ThrottlingException"]);

export const parseBedrock = (output: string): { usable: string[]; refused: { model: string; reason: string }[] } => {
  const results = [...output.matchAll(/^FLEET_BEDROCK (\S+) (\S+)\s*$/gm)].map((m) => ({ model: m[1]!, reason: m[2]! }));
  return {
    usable: results.filter((r) => USABLE.has(r.reason)).map((r) => r.model),
    refused: results.filter((r) => !USABLE.has(r.reason)),
  };
};

export const uninstallScript = (): string => `#!/bin/bash
set -uo pipefail
systemctl disable --now fleet-runner
rm -f /etc/systemd/system/fleet-runner.service /etc/fleet-runner.env /usr/local/bin/fleet-runner
rm -rf /opt/fleet-agents ${ENGINE_DIR} /tmp/fleet-local
userdel -r fleet-runner
rm -rf /var/lib/fleet-runner
systemctl daemon-reload
echo uninstalled
`;
