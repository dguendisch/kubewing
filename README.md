# kubewing 🪽

Keyboard-driven native desktop UI for Kubernetes: `kubectl` + grep/watch/diff + tabs/splits. See [Plan.md](Plan.md).

## What works today

- Live table for any resource (`po`, `deploy.apps`, CRDs …) of any kubeconfig context; columns from server-side Table output.
- One watch stream per source (`as=Table;includeObject=Object`): cells and objects come from the same resourceVersion.
- Keyed diff by UID: changed cells, "changed, not visible" marker, added/deleted rows (delete + recreate = remove + add), AGE never counts as a change, noise (resourceVersion, managedFields, heartbeats) ignored.
- Splits/tabs (dockview): drag a divider to resize, drag a pane to rearrange; `⌘D` split stacked, `⌘⇧D` split side by side (deliberately swapped vs. iTerm), `⌃D` or `⌃⇧D` close the pane, `⌘T` new tab, `⌘W` close the tab (it asks first if the tab holds more than one pane), `⌘1`–`⌘8` go to that tab and `⌘9` to the last (shown in the tab header), `⌘←→` cycle tabs, `⌘[ ]` cycle panes, `⌘⌥←→↑↓` move to the tile in that direction. `⌃⇥` / `⌃⇧⇥` switch tabs in MRU order: a quick tap flips to the previous tab, and holding `⌃` shows a switcher (`⇥` steps, release commits, `Esc` cancels). `⌃D` and `⌘←→` stay out of text fields, where they are forward-delete and start/end of line; in a terminal `⌃D` belongs to the shell (ending it closes the pane), and `⌃⇧D` closes the pane of a shell that won't end. Splits on the same source share one watch.
- Filter bar: `/` grep (applies as you type), `l` label selector, `c` CEL filter over the object `o` (`o.status.containerStatuses.exists(c, c.restartCount > 3)`). Labels and CEL are drafts until `⏎`: a half-typed value would match nothing, so while typing the table stays as it is and the field shows what the draft would show (`→ 2 / 3`; `≥` when a wider label selector may match objects not loaded yet), or why it can't apply (parse error with a caret, not a bool). `⏎` applies, empty + `⏎` clears, a dashed border means a draft is pending. CEL completes field paths from the pane's live objects (`o.status.` → the keys found there, with type and how many objects have them; also inside `exists(c, c.…)`) and the common functions; `⇥` completes, `↑` in an empty field recalls recent filters. Filter changes keep the watch and the diff state. Errors other than a missing field (which just doesn't match) show in the status line.
- `j/k`, `g/G` or `⌥↑/⌥↓` first/last row, `⌘O` open context/resource/namespace.
- Detail view in a read-only Monaco editor: `⏎`/`y` YAML, `d` side-by-side diff of the previous vs. current normalized object, `⇧D` `kubectl describe` (with events — `d` is the diff toggle here, so describe keeps `⇧D` in this view), `⌘F` find, `Esc` closes. In the YAML, `=` on a line filters the pane by that field's value and `!` by "not this value" (objects without the field included); fields inside lists become `exists()`.
- Describe diff: in the describe view `d` diffs against the previous look at the same object (by UID, this session), `r` re-runs describe. Unlike the object diff it shows what describe adds (events, counts); relative times (event ages, heartbeats, lease renewals) are blanked and tables re-aligned, so only real changes show. It compares looks, not watch history: changes between two looks are summed up.
- Object actions: `d` describe, `⌘⌫` or `Del` delete (UID precondition, so a recreated object of the same name is never hit), `s` exec into a pod (bash, else sh) in a terminal pane below (xterm.js; every key goes to the shell except `⌘` chords, `⌃⇥` and `⌃⇧D`; `⌃D` or `exit` ends the shell and the pane goes with it, `⌘W` closes the tab as anywhere else; a session that never started, or a shell that exits non-zero before the first keystroke, keeps its pane so the reason stays readable, and `⌃D` closes it once read), `f` port-forward on 127.0.0.1 (pre-filled from the container ports), `⌘⌥P` lists port-forwards (`⌃D` stops). Exec uses the `kubectl.kubernetes.io/default-container`, else the first container.
- Context menu: `⌘⏎` or right-click on a row lists every operation on it (view YAML, describe, diff, exec, port-forward, delete) with its shortcut from the live keymap; unavailable entries say why ("needs a pod", "read-only context", "no change seen yet"). `j/k` move, `⏎` runs, `Esc` closes. It's generated from [actions/registry.ts](frontend/src/actions/registry.ts): a new row action is one entry there, and a unit test fails for any `object.*` command that has none.
- Cheat sheet: `?` (again or `Esc` closes) lists every shortcut by section, with the context a key is scoped to, read from the live keymap — so `keybindings.yaml` overrides show up as they are. It's built from [keys/cheatsheet.ts](frontend/src/keys/cheatsheet.ts), and a unit test fails for any command that no section mentions.
- Safety model, decided in Go: per-context label and color on pane frame, header and tab; read-only contexts refuse delete and exec (describe and port-forward still work); delete always asks, other actions per rule; strict rules require typing the object name. Every mutation goes through a single-use, 60 s token bound to the exact object.
- Config in `~/.kubewing/` (or `$KUBEWING_HOME`), read-only and optional; `⌘⇧,` reloads. Problems show in a banner and fall back to defaults. See [testdata/config/](testdata/config/) for a commented example:
  - `config.yaml`: theme, extra diff ignore rules, per-context safety rules (`match` glob, `label`, `color`, `readOnly`, `confirm`, `strict`).
  - `keybindings.yaml`: `{key: cmd+k, command: row.down, when: [table]}`; `command: none` unbinds.
  - `themes/<name>.yaml`: overrides for the tokens in [theme.css](frontend/src/theme.css).
- `⌘O` completion for resource and namespace: ranked by exact > prefix > substring > fuzzy over names, short names, singular and kind (`po`, `pdb`, `Deployment`). Suggestions show group, scope and short names, with the typed letters highlighted. A plural served by two groups (`machines`) completes to its qualified name. Fields open with their value selected; the list opens on typing (or `↓`). `⇥` completes, `⏎` completes and opens, `⌥↑/⌥↓` first/last suggestion, `Esc` closes the list, then the dialog. Unknown text still opens as typed.
- Cluster catalog (resource types + namespaces per context), fetched in the background once a pane is open on that context. It never connects on its own, so it never triggers exec-plugin logins. Refreshed by metadata-only CRD/namespace watches, on resolve misses and every 5 min. Partial discovery (an aggregated API down) and forbidden namespace lists degrade to a hint.

## Develop

Toolchain caches live in `.cache/` inside the repo (no global writes).

```sh
make deps        # Go modules, npm packages, Playwright Chromium
make run         # build and start the app (as bin/kubewing.app, for the Dock icon)
make test        # lint + Go (race) + frontend unit tests
make e2e         # Playwright (Chromium) against the headless backend replaying testdata/tapes
make headless    # bridge over WebSocket on :7777 replaying tapes + testdata/catalog.yaml (TAPES= for real kubeconfig)
```

Browser dev against the headless backend: `make headless` and
`cd frontend && VITE_KW_TRANSPORT=ws npx vite`.

## Layout

| Path | What |
|---|---|
| `internal/pipeline` | pipeline model (source → stages → render), YAML (de)serialization |
| `internal/expr` | CEL (cel-go, plus `sum()`) and dot paths |
| `internal/normalize` | noise rules + content hash |
| `internal/source` | Table list/watch, ref-counted shared registry, discovery + metadata-only lists/watches; actions (describe, delete, exec, port-forward) |
| `internal/catalog` | per-context completion snapshot (resource types, namespaces), background refresh |
| `internal/config` | `~/.kubewing/` loader (config, keybindings, themes); invalid parts reported, defaults used |
| `internal/safety` | per-context rules, two-phase mutations (prepare → single-use token → execute) |
| `internal/view` | pipeline over events → keyed diff → viewport frames |
| `internal/bridge` | frontend API, ≤10 Hz frame pump, WebSocket transport |
| `internal/tape` | scenario tapes (goldens, headless E2E); fake catalog for completion (`testdata/catalog.yaml`); fake actions (echo shell, port-forward) |
| `frontend/src` | React 19 + Compiler, Glide grid, zustand, transport (Wails / WS) |
| `frontend/src/complete` | completion: pure ranker + candidate providers (reused by the P1 palette), combobox, catalog hook |
| `frontend/src/store/dock.ts` | pure converters between the store's split tree (source of truth) and dockview's layout |
| `frontend/src/editor` | Monaco, trimmed to a lazily loaded read-only YAML/text and diff viewer |
| `frontend/src/term` | xterm.js terminal and exec session output store |

## Tests

- **Goldens** (`internal/view/testdata/*.golden`): tapes in `testdata/tapes/` replayed through the view; frames compared to the golden files. They are the spec: change them only with `make golden-update` and review the diff on its own.
- **Properties** (`rapid`): sort doesn't affect markers, no-op relist produces no frame, rows never leave the viewport, no unchanged resends.
- **Bridge budget**: 10k objects under an event storm → ≤10 Hz, ≤ viewport rows per frame.
- **Catalog**: never connects to a context without an open pane; partial discovery stays usable; failed refreshes keep the last good state; CRD/namespace watches and resolve misses trigger refetches.
- **Frontend units**: keymap (incl. collisions, suppressed webview defaults), layout/command/MRU invariants under 3000 random ops, directional tile focus, cell layout, row cache, completion ranking/highlight goldens.
- **E2E**: Playwright drives Chromium; asserts via `window.__kw.inspect()` and ARIA snapshots.
