# Runner guides: adding runners with a guided setup

Status: design + first implementation (Nov 2026). Answers Q-RUN-7, Q-LOG-3 and part of Q-NET-1 /
Q-NET-3 in [../DESIGN.md](../DESIGN.md).

## Goal

"Add runner" offers a list of **guides**. Each guide is an extension that walks the user through
setting up a runner somewhere (by hand, on AWS EC2, later others) and ends with a saved **runner
config**. The Controller then keeps that runner connected on every start (opening a tunnel when the
config needs one) with no further user action.

## Principles

1. **Guides run in the Controller.** The Fleet page only renders the step the Controller sends and
   posts the user's answers. A guide survives the page closing; on Controller restart it resumes
   from its last logged state.
2. **Setting up (once) is separate from connecting (every start).** The guide is used once and
   produces a `RunnerConfig`. Only the config is kept. Connecting is the job of the runner's
   **transport**.
3. **A transport is an object.** `RunnerConfig.transport` is a serializable spec; a factory turns it
   into a `Transport` instance (`direct`, `aws_ssm`, …) with one method, `open`. Every runner has
   one, including plain URLs, so there is a single connection path.
4. **The connection is a TEA subscription.** `subscriptions(model)` asks for a `Link` per runner; the
   runtime opens and closes transports the way it already does task streams. Restart, laptop wake
   and dropped tunnels all reconnect through the same path, with the existing backoff.
5. **The Controller talks to agents only through the runner.** Every A2A call goes to
   `<link url>/agents/<id>/jsonrpc`; the URL inside the agent card is ignored. Tunnel ports change
   on every start, so the card can't know the URL.
6. **Secrets never enter the Model or the Msg log.** They go to the OS vault; the Model holds
   `SecretRef`s. Secret fields a user types into a guide are written to the vault by the API before
   the Msg is logged.
7. **Testable in pieces.** Guides reach the outside world only through ports passed in (`vault`,
   `aws`, `transports`, `fetch`), so each step is tested with fakes. Transports, vault and AWS have
   real and fake implementations behind one interface each.
8. **Clean slate.** Nothing is shared with pizza-bot (its vault is Electron `safeStorage`, which a
   plain Node process can't use anyway).

## Entities

```
controller/src/
  vault.ts            SecretStore: OS keychain (macOS / Linux Secret Service / Windows Credential
                      Manager via @napi-rs/keyring) and in-memory
  transport.ts        Transport interface, factory, direct + aws_ssm implementations
  guides/
    guide.ts          RunnerGuide interface, StepView schema, ports
    registry.ts       the list of guides (the extension point)
    manual.ts         name + URL + token
    aws/              guide.ts (steps) · ec2.ts (Ec2Host on AWS SDK v3) · install.ts (bootstrap script)
                      · profiles.ts (~/.aws/config and ~/.aws/credentials)
  types.ts · update.ts · runtime.ts · api.ts   wiring (below)
```

### SecretStore (vault)

```ts
type SecretRef = { kind: "vault"; key: string } | { kind: "inline"; value: string };
interface SecretStore {
  get(key: string): Promise<Outcome<string | null>>;
  set(key: string, value: string): Promise<Outcome<void>>;
  delete(key: string): Promise<Outcome<void>>;
}
```

- `os`: the OS keychain, service `agent-fleet`. One native package covers the three OSes and avoids
  passing secrets on command lines (`security -w <secret>` would show in `ps`).
- `memory`: tests, and `FLEET_VAULT=memory` for throwaway runs.
- `inline` exists only so Msg logs written before the vault still replay; new Msgs never contain it.
- Keys: `runner/<name>/token`, `guide/<session>/<field>`.

### RunnerConfig and Transport

```ts
type TransportSpec =
  | { kind: "direct"; url: string }
  | { kind: "aws_ssm"; region: string; instanceId: string; remotePort: number; credentials: AwsCredentials }
  | { kind: "ssh"; host: string; user: string | null; port: number | null; identityFile: string | null; remotePort: number };
type AwsCredentials = { kind: "profile"; profile: string } | { kind: "default" } | { kind: "keys"; accessKeyId: SecretRef; secretAccessKey: SecretRef };

type RunnerOrigin = { guide: string; summary: string; teardown: { label: string; data: Record<string, string> } | null };

interface Transport {
  /** Resolves once the runner is reachable at `url`; `closed` resolves when the link drops. */
  open(signal: AbortSignal): Promise<Outcome<{ url: string; closed: Promise<string | null> }>>;
}
```

- `direct`: returns its URL; `closed` resolves only on abort.
- `aws_ssm`: picks a free local port, spawns `aws ssm start-session --document-name
  AWS-StartPortForwardingSession` (needs the AWS CLI and `session-manager-plugin`; no SSH key, no
  inbound ports), waits for "Waiting for connections", and resolves `closed` when the process exits.
- `ssh`: picks a free local port, spawns `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort>` with
  `BatchMode` and `ExitOnForwardFailure` (null fields defer to `~/.ssh/config`), and is up once the
  local port accepts connections; `closed` resolves when ssh exits.

`UpdateRunner {name, transport?, token?}` replaces a runner's config: it bumps the link epoch so the
link reopens with the new transport, drops the runner to `unknown` until it answers again, and
deletes vault entries only the old config used.

The `Runner` in the Model gains `transport`, `token: SecretRef`, `origin`, and the live link state
`link: { state: "down" | "opening" } | { state: "up"; url }` with its own epoch/failures/retry, like
task streams. Health checks and agent calls happen only while the link is up.

### RunnerGuide (the extension point)

```ts
interface RunnerGuide {
  id: string; title: string; description: string;
  start(): GuideState;                                   // JSON
  step(state: GuideState, input: GuideInput | null, ports: GuidePorts): Promise<GuideResult>;
  teardown?(data: Record<string, string>, ports: GuidePorts): Promise<Outcome<string>>;
}
type GuideResult =
  | { kind: "ask"; state: GuideState; view: StepView }      // wait for the user
  | { kind: "working"; state: GuideState; view: StepView }  // show progress, step again with no input
  | { kind: "done"; runner: NewRunner }                     // becomes a runner
  | { kind: "failed"; state: GuideState; view: StepView; error: string }; // Retry re-runs from state
type StepView = {
  title: string; body?: string; progress?: string;
  fields: { id: string; label: string; hint?: string; kind: "text" | "secret" | "choice"; value?: string;
            options?: { value: string; label: string; detail?: string }[] }[];
  submit?: string;                                          // button label; none while working
};
type GuidePorts = { vault: SecretStore; aws: AwsPort; transports: (spec: TransportSpec) => Transport; fetch: typeof fetch; sessionId: string };
```

- `registry.ts` lists the guides. The catalog (`id, title, description`) reaches UIs through the
  Model (it rides in `Booted`), so a new guide needs no UI change.
- The Fleet page renders any `StepView` with one generic component.
- Steps must be safe to repeat (the Controller can die mid-step): e.g. a retried install reuses the
  runner token it already stored, and the install script upgrades in place.

### AWS port

```ts
interface AwsPort {
  profiles(): Promise<{ name: string; region: string | null }[]>;     // ~/.aws/config + credentials
  host(creds: AwsCredentials, region: string): Promise<Outcome<Ec2Host>>;
}
interface Ec2Host {
  whoAmI(): Promise<Outcome<{ account: string; arn: string }>>;      // STS
  canUseEc2(): Promise<Outcome<void>>;                                // DescribeInstances DryRun
  instances(): Promise<Outcome<Instance[]>>;                          // running, + SSM ping status, arch
  sendScript(instanceId: string, script: string): Promise<Outcome<string>>;   // SSM RunCommand id
  scriptResult(instanceId: string, commandId: string): Promise<Outcome<{ done: boolean; ok: boolean; output: string }>>;
}
```

## TEA wiring

| | |
|---|---|
| Intents | `StartGuide {guide}` (id minted) · `GuideInput {sessionId, input}` · `GuideRetry {sessionId}` · `CancelGuide {sessionId}` · `RemoveRunner {name, teardown}` · `AddRunner {name, token, url \| transport}` and `UpdateRunner {name, transport?, token?}` for scripts (token goes to the vault) |
| Effects | `RunGuideStep {sessionId, guide, state, input}` · `Teardown {runner, guide, data}` · existing ones carry the runner's link URL and token ref |
| World | `GuideStepped {sessionId, result}` · `GuideStepFailed` · `LinkUp {runner, epoch, url}` · `LinkDown {runner, epoch, error}` · `TeardownDone {runner, text}` |
| Sub | `Link {key: runner#epoch, runner, transport}` next to `TaskStream` |
| Model | `guideSessions`, `guideCatalog`, runner `link` |

- `working` results immediately ask for the next step; `done` adds the runner and closes the session.
- On `Booted`, a session that was mid-step shows "The Controller restarted during this step" with
  Retry.
- **Removing a runner asks** what to do when the runner has a teardown: "Remove from fleet" or
  "Remove and <teardown label>" (for AWS: stop and uninstall the runner; the instance keeps
  running). Open tasks of a removed runner become
  `lost` (Q-CORE-2).

## Guides in this change

### manual

Listed in Add runner as "Coming soon" (`comingSoon` in the catalog); it can't be started yet. Scripts add a runner by URL with the `AddRunner` intent.

### aws (EC2)

| Step | Asks / does |
|---|---|
| credentials | Lists profiles from `~/.aws/config` and `~/.aws/credentials`, plus "default chain" and "enter access keys". No region: account-wide calls use the profile's region, else `us-east-1`. |
| keys | Only for "enter access keys": access key id + secret, both stored in the vault. |
| verify | `whoAmI` and `canUseEc2`. Shows the account and ARN, or the exact error. |
| target | Running instances across every enabled region (`DescribeRegions`, searched in parallel; a region that can't be searched is skipped and named), usable ones first, each with its region and SSM status; the picked instance's region becomes the transport's; only SSM-online ones are selectable. If none is, it says what an instance needs (a role with `AmazonSSMManagedInstanceCore`, outbound internet). Plus runner name and agents to serve. Launching new instances is out of scope for now. |
| detect | Runs a check script over SSM RunCommand. If `/etc/fleet-runner.env` exists and the runner answers `GET /agents`, the guide stores its `RUNNER_TOKEN` in the vault, uses its `RUNNER_BIND` port and skips to check. The token passes through SSM command output. |
| install | Only when detect found no running runner. Generates the runner token (vault) and runs the bootstrap script over SSM RunCommand: downloads the runner binary and the agents tarball from the GitHub release, installs uv, creates the `fleet-runner` user, env file and systemd unit, pre-warms agents, starts the service. |
| check | Opens the `aws_ssm` transport and reads `GET /agents`. |
| bedrock | Over SSM RunCommand, calls each model in `AGENT_MODELS` once (1 token) with the instance role, the way agents will. Fails, with what to allow on the role, when no model answers. |
| done | Saves the runner: `aws_ssm` transport, token ref, origin with teardown data. An adopted runner gets no teardown: the Controller never uninstalls what it didn't install. |

The set-up steps (detect through bedrock, plus the local-build copy) show as a checklist
(`StepView.checklist`): done steps are checked, the current one spins with its progress under it,
a failed one is marked, and an adopted runner's install is shown as skipped.

Release assets (`fleet-runner-<arch>-linux-musl`, `fleet-agents.tar.gz`) come from
`FLEET_RUNNER_RELEASE` (a GitHub release download base, e.g.
`https://github.com/<owner>/<repo>/releases/download/<tag>`). `.github/workflows/fleet-runner-release.yml`
builds and publishes them on a `fleet-runner-v*` tag.

**Temporary, until a release is tested:** `FLEET_RUNNER_RELEASE=local` installs this checkout instead.
Before installing, the guide runs `deploy/dev-push.sh`: `deploy/dev-build.sh` cross-compiles the
static musl runner with `cargo zigbuild` (needs `brew install zig`, `cargo install cargo-zigbuild`,
`rustup target add aarch64-unknown-linux-musl`) and packs the agents. Then it scp's both over SSM to
`/tmp/fleet-local`, using a 60-second EC2 Instance Connect key, and the install script reads them
through `file://`. Remove `local-build.ts`, the `push` step and both scripts once releases are in use.

## Testing

| What | How |
|---|---|
| Guide flows | `step()` with fake ports: every branch (profiles found / none, keys, verify fails, no online instances, install fails or retried, check). |
| Links | `update` tables: link sub per runner, health only while up, `LinkDown` backoff, wake bumps the epoch, remove closes it. |
| Guide sessions | `update` tables: start → ask → input → working → done → runner added; restart mid-step; cancel. |
| API | secret fields never reach the logged Msg; `AddRunner` stores its token in the vault. |
| Transports | `aws_ssm` against a fake `aws` command (ready line, exit = drop); direct. Real tunnel to an existing instance by hand. |
| Bootstrap script | snapshot of `install.ts` output. |
| Vault | memory in unit tests; the OS keychain in a test that runs only where the keychain is available. |

## Open questions

- Q-GUIDE-1 The runner token travels in the SSM RunCommand parameters, which AWS keeps in command
  history for 30 days. Move it to SSM Parameter Store (SecureString) or generate it on the box?
- Q-GUIDE-2 No GitHub release exists yet: this checkout's `origin` is upstream pizza-bot with push
  disabled. Which repo publishes `fleet-runner-v*` releases?
- Q-GUIDE-3 External guides (a folder of guide modules, like agents) once the interface settles?
- Q-GUIDE-4 The aws_ssm transport needs the AWS CLI and session-manager-plugin on the Controller's
  machine. Check for them in the guide's first step, or implement the SSM data channel in Node?
- Q-GUIDE-5 Launching a new instance (IAM role and instance profile, a no-inbound security group,
  AMI lookup) was left out on purpose. Add it as a step of this guide, or as a separate guide?
