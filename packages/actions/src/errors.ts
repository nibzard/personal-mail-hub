/**
 * Errors raised by the action service.
 *
 * Codes stay coarse on purpose: callers log the message and surface the code,
 * and no message content or credential ever enters an error string.
 */

export type ActionErrorCode = "invalid_request" | "not_found" | "idempotency_conflict";

export class ActionError extends Error {
  readonly code: ActionErrorCode;

  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}
