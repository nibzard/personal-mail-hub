import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MailActionResponse, SubmitMailActionBody } from "@mail-hub/contracts";
import {
  ACTION_KINDS,
  ActionError,
  MAX_ACTION_TARGETS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type ActionReceipt,
  type ActionService,
  type MailActionSubmission,
} from "@mail-hub/actions";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { AuthError } from "@mail-hub/auth";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";

/**
 * Mail action routes (SPEC F4 and section 7). Submitting is a state change:
 * it needs the deployed origin, a live session, and the recovery generation
 * the client captured, which the action service checks before its
 * idempotency lookup (SPEC section 7, step 1). Reading one receipt needs a
 * session only. The API never executes; the worker re-drives pending items
 * over the account's open mailbox session.
 */

/** The service surface the routes need. `ActionService` satisfies it. */
export type ActionServiceForRoutes = Pick<ActionService, "submit" | "receipt">;

export interface ActionRoutesOptions {
  service: ActionServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F-]{36}$";

const actionParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

/** Register the action routes under a scoped error handler. */
export async function registerActionRoutes(
  app: FastifyInstance,
  options: ActionRoutesOptions,
): Promise<void> {
  const { service, origin } = options;

  await app.register(async function actionRoutes(scope) {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ActionError) {
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

    scope.post<{ Body: SubmitMailActionBody; Reply: MailActionResponse }>(
      "/actions",
      {
        schema: {
          body: {
            type: "object",
            required: ["accountId", "kind", "idempotencyKey", "occurrenceIds"],
            properties: {
              accountId: { type: "string", pattern: UUID_PATTERN },
              kind: { type: "string", enum: [...ACTION_KINDS] },
              idempotencyKey: { type: "string", minLength: 1, maxLength: MAX_IDEMPOTENCY_KEY_LENGTH },
              occurrenceIds: {
                type: "array",
                minItems: 1,
                maxItems: MAX_ACTION_TARGETS,
                items: { type: "string", pattern: UUID_PATTERN },
              },
              destinationFolderId: { type: "string", pattern: UUID_PATTERN },
            },
            // A move or archive must freeze the destination it names (SPEC F4);
            // the service checks the same rule again for other callers.
            allOf: [
              {
                if: { properties: { kind: { enum: ["move", "archive"] } } },
                then: { required: ["destinationFolderId"] },
              },
            ],
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        const submission: MailActionSubmission = {
          accountId: request.body.accountId,
          kind: request.body.kind,
          idempotencyKey: request.body.idempotencyKey,
          occurrenceIds: request.body.occurrenceIds,
          ...(request.body.destinationFolderId === undefined
            ? {}
            : { destinationFolderId: request.body.destinationFolderId }),
          recoveryGeneration: readRequestGeneration(request) ?? "",
        };
        const result = await service.submit(submission);
        return reply.code(result.created ? 201 : 200).send({ action: toReceiptView(result.receipt) });
      },
    );

    scope.get<{ Params: { id: string }; Reply: MailActionResponse }>(
      "/actions/:id",
      { schema: { params: actionParams }, preHandler: [requireSession] },
      async (request) => ({ action: toReceiptView(await service.receipt(request.params.id)) }),
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

/** One receipt in its wire form: the statuses, never the frozen targets. */
function toReceiptView(receipt: ActionReceipt): MailActionResponse["action"] {
  return {
    actionId: receipt.actionId,
    kind: receipt.kind,
    status: receipt.status,
    idempotencyKey: receipt.idempotencyKey,
    items: receipt.items.map((item) => ({
      itemKey: item.itemKey,
      status: item.status,
      outcome: item.outcome,
    })),
  };
}
