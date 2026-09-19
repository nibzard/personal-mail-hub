import type { SearchErrorCode } from "@mail-hub/contracts";

/**
 * Search rejections: query parsing, filters, and saved-search state. Each
 * code maps to one HTTP status so routes and services report the same way.
 * `invalid_query` covers everything the query box can produce: unknown
 * operators, empty operator values, and dates that are not real calendar
 * dates (SPEC F5).
 */

const HTTP_STATUS_BY_CODE: Record<SearchErrorCode, number> = {
  invalid_request: 400,
  invalid_query: 400,
  not_found: 404,
  name_conflict: 409,
};

/** A search rejection with its HTTP status. */
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly httpStatus: number;

  constructor(code: SearchErrorCode, message: string) {
    super(message);
    this.name = "SearchError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}
