#!/bin/bash
# TEMPORARY, for testing the AWS guide before a release exists: cross-compiles what a fleet-runner-v*
# release publishes (static musl runner + agents tarball) from this checkout, into runner/target-linux/dist.
# Needs: brew install zig; cargo install cargo-zigbuild; rustup target add <arch>-unknown-linux-musl.
# Usage: dev-build.sh <arm64|x86_64>
set -euo pipefail
ARCH="${1:?usage: dev-build.sh <arm64|x86_64>}"
FLEET="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$FLEET/runner/target-linux/dist"
export PATH="$HOME/.cargo/bin:$PATH"

case "$ARCH" in
  arm64) TARGET=aarch64-unknown-linux-musl ASSET=fleet-runner-aarch64-linux-musl ;;
  x86_64) TARGET=x86_64-unknown-linux-musl ASSET=fleet-runner-x86_64-linux-musl ;;
  *) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

command -v zig >/dev/null || { echo "zig is missing: brew install zig" >&2; exit 1; }
command -v cargo-zigbuild >/dev/null || { echo "cargo-zigbuild is missing: cargo install cargo-zigbuild" >&2; exit 1; }

mkdir -p "$DIST"
(cd "$FLEET/runner" && CARGO_TARGET_DIR="$FLEET/runner/target-linux" cargo zigbuild --release --locked --target "$TARGET")
cp "$FLEET/runner/target-linux/$TARGET/release/fleet-runner" "$DIST/$ASSET"

# Keeps macOS extended attributes (com.apple.provenance) out; Linux tar warns about each one.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$DIST/fleet-agents.tar.gz" -C "$FLEET/agents" --exclude README.md --exclude .venv --exclude __pycache__ .
ls -l "$DIST"
