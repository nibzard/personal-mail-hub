import type { AuthErrorCode } from "@mail-hub/contracts";

/**
 * Authentication rejections. Each code maps to one HTTP status so routes
 * and the console report the same way.
 */

const HTTP_STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  origin_forbidden: 403,
  grant_invalid: 403,
  challenge_invalid: 400,
  challenge_rate_limited: 429,
  webauthn_invalid: 400,
  verification_required: 403,
  last_credential: 409,
  owner_exists: 409,
  owner_missing: 400,
  login_blocked: 503,
  auth_unavailable: 503,
};

/** An owner-authentication rejection with its HTTP status. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly httpStatus: number;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}
