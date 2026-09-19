import type { SendErrorCode } from "@mail-hub/contracts";

/**
 * Send rejections: queueing an outbound snapshot and submitting it (SPEC F7).
 * Each code maps to one HTTP status so routes and workers report the same
 * way. `draft_stale` carries the server's current revision; the choice codes
 * of reply addressing live in the compose package instead.
 */

const HTTP_STATUS_BY_CODE: Record<SendErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  draft_stale: 409,
  draft_locked: 423,
  recipients_required: 409,
  upload_unverified: 409,
  idempotency_conflict: 409,
  send_unavailable: 503,
};

/** A send rejection with its HTTP status. */
export class SendError extends Error {
  readonly code: SendErrorCode;
  readonly httpStatus: number;

  /**
   * The revision the server currently holds. Present on `draft_stale` only,
   * so a client can show both values and ask which one to keep.
   */
  readonly currentRevision?: number;

  constructor(code: SendErrorCode, message: string, currentRevision?: number) {
    super(message);
    this.name = "SendError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    if (code === "draft_stale" && currentRevision !== undefined) {
      this.currentRevision = currentRevision;
    }
  }
}
