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
make e2e GREP='ctrl.tab'   # only tests whose title (incl. describe) matches the regex
make e2e FAILED=1      # only the last run's failures (none: passes)
make e2e ARGS=e2e/app.spec.ts:123   # anything else for `playwright test` (a line, --headed, --debug, …)
make headless          # backend over WebSocket on :7777 replaying tapes + testdata/catalog.yaml (TAPES= for your real kubeconfig)
make golden-update     # regenerate the view goldens, then review the diff on its own
make icon              # regenerate the app icon from build/appicon.svg
make dist              # the release zip: bin/kubewing-<version>-macos-arm64.zip (+ .sha256)
make sign              # its signature for the updater (.sig), key in $KUBEWING_SIGNING_KEY (see Release signing)
make release BUMP=…    # tag the next release (see Releases)
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

Scenario tapes (`testdata/tapes/*.yaml`) are scripted fake clusters: starting objects plus timed watch events (add, update, delete, relist, recreate under the same name). They drive the goldens, and the headless E2E backend. `testdata/catalog.yaml` is the fake catalog for completion. `filter: true` tapes (`rel-*`) honor namespace and selectors and serve metadata, acting as a fake API for the jump menu (a tape serves its first object's kind; a group without a version, as in RBAC's `apiGroup`, takes any tape of that group and kind). The headless backend also fakes actions (an echo shell, port-forward, logs). `rel-services` serves services for port-forward: their selectors pick `rel-pods`' pods (`web-7d9f-a` is the ready one, so it's chosen), with a named target port, a UDP-only port, one without a selector and one matching no pods. A tape's `metrics:` (usage by `namespace/name`, `/name` for nodes) fakes metrics.k8s.io for the metric columns; a tape without it is a cluster without metrics-server. `lookupOnly: true` tapes (`garden-*`) only serve the clusters dialog's garden lookups (shoots, projects, the shoots' CA config maps as `configmaps`), staying out of the jump menu's kinds; `testdata/garden/` is the matching gardenctl home (`-garden testdata/garden` in the E2E backend: its config, a garden kubeconfig and a session target). `unfinished-pods.yaml` serves the pods the nodes' allocation columns watch (with ephemeral storage and a GPU, which `nodes.yaml`'s first node offers) (any `pods` source with the unfinished-pods field selector); its `listDelay: 1s` delays the first list, as a big cluster would (the loading state).

## Tests

| Suite | What | Run |
|---|---|---|
| Goldens | `internal/view/testdata/*.golden`: tapes replayed through the view, frames compared to the golden files. They are the spec: change them only with `make golden-update` and review that diff on its own. | `make test-go` |
| Properties | `rapid`: sort doesn't affect markers, a no-op relist produces no frame, rows never leave the viewport, no unchanged resends. | `make test-go` |
| Bridge budget | 10k objects under an event storm → ≤ 10 Hz, ≤ viewport rows per frame. | `make test-go` |
| Catalog | never connects to a context without an open pane; partial discovery stays usable; failed refreshes keep the last good state; CRD/namespace watches and resolve misses trigger refetches. | `make test-go` |
| Frontend units | keymap (collisions, suppressed webview defaults), layout/command/MRU invariants under 3000 random ops, directional tile focus, cell layout, row cache, completion ranking, cheat sheet and row menu completeness. | `make test-fe` (or `npx vitest run` in `frontend/`) |
| E2E | Playwright drives Chromium against the headless backend; asserts via `window.__kw.inspect()` and ARIA snapshots, never pixels. The backend gets an empty `KUBECONFIG`: a tape pane counts as the current context, so your own kubeconfig's (e.g. a gardenctl target) would leak into the tests. | `make e2e` |
| Lint | `gofmt`, and no raw colors outside theme tokens (`frontend/scripts/lint-tokens.mjs`). | `make lint` |

Inside a sandbox, Go needs a writable build cache: `GOCACHE=$TMPDIR/gocache go test ./internal/...`. The local-terminal PTY tests (`TestRunPTY*` in `internal/source`) skip where `/dev/ptmx` can't be opened (the macOS sandbox); run them outside it.

## Releases

### Changelog

`Changelog.md` records what changed for users, newest first: entries go under `## [Unreleased]`, grouped as `### Added` (new features), `### Changed` (changed behavior), `### Fixed` (bugs) and `### Removed`. One line per change, written for users like the manual (no internal names). Tests, refactoring, CI and tooling get no entry. The released sections (`## [X.Y.Z] - YYYY-MM-DD`) are written by `make release`, not by hand.

### Releasing

A release is a pushed tag `vX.Y.Z` (or a release candidate `vX.Y.Z-rc.N`). `make release` creates it locally, pushing it is up to you. First make sure `Changelog.md`'s `## [Unreleased]` section lists the release's changes:

```sh
make release BUMP=minor RC=1   # v0.2.0-rc.1; again: v0.2.0-rc.2, …
make release BUMP=minor        # v0.2.0: promotes the candidates (the same commit or a later one)
make release BUMP=patch        # v0.2.1
make release BUMP=major DRY=1  # only shows the next tag and its notes
git push --atomic origin main v0.2.0   # publishes a final (and its changelog commit)
git push origin v0.2.0-rc.1    # publishes a candidate
```

- The bump counts from the newest final release (no release yet: from `0.0.0`, so the first `BUMP=minor` is `v0.1.0`). Candidates count per version, so `BUMP=minor RC=1` after `v0.2.0-rc.2` is `v0.2.0-rc.3`.
- It refuses unless you're on `main` with a clean working tree and `main` equals `origin/main` (the tag must point at a commit GitHub has), and one commit gets one release (only a final may join its own candidates). It runs `make test` first (`SKIP_TESTS=1` skips it).
- The release notes are `Changelog.md`'s `## [Unreleased]` section (it refuses an empty one). Check them with `DRY=1` first: nothing asks before tagging, since nothing is published before the push. A final then stamps the section (`## [Unreleased]` stays, empty, above `## [X.Y.Z] - date`) and commits that as `release: vX.Y.Z`, so the tag points at that commit; a candidate commits nothing and its notes are the whole section so far. The annotated tag's message carries the notes. A tag pushed by mistake: `git push origin :refs/tags/vX.Y.Z` before the workflow publishes, else delete the release on GitHub too.
- Pushing the tag runs `.github/workflows/release.yml` on a macOS arm64 runner: it checks the tag is annotated and on `main`, runs `make test`, `make dist VERSION=X.Y.Z`, signs the zip (`make sign`, see Release signing), and publishes a GitHub release with the zip, its `.sha256` and `.sig`, the tag message as notes. Candidates become pre-releases; a final is marked latest. Started by hand (Actions → release → Run workflow) it only builds, and the zip is a workflow artifact for 7 days.
- Nothing in the repository holds the version (the changelog's headings only record it): `make` reads it from the tag (`git describe`: `0.2.0`, `0.2.0-3-gabc1234` after it, `-dirty` with changes; `0.0.0-dev` without tags) or takes `VERSION=`. It goes into the binary (`internal/app.Version`, shown by `-version` and the About box) and the bundle's `Info.plist`; `build/darwin/Info.plist` is the template.
- The zip is ad-hoc signed (`codesign -s -`), not notarized (needs a paid Apple developer account). See the [manual](Manual.md#installing) for what users do on first launch.

### Release signing

The updater installs only zips signed with the release key (see [Architecture.md](Architecture.md#updates)). Set it up once, before the first release that ships the updater:

```sh
go run ./internal/update/cmd/releasesign -keygen
```

- The private key goes into the repository's Actions secret `KUBEWING_SIGNING_KEY` (Settings → Secrets and variables → Actions). Keep a copy offline, e.g. in a password manager: nothing else can sign releases the installed apps accept.
- The public key goes into `build/release-key.pub` (one line), committed. `make` builds it into the binary. A build without the file checks for updates but can't install them.
- Once `build/release-key.pub` is committed, the workflow refuses to publish a release without the secret. `make sign` also checks that the secret matches the committed public key.
- Rotating: the apps out there only trust the key they were built with. Ship the new public key in a release still signed with the old key, and switch the secret only after that.

### Trying the updater

`make try-update` starts the app with a fake release list, so you don't need to publish releases to see the update UI. The app poses as 0.1.0 and reads `testdata/releases.json`; `CURRENT=` and `RELEASES=` change either. It runs as a kubewing of its own (`-new-process`), beside an installed one. The automatic check runs 10 s after the start, and **kubewing → Check for Updates…** works too. Update goes through the dialog's confirmation and a pretend download, verify and install, then fails with "simulated", leaving everything untouched. The skipped version and last check are kept in memory only, so `update.json` stays as it was. To see candidates offered, set `update.prereleases: true` in the config.

The flags behind it are `-releases <file>` and `-releases-current <version>`. The headless backend (`make headless`, E2E) takes them too, but checks only on request (`__kw.dispatch("update.check")` in the browser console) and offers "download…" only. To try a real install: build the app with an older `VERSION=` (and the release key), copy it to a folder you own, and start it from there.

## Docs

- [README.md](README.md): what kubewing is and its highlights, nothing exhaustive.
- [Manual.md](Manual.md): every user-facing feature. A finished feature is documented here.
- [Architecture.md](Architecture.md): design, decisions, internals.
- [Plan.md](Plan.md): only what's not done yet. A finished item leaves it (into the manual).
