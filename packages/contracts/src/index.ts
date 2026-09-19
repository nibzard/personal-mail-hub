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

/** Compose rejection codes: draft editing and durable uploads (SPEC F6, F9). */
export type ComposeErrorCode =
  | "invalid_request"
  | "not_found"
  | "draft_stale"
  | "draft_locked"
  | "identity_invalid"
  | "upload_unverified";

/** The body of a compose route rejection. */
export interface ComposeErrorBody {
  error: {
    code: ComposeErrorCode;
    message: string;
    /** Present on `draft_stale`: the revision the server currently holds. */
    currentRevision?: number;
  };
}

/** One address as a draft or message header carries it. */
export interface MessageAddress {
  address: string;
  name?: string | null;
}

/** Visible recipient lists of a draft or a sent message. */
export interface MessageRecipients {
  to: MessageAddress[];
  cc?: MessageAddress[];
  bcc?: MessageAddress[];
}

/** One identity choice for a draft: the address of a configured identity. */
export interface IdentitySelection {
  address: string;
}

/** One editable draft in its wire form. */
export interface DraftView {
  id: string;
  accountId: string;
  identity: { address: string; name: string | null };
  recipients: MessageRecipients;
  subject: string | null;
  markdown: string;
  revision: number;
  /** The outbound attempt that locked this draft, when one has (SPEC F7). */
  lockedBySend: string | null;
  updatedAt: string;
}

/** Response of `GET /drafts`. */
export interface DraftsResponse {
  drafts: DraftView[];
}

/** Response of `GET /drafts/:id` and the draft mutations. */
export interface DraftResponse {
  draft: DraftView;
}

/** One durable upload in its wire form. */
export interface UploadView {
  id: string;
  accountId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

/** Response of `POST /uploads`. */
export interface UploadResponse {
  upload: UploadView;
}

/** One upload attached to a draft, with its position. */
export interface DraftAttachmentView extends UploadView {
  ordinal: number;
}

/** Response of `GET /drafts/:id/uploads`. */
export interface DraftAttachmentsResponse {
  attachments: DraftAttachmentView[];
}

/** The result of verifying every upload a draft references (SPEC F6). */
export interface DraftUploadVerificationResponse {
  draftId: string;
  ok: boolean;
  uploads: {
    uploadId: string;
    filename: string;
    verified: boolean;
  }[];
}

/** Connection test rejection codes, from `SPEC.md` F1 and section 9. */
export type TransportErrorCode =
  | "network_error"
  | "tls_unavailable"
  | "tls_invalid"
  | "authentication_failed"
  | "protocol_error"
  | "internal_error";

/** MIME ingestion and attachment recovery rejection codes, from `SPEC.md` section 8. */
export type IngestionErrorCode =
  | "invalid_request"
  | "not_found"
  | "unsupported_locator"
  | "parse_failed"
  | "original_missing"
  | "original_mismatch"
  | "locator_unresolved"
  | "bytes_mismatch";

/** The stages one connection test walks through, in order. */
export type ConnectionTestStage = "tls" | "authenticate" | "inspect";

/** One connection-test rejection. Messages never contain credentials. */
export interface ConnectionTestError {
  code: TransportErrorCode;
  message: string;
}

/** One folder as an IMAP connection test reports it, with its counts. */
export interface ImapFolderReport {
  /** Full IMAP path, ready for the folder-import route. */
  name: string;
  /** IMAP special-use attributes, for example `\\Sent`. */
  specialUse: string[];
  messages: number | null;
  unread: number | null;
}

/** The IMAP half of one connection test (SPEC F1). */
export interface ImapConnectionReport {
  protocol: "imap";
  ok: boolean;
  /** The furthest stage the test reached. */
  stage: ConnectionTestStage;
  /** Capabilities the server advertised after authentication. */
  capabilities: string[];
  folders: ImapFolderReport[];
  error: ConnectionTestError | null;
}

/** The SMTP half of one connection test (SPEC F1). */
export interface SmtpConnectionReport {
  protocol: "smtp";
  ok: boolean;
  /** The furthest stage the test reached. */
  stage: ConnectionTestStage;
  /** The security mode that was tested. */
  security: SmtpSecurityMode;
  error: ConnectionTestError | null;
}

/**
 * Response of `POST /accounts/:id/connection-test`. Each protocol is tested
 * and reported separately; one failing half never hides the other. The test
 * sends no mail and verifies no send identities.
 */
export interface ConnectionTestResponse {
  imap: ImapConnectionReport;
  smtp: SmtpConnectionReport;
}
