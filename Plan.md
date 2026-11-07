# kubewing plan

What's not done yet. What works is in the [Manual](Manual.md), how it's built in [Architecture.md](Architecture.md), developer related topics are in [Development](Development.md). A finished item leaves this file and goes into the manual (if user facing) or readme (if huge/important enough) or development or architecture.

## Next up

- **Reverse references ("used by"):** the field reference rules (`refs.yaml`) read backwards: pods using this secret/configmap/claim, bindings granting this role, attachments of this volume. A `⌘J` section run on request (like the owned scan): a reverse step lists the referring kinds in full unless the field is metadata. `**` patterns expand to concrete paths per listed kind (pod, workload templates, cron job), which also build the target pane's CEL filter.
- **Chains:** transitive jumps as configured sequences of rule ids, `~` reversing a step, e.g. `via: [pod-volume-pvc, pvc-volumename, ~va-pv]`, `show: each | set`. Bounded depth (~3) and lookups; no syntax beyond `via` + `show`. Port today's hand-written storage paths to built-in chains (the bridge tests prove it). Selector- and naming-convention-based relations (deployment → pods, stateful set claims) stay in Go.
- nit: remember window position across restarts
- nit: shadow below dialogs (themeable on/off)
- hide-healthy filter with special support for e.g. managedresources and nodes. Maybe generalize it like jump to?
- nit: what to do with last pane/tab closing? currently it reloads the pane with which it started, but that's weird
- Completion and regular UI for a context picked in `⌘O` (instead of the system UI's drop down)
- kubectl blame like

## Follow-ups of done features

- **Time travel:** pinning objects or views against eviction (within budget); linking the moment of splits (pods and nodes at the same time).
- **Logs:** a whole-pane tail for non-pod panes (the union of their pods); previous-container logs (`--previous`); saving a tail to a file; an optional timestamp column.
- **Decode:** a hint at the end of decodable lines (`⟶ base64·brotli · yaml 14 KiB`, `⟶ jwt, expires in 3h`); a decoded view of a whole secret (all keys at once, like `kubectl view-secret`).
- **Marked rows:** logs of the marked rows (one tail over their pods); exec into several pods; input typed once to all debug panes of a batch (like iTerm's broadcast); edit of many objects (one YAML stream).
- **Edit:** server-side apply (field manager `kubewing`, conflicts listed with their owners, force); recreate for immutable fields (delete + create, confirmed as delete); applying from files (see Scratch apply).
- **Jump menu references:** svc → pods (by selector: not a field rule); a dependency tree view.
- **Jump menu clusters:** a garden recognized when not opened by `⌘P` nor matching a gardenctl garden's API server (e.g. `Shoot` rows of a virtual garden reached through a port-forward); a shoot's or seed's other clusters from inside the cluster (a shoot's `kube-system/shoot-info` config map, a seed's `garden` namespace); `⌘J` on a project row → the project in the garden.
- **Field jumps:** a `*KeyRef` landing at `data.<key>` in the target's YAML; references inside decoded YAML (a managed resource's manifests); `⌘←` after a jump from the YAML back to the YAML at the same line (today: to the object view, cursor at the top).
- **Field-path diff:** list items matched via OpenAPI `x-kubernetes-list-map-keys` (today: by `name`/`type`/… heuristics); "what changed" on the "changed, not visible" marker; a change stream for filters ("only rows whose `spec` changed", "image changed in last 10m").
- **Moving panes:** a keyboard equivalent to move/swap the focused pane (e.g. `⌘⇧⌥` arrows).
- **Names:** persisted with the layout, once there is layout persistence.
- **Clusters dialog (`⌘P`):** the recent list alone (a key of its own: `⌘⇧P` switches shoot ⇄ control plane now); a reconnect rebuilding a Gardener target's kubeconfig (rotated CA, changed addresses: today a new pick); listing a garden's projects and shoots on request (connects: explicit only); shoots older than Kubernetes 1.20 (gardenlogin's legacy flag form); clipboard kubeconfig import. `⌘⇧P` on panes restored across restarts (with layout persistence); the "plane" toggle for a seed line (a managed seed ⇄ its shoot).
- **Everything in a namespace (`all`):** all namespaces (`all` + `*`, the shell's `kapires-namespaced --all`: heavy on big clusters, so asked first); cluster-scoped types (`kapires-non-namespaced`); counts per kind once `groupBy` lands (P1); what blocks a terminating namespace (P3's stuck-resource forensics builds on it); auto refresh kept with the layout (today per pane, until it closes); the object diff of a row in full (today the versions are the listed metadata, so `d` shows label, annotation, owner and finalizer changes only).
- **Settings editor (`⌘,`):** completion and hover docs from the reference (a YAML schema for Monaco); the other files (`keybindings.yaml`, `refs.yaml`, themes) in the same dialog; a warning when the file changed on disk while the editor was open.
- **Updates:** a "what's new" on the first start after an update (the same dialog, the notes of the versions just installed); an HTTP proxy for the check and the download (Go doesn't read macOS's system proxy settings, and an app started from the Dock has no proxy variables: from the webview's `fetch`, which uses them, or `scutil --proxy`); the release signing key set up (see Development.md) before the first release that ships the updater.
- **Metrics:** per-container breakdown (`top --containers`) in the object view or the row menu; metrics in CEL filters (e.g. `m.cpu > 500`); sparklines of recent values (needs kept samples, which could then also feed time travel); metric columns rendered as `cpu-gauge` once that type exists (P1). Allocation: absolute request/limit columns on pods (`CPU REQ`, `MEM REQ`, …, to see who reserves the most on a node after `⌘J`); the unfinished-pods watch is cluster-wide, so a per-node watch for single-node panes on very large clusters. metrics.k8s.io serves only CPU and memory, so more needs other sources (optional):
  - *Kubelet Summary API, a separate opt-in group:* `nodes/<n>/proxy/stats/summary` (through the API server) for usage metrics.k8s.io doesn't have. Nodes: root/image filesystem used/capacity and inodes (`%DISK`: DiskPressure evictions), network rx/tx (rates from two polls) and errors, PIDs of the max (PIDPressure), memory available/RSS/swap. Pods: ephemeral-storage usage and volume stats, i.e. used/capacity per PVC (a fill level column on PVCs, like `kubectl df-pv`). Costs: needs `nodes/proxy` RBAC (powerful, often not granted: Forbidden shown in the status line like `ErrNoMetrics`), one request per node per poll (a concurrency cap and a slower interval on big clusters), polled since it can't be watched.

## P1 — "Shell parity" (v0.5)

1. **Filtering & aggregating** — `groupBy`/`aggregate` pipeline stages and full stage support in the UI: group-by, count, histogram; `cpu-gauge` column type (gradient badge).
1. **Command palette** — tab-complete operations, targets, aliases, pipeline stages.
   - Targets: object-name completion (`describe po etcd-ma⇥` without a pane on pods) via metadata-only lists — first real consumer of a generic background-fetch layer.
   - Reuse the `⌘O` completion provider (pure ranker + candidates); revisit cmdk for the palette itself.
1. **Saved views / aliases / favorites** — transfer shell muscle memory (`kg` → `kubectl get`, `k get nodes -owide`, `tgd` → `gardenctl target garden landscape-dev`). Favorites = bookmarked clusters with a name. Files: `views/*.yaml`, `aliases.yaml`, `favorites.yaml`.
1. **Shell interop** — export the current pipeline as a `kubectl` + shell one-liner, and import one.

## P2 — "Polishing"

1. **CI on pull requests / pushes** (`make test`, maybe `make e2e`) once the repo is public (free macOS runners); today only release tags build. Needs `make test` green first.
1. **Manual screenshots** — generated by a separate Playwright suite (`make docs-screenshots`, outside the sandbox) against the headless backend replaying demo tapes with realistic names and a prod-labelled context. Start small (overview, YAML view, cheat sheet), then add scenes in batches. Ages and the timeline depend on the Go side's clock, which Playwright can't freeze: backdate `creationTimestamp` in the tapes rather than mocking time.

## P3 — "Operator power" (v1.0)

1. RBAC views
1. **Encoders:** like decoders, for editing: `⏎` on a value in the editor shows e.g. the base64-decoded text → edit it → applying base64-encodes it back into the YAML, where it can be applied. Same for further levels (e.g. brotli).
1. From a node's describe output, recognize the pods listed there and allow navigating to them, with all pod operations (via the context menu)
1. **Session recording + saving** — save a session (not every watch diff, but everything else displayed) for later forensics, when one doesn't recall what was actually done on a cluster
1. **Persistent history** — on-disk history buffer (hours, survives restarts); requires secret encryption/exclusion first.
1. **Stuck-resource forensics** — finalizers, `deletionTimestamp`, owner-ref orphan sweep.
1. **Scratch apply** from files.
1. **Cluster navigator** — a browsable garden → project → seed/shoot tree on top of `⌘P` (which already resolves gardenctl targets, dashboard URLs and recent clusters); `shoots/adminkubeconfig` / `viewerkubeconfig` as an alternative to gardenlogin.
1. Cross-cluster compare/diff
1. **Multi-cluster operations** — replaces nested `for ns … for shoot …` loops. Builds on Gardener shoot-kubeconfig access + safety model (dry-run across targets first, then confirm).

## P4 — "Nice to have" (v2.0)

1. Native tooltips into a copy-able/colored pop-over
1. **Recipes** — guarded multi-step workflows (VPA reset, shoot force-delete).
1. **AI chat** — e.g. via an Anthropic endpoint + API key; produces pipelines / proposed actions, never executes mutations without the safety model's confirmation.
1. **Replace xterm** with ghostty(-web)?
2. 1. **Keybinding & theme UI** — editors on top of the config files.
1. **WKWebView smoke suite** — a few tests against the real app for what Chromium/Playwright can't reach: native menu accelerators (⌘W closes a tab, not the window; ⌘R doesn't reload; ⌘P opens no print dialog), menu clicks reaching the dispatcher, IME input in the filter fields. Needs a native harness (XCUITest or an in-app test hook sending real key events); Playwright has no WKWebView driver.
1. Generated TS bindings check in CI; golden-guard hook on `testdata/`; invariant fuzzing (random key sequences and pipeline edits, checking focus, layout tree, bridge and frame budgets after every step).
