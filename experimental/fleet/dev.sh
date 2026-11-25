#!/bin/bash
# One command from a fresh clone to the running fleet experiment: checks prerequisites, runs npm install,
# builds everything, frees the ports, then starts the pizza-bot desktop app (Electron) with the fleet
# (`npm run dev`). Ctrl-C stops everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Vite serves the app's UI to Electron; Electron's own api-server takes a port the OS assigns.
WEB_PORT="${PIZZA_WEB_PORT:-5273}"
PORTS=("$WEB_PORT" 7700 9301)
export PATH="$HOME/.cargo/bin:$PATH"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

missing=()

step "Checking prerequisites"
if have node; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 24 ] || missing+=("Node.js 24 or newer (found $(node -v)): brew install node, or nvm install 24")
else
  missing+=("Node.js 24 or newer: brew install node, or nvm install 24")
fi
have npm || missing+=("npm (comes with Node.js)")
have cargo || missing+=("Rust (cargo): curl https://sh.rustup.rs -sSf | sh")
have uv || missing+=("uv (runs the Python agents): brew install uv")
have lsof || missing+=("lsof (frees the ports before starting)")

# The Linux runners for EC2 (arm64 and x86_64) are cross-compiled with zig; set-up copies them to the
# instance. The pieces that install without asking are installed here.
LINUX_TARGETS=(aarch64-unknown-linux-musl x86_64-unknown-linux-musl)
if ! have zig; then
  if have brew; then
    echo "installing zig (brew install zig)"
    brew install zig
  else
    missing+=("zig (cross-compiles the EC2 runners): https://ziglang.org/download/")
  fi
fi
if have cargo && ! have cargo-zigbuild; then
  echo "installing cargo-zigbuild (cargo install --locked cargo-zigbuild)"
  cargo install --locked cargo-zigbuild
fi
if have rustup; then
  for target in "${LINUX_TARGETS[@]}"; do
    rustup target list --installed | grep -qx "$target" || { echo "adding Rust target $target"; rustup target add "$target"; }
  done
elif have cargo; then
  missing+=("rustup (adds the Linux targets for the EC2 runners): curl https://sh.rustup.rs -sSf | sh")
fi

# The Controller reaches EC2 instances over SSM, and agents call Bedrock with these AWS credentials.
have aws || missing+=("AWS CLI: brew install awscli")
have session-manager-plugin || missing+=("session-manager-plugin (SSM tunnels to EC2): brew install --cask session-manager-plugin")
if have aws && ! aws sts get-caller-identity >/dev/null 2>&1; then
  missing+=("working AWS credentials (EC2 set-up and Bedrock agents): aws configure, or aws sso login")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing, install these and run dev.sh again:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi
echo "ok: node $(node -v), $(cargo --version | cut -d' ' -f1-2), $(uv --version | cut -d' ' -f1-2), $(zig version | sed 's/^/zig /'), $(aws --version 2>&1 | cut -d' ' -f1), AWS account $(aws sts get-caller-identity --query Account --output text)"

step "npm install"
npm install

step "npm run build (pizza-bot, the fleet Controller, the runner and its arm64 + x86_64 Linux builds, the plugins)"
FLEET_REQUIRE_LINUX_RUNNER=1 npm run build
DIST="$ROOT/experimental/fleet/runner/target-linux/dist"
for asset in fleet-runner-aarch64-linux-musl fleet-runner-x86_64-linux-musl fleet-plugins.tar.gz; do
  [ -s "$DIST/$asset" ] || { echo "the build didn't produce $DIST/$asset" >&2; exit 1; }
done
echo "EC2 runner builds: $(cd "$DIST" && ls fleet-runner-* | tr '\n' ' ')"

step "Freeing ports ${PORTS[*]}"
for port in "${PORTS[@]}"; do
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN || true)"
  [ -z "$pids" ] && continue
  echo "port $port is taken by pid(s) $(echo "$pids" | tr '\n' ' ')- stopping them"
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 1
    lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null || break
  done
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN || true)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
done

step "Starting the desktop app (open Fleet in the left rail), Controller :7700, laptop runner :9301"
exec npm run dev
