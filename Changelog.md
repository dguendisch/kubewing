# Changelog
## [Unreleased]

### Fixed
- recent gardenctl session targets and local terminal targeting use its private per-user temporary directory, including resolved macOS paths; this integration requires gardenctl v2.19.0 or newer (gardenctl remains optional for using kubewing)

## [0.7.0] - 2026-11-14
### Added
- multi-window support for tabs: drag a tab out of the window to give it a window of its own, or onto another window to move it there, with all its panes as they were
- multi-window support for panes: drag a pane's grip out of the window to give the pane a window of its own, or onto another window to move it there; it keeps its watch, filters, history, a shell's screen and a log pane's lines
- Gardener clusters show where you are in the pane header: the landscape, the seed beneath, and a colored badge for the plane (shoot, control plane, seed, garden), with managed and unmanaged seeds told apart; its parts open the garden, a seed or the other plane, and the tab leads with the plane's mark
- copy on select: with `terminal.copyOnSelect: true` in `config.yaml`, selecting text with the mouse in a shell or log pane copies it (off by default)
- copy & copy cell(s) (`⌘⇧C`) with multiple rows marked, copies all marked rows (instead of only the cursor's row)
- the log dialog can show the logs of each container's previous instance, like `kubectl logs -p` (the **previous** checkbox, or `⌘P` in the dialog): a crashed or restarted container's last run
- status colors: state cells (STATUS, READY, conditions such as AVAILABLE or a shoot's NODES, an event's TYPE) show their text in orange when waiting (`Pending`, `1/2`, `Unknown`) and red when broken (`CrashLoopBackOff`, `False`), like kubecolor; healthy states stay uncolored unless a theme sets the `ok` token. Metric percentages (`%CPU`, `%MEM/L`, `%CPU REQ` …) turn orange from 70% and red from 90%
- the row menu (`⌘⏎`, right-click) now has the **events** command (`v`) (previously it was only visible from the jump menu)
- `safety.chip: false` in `config.yaml` shows the landscape's label (with `safety.label: landscape`) as just its text in the rule's color, without a chip, in the pane header and the clusters dialog
- `safety.label: landscape` in `config.yaml` shows a landscape's safety label (e.g. `Live`) in place of the landscape's name in the pane header instead of as a separate badge; `safety.frame: false` stops coloring the pane frame

### Changed
- the YAML, diff, describe and editor views have the same header as their table
- safety rules also match a Gardener cluster's landscape: a rule for `*-live` now labels and guards every shoot, control plane and seed opened from a live landscape (also gardenctl's kubeconfigs)
- safety labels (`PROD`, `LIVE`) are outlined chips in the rule's color instead of filled blocks
- naming a tab (`⌘⇧I` or double-click) starts with its current title selected, ready to edit, instead of an empty field
- the open cluster dialog (`⌘⇧O`) opens panes/tabs now consistent with the jump menu (`⌘J`): `⏎` in the focused pane, `⇧⏎` in a split below, `⌘⏎` in a new tab. The "open in" toggle and `⌃⇧⏎` are gone

### Fixed
- every menu bar item now shows its shortcut in the menu's shortcut column, the macOS way
- a cluster just opened with `⌘⇧O` or `⌘J` shows its safety label right away, not only once something is listed in it
- an ended log tail now names the key that closes its pane (`⌃D`), not `⌘W`, which closes the whole tab
- marked rows no longer grow pulsing borders around their age and restarts cells a few seconds after they were marked (due to time/age repainting)

## [0.6.0] - 2026-11-11
### Added
- the status line now shows how far it got on huge resource listings (e.g. `syncing 35% (1,500/4,213)`)
- font settings in `config.yaml`: `font.family` (any installed font, e.g. a Nerd Font), `font.size` and `font.ligatures`, for tables, YAML, terminals, logs and menus alike; a font that isn't installed is reported when the settings are saved or loaded
- `⌘+` / `⌘-` / `⌘0` zoom the font of all panes and tabs until kubewing quits (also in the View menu)
- `⌘F` searches the open keyboard cheat sheet by section, description or keys; `⌘G` / `⏎` and `⌘⇧G` / `⇧⏎` step through the matches, which are highlighted
- the log viewer's status bar now shows whether timestamps are on or off and the key that toggles them

### Changed
- shoot ⇄ control plane moved from `⌘⇧P` to `⌥⌘O`, next to `⌘⇧O`'s clusters

### Fixed
- checking for updates no longer fails with "GitHub's rate limit for anonymous requests is used up" behind a company network or VPN
- a custom column's field path can now stop before a leaf: `⌫` on the `.` the completion added (`spec.` → `spec`) closes the suggestions, so `⏎` adds `spec` instead of completing to `spec.` again
- a pane of nodes could now and then stay on **loading requests/limits…** with its requests/limits columns empty, right after it was opened

## [0.5.0] - 2026-11-09
### Added
- hide healthy (`h`) works on more kinds: Gardener managed resources (applied, healthy and not progressing), nodes (Ready and not cordoned), jobs, persistent volume claims, Gardener extension resources, shoots, seeds, machines and etcds
- `health.yaml` in the config directory sets what hide healthy hides per kind, for your own resources too: status conditions, the observed generation or a CEL expression
- the label and annotate dialogs remember the last 20 labels and annotations you set: `↓` in the field lists them, ✕ forgets one

### Changed
- logs moved from `⌘L` to `l` (and from `⌥⌘L` to `⌥L` for the whole pane)
- `l` and `c` no longer jump to the label selector and CEL fields: `/` and then `⇥` gets there (or the menu bar's **View → Filter by Labels / Filter by CEL**)
- the node shell moved from `⌥⌘O` to `n` in a table, like the other row keys; from a terminal pane it's in the menu bar (**Object → Node Shell…**)
- the row menu (`⌘⏎`) is regrouped

## [0.4.0] - 2026-11-09
### Added
- editing decoded values: `⌘E` in the editor opens the value at the cursor decoded (base64, gzip, brotli, also nested: a kubeconfig in a managed resource's manifests), and `Esc` encodes your edit back the way it was encoded; `e` in a decoded value opens it in the editor
- keybinding editor: `⌥⌘,` (**kubewing → Settings → Keyboard Shortcuts…**) edits `keybindings.yaml` in the app: every default binding beside it, unknown commands, keys and contexts shown as you type, `⌘S` saves and applies
- a built-in blue theme (`theme: blue` in `config.yaml`)
- drop shadows below menus and dialogs, in every theme; the `shadow` theme color sets or turns them off

### Changed
- opening a cluster moved from `⌘P` to `⌘⇧O`: `⌘O` opens what's in the pane's cluster, `⌘⇧O` a cluster; the cheat sheet lists both first, as global keys
- the app menu's settings are a **Settings** submenu: **General…** (`⌘,`, `config.yaml`) and **Keyboard Shortcuts…** (`⌥⌘,`, `keybindings.yaml`)
- kubewing now needs macOS 13 Ventura or later (it never ran on older versions; macOS now says so instead of the app failing to start)

### Fixed
- `home` and `end` in `keybindings.yaml` are recognized as keys
- a problem in `keybindings.yaml` after an entry missing its key or command names the right entry

## [0.3.0] - 2026-11-07
### Added
- `⌘,` (**kubewing → Settings…**) edits `config.yaml` in the app: a reference of every setting beside it, problems shown as you type, `⌘S` saves and applies
- `b` in the YAML view (`⌘B` in the editor) shows who set each line, like kubectl-blame: the field manager owning it and how long ago, beside the YAML
- a **?** button at the right end of the tab bar opens the cheat sheet of keyboard shortcuts
- `⌘L` with rows marked tails the logs of all marked pods, workloads, nodes or namespaces together in one log pane
- the log dialog can open a log pane per pod when a tail covers several pods (up to 8): stacked below, or in a new tab

### Changed
- the node shell dialog no longer opens with the node list expanded; type or press `↓` to list the nodes

## [0.2.0] - 2026-11-07
### Added
- auto-updates: kubewing checks for a new version daily (`update.checkDays`, `0` = off), shows its release notes, and installs it on request; also **kubewing → Check for Updates…**

## [0.1.0] - 2026-11-06
### Added
- First release of kubewing: see the [highlights](https://github.com/dguendisch/kubewing#highlights) and the [manual](https://github.com/dguendisch/kubewing/blob/main/Manual.md)
