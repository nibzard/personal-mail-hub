/**
 * Passkey owner authentication and recovery (SPEC sections 9 and 10).
 *
 * One owner signs in with WebAuthn passkeys. Operator commands issue
 * short-lived enrollment grants; challenges and sessions are bound to the
 * recovery generation, so a restored database never trusts restored
 * authentication state.
 */
export {
  CHALLENGE_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  GRANT_TTL_MS,
  RECENT_VERIFICATION_MS,
  parseAuthConfig,
  type AuthConfig,
  type AuthConfigInput,
} from "./config.ts";
export { AuthError } from "./errors.ts";
export { generateToken, hashToken } from "./tokens.ts";
export {
  ConsoleAuthService,
  createRecoveryHooks,
  type ConsoleAuthOptions,
  type IssuedGrant,
} from "./console.ts";
export {
  PasskeyAuthService,
  type AuthPublicStatus,
  type ControlStatusReader,
  type CredentialSummary,
  type OpenedSession,
  type SessionInfo,
} from "./service.ts";
