/**
 * Errors raised by the action service.
 *
 * Codes stay coarse on purpose: callers log the message and surface the code,
 * and no message content or credential ever enters an error string.
 */

export type ActionErrorCode = "invalid_request" | "not_found" | "idempotency_conflict";

/** The HTTP status each code maps to on the action routes. */
const HTTP_STATUS_BY_CODE: Record<ActionErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  idempotency_conflict: 409,
};

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly httpStatus: number;

  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}
