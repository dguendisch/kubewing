# Developing kubewing

Building, running and testing kubewing. How it's built: [Architecture.md](Architecture.md). What's next: [Plan.md](Plan.md).

## Toolchain

All toolchain caches live in `.cache/` inside the repo (Go modules and build cache, npm cache, Playwright's Chromium): nothing is written globally. The Makefile sets the environment (`GOPATH`, `GOCACHE`, `PLAYWRIGHT_BROWSERS_PATH`, …), so go through `make`.

```sh
make deps              # Go modules, npm packages, Playwright Chromium (needs network)
make run               # build and start the app (as bin/kubewing.app, for the Dock icon), in the foreground (-wait)
make app               # build bin/kubewing.app only
make test              # lint + Go (race) + frontend unit tests
make e2e               # Playwright (Chromium) against the headless backend replaying testdata/tapes
make headless          # backend over WebSocket on :7777 replaying tapes + testdata/catalog.yaml (TAPES= for your real kubeconfig)
make golden-update     # regenerate the view goldens, then review the diff on its own
make icon              # regenerate the app icon from build/appicon.svg
```

`make e2e` and `make icon` can't run inside the macOS sandbox (Chromium needs Mach ports; `iconutil` needs the system temp dir). Never call `npx playwright test` or `npx playwright install` directly: only the Makefile points Playwright at the browsers in `.cache/ms-playwright`.

## Browser dev

The frontend can run in a browser against the headless backend, with Vite's hot reload:

```sh
make headless                                       # terminal 1: replays testdata/tapes
cd frontend && VITE_KW_TRANSPORT=ws npx vite        # terminal 2
```

`make headless TAPES=` uses your real kubeconfig instead of tapes.

### Tapes

Scenario tapes (`testdata/tapes/*.yaml`) are scripted fake clusters: starting objects plus timed watch events (add, update, delete, relist, recreate under the same name). They drive the goldens, and the headless E2E backend. `testdata/catalog.yaml` is the fake catalog for completion. `filter: true` tapes (`rel-*`) honor namespace and selectors and serve metadata, acting as a fake API for the jump menu (a tape serves its first object's kind; a group without a version, as in RBAC's `apiGroup`, takes any tape of that group and kind). The headless backend also fakes actions (an echo shell, port-forward, logs). A tape's `metrics:` (usage by `namespace/name`, `/name` for nodes) fakes metrics.k8s.io for the metric columns; a tape without it is a cluster without metrics-server. `lookupOnly: true` tapes (`garden-*`) only serve the clusters dialog's garden lookups (shoots, projects, the shoots' CA config maps as `configmaps`), staying out of the jump menu's kinds; `testdata/garden/` is the matching gardenctl home (`-garden testdata/garden` in the E2E backend: its config, a garden kubeconfig and a session target). `unfinished-pods.yaml` serves the pods the nodes' allocation columns watch (with ephemeral storage and a GPU, which `nodes.yaml`'s first node offers) (any `pods` source with the unfinished-pods field selector); its `listDelay: 1s` delays the first list, as a big cluster would (the loading state).

## Tests

| Suite | What | Run |
|---|---|---|
| Goldens | `internal/view/testdata/*.golden`: tapes replayed through the view, frames compared to the golden files. They are the spec: change them only with `make golden-update` and review that diff on its own. | `make test-go` |
| Properties | `rapid`: sort doesn't affect markers, a no-op relist produces no frame, rows never leave the viewport, no unchanged resends. | `make test-go` |
| Bridge budget | 10k objects under an event storm → ≤ 10 Hz, ≤ viewport rows per frame. | `make test-go` |
| Catalog | never connects to a context without an open pane; partial discovery stays usable; failed refreshes keep the last good state; CRD/namespace watches and resolve misses trigger refetches. | `make test-go` |
| Frontend units | keymap (collisions, suppressed webview defaults), layout/command/MRU invariants under 3000 random ops, directional tile focus, cell layout, row cache, completion ranking, cheat sheet and row menu completeness. | `make test-fe` (or `npx vitest run` in `frontend/`) |
| E2E | Playwright drives Chromium against the headless backend; asserts via `window.__kw.inspect()` and ARIA snapshots, never pixels. | `make e2e` |
| Lint | `gofmt`, and no raw colors outside theme tokens (`frontend/scripts/lint-tokens.mjs`). | `make lint` |

Inside a sandbox, Go needs a writable build cache: `GOCACHE=$TMPDIR/gocache go test ./internal/...`.

## Docs

- [README.md](README.md): what kubewing is and its highlights, nothing exhaustive.
- [Manual.md](Manual.md): every user-facing feature. A finished feature is documented here.
- [Architecture.md](Architecture.md): design, decisions, internals.
- [Plan.md](Plan.md): only what's not done yet. A finished item leaves it (into the manual).
