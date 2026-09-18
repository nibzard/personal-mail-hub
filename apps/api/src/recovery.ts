import type { FastifyReply, FastifyRequest } from "fastify";
import { RecoveryBlockedError, type MutationGate } from "@mail-hub/recovery";

/**
 * Fastify glue for the recovery gate. Attach this preHandler to mutation
 * routes only; enrollment and operator recovery stay available while service
 * is blocked (SPEC section 10).
 */

/** Header that carries the generation a client captured for its request. */
export const RECOVERY_GENERATION_HEADER = "x-recovery-generation";

/**
 * Read the recovery generation a client captured for its request. Returns
 * `undefined` when the header is absent or blank.
 */
export function readRequestGeneration(request: FastifyRequest): string | undefined {
  const header = request.headers[RECOVERY_GENERATION_HEADER];
  return typeof header === "string" && header.trim() !== "" ? header.trim() : undefined;
}

/**
 * Build a preHandler that enforces the recovery gate before the route runs.
 * The gate executes before any idempotency lookup.
 */
export function mailMutationGate(gate: MutationGate) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await gate.gateMutation(readRequestGeneration(request));
    } catch (error) {
      if (!(error instanceof RecoveryBlockedError)) {
        throw error;
      }
      return reply.code(error.httpStatus).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.currentGeneration === undefined ? {} : { currentGeneration: error.currentGeneration }),
        },
      });
    }
  };
}
