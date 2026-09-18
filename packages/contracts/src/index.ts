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

/** Account and identity management rejection codes, from `SPEC.md` F1. */
export type AccountErrorCode = "invalid_request" | "not_found" | "credential_invalid";

/** The body of an account route rejection. */
export interface AccountErrorBody {
  error: {
    code: AccountErrorCode;
    message: string;
  };
}

/** The security modes an account may use, from `SPEC.md` F1. */
export type SmtpSecurityMode = "starttls_required" | "implicit_tls";

/** One folder role, from `SPEC.md` section 8. */
export type FolderRole = "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk";

/** The roles every account must map before folder-bound actions run. */
export type RequiredFolderRole = "inbox" | "sent" | "archive";

/** One send identity: an address pair where exactly one per account is the default. */
export interface AccountIdentityInput {
  address: string;
  name?: string | null;
  isDefault: boolean;
}

/** One send identity as stored on the account. */
export interface AccountIdentityView extends AccountIdentityInput {
  name: string | null;
}

/** One account as shown in settings. Passwords never appear in any view. */
export interface AccountSummary {
  id: string;
  label: string;
  color: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurityMode;
  username: string;
  identities: AccountIdentityView[];
  classifyEnabled: boolean;
  createdAt: string;
}

/** Response of `GET /accounts`. */
export interface AccountsResponse {
  accounts: AccountSummary[];
}

/** Response of `GET /accounts/:id`. */
export interface AccountResponse {
  account: AccountSummary;
}

/** One IMAP folder as shown in settings. */
export interface FolderSummary {
  id: string;
  name: string;
  role: FolderRole | null;
}

/** Response of `GET /accounts/:id/folders`. */
export interface AccountFoldersResponse {
  folders: FolderSummary[];
  /** Required roles that still need a manual destination choice. */
  pendingRoleChoices: RequiredFolderRole[];
}

/** One folder as reported by a connection test, with its server hints. */
export interface DiscoveredFolder {
  name: string;
  /** IMAP special-use attributes, for example `\\Sent`. */
  specialUse?: string[];
}

/** A server hint that disagreed with the role already assigned to a folder. */
export interface RoleHintConflict {
  role: FolderRole;
  /** Folder that currently holds the role. */
  current: string;
  /** Folder the server hint named instead. */
  hinted: string;
}

/** Result of importing one discovery run, with the resolved role map. */
export interface FolderImportResult {
  /** Folders created by this import. */
  created: FolderSummary[];
  /** Roles assigned from unambiguous server hints. */
  assignedRoles: Partial<Record<FolderRole, string>>;
  /** Roles whose hints named more than one folder. They need a manual choice. */
  ambiguousRoles: FolderRole[];
  /** Hints that disagreed with an existing assignment. Existing choices win. */
  conflicts: RoleHintConflict[];
}

/** Response of `POST /accounts/:id/folders/import`. */
export interface FolderImportResponse extends FolderImportResult {
  folders: FolderSummary[];
  pendingRoleChoices: RequiredFolderRole[];
}
