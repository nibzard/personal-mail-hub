import type { ReadingErrorCode } from "@mail-hub/contracts";

/**
 * Message reader rejections. Each code maps to one HTTP status so the
 * detail and download routes report the same way.
 */

const HTTP_STATUS_BY_CODE: Record<ReadingErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
};

/** A reading rejection with its HTTP status. */
export class ReadingError extends Error {
  readonly code: ReadingErrorCode;
  readonly httpStatus: number;

  constructor(code: ReadingErrorCode, message: string) {
    super(message);
    this.name = "ReadingError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}
