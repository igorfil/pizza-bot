#!/bin/bash
# TEMPORARY, for testing the AWS guide before a release exists: builds this checkout's runner and agents
# (dev-build.sh) and copies them with scp over SSM into /tmp/fleet-local on the instance, where the
# guide's install script reads them through file:// instead of downloading a release.
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
  arm64) ASSET=fleet-runner-aarch64-linux-musl ;;
  x86_64) ASSET=fleet-runner-x86_64-linux-musl ;;
  *) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

if [ "${FLEET_DEV_SKIP_BUILD:-0}" != 1 ]; then
  bash "$FLEET/deploy/dev-build.sh" "$ARCH"
fi
[ -f "$DIST/$ASSET" ] && [ -f "$DIST/fleet-agents.tar.gz" ] || { echo "no local build in $DIST" >&2; exit 1; }

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
scp "${SSH_OPTS[@]}" "$DIST/$ASSET" "$DIST/fleet-agents.tar.gz" "$SSH_USER@$INSTANCE:$REMOTE/"
echo "copied the local build to $INSTANCE:$REMOTE"
