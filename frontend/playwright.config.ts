import { defineConfig } from "@playwright/test";

const goEnv = ". ../.cache/env.sh && export GOPROXY=off GOFLAGS=-mod=mod";

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
      command: `${goEnv} && cd .. && go run . -headless 127.0.0.1:7777 -tapes testdata/tapes -catalog testdata/catalog.yaml -config testdata/config -garden testdata/garden -state "$(mktemp -d)"`,
      url: "http://127.0.0.1:7777/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
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
