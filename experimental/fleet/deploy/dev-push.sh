#!/bin/bash
# TEMPORARY, until runner releases are published: copies the Linux runner, agents, plugins and built-in engine that `npm run build`
# made (dev-build.sh) with scp over SSM into /tmp/fleet-local on the instance, where the guide's install
# script reads them through file:// instead of downloading a release.
# A throwaway key goes to the instance through EC2 Instance Connect (valid 60 s), so no key needs to be
# set up there; if that fails, your own ssh keys are tried.
# Usage: dev-push.sh <instance-id> <region> <arm64|x86_64>; AWS credentials come from the environment.
set -euo pipefail
INSTANCE="${1:?usage: dev-push.sh <instance-id> <region> <arm64|x86_64>}"
REGION="${2:?region}"
ARCH="${3:?arch}"
SSH_USER="${FLEET_DEV_SSH_USER:-ec2-user}"
FLEET="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$FLEET/runner/target-linux/dist"
REMOTE=/tmp/fleet-local

case "$ARCH" in
  arm64) ASSET=fleet-runner-aarch64-linux-musl ENGINE=fleet-engine-arm64-linux.tar.gz ;;
  x86_64) ASSET=fleet-runner-x86_64-linux-musl ENGINE=fleet-engine-x64-linux.tar.gz ;;
  *) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

[ -f "$DIST/$ASSET" ] && [ -f "$DIST/fleet-agents.tar.gz" ] && [ -f "$DIST/fleet-plugins.tar.gz" ] && [ -f "$DIST/$ENGINE" ] || {
  echo "there is no $ARCH Linux runner build yet; run npm run build (it needs zig and cargo-zigbuild)" >&2
  exit 1
}

KEYDIR="$(mktemp -d)"
trap 'rm -rf "$KEYDIR"' EXIT
ssh-keygen -q -t ed25519 -N "" -C fleet-dev-push -f "$KEYDIR/key"
IDENTITY=()
if aws ec2-instance-connect send-ssh-public-key --region "$REGION" --instance-id "$INSTANCE" \
  --instance-os-user "$SSH_USER" --ssh-public-key "file://$KEYDIR/key.pub" >/dev/null; then
  IDENTITY=(-i "$KEYDIR/key" -o IdentitiesOnly=yes)
else
  echo "EC2 Instance Connect refused the key; trying your own ssh keys" >&2
fi

SSH_OPTS=(
  -o "ProxyCommand=aws ssm start-session --region $REGION --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p"
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30
  ${IDENTITY[@]+"${IDENTITY[@]}"}
)
ssh "${SSH_OPTS[@]}" "$SSH_USER@$INSTANCE" "rm -rf $REMOTE && mkdir -p $REMOTE"
scp "${SSH_OPTS[@]}" "$DIST/$ASSET" "$DIST/fleet-agents.tar.gz" "$DIST/fleet-plugins.tar.gz" "$DIST/$ENGINE" "$SSH_USER@$INSTANCE:$REMOTE/"
echo "copied the local build to $INSTANCE:$REMOTE"
