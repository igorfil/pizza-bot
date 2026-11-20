#!/bin/bash
# Forwards localhost:9471 to the EC2 runner's 127.0.0.1:9000 over SSH-over-SSM (no inbound ports on the instance).
# Loops so the tunnel comes back on its own after laptop sleep or network changes.
set -u
INSTANCE_ID="${1:?usage: tunnel.sh <instance-id>}"
REGION="${AWS_REGION:-us-west-2}"

while true; do
  ssh -N \
    -o "ProxyCommand=aws ssm start-session --region $REGION --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p" \
    -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=accept-new \
    -L 127.0.0.1:9471:127.0.0.1:9000 \
    "ec2-user@$INSTANCE_ID"
  echo "tunnel dropped ($?), reconnecting in 3s" >&2
  sleep 3
done
