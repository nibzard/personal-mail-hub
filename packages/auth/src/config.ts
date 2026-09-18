/**
 * Passkey relying-party configuration, from `SPEC.md` section 9.
 *
 * `BASE_URL` must be the deployed HTTPS origin. The WebAuthn origin check
 * uses the full origin and the relying-party identifier check uses its
 * hostname.
 */

/** Challenge lifetime: challenges expire after five minutes. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Enrollment grant lifetime: grants expire after ten minutes. */
export const GRANT_TTL_MS = 10 * 60 * 1000;

/** Credential changes require a passkey verification within five minutes. */
export const RECENT_VERIFICATION_MS = 5 * 60 * 1000;

/** Session lifetime unless configured otherwise. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthConfig {
  /** Normalized origin, for example `https://mail.example.com`. */
  readonly origin: string;
  /** Relying-party identifier: the hostname of `BASE_URL`. */
  readonly rpId: string;
  readonly sessionTtlMs: number;
  readonly challengeTtlMs: number;
  readonly grantTtlMs: number;
  readonly recentVerificationMs: number;
}

export interface AuthConfigInput {
  baseUrl?: string | null;
  sessionTtlMs?: number;
  challengeTtlMs?: number;
  grantTtlMs?: number;
  recentVerificationMs?: number;
}

/**
 * Parse and validate relying-party configuration. Returns `null` when
 * `BASE_URL` is missing or unusable; callers keep authentication closed in
 * that case instead of guessing an origin.
 */
export function parseAuthConfig(input: AuthConfigInput): AuthConfig | null {
  if (input.baseUrl === null || input.baseUrl === undefined) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return null;
  }
  return {
    origin: url.origin,
    rpId: host,
    sessionTtlMs: input.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    challengeTtlMs: input.challengeTtlMs ?? CHALLENGE_TTL_MS,
    grantTtlMs: input.grantTtlMs ?? GRANT_TTL_MS,
    recentVerificationMs: input.recentVerificationMs ?? RECENT_VERIFICATION_MS,
  };
}
