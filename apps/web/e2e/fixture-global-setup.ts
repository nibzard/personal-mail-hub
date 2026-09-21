import type { FullConfig } from "@playwright/test";
import { verifyFixtureIdentity } from "./fixture-launch.mjs";

/*
 * Global setup (T112): before the first test, prove the server answering
 * this run's port is the launcher this run started — it carries this run's
 * token — and record its build fingerprint. The returned teardown proves
 * the fingerprint again, so a green run also proves the build under test
 * never changed mid-run.
 *
 * The config load hands the token over through `process.env.E2E_RUN_TOKEN`
 * (Playwright loads the config and runs global setup in one process); the
 * base URL comes from the resolved config, whose projects each inherit the
 * top-level `use.baseURL`.
 */
export default async function fixtureGlobalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  const runToken = process.env.E2E_RUN_TOKEN;
  if (baseURL === undefined || baseURL.length === 0 || runToken === undefined || runToken.length === 0) {
    throw new Error(
      "fixture global setup: the config did not hand over its base URL and run token; " +
        "the run cannot prove which server it tests. Refusing to start.",
    );
  }
  const start = await verifyFixtureIdentity({ baseURL, expectedToken: runToken });
  return async () => {
    await verifyFixtureIdentity({
      baseURL,
      expectedToken: runToken,
      expectedFingerprint: start.fingerprint,
    });
  };
}
