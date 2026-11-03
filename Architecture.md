# kubewing architecture

How kubewing is built and why. For what it does, see the [Manual](Manual.md); for building and testing, [Development.md](Development.md); for what's next, [Plan.md](Plan.md).

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
  - hideHealthy: true
  - sort: [-restarts, name]
  - groupBy: spec.nodeName              # planned
  - aggregate: {count: true}            # planned
render:
  columns:
    - {name: NAME,     path: metadata.name}
    - {name: NODE,     path: spec.nodeName}
    - {name: RESTARTS, expr: 'o.status.containerStatuses.map(c, c.restartCount).sum()'}
    - {name: MEM,      path: ..., type: bytes}     # human-readable
    - {name: CPU,      path: ..., type: cpu-gauge} # gradient badge, planned
  diff: {mode: highlight, ignore: [default-noise]}
```

Many features fall out of it:
- **Jumps** (`⌘J`, events) = a new source plus filters, so the filter bar shows why a pane holds what it holds.
- **Back/forward** = a stack of pipelines per pane.
- **Splits** = N pipelines sharing sources.
- Planned: **saved views / aliases** = stored pipelines (+ parameters); **shell export/import** = pipeline ⇄ `kubectl … | jq … | sort` (best effort, lossy where CEL has no shell equivalent); a **structured pipeline editor**; **AI help** that emits pipelines (safe, inspectable) rather than arbitrary commands.

Expression languages: CEL (cel-go) for filters and columns; gojq as an optional escape hatch.

## Decisions

### Language: Go

client-go/informers, `k8s.io/kubectl` packages (apply, diff, printers, exec, port-forward), cel-go, gojq, Gardener API types. Rust/kube-rs would mean rebuilding much of kubectl.

### UI framework: Wails v3 (Go backend + system webview)

- v3 over v2: multi-window (tear-off splits), improved bindings/events. Accepting pre-stable API churn.
- Platforms: macOS first; Linux via WebKitGTK accepted as good enough for now; Windows (WebView2) maybe later.
- Why: off-the-shelf components cover most features (see the frontend stack below); CSS variables for theming and per-context colors; Vite hot-reload; small binary via the system webview.
- Rejected: **Gio** — best raw throughput (no bridge), but terminal emulator, code editor, diff viewer and markdown would all be hand-built; pre-1.0 API. **Fyne** — retained-mode widgets are hard to make dense and fast for large live tables.
- **Bridge rule (architecture constraint):** Go owns all pipeline state (informers, stages, diff, history). The frontend is a thin view: it requests a visible row range, Go pushes batched cell deltas for that range (throttled, ≤ 10 Hz). Never ship full objects or full tables over the bridge; full YAML only on an explicit detail view.
- Keyboard-first discipline: dense layout, no gratuitous animation, own all shortcuts (suppress conflicting webview defaults).
- Escape hatch: the rendering layer is the only frontend-coupled part; any frontend component can be swapped without touching the Go core.

### Frontend: React 19 + React Compiler (TypeScript, Vite)

- Criteria: fastest + best-looking; boilerplate irrelevant (AI-written code). With the bridge rule, framework render speed is not the bottleneck — grid rendering is.
- Why React: the only ecosystem with a top-tier canvas grid and the polished-UI component stack; highest AI-generation accuracy (Svelte 5 runes vs. Svelte 4 confusion, Solid written like React) — matters since the frontend won't be hand-reviewed by a framework expert.
- Rejected: **Svelte 5** — fine-grained reactivity for free, but fewer first-class adapters (dockview, shadcn port lags) and weaker AI accuracy. **Solid** — best reactivity model on paper, smallest ecosystem.

| Layer | Choice |
|---|---|
| Main live table | Glide Data Grid (canvas) — cell deltas from bridge events applied via `updateCells`, bypassing React re-render. The last stable release (6.0.3) declares React ≤18 peers and upstream looks stalled; used with a peer override behind the pure `layout()` adapter so it can be swapped |
| Components / styling | shadcn/ui + Radix + Tailwind (themes via CSS variables) |
| Command palette (planned) | cmdk — not used for `⌘O`: it forces Enter onto the highlighted item, which breaks free-text submit |
| Splits / tabs | dockview |
| YAML view / edit / diff | Monaco (incl. diff editor), trimmed to a lazily loaded viewer; a small Monarch tokenizer for decoded JSON instead of Monaco's JSON language service and its worker |
| Terminal (exec, debug, node shell, logs) | xterm.js |
| Motion | Motion (formerly Framer Motion), subtle only |

- Canvas constraint: no arbitrary HTML in table cells — typed columns (bytes, diff highlight, "changed, not visible" marker) are Glide custom cell renderers.
- Non-table React state (panels, dialogs) lives in an external store (zustand) subscribed per component; high-frequency data never goes through React state.

### User config: `~/.kubewing/`

Plain YAML, hand-editable, git-friendly (can be versioned or dotfile-synced). kubewing only reads `config.yaml`, `keybindings.yaml`, `refs.yaml` and `themes/`; it writes its own `history.yaml`, `columns.yaml` and `clusters.yaml` (into the state directory, by default the same). Planned: `views/*.yaml` (saved pipelines), `aliases.yaml`, `favorites.yaml` (bookmarked clusters).

## Watches and the source layer

- **One watch per source:** `as=Table;g=meta.k8s.io;v=v1;includeObject=Object`. Default columns come from the server's Table output, so kubectl's columns and CRDs' `additionalPrinterColumns` are free, and cells and objects always share a resourceVersion.
- **Shared registry** keyed by (cluster, resolved GVR, namespace, selectors), ref-counted; a watch stops when the last view on it closes. Keys use the *resolved* resource, so `no`, `node` and `nodes` share one. Short-lived consumers (the node-shell dialog's node list) hold a watch and release it 30 s after they close.
- `managedFields` stripped via transform funcs; metadata-only lists, watches and gets where sufficient (the jump menu, label completion, the catalog's CRD and namespace watches).
- **Cluster catalog:** per-context discovery snapshot (resource types incl. short names, group, scope; namespaces), fetched only for contexts with an open pane — never triggers exec-plugin logins in the background. Refreshed by metadata-only CRD/namespace watches, on resolve misses and every 5 minutes. Partial discovery and forbidden namespace lists degrade to a hint.
- **Reconnect:** each context's connection has a dialer of its own (`rest.Config.Dial`), so client-go builds a transport for it rather than sharing one from its TLS/exec-plugin cache. A reconnect drops the connection (`ClusterOpener.Reconnect`, under every name it was reached by), restarts the context's shared watches in place (`Registry.Restart`: subscribers, objects and history stay; the new list reaches them as a relist; the old watch's fanout stops delivering) and restarts the catalog's watches. Sessions, port-forwards and log streams keep the old transport until they end. "Disconnected" is derived, not tracked: a synced view with a source error (cleared by the next successful list).
- **Kubeconfigs from other terminals:** a launch that hands over to a running kubewing passes the `$KUBECONFIG` path encrypted with `instance.key`. Such a cluster is addressed as `@n/<context>` (`internal/source/kubeconfig.go`); kubewing's own kubeconfig uses plain context names. The references live as long as the process.
- **Kubeconfigs in memory:** a `@n` reference is either a list of files (read anew each time, as kubectl does) or a kubeconfig built in memory under a key (`RegisterConfig`: the same key gets the same `@n`, its config replaced). The clusters dialog (`⌘P`) registers Gardener targets that way, so everything downstream (the opener's connection cache, reconnect, the catalog, splits and `⌘T` staying on `@n`) works unchanged. Nothing is written to disk; a reconnect reuses the registered config (a rotated CA needs a new pick).

## Listings (`all`)

Everything in a namespace (resource `all`, `source.AllResources`) is one pane over every namespaced type, listed once rather than watched: one watch per type would be 100–200 per namespace on CRD-heavy clusters, for a view mostly used to look around.

- **A source like any other.** The registry resolves `all` itself (`Resolved.Kind` `*`, a namespace required, no selectors) and runs a snapshot (`internal/source/snapshot.go`) in place of the opener's watch: the types from discovery (refreshed, so new CRDs count; tapes: their kinds), namespaced ones only, events left out, each group/kind once; metadata-only lists, ≤ 8 at a time, ≤ 60 s for all; merged into one `Relist`, then idle. So sharing between splits, history recording and the keyed diff work unchanged.
- **Its own table.** The snapshot sends server-style column definitions and cells (`SnapshotColumns`): KIND, NAME, OWNER, FINALIZERS as cells, AGE and DELETING as dates re-derived from the timestamps (`stampColumns["*"]`), so they tick. A kind served by two groups is shown qualified. Metadata lists say `PartialObjectMetadata`: the type's apiVersion and kind are stamped on, which is what the rows' actions resolve their type from.
- **Refresh = restart.** `⌘R` (`Service.Refresh` → `Subscription.Restart`) starts the shared source anew, as a reconnect does: the new relist reaches every split, which diffs it against the last (added, removed, changed marks; a version when recording). Progress and the outcome travel as `Listed` events (`source.Listing`: types, done, when, skipped types), replayed to late subscribers like the last error and shown by the view's `Status`; the skipped list itself is fetched on request (`Service.Skipped`).
- **Rows of many types.** Actions don't use the pane's type: `row()` resolves a snapshot row's own (`rowType`: `ResolveKind` from its stamped apiVersion/kind, then the opener's `Resolve` for the GVR) and reads the whole object (`Actor.Get`). Full objects are kept per pane for the rows opened lately (`fullCache`, ≤ 64), read by the view through `view.Options.Full` for the detail's YAML and decoding; the detail polls `Object`, which re-reads it, so an open YAML follows the object. Relations read the full object too (references are in the spec). The versions (diff, field history) stay the listed metadata: the history records what the source delivered. A delete or an edit from the pane lists again (`refreshAfter`), since nothing watches.

## Clusters dialog and Gardener

- **gardenctl compatibility without gardenctl:** `internal/gardener` reads `gardenctl-v2.yaml` (identity, alias, kubeconfig, context, patterns, access-level defaults) and matches patterns as gardenctl does (Go regexps, unanchored, named groups `project`/`namespace`/`shoot`/`seed`, first matching pattern per garden). gardenctl's resolver, kubeconfig generator and session logic are under its `internal/`, and its module pulls in gardener/gardener, so the needed parts are reimplemented (~400 lines) against unstructured objects. No Gardener Go types.
- **Matching never connects:** `MatchTarget` runs on every keystroke and is pure; only `OpenCluster` (an explicit pick) connects, through kubewing's own connection to the garden (`Lookup`: `GetObject`/`ListObjects` on the `ClusterOpener`, status errors kept so NotFound is still recognized), so lookups and garden panes share one login. Where gardenctl errors on a value several gardens match, kubewing lists one target per garden.
- **Shoot kubeconfig:** gardenctl's: per advertised address (external first) a cluster with the CA from `<shoot>.ca-cluster`, the cluster extension `client.authentication.k8s.io/exec` = `{shootRef, gardenClusterIdentity}` (client-go hands it to the plugin as `spec.cluster.config`, hence `ProvideClusterInfo`), user exec `kubectl-gardenlogin get-client-certificate [--access-level]`. The first context is named `<garden>/<technicalID>` (safety rules match on it). Shoots older than Kubernetes 1.20 (the legacy flag form) aren't supported.
- **Control plane:** the seed of `spec.seedName`, in namespace `status.technicalID`: a managed seed (`garden/<seed>`) through its shoot's gardenlogin kubeconfig (access level from `kubeconfigAccessLevelDefaults.seeds`), else the `garden/<seed>.login` (or `.oidc`) secret's kubeconfig as is. Named `<garden>/seed--<seed>`, so all control planes on one seed share a connection.
- **Seed targets:** `Target{Seed}` without a shoot (a pattern's `seed` group, a gardenctl session, `⌘J`) resolves the same way as a control plane's seed (`Resolver.seed`), in all namespaces; registered under the same key, so a seed and its control planes are one connection. Remembered as `config.Cluster.Seed`; a control plane's seed isn't (it's looked up anew).
- **Recent clusters:** `config.ClusterStore` (`clusters.yaml`, ≤ 100, same-cluster dedupe, not rewritten within a minute). Kubeconfig contexts are recorded by `OpenPipeline` (whatever opened the pane), Gardener targets when they're resolved: their pane's cluster is an in-memory kubeconfig that can't be reopened from files, and two control planes on one seed are one connection. gardenctl's session targets (`$TMPDIR/garden/sessions/*/target.yaml`, by mtime) are merged into the list read-only.
- **One line per shoot:** Go pairs a shoot and its control plane into one entry (`ClusterEntry.Alt`) in the recent list, matches and choices. The pair sits where the most recently used plane would be. A missing other plane is made up, never used, so the dialog's plane toggle works on every shoot and shows a known rule for both. The frontend only picks `entry` or `alt`, by the toggle. Forgetting a line removes both planes.
- **Opening lists nothing:** `⌘P` opens a pane with `resource: ""` (`emptySpec`), which `applySpec` and the pane's mount never send to Go, and `⌘O` over it. `OpenCluster` tracks the catalog right away (an explicit pick may connect), so `⌘O` completes before anything is listed. The resolved context name is the cluster's context part, so badges and frame colors are there from the start.
- **Clusters in `⌘J` (`Relations.Clusters`, `bridge/clusterjumps.go`):** a Shoot (`core.gardener.cloud`), Seed or ManagedSeed (`seedmanagement.gardener.cloud`) row lists ⌘P entries (`ClusterEntry`, `From: "jump"`), not pipeline targets: they're another cluster, and resolving one connects (maybe a login), so it happens on the pick only (`OpenCluster`, as the dialog's). Only on a garden of gardenctl's config, so the entries' garden is known without a lookup: a cluster `⌘P` registered as `garden:<identity>`, else one whose kubeconfig's API server is a garden's (`source.Server`: kubeconfig only, no connection). The frontend shows them as a section of their own, first (the highlight starts there), and opens them as `⌘P` does (`openCluster`: here, split, tab).
- **`⌘⇧P` (`OtherPlane`):** Go remembers the targets `OpenCluster` resolved, a shoot by its cluster (its kubeconfig is its own) and a control plane by its seed's cluster plus the shoot's namespace there (control planes on one seed share a connection). The pane's spec (cluster, namespace) finds the target. The other plane is resolved as a pick would be. The memory lives as long as kubewing runs, like the in-memory kubeconfigs; a cluster not opened by `⌘P` or `⌘J` gets an error. A resolved control plane also notes its seed's cluster (as a seed, with that shoot). On a seed's cluster the shoot is the pane's namespace's (`gardener.ShootOfNamespace`: the technical id `shoot--<project>--<name>`), else the context's namespace's (gardenctl's), else the control plane opened there last. Clusters not resolved in this run (a terminal's gardenctl kubeconfig, a restored pane) are known by their kubeconfig (`targetOfKubeconfig`, reading only): a context named `<garden>/seed--<seed>` is that seed (kubewing's naming; checked first, as a managed seed's kubeconfig has gardenlogin for its shoot); a gardenlogin context (`source.GardenloginOf`: the cluster extension's `shootRef` and `gardenClusterIdentity`) with a `shoot--` namespace is a control plane on the seed of `shootRef`, without one the shoot `shootRef`. `⌘⇧P` is bound in the `dialog` context as well (⌘O only), since an opened cluster has ⌘O over it.

## Metrics

- **Columns, not a view.** `kubectl top` values (and `kubectl describe node`'s allocated resources) are extra available columns of Pod and Node views (`metricColumns` in `internal/view/metrics.go`), referenced by name in `columns.yaml` like server columns, never among the defaults. So sort, grep, filters, splits and jumps apply without a second table.
- **Feeds, shared.** A metric column says what it's computed from; the bridge runs ref-counted feeds for the panes that show one (`internal/bridge/metrics.go`), started when a pane's columns gain one (open, type columns change), stopped when the last pane hides them or closes; a joining pane gets the last data at once.
  - *Usage:* metrics.k8s.io can't be watched, so it's polled (15 s), one feed per source key (cluster, resource, namespace, selectors) + kind.
  - *Allocation* (node `%CPU REQ` …, their own group and key, `⇧M`: the first list of every pod is slow on big clusters, so it's opt-in apart from usage, with a loading state in the status line until the first sums): one feed per cluster holding a shared registry watch on its unfinished pods (`status.phase!=Succeeded,status.phase!=Failed`, as kubectl describe node), keeping per-node sums up to date from the events (a pod's previous resources taken out, its new ones put in), pushed at most once a second. A watch rather than a list per poll: the first list is the cost, then only changes. A pod's resources are component-helpers' `PodRequests`/`PodLimits` (`source.PodResources`), the scheduler's and kubectl's rules, for the pods' percentages too. They're kept by resource name (`source.Amounts`: cpu in millicores, the rest in their unit), so ephemeral storage and extended resources are summed with no extra code, and a node's sum counts its pods (`PODS`/`%PODS` against `allocatable.pods`). Extended resources and huge pages get a `%<name> REQ` column each, only once a node of the pane has a non-zero allocatable of it (`View.extended`, collected from the nodes' events; a newly seen one re-resolves the columns, so a configured column of it appears then, and the pump re-syncs the feeds since it may be the first allocation column shown); no LIM column, as Kubernetes requires their limits to equal their requests. A configured one no node has yet is still listed in the `alloc` group (missing), so the switch hides it too. `source.Metrics` is implemented by the cluster opener (`metrics.k8s.io/v1beta1` pods/nodes, container usage summed) and by tapes (`metrics:`); NotFound/Forbidden/ServiceUnavailable are `ErrNoMetrics`, shown in the status line.
- **Outside the object.** Usage is held by the view by namespace/name (`SetMetrics`), not in the object or its hash: new data re-renders only metric cells (and the match: grep sees them), marks nothing (metric columns are `timeDerived`) and isn't recorded. The past renders them empty.
- **Their place, while off.** Hidden columns aren't in `columns.yaml`, so turning a group off (`SetTypeMetrics`) also saves its place, `metrics:` or `allocation: {after, order}`: the shown column before them and their order. Requests/limits without a place go after the usage columns. Turning on puts them back there; a missing anchor falls back to after NAME.

## Keyed diff

Object identity from watch events, not screen position (avoids viddy's row-shift, AGE-tick and same-name-recreate artifacts).

- **Identity:** rows keyed by UID → correct added/removed/changed regardless of sort; delete + recreate under the same name shows as remove + add.
- **Table diff:** per-(UID, column) rendered-cell comparison; time-derived columns (AGE, an event's LAST SEEN/FIRST SEEN) excluded. Event stamps are taken from the object by kind (`stampColumns` in `internal/view/stamps.go`), as kubectl picks them, so they tick and sort by exact time.
- **Hidden changes:** hash of the normalized object → "changed, not visible" marker.
- **Normalization / noise filter:** strip `resourceVersion`, `managedFields`, heartbeat fields (`lastHeartbeatTime`, lease `renewTime`); drop resync/relist no-ops. Path-based, user-extensible ignore rules. The rules are fixed per watch: a config reload applies to watches started afterwards, so one history never mixes two rule sets.
- **In-place stage updates:** a filter/grep change re-evaluates the match flag of the existing view instead of rebuilding it: the watch, normalized objects and diff state survive. Only a source change (label selector) re-subscribes.

## Filters

- **Grep** is one `grep:` string in the pipeline (fzf-like terms: AND, `!x`, `^x`/`x$`, `|`, quoting). Regex was considered and left out: prefix, suffix and OR cover the cases, without a second engine (RE2 vs JS) or backtracking in the log filter. Export can map it to `grep -i a | grep -vi x`. Matching runs on the lower-cased cells joined by a space; age columns match as timestamps.
- **Label selector and CEL are drafts until `⏎`.** Go dry-runs the draft against the pane's objects for the preview (`→ 298 / 340`). Label previews are exact when the draft is at least as strict as the applied selector (`view.Narrower`), else a lower bound (`≥`).
- **Label completion** counts keys and values among the source's objects matching the draft's *other* requirements (`Service.Labels`, `internal/bridge/labels.go`): from the pane's objects when the rest is at least as strict as the applied selector or the pane shows the past, else from a metadata-only list of the source; failures fall back to the pane's objects.
- **CEL completion** takes field paths from the live objects (works for every CRD without OpenAPI). The objects are schemaless, so keys that aren't identifiers complete as `["app.kubernetes.io/name"]`, not Kubernetes' `__dot__` escaping. CEL has a cost limit per evaluation; a missing field is "no match", other errors are counted and reported.

## History buffer

In-memory, newest snapshot + reverse field-path deltas, per shared watch (`internal/history`, diffs from `internal/fieldpath`).

- **Storage:** the newest normalized object per UID, plus one delta per older version. A delta is a list of field-path changes carrying both old and new values, so it applies in reverse: version n−1 = undo(delta n, version n). Going back is a walk from the newest object; dropping the oldest version drops its delta, with no keyframes to rebase. The same changes drive "what changed" in the diff header.
- **Lists matched by key** (containers by `name`, conditions by `type`), not by index.
- **Opt-in:** off by default ("record changes" per source). A recording watch handles ~200k events/s (normalize + hash + diff, ~5 µs/event) vs. ~1M/s without. Off, each view keeps only the previous version. Switching on takes the current objects as first versions; switching off drops the history.
- **Where:** in the shared watch (`source.Registry`), not in each view. Splits on one source share one history (and its on/off), and the object is normalized once per event, not once per split.
- **Limit:** one global memory budget (`history.budget`, default 512Mi, counting the newest copies and the changes as JSON sizes), so every object reaches back equally far — which a table-at-a-moment needs and a per-object version cap doesn't give. Past it, the oldest changes go first across all objects (down to 90%, so eviction doesn't run per event). An object's oldest kept version stays as its baseline. There's no time window: it would only cut history the budget still has room for. Versions are numbered per object, so stepping stays stable while updates arrive.
- **Tombstones:** a deleted object keeps its history until the view drops its tombstone; a recreate under the same name is another UID, so another history.
- **Lifecycle:** dropped when the last view on the source closes.
- **Time travel cost:** a step rebuilds the table from the history, ~50 ms for 10k objects with 10 versions each; quick presses merge into one step. Server cells are recorded with each version. Ages count from the moment shown (`nowOf` in `frontend/src/grid/rowcache.ts`).
- **Later:** pinning objects/views against eviction; on-disk persistence (e.g. SQLite/Pebble), blocked on secrets landing on disk in plaintext — needs encryption or exclusion first.

## Field references

Which fields name another object (`secretName`, `roleRef`, a shoot's `seedName`) is data, not code: rules in `internal/relations/refs.yaml` (embedded), extended by the user's `refs.yaml` (theirs first, same id replaces, `disable` drops). They drive the jump menu's field section (the references at a YAML view's or the editor's cursor), the marks and `⌘`-click in the viewer, and the direct references of the table's `⌘J`.

- **Path patterns, not CEL.** A rule must say *where* a reference is, so the cursor can be matched to it; CEL evaluates to values and can't. The pattern (`**.volumes[*].secret`, `subjects[kind=ServiceAccount]`, `*SecretRef`) is matched over the YAML node tree of the text shown, which has the lines and columns: one walk gives the reference, the value's position (for the mark) and the field's line span (for "everything in this volume"). The same text Go parses is what the frontend shows (the view, the diff's right side, the editor's text as typed), so nothing has to map lines between two renderings.
- **Kinds by group, not version.** Targets are `Kind`, `group/Kind` or `group/version/Kind`; a reference without a version (RBAC's `apiGroup`) resolves to the preferred one (`ResolveKind` with `group/`). Two fields naming one object are one entry (counted), compared by group/kind/namespace/name; the namespace defaults to the object's own and is dropped once discovery says the target is cluster-scoped.
- **Direct only; derived references stay in Go.** A pod's claims → their bound volumes → attachments, a stateful set's claims by the controller's naming pattern, an ephemeral volume's claim `<pod>-<volume>` aren't one field each. `relations.References` keeps them; the rules add what it doesn't list, and on a duplicate the derived entry wins (it knows more: a checked UID, "deleted" vs. "missing"). Planned on top: reverse references (the rules read backwards, e.g. the pods using a secret) and configurable chains of rule ids (see Plan).
- **Every target is looked up** (metadata only, so secrets aren't read): not there is **missing** (a field may name what was never created, unlike an owner, which is "deleted"); a failed lookup (forbidden) keeps the jump with "not checked".

## Decoding

`internal/decode` is pure. A request sends the levels (field paths resolved by Go on the first, chains after), and Go decodes from the object again each time: nothing decoded is kept. The value comes from the object at the line's field path (`fieldpath.AtLine`), not from the YAML text.

- Detection: base64 is kept only when it decodes to text, gzip or brotli text (so "admin123" stays a word); a Secret's `data` and a ConfigMap's `binaryData` always decode. gzip by magic bytes. Brotli has no magic bytes: bytes that aren't text are tried and kept only if they decompress to text; a `.br` key takes any result. Decompression capped at 16 MiB.
- The decoded diff decodes the field in both versions with the same chain.
- Out of scope: etcd/auger (protobuf as stored in etcd; kubewing only sees the API server's objects).

## Logs

`internal/logs` is the pure tailer; `internal/bridge/logs.go` wires it to a watch and the `kw:logs` batch events; `source.Actor.Logs` (and a tape fake) behind it. One follower per pod container (shared on the pane's watch for a whole-pane tail), `logs.maxStreams` concurrent, restart-resume via the RFC 3339 timestamp. The frontend renders into a read-only xterm from a bounded ring (`frontend/src/logs/`).

## Safety model

Rules are decided in Go (`internal/safety`); the frontend only shows what Go decided. Every mutation is two-phase: Go checks the rule and issues a single-use token, valid for 60 s and bound to that exact action and object (kind, context, resource, namespace, name, UID); the mutating call only runs when it redeems that token. So no path (keys, menu, context menu, palette) gets around a rule, and a confirmation can't act on another object than the one it showed. A config reload drops outstanding tokens. Deletes carry a UID precondition; edits a resourceVersion precondition.

## Frontend

- **Single command dispatcher:** every shortcut (JS keydown or native menu accelerator) resolves to the same command id and goes through one dispatcher. The native menu is built from the live keymap (`keys/appMenu.ts`); global `⌘` chords are native key equivalents, scoped keys appear in labels only, so a menu shortcut never fires inside a text field.
- **Modal editor:** the YAML editor (edit, node-shell YAML) only lets its own keys reach the app; global keys and menu commands wait until it's closed.
- **Generated lists with completeness tests:** the row menu comes from `actions/registry.ts` (a test fails for any `object.*` command without an entry); the cheat sheet from `keys/cheatsheet.ts` (a test fails for any command no section mentions).
- **Swappable bridge transport:** Wails IPC in the app, WebSocket to a headless Go backend in tests and browser dev.
- **Layout:** the store's split tree is the source of truth; `store/dock.ts` converts to and from dockview's layout.

## Process model

- **Single instance per config directory:** Wails' single-instance lock (in `NSTemporaryDirectory()`), keyed by the config directory, checked before `application.New` (which would exit silently); the second launch says so on stderr and hands over its kubeconfig path.
- **Detaching:** launched from a terminal, kubewing re-runs itself in a session of its own (stdin `/dev/null`, output appended to `kubewing.log`, rotated at 10 MiB). Piped/redirected output and `-headless` never detach.

## Testing strategy: assert on state, not pixels

UI regressions are caught by checking the app's state as data at every layer. Full-app screenshot diffs are not used.

- **Go core: view-model goldens (most tests).** Scenario tapes (starting objects + scripted watch events: add/update/delete/relist/recreate under the same name) run through `pipeline → bridge output` against a fake cluster; cell deltas, row keys and diff markers are compared to golden files. Property tests (`rapid`) for the keyed diff: re-sorting produces no "changed" markers, AGE ticks never count, recreate shows as remove + add, a no-op relist produces no deltas. The bridge rule is tested too: nothing outside the requested row range, no full objects unless asked for, ≤ 10 Hz under event storms.
- **Bridge contract.** Generated TS bindings are committed (a CI check is planned).
- **Frontend logic without a browser.** Keymap resolution and command effects are plain unit tests; a static check catches binding collisions per context and confirms suppressed webview defaults stay suppressed. Glide cell renderers are split into a pure `layout(cell, theme)` (unit-tested) and a thin `draw()`. Layout operations keep the tree valid and focus always on an existing pane.
- **E2E on meaning.** Playwright drives the frontend in Chromium against the headless Go backend replaying tapes; tests read state through `window.__kw.inspect()` and use ARIA snapshots for DOM parts.
- **Introspection hook:** test builds expose `window.__kw.inspect()` (layout tree, focus, per-pane pipeline, visible rows/cells, selection, open overlays).
- **Guardrails against AI-made regressions.** Goldens are the spec: updating them takes an explicit `-update` flag and the change is reviewed as its own diff. Lint bans raw colors outside theme tokens.
- Planned: a WKWebView smoke suite for what Chromium can't reach (native menu accelerators, IME); invariant fuzzing with random key sequences; a golden-guard hook on `testdata/`.

Example — "a shortcut opens an overlay", by layer:

| Layer | Assertion |
|---|---|
| Keymap unit | `resolve("Meta+P", {focus: "table"})` → the command, also from a split, the YAML view and a terminal (xterm.js and Monaco must not swallow it) |
| Command unit | the command on a store state → overlay open, input focused, previous focus remembered for `Esc` |
| E2E (Chromium) | press the key → `inspect().overlays` contains it; ARIA snapshot shows a focused combobox; `Esc` → focus back on the same pane and row |
| Smoke (WKWebView) | the key triggers no native dialog and isn't consumed by the menu bar |

## Code layout

| Path | What |
|---|---|
| `internal/pipeline` | pipeline model (source → stages → render), YAML (de)serialization |
| `internal/expr` | CEL (cel-go, plus `sum()`) and dot paths |
| `internal/normalize` | noise rules + content hash |
| `internal/fieldpath` | field-path diff of two objects (lists matched by `name`/`type`/…), applied forward or in reverse; a YAML line → its field path; pure |
| `internal/decode` | value decoding: base64/gzip/brotli chains, rendered as JWT, PEM/x509, JSON/YAML, text or hex dump; capped; pure |
| `internal/history` | per-object versions: newest object + reverse deltas; global memory budget; the table at a moment, changes over time, a field's values |
| `internal/source` | Table list/watch, ref-counted shared registry (history recording per watch), namespace listings (`all`), discovery + metadata-only lists/watches/gets; metrics.k8s.io usage; actions (describe, delete, exec, debug containers, node shells, port-forward, logs) |
| `internal/logs` | multi-container log tailer; pure |
| `internal/catalog` | per-context completion snapshot (resource types, namespaces), background refresh |
| `internal/config` | `~/.kubewing/` loader (config, keybindings, themes; invalid parts reported, defaults used); `history.yaml`; `columns.yaml`; `clusters.yaml` |
| `internal/gardener` | gardenctl-v2 config and patterns, target resolution in the garden (shoot, control plane, project), gardenlogin kubeconfigs, gardenctl session targets; no Gardener Go deps |
| `internal/safety` | per-context rules, two-phase mutations (prepare → single-use token → execute) |
| `internal/view` | pipeline over events → keyed diff → viewport frames |
| `internal/bridge` | frontend API, ≤10 Hz frame pump, WebSocket transport |
| `internal/app` | the Wails-bound service (thin adapter over the bridge), native menu, window, single instance, detaching |
| `internal/relations` | the jump menu's relations (namespace, owners, owned, references), each as a pipeline target; field reference rules (`refs.yaml`, embedded) matched over a YAML text; pure |
| `internal/tape` | scenario tapes (goldens, headless E2E); fake catalog; fake actions (echo shell, port-forward); fake metrics (`metrics:`); `filter: true` tapes (`rel-*`) honor namespace and selectors and serve metadata |
| `frontend/src` | React 19 + Compiler, Glide grid, zustand, transport (Wails / WS) |
| `frontend/src/actions` | row actions registry (row menu) |
| `frontend/src/keys` | keymap, cheat sheet, native menu |
| `frontend/src/complete` | completion: pure ranker + candidate providers, combobox, catalog hook |
| `frontend/src/store/dock.ts` | pure converters between the store's split tree and dockview's layout |
| `frontend/src/editor` | Monaco, trimmed to a lazily loaded read-only YAML/JSON/text and diff viewer, and the editor |
| `frontend/src/term` | xterm.js terminal and exec session output store |
| `frontend/src/logs` | log pane: bounded ring, live filter |
| `frontend/src/grid` | Glide grid adapter, cell layout, row cache |
