import type { ComposeErrorCode } from "@mail-hub/contracts";

/**
 * Compose rejections: draft editing, uploads, draft locking, and reply
 * addressing. Each code maps to one HTTP status so routes and workers report
 * the same way. The three choice codes report `409`: the stored parent, not
 * the request, is what leaves the choice open.
 */

const HTTP_STATUS_BY_CODE: Record<ComposeErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  draft_stale: 409,
  draft_locked: 423,
  identity_invalid: 400,
  upload_unverified: 409,
  account_choice_required: 409,
  identity_choice_required: 409,
  recipients_required: 409,
};

/** A compose rejection with its HTTP status. */
export class ComposeError extends Error {
  readonly code: ComposeErrorCode;
  readonly httpStatus: number;

  /**
   * The revision the server currently holds. Present on `draft_stale` only,
   * so a client can show both values and ask which one to keep (SPEC F9).
   */
  readonly currentRevision?: number;

  constructor(code: ComposeErrorCode, message: string, currentRevision?: number) {
    super(message);
    this.name = "ComposeError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    if (code === "draft_stale" && currentRevision !== undefined) {
      this.currentRevision = currentRevision;
    }
  }
}
