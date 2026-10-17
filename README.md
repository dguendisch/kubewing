# kubewing 🪽

Keyboard-driven native desktop UI for Kubernetes: `kubectl` + grep/watch/diff + tabs/splits. See [Plan.md](Plan.md).

## Status: P0 step 1 (vertical slice) + P0.1 (completion)

Works today:
- Live table for any resource (`po`, `deploy.apps`, CRDs …) of any kubeconfig context; columns from server-side Table output.
- One watch stream per source (`as=Table;includeObject=Object`): cells and objects come from the same resourceVersion.
- Keyed diff by UID: changed cells, "changed, not visible" marker, added/deleted rows (delete + recreate = remove + add), AGE never counts as a change, noise (resourceVersion, managedFields, heartbeats) ignored.
- Splits/tabs (`⌘D`, `⌘⇧D`, `⌘W`, `⌘T`, `⌘⇧[ ]`, `⌘[ ]`), splits on the same source share one watch.
- Filter bar (`/` grep, label selector), `j/k/g/G`, `⏎` YAML detail, `d` normalized diff to the previous version, `⌘O` open context/resource/namespace.
- `⌘O` completion for resource and namespace: ranked by exact > prefix > substring > fuzzy over names, short names, singular and kind (`po`, `pdb`, `Deployment`). Suggestions show group, scope and short names, with the typed letters highlighted. A plural served by two groups (`machines`) completes to its qualified name. Fields open with their value selected; the list opens on typing (or `↓`). `⇥` completes, `⏎` completes and opens, `Esc` closes the list, then the dialog. Unknown text still opens as typed.
- Cluster catalog (resource types + namespaces per context), fetched in the background once a pane is open on that context. It never connects on its own, so it never triggers exec-plugin logins. Refreshed by metadata-only CRD/namespace watches, on resolve misses and every 5 min. Partial discovery (an aggregated API down) and forbidden namespace lists degrade to a hint.

Not yet (rest of P0): exec, port-forward, describe/events, delete, Gardener tree, safety model, config files in `~/.kubewing/`, CEL filter UI, dockview, Monaco.

Not yet (P0.1): object-name completion; completion for a context picked in `⌘O` before any pane is open on it (shows a hint instead).

## Develop

Toolchain caches live in `.cache/` inside the repo (no global writes).

```sh
make deps        # Go modules, npm packages, Playwright Chromium
make run         # build and start the app
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
| `internal/source` | Table list/watch, ref-counted shared registry, discovery + metadata-only lists/watches |
| `internal/catalog` | per-context completion snapshot (resource types, namespaces), background refresh |
| `internal/view` | pipeline over events → keyed diff → viewport frames |
| `internal/bridge` | frontend API, ≤10 Hz frame pump, WebSocket transport |
| `internal/tape` | scenario tapes (goldens, headless E2E); fake catalog for completion (`testdata/catalog.yaml`) |
| `frontend/src` | React 19 + Compiler, Glide grid, zustand, transport (Wails / WS) |
| `frontend/src/complete` | completion: pure ranker + candidate providers (reused by the P1 palette), combobox, catalog hook |

## Tests

- **Goldens** (`internal/view/testdata/*.golden`): tapes in `testdata/tapes/` replayed through the view; frames compared to the golden files. They are the spec: change them only with `make golden-update` and review the diff on its own.
- **Properties** (`rapid`): sort doesn't affect markers, no-op relist produces no frame, rows never leave the viewport, no unchanged resends.
- **Bridge budget**: 10k objects under an event storm → ≤10 Hz, ≤ viewport rows per frame.
- **Catalog**: never connects to a context without an open pane; partial discovery stays usable; failed refreshes keep the last good state; CRD/namespace watches and resolve misses trigger refetches.
- **Frontend units**: keymap (incl. collisions, suppressed webview defaults), layout/command invariants under 2000 random ops, cell layout, row cache, completion ranking/highlight goldens.
- **E2E**: Playwright drives Chromium; asserts via `window.__kw.inspect()` and ARIA snapshots.
