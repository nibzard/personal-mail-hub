import type { IngestionErrorCode } from "@mail-hub/contracts";

/**
 * MIME ingestion and attachment recovery rejections. Each code maps to one
 * HTTP status so the download routes report the same way.
 */

const HTTP_STATUS_BY_CODE: Record<IngestionErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  unsupported_locator: 422,
  parse_failed: 500,
  original_missing: 500,
  original_mismatch: 500,
  locator_unresolved: 500,
  bytes_mismatch: 500,
  message_too_large: 413,
};

/** An ingestion rejection with its HTTP status. */
export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  readonly httpStatus: number;

  constructor(code: IngestionErrorCode, message: string) {
    super(message);
    this.name = "IngestionError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}
