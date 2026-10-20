# Tests

- e2e (Playwright): run only `make e2e` from the repo root, outside the sandbox. Chromium needs Mach ports, so it can't run inside the macOS sandbox.
- Never call `npx playwright test` or `npx playwright install` directly. The browsers are already in `.cache/ms-playwright`, and only the Makefile points Playwright there (`PLAYWRIGHT_BROWSERS_PATH`). Without it, Playwright wrongly reports the browsers as missing.
- Unit tests (`npx vitest run` in `frontend/`) run fine inside the sandbox.
