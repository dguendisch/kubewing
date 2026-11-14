import { defineConfig } from "@playwright/test";

/**
 * E2E on meaning: Chromium against the headless Go backend replaying
 * scenario tapes (../testdata/tapes). Assertions use window.__kw.inspect()
 * and ARIA snapshots, never pixels.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 20_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5199", viewport: { width: 1400, height: 800 } },
  webServer: [
    {
      // KUBECONFIG: an empty one, never the developer's: a tape pane is the "current context", and
      // what kubewing reads from a real kubeconfig's (gardenlogin: ⌘⇧P's target) would leak in
      command: "bash e2e/backend.sh",
      url: "http://127.0.0.1:7777/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      stdout: "pipe",
    },
    {
      command: "VITE_KW_TRANSPORT=ws ./node_modules/.bin/vite --host 127.0.0.1 --port 5199 --strictPort",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
