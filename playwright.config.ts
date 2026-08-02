import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e suite exists for one reason: jsdom has no layout engine, so vitest
 * cannot see a chart panel collapsed to zero height. These tests run in a real
 * browser at real viewport sizes.
 *
 * They run against the **production preview**, not the dev server, because the
 * GitHub Pages base path (/spikePhysics/) only exists in a build — a runtime
 * asset path that 404s in production would otherwise slip through.
 */
const PORT = 4173;
const BASE_PATH = "/spikePhysics/";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: `http://localhost:${PORT}${BASE_PATH}`,
    trace: "on-first-retry",
  },

  // Tablet-sized viewports in both orientations — the reported bug only shows
  // in one of them, so both are non-negotiable.
  projects: [
    {
      name: "landscape",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "portrait",
      use: { ...devices["Desktop Chrome"], viewport: { width: 800, height: 1280 } },
    },
  ],

  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
