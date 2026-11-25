# Deploying the EC2 runner

Everything here is in AWS account `<account-id>`, region `us-west-2`, tagged `Project=agent-fleet-poc`.

## Resources

| Resource | Id / name | Notes |
|---|---|---|
| EC2 instance | `<instance-id>` | `t4g.small`, Amazon Linux 2023 arm64, default VPC subnet `<subnet-id>` (us-west-2a) |
| Security group | `<security-group-id>` (`agent-fleet-poc-runner`) | **No inbound rules.** Default egress. |
| IAM role + instance profile | `agent-fleet-poc-runner` | see policies below |
| S3 bucket | `agent-fleet-poc-<account-id>` | public access blocked; holds `fleet-runner-arm64` and `agents-ec2.tar.gz` (the agent folders the box serves) |
| AMI | `<ami-id>` | from SSM parameter `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64` at launch time |

IAM role policies:
- Managed `AmazonSSMManagedInstanceCore` (Session Manager, no SSH port needed).
- Inline `read-runner-binary`: `s3:GetObject` on `arn:aws:s3:::agent-fleet-poc-<account-id>/*`.
- Inline `invoke-terra`: `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` on
  `arn:aws:bedrock:us-west-2:<account-id>:inference-profile/us.openai.gpt-6.1-terra` and
  `arn:aws:bedrock:*::foundation-model/openai.gpt-6.1-terra` (cross-region profiles route to other US
  regions, hence the `*`).

Started as `t4g.nano` (512 MB); it ran out of memory once the SSM agent plus an account-level SSM
installation document were running, so it was changed to `t4g.small`.

## On the instance

| Path | What |
|---|---|
| `/usr/local/bin/fleet-runner` | static musl binary |
| `/etc/fleet-runner.env` | root-only (0600) env file: `RUNNER_NAME=ec2`, `RUNNER_LOCATION=EC2 us-west-2`, `RUNNER_AGENTS_DIR=/opt/fleet-agents`, `RUNNER_AGENTS=` (none; agents are added from the Fleet page), `AWS_REGION`, `RUNNER_TOKEN`, `RUNNER_BIND=127.0.0.1:9000`, `RUNNER_PUBLIC_URL=http://127.0.0.1:9471`, `RUNNER_DB` |
| `/opt/fleet-agents/` | the shipped agent folders, from `agents-ec2.tar.gz` |
| `/usr/local/bin/uv` | runs `uvx` MCP servers; its cache and downloaded Python live in the service user's home `/var/lib/fleet-runner` |
| `/etc/systemd/system/fleet-runner.service` | `Restart=always`, runs as system user `fleet-runner` |
| `/var/lib/fleet-runner/runner.db` | task store |

The runner listens on 127.0.0.1 only. `RUNNER_PUBLIC_URL` is the **laptop** end of the tunnel,
because the agent card's interface URL is what the Controller's A2A client calls.

The runner token was generated with `openssl rand -hex 24` at launch and is not in this repo. It is
in `/etc/fleet-runner.env` on the instance and in the Controller's Msg log (registered via
`AddRunner`). To read it: `sudo grep RUNNER_TOKEN /etc/fleet-runner.env` over the tunnel ssh below.

## Network: SSH over SSM

No inbound ports. `deploy/tunnel.sh <instance-id>` runs, in a reconnect loop:

```bash
ssh -N -o "ProxyCommand=aws ssm start-session --region us-west-2 --target %h \
    --document-name AWS-StartSSHSession --parameters portNumber=%p" \
  -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:9471:127.0.0.1:9000 ec2-user@<instance-id>
```

Needs locally: AWS CLI credentials, `session-manager-plugin`, and the public key that user-data put
into `ec2-user`'s `authorized_keys` (`~/.ssh/id_ecdsa.pub` was used).

Port 9471 on purpose: 9400 is taken by OpenVPN on this laptop. Binding `127.0.0.1:` explicitly
avoids ssh grabbing only `[::1]`.

Run a command on the box:

```bash
ssh -o BatchMode=yes -o "ProxyCommand=aws ssm start-session --region us-west-2 --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p" \
  ec2-user@<instance-id> 'systemctl is-active fleet-runner; sudo journalctl -u fleet-runner -n 20 --no-pager'
```

## Building the Linux binary

Static musl build for arm64, in Docker (the Mac's Docker is arm64 natively):

```bash
cd runner
docker run --rm --platform linux/arm64 -v "$PWD":/src -v fleet-cargo-registry:/usr/local/cargo/registry \
  -w /src -e CARGO_TARGET_DIR=/src/target-linux rust:alpine \
  sh -c "apk add --no-cache musl-dev && cargo build --release"
# → runner/target-linux/release/fleet-runner  (≈19 MB with the AWS SDK, statically linked)
```

≈7 MB. (While agents were compiled into the runner, the AWS SDK pushed it to 19 MB and needed
`cmake make perl clang` for `aws-lc-sys`; agents now carry their own dependencies.)

## Updating the runner and its agents

1. Build the binary (above) and pack the EC2 agents:
   `COPYFILE_DISABLE=1 tar -czf agents-ec2.tar.gz -C agents --exclude README.md .`
   (`COPYFILE_DISABLE` keeps macOS extended attributes out; Linux tar warns about them otherwise).
2. Upload both to the bucket as `fleet-runner-arm64` and `agents-ec2.tar.gz` (presigned PUTs work:
   `curl -X PUT --upload-file <file> '<presigned url>'`).
3. Copy and run [deploy/ec2-update.sh](../deploy/ec2-update.sh) on the box:
   ```bash
   scp -o "ProxyCommand=aws ssm start-session --region us-west-2 --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p" \
     deploy/ec2-update.sh ec2-user@<instance-id>:/tmp/
   ssh … ec2-user@<instance-id> 'sudo BUCKET=agent-fleet-poc-<account-id> bash /tmp/ec2-update.sh'
   ```
   It installs `uv` if missing, swaps the binary and `/opt/fleet-agents`, rewrites the agent settings
   in `/etc/fleet-runner.env`, pre-warms each Python agent (`uv sync --script`, as the service user)
   so the first real run doesn't wait for a Python download, restarts the service and prints
   `GET /agents`.

Changing only an agent (e.g. its prompt) needs steps 1–3 for the tarball; the runner binary can stay.
A run in flight during restart is marked `failed` by the runner on startup.

## Fresh instance

`deploy/user-data.sh` bootstraps a new box: adds the SSH public key, copies the binary and
`agents-ec2.tar.gz` from S3, installs `uv`, creates the `fleet-runner` user, writes `/etc/fleet-runner.env`, installs and starts the systemd
unit. Replace `__TOKEN__`, `__PUBKEY__`, `__BUCKET__` before passing it as user-data. Launch with the
instance profile, the no-inbound security group, `MetadataOptions.HttpTokens=required`, a subnet with
outbound internet (SSM needs it), and at least `t4g.small`.

## Cleanup

Delete in this order: instance, security group, instance profile (remove role first), role (detach
managed policy, delete inline policies), S3 object, bucket.
