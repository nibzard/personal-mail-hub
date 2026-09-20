import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CORRECTION_SCOPES,
  MESSAGE_CLASSES,
  type ClassificationCorrectionBody,
  type ClassificationCorrectionResponse,
} from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { ClassificationError, type CorrectionContext, type CorrectionService } from "@mail-hub/classification";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";
import { sendUnclassifiedError } from "./http-errors.ts";

/**
 * Classification corrections (SPEC F8): the route the reader's suggestion
 * feeds. A correction names its scope — this message only, this sender, or
 * the deterministic rule — and is a durable client mutation, so it needs the
 * deployed origin, a live session, and the recovery generation the client
 * captured, exactly like a settings change (SPEC section 7, step 1).
 */

/** The service surface the routes need. `CorrectionService` satisfies it. */
export type CorrectionServiceForRoutes = Pick<CorrectionService, "correct">;

export interface ClassificationRoutesOptions {
  service: CorrectionServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** The longest note one correction may carry; the service repeats the rule. */
const MAX_NOTE_CHARS = 2_000;

/** Register the correction route under a scoped error handler. */
export async function registerClassificationRoutes(
  app: FastifyInstance,
  options: ClassificationRoutesOptions,
): Promise<void> {
  const { service, origin, verifySession } = options;

  await app.register(async function classificationRoutes(scope) {
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof ClassificationError) {
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
      return sendUnclassifiedError(error, request, reply);
    });

    scope.post<{
      Params: { id: string };
      Body: ClassificationCorrectionBody;
      Reply: ClassificationCorrectionResponse;
    }>(
      "/messages/:id/classification/correction",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", pattern: UUID_PATTERN } },
          },
          body: {
            type: "object",
            required: ["scope", "classHint"],
            properties: {
              scope: { enum: [...CORRECTION_SCOPES] },
              classHint: { anyOf: [{ enum: [...MESSAGE_CLASSES] }, { type: "null" }] },
              note: { type: "string", maxLength: MAX_NOTE_CHARS },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => {
        const context: CorrectionContext = { requestGeneration: readRequestGeneration(request) };
        const correction = await service.correct(context, {
          messageId: request.params.id,
          scope: request.body.scope,
          classHint: request.body.classHint,
          note: request.body.note ?? null,
        });
        return { correction };
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
