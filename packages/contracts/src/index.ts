/** The current API version exposed by the application. */
export const API_VERSION = "v1" as const;

/** The response returned by a ready API instance. */
export interface HealthResponse {
  service: "api";
  status: "ok";
  version: typeof API_VERSION;
}

/** Recovery gate rejection codes, from `SPEC.md` sections 7 and 10. */
export type RecoveryErrorCode =
  | "invalid_recovery_generation"
  | "recovery_required"
  | "recovery_in_progress";

/** The body of a recovery gate rejection from a mutation route. */
export interface RecoveryErrorBody {
  error: {
    code: RecoveryErrorCode;
    message: string;
    /** The generation the client must review and reuse for new work. */
    currentGeneration?: string;
  };
}

/** Owner authentication rejection codes, from `SPEC.md` section 9. */
export type AuthErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "origin_forbidden"
  | "grant_invalid"
  | "challenge_invalid"
  | "webauthn_invalid"
  | "verification_required"
  | "last_credential"
  | "owner_exists"
  | "owner_missing"
  | "login_blocked"
  | "auth_unavailable";

/** The body of an authentication route rejection. */
export interface AuthErrorBody {
  error: {
    code: AuthErrorCode;
    message: string;
  };
}

/** How a client may authenticate right now. */
export type AuthLoginAvailability = "available" | "inspection_only" | "blocked";

/** Response of `GET /auth/status`. */
export interface AuthStatusResponse {
  ownerRegistered: boolean;
  login: AuthLoginAvailability;
  control: string;
}

/** WebAuthn ceremony options, passed to the browser unchanged. */
export interface AuthOptionsResponse {
  options: object;
}

/** Session state returned after a ceremony or session check. */
export interface AuthSessionResponse {
  kind: "standard" | "inspection";
  verifiedAt: string;
  expiresAt: string;
}

/** One passkey as shown in settings. */
export interface AuthCredentialSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Response of `GET /auth/credentials`. */
export interface AuthCredentialsResponse {
  credentials: AuthCredentialSummary[];
}
