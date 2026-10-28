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

Done: P0 and P0.1 except for the items below (see the [README](README.md) for what works). Also done: column resizing and the column configurator per resource type (`o`: `-o wide`, custom path/CEL columns; `columns.yaml`), on `render.columns` with server columns by name. Copying any cell of a row (`⌘⇧C`, right-click a cell → copy cell…), and text selection inside a cell (double/triple-click, drag; `⌘C`). A cell whose text doesn't fit shows it whole as a tooltip. The diff headers show `j/k: changes`; the pane status line says "● connected" once synced, the dot green-grey.

Done: history store per shared source (`internal/fieldpath` diff, `internal/history`), `[`/`]` step through versions in the detail diff with the changed field paths above it. Opt-in per source ("record history" in the status line, `⇧R`), since it costs: a recording watch handles ~200k events/s (normalize + hash + diff, ~5 µs/event) vs. ~1M/s without. Off, everything is as before (each view keeps the previous version).

Done: time-travel (P1, see below): `t` shows the pane as it was, with a timeline instead of the status line; `←`/`→` change to change, `⇧←`/`⇧→` a minute, `Home`/`End`, `Esc` live; `⇧H` in the YAML lists a field's values over time. The history's limit is a global memory budget now (`history.budget`, default 512Mi; a config reload applies it to running recordings too), so it reaches back equally far for every object; there's no time window (it would only cut history the budget still has room for). The timeline shows the source's history size against its budget. Cost: a step rebuilds the table from the history, ~50 ms for 10k objects with 10 versions each; quick presses merge into one step. Open: pinning, linked time cursors across splits.

Done: launching kubewing while one runs on the same config directory opens a new tab in it on the launching terminal's kubeconfig and current context, and brings it to the front (Wails' single-instance lock, keyed by the config directory; the `$KUBECONFIG` path is handed over encrypted with `instance.key`); `-new-process` starts a separate one. A cluster is `@n/<context>` for such a kubeconfig (`internal/source/kubeconfig.go`), a plain context name for kubewing's own; the references live as long as the process.

Done: `↓` opens the completion list in the label and CEL fields at the caret, also where typing alone doesn't (empty field, after an operator); the label selector completes keys, operators and a key's values (`FieldValues`, next to `FieldKeys`). `Esc` with a list open only closes the list.

Done: the YAML editor (`e`, and the node shell's) is modal: only its own keys reach the app (`Esc`, `⌘S`, `⌘⏎`; in the preview `j`/`k`, `⏎`, `w`), global ones and native menu commands wait until it's closed. Before, `⌘D` split the pane behind the open editor, the focus went to the new pane, and `⌘S`/`⏎` resolved as table keys (the "failed" apply). Monaco's line operations are in: `⌘D` deletes the line, `⌥↑`/`⌥↓` move it, `⌥⇧↑`/`⌥⇧↓` copy it, `⌘[`/`⌘]` indent.

Done: naming tabs (`⌘⇧I`, double-click the tab) and panes (`⌘I`, double-click the header's empty part; a label in the pane's header, and the tab's title while the tab has none). Applied as typed, `Esc` restores, empty clears; not persisted (no layout persistence yet).

Done: multi-pod log tail (stern-like), `⌘L` on a row (its pods: a pod by name, a workload/node/namespace's pods, followed as they come and go) or `⌥⌘L` for every pod a pods pane shows (its filters applied, a snapshot). One follower per pod container, shared on the pane's watch for the whole-pane case; the last `logs.tail` lines then follow, `logs.maxStreams` concurrent followers, restart-resume via the RFC 3339 timestamp (`internal/logs` is the pure tailer; `internal/bridge/logs.go` wires it to a watch and the `kw:logs` batch events; `source.Actor.Logs` and a tape fake behind it). The frontend renders into a read-only xterm from a bounded ring (`frontend/src/logs/`), the live filter (`/`, fzf-like) hides and highlights lines (past ones too), `t` timestamps, `⌘K` clear, `⌘F` find; a dialog before the tail picks containers, history (lines, since or all), follow and timestamps, and the footer shows following / not following. Open: a whole-pane tail for non-pod panes (the union of their pods), previous-container logs (`--previous`), saving a tail to a file, and wiring an optional timestamp column.

Done: launched from a terminal, kubewing detaches by default (re-runs itself in a session of its own, stdin `/dev/null`, output appended to `kubewing.log` in the state directory, rotated to `.1` at 10 MiB), so the prompt comes back and closing the terminal doesn't end it. `-wait` or `launch.wait: true` keeps it in the foreground (`make run` passes `-wait`); piped/redirected output and `-headless` never detach. A launch that hands over to a running kubewing (Wails' lock in `NSTemporaryDirectory()` held, checked before `application.New` exits silently) says so on stderr, `-wait` too.

Done: an event's LAST SEEN and FIRST SEEN (`-o wide`) are timestamps from the object, as kubectl picks them (`series.lastObservedTime`, `lastTimestamp`, else first seen; `firstTimestamp`, else `eventTime`; the `deprecated*` names of `events.k8s.io` too), shown as ages: they tick like AGE, sort by the exact time (the server's "2m" for several tied before) and aren't changes (only the count is, a hidden one). By kind (`stampColumns` in `internal/view/stamps.go`), so another kind's Last Seen printer column stays the server's text. An events pane without a sort of its own starts by LAST SEEN, the latest first (`defaultSorts` in `internal/bridge`): it's the pane's own sort then (`OpenResult.Sort` into its spec), so the header shows it and a click cycles from it.

Done: decoders (`internal/decode`, pure; `view.Decode`). `⏎` on a line of the YAML (or of the object diff's right side; also "decode value" in the editor's right-click menu) decodes the field's value: a chain of steps detected one after the other, each feeding the next — base64 (std/url, padded or not; kept only when it decodes to text, gzip or brotli text, so "admin123" stays a word; a Secret's `data` and a ConfigMap's `binaryData` always decode), gzip (`1f 8b`), brotli (no magic bytes: bytes that aren't text, kept only if they decompress to text; a `.br` key takes any result) — then rendered: JWT (header and payload, `exp`/`iat`/`nbf`/`auth_time` annotated as times, "EXPIRED", "signature not verified"), PEM/x509 (certificates: subject, issuer, SANs, validity, usages, public key and its SHA-256, serial, fingerprint; CSRs; private and public keys: type, size/curve, encoding, public-key SHA-256 and which certificate among the object's other values it matches, or MISMATCH; a bundle block by block), JSON in a string as YAML, YAML kept (colored, foldable), else text; anything not text as a hex dump of its first KiB. Decompression is capped at 16 MiB. The value comes from the object at the line's field path (`fieldpath.AtLine`), not the YAML text. Out: etcd/auger (protobuf as stored in etcd; kubewing only sees the API server's objects).

The decode opens over the detail view (`Esc` back to it, the cursor where it was): the header shows the field path through the levels (`data["data.yaml.br"] → doc 2: data.kubeconfig`), the chain (`base64 → brotli → yaml · 14.2 KiB`; a click on a step leaves it and what follows out, on the rendering shows the bytes as they are, the PEM text; `↺ auto` detects again); `⌘A` `⌘C` copies it. `⏎` in decoded YAML goes a level deeper (multi-document YAML too: secret → manifests → kubeconfig → `certificate-authority-data` → certificate), `Esc` a level up. Nothing to decode on a line (a map, a number, plain text) says why in the status line of the view it was asked in (the YAML, or the decoded level), not the pane's (covered by them), and stays; so do `=`/`!` without a value and `⇧H` errors in the YAML. In the object diff, `⏎` is the decoded diff: the field decoded in both versions with the same chain (a managed resource's change as YAML, not one blob for another), `j`/`k` its changes, `[`/`]` other versions; a version without the field shows it added or removed. Each request sends the levels (paths resolved by Go on the first, chains), and Go decodes from the object again: nothing decoded is kept. The detail view's keys that don't apply there (`=`, `!`, `⇧H`, `d`, `y`, `⇧D`, `e`, `⌘J`, `v`) wait until the decode is closed. Open: a hint at the end of decodable lines (`⟶ base64·brotli · yaml 14 KiB`, `⟶ jwt, expires in 3h`); a decoded view of a whole secret (all keys at once, like `kubectl view-secret`).

Done: the row menu's view entries are consistent: view YAML, edit YAML and describe are one entry each (the in-place variant), without "…" (nothing to configure), each with its split key as a hint (`· ⇧E split`; `RowAction.split` in `actions/registry.ts`), and `⇧⏎` on the entry runs the split variant (diff too, as before). `⇧D` in the table describes in a split to the right (`object.describeSplit`; in the detail view `⇧D` stays describe, `d` being the diff toggle there). The row menu's and the jump menu's highlight wraps around (`↑` on the first entry goes to the last, `↓` on the last to the first; `S.wrapIndex`). `Esc` in the editor of a `⇧E` split closes the split, as `e`'s editor goes back to the table (it went back to the object's YAML before).

Done: label selector completion isn't limited by the applied selector (switching `app=web` to `app=api` or `widget=…` offered only what the selector had loaded): keys and values are counted among the source's objects that match the draft's other requirements (`labelContext`'s `others`, those after the caret too), by `Service.Labels` (`internal/bridge/labels.go`): from the pane's objects when the rest is at least as strict as the applied selector (`view.Narrower`) or the pane shows the past, else from a metadata-only list of the source (namespace and field selector kept); an unparsable rest or a failed list falls back to the pane's objects. It replaces `FieldValues`. CEL completion was never limited: its filter only marks rows, the pane holds every object (so CEL keys are limited by the applied label selector only).

Done: in time travel, age cells (AGE, an event's LAST SEEN, …) count from the moment shown (`status.at`), not now, and don't tick while there (`nowOf` in `grid/rowcache.ts`; the table, its text selection and ⌘⇧C's cell choices).

Next up:
- add user facing documentation/manual & cleanup of plan.md and readme.md(everything done goes into a user documentation/manual, only high-level/interesting/novel features remain in readme, plan.md must only remain with not-yet-done things); the manual should have a structure to present the features/functionality
- dedicated annotate/label/scale commands
- grep filter with regex support
- special jumps from viewer/editor to e.g. volumes/secrets/configmaps
- nit: "record history" should be "record changes"
- nit: decoder must not reformat result (e.g. json is json and not yaml)
- force refresh (e.g. after network down), also instead of connected it should then say disconnected
- multi-select (with shift+up/down or shift+click or cmd+click), some commands need to adapt (e.g. delete), while others should remain on one item as they don't really make sense for multiple rows
- nit: remember window position across restarts
- hide-healthy filter with special support for e.g. managedresources?
- nit: what to do with last pane/tab closing? currently it reloads the pane with which it started, but that's weird

Still open in P0.1:
- Completion and regular UI for a context picked in `⌘O` (instead of system UI's drop down)

### P0 — "The Core" (v0.1)

1. **Pipeline model** (see above) — source, filter/grep/sort stages, column render, serialization. `groupBy`/`aggregate` stages and the `cpu-gauge` column come with P1 (Filtering & aggregating).
1. **Watch-backed source layer** (client-go informers)
   - Shared informer registry keyed by (cluster, GVR, namespace, selector), ref-counted; stops when last view closes. Splits on the same cluster share it.
   - Strip `managedFields` via transform funcs; metadata-only informers where sufficient. Secrets are treated like any other resource.
   - Per-object bounded history of *normalized* objects, kept per shared watch (foundation for time-travel and field-path diffs in P1) — see History buffer decision.
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
   - **Grep highlights** its positive terms in the shown cells (the `match` theme token), found like the Go side matches: in the lower-cased cells joined by a space, so a phrase across two cells highlights in both. Age columns aren't highlighted: grep matches their timestamp, the cell shows `5m`.
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
1. **Field-path diff engine** — computed from the P0 history buffer; the diff function itself (`internal/fieldpath`) comes with the history store.
   - Changes as field paths, e.g. `status.conditions[Ready].status: True→False`.
   - Lists matched by key (containers by `name`, conditions by `type`) via OpenAPI `x-kubernetes-list-map-keys`, not by index.
   - Replaces the hidden-change marker with "what changed" and the text detail diff with a semantic one.
   - Exposes a change stream for filters: "only rows whose `spec` changed", "image changed in last 10m".
1. **Time-travel** — scrub the whole table over time (rows as they were at a moment, deleted ones included) from the P0 history buffer (scope: since recording started), per-field ("when did this flip?") on top of the field-path engine. Brings the history's global budget, oldest-first eviction and pinning (see History buffer decision): a moment in the table needs every object's history to reach back equally far, which a per-object version cap doesn't give. Done except pinning and linked cursors:
   - **Entering / leaving:** `t` in the table shows the pane in the past (starting recording if it was off: the timeline begins then), at the newest change; `t`, `Esc`, `End` or the header badge go back to live. Each pane has its own moment.
   - **Timeline** replaces the status line while in the past: the recorded span as a bar, a tick per change of the pane's rows (its filter applied), the cursor at the moment; a click goes there (snapped to a near change). `←`/`→` previous/next change, `⇧←`/`⇧→` one minute, `Home` the start. The header turns accent and shows "⏸ 12:03:14"; live changes keep arriving behind ("+37 since"), so going back is instant.
   - **The table then:** every row as it was (deleted-later objects back, later ones hidden); filters, sort and columns apply to the past objects; server cells are recorded with each version. Markers are the step's: forward, rows new in the step are added and gone ones deleted; backward, rows back (deleted later) are marked deleted.
   - **The detail view then:** the version current at the moment, diffed against the one before.
   - **When did this flip:** `⇧H` on a YAML line (or the diff's right side) lists the values of the field at the cursor over time (list items matched by key, as the diff); `⏎` takes the pane to that moment. Discoverable: a header hint while recording, and "history of this field" in the editor's right-click menu. The detail view shows the timeline too while the pane is in the past.
   - **Follow-ups:** pinning objects or views against eviction; linking the moment of splits (pods and nodes at the same time).

### P2— "Polishing"
1. **github actions build pipelines**
1. **Pane drag & drop** — drag a pane by its header onto another pane's edge or centre (or the tab's outer edges) to rearrange the split; keyboard equivalent to swap/move the focused pane (e.g. `⌘⇧⌥arrows`). The receiving end already exists: dockview's drop targets and overlays are on (`disableDnd` unset), and `Dock` + `setLayout` take user rearrangements back into the store. Missing is the drag source: dockview only starts drags from a group's tab header, which we hide because each pane draws its own header. Options: make our pane header the drag handle (custom tab component rendered as the header, or a drag source wired to dockview's panel transfer), or show dockview's header only while ⌥ is held. Use `dndStrategy: 'pointer'` if HTML5 DnD is unreliable in WKWebView. Dropping onto the tab strip (move a pane to another tab) is a follow-up.

### P3 — "Operator power" (v1.0)

1. Resource dependencies: done as the jump menu (`⌘J`: namespace, owners, owned; `⌘←`/`⌘→` back and forward; see the README). Non-owner references: a "references" section from a per-kind table (`relations.References`); done: pod and statefulset → their pvcs, those pvs and volume attachments; pvc → pv and its volume attachments, pv → pvc and volume attachments, volume attachment → pv and node; namespace → pods is an owned entry. Open: more references (pod → node, the configmaps/secrets/service account it uses, svc → pods, ingress → svc); a dependency tree view.
1. Open an xterm pane with the current kubeconfig injected
1. RBAC views
1. Encoders: similar to decoders, so when you edit resources, use return to show e.g. the base64 decoded text -> edit it -> apply it means base64 encode the modified text and put the new base64 encoded thing into the yaml editor, there you are able to apply that modification. Same should work for additional level with e.g. brotli.
1. From a node's describe output, understand that contained pods are listed there and allow navigation to those pods and directly allow all pod operations (via the context menu)
1. **From a `shoot` resource to a new pane/tab pointing to that `shoot`**
1. **Session recording + saving** - allow to save a session (not every watch diff, but everything else displayed, for later forensics when one doesn't recall what was actually did on a cluster)
1. **Persistent history** — on-disk history buffer (hours, survives restarts); requires secret encryption/exclusion first.
1. **Stuck-resource forensics** — finalizers, `deletionTimestamp`, owner-ref orphan sweep.
1. **Scratch apply** from files.
1. **Cluster navigator** — kubeconfig/context tree, clipboard-kubeconfig import.
   - Auth: exec credential plugins (gardenlogin, kubelogin/OIDC), token refresh.
   - Gardener: garden → project → seed/shoot tree; shoot kubeconfigs on demand via `shoots/adminkubeconfig` (default) / `viewerkubeconfig` subresources; read-only per context comes from the safety model.
1. cross-cluster compare/diff
1. **Multi-cluster operations** — replaces nested `for ns … for shoot …` loops. Builds on Gardener shoot-kubeconfig access + safety model (dry-run across targets first, then confirm).

### P4 - "Nice to have" (v2.0)
1. Native tooltips into a copy-able/colored pop over
1. **Focus follows mouse**
1. **Recipes** — guarded multi-step workflows (VPA reset, shoot force-delete).
1. **AI chat** — e.g. via Anthropic endpoint + API key; produces pipelines / proposed actions, never executes mutations without the safety model's confirmation.
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
1. **History buffer: in-memory, newest snapshot + reverse field-path deltas, per shared watch.**
   - **Storage:** the newest normalized object per UID, plus one delta per older version. A delta is a list of field-path changes that carries both the old and the new value, so it applies in reverse: version n−1 = undo(delta n, version n). Going back is a walk from the newest object; dropping the oldest version drops its delta, with no keyframes to rebase. The same changes are the input for the P1 field-path engine ("what changed").
   - **Opt-in:** off by default ("record history" per source, in the pane's status line): recording cuts a watch's throughput ~5× (~1M → ~200k events/s). Off, each view keeps only the previous version, as before. Switching on takes the current objects as first versions; switching off drops the history.
   - **Where:** in the shared watch (`source.Registry`), not in each view. Splits on one source share one history (and its on/off), and while recording the object is normalized once per event, not once per split. The noise rules are fixed per watch: a config reload applies to watches started afterwards, so one history never mixes two rule sets.
   - **Limit:** one global memory budget, so every object reaches back equally far: past it (default 512Mi, `history.budget`; it counts the objects' newest copies and the changes, as JSON sizes) the oldest changes go first across all objects (down to 90%, so it doesn't run per event). An object's oldest kept version stays as its baseline. The horizon (from when on the table can be shown) moves forward as old versions go. Each version is recorded at a number that counts up per object, so stepping through versions stays stable while updates come in.
   - **Tombstones:** a deleted object keeps its history until the view drops its tombstone; a recreate under the same name is another UID, so another history.
   - **Lifecycle:** history scoped to the shared watch — dropped when the last view on that source closes (comes free with the ref-counted registry).
   - **Later:** pinning objects/views under investigation against eviction (within budget).
   - **Deferred (P2):** on-disk persistence (e.g. SQLite/Pebble in `~/.kubewing/cache/`) for hours of history / restart survival. Blocker: secrets would land on disk in plaintext — needs encryption or an exclusion rule first.
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
