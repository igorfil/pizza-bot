#!/bin/bash
# TEMPORARY, until runner releases are published: cross-compiles what a fleet-runner-v* release
# publishes (static musl runner + agents tarball) from this checkout, into runner/target-linux/dist.
# `npm run build` runs it for both architectures; the AWS guide copies the result (dev-push.sh).
# Needs: brew install zig; cargo install cargo-zigbuild; rustup target add <arch>-unknown-linux-musl.
# Usage: dev-build.sh <arm64|x86_64>
set -euo pipefail
ARCH="${1:?usage: dev-build.sh <arm64|x86_64>}"
FLEET="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$FLEET/runner/target-linux/dist"
export PATH="$HOME/.cargo/bin:$PATH"

case "$ARCH" in
  arm64) TARGET=aarch64-unknown-linux-musl ASSET=fleet-runner-aarch64-linux-musl NODE_ARCH=arm64 ;;
  x86_64) TARGET=x86_64-unknown-linux-musl ASSET=fleet-runner-x86_64-linux-musl NODE_ARCH=x64 ;;
  *) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac
ENGINE_ASSET="fleet-engine-$NODE_ARCH-linux.tar.gz"
# The engine bundle targets Node 24 (apps/fleet-agent/scripts/bundle.mjs).
NODE_VERSION=v24.22.3
ROOT="$(cd "$FLEET/../.." && pwd)"
BUNDLE="$ROOT/apps/fleet-agent/dist"
SQLITE="$ROOT/node_modules/better-sqlite3"

command -v zig >/dev/null || { echo "zig is missing: brew install zig" >&2; exit 1; }
command -v cargo-zigbuild >/dev/null || { echo "cargo-zigbuild is missing: cargo install cargo-zigbuild" >&2; exit 1; }
rustup target list --installed 2>/dev/null | grep -qx "$TARGET" || { echo "the Rust target is missing: rustup target add $TARGET" >&2; exit 1; }
[ -f "$BUNDLE/main.js" ] || { echo "the built-in engine isn't built: run npm run build" >&2; exit 1; }

mkdir -p "$DIST"
(cd "$FLEET/runner" && CARGO_TARGET_DIR="$FLEET/runner/target-linux" cargo zigbuild --release --locked --target "$TARGET")
cp "$FLEET/runner/target-linux/$TARGET/release/fleet-runner" "$DIST/$ASSET"

# Keeps macOS extended attributes (com.apple.provenance) out; Linux tar warns about each one.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$DIST/fleet-agents.tar.gz" -C "$FLEET/agents" --exclude README.md --exclude .venv --exclude __pycache__ .

# The built-in engine: Node, the fleet-agent bundle, and better-sqlite3 with only its Linux binaries (N-API, any Node 24).
CACHE="$FLEET/runner/target-linux/cache"
NODE_TARBALL="$CACHE/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
mkdir -p "$CACHE"
[ -f "$NODE_TARBALL" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o "$NODE_TARBALL"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/node" "$STAGE/fleet-agent/node_modules/better-sqlite3/prebuilds"
tar -xJf "$NODE_TARBALL" -C "$STAGE/node" --strip-components=1 "node-$NODE_VERSION-linux-$NODE_ARCH/bin/node"
cp "$BUNDLE"/* "$STAGE/fleet-agent/"
cp -R "$SQLITE/package.json" "$SQLITE/lib" "$STAGE/fleet-agent/node_modules/better-sqlite3/"
cp "$SQLITE/prebuilds/linux-$NODE_ARCH.node" "$SQLITE/prebuilds/linuxmusl-$NODE_ARCH.node" "$STAGE/fleet-agent/node_modules/better-sqlite3/prebuilds/"
echo "$NODE_VERSION" > "$STAGE/VERSION"
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$DIST/$ENGINE_ASSET" -C "$STAGE" .
ls -l "$DIST"
