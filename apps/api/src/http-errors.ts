import type { FastifyReply, FastifyRequest } from "fastify";
import { StorageError } from "@mail-hub/database";

/**
 * The fallback error answer every scoped route shares (SPEC section 7).
 * Errors the routes classify keep their own codes and messages. Anything
 * else must not leak internals: a database or storage failure carries
 * topology and driver detail no browser should see.
 */

/** An error Fastify raised itself carries an HTTP status. */
type StatusError = Error & { statusCode?: number };

/** A client refusal Fastify raised: malformed JSON, a schema or body limit. */
function clientStatusOf(error: StatusError): number | null {
  if (typeof error.statusCode !== "number") {
    return null;
  }
  return error.statusCode >= 400 && error.statusCode <= 499 ? error.statusCode : null;
}

/**
 * Answer an error no route classified. A Fastify client error keeps its
 * status but answers in the shared error shape, so a refusal such as an
 * oversized body stays inside the contract. Every other failure is internal:
 * the detail is logged server-side only and the caller receives a generic
 * `500`.
 */
export function sendUnclassifiedError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  // A full storage volume is a system state the client can distinguish from
  // a bug (SPEC section 10): 507, with the measured numbers, no internals.
  if (error instanceof StorageError && error.code === "insufficient_space") {
    return reply.code(507).send({
      error: { code: "insufficient_space", message: error.message },
    });
  }
  if (error instanceof Error) {
    const clientStatus = clientStatusOf(error);
    if (clientStatus !== null) {
      return reply.code(clientStatus).send({
        error: { code: "invalid_request", message: error.message },
      });
    }
  }
  request.log.error({ err: error }, "unhandled error while serving a request");
  return reply.code(500).send({
    error: {
      code: "internal_error",
      message: "The request failed unexpectedly. Try again.",
    },
  });
}
