# Changelog
## [Unreleased]
### Added
- the status line now shows how far it got on huge resource listings (e.g. `syncing 35% (1,500/4,213)`)

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
