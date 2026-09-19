import type { FastifyInstance, FastifyRequest } from "fastify";
import type { OutboundResponse, SendDraftRequestBody } from "@mail-hub/contracts";
import { SendError, toOutboundView, type OutboundService } from "@mail-hub/send";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { AuthError } from "@mail-hub/auth";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";

/**
 * Send routes (SPEC F7 and F9). Queueing a send is a state change: it needs
 * the deployed origin, a live session, and the recovery generation the client
 * captured, which the send service checks before its idempotency lookup
 * (SPEC section 7, step 1). Reading one outbound snapshot needs a session
 * only. The API never submits; the worker claims queued rows.
 */

/** The service surface the routes need. `OutboundService` satisfies it. */
export type SendServiceForRoutes = Pick<OutboundService, "queueSend" | "readOutbound">;

export interface SendRoutesOptions {
  service: SendServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F-]{36}$";

const draftParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const outboundParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

/** Register the send routes under a scoped error handler. */
export async function registerSendRoutes(
  app: FastifyInstance,
  options: SendRoutesOptions,
): Promise<void> {
  const { service, origin } = options;

  await app.register(async function sendRoutes(scope) {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof SendError) {
        return reply
          .code(error.httpStatus)
          .send({
            error: {
              code: error.code,
              message: error.message,
              ...(error.currentRevision === undefined
                ? {}
                : { currentRevision: error.currentRevision }),
            },
          });
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

    scope.post<{ Params: { id: string }; Body: SendDraftRequestBody; Reply: OutboundResponse }>(
      "/drafts/:id/send",
      {
        schema: {
          params: draftParams,
          body: {
            type: "object",
            required: ["idempotencyKey", "baseRevision"],
            properties: {
              idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
              baseRevision: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        const result = await service.queueSend(readContext(request), {
          draftId: request.params.id,
          idempotencyKey: request.body.idempotencyKey,
          baseRevision: request.body.baseRevision,
        });
        return reply
          .code(result.created ? 201 : 200)
          .send({ outbound: toOutboundView(result.outbound) });
      },
    );

    scope.get<{ Params: { id: string }; Reply: OutboundResponse }>(
      "/outbound/:id",
      { schema: { params: outboundParams }, preHandler: [requireSession] },
      async (request) => ({ outbound: toOutboundView(await service.readOutbound(request.params.id)) }),
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
    await options.verifySession(token);
  }
}

function readContext(request: FastifyRequest): { requestGeneration?: string | null } {
  return { requestGeneration: readRequestGeneration(request) };
}
