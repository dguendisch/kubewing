# kubewing manual

kubewing is a keyboard-driven desktop UI for Kubernetes: `kubectl`'s operations, the shell's grep / watch / diff, and a terminal multiplexer's tabs and splits, in one window. This manual covers everything that works today. Press `?` in the app for the live list of shortcuts.

## Contents

1. [Getting started](#1-getting-started)
2. [Basics: tabs, panes, sources](#2-basics-tabs-panes-sources)
3. [The table](#3-the-table)
4. [Filtering](#4-filtering)
5. [Watching changes](#5-watching-changes)
6. [Time travel](#6-time-travel)
7. [Looking at an object](#7-looking-at-an-object)
8. [Decoding values](#8-decoding-values)
9. [Editing](#9-editing)
10. [Navigating between resources](#10-navigating-between-resources)
11. [Row actions](#11-row-actions)
12. [Logs](#12-logs)
13. [Shells: exec, debug containers, node shells, local terminals](#13-shells-exec-debug-containers-node-shells-local-terminals)
14. [Port-forwarding](#14-port-forwarding)
15. [Layout: splits, tabs, names](#15-layout-splits-tabs-names)
16. [Safety](#16-safety)
17. [Configuration](#17-configuration)
18. [Keyboard reference](#18-keyboard-reference)
19. [Troubleshooting](#19-troubleshooting)

Key notation: `⌘` Command, `⌥` Option, `⌃` Control, `⇧` Shift, `⏎` Return, `⇥` Tab, `⌫` Backspace.

---

## 1. Getting started

### Installing

kubewing runs on Macs with Apple silicon (macOS 13 Ventura or later). Download `kubewing-<version>-macos-arm64.zip` from the [releases](https://github.com/dguendisch/kubewing/releases), unpack it (double-click), and move `kubewing.app` to `/Applications`. Releases named `-rc.N` are release candidates: previews of the next version.

kubewing isn't notarized by Apple, so macOS blocks the first launch ("Apple could not verify kubewing…"). Allow it once, either way:

- open it, click **Done**, then **System Settings → Privacy & Security → Open Anyway** (near the bottom), and confirm with your password; or
- in a terminal: `xattr -dr com.apple.quarantine /Applications/kubewing.app`

To check a download, compare `shasum -a 256 kubewing-*.zip` with the `.sha256` file next to it in the release. The version is shown in **kubewing → About kubewing**, and `kubewing -version` prints it.

To start it from a terminal (for the [flags](#command-line-flags)), link it into your `PATH`, e.g. `ln -s /Applications/kubewing.app/Contents/MacOS/kubewing ~/bin/kubewing`.

### Updates

kubewing checks for a new version once a day. When one is out, **⬆ 0.3.0** appears at the right end of the tab bar. Click it to read what's new: the release notes of every version since yours, newest first. **kubewing → Check for Updates…** checks right away and shows the same notes, or says you're up to date.

- **Update to 0.3.0** downloads the new version, checks that it's an unchanged, signed kubewing release, replaces the app and restarts it. A restart ends terminals, log tails and port-forwards: the dialog says how many and asks first. macOS doesn't ask to allow the new version again.
- **Skip this version** hides the hint until a newer version is out.
- **Later** closes the dialog. The hint stays.

Where kubewing can't replace itself, the button reads **download…** and opens the release page, and the dialog says why. That happens when the app runs from a folder you can't write to, or wasn't moved out of Downloads (macOS then runs it from a temporary copy). Development builds (built from source) aren't offered updates.

Both settings go in [`config.yaml`](#configyaml), under `update:`:

```yaml
update:
  checkDays: 7        # days between checks; 0 turns automatic checks off (Check for Updates… still works)
  prereleases: true   # offer release candidates too
```

The check asks GitHub for the list of releases and sends nothing about you or your clusters.

### Building from source

kubewing can also be built and started from the repository (see [Development.md](Development.md) for the toolchain):

```sh
make deps   # once
make run    # builds bin/kubewing.app and starts it in the foreground
```

The app opens on your kubeconfig (`$KUBECONFIG`, else `~/.kube/config`) at its current context, on pods. A context that sets a namespace starts in it; one without starts in all namespaces. Without a kubeconfig, or with none of its contexts set as current, it opens with `⌘⇧O` instead, over an empty pane (new tabs start empty too). Other clusters, Gardener shoots included, are a `⌘⇧O` away (see [Opening a cluster](#opening-a-cluster-o)).

### Launching from a terminal

Launched from a terminal, kubewing **detaches**: the prompt comes back right away, and closing the terminal doesn't end it. Its output goes to `kubewing.log` in the state directory (appended; at 10 MiB it moves to `kubewing.log.1`).

- `-wait` (or `launch.wait: true` in `config.yaml`; `-wait=false` overrides it) keeps it in the foreground with the log in the terminal.
- Output redirected to a file or pipe (`kubewing 2>&1 | tee …`) is left as it is, and kubewing doesn't detach.

### Launching from the Dock or Finder

Started from the Dock, Finder or `open`, kubewing first asks your login shell for its environment (`$SHELL -i -l`, like a new Terminal tab, so `.zprofile` and `.zshrc` both count) and uses it. So `PATH` and with it the credential plugins of your kubeconfigs (`kubectl`, `kubectl-gardenlogin`, `kubectl oidc-login`), `KUBECONFIG`, `GCTL_HOME` and `KUBEWING_HOME` are the same as from a terminal. If the shell gives no answer within 10 seconds, kubewing goes on with macOS's minimal environment and says so in the log.

### One kubewing per config directory

Launching kubewing again while one is running **opens a new tab in the running one** and brings its window to the front; the new launch exits (and says so in the terminal). The new tab starts on *that terminal's* kubeconfig, at its current context and namespace, so a `gardenctl` shell's target opens as it is.

- The tab keeps that kubeconfig: splits and `⌘T` from there stay on it, and `⌘O` lists its contexts (the dialog names the files).
- The same context name in two terminals' kubeconfigs is two different clusters. Safety rules still match by name.
- The kubeconfig path is handed over encrypted with `instance.key` in the config directory, so no other app can make kubewing read a file.
- `-new-process` starts a separate kubewing (its own window, watches and shells). A different config directory (`-config`, `$KUBEWING_HOME`) is always a separate kubewing.

### Command line flags

| Flag | Effect |
|---|---|
| `-wait` | Stay in the foreground, logging to the terminal. |
| `-new-process` | Start a separate kubewing instead of opening a tab in the running one. |
| `-config <dir>` | Config directory (default `$KUBEWING_HOME`, else `~/.kubewing`). |
| `-state <dir>` | Where kubewing writes `history.yaml`, `columns.yaml`, `clusters.yaml`, `update.json` and `kubewing.log` (default: the config directory). |
| `-garden <dir>` | The directory of the `gardenctl-v2.yaml` to read (default `$GCTL_HOME`, else `~/.garden`). |
| `-headless <addr>` | No window: serve the UI's backend over WebSocket (for development and tests). |
| `-version` | Print the version and exit. |

---

## 2. Basics: tabs, panes, sources

A window holds **tabs**; a tab holds **panes** in splits. Every pane shows one **source**: a context, a resource type, a namespace (or all), and optionally a label and field selector. On top of the source, the pane applies its **filters** (grep, CEL, hide healthy), a **sort**, and the resource type's **columns**.

Under the hood each pane is a *pipeline* (`source → stages → render`), which is why filters, jumps and back/forward all compose the same way.

### Opening a source: `⌘O`

`⌘O` opens the dialog for context, resource and namespace. It starts from the focused pane's view.

- **Resource completion** ranks exact > prefix > substring > fuzzy matches over names, short names, singular and kind (`po`, `pdb`, `Deployment`). Suggestions show group, scope and short names, with the typed letters highlighted. A plural served by two groups (`machines`) completes to its qualified name (`machines.cluster.x-k8s.io`).
- **Namespace completion** lists the context's namespaces. Picking a context that sets a namespace prefills it.
- Fields open with their value selected; the list opens as you type (or with `↓`). `⇥` completes, `⏎` completes and opens, `⌥↑`/`⌥↓` first/last suggestion, `Esc` closes the list, then the dialog. Unknown text still opens as typed (any resource, CRDs included).
- A jump's field selector and CEL filter (see [Navigating](#10-navigating-between-resources)) aren't carried into `⌘O`, since they wouldn't apply to another resource.

Completion comes from a per-context **catalog** (resource types and namespaces), fetched in the background once a pane is open on that context. kubewing never connects to a context on its own, so it never triggers an exec-plugin login you didn't ask for. The catalog follows CRD and namespace changes and refreshes every 5 minutes. A partly broken discovery (an aggregated API down) or a forbidden namespace list shows a hint instead of failing.

### Opening a cluster: `⌘⇧O`

`⌘⇧O` (File → Open Cluster…) opens another cluster in the focused pane, a split below or a new tab, without going through a terminal. (`⌘O` opens what's in a cluster, `⌘⇧O` a cluster itself.) It has one field and a list:

- **Empty field:** the clusters you opened recently (up to 100, the latest first), then your gardens. A cluster counts as opened once a pane showed it, whichever way it got there (launch, `⌘O`, `⌘⇧O`). The targets of your gardenctl sessions (each terminal's `gardenctl target`) are listed too, marked `gardenctl`, so the list isn't empty on the first day. `✕` forgets a cluster.
- **Typing** ranks the list by shoot, project, garden, context name and kubeconfig file (`shoot--foo--bar` finds the shoot `bar` of project `foo`).
- **Pasting a Gardener dashboard URL** (or an API server host, or `garden/shoot--project--name`) shows what gardenctl's patterns make of it: the shoot (see the toggle below for its control plane). A dashboard URL of a project (no shoot) is the project in its garden.
- **A path** (`/…`, `~/…`) opens that kubeconfig file at its current context; `⌘O` then lists its other contexts.

`↑`/`↓` move, `⌥↑`/`⌥↓` first/last, `Esc` closes. Like a jump (`⌘J`), the highlighted cluster opens with:

- `⏎` (or a click) in the focused pane (`⌘←` goes back to what it showed). From a shell or log pane, it opens in a new tab instead.
- `⇧⏎` (or `⇧`-click) in a split below the focused pane (as `⌘D`).
- `⌘⏎` (or `⌘`-click) in a new tab.

The hints at the bottom of the dialog list these keys. The cluster opens with nothing listed and `⌘O` over it, in the cluster's namespace, to pick the resource. `Esc` there leaves the pane empty (its status line says **nothing listed**), and a click into it (or `⌘O`) picks later.

**Gardener shoot** (`⇥` toggles, or click the toggle at the bottom): a shoot is listed once, and opens as the **shoot** or its **control plane**. Each opening of the dialog starts on the shoot. Recent entries and labels follow the toggle: opening a control plane also lists its shoot.

Entries that can't be opened (a garden whose kubeconfig is missing) are greyed out, with the reason. Safety labels show next to the entries already, as far as the name is known. `✕` on a shoot forgets both its shoot and its control plane.

**Shoot ⇄ control plane: `⌥⌘O`** (File → Shoot ⇄ Control Plane) switches the focused table pane from a shoot to its control plane, or back. The pane keeps its resource and filters. A control plane starts in the shoot's namespace on the seed, a shoot in all namespaces. Like a pick in `⌘⇧O`, it may ask you to log in, and `⌘←` goes back. It works on shoots and control planes opened with `⌘⇧O` or `⌘J`, also right after opening, with `⌘O` still over the empty pane (it then stays open over the other plane). It also works on clusters opened from a terminal with gardenctl's kubeconfigs (`gardenctl target`, then `kubewing`), as their kubeconfig says which shoot or control plane they are. On a seed, the shoot is the one whose namespace the pane shows (`shoot--<project>--<name>`), else the one whose control plane was opened there last (a pane on nodes, or on all namespaces). Elsewhere it says so in the status line.

**Gardener targets.** kubewing reads gardenctl's config, `~/.garden/gardenctl-v2.yaml` (or `$GCTL_HOME/$GCTL_CONFIG_NAME.yaml`; `-garden` names another directory): the gardens, their kubeconfigs and contexts, and the `patterns` that turn a URL or name into a target. It's read anew each time the dialog opens. You need neither gardenctl nor its `target` command, but you do need what gardenctl's kubeconfigs need: `kubectl-gardenlogin` (shoots), and whatever the garden's kubeconfig uses (e.g. `kubectl oidc-login`), on your shell's `PATH` (see [Launching from the Dock or Finder](#launching-from-the-dock-or-finder)).

| Target | Opens | Context name | Namespace |
|---|---|---|---|
| shoot | the shoot, authenticated by gardenlogin | `<garden>/shoot--<project>--<name>` | all |
| shoot's control plane | its seed (a managed seed through its shoot, otherwise the seed's login secret) | `<garden>/seed--<seed>` | the shoot's, on the seed |
| seed | the seed, as for a control plane | `<garden>/seed--<seed>` | all |
| project | the garden | `<garden>` | the project's |
| garden | the garden | `<garden>` | all |

- Picking one looks it up in the garden, which may ask you to log in (the garden kubeconfig's exec plugin, e.g. a browser for OIDC). The dialog stays open with **resolving…** until it's done; errors (no access, no such shoot) show in it.
- A shoot name without a project is searched in all projects. If it exists in more than one, the dialog lists them to pick from (`Esc` goes back).
- A value that several gardens' patterns match (`shoot--foo--bar` without a garden prefix, two gardens with the same patterns) is listed once per garden, where gardenctl would refuse it.
- The garden is one connection however many of its projects and lookups you open, so you log in once. A shoot's kubeconfig is built in memory and lives as long as kubewing runs: nothing is written to disk.
- A seed is a target of its own when a pattern names one (a `seed` group), a gardenctl session targets one, or `⌘J` opened it from a seed row. A seed and the control planes on it are one connection.

### Where you are: the pane header

A pane's header names its cluster. On a Gardener cluster, instead of the context name, it shows where you are: the landscape (the garden), the seed beneath, and a colored badge for the **plane** you're looking at, followed by its name:

| Header | You're looking at |
|---|---|
| `live › seed aws-eu1 › ◉ SHOOT foo/bar` | the shoot `bar` of project `foo`, running on seed `aws-eu1` |
| `live › seed aws-eu1 › ⛭ CP foo/bar` | its control plane (CP): the shoot's namespace on the seed |
| `live › ▣ SEED aws-eu1 managed · shoot garden/aws-eu1 on seed root` | the seed itself, a managed seed: a shoot of project `garden`, whose own control plane runs on seed `root` |
| `live › ▣ SEED gke-01 unmanaged` | a seed registered with a kubeconfig of its own |
| `live › seed root › ◉ SHOOT garden/aws-eu1 is seed aws-eu1` | the shoot behind a managed seed |
| `live ◆ GARDEN project foo` | the garden, in project `foo`'s namespace |

- Each plane has a color of its own: shoot blue, control plane violet, seed brown, garden green. They're fixed, so they never clash with a safety rule's label and frame color (see [Safety](#16-safety)). The plane badge has round corners, the safety label (`LIVE`) square ones. A rule for a landscape (`*-live`) labels all its clusters.
- On a seed the pane's namespace decides: a shoot's namespace (`shoot--<project>--<name>`) is that shoot's **control plane**, any other namespace, or all, is the **seed**. Switching the namespace with `⌘O` switches the badge.
- A click on the landscape opens the garden (in the shown project's namespace), a click on a seed opens that seed, a click on a managed seed's shoot opens that shoot, all in the pane (`⌘←` goes back). A click on the **SHOOT** or **CP** badge switches to the other plane, as `⌥⌘O` does.
- In a narrow pane the landscape and seed are cut short first (`sap-l… › seed g… ›`); the badge always stays whole, and the shoot's name keeps as much room as it can.
- Hovering the header shows all of it: landscape, project, shoot, seed and what kind of seed it is, the namespace on the seed, and the context name.
- The tab leads with the plane's mark too (`⛭ pods · shoot--foo--bar`), after the safety label (`LIVE · ◉ pods`).
- Whether a seed is managed or unmanaged shows on the seed itself; it's learned when kubewing opens it (it needs to know that to connect), so it costs no extra login. A shoot's or control plane's header names only the seed, to leave room for the shoot; hovering tells its kind once known.
- This works for clusters opened with `⌘⇧O` or `⌘J`, for gardenctl's kubeconfigs when kubewing was launched from a terminal (`gardenctl target`, then `kubewing`), and for a garden opened from its own kubeconfig. Other clusters show their context name, as before.

### The status line

At the bottom of every table pane: the connection state (a green dot and **connected** once the watch is synced), `N shown / M objects`, errors, why metric columns are empty (see [Metrics](#metrics-m)), the **record changes** toggle and **columns**.

While a pane's first list is still loading, the dot pulses and says **syncing**. For a large resource, listed page by page, it also shows how far the list got: `syncing 35% (1,500/4,213)`. The total is the API server's estimate, which it only gives for lists without a label or field selector, and only once the first 500 objects are in, so a small or filtered list just says **syncing**.

When a synced watch starts failing (the network is down, the API server is unreachable), the state turns red and says **disconnected**. The rows stay as they last were, and the watch keeps retrying with a growing pause (up to 30 s).

**Reconnect** (`⌘⇧R`, a click on **connected**/**disconnected**, or File → Reconnect) doesn't wait for the retry: it drops the connection to the focused pane's context and lists every resource shown from that context again, over a fresh connection. Use it after the network comes back, or when a pane looks stuck while still saying connected. Panes keep their rows, filters and recorded history; whatever changed in the meantime shows as changes. Panes on that context whose open had failed open again. Shells, port-forwards and log tails keep their own connection.

Errors (a failed list or watch, a CEL filter failing on some objects, an action refused, such as a delete denied by an admission webhook) show their first line, wrapped to at most two lines. A click opens the full message, selectable (`⌘C`) or with **copy all**; `Esc` or a click elsewhere closes it. When client-go only says "the server rejected our request for an unknown reason", kubewing adds what the server actually answered and its HTTP status.

### Watches are shared

Every source is one watch (`as=Table;includeObject=Object`), so cells and objects always come from the same resourceVersion. Panes on the same source share that watch; it stops when the last pane using it closes.

### Everything in a namespace: `all`

The resource **`all`** lists every object of a namespace, of every type: config maps, secrets, claims, service accounts, roles and bindings, leases, custom resources … This is what `kubectl api-resources --namespaced -o name | xargs kubectl get` shows, not `kubectl get all` (which only covers pods, services, workloads, jobs and autoscalers). Events are left out: there are many, and they are about the other objects (`v` on a row shows its own).

- **Opening it:** `all` in `⌘O` (the first suggestion), with a namespace, which it needs. Or `⌘J` → **everything in shop**, from any row in a namespace or from a namespace row; `⌘←` goes back.
- **The table:** KIND (with its group where two groups serve the same kind), NAME, OWNER (the controller, else the first owner; `+2` more), AGE, DELETING (since its deletion was requested) and FINALIZERS, sorted by kind. Grep, CEL (on the metadata), sort, columns and splits work as anywhere: `/^Secret$` shows the secrets, `!^ConfigMap$` everything but the config maps, a sort on DELETING what's stuck in deletion longest.
- **Each row is its own type.** `⏎` shows the whole object, read when opened (so secrets are read only when you look at one), describe, edit, delete, events and `⌘J` work as in a pane of that type, logs and exec on pods.

**Listed, not watched.** A watch per type would be a hundred or more per namespace on clusters with many custom resources, so `all` is listed once: every type, at most 8 at a time. The status line says **listing 57/143 types** while it runs, then **listed 2m ago**.

- **Refresh: `⌘R`** (View → Refresh Listing, or a click on **listed …**) lists again, with the types the cluster serves now (a new custom resource is listed too). The rows stay until the new listing is complete, and what was added, removed or changed since the last listing is marked as in any pane. With **record changes** on, every listing is a moment to travel back to. A delete or an edit from the pane lists again on its own. **Reconnect** (`⌘⇧R`) lists again too.
- **Auto refresh:** a click on **auto refresh off** cycles through every 10s, 30s, 1m and 5m (and back to off). It runs while the pane is open.
- **Types it couldn't list** (forbidden, an aggregated API down) are counted in the status line (**3 not listed**); a click shows which and why. The rest is shown.

---

## 3. The table

A live table for any resource type, with kubectl's columns (taken from the server's Table output, so CRDs' printer columns work too).

### Moving around

| Key | Action |
|---|---|
| `j` / `k` (or `↓` / `↑`) | next / previous row |
| `PgDn` / `PgUp` | page down / up |
| `g` / `G`, `⌥↑` / `⌥↓` | first / last row |

A cell whose text doesn't fit shows it whole as a tooltip.

### Columns

`o` (or a right-click on the header, or **columns** in the status line) opens the column configurator for the pane's resource type.

- It lists every server column, `-o wide` ones too (marked `wide`; the **-o wide** switch shows or hides them all at once).
- `space` shows or hides a column; drag & drop or `⌥↑`/`⌥↓` reorders.
- **Custom columns** take a field path (completed from the pane's live objects, one key at a time: `⏎` on a key with more below, such as `spec.`, goes on with its keys; `⌫` on that final `.` stops there, so `⏎` adds the key itself) or a CEL expression over `o` (keys with dots, such as labels, need CEL: `o.metadata.labels["app.kubernetes.io/name"]`). Each is typed as text, number, bytes or age. `⏎` in the add fields adds the column. An invalid expression is refused in the dialog.
- `⌫` removes a custom column from the list.
- `⏎` saves (in the add fields: once they're empty, e.g. right after adding a column). Columns belong to the **resource type** (`pods`, `deployments.apps`), in every context: every pane of that type follows at once.
- **reset columns** goes back to the server's defaults (so new server columns, e.g. after a CRD upgrade, show again).

In the table itself:

- **Sort:** a click on a header sorts by it (ascending, again for descending, a third time back to kubectl's order). Numbers sort as numbers, ages by time (youngest first), durations such as `5m` or `2d3h` by length; empty and `<unknown>` cells go last. The sort belongs to the pane (and its back/forward history), not to the type.
- **Move:** dragging a header moves its column (saved for the type).
- **Resize:** dragging a header edge resizes; a double-click fits the column to the visible rows. Widths are saved for the type; **reset widths** goes back to defaults.

Columns and widths are kept in `columns.yaml` across restarts. Changing columns keeps the watch and its diff state.

**Status colors.** Cells that tell a state color their text when it needs attention, like [kubecolor](https://github.com/kubecolor/kubecolor) does for kubectl, but only where the column means a state (`False` in READY, not in SUSPEND):

| Column | Orange (wait) | Red (broken) |
|---|---|---|
| STATUS, PHASE, CONDITION | `Pending`, `ContainerCreating`, `Init:0/2`, `Terminating`, `Unknown`, `NotReady`, `SchedulingDisabled`, `Released`, `Suspended`, `progressing` | `Failed`, `Error`, `CrashLoopBackOff`, `ImagePullBackOff`, `CreateContainerConfigError`, `OOMKilled`, `ExitCode:1`, `Evicted`, `Lost`, `Denied`, `unhealthy` |
| READY | fewer ready than expected (`1/2`, `0/1`: not for completed pods); `Unknown` | `False` |
| AVAILABLE, HEALTHY, APPLIED, SYNCED, ESTABLISHED, a shoot's APISERVER, CONTROL, NODES, SYSTEM, OBSERVABILITY | `Unknown`, `Progressing` | `False` |
| PROGRESSING | `True` | |
| LAST OPERATION (shoots) | `Processing`, `Pending` | `Error`, `Failed`, `Aborted` |
| TYPE (events) | `Warning` | |

- A list such as `Ready,SchedulingDisabled` takes its worst part.
- Only the text is colored: the background stays the [keyed diff's](#the-keyed-diff). A pod that just started crash-looping shows red text on the "changed" highlight. A deleted row stays struck through.
- Healthy states (`Running`, `True`, `2/2`) stay in the normal text color. A theme can color them too, with the `ok` token (see [Themes](#themes)); `warn` and `bad` are the orange and the red.

### Metrics: `m`, requests/limits: `⇧M`

`m` shows the CPU and memory usage of pods and nodes as columns, like `kubectl top`, and hides them again. `⇧M` does the same for what the pods on each node request and are limited to, like `kubectl describe node`. Like **-o wide**, it applies to the resource type: every pane of pods (or nodes) shows them, in every context, and they stay across restarts. They're off by default. The first time they're turned on, they're placed right after NAME, as narrow as their numbers. Moved and resized, they keep it: turned off and on again (`m` or the switch), they come back where they were, in their order and widths (right after NAME if the column they followed is hidden by then). Each group keeps its own place. The column configurator lists them marked `metrics` or `requests/limits`, with a **metrics** and a **requests/limits** switch that show or hide a group at once; they can also be shown, hidden and moved one by one.

| Kind | Columns |
|---|---|
| Pods | `CPU` (millicores, as `kubectl top`), `%CPU/R` and `%CPU/L` (of the pod's requests and limits), `MEM`, `%MEM/R`, `%MEM/L` |
| Nodes | `m`: `CPU`, `%CPU` (of the node's allocatable), `MEM`, `%MEM`. `⇧M`: `%CPU REQ`, `%CPU LIM`, `%MEM REQ`, `%MEM LIM`, `%EPH REQ`, `%EPH LIM` (ephemeral storage), what the pods on it request and are limited to, of its allocatable (kubectl describe node's "Allocated resources"); `PODS` and `%PODS`, the pods on it and their share of the pods it allows (a node with room left takes no more pods once that's full); `%<resource> REQ` for extended resources and huge pages (`%nvidia.com/gpu REQ`, `%hugepages-2Mi REQ`), offered only once a node of the context has some (their limits always equal their requests) |

- The usage comes from the cluster's metrics-server. It is read every 15 s, and only while a pane shows a usage column; panes on the same source share the reads.
- A pod's requests and limits are counted as the scheduler and kubectl count them: its containers summed, sidecars added, an init container as the larger of it and the rest (it runs alone), pod-level resources and the runtime's overhead included. A node's are the sum over its pods that haven't finished; a pod without a limit adds nothing to the limits, so they can be below what the node may really use (and above 100%: overcommitted).
- The nodes' requests and limits follow the pods live (one watch of the context's pods, while a pane shows such a column), and need no metrics-server. They're separate from `m` because they list every pod of the context first, which takes a few seconds on a big cluster: meanwhile the status line says **loading requests/limits…**. If the pods can't be listed (no permission across namespaces), the status line says why.
- Percentages are cut off, not rounded, as in kubectl. They sort as numbers, and grep matches them. A pod without metrics yet (pending, just started) has empty cells, sorted last. A percentage is empty if the pod sets no requests (or limits), or if the node has none of the resource (no ephemeral storage in its allocatable, a node without GPUs).
- New values don't count as a change: no marker, nothing recorded. In time travel the metric cells are empty, since past values aren't known.
- Without a metrics-server (or without permission to read it) the usage cells stay empty and the status line says so.
- Other resource types have no metrics: `m` says so.

**Events** get real timestamps: LAST SEEN and FIRST SEEN (`-o wide`) are taken from the event object as kubectl picks them, shown as ages that tick and sort by the exact time. An events pane starts sorted by LAST SEEN, newest first.

**Pods** show RESTARTS as kubectl does, `3 (5m ago)`. The "ago" ticks: it counts from the last restart of any of the pod's containers. The column sorts by the number of restarts and is marked changed only when the pod restarts again.

### Hide healthy

`h` (or the **hide healthy** checkbox in the pane header) hides what needs no attention:

| Kind | Healthy means |
|---|---|
| Pods | Running, every container ready (sidecars included; completed init containers ignored) |
| Deployments, StatefulSets | `observedGeneration` is current, and current, updated, ready and available replicas all equal `spec.replicas` |
| ReplicaSets | the same, without "updated" |
| DaemonSets | scheduled, updated, ready and available all equal desired; none misscheduled |
| Jobs | the `Complete` condition is True |
| Nodes | the `Ready` condition is True and the node isn't cordoned |
| PersistentVolumeClaims | Bound |
| ManagedResources (Gardener) | `observedGeneration` is current; `ResourcesApplied` and `ResourcesHealthy` are True, `ResourcesProgressing` is False |
| Gardener extension resources (`extensions.gardener.cloud`: Infrastructure, Worker, …) | `observedGeneration` is current and the last operation succeeded |
| Shoots, Seeds | `observedGeneration` is current, the last operation succeeded and every condition is True |
| Machines (`machine.sapcloud.io`) | Running |
| Etcds (`druid.gardener.cloud`) | ready |

Anything terminating stays visible. Other kinds have no checkbox; its tooltip says what it hides. It's evaluated live: an object that becomes healthy drops out, one that stops being healthy comes back.

What counts as healthy is configurable per kind, for your own resources too: see [`health.yaml`](#healthyaml).

### Selecting and copying

- **Text in a cell** selects as in a text field: double-click a word (a name, IP, image or `key=value` counts as one word), triple-click the whole cell, or drag over part of it. `⌘C` copies the selection. An age cell is always selected whole and copies its timestamp (`2026-01-01T10:00:00Z`), not `5m`. `Esc`, a click elsewhere or another row clears it; a live update to the cell drops it too (and `⌘C` then says so rather than copying something else).
- **`⌘C` without a selection** copies the selected row's name; with rows marked, their names, a line each.
- **`⌘⇧C`** copies any other cell: a picker (**copy cell(s)**) lists the whole row first (tab-separated, so it pastes into spreadsheet columns), then the row's columns with their values. `j`/`k` move (up from the first entry goes to the last, down from the last back to the first), `⏎` copies, `Esc` cancels. The column copied last is highlighted again, so `⌘⇧C ⏎` copies the same column of the next row. A right-click on a cell → **copy cell(s)…** highlights the cell clicked.
- **With rows marked**, `⌘⇧C` copies from all of them: the picker (**copy cells of 3 rows**) shows the first marked row's values with how many more follow (`web-0 … +2`), and copies the chosen column of every marked row, a line each, in table order. The whole row copies a tab-separated line per row, so they paste into spreadsheet rows.

A double-click doesn't open the YAML; `⏎` or `y` does.

### Marking rows

Some actions work on many rows at once: copy name, label, annotate, scale, rollout restart, delete, and debug container. Mark the rows first:

| Key | Marks |
|---|---|
| `⇧↓` / `⇧↑` (`⇧J` / `⇧K`) | from the anchor to the cursor, as the cursor moves; moving back towards the anchor unmarks again |
| `⇧PageDown` / `⇧PageUp`, `⌥⇧↑` / `⌥⇧↓` | a page, or up to the first / last row |
| `⇧`-click | from the anchor to the row clicked |
| `Space`, `⌘`-click | toggles one row; it becomes the anchor |
| `⌘A` | every row shown |
| `Esc` | clears the marks (after a cell's text selection) |

Marked rows have a blue tint and a bar on their left edge, and the status line counts them (**3 marked**). Only live rows that are shown can be marked: a mark goes away when a filter hides its row or the object is deleted, so an action never hits a row you can't see. Opening another resource or namespace starts with no marks.

With rows marked, the multi actions act on them, not on the cursor row (unless it's marked too); everything else (YAML, edit, describe, exec, jump …) stays on the cursor row. The row menu (`⌘⏎`) shows which: its header reads **3 marked · cursor on web-0**, the multi entries say how many they act on (**delete 3…**), the others name the cursor row. A multi action that fits only some of the marked rows (scale: workloads; rollout restart: deployments, stateful sets, daemon sets; debug: pods) skips the others and says so; if it fits none, the entry is disabled. A right-click on a row that isn't marked clears the marks first, so the menu is for that row alone.

- **Copy name** copies the names, a line each.
- **Copy cell(s)** (`⌘⇧C`) copies a column of every marked row, a line each, or the whole rows (see [Selecting and copying](#selecting-and-copying)).
- **Label / annotate**: one dialog for all. It lists every key of the marked rows, with how many rows have it (`app=web 3/3`) and its value if they all share it (else how many values). The changes go to each row. Setting a key to the value all rows already have is no change. A key that differs, or that only some rows have, can be set or removed (`key-`).
- **Scale**: one number for all, each row's current replicas listed.
- **Rollout restart**: always confirmed, listing the workloads.
- **Delete**: always confirmed, listing the objects.
- **Logs**: one tail over the pods of every marked row (see [Logs](#12-logs)).
- **Debug container**: one dialog for all pods, at most 8. The target is empty for each pod's own default container, `-` for none, or a container every marked pod has. Each pod gets its debug container in a pane of its own, all in a new tab named **debug ×N**, stacked one below the other (more than 3: in two columns).

Each object still gets its own safety check, its UID precondition and its own request (at most 8 at once). The confirmation, if the context's rule asks for one, is one for all, and names the objects. With a `strict` rule you type the number of objects instead of a name, and a delete of more than 20 objects always asks for their number. Afterwards the status line says how many went through and names the first failures (`deleted 4 of 5 objects — web-2: forbidden`). The marks stay, so the failed rows can be retried; after a delete that removed every marked row, they're cleared.

---

## 4. Filtering

The filter bar in each pane's header has three fields: grep (`/`), label selector and CEL. `/` lands in grep, `⇥` moves on to the label selector and CEL (`⇧⇥` back); the fields can also be clicked, or reached from the menu bar (**View → Filter by Labels / Filter by CEL**).

Filter changes keep the watch and the diff state. `⏎` and `Esc` go back to the table from any of the three fields.

### Grep: `/`

Matches the rendered row text, applied as you type, fzf-style:

| Syntax | Meaning |
|---|---|
| `etcd main` | rows containing both terms |
| `!x` | rows not containing `x` |
| `^x` / `x$` | a cell starts / ends with `x` (`^Running$`: exactly) |
| `a \| b` | either (`etcd pending \| ^crash`: etcd, and one of the other two) |
| `"a b"` | one term with a space |
| `\!` `\^` `\$` `\|` | literal characters |

A negated term or an alternative after `|` applies once it's finished (a following space, `⏎`, or leaving the field), so the table doesn't blank and refill while you type `!c`, `!co`, … `Esc` restores the grep the field had when it got focus. Matches are highlighted in the cells. Age columns are matched as timestamps (and not highlighted).

### Label selector

Kubernetes' syntax, sent to the API server (so it narrows what's loaded):

| Example | Meaning |
|---|---|
| `app=web`, `app!=web` | equals / not equals |
| `env in (prod, staging)` | one of |
| `env notin (dev)` | none of (also objects without `env`) |
| `env`, `!env` | has / doesn't have the label |
| `app=web, env in (prod, staging)` | commas AND |

### CEL

A [CEL](https://cel.dev) expression over the object `o`, for what a selector can't express. It runs in kubewing on the loaded objects, so narrow with the label selector first on big sources.

```
o.metadata.labels.app == "web" || o.metadata.labels.tier == "db"
o.metadata.labels.app.startsWith("web-")
o.metadata.name.matches("^web-[0-9]+$")
o.status.containerStatuses.exists(c, c.restartCount > 3)
o.metadata.annotations["example.com/owner"] == "team-a"
```

A missing field simply doesn't match (lists mix shapes); other evaluation errors show in the status line. `↑` in an empty CEL field recalls recent filters for the resource type.

### Drafts and completion (labels and CEL)

Label selectors and CEL are **drafts until `⏎`**, since a half-typed value (`app=et`) would match nothing. While you type, the table stays as it is and the field shows what the draft would give (`→ 2 / 3`; `≥` when a wider selector may match objects not loaded yet), or why it can't apply (a parse error with a caret, "not a bool"). `⏎` or leaving the field applies; an invalid draft stays, red, with the reason as tooltip. Empty + `⏎` clears. `Esc` drops the draft.

Both fields complete as you type, and `↓` opens the list anywhere (in an empty field: what can start it). `⇥` completes; `Esc` closes the list, a second `Esc` leaves the field.

- **CEL** completes field paths from the pane's live objects (`o.status.` → the keys found there, with type and how many objects have them), also inside `exists(c, c.…)`. A key that isn't an identifier goes in as `["app.kubernetes.io/name"]`; typing `["` completes keys too. After a field and a space it offers the operators that fit its type (strings get `==`, `!=`, `in […]` and comparisons, which also order RFC 3339 timestamps; bools `&&`/`||`). Common functions complete too.
- **Labels** complete label keys (with counts), then operators, then a key's values (most common first). Keys and values come from the objects matching the selector's *other* requirements, not the applied selector: with `app=web` applied, `app=` still offers every app.

### Filtering from the YAML

In an object's YAML view, `=` on a line filters the pane by that field's value and `!` by "not this value" (objects without the field included). Fields inside lists become `exists()`.

---

## 5. Watching changes

### The keyed diff

The table marks what changed since it opened, keyed by object UID, not by screen position (so re-sorting never shows bogus changes):

- **changed cells** are highlighted,
- **added** and **deleted** rows are marked (a delete and recreate under the same name is a removal plus an addition),
- **"changed, not visible"** marks a row whose object changed outside the shown columns.

AGE never counts as a change. Noise is ignored: `resourceVersion`, `managedFields`, heartbeats (`lastHeartbeatTime`, lease renewals) and no-op relists. Add your own ignore rules in `config.yaml` (`diff.ignore`).

### Record changes

By default each view only keeps an object's previous version, enough for "what changed last". **Record changes** (the status line's **⏸︎ record changes**, or `⇧R` in the table) keeps every version of every object of the source, so you can step through versions and travel back in time.

- It belongs to the source: all panes on that source follow; stopping drops the history.
- It's off by default because it costs CPU per event.
- History is kept in memory within a global budget (`history.budget`, default 512Mi). Past it, the oldest changes go first, across all objects, so every object reaches back equally far. The timeline shows the source's history size against the budget.

With history recorded, the row menu's diff entry says how many changes there are to step through ("diff changes (7)").

---

## 6. Time travel

`t` in the table shows the pane **as it was**, at the newest change (recording starts if it was off; the timeline begins then).

The status line becomes a **timeline**: the recorded span, a tick per change of the pane's rows, and the moment shown. The header turns accent and shows **⏸ 12:03:14**.

| Key | Action |
|---|---|
| `←` / `→` | previous / next change |
| `⇧←` / `⇧→` | one minute back / forward |
| `Home` | start of the recording |
| `t`, `Esc`, `End` | back to live (also a click on the header badge) |

A click on the timeline goes to that moment.

- Every row is the object **as it was** then: deleted ones are back, later ones are hidden. Filters, sort and columns apply to the past objects; the cells a step changed are marked. Ages count from the moment shown and don't tick.
- Live changes keep arriving meanwhile, counted as "+n since", so going back is instant.
- The detail view shows the version current at that moment, diffed against the one before, with the timeline at its bottom.
- Each pane has its own moment.

### When did this field change? `⇧H`

`⇧H` on a line of the YAML (or the diff's right side; also **history of this field** in the right-click menu) lists the field's values over time. `⏎` on a value takes the table to that moment; `Esc` goes back to the YAML. The YAML header says when history is available.

---

## 7. Looking at an object

### YAML view

`⏎` (or `y`) shows the row's YAML in place of the table, in a read-only editor. It's a step in the pane's history: `Esc` goes back to the table, with its row and scroll as they were (`⌘→` there comes forward again).

`⇧⏎` opens the YAML **in a split to the right** instead, to compare (another `⇧⏎` from the table adds another one). `Esc` at its top closes it.

- A split is pinned to its object. Its **follow** checkbox makes it show whichever row is selected in its table.
- It shares the table's watch, so it stays and keeps updating when the table closes or shows something else (following then stops; the header says why).

In the object view: `⌘F` finds, `w` toggles wrapping of long lines (on by default; holds for the session). The cursor moves as in VS Code: `⌥←`/`⌥→` a word (`⇧` selects), `⌘←`/`⌘→` start/end of line, and `⌃←`/`⌃→` fold/unfold the section at the cursor (in the editor too). A held `Esc` (key repeat) stops at the top of an object view; only a fresh press leaves it.

### Who set this? `b`

`b` in the YAML view shows **who set each line**, like [kubectl-blame](https://github.com/knight42/kubectl-blame): beside the YAML, in place of the line numbers, the field manager that owns the field there and how long ago it last wrote (`kube-controller-manager 3d`, `helm 5h`). It's dimmed and read-only, only there to look at.

- `b` again turns it off. It holds for the session: on, it shows for every object and in the editor too.
- Hover a name for every manager owning that field, each with its operation (Apply or Update), subresource (`status`, `scale`) and time. `+1` after a name means one more owner.
- Blank lines have no owner of their own: a map such as `spec:` that nobody set as a whole, or a field the server defaulted.
- It reads the object's `managedFields` fresh from the API server. The YAML still doesn't show them (they're noise everywhere else). An object without any says so in the header.
- In the editor `⌘B` toggles it (`b` is text there). It follows what you type: owners stay with their lines, a line you add has none until it's applied, and once applied the fields you changed are `kubewing`'s. While the YAML doesn't parse (mid-typing), the names are blank and the header says why.
- It shows the object as it is now, also in a pane showing the past (time travel).

### Object diff: `d`

`d` in the YAML view (or **diff** in the row menu) shows a side-by-side diff of the previous vs. current object (normalized as for the table), following new versions as they come in.

- `j` / `k` (or the `↓` / `↑` buttons) jump to the next / previous change, wrapping around; the header shows which (`2 / 5`). The diff opens on the first.
- With **record changes** on, `[` / `]` (or `‹` / `›`) step to older / newer versions; the header shows which two are compared and when they were seen, and the changed fields are listed above the diff as paths:

  ```
  spec.containers[name=app].image: "web:1" → "web:2"
  ```

### Describe: `⇧D`

`⇧D` in the YAML view runs `kubectl describe` (with events); in the table `d` describes in place and `⇧D` in a split to the right. (In the YAML view `d` is the diff toggle, so describe keeps `⇧D` there.)

In the describe view:

- `r` re-runs describe.
- `d` diffs it against your previous look at the same object (this session). Unlike the object diff it shows what describe adds (events, counts). Relative times (event ages, heartbeats, lease renewals) are blanked and tables re-aligned, so only real changes show. It compares looks, not the watch history: changes between two looks are summed up.

---

## 8. Decoding values

`⏎` on a line of the YAML (or **decode value** in the right-click menu) decodes the field's value in place of the object view.

**Encodings** are detected one after the other, each feeding the next:

- **base64** (standard or URL alphabet, padded or not). It's kept only when the result is text, gzip or brotli, so a plain word like `admin123` isn't "decoded". A Secret's `data` and a ConfigMap's `binaryData` always decode.
- **gzip**, **brotli** (a managed resource's `data.yaml.br` is `base64 → brotli → yaml`). Decompression is capped at 16 MiB.

**Renderings** of the result:

| Content | Shown as |
|---|---|
| JWT | header and claims; `exp`, `iat`, `nbf`, `auth_time` annotated as times (`# in 3h`), expired ones marked; the signature isn't verified |
| Certificate (PEM) | subject, issuer, SANs, validity, usages, public key and its SHA-256, serial, fingerprint; bundles block by block; CSRs |
| Private / public key | type, size or curve, encoding, public-key SHA-256, and which certificate in the same object it matches (or MISMATCH) |
| JSON | as JSON, indented if it's on one line; colored, foldable |
| YAML | as YAML; colored, foldable |
| Text | as text |
| Binary | hex dump of the first KiB |

Navigating:

- The header shows where you are (`api-0 › data["data.yaml.br"] › doc 2: data.kubeconfig`); a click on a level goes back up to it.
- The **chain** is shown above the value (`base64 → brotli → yaml · 14.2 KiB`). A click on a step leaves it and what follows out (the raw brotli bytes, the PEM text); **↺ auto** detects again.
- `⏎` in decoded YAML or JSON goes a level **deeper** (multi-document YAML too: secret → manifests → kubeconfig → `certificate-authority-data` → certificate). `Esc` goes up a level, and finally back to the YAML with its cursor where it was.
- `⇧⏎` opens the decoded level in a split of its own, to compare.
- `⌘A` `⌘C` copies the text.
- In the object diff, `⏎` decodes the field in **both versions** and diffs those (a managed resource's change as YAML, not one blob against another); `[`/`]` step versions.

Nothing to decode on a line (a map, a number, plain text) says why in the status line. Decoded text is never kept: each view decodes from the object again.

---

## 9. Editing

`e` on a row (or in its YAML view; `⇧E` opens the editor in a split to the right) edits the object, as `kubectl edit` does:

1. The object is read **fresh from the API server** (not the watch) into an editable editor. Opened from the YAML view (or its diff), the cursor stays on the line it was on, at the same height on screen.
2. `⌘S` (or `⌘⏎`) checks the edit and has the server **dry-run** it, then shows a side-by-side diff of the object now vs. as the server would store it (defaults and admission webhooks applied). `j`/`k` step through the changes.
3. `⏎` writes it; `Esc` goes back to editing, with the cursor where it was.

What's sent:

- Only what changed (a JSON merge patch, field manager `kubewing`).
- With the opened `resourceVersion` as a precondition: if anyone changed the object since you opened it, the write is refused as a conflict instead of overwriting their change.
- apiVersion, kind, name, namespace and uid can't change (that would be another object).

Anything refused (invalid YAML, a webhook, a conflict, "no changes") shows below the editor with your text kept.

The editor is **modal**: keys go to the editor (`⌘D` deletes the line, `⌥↑`/`⌥↓` move it, `⌥⇧↑`/`⌥⇧↓` copy it, `⌘[`/`⌘]` indent, `⌥←`/`⌥→` a word, `⌃←`/`⌃→` fold/unfold). Only `Esc`, `⌘S`, `⌘⏎`, `⌘E`, `⌘J` and `⌘B` reach the app, plus the keys that move focus to another pane or tab, and `⌘⇧⏎` to maximize the pane. An edit left that way stays in its pane, marked **● unsaved**, and closing that pane or tab asks first. `Esc` with changes asks once; a second `Esc` discards them.

`⌘B` shows who set each line beside the text, as `b` does in the YAML view (see [Who set this?](#who-set-this-b)).

Read-only contexts refuse `e` before the editor opens. `confirm: [edit]` in a context rule asks after the preview.

### Editing decoded values: `⌘E`

`⌘E` in the editor (or **edit decoded value** in its right-click menu) decodes the value at the cursor, as `⏎` does in the YAML view (see [Decoding values](#8-decoding-values)), and opens it for editing in place of the object. When you're done, it's encoded back the way it was encoded, so a secret's password, a managed resource's brotli manifests or a kubeconfig inside them can be edited as text.

- The header shows the levels (`object › data["data.yaml.br"] › doc 2: data.kubeconfig`) and how the value is encoded (`base64 → brotli → yaml`), with **changed** once you've edited it.
- `⌘E` in decoded YAML or JSON goes a level **deeper**.
- `Esc` goes **up** a level and keeps your changes: the value is encoded back into the level above (or the object). That's one edit there, so `⌘Z` takes it back. A click on a level in the header goes up to it the same way.
- `⌘S` / `⌘⏎` encodes every level back into the object and previews the edit as usual (the preview shows the encoded value).
- `e` in a decoded value (the YAML view's `⏎`) opens the editor at that value.

What you edit:

- Text, YAML, and certificates and keys as their PEM text.
- JSON that was on one line is shown indented and written back on one line again.
- A YAML or JSON value that isn't encoded (a config map's `config.yaml: |`) can be edited this way too, with YAML or JSON colors; it's written back as a block (`|`).
- The encoding stays as it was: base64's alphabet, padding, line wrapping and final line break; gzip and brotli are compressed again. A value you didn't change keeps its exact bytes.
- Only that value changes in the text above: its other lines, comments and formatting stay.

Binary values and JWTs (whose signature an edit would break) can't be edited decoded; the status line says why. If an edited value can't be encoded (JSON that no longer parses), you stay on its level, with why below the editor.

---

## 10. Navigating between resources

### Jump menu: `⌘J`

`⌘J` on a row (also in its YAML view, or **jump to…** in the row menu) lists where it leads. From the YAML, what the field at the cursor refers to comes first (see [Jumping from a field](#jumping-from-a-field-in-the-yaml)).

| Section | Entries |
|---|---|
| **clusters** | on a garden's Gardener rows (see below): a shoot → "shoot bar" and "control plane of bar"; a seed → "seed soil"; a managed seed → its seed and the control plane of its shoot |
| **namespace** | "pods in shop" (the same resource narrowed to the row's namespace, filters kept; from an all-namespaces pane), "namespace object shop", "everything in shop" (every type, see [`all`](#everything-in-a-namespace-all)); a namespace row has "everything in" it too |
| **owners** | the `ownerReferences` chain up (pod → replica set → deployment, and on through Gardener and other CRD owners); each checked by UID, so a deleted or recreated owner is listed disabled with why |
| **owned** | what the row runs, counted: deployments → replica sets and pods; replica sets, stateful sets, daemon sets, jobs → pods; cron jobs → jobs; nodes → their pods; namespaces → their pods; a custom resource with a scale subresource → the pods its selector selects. **scan for owned…** finds anything else (e.g. a CRD owning config maps) by listing every resource type's metadata in the namespace; it runs only on request |
| **references** | pod → the claims its volumes use, each followed by its bound volume, and their volume attachments; stateful set → its claims (every ordinal, so claims left by a scale-down count too), their volumes and attachments; claim → volume ("not bound" while pending) → attachments; volume → claim and attachments; volume attachment → volume and node. Then every other object the row names in a field (see [Jumping from a field](#jumping-from-a-field-in-the-yaml)): a pod's node, service account, secrets and config maps, a binding's role, a shoot's seed … Each is looked up: one that doesn't exist is listed as **missing**; the same object named in several fields is listed once, with how often (`secret db 2×`) |
| **events** | the row's events (see below) |

Each entry starts with its resource type (**replicaset** web-7d4, **pods** in shop, **seed** soil), set apart from the name in the same color as the resource in a pane's header.

`j`/`k` move (wrapping around), `⏎` jumps in place, `⇧⏎` opens the target in a split below, `Esc` closes.

**Clusters of a shoot or seed.** In a pane on a garden, `⌘J` on a shoot, seed or managed seed row lists its clusters first, highlighted, each with the context name it will get (and its safety label). It opens like a pick in `⌘⇧O` (see [Opening a cluster](#opening-a-cluster-o)): with nothing listed and `⌘O` over it, the shoot in all namespaces, the control plane in the shoot's namespace on its seed, a seed in all namespaces.

- `⏎` opens it in the pane (`⌘←` goes back to the rows), `⇧⏎` in a split below, `⌘⏎` in a new tab.
- Only picking an entry looks it up in the garden, which may ask you to log in; the entry says **resolving…** meanwhile. An error (no access, a seed without a login secret) shows on the entry, and the menu stays open.
- The garden is one of gardenctl's (see [Gardener targets](#opening-a-cluster-o)): opened with `⌘⇧O`, or from any kubeconfig whose context points at the same API server.
- `⌥⌘O` switches a shoot or control plane opened this way, as one opened with `⌘⇧O`. Opened clusters are remembered in `⌘⇧O`'s list.

### Jumping from a field in the YAML

In an object's YAML view, values that name another object are underlined: `secretName: certs`, `claimName: data`, `serviceAccountName: web`, a binding's `roleRef`, a shoot's `seedName`, an owner reference.

- `⌘`-click on one jumps there (the pointer turns into a hand while `⌘` is held); `⇧⌘`-click opens it in a split below. A missing object says so in the status line instead.
- `⌘J` lists what the field at the cursor refers to first, under **at the cursor**, highlighted, above the rest of the menu. On a value, that one object; on a list item (a volume, a container, an `env` entry) or a section (`volumes:`), everything in it. On a line without a reference the menu is as from the table.
- In the object diff, the right side (the newer version) works the same.
- In the editor, `⌘J` and `⌘`-click work on the text as typed, and always open in a split to the right, so the edit stays beside it. The marks follow the text a moment after typing.

What counts as a reference is a set of built-in rules, which `refs.yaml` extends (see [Configuration](#refsyaml)):

| Where | Refers to |
|---|---|
| pod specs (pods, workload templates, cron jobs, any custom resource embedding one) | secrets and config maps of volumes (projected too), `env`/`envFrom`, image pull secrets; claims; service account, node, priority class, runtime class |
| storage | claim → volume, storage class; volume → claim, storage class, CSI secrets; volume attachment → volume, node |
| network | ingress → backend services, TLS secrets, ingress class; endpoints and endpoint slices → their target pods |
| RBAC | role bindings and cluster role bindings → role or cluster role, service account subjects |
| object references | owner references, HPA and VPA targets, an event's object, webhooks' and API services' services, a CRD's conversion webhook service |
| Gardener | shoot → seed, secret binding, credentials binding, cloud profile, exposure class, DNS secrets, resource references; credentials binding → its credentials; managed resource → its secrets |
| by convention | `secretRef` and `*SecretRef` fields anywhere → a secret (in the field's `namespace`, if it has one) |

A referenced object is in the referring object's namespace unless the field names one; cluster-scoped kinds (nodes, volumes, cluster roles …) have none. A kind the cluster doesn't serve is listed as **unknown kind**.

A jump is an ordinary pane: the target is a source plus filters (`o.metadata.name == "web"`, an owner-UID filter, a label or field selector; a field selector shows as a chip in the header). So the filter bar shows why the pane holds what it holds, and clearing the filter shows the siblings.

The jump menu reads metadata only: it works on read-only contexts and on deleted rows (their last state).

### Events of a row: `v`

`v` (also in the YAML view, or **events** in the row menu or the jump menu) turns the pane into the events about that object: `events` with a field selector like `involvedObject.kind=Pod,involvedObject.name=web-0`, in the object's namespace (all namespaces for cluster-scoped objects). `⇧V` opens them in a split to the right instead, the row (or object) staying as it is. Matched by kind and name, as `kubectl describe` does. It's a live watch, so new events show up as they happen. It works on deleted rows too (events outlive their object for a while), and on objects without events yet (to wait for them).

### Back and forward: `⌘←` / `⌘→`

Each pane keeps a history, as a browser does. Jumps and `⌘O` to a new source are steps; filter edits belong to the view they're on and come back with it.

- `⌘←` goes back, `⌘→` forward, each time with the row that view had selected. (In the YAML view, the editor and text fields they stay start/end of line: `Esc` leaves the YAML view first.)
- The header's `←` / `→` buttons do the same; holding one (or a right-click) lists that history, nearest first, with its filters. `j`/`k` move, `⏎` or a click goes there at once.
- A new jump or `⌘O` after going back drops the forward history. Splits and new tabs start without history.

---

## 11. Row actions

### The row menu: `⌘⏎`

`⌘⏎` or a right-click on a row lists every operation on it, with its shortcut from the live keymap. The entries come in groups: viewing and copying (YAML, edit, describe, events, diff, copy, jump to), then shells, port-forward and logs, then changes (label, annotate, scale, rollout restart), and delete last. Unavailable entries say why ("needs a pod", "read-only context", "no change seen yet"). `j`/`k` move (wrapping around), `⏎` runs, `Esc` closes. View YAML, edit YAML, describe and events show their split key too (`⇧⏎`, `⇧E`, `⇧D`, `⇧V`), and `⇧⏎` on the entry runs the split variant.

| Key | Action |
|---|---|
| `⏎` / `y` | view YAML (`⇧⏎` in a split) |
| `e` | edit YAML (`⇧E` in a split) |
| `d` | describe (`⇧D` in a split) |
| — | diff (row menu; `d` in the YAML view) |
| `⌘C` / `⌘⇧C` | copy name / copy cell(s)… |
| `⌘J` | jump to… |
| `v` | events (`⇧V` in a split) |
| `l` | logs… (`⌥L` for the whole pane) |
| `x` | exec shell |
| `b` | debug container… |
| `n` | node shell… |
| `f` | port-forward… |
| `⇧L` | label… |
| `⇧A` | annotate… |
| `s` | scale… (the entry shows the current replicas) |
| `r` | rollout restart… |
| `⌘⌫` / `Del` | delete… |

With rows marked, copy name, copy cell(s), label, annotate, scale, rollout restart, delete and debug act on them (see [Marking rows](#marking-rows)).

### Label, annotate

`⇧L` labels the row's object, `⇧A` annotates it, as `kubectl label` / `kubectl annotate --overwrite` do. The dialog lists the current labels (or annotations) and takes changes in kubectl's syntax, separated by spaces:

- `key=value` sets a key (a new one, or a new value), `key-` removes one. `env=prod tier=front app-` does all three.
- Annotation values with spaces go in quotes: `note="drained, back at 14:00"`. Label values can't have spaces (Kubernetes' rule).
- The list previews what the text does: `+` added, `~` changed (old value struck through), `−` removed. A click on a key takes it into the field with its value, to change it.
- `↓` lists the last 20 labels (or annotations) you set, newest first, ranked by what you type. `⏎`, `⇥` or a click puts the highlighted one in place of the word at the cursor, so you can keep going with `↓` for the next. Keys already in your text aren't listed, and the list says how a value compares with the object's (`already set`, `now dev`). ✕ forgets one, `Esc` closes the list. Only changes that were applied are remembered (in `history.yaml`), not removals.

`⏎` applies, `Esc` cancels. Anything refused (an invalid key or value, a removed key that isn't set, a webhook) stays in the dialog with your text kept. Only the keys given are sent, with the object's UID, so a recreated object with the same name is never hit.

### Scale

`s` scales a workload (deployment, stateful set, replica set, a custom resource with a scale subresource), as `kubectl scale --replicas` does. The dialog is prefilled with the current replicas, selected, so typing replaces them. Rows without replicas have the entry disabled.

### Rollout restart

`r` restarts a deployment, stateful set or daemon set, as `kubectl rollout restart` does: it stamps the pod template with the current time (the `kubectl.kubernetes.io/restartedAt` annotation), so the workload replaces its pods one by one, following its update strategy. It always asks first, since every pod is replaced. A paused deployment can't be restarted (resume it first), and other kinds have the entry disabled.

### Delete

`⌘⌫` or `Del` deletes the row's object, always after a confirmation. It's sent with a UID precondition, so a recreated object with the same name is never hit.

---

## 12. Logs

kubewing has a stern-like multi-pod log tail.

### Starting a tail

- `l` on a row follows its pods: a pod row follows that pod (by name, so a recreated StatefulSet pod carries on); a workload, node or namespace row follows all of its pods, keeping up as pods come and go.
- `l` with rows marked follows the pods of all marked rows together, in one tail: marked pods by name, marked workloads, nodes or namespaces with all their pods. A pod that two marked rows cover (a deployment and one of its pods) is followed once. Rows without pods (a config map) are skipped, and the dialog names them. At most 20 marked workloads, nodes or namespaces at once (any number of pods).
- `⌥L` (or **logs of pane**) follows every pod the pods pane currently shows, with its namespace, selectors, grep and CEL applied (a snapshot: later edits to the pane don't change it).

A dialog asks first: which containers (all checked), how much history per container (the last lines, `100` by default from `logs.tail`; since a duration like `10m` or `1h30m`; or `all`), follow (on), previous (off) and timestamps (off). `⏎` starts from anywhere in it, so `⌘L ⏎` takes the defaults. Without follow, each container's log is read once and the tail ends.

**Previous instance** (`⌘P` in the dialog, from any field): shows the logs of each container's previous, terminated instance, like `kubectl logs -p`. Use it for a container that crashed or was restarted (a crash-looping container's last run, an `OOMKilled` one). Those logs don't grow, so they're read once and follow is off; the history choice still applies. A container that has never restarted shows **— no previous instance —**. The status line says **previous instance**.

The log pane opens below.

**A pane per pod.** When the tail covers several pods (a workload, marked rows, the whole pane), the dialog also offers **a pane per pod**: each pod gets a log pane of its own, with the same options, stacked one below the other under the pane (it keeps half its height, the log panes share the rest). **in a new tab** puts them in a tab of their own instead, named **logs ×N**. It takes the pods there are when the tail starts, up to 8; a pod that appears later gets no pane. Each pane follows its pod by name, so a recreated StatefulSet pod carries on.

- Each line is prefixed with what tells it apart, colored per pod: `pod/container`, just the container when all lines come from one pod, just the pod when every pod has a single container of the same name, nothing for a single container.
- Up to `logs.maxStreams` (default 50) containers are followed at once; the rest are listed as "not followed (limit)".
- Pods that appear later start from their beginning, as stern does.

### In the log pane

| Key | Action |
|---|---|
| `/` | live filter: fzf-like as the table's grep, matched against pod, container and text; hides non-matching lines (past ones too) and highlights matches; `⏎` or `Esc` goes back to the lines |
| `t` | RFC 3339 timestamps on / off |
| `⌘K` | clear the buffer (kept to `logs.buffer` lines, default 50 000) |
| `⌘F` | find (next/previous, case, whole word, regex) in the lines shown, also straight from the filter field |
| `↑` / `↓`, `PgUp` / `PgDn` | scroll a line / a page |
| `Home` / `End`, `⌥↑` / `⌥↓` | first / latest line |
| `⏎` | back to the latest line |
| `⌃D` / `⌃⇧D` | close the pane |

With `terminal.copyOnSelect: true`, selecting text with the mouse copies it as you release the button (see [Shells](#13-shells-exec-debug-containers-node-shells-local-terminals)).

Scrolled up, new lines don't move the view. The status line shows **following** (green) while lines stream in, **not following** (grey) once nothing is followed (**previous instance** for a tail of the previous instances), then shown/total lines, container and pod counts, any dropped or limited streams, and whether **timestamps** are on or off with the key that toggles them (`t`).

---

## 13. Shells: exec, debug containers, node shells, local terminals

All shells open in a terminal pane below the table (a local terminal to the right with `⌃⇧T`). Every key goes to the shell except `⌘` chords, `⌃⇥` and `⌃⇧D`. `⌃D` or `exit` ends the shell and the pane goes with it; `⌃⇧D` closes the pane of a shell that won't end.

`⌘F` finds in the output and scrollback: matches highlight as you type, `⏎`/`⇧⏎` or `⌘G`/`⌘⇧G` step, `⌥⌘C` / `⌥⌘W` / `⌥⌘R` toggle case, whole word and regex, `Esc` closes back to the prompt.

**Copy on select** (`terminal.copyOnSelect: true` in `config.yaml`, off by default): selecting text with the mouse copies it when you release the button, as in many terminal apps: drag over it, double-click a word or triple-click a line. Without it, `⌘C` copies the selection. It works the same in log panes. Find's highlighted match doesn't count as a selection, so searching leaves the clipboard alone.

A session that never started, or a shell that exits non-zero before your first keystroke, keeps its pane so the reason stays readable.

### Exec: `x`

Execs into a pod (bash, else sh). With more than one container, `x` asks which one: the pod's containers, then init, sidecar and ephemeral ones, each with its state (not running ones are listed but skipped). The default (`kubectl.kubernetes.io/default-container`, else the first) is highlighted, so `x ⏎` enters it. A pod with a single container goes straight to its shell.

### Debug container: `b`

Starts an ephemeral debug container in the pod, as `kubectl debug -it` does. The dialog asks for:

- the **image**: prefilled from `debug.image`, else the last one that started; `↓` lists the configured one and the last 10 (✕ on a history entry forgets it),
- the **target** container whose processes it shares (the pod's default; empty = none),
- the **profile**: `general`, `baseline`, `restricted`, `netadmin` (for tcpdump), `sysadmin` (privileged); default from `debug.profile`.

`⏎` on a highlighted suggestion only takes it into the field; the next `⏎` starts. Until the container runs, the pane shows its waiting state and the kubelet's events (`Pulling image …`); a container that can't start keeps its pane with the reason. As with `kubectl debug`, the ephemeral container stays in the pod (terminated) until the pod is gone.

With pods marked, `b` starts a debug container in each, a pane each in a new tab (see [Marking rows](#marking-rows)).

### Node shell: `n`

A privileged pod on a node, like ops-toolbelt's `hacks/ops-pod`. `n` in a table, **node shell…** in the row menu of a node or pod, or **Object → Node Shell…** in the menu bar (also from a terminal pane).

- The **node** is prefilled from the selected row (the node, or the node a pod runs on). Typing or `↓` lists the context's nodes with pool, zone and state (not ready, cordoned); `⏎` takes the prefilled one.
- The **image** shares its history with debug containers (default `opsPod.image`).
- The **namespace** completes from the context's namespaces (empty = `default`). Note that PodSecurity's `baseline` (as on `default`) rejects such pods; use e.g. `kube-system`.
- Checkboxes: **chroot** into `/host` (the shell runs on the node; implies host root), **host root** (the node's `/` at `/host`), **host network**. Host root and host network are on by default.
- Optionally a **persistent volume** is mounted (default at `/pv`). Only bound volumes can be picked, since a pod mounts a volume through its claim; the pod then runs in the claim's namespace.
- **show YAML…** shows the pod kubewing would create, editable. Edited, that YAML is what starts (it must stay a `v1` Pod on the chosen node with the `ops-pod` container); `⌘⏎` starts it, `Esc` goes back to the form.

The namespace and checkboxes of the last pod that started are remembered across restarts. The pod is named `ops-pod-kubewing-<user>-<hex>`, privileged with host PID, bound to the node via `nodeName` (so cordoned and tainted nodes work), and labelled `app=opspod`. **It's deleted when the shell ends, the pane is closed or the app quits.**

### Local terminal: `⌃T` / `⌃⇧T`

A shell on your Mac, on the cluster the focused pane shows: `⌃T` opens it in a split below, `⌃⇧T` to the right. Use it to run `kubectl`, `helm`, `stern`, scripts or anything else against the cluster you're looking at, without targeting it by hand.

- It's your login shell (`$SHELL -l`, like a new Terminal tab), starting in your home directory, so your profile's `PATH`, aliases and prompt are there even when kubewing was started from the Dock.
- `$KUBECONFIG` points at a kubeconfig of the shell's own: its current context is the pane's, in the pane's namespace (with all namespaces, the context's own). `kubectl get pods` lists what the pane lists.
- That kubeconfig is a small file in front of your usual kubeconfig files, holding only the current context. Credentials aren't copied, and `kubectl config use-context` or `kubens` in the shell change only this shell, not `~/.kube/config` or other terminals. A Gardener cluster opened with `⌘⇧O` has no kubeconfig file, so its kubeconfig is written in full. The file is removed when the shell ends.
- **gardenctl** is targeted too: on a Gardener cluster the shell's gardenctl target is the pane's, so `gardenctl provider-env zsh`, `gardenctl ssh` or `gardenctl kubectl-env zsh` work right away. A shoot is targeted as the shoot, a control plane as the control plane, a seed as the seed (a shoot's namespace on it: that shoot's control plane), and a garden with the project of the pane's namespace. This works for clusters opened with `⌘⇧O` or `⌘J`, gardenctl's kubeconfigs and a garden's own kubeconfig. Every terminal has a gardenctl session of its own (`$GCTL_SESSION_ID`), so `gardenctl target` in it moves neither the terminal kubewing was launched from nor other kubewing terminals. The session is removed when the shell ends.
- It works from tables, YAML and describe views, log panes and ended shells. Inside a running shell `⌃T` is the shell's own key (transpose, fzf's file picker); move to another pane first (`⌥⌘` arrows).
- The header says **terminal**, with the context and namespace. `exit` or `⌃D` ends it, and the pane goes with it.
- The shell has `$TERM_PROGRAM` set to `kubewing`. A profile that sets `KUBECONFIG` itself (e.g. `eval $(gardenctl kubectl-env zsh)`) replaces kubewing's; skip that part when `[[ $TERM_PROGRAM == kubewing ]]`.

A shell holds the context's credentials, and kubewing can't check what it runs. So a read-only context refuses it, and `confirm: [terminal]` in a safety rule asks before it opens (see [Safety](#16-safety)).

#### Why not `kubectl debug node`?

`kubectl debug node/<n> -it --image=…` creates almost the same pod, and on a generic cluster the two are interchangeable. The differences matter on Gardener:

- **Tolerates every taint.** `NoExecute` taints are enforced even for pods bound via `nodeName`, so on a Gardener etcd pool (`pool.worker.gardener.cloud/dedicated-for=etcd:NoExecute`) a `kubectl debug node` pod gets evicted; the node shell stays.
- **Reaches the seed API server** (`networking.gardener.cloud/to-seed-apiserver: allowed`), which network policies would otherwise block.
- **No istio sidecar** (`sidecar.istio.io/inject: "false"`).
- **Cleans up after itself**; `kubectl debug node` leaves the pod behind.
- **`priorityClassName`** (e.g. `system-cluster-critical`, to land on a full node) is offered as a commented line in **show YAML…**.

---

## 14. Port-forwarding

`f` on a pod or a service forwards ports on `127.0.0.1` (a service: see [below](#services)). The dialog lists the pod's running forwards (✕ stops one) and offers the declared ports not forwarded yet:

- Each port is forwarded locally on the same number, except below 1000 (binding those needs root), which gets 8000 added (`8053:53`, `8443:443`).
- With one port it's prefilled, so `f ⏎` forwards it. With several, a list shows each with name, protocol and container; type a number or name to narrow it, `⏎` adds the highlighted one, the next `⏎` forwards. `⇥` completes to the best match.
- UDP-only ports are listed but can't be picked (port-forward carries TCP only, as with kubectl).
- Each port is its own forward. If one fails (a port in use, a local port below 1024), the others still start; the failed ones stay in the field with their error.

From the keyboard, `⇧⇥` goes up into the running forwards; `↑`/`↓` pick, `x` or `⌫` stops one, `⇥`/`Esc` goes back.

The **⇄ N** badge in the tab bar (or `⌥⌘P`) lists all forwards, including those whose pod is no longer shown; `x`, `⌫` or ✕ stops one.

### Services

`f` on a service works like `kubectl port-forward svc/…`. The dialog offers the service's ports, each with its target port when it differs (`80 · http · TCP · → http`). The forward goes to one pod the service selects:

- It picks the most active pod: running and ready over pending, ready the longest, fewest restarts (the same choice kubectl makes).
- Each service port goes to its target port on that pod. A named target port (`targetPort: http`) is looked up in the pod's containers.
- The forward stays on that pod. If the pod goes away, the forward ends with the reason; `f` again picks a pod anew.
- A service without a selector (one with manually managed endpoints), or whose selector matches no pod, can't be forwarded; the dialog says why.

A service's forwards are listed as `127.0.0.1:8080 → svc 80 → 8080` with the pod they go to, in its dialog and in `⌥⌘P`.

---

## 15. Layout: splits, tabs, names

### Panes

| Key | Action |
|---|---|
| `⌘D` | split down (stacked) |
| `⌘⇧D` | split right (side by side) |
| `⌃D`, `⌃⇧D` | close the pane |
| `⌘[` / `⌘]` | previous / next pane |
| `⌘⌥←→↑↓` | pane in that direction |
| `⌘⌃←→↑↓` | move the pane's divider in that direction |
| `⌘⇧⏎` | maximize the pane / show all again |
| `⌘I` | name the pane |

`⌘D` and `⌘⇧D` are deliberately swapped compared to iTerm. `⌃D` stays out of text fields (where it's forward-delete) and terminals (where it belongs to the shell).

**Focus follows mouse** (`focusFollowsMouse: true` in `config.yaml`, off by default): moving the mouse over a pane focuses it, without a click. A filter or find field, a dialog or a menu keeps the focus until you leave it, so you can type with the pointer anywhere. A maximized pane keeps it too. A pane that just opened under a resting pointer stays focused until the mouse moves.

Drag a divider to resize, or use `⌘⌃` arrows (as in iTerm): the focused pane's top (or left) divider moves that way, so `⌘⌃↑` makes a pane taller upwards and `⌘⌃↓` shorter from the top, while its bottom stays put. A pane at the tab's top (or left) edge has no divider there, so its bottom (or right) one moves. Hold the keys to keep moving it; it stops before a pane gets too small. **Maximizing** (`⌘⇧⏎`, as in iTerm) shows the focused pane over the whole tab; the others keep running behind it, and a **⤡N** badge says how many are hidden. A click on it, `⌘⇧⏎` again, moving focus, splitting or closing a pane shows them all again.

**Moving panes** (as in ghostty): hovering a pane shows a grip at its top. Dragging it shows where it would go: the side of another pane (taking half of its place), a whole edge of the tab, a tab header (holding over it switches to that tab, so you can drop next to one of its panes), or `+` for a tab of its own. Dropping moves the pane as it is (its watch, filters, history, a shell and its screen). `Esc` cancels.

**Windows:** drop a pane's grip outside the window and the pane gets a window of its own, opened where you dropped it and as big as the pane was. While the pointer is out of the window, the pane is dimmed and says where it will go. A pane has no grip only when it's the one pane there is. It stays the same pane: the same watch, filters and history, a shell keeps running with its screen, a log pane keeps its lines, a table scrubbed back in time stays at that moment. Dragged over another window, the grip shows the same targets there as within a window (a side of a pane, a tab's edge, a tab header to hold over, `+` for a new tab), and dropping moves the pane into it. A window other than the first one closes when its last pane moves away or closes; closing it with its red button closes its panes, as closing a tab does (their shells end). Menu commands and a launch from a terminal (a new tab) go to the window in front.

### Tabs

| Key | Action |
|---|---|
| `⌘T` | new tab |
| `⌘W` | close the tab (asks if it holds more than one pane) |
| `⌘1`–`⌘8`, `⌘9` | go to that tab, `⌘9` to the last |
| `⌘⇧[` / `⌘⇧]` | previous / next tab (from anywhere, also a shell) |
| `⌃⇥` / `⌃⇧⇥` | switch in most-recently-used order |
| `⌘⇧I` | name the tab |

`⌃⇥` tapped quickly flips to the previous tab; holding `⌃` shows a switcher (`⇥` steps, releasing `⌃` commits, `Esc` cancels).

Hovering a tab shows a **✕** at its left, which closes that tab (asking first in the same cases as `⌘W`). It sits on the left so you can close several tabs in a row: the next tab moves into place with its ✕ under the pointer, and you just keep clicking.

Tabs keep their width: when there are more than fit, they wrap into more rows and the panes below get shorter. Dragging a tab reorders the tabs, across rows too. Dragged out of the window, a tab gets a window of its own with all its panes, laid out as they were (its panes are dimmed while the pointer is outside, saying where they'll go); dragged onto another window, a marker in that window's tab bar shows where it will land (anywhere below the tab bar puts it last), and dropping moves it there. The panes stay the same panes, as when moving a single pane between windows: watches, filters, history, shells and their screens, log lines. A window's only tab can't leave for a window of its own (it already is one), but it can move to another window, which closes the one it leaves.

### Names

`⌘⇧I` (or a double-click on the tab) names the tab; `⌘I` (or a double-click on the empty part of a pane's header) names the pane. The field starts with the current name selected, so you can type over it or edit it. For a tab without a name, that's the title it shows, and the tab stays unnamed until you change it. The name applies as you type; `⏎` or a click elsewhere keeps it, `Esc` restores the old one, an empty name removes it.

A pane's name shows in its header, and in the tab while the tab has no name of its own (otherwise the tab shows the focused pane's resource and namespace). A context label (`PROD`) always stays in front. Names aren't saved across restarts.

### Menu bar

The macOS menu bar (File / Object / View / Pane / Tab / Help) lists the app's commands with their current shortcuts, including your `keybindings.yaml` changes. The app menu has **Settings ▸ General…** (`⌘,`) and **Settings ▸ Keyboard Shortcuts…** (`⌥⌘,`). There's no ⌘W "Close Window" (⌘W closes a tab) and no ⌘R "Reload" (⌘⇧R reconnects the pane's context).

---

## 16. Safety

Safety rules guard clusters against mistakes. They're per kubeconfig context and live in `config.yaml` under `contexts:`:

```yaml
contexts:
  - {match: "*-prod", label: PROD, color: prod, readOnly: true}
  - {match: "*-live", label: LIVE, color: changed, strict: true}
  - {match: "*-dev", label: DEV, color: added, confirm: [delete, exec, debug, opspod, edit, terminal, label, annotate, scale]}
```

| Field | Effect |
|---|---|
| `match` | Required. A glob (`*`, `?`, `[a-z]`) on the context name. The first matching rule wins, so put specific rules before broad ones. |
| `label` | A badge in the pane header, tab, confirmations and the clusters dialog, e.g. `PROD`. |
| `color` | Colors the label and the pane frame: a theme token (`prod`, `changed`, `added`, `deleted`, …) or a CSS color (`#f14c4c`, `rgb(…)`, `oklch(…)`). |
| `readOnly` | Refuses every mutation: delete, exec, debug, node shell (`opspod`), edit, local terminals (`terminal`: a shell can run anything), `label`, `annotate`, `scale` and rollout restart (`restart`). Reading still works: tables, YAML, diff, describe, logs, jumps, port-forward. |
| `confirm` | Actions that ask before they run: `delete`, `exec`, `debug`, `opspod`, `edit`, `terminal`, `label`, `annotate`, `scale`, `restart`. Delete and restart always ask. An edit asks after its diff preview; label, annotate and scale after their dialog, naming the changes. |
| `strict` | A confirmation needs the object's name typed, not just `⏎`. |

A context no rule matches is writable, and only delete and rollout restart ask.

How the rules show is set apart from them, under `safety:`:

```yaml
safety:
  label: landscape   # badge (default) or landscape
  frame: false       # color the pane frame in the rule's color (default true)
```

- **`label: badge`** shows a rule's label as a chip of its own at the start of the pane header.
- **`label: landscape`** puts it on the landscape instead, for Gardener clusters whose rule matched their landscape (`{match: "sap-landscape-live", label: Live, …}`): the landscape's name in the header becomes a chip in the rule's color reading `Live`, so the header starts `Live › seed gcp-ha-eu2 › ⛭ CP core/cicd`. Hovering it shows the landscape's name, and a click still opens the garden. A rule matching a cluster's own name (`sap-landscape-live/shoot--ops--*`) isn't the landscape's, so it keeps its chip of its own, as do other clusters.
- **`frame: false`** leaves the pane frame in its usual color; the label still shows.

- Rules match the context name only, whichever kubeconfig it comes from.
- **Gardener landscapes:** a rule also matches the landscape of a Gardener cluster picked in `⌘⇧O` or `⌘J`. These are named `<garden>/shoot--<project>--<name>`, `<garden>/seed--<seed>` and `<garden>` (see [Opening a cluster](#opening-a-cluster-o)), so `{match: "*-live", …}` covers the garden `sap-landscape-live` and every shoot, control plane and seed opened from it, enforced as for any context. A rule for single clusters goes before it, as the first matching rule wins: `{match: "sap-landscape-live/shoot--ops--*", …}` (a glob's `*` doesn't match `/`), `{match: "*/seed--*", …}` for every seed and control plane.
- This also works for gardenctl's kubeconfigs when kubewing was launched from a terminal (`gardenctl target`, then `kubewing`), whose context names (`shoot--core--cicd`, `garden--gcp-ha-eu2-external`) don't name the landscape: kubewing reads it from the kubeconfig (gardenlogin's garden identity). A seed reached through its login secret has none, so only a rule on its context name applies there.
- A catch-all rule (`{match: "*", …}`) covers Gardener clusters too, through their landscape.
- A rule with an error (no `match`, a broken glob, an unknown color or action) shows in the config banner and is skipped, so its contexts fall through to the next rule. Check the banner after editing.
- The rules are enforced in the backend, not the UI. Every mutation needs a single-use token, valid for 60 s and bound to that exact action and object (including its UID), so no path (key, menu, context menu) gets around a rule, and a confirmation can't act on another object than the one it showed. Reloading the config drops outstanding tokens.

---

## 17. Configuration

Configuration lives in `~/.kubewing/` (or `$KUBEWING_HOME`, or `-config`). All files are optional plain YAML. `⌘⇧,` reloads them; problems show in a banner and fall back to defaults. [testdata/config/](testdata/config/) has a commented example.

### Editing the settings (`⌘,`)

`⌘,` (or **kubewing → Settings → General…**) opens `config.yaml` in an editor, with a reference beside it: every setting with its default (or an example) and what it does. Copy what you need from there; **reference** shows or hides it.

- Without a `config.yaml` yet, the editor starts with the reference commented out, so nothing changes until you uncomment a line (`⌘/` comments lines in and out).
- Problems show below the editor as you type, as kubewing would read the file. Whether `font.family` is installed is checked when you save: it shows there too then.
- `⌘S` saves and applies at once, like `⌘⇧,`. If the file still has problems, it's saved anyway and those parts fall back to defaults (and show in the banner once the editor is closed: while it's open, the banner is hidden).
- `Esc` closes. With unsaved edits it asks first; a second `Esc` drops them.

`⌥⌘,` (or **kubewing → Settings → Keyboard Shortcuts…**) opens `keybindings.yaml` the same way, with every default binding beside it, by section, written as an entry would be: copy a line and change its key. Problems (an unknown command, key or context, an entry without a key or command) show as you type, numbered by entry. A new file starts with a commented example.

Both keys work while the editor's text doesn't have the focus (in the text, keys are the editor's); the other one doesn't switch files while one is open, so edits are never dropped unasked.

A symlinked `config.yaml` or `keybindings.yaml` (dotfiles) is saved where the link points. The other files (`refs.yaml`, `health.yaml`, themes) are edited outside kubewing.

| File | Content |
|---|---|
| `config.yaml` | settings (below) |
| `keybindings.yaml` | key overrides |
| `refs.yaml` | which fields refer to other objects (jumps from the YAML) |
| `health.yaml` | what "hide healthy" hides, per kind |
| `themes/<name>.yaml` | theme token overrides |
| `columns.yaml` | written by kubewing: columns and widths per resource type (edit by hand while kubewing isn't running) |
| `history.yaml` | written by kubewing: recent debug and node-shell images, the last node shell's settings, recent labels and annotations, the window's size |
| `clusters.yaml` | written by kubewing: the recently opened clusters (`⌘⇧O`), the latest first, at most 100 |
| `update.json` | written by kubewing: when it last checked for updates, and the version you skipped |

### `config.yaml`

```yaml
theme: mytheme              # blue (built in) or themes/mytheme.yaml; omit for the default theme

font:
  family: JetBrainsMono Nerd Font   # an installed font or a list ("Fira Code", Menlo); omit for SF Mono
  size: 12                  # px, 8 … 24
  ligatures: false          # true: "->", "!=", "=>" as one glyph, in fonts that have them

diff:
  ignore:                   # extra noise rules for the diff ("*" matches any list element / map key)
    - {path: metadata.annotations.example\.com/last-sync}

contexts: []                # safety rules, see Safety
safety: {label: badge, frame: true}   # how they show: landscape puts a landscape's label on its name; frame: false keeps frames plain

debug:
  image: nicolaka/netshoot  # prefilled debug image
  profile: general          # general, baseline, restricted, netadmin, sysadmin

opsPod:                     # node shell defaults (until a pod ran; then the last used ones)
  image: europe-docker.pkg.dev/gardener-project/releases/gardener/ops-toolbelt:latest
  namespace: kube-system
  chroot: false
  hostRoot: true
  hostNetwork: true

terminal:
  scrollback: 10000         # lines, 100 … 1000000
  copyOnSelect: false       # true: selecting with the mouse copies, in terminals and logs alike

logs:
  tail: 100                 # lines per container before following, 1 … 10000
  maxStreams: 50            # containers followed at once
  buffer: 50000             # lines kept per log pane, 1000 … 5000000

history:
  budget: 512Mi             # memory for recorded changes, 1Mi … 64Gi; a reload applies it at once

launch:
  wait: false               # true: stay in the foreground when launched from a terminal

update:
  checkDays: 1              # days between update checks, 0 = off (Check for Updates… still works), at most 365
  prereleases: false        # true: offer release candidates too

focusFollowsMouse: false    # true: the pane under the mouse gets the focus, no click needed
```

### `keybindings.yaml`

```yaml
- {key: "cmd+k", command: row.down, when: [table]}
- {key: "cmd+shift+d", command: none}       # unbind
```

Edit it in the app with `⌥⌘,` (see [Editing the settings](#editing-the-settings-)). Keys are modifiers `cmd`/`ctrl`/`alt` (`opt`)/`shift` joined with `+`. An entry overrides the defaults for that key in the given contexts (all contexts without `when`). The cheat sheet (`?`) and the menu bar show your bindings as they are. The editor's reference lists every command id with its default keys (and the commands without one).

### `refs.yaml`

Rules for what a field refers to (see [Jumping from a field](#jumping-from-a-field-in-the-yaml)). Yours come before the built-in ones; a rule with a built-in's `id` replaces it, `disable` turns built-in ones off. The built-in rules are in [internal/relations/refs.yaml](internal/relations/refs.yaml).

```yaml
rules:
  # a custom resource naming config maps in a list
  - id: widget-configs
    kinds: [example.com/Widget]       # group/Kind ("Pod" for core kinds), globs allowed; omitted or "*": any kind
    path: "spec.configs[*]"           # where the reference is
    name: ref                         # the name's field, relative to path; omitted: the value at path
    target: ConfigMap                 # Kind (core), group/Kind (preferred version) or group/version/Kind
  # the kind and group come from the object (like a roleRef)
  - id: widget-owner
    kinds: [example.com/Widget]
    path: spec.ownerRef
    name: name
    kindField: kind                   # also groupField, apiVersionField
    namespaceField: namespace         # default: the object's own namespace
disable: [node-name]                  # ids of built-in rules
```

### `health.yaml`

What "hide healthy" hides (see [Hide healthy](#hide-healthy)): a rule per kind. The first rule whose `kinds` match an object decides; kinds without a rule are never hidden, and an object being deleted never is. Yours come before the built-in ones; a rule with a built-in's `id` replaces it, `disable` turns built-in ones off. The built-in rules are in [internal/health/health.yaml](internal/health/health.yaml). Changes apply to open panes once the config is reloaded.

```yaml
rules:
  # healthy when every check the rule sets holds
  - id: widget
    kinds: [example.com/Widget]       # group/Kind ("Pod" for core kinds), globs allowed ("example.com/*"); required
    title: widgets that are ready     # the checkbox's tooltip ("{kinds}" = the pane's kind: "widgets")
    generation: true                  # status.observedGeneration is at least metadata.generation
    conditions:                       # status.conditions: type → required status; a missing condition fails
      Ready: "True"
      Degraded: "False"
    cel: o.status.phase == "Up"       # a CEL expression over the object o, as in the filter; a missing field fails
  # cordoned nodes count as healthy too (replaces the built-in rule "node")
  - id: node
    kinds: [Node]
    conditions: {Ready: "True"}
disable: [pvc]                        # ids of built-in rules
```

Pods and workloads use checks built into kubewing, named by `builtin: pod`, `workload` (Deployments, StatefulSets), `replicaset` or `daemonset`; a rule of yours can use them for other kinds of the same shape too.

Paths are field names separated by dots, plus:

| Syntax | Matches |
|---|---|
| `[*]` | any list item |
| `[kind=ServiceAccount]` | the list items whose `kind` is `ServiceAccount` |
| `*`, `*SecretRef` | any key, a key matching the glob |
| `**` | any depth (`**.volumes[*].secret`: pod specs wherever they're embedded) |
| `["example.com/ref"]` | a key with dots, literally |

### Fonts

kubewing uses one font everywhere: tables, YAML, terminals, logs, menus and dialogs. Without `font` in `config.yaml` it's SF Mono (Menlo where SF Mono isn't available) at 12px.

- `font.family` names an installed font, as Font Book shows its family (a Nerd Font is called e.g. `JetBrainsMono Nerd Font`), or a comma-separated list, of which the first installed one is used. SF Mono and Menlo stay behind it, so a missing font falls back to them; the settings editor and the error banner then say so. Pick a monospaced font: table columns and terminals only line up with one.
- `font.size` is the base size in pixels (8 … 24); table rows, terminals and editors follow it, and the smaller text of menus and status lines stays 1-2px below it.
- `font.ligatures: true` lets fonts with programming ligatures (Fira Code, JetBrains Mono, Cascadia Code) join `->`, `!=`, `=>` and the like into one glyph. It's off by default, so text reads as it was typed.

A reload (`⌘⇧,`, or saving in `⌘,`) applies changes at once, to open panes too.

`⌘+` and `⌘-` make the font one pixel bigger or smaller, in every pane and tab at once (also **View → Zoom In / Zoom Out**); `⌘0` (**Actual Size**) goes back to `font.size`. The zoom stays within 8 … 24px and lasts until kubewing quits: it isn't saved, and the next start uses `font.size` again. A reload keeps it, on top of the new `font.size`.

### Themes

Two themes are built in: the default one (dark grey with an orange accent) and `blue` (navy with a blue accent); select it with `theme: blue`. Both draw drop shadows below menus and dialogs.

`themes/<name>.yaml` overrides the tokens in [theme.css](frontend/src/theme.css) (colors such as `prod`, `changed`, `added`, `deleted`, `match`, and the [status colors](#columns) `ok`, `warn`, `bad`); select it with `theme: <name>`. A `themes/blue.yaml` changes single tokens of the built-in blue theme. The `shadow` token colors the drop shadow below menus and dialogs; `shadow: "#0000"` turns it off.

---

## 18. Keyboard reference

`?` (or the **?** button at the right end of the tab bar) opens the cheat sheet: every shortcut by section (the global keys first), with the context it applies in, read from the live keymap (so your overrides show). `?` again, the button again, or `Esc` closes it.

`⌘F` searches the open cheat sheet: type to match on a section's name, a shortcut's description or its keys, with the matched text highlighted; `⌘G` / `⏎` jumps to the next match and `⌘⇧G` / `⇧⏎` the previous (the rest dims so the matches stand out). `Esc` closes the search and leaves the sheet open; `Esc` again closes the sheet.

The most used keys:

| Where | Keys |
|---|---|
| Anywhere | `⌘O` open · `⌘⇧O` cluster · `⌥⌘O` shoot ⇄ control plane · `⌘T` tab · `⌘D`/`⌘⇧D` split · `⌃T`/`⌃⇧T` local terminal · `⌘W` close tab · `⌘R` list `all` again · `⌘⇧R` reconnect · `⌘,` settings · `⌘⇧,` reload config · `⌘+`/`⌘-`/`⌘0` font size · `?` help |
| Table | `/` grep (`⇥` labels, CEL) · `h` hide healthy · `o` columns · `m` metrics · `⇧M` requests/limits · `⇧R` record changes · `t` time travel · `⇧↓`/`⇧↑` mark · `Space` mark one · `⌘A` mark all |
| Row | `⏎` YAML · `e` edit · `d` describe · `⌘J` jump · `v` events (`⇧V` split) · `l` logs · `x` exec · `b` debug · `n` node shell · `f` port-forward · `⇧L` label · `⇧A` annotate · `s` scale · `r` restart · `⌘⌫` delete · `⌘⏎` all actions |
| YAML view | `⏎` decode (`e` in it: edit it) · `d` diff · `⇧D` describe · `=`/`!` filter by value · `⇧H` field history · `⌘J` / `⌘`-click jump from a field · `b` who set each line · `w` wrap · `⌘F` find · `⌃←`/`⌃→` fold/unfold |
| Diff | `j`/`k` changes · `[`/`]` versions |
| Time travel | `←`/`→` changes · `⇧←`/`⇧→` minutes · `Home` start · `Esc` live |
| History | `⌘←` back · `⌘→` forward |

---

## 19. Troubleshooting

- **macOS says kubewing "is damaged and can't be opened".** The download lost its signature, e.g. unpacked by a tool that drops bundle metadata. Unpack the zip with Finder (or `ditto -x -k`), or remove the quarantine flag as in [Installing](#installing).
- **The update fails.** The dialog shows why. A download that doesn't match its signature or GitHub's checksum is never installed: try again later, or download the release by hand (see [Installing](#installing)). "Rate limit" means GitHub is limiting checks from your network for the hour.
- **Where's the log?** `kubewing.log` in the state directory (default `~/.kubewing/`), rotated to `kubewing.log.1` at 10 MiB. Or start with `-wait` to see it in the terminal.
- **A pane shows an error.** Click the status line's error to see the full message, including what the server answered.
- **A pane says `connection refused` on `127.0.0.1` or `localhost`.** The context points at a local cluster (kind, minikube, …) that's stopped, or that's gone while its kubeconfig entry stayed behind. The pane says so, and its button opens `⌘⇧O` to replace the pane with another cluster. Start the cluster again, or remove its context (`kind delete cluster` does both: cluster and context). `kubectl config unset current-context` makes kubewing start with `⌘⇧O`.
- **A pane says disconnected, or looks stuck.** Press `⌘⇧R` (or click the connection state) to reconnect its context.
- **Completion doesn't know a resource.** The catalog loads once a pane is open on that context and follows CRD changes; unknown text in `⌘O` still opens as typed.
- **A config change has no effect.** Press `⌘⇧,` and check the banner: invalid parts are reported and skipped.
- **Launching kubewing again only brought the window to the front.** That's the single-instance behavior: it opened a tab there. Use `-new-process` for a separate one.
- **A Gardener shoot fails with `kubectl-gardenlogin` (or `kubectl`) not found.** kubewing runs the exec plugins of the kubeconfigs it uses with its own `PATH`: the terminal's when launched from one, your login shell's when launched from the Dock or Finder. Check that `command -v kubectl-gardenlogin` finds it in a new Terminal tab. Launched from the Dock, look in the log for `keeping launchd's environment`: your profile took longer than 10 seconds or failed.
- **A pasted dashboard URL matches nothing.** The patterns come from `~/.garden/gardenctl-v2.yaml` (each garden's `patterns`); the dashboard's host must be in one of them. `gardenctl config set-garden … --pattern` adds one.
- **`kubectl` in a local terminal targets another cluster, or its `$KUBECONFIG` file doesn't exist.** Your shell profile sets `KUBECONFIG` after kubewing did. With gardenctl, an untargeted session's `gardenctl kubectl-env` points at a file that isn't there yet. Skip it in kubewing's shells: `[[ $TERM_PROGRAM != kubewing ]] && eval $(gardenctl kubectl-env zsh)`.
- **A node shell is rejected by PodSecurity.** The namespace enforces `baseline` or stricter (like `default`); pick a privileged one such as `kube-system`.
