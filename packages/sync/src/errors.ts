/**
 * Errors raised by the synchronization services.
 *
 * Codes stay coarse on purpose: contained failures are logged as their code
 * through `classifyFailure` (diagnostics.ts), never as their message, and no
 * message content ever enters an error string.
 */

export type SyncErrorCode =
  | "invalid_request"
  | "not_found"
  | "mailbox_error"
  | "generation_changed"
  | "original_missing";

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = "SyncError";
    this.code = code;
  }
}
