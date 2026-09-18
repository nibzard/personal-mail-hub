import type { AccountErrorCode } from "@mail-hub/contracts";

/**
 * Account and identity management rejections. Each code maps to one HTTP
 * status so routes and the console report the same way.
 */

const HTTP_STATUS_BY_CODE: Record<AccountErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  credential_invalid: 500,
};

/** An account-management rejection with its HTTP status. */
export class AccountError extends Error {
  readonly code: AccountErrorCode;
  readonly httpStatus: number;

  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}
