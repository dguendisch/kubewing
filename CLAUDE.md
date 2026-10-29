# Docs

- A finished feature is documented in `Manual.md` (in its chapter, written for users: no internal names) and its item leaves `Plan.md`, which lists only what's not done. Open follow-ups go to Plan.md's "Follow-ups of done features".
- Design decisions and internals go to `Architecture.md`; build/test changes to `Development.md`.
- `README.md` keeps only the highlights.

# Tests

- e2e (Playwright): run only `make e2e` from the repo root, outside the sandbox. Chromium needs Mach ports, so it can't run inside the macOS sandbox.
- Never call `npx playwright test` or `npx playwright install` directly. The browsers are already in `.cache/ms-playwright`, and only the Makefile points Playwright there (`PLAYWRIGHT_BROWSERS_PATH`). Without it, Playwright wrongly reports the browsers as missing.
- Unit tests (`npx vitest run` in `frontend/`) run fine inside the sandbox.
