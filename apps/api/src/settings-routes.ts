import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  HealthzUnavailableBody,
  SettingsResponse,
  SettingsUpdateBody,
  SyncStatusResponse,
} from "@mail-hub/contracts";
import type { HealthService } from "@mail-hub/observability";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { SettingsError, type MutationContext, type SettingsService } from "@mail-hub/settings";
import { AuthError } from "@mail-hub/auth";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";

/**
 * Settings routes (SPEC F10) and the per-account synchronization status the
 * settings screen shows. Reads need a session; a settings change also needs
 * the deployed origin and the recovery generation the client captured, which
 * the service checks before it writes (SPEC section 7, step 1). The sync
 * status reads the same durable records as `GET /healthz`, so the interface
 * and the health check can never disagree.
 */

/** The service surface the routes need. `SettingsService` satisfies it. */
export type SettingsServiceForRoutes = Pick<SettingsService, "readSettings" | "updateSettings">;

export interface SettingsRoutesOptions {
  service: SettingsServiceForRoutes;
  /** Assembles the per-account sync and queue report. */
  health: Pick<HealthService, "readHealth">;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

/** Register the settings and sync-status routes under one error handler. */
export async function registerSettingsRoutes(
  app: FastifyInstance,
  options: SettingsRoutesOptions,
): Promise<void> {
  const { service, health, origin, verifySession } = options;

  await app.register(async function settingsRoutes(scope) {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof SettingsError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof AuthError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof RecoveryBlockedError) {
        return reply.code(error.httpStatus).send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentGeneration === undefined ? {} : { currentGeneration: error.currentGeneration }),
          },
        });
      }
      return reply.send(error);
    });

    scope.get<{ Reply: SettingsResponse }>("/settings", { preHandler: [requireSession] }, async () => ({
      settings: await service.readSettings(),
    }));

    scope.put<{ Body: SettingsUpdateBody; Reply: SettingsResponse }>(
      "/settings",
      {
        schema: {
          body: {
            type: "object",
            properties: {
              theme: { enum: ["system", "light", "dark"] },
              density: { enum: ["compact", "comfortable"] },
              singleKeyShortcuts: { type: "boolean" },
              cleanViewDefault: { type: "boolean" },
              classificationEnabled: { type: "boolean" },
              classificationMonthlyCostCapUsd: {
                anyOf: [{ type: "number", minimum: 0, maximum: 1_000_000 }, { type: "null" }],
              },
              backfillClassification: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => {
        const context: MutationContext = { requestGeneration: readRequestGeneration(request) };
        return { settings: await service.updateSettings(context, request.body) };
      },
    );

    scope.get<{ Reply: SyncStatusResponse | HealthzUnavailableBody }>(
      "/sync/status",
      { preHandler: [requireSession] },
      async (_request, reply) => {
        const report = await health.readHealth();
        if (!report.available) {
          return reply
            .code(503)
            .send({ error: { code: "database_unavailable", message: "The database cannot be reached." } });
        }
        return reply.send({
          checkedAt: report.report.checkedAt,
          queue: report.report.queue,
          sends: report.report.sends,
          classification: report.report.classification,
          accounts: report.report.accounts,
        });
      },
    );
  });

  /** Cross-site requests must present the deployed origin (SPEC section 9). */
  async function requireOrigin(request: FastifyRequest): Promise<void> {
    if (request.headers.origin !== origin) {
      throw new AuthError(
        "origin_forbidden",
        "Requests must come from the deployed origin of this application.",
      );
    }
  }

  /** Resolve the session cookie before an authenticated route runs. */
  async function requireSession(request: FastifyRequest): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined || token === "") {
      throw new AuthError("unauthorized", "Sign in to continue.");
    }
    await verifySession(token);
  }
}
