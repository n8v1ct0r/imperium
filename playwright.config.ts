// Browser checks for the static demo console: `pnpm build`, then `pnpm test:e2e`.
// Headless Chrome needs SwiftShader for WebGL. PLAYWRIGHT_CHROME may point at a cached
// Chrome for Testing build when the pinned headless shell is not installed.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
      ...(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {}),
    },
  },
  webServer: {
    command: "python3 -m http.server 4173 --bind 127.0.0.1 --directory apps/console/out",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
});
