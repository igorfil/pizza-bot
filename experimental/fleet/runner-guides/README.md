# Runner-guide plugins

A runner guide is one way to add a runner on the Fleet page (**Agents → Add runner**). Two ship with
the Controller: **AWS EC2** and **By URL**. Other guides are plugins: folders copied into this
directory, outside version control. An organization can keep its own guides (for its internal hosts,
dev boxes or networks) in a private repository and copy them into an install of this open-source
app to make a customized one; nothing about them has to live here.

Only this README is tracked; every other folder here is ignored by git.

The Controller loads every folder here at startup (`FLEET_RUNNER_GUIDES_DIR` points elsewhere).
A folder that fails to load, or reuses a plugin or guide id, is skipped with a warning in the
Controller's log; the others still load. The guides appear in Add runner after the built-in ones,
with no UI change.

## Folder

```
runner-guides/<folder>/
├── guide.ts       the entry, or guide.mjs / guide.js; its default export is the plugin factory
└── …              whatever it imports
```

`.ts` files run through Node's type stripping, so they can use only erasable syntax (no `enum`,
no parameter properties), must import local files with their `.ts` extension, and must import the
contract below with `import type`.

## Contract

The types are in [`controller/src/guides/plugin.ts`](../controller/src/guides/plugin.ts).

```ts
import type { GuidePluginFactory } from "<this checkout>/experimental/fleet/controller/src/guides/plugin.ts";

const plugin: GuidePluginFactory = (host) => ({
  id: "my-hosts",
  guides: [myGuide(host)],
  transport: (spec) => myTransport(spec, host), // optional
});
export default plugin;
```

- **`host`**: the OS vault, every transport the Controller knows (`host.transports(spec)`, so a
  plugin's transport can wrap the built-in `ssh` one), the folder holding the Linux runner build
  `npm run build` made (`localBuildDir`) and the runner-name rule (`nameProblem`).
- **`guides`**: `RunnerGuide`s (`start`, `step`, optional `teardown`), the same interface the
  built-in guides implement. [`../docs/RUNNER-GUIDES.md`](../docs/RUNNER-GUIDES.md) describes
  steps, screens and the rules they follow: steps are safe to repeat, and state is logged, so it
  holds vault keys, never secrets.
- **`transport`**: opens the `{kind: "plugin", plugin: <id>, label, config}` transports this
  plugin's guides save. The Controller calls it every time it connects to such a runner, so it can
  wake the host or restart the runner first. `label` names the connection on the runner's page;
  `config` is logged and holds no secret. A runner whose plugin is gone stays listed and shows
  that its plugin is not installed.

The guide's `step` gets the generic `GuidePorts` (vault, transports, `fetch`, `sleep`, the runner
names in use); anything else it needs (a CLI, an SDK client) it builds itself, from `host` if
needed.
