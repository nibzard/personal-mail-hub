import { defineConfig, type PlaywrightWorkerOptions } from "@playwright/test";

/*
 * Browser checks for the interface (SPEC section 12, "Interface acceptance"
 * and F12). One fixture server serves the production `dist` build with the
 * fixture API behind `/api`, so every project runs against the shipped
 * client. Two projects split the suites the release gate runs separately:
 *
 * - `flows`     browser workflows: keyboard triage, the palette chord,
 *               offline fallback, and palette latency (npm run test:e2e).
 * - `interface` accessibility and visual checks: axe, screen-reader
 *               semantics, focus visibility, reduced motion, reflow, zoom,
 *               touch targets, and theme switching (npm run test:a11y).
 */

const port = Number(process.env.E2E_PORT ?? 4180);
const baseURL = `http://127.0.0.1:${port}`;
// SPEC F12 records the browsers a release check ran on. The default stays
// the cached Linux Chromium; a macOS machine overrides the channel, for
// example E2E_BROWSER_CHANNEL=safari or chrome, and runs the same suites.
const browserChannel = process.env.E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Keep the visual baselines free of platform and project suffixes, so one
  // committed set matches every run of the interface project.
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/__screenshots__/{testFileName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    // Pin the locale the interface formats dates and counts with.
    locale: "en-US",
    timezoneId: "UTC",
    ...(browserChannel === undefined
      ? {}
      : { channel: browserChannel as PlaywrightWorkerOptions["channel"] }),
  },
  webServer: {
    command: "npm run build && node e2e/fixture-server.mjs",
    url: `${baseURL}/api/auth/status`,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 120_000,
    stdout: "ignore",
  },
  projects: [
    { name: "flows", testMatch: /flows\.browser\.ts$/u },
    { name: "interface", testMatch: /interface\.browser\.ts$/u },
  ],
});
