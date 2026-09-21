import type { FastifyInstance } from "fastify";
import { API_VERSION, type HealthzResponse, type HealthzUnavailableBody } from "@mail-hub/contracts";
import type { HealthReport } from "@mail-hub/observability";

/**
 * The health check route (SPEC sections 10 and 11). The deployment platform
 * calls it without a session, so it stays public and never reads request
 * input. A failed database round trip answers `503`; every other state is
 * reported honestly with `200`, because the API must stay reachable for
 * enrollment and operator recovery while mail work is blocked.
 */

/** The service surface the route needs. `HealthService` satisfies it. */
export type HealthServiceForRoutes = {
  readHealth(): Promise<HealthReport>;
};

export interface HealthRoutesOptions {
  service: HealthServiceForRoutes;
}

const SYNC_SCHEMA = {
  type: "object",
  required: [
    "lastCycleAt",
    "cycleAgeSeconds",
    "backfillPendingFolders",
    "pendingBodies",
    "state",
    "folderErrors",
    "bodyErrors",
    "threadErrors",
    "folderFailureKinds",
    "bodyFailureKinds",
    "threadFailureKinds",
    "pendingThreads",
  ],
  properties: {
    lastCycleAt: { type: ["string", "null"] },
    cycleAgeSeconds: { type: ["integer", "null"], minimum: 0 },
    backfillPendingFolders: { type: ["integer", "null"], minimum: 0 },
    pendingBodies: { type: "integer", minimum: 0 },
    state: { enum: ["ok", "syncing", "degraded", "stale", "unknown"] },
    folderErrors: { type: ["integer", "null"], minimum: 0 },
    bodyErrors: { type: ["integer", "null"], minimum: 0 },
    threadErrors: { type: ["integer", "null"], minimum: 0 },
    // Approved failure codes only: no folder names, no mail text, no error
    // detail reaches this public response.
    folderFailureKinds: { type: ["array", "null"], items: { type: "string" } },
    bodyFailureKinds: { type: ["array", "null"], items: { type: "string" } },
    threadFailureKinds: { type: ["array", "null"], items: { type: "string" } },
    pendingThreads: { type: ["integer", "null"], minimum: 0 },
  },
} as const;

const METRICS_SCHEMA = {
  type: "object",
  required: [
    "messagesSynced",
    "bodiesFetched",
    "lastFullReconciliationAt",
    "jevCalls",
    "jevErrors",
  ],
  properties: {
    messagesSynced: { type: "integer", minimum: 0 },
    bodiesFetched: { type: "integer", minimum: 0 },
    lastFullReconciliationAt: { type: ["string", "null"] },
    jevCalls: { type: "integer", minimum: 0 },
    jevErrors: { type: "integer", minimum: 0 },
  },
} as const;

const ACCOUNT_SCHEMA = {
  type: "object",
  required: ["accountId", "sync", "metrics"],
  properties: {
    accountId: { type: "string", format: "uuid" },
    sync: SYNC_SCHEMA,
    metrics: METRICS_SCHEMA,
  },
  // The check is public: anything the report carries beyond these fields
  // must not reach an unauthenticated caller.
  additionalProperties: false,
} as const;

const HEALTHZ_SCHEMA = {
  type: "object",
  required: [
    "service",
    "status",
    "version",
    "checkedAt",
    "database",
    "recovery",
    "queue",
    "classification",
    "sends",
    "accounts",
  ],
  properties: {
    service: { const: "api" },
    status: { enum: ["ok", "degraded"] },
    version: { const: API_VERSION },
    checkedAt: { type: "string" },
    database: {
      type: "object",
      required: ["state", "roundTripMs"],
      properties: {
        state: { const: "ok" },
        roundTripMs: { type: "integer", minimum: 0 },
      },
    },
    recovery: {
      type: "object",
      required: ["state", "mode", "description"],
      properties: {
        state: {
          enum: ["ready", "reconciling", "generation_mismatch", "uninitialized", "config_missing", "unknown"],
        },
        mode: { enum: ["ready", "reconciling", null] },
        description: { type: "string" },
      },
      additionalProperties: false,
    },
    queue: {
      type: "object",
      required: [
        "state",
        "depth",
        "oldestJobAt",
        "oldestJobAgeSeconds",
        "oldestPendingWorkAt",
        "oldestPendingWorkAgeSeconds",
      ],
      properties: {
        state: { enum: ["ok", "unknown"] },
        depth: { type: ["integer", "null"], minimum: 0 },
        oldestJobAt: { type: ["string", "null"] },
        oldestJobAgeSeconds: { type: ["integer", "null"], minimum: 0 },
        oldestPendingWorkAt: { type: ["string", "null"] },
        oldestPendingWorkAgeSeconds: { type: ["integer", "null"], minimum: 0 },
      },
    },
    classification: {
      type: "object",
      required: ["circuit", "calls", "errors", "description"],
      properties: {
        circuit: { enum: ["closed", "open", "not_configured", "unknown"] },
        calls: { type: "integer", minimum: 0 },
        errors: { type: "integer", minimum: 0 },
        description: { type: "string" },
      },
    },
    sends: {
      type: "object",
      required: ["queued", "failed", "outcomeUnknown"],
      properties: {
        queued: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        outcomeUnknown: { type: "integer", minimum: 0 },
      },
    },
    accounts: { type: "array", items: ACCOUNT_SCHEMA },
  },
} as const;

const UNAVAILABLE_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { const: "database_unavailable" },
        message: { type: "string" },
      },
    },
  },
} as const;

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions,
): Promise<void> {
  app.get<{ Reply: HealthzResponse | HealthzUnavailableBody }>("/healthz", {
    schema: {
      response: {
        200: HEALTHZ_SCHEMA,
        503: UNAVAILABLE_SCHEMA,
      },
    },
  }, async (_request, reply) => {
    const health = await options.service.readHealth();
    if (!health.available) {
      return reply.code(503).send({
        error: {
          code: "database_unavailable",
          message: "The database round trip failed, so no health state can be reported.",
        },
      });
    }
    return reply.code(200).send(health.report);
  });
}
