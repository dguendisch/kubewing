import { defineConfig } from "vitest/config";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  // headless/E2E mode talks to the Go backend via WebSocket (see src/transport)
  server: { proxy: { "/kw-ws": { target: "ws://127.0.0.1:7777", ws: true } } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
