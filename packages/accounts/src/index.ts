/**
 * Encrypted account and identity management (SPEC F1 and section 9).
 *
 * One account is one mailbox. Passwords are sealed with AES-256-GCM under
 * `CREDENTIALS_KEY`, folder discovery maps roles from server hints with a
 * manual choice for the rest, and send identities stay validated with exactly
 * one default. Every mutation passes the recovery-generation gate first.
 */
export { createCredentialCipher, parseCredentialsKey, type CredentialCipher } from "./crypto.ts";
export { AccountError } from "./errors.ts";
export {
  AccountService,
  type AccountFolders,
  type AccountSummary,
  type CreateAccountInput,
  type FolderImportResult,
  type FolderSummary,
  type MutationContext,
  type ResolvedCredentials,
  type UpdateAccountInput,
} from "./service.ts";
