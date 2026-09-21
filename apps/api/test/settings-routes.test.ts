import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  SettingsResponse,
  SyncStatusResponse,
} from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import type { HealthReport } from "@mail-hub/observability";
import { SettingsError, type MutationContext } from "@mail-hub/settings";
import { buildApp } from "../src/app.ts";
import { registerSettingsRoutes } from "../src/settings-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F10 and section 7): origin and session
 * enforcement, recovery-generation forwarding, error mapping, and the sync
 * status body. Storage and validation are covered by the
 * `@mail-hub/settings` suite.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const GENERATION = "11111111-1111-4111-8111-111111111111";

const SETTINGS: SettingsResponse["settings"] = {
  theme: "system",
  density: "compact",
  singleKeyShortcuts: true,
  cleanViewDefault: false,
  classificationEnabled: false,
  homeEnabled: true,
  classificationMonthlyCostCapUsd: null,
  backfillClassification: false,
};

const SYNC_REPORT: SyncStatusResponse = {
  checkedAt: "2026-09-19T10:00:00.000Z",
  queue: {
    state: "ok",
    depth: 2,
    oldestJobAt: "2026-09-19T09:59:00.000Z",
    oldestJobAgeSeconds: 60,
    oldestPendingWorkAt: null,
    oldestPendingWorkAgeSeconds: null,
  },
  sends: { queued: 1, failed: 0, outcomeUnknown: 0 },
  classification: {
    circuit: "not_configured",
    calls: 0,
    errors: 0,
    description: "Jev classification is not configured.",
  },
  accounts: [
    {
      accountId: "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d",
      sync: {
        lastCycleAt: "2026-09-19T09:58:00.000Z",
        cycleAgeSeconds: 120,
        backfillPendingFolders: 1,
        pendingBodies: 3,
        state: "syncing",
        folderErrors: 0,
        bodyErrors: 0,
        threadErrors: 0,
        folderFailureKinds: [],
        bodyFailureKinds: [],
        threadFailureKinds: [],
        pendingThreads: 2,
      },
      metrics: {
        messagesSynced: 100,
        bodiesFetched: 97,
        lastFullReconciliationAt: null,
        jevCalls: 0,
        jevErrors: 0,
      },
    },
  ],
};

/** A controllable stand-in for the settings service. */
function fakeService(
  overrides: {
    read?: () => Promise<SettingsResponse["settings"]>;
    update?: (context: MutationContext, patch: unknown) => Promise<SettingsResponse["settings"]>;
  } = {},
) {
  const calls: { generations: (string | null | undefined)[]; patches: unknown[] } = {
    generations: [],
    patches: [],
  };
  const base = {
    async readSettings(): Promise<SettingsResponse["settings"]> {
      return overrides.read?.() ?? SETTINGS;
    },
    async updateSettings(context: MutationContext, patch: unknown): Promise<SettingsResponse["settings"]> {
      calls.generations.push(context.requestGeneration);
      calls.patches.push(patch);
      return overrides.update?.(context, patch) ?? { ...SETTINGS, ...(patch as object) };
    },
  };
  return Object.assign(base, { calls });
}

/** A stand-in for the health report the sync status reads. */
function fakeHealth(report: HealthReport | null): { readHealth(): Promise<HealthReport> } {
  return {
    async readHealth() {
      return report ?? { available: true, report: syncReportWithExtras() };
    },
  };
}

/** The full healthz shape the route trims down for the settings screen. */
function syncReportWithExtras() {
  return {
    service: "api" as const,
    status: "ok" as const,
    version: "v1" as const,
    checkedAt: SYNC_REPORT.checkedAt,
    database: { state: "ok" as const, roundTripMs: 3 },
    recovery: {
      state: "ready" as const,
      mode: "ready" as const,
      description: "ready",
    },
    queue: SYNC_REPORT.queue,
    sends: SYNC_REPORT.sends,
    classification: SYNC_REPORT.classification,
    accounts: SYNC_REPORT.accounts,
  };
}

const apps: FastifyInstance[] = [];

function appWith(
  service: ReturnType<typeof fakeService>,
  health: ReturnType<typeof fakeHealth> = fakeHealth(null),
): FastifyInstance {
  const app = buildApp();
  apps.push(app);
  void registerSettingsRoutes(app, {
    service,
    health,
    origin: ORIGIN,
    verifySession: async (token) => {
      if (token !== TOKEN) {
        throw new AuthError("unauthorized", "Sign in to continue.");
      }
      return null;
    },
  });
  return app;
}

const headers = { origin: ORIGIN };
const withCookie = { ...headers, cookie: `${SESSION_COOKIE}=${TOKEN}` };
const withGeneration = { ...withCookie, "x-recovery-generation": GENERATION };

describe("the settings routes", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("reads settings for a valid session", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({
      method: "GET",
      url: "/settings",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as SettingsResponse).settings).toEqual(SETTINGS);
  });

  it("rejects reads without a session", async () => {
    const app = appWith(fakeService());
    const missing = await app.inject({ method: "GET", url: "/settings" });
    expect(missing.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "GET",
      url: "/settings",
      headers: { cookie: `${SESSION_COOKIE}=other-token` },
    });
    expect(unknown.statusCode).toBe(401);

    const syncMissing = await app.inject({ method: "GET", url: "/sync/status" });
    expect(syncMissing.statusCode).toBe(401);
  });

  it("rejects changes without the deployed origin", async () => {
    const app = appWith(fakeService());
    const missing = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
      payload: { density: "comfortable" },
    });
    expect(missing.statusCode).toBe(403);

    const foreign = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: { origin: "https://attacker.example", cookie: `${SESSION_COOKIE}=${TOKEN}` },
      payload: { density: "comfortable" },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("forwards the recovery generation and the patch on a change", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "PUT",
      url: "/settings",
      headers: withGeneration,
      payload: { density: "comfortable", theme: "dark" },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as SettingsResponse).settings.density).toBe("comfortable");
    expect(service.calls.generations).toEqual([GENERATION]);
    expect(service.calls.patches).toEqual([{ density: "comfortable", theme: "dark" }]);
  });

  it("rejects bodies outside the settings schema", async () => {
    const app = appWith(fakeService());
    // Unknown keys are stripped by validation, so every surviving value must
    // fit its key's schema.
    for (const payload of [
      { density: "cozy" },
      { theme: "blue" },
      { classificationMonthlyCostCapUsd: -5 },
      { singleKeyShortcuts: "off" },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/settings",
        headers: withGeneration,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("maps service and recovery rejections onto their status codes", async () => {
    const invalid = appWith(
      fakeService({
        update: () => {
          throw new SettingsError("invalid_request", "Density must be compact or comfortable.");
        },
      }),
    );
    const invalidResponse = await invalid.inject({
      method: "PUT",
      url: "/settings",
      headers: withGeneration,
      payload: { density: "comfortable" },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toEqual({
      error: { code: "invalid_request", message: "Density must be compact or comfortable." },
    });

    const blocked = appWith(
      fakeService({
        update: () => {
          throw new RecoveryBlockedError("recovery_required", GENERATION);
        },
      }),
    );
    const blockedResponse = await blocked.inject({
      method: "PUT",
      url: "/settings",
      headers: withGeneration,
      payload: { density: "comfortable" },
    });
    expect(blockedResponse.statusCode).toBe(409);
    expect(blockedResponse.json().error).toMatchObject({
      code: "recovery_required",
      currentGeneration: GENERATION,
    });
  });

  it("serves the per-account sync and queue status for a valid session", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({
      method: "GET",
      url: "/sync/status",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SyncStatusResponse;
    expect(body).toEqual(SYNC_REPORT);
    expect(body.accounts[0]!.sync.pendingBodies).toBe(3);
    // The derived cycle state and its failure counters reach the settings
    // screen; a session gates them, unlike the public health check.
    expect(body.accounts[0]!.sync.state).toBe("syncing");
    expect(body.accounts[0]!.sync.pendingThreads).toBe(2);
  });

  it("answers 503 when the database round trip behind the sync status fails", async () => {
    const app = appWith(
      fakeService(),
      fakeHealth({
        available: false,
        database: { state: "unavailable", roundTripMs: null },
        checkedAt: "2026-09-19T10:00:00.000Z",
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/sync/status",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("database_unavailable");
  });
});
