import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type PlaywrightWorkerOptions } from "@playwright/test";
import { allocatePort } from "./e2e/fixture-launch.mjs";
import { sweepAbandonedDirs } from "./e2e/run-isolation.mjs";

/** This config file's directory: the anchor for the run-results root. */
const configDir = dirname(fileURLToPath(import.meta.url));

/*
 * Browser checks for the interface (SPEC section 12, "Interface acceptance"
 * and F12). One fixture server serves the production build with the
 * fixture API behind `/api`, so every project runs against the shipped
 * client. Two projects split the suites the release gate runs separately:
 *
 * - `flows`     browser workflows: keyboard triage, the palette chord,
 *               offline fallback, and palette latency (npm run test:e2e).
 * - `interface` accessibility and visual checks: axe, screen-reader
 *               semantics, focus visibility, reduced motion, reflow, zoom,
 *               touch targets, and theme switching (npm run test:a11y).
 *
 * Every run gets its own fixture (T112): an ephemeral loopback port — or
 * the exact port `E2E_PORT` names — a build in an isolated directory, and
 * a run token the launcher serves at `/api/fixture/identity`. The web
 * server below is never reused, so a stale or foreign listener on any
 * port fails loudly instead of serving this run's tests. Global setup
 * verifies the token before the first test and the build fingerprint
 * again at teardown, so a green run proves it tested one known build.
 */

// Every worker process loads this file again, so every run-wide decision —
// port, token, results directory — must be made exactly once: the leader
// process mints it into E2E_RUN_* variables, and the workers it spawns
// inherit them and adopt the same decisions. The E2E_RUN_* variables are
// internal hand-off state; no shell needs to export them.
const isLeader = process.env.E2E_RUN_TOKEN === undefined;
if (isLeader) {
  if (process.env.E2E_PORT === undefined) {
    process.env.E2E_PORT = String(await allocatePort(undefined));
  }
  process.env.E2E_RUN_TOKEN = randomUUID();
  process.env.E2E_RUN_PID = String(process.pid);
  // Retire the results directories of runs whose process is gone; a live
  // run keeps its directories however long it runs.
  await sweepAbandonedDirs(join(configDir, "test-results"), "run-");
}
const port = await allocatePort(process.env.E2E_PORT);
const runToken = process.env.E2E_RUN_TOKEN;
const runPid = process.env.E2E_RUN_PID;
if (runToken === undefined || runPid === undefined) {
  // Only reachable if a shell exported a partial E2E_RUN_* set.
  throw new Error(
    "playwright.config.ts: E2E_RUN_TOKEN or E2E_RUN_PID is set but not both; they are internal run hand-off variables. Unset them.",
  );
}
const baseURL = `http://127.0.0.1:${port}`;
// SPEC F12 records the browsers a release check ran on. The default stays
// the cached Linux Chromium; a macOS machine overrides the channel, for
// example E2E_BROWSER_CHANNEL=safari or chrome, and runs the same suites.
const browserChannel = process.env.E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: "e2e",
  // One output directory per run, named after the run's leader pid, so
  // concurrent runs never write into each other's traces and artifacts and
  // the sweep above can tell an abandoned directory from a live run's.
  outputDir: join("test-results", `run-${runPid}-${runToken.slice(0, 8)}`),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Keep the visual baselines free of platform and project suffixes, so one
  // committed set matches every run of the interface project.
  snapshotPathTemplate: "{snapshotDir}/{testFileDir}/__screenshots__/{testFileName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  reporter: [["list"]],
  // Before the first test: the server answering this run's port carries
  // this run's token. At teardown: it still carries this run's build
  // fingerprint, so nothing rebuilt or replaced the build mid-run.
  globalSetup: "./e2e/fixture-global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    // Pin the locale the interface formats dates and counts with.
    locale: "en-US",
    timezoneId: "UTC",
    // The cache matches the fixture's server default of Inbox. Home checks
    // enable the server preference through `openHome`; offline checks use
    // the last confirmed cache when the settings request cannot finish.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [{ name: "mail-hub.home-startup", value: "false" }],
        },
      ],
    },
    ...(browserChannel === undefined
      ? {}
      : { channel: browserChannel as PlaywrightWorkerOptions["channel"] }),
  },
  webServer: {
    command: "node e2e/fixture-launch.mjs",
    url: `${baseURL}/api/fixture/identity`,
    // Never reuse a server already on the port, locally or in CI: reuse is
    // how a stale build answered a run's tests. The launcher answers 503
    // while it builds, then 200 with this run's identity.
    reuseExistingServer: false,
    timeout: 300_000,
    // Without this, Playwright SIGKILLs the process group on teardown and the
    // launcher's cleanup (remove its build directory, close its listener)
    // never runs. The SIGTERM handler finishes in milliseconds; the timeout
    // only backstops a hang with a force kill.
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    stdout: "pipe",
    env: { ...process.env, E2E_PORT: String(port), E2E_RUN_TOKEN: runToken },
  },
  projects: [
    { name: "flows", testMatch: /flows\.browser\.ts$/u },
    { name: "interface", testMatch: /interface\.browser\.ts$/u },
  ],
});
