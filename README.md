# kubewing 🪽

A vibe-coded, keyboard-driven, desktop UI for Kubernetes matching most features of `kubectl`, the shell's grep / watch / diff / viddy, and a terminal multiplexer's tabs and splits. Knows [Gardener](https://github.com/gardener/gardener) clusters and hierarchy.

## Highlights

- **Live tables for any resource (backed by watches)**, CRDs included, with `kubectl`'s columns from the server, custom path/CEL columns per resource type, CPU and memory of pods and nodes (`kubectl top`, `m`), column configuration is persisted per resource. Changes are highlighted.
- **Everything in a namespace** (`all`): every object of every type, CRDs included (what `kubectl get all` leaves out), listed once and refreshed with `⌘R`, which marks what changed since.
- **Diffs based on the resources.** Changes are keyed by UID: changed cells, added and deleted rows, a "changed, not visible" marker. AGE ticks and noise (resourceVersion, managedFields, heartbeats) doesn't count as changes. A recreated object is a removal plus an addition.
- **Time travel.** Record changes and scrub the whole table back in time (similar to `viddy` but based on resource field changes, not line/text changes), deleted objects included. Ask any YAML field "when did you change?" (`⇧H`), step through an object's versions with the changes listed as field paths (`spec.containers[name=app].image: "web:1" → "web:2"`).
- **Three filters.** fzf-style grep, label selectors with value completion, and CEL over the whole object, completed from the live objects' fields.
- **Decode anything.** `⏎` on a YAML value unwraps base64 → gzip/brotli → YAML/JSON, renders certificates, keys (matched to their certificate), JWTs, and goes deeper level by level: secret → kubeconfig → CA → certificate. Decoded diffs show what changed inside a managed resource's compressed blob.
- **Jump between related resources** (`⌘J`): owners up the chain, what a workload runs, a pod's claims → volumes → attachments, events; from a garden's shoot or seed straight into its cluster or control plane. From the YAML, `⌘`-click a `secretName`, `roleRef` or `seedName` to land on the object it names (rules extendable in `refs.yaml`). Back and forward like a browser.
- **Pod logs** with a live fzf-like filter
- **port-forwards** to pods and services with completion on available ports
- **exec**, **debug containers**, and **node shells** with proper configurability
- **Local terminals** (`⌃T`/`⌃⇧T`): your own shell on the cluster you're looking at, with a kubeconfig of its own (context and namespace of the pane), so `kubectl`, `helm` or any script just works, serves as an escape hatch in case something is not natively available in kubewing.
- **Marked rows** (`⇧↓`, `⇧`/`⌘`-click, `⌘A`): delete, label, annotate, scale or rollout-restart many objects at once under one confirmation, or open a debug container in every marked pod, a pane each.
- **Edit resources**: a server dry-run diff before writing, only the change sent, and a conflict instead of overwriting someone else's change.
- **Tabs, splits, a cheat sheet** (`?`), moveable panes, a native menu bar and rebindable keys. Launching kubewing from another terminal opens a tab on that terminal's kubeconfig.
- **Safety per context**: prod is labelled and red, read-only contexts refuse mutations, confirmations (typed names for strict ones), all enforced in the backend with single-use tokens bound to the exact object.

## Docs

- [Manual](Manual.md): how to use everything.
- [Architecture](Architecture.md): how it's built and why.
- [Development](Development.md): building, running, testing.
- [Plan](Plan.md): what's next.

## Quick start

macOS (Apple silicon): download the zip from the [releases](https://github.com/dguendisch/kubewing/releases), unpack it and move `kubewing.app` to `/Applications`. It isn't notarized, so allow the first launch once (see [Installing](Manual.md#installing)). After that it updates itself (see [Updates](Manual.md#updates)).

From source:

```sh
make deps
make run
```

kubewing opens on your kubeconfig's current context. Press `⌘O` to open another resource, `?` to display keyboard shortcuts.
