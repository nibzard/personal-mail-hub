import { describe, expect, it } from "vitest";
import type { HealthzResponse } from "@mail-hub/contracts";
import type { HealthReport } from "@mail-hub/observability";
import { buildApp } from "../src/app.ts";
import { registerHealthRoutes, type HealthServiceForRoutes } from "../src/health-routes.ts";

/**
 * Route behavior only (SPEC sections 10 and 11): the check stays public, a
 * reachable database answers `200` whatever the recovery state says, and a
 * failed round trip answers `503` with the error body. The report itself is
 * covered by the `@mail-hub/observability` suite.
 */

const READY_REPORT: HealthzResponse = {
  service: "api",
  status: "ok",
  version: "v1",
  checkedAt: "2026-09-19T12:00:00.000Z",
  database: { state: "ok", roundTripMs: 4 },
  recovery: {
    state: "ready",
    mode: "ready",
    description: "Deployment and database recovery state agree; mail mutations are allowed.",
  },
  queue: {
    state: "ok",
    depth: 0,
    oldestJobAt: null,
    oldestJobAgeSeconds: null,
    oldestPendingWorkAt: null,
    oldestPendingWorkAgeSeconds: null,
  },
  classification: {
    circuit: "not_configured",
    calls: 0,
    errors: 0,
    description: "Jev classification is not configured.",
  },
  sends: { queued: 0, failed: 0, outcomeUnknown: 0 },
  accounts: [],
};

const DEGRADED_REPORT: HealthzResponse = {
  ...READY_REPORT,
  status: "degraded",
  recovery: {
    state: "reconciling",
    mode: "reconciling",
    description: "A restore is being reconciled.",
  },
};

const UNAVAILABLE: HealthReport = {
  available: false,
  database: { state: "unavailable", roundTripMs: null },
  checkedAt: "2026-09-19T12:00:00.000Z",
};

function fakeService(report: HealthReport): HealthServiceForRoutes {
  return { readHealth: async () => report };
}

describe("health routes", () => {
  it("answers an unauthenticated ready report with 200", async () => {
    const app = buildApp();
    await registerHealthRoutes(app, { service: fakeService({ available: true, report: READY_REPORT }) });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(READY_REPORT);
    await app.close();
  });

  it("still answers 200 while degraded, so recovery stays observable", async () => {
    const app = buildApp();
    await registerHealthRoutes(app, { service: fakeService({ available: true, report: DEGRADED_REPORT }) });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEGRADED_REPORT);
    await app.close();
  });

  it("answers 503 with the error body when the round trip fails", async () => {
    const app = buildApp();
    await registerHealthRoutes(app, { service: fakeService(UNAVAILABLE) });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "database_unavailable",
        message: "The database round trip failed, so no health state can be reported.",
      },
    });
    await app.close();
  });
});
