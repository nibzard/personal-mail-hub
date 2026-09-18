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
 * Build a preHandler that enforces the recovery gate before the route runs.
 * The gate executes before any idempotency lookup.
 */
export function mailMutationGate(gate: MutationGate) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers[RECOVERY_GENERATION_HEADER];
    const requestGeneration =
      typeof header === "string" && header.trim() !== "" ? header.trim() : undefined;

    try {
      await gate.gateMutation(requestGeneration);
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
