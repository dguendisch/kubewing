# kubewing 🪽

A native desktop UI that merges `kubectl`'s feature set with
- shell features: filtering/slicing/sorting/grouping/watching/diffing (analogous to grep, watch, jq, yq, diff)
- terminal/shell-multiplexer features: tabs, splits
- power-user, keyboard driven

## Core abstraction: the pipeline

Every view is a serializable **pipeline**: `source → stages → render`.

```yaml
source:
  cluster: garden-dev/shoot--foo--bar   # context or Gardener path
  resource: pods                        # GVR, alias-resolved
  namespace: kube-system                # or "*"
  labelSelector: app=etcd
  fieldSelector: status.phase!=Running
stages:
  - filter: 'o.status.containerStatuses.exists(c, c.restartCount > 3)'  # CEL
  - grep: 'oom'                                                          # text match on rendered row
  - sort: [-restarts, name]
  - groupBy: spec.nodeName
  - aggregate: {count: true}
render:
  columns:
    - {name: NAME,     path: metadata.name}
    - {name: NODE,     path: spec.nodeName}
    - {name: RESTARTS, expr: 'o.status.containerStatuses.map(c, c.restartCount).sum()'}
    - {name: MEM,      path: ..., type: bytes}     # human-readable
    - {name: CPU,      path: ..., type: cpu-gauge} # gradient badge
  diff: {mode: highlight, ignore: [default-noise]}
```

Many other features fall out of it:
- **Saved views / aliases** = stored pipelines (+ parameters).
- **Shell export/import** = pipeline ⇄ `kubectl … | jq … | sort` string (best effort, lossy where CEL has no shell equivalent).
- **Structured pipeline editor** with completion.
- **AI help** = emits pipelines (safe, inspectable) rather than arbitrary commands.
- **Splits** = N pipelines sharing sources.

Expression languages: CEL (cel-go) for filters/columns, gojq as optional escape hatch.

## Feature seed

### Status

Done: P0 and P0.1 except for the items below (see the [README](README.md) for what works).

Next up:
- diff editor (show that j/k is for next/prev change)
- cmd+shift+return: maximize a pane (similar to iTerm), with some button/indicator on the top right that it's maximized and thus potentially overshadows other split panes, clicking on it (or cmd+shift+return again) un-maximizes it
- overlay grab handles for panes to move them, attach them (similar to ghostty)
- Events for a resource (shortcut "v")
- grep highlight search results
- better column sizing + resizing
- History buffer (snapshots + deltas, budget, pinning); the diff keeps only the previous version so far.

Still open in P0.1:
- Completion for a context picked in `⌘O` before any pane is open on it (shows a hint instead).

### P0 — "The Core" (v0.1)

1. **Pipeline model** (see above) — source, filter/grep/sort stages, column render, serialization. `groupBy`/`aggregate` stages and the `cpu-gauge` column come with P1 (Filtering & aggregating).
1. **Watch-backed source layer** (client-go informers)
   - Shared informer registry keyed by (cluster, GVR, namespace, selector), ref-counted; stops when last view closes. Splits on the same cluster share it.
   - Strip `managedFields` via transform funcs; metadata-only informers where sufficient. Secrets are treated like any other resource.
   - Per-object bounded history of *normalized* objects (foundation for time-travel and field-path diffs in P1) — see History buffer decision.
1. **Keyed diff** — object identity from informer events, not screen position (avoids viddy's row-shift, AGE-tick, and same-name-recreate artifacts).
   - **Identity:** rows keyed by UID → correct added/removed/changed regardless of sort; delete+recreate under the same name shows as remove+add.
   - **Table diff:** per-(UID, column) rendered-cell comparison; time-derived columns (AGE etc.) excluded.
   - **Hidden changes:** hash of the normalized object → "changed, not visible" row marker for changes outside the displayed columns.
   - **Detail diff:** text diff of normalized YAML (old vs. new) for a selected object.
   - **Normalization / noise filter:** strip `resourceVersion`, `managedFields`, heartbeat fields (`lastHeartbeatTime`, lease `renewTime`); drop resync/relist no-ops. Path-based, user-extensible ignore rules.
1. **Virtualized live table** — arbitrary resources, configurable typed columns, live updates.
   - Default columns from server-side Table output (`as=Table;g=meta.k8s.io;v=v1`) → kubectl columns + CRD `additionalPrinterColumns` for free; full objects in the same stream via `includeObject=Object`, so cells and objects always share a resourceVersion.
1. **Basic object actions** — `describe` (+ events), view YAML, `exec` into a pod, `port-forward`, delete (confirmed).
1. **Safety model** — per-context color/label (prod = red), read-only mode per context, confirmation for any mutating action. Required before any multi-cluster writes later.
1. **Splits & tabs** — `cmd+d` split horizontal, `cmd+shift+d` split vertical.
1. **Filter bar** — quick grep + label selector + one CEL filter on the focused view (full stage editing comes with the palette).
   - Fields: `/` grep, `l` label selector, `c` CEL (`o` = the object). The CEL field widens to the header while focused; unfocused it's a truncated chip, so a hidden-rows filter is never invisible. Status line: `12 / 340 shown`.
   - **Grep terms** (fzf-like): space-separated, all must match; `!x` excludes; `"a b"` is one term; `\!` escapes. Still one `grep:` string in the pipeline, so export maps it to `grep -i a | grep -vi x`.
   - **Grep applies live** (debounced): every extra character of a positive term only narrows the result. A negated term does the opposite (`!c` hides nearly everything, `!co` … brings rows back), so the one being typed is held back until it's finished: a following space, `⏎`, or leaving the field.
   - **Labels and CEL are drafts until `⏎`.** A half-typed value (`app=et`, `o.status.phase == "Run"`) is valid but matches nothing, so applying live would blank the table on every keystroke. While typing, Go dry-runs the draft against the pane's objects and the field shows the outcome: `→ 298 / 340`, a type problem (`string, not bool`), or a parse error with a caret. `⏎` or leaving the field applies (an invalid draft is refused and stays, marked red), an empty field + `⏎` clears. Switching apps doesn't count as leaving the field. Label previews are exact when the draft is at least as strict as the applied selector, else a lower bound (`≥ 298`): the wider set isn't loaded yet.
   - **In-place stage updates.** A filter/grep change re-evaluates the match flag of the existing view instead of rebuilding it: the watch, normalized objects and diff state (prev, markers) survive. Only a source change (labels) re-subscribes.
   - **Errors are visible.** Missing fields stay "no match" (heterogeneous lists); other evaluation errors count as no match and are reported in the status line (`3 errors`). CEL cost limit per evaluation.
   - **Completion** for the CEL field: field paths taken from the source's live objects (`o.status.` → keys seen at that path, with how many objects have them; works for every CRD without OpenAPI) plus CEL macros/functions, through the ⌘O ranker. Keys that aren't identifiers complete as `["app.kubernetes.io/name"]` (the objects are schemaless, so not Kubernetes' `__dot__` escaping). After an operand, the operators that fit the field's type (as the key listing reports it).
   - **From the detail view:** cursor on a YAML line, `=` sets the CEL filter to `<path> == <value>`, `!` to `!=`, and applies it at once (the expression is complete).
   - `↑` in an empty CEL field recalls recent expressions for the resource type.
1. Keybindings and theme: sensible defaults + config files in `~/.kubewing/`; no settings UI yet.

### P0.1 — "Completion"
1. **Cluster catalog** — per-context discovery snapshot (resource types incl. short names, group, scope; namespaces), fetched async on connect and refreshed on resolve-miss / CRD change. Only for connected contexts (never trigger exec-plugin logins in the background). Partial discovery failures degrade gracefully.
1. **⌘O completion** — fuzzy completion for resource and namespace in the open dialog, built as a reusable completion provider (pure ranker + candidates) for the P1 command palette. cmdk not used here: it forces Enter onto the highlighted item, which breaks free-text submit; revisit for the palette itself.

### P1 — "Shell parity" (v0.5)

1. **Filtering & aggregating** — `groupBy`/`aggregate` pipeline stages and full stage support in UI: group-by, count, histogram; `cpu-gauge` column type (gradient badge).
1. **Command palette** — tab-complete operations, targets, aliases, pipeline stages.
   - Targets: object-name completion (`describe po etcd-ma⇥` without a pane on pods) via metadata-only lists — first real consumer of a generic background-fetch layer.
1. **Saved views / aliases / favorites** — transfer shell muscle memory (`kg` → `kubectl get`, `k get nodes -owide`, `tgd` → `gardenctl target garden landscape-dev`). Favorites = bookmarked clusters with a name.
1. **Shell interop** — export the current pipeline as a `kubectl` + shell one-liner, and import one.
1. **Edit resources** — apply/recreate, client-/server-side, dry-run, with diff preview.
   - Done: update as `kubectl edit` (`e`; exec moved to `x`): merge patch with a resourceVersion precondition, server dry run shown as a diff before writing, `edit` safety action.
   - Open: server-side apply (field manager `kubewing`, conflicts listed with their owners, force), recreate for immutable fields (delete + create, confirmed as delete), and applying from files (P3 "Scratch apply").
1. **Field-path diff engine** — computed from the P0 history buffer.
   - Changes as field paths, e.g. `status.conditions[Ready].status: True→False`.
   - Lists matched by key (containers by `name`, conditions by `type`) via OpenAPI `x-kubernetes-list-map-keys`, not by index.
   - Replaces the hidden-change marker with "what changed" and the text detail diff with a semantic one.
   - Exposes a change stream for filters: "only rows whose `spec` changed", "image changed in last 10m".
1. **Time-travel** — scrub over the per-object history buffer from P0 (scope: since watch start), per-field ("when did this flip?") on top of the field-path engine.
1. **Multi-pod log tail** — stern-like, live filter.
1. **Decoders** — brotli decompression, secret base64 decode, JWT, etcd/auger-style values.

### P2— "Polishing"
1. **github actions build pipelines**
1. **Pane drag & drop** — drag a pane by its header onto another pane's edge or centre (or the tab's outer edges) to rearrange the split; keyboard equivalent to swap/move the focused pane (e.g. `⌘⇧⌥arrows`). The receiving end already exists: dockview's drop targets and overlays are on (`disableDnd` unset), and `Dock` + `setLayout` take user rearrangements back into the store. Missing is the drag source: dockview only starts drags from a group's tab header, which we hide because each pane draws its own header. Options: make our pane header the drag handle (custom tab component rendered as the header, or a drag source wired to dockview's panel transfer), or show dockview's header only while ⌥ is held. Use `dndStrategy: 'pointer'` if HTML5 DnD is unreliable in WKWebView. Dropping onto the tab strip (move a pane to another tab) is a follow-up.

### P3 — "Operator power" (v1.0)

1. Resource dependencies: done as the jump menu (`⌘J`: namespace, owners, owned; `⌘←`/`⌘→` back and forward; see the README). Open: non-owner references (pod → node, the configmaps/secrets/PVCs/service account it uses, svc → pods, pvc → pv, ingress → svc) as a "references" section from a per-kind table, with the same jump mechanics; a dependency tree view.
1. RBAC views
1. From a node's describe output, understand that contained pods are listed there and allow navigation to those pods and directly allow all pod operations (via the context menu)
1. **From a `shoot` resource to a new pane/tab pointing to that `shoot`**
1. **Session recording + saving** - allow to save a session (not every watch diff, but everything else displayed, for later forensics when one doesn't recall what was actually did on a cluster)
1. **Persistent history** — on-disk history buffer (hours, survives restarts); requires secret encryption/exclusion first.
1. **Stuck-resource forensics** — finalizers, `deletionTimestamp`, owner-ref orphan sweep.
1. **Scratch apply** from files.
1. **Cluster navigator** — kubeconfig/context tree, clipboard-kubeconfig import.
   - Auth: exec credential plugins (gardenlogin, kubelogin/OIDC), token refresh.
   - Gardener: garden → project → seed/shoot tree; shoot kubeconfigs on demand via `shoots/adminkubeconfig` (default) / `viewerkubeconfig` subresources; read-only per context comes from the safety model.
1. **Multi-cluster operations** — replaces nested `for ns … for shoot …` loops. Builds on Gardener shoot-kubeconfig access + safety model (dry-run across targets first, then confirm).

### P4 - "Nice to have" (v2.0)
1. **AI chat** — e.g. via Anthropic endpoint + API key; produces pipelines / proposed actions, never executes mutations without the safety model's confirmation.
1. **Focus follows mouse**
1. **Recipes** — guarded multi-step workflows (VPA reset, shoot force-delete).
1. **Keybinding & theme UI** — editors on top of the P0 config files.
1. **WKWebView smoke suite** — a few tests against the real app for what Chromium/Playwright can't reach: native menu accelerators (⌘W closes a tab, not the window; ⌘R doesn't reload; ⌘P opens no print dialog), menu clicks reaching the dispatcher, IME input in the filter fields. Needs a native harness (XCUITest or an in-app test hook sending real key events); Playwright has no WKWebView driver.
1. Generated TS bindings check; golden-guard hook on `testdata/`.

## Decisions

1. **Lang: Go** client-go/informers, `k8s.io/kubectl` packages (apply, diff, printers, exec, port-forward), cel-go, gojq, Gardener API types. Rust/kube-rs would mean rebuilding much of kubectl.
1. **UI framework: Wails v3** (Go backend + system webview).
   - v3 over v2: multi-window (tear-off splits), improved bindings/events. Accepting pre-stable API churn.
   - Platforms: macOS first; Linux via WebKitGTK accepted as good enough for now; Windows (WebView2) might come somewhen.
   - Why: off-the-shelf components cover most P0/P1 features (see frontend stack below); CSS variables for theming and per-context colors; Vite hot-reload; small binary via system webview.
   - Rejected: **Gio** — best raw throughput (no bridge), but terminal emulator, code editor, diff viewer and markdown would all be hand-built; pre-1.0 API. **Fyne** — retained-mode widgets hard to make dense/fast for large live tables.
   - **Bridge rule (P0 architecture constraint):** Go owns all pipeline state (informers, stages, diff, history). Frontend is a thin view: requests a visible row range, Go pushes batched cell deltas for that range (throttled, e.g. ≤ 10 Hz). Never ship full objects or full tables over the bridge; full YAML only on explicit detail view.
   - Keyboard-first discipline: dense layout, no gratuitous animation, own all shortcuts (suppress conflicting webview defaults).
   - Escape hatch: the rendering layer is the only frontend-coupled part; any frontend component can be swapped without touching the Go core.
1. **Frontend: React 19 + React Compiler** (TypeScript, Vite).
   - Criteria: fastest + best-looking; boilerplate irrelevant (AI-written code). With the bridge rule, framework render speed is not the bottleneck — grid rendering is.
   - Why React: only ecosystem with a top-tier canvas grid and the polished-UI component stack; highest AI-generation accuracy (Svelte 5 runes vs. Svelte 4 confusion, Solid written like React) — matters since the frontend won't be hand-reviewed by a framework expert.
   - Rejected: **Svelte 5** — fine-grained reactivity for free, but fewer first-class adapters (dockview, shadcn port lags) and weaker AI accuracy. **Solid** — best reactivity model on paper, smallest ecosystem.
   - Stack:

     | Layer | Choice |
     |---|---|
     | Main live table | Glide Data Grid (canvas) — cell deltas from bridge events applied via `updateCells`, bypassing React re-render. Last stable (6.0.3) declares React ≤18 peers and upstream looks stalled; used with a peer override behind the pure `layout()` adapter so it can be swapped |
     | Components / styling | shadcn/ui + Radix + Tailwind (themes via CSS variables) |
     | Command palette | cmdk |
     | Splits / tabs | dockview |
     | YAML view / edit / detail diff | Monaco (incl. diff editor) |
     | Terminal (exec, logs) | xterm.js |
     | Motion | Motion (formerly Framer Motion), subtle only |

   - Canvas constraint: no arbitrary HTML in table cells — typed columns (bytes, CPU gradient badge, diff highlight, "changed, not visible" marker) are implemented as Glide custom cell renderers.
   - Non-table React state (panels, palette, dialogs) via an external store (e.g. Zustand) subscribed per component; high-frequency data never goes through React state.
1. **User config: `~/.kubewing/`** — plain YAML, hand-editable, git-friendly (can be versioned/dotfile-synced).

   ```
   ~/.kubewing/
     config.yaml        # general prefs, per-context safety rules (colors, read-only), diff ignore rules
     keybindings.yaml
     themes/*.yaml
     views/*.yaml       # saved pipelines
     aliases.yaml
     favorites.yaml     # bookmarked clusters
   ```
1. **History buffer: in-memory, snapshot + deltas, global budget.**
   - **Storage:** first-seen normalized snapshot + per-update deltas (a few hundred bytes typical vs. ~10 KB full object → ~10–50× smaller); keyframe snapshot every N deltas to bound reconstruction cost. Delta format doubles as input for the P1 field-path engine.
   - **Limits:** global memory budget as hard cap (configurable, default ~256 MB) + per-object time window (default 1h), both in `config.yaml`.
   - **Eviction:** oldest-delta-first across all objects (one coherent "history reaches back ~X min" horizon, shown in the UI).
   - **Tombstones:** deleted objects keep their last state as a marker for a while, so time-travel can show them.
   - **Pinning:** objects/views under investigation are exempt from eviction (within budget).
   - **Lifecycle:** history scoped to the informer — dropped when the last view on that source closes (comes free with the ref-counted registry).
   - **Deferred (P2):** on-disk persistence (e.g. SQLite/Pebble in `~/.kubewing/cache/`) for hours of history / restart survival. Blocker: secrets would land on disk in plaintext — needs encryption or an exclusion rule first.1. 
1. **Testing: assert on state, not pixels.** UI regressions are caught by checking the app's state as data at every layer. Full-app screenshot diffs are not used.
   - **Go core: view-model goldens (most tests).** Scenario tapes (starting objects + scripted watch events: add/update/delete/relist/recreate under the same name) run through `pipeline → bridge output` against a fake cluster. The resulting cell deltas, row keys and diff markers are compared to golden files. Property tests (e.g. `rapid`) for the keyed diff: re-sorting produces no "changed" markers, AGE ticks never count as a diff, recreate shows as remove+add, a no-op relist produces no deltas. The bridge rule is tested too: nothing sent outside the requested row range, no full objects unless asked for, rate stays at or below 10 Hz under event storms. envtest only where needed (apply, dry-run).
   - **Bridge contract.** Generated TS bindings are committed; CI fails if they change unexpectedly. Recorded bridge transcripts from the Go tests are reused as replay fixtures for frontend tests.
   - **Frontend logic, without a browser.** Keymap resolution (key sequence + focus context → command) and command effects (command + store state → new store state) are plain unit tests. A static check catches binding collisions per context and confirms suppressed webview defaults stay suppressed. Glide cell renderers are split into a pure `layout(cell, theme) → {text, colorToken, gaugeFraction, marker}` (unit-tested) and a thin `draw()`. dockview layout operations keep the tree valid and focus always lands on an existing pane.
   - **E2E on meaning.** Playwright drives the same frontend in Chromium against a headless Go backend that loads a scenario tape. Tests read the state through the introspection hook and use ARIA snapshots (`toMatchAriaSnapshot`) for the DOM parts (shadcn/Radix, cmdk, dialogs). A small smoke suite runs on the real WKWebView for what Chromium can't reproduce: native menu accelerators, webview default shortcuts, IME.
   - **Invariant fuzzing.** Random key sequences and pipeline edits. After every step check: no uncaught errors, focus exists, layout tree is valid, bridge stays within budget, frame time stays within budget with 10k changing rows.
   - **Guardrails against AI-made regressions.** Goldens are the spec: updating them takes an explicit `-update` flag and the change is reviewed as its own diff. Agents must not rewrite expectations to make tests pass (enforce via a Claude Code hook on `testdata/`). Lint bans raw colors/pixel values outside theme tokens. The only pixel tests are per-cell-renderer images on a fixed canvas size.
   - **Introspection hook (P0 architecture constraint).** Test builds expose `window.__kw.inspect()`, which returns layout tree, focused pane, per-pane pipeline, visible rows/cells, selection and open overlays (palette, dialogs, menus). Compiled out of release builds.
   - **Swappable bridge transport (P0 architecture constraint).** The frontend talks to an abstract transport: Wails IPC in the app, WebSocket to a headless Go backend in tests. This is what makes Chromium/Playwright E2E possible at all.
   - **Single command dispatcher (P0 architecture constraint).** Every shortcut (JS keydown or native menu accelerator) resolves to the same command ID and goes through one dispatcher. Tests then cover the mapping once, regardless of where the key event entered.
   - Example — "`cmd+p` opens the command palette":

     | Layer | Assertion |
     |---|---|
     | Keymap unit | `resolve("Meta+P", {focus: "table"})` → `palette.open`, also from inside a split, YAML view and terminal pane (xterm.js and Monaco must not swallow it) |
     | Command unit | `palette.open` on a store state → `overlay = palette`, input focused, previous focus remembered for restore on `Esc` |
     | E2E (Chromium) | press `ControlOrMeta+P` → `inspect().overlays` contains the palette; ARIA snapshot shows a focused `combobox` with an option list; `Esc` → focus back on the same pane and row |
     | Smoke (WKWebView) | `cmd+p` triggers no native print dialog and isn't consumed by the menu bar (synthetic Playwright keys never reach native accelerators, so only this layer catches that) |
