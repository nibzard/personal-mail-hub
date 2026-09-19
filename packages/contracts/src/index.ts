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

/** Compose rejection codes: draft editing, durable uploads, and replies (SPEC F6, F9). */
export type ComposeErrorCode =
  | "invalid_request"
  | "not_found"
  | "draft_stale"
  | "draft_locked"
  | "identity_invalid"
  | "upload_unverified"
  | "account_choice_required"
  | "identity_choice_required"
  | "recipients_required";

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

/** Which recipient derivation one reply draft opens with (SPEC F6). */
export type ReplyMode = "reply" | "reply_all";

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
  /** The selected parent of a reply draft; `null` for new messages (SPEC F6). */
  replyParentId: string | null;
  /** The parent's thread as frozen with the draft. */
  threadId: string | null;
  /** The frozen `In-Reply-To` identifier; `null` when the parent has none usable. */
  inReplyTo: string | null;
  /** The frozen `References` identifiers, oldest first. */
  referenceIds: string[];
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

/** Send rejection codes: queueing, submitting, and storing the Sent copy (SPEC F7). */
export type SendErrorCode =
  | "invalid_request"
  | "not_found"
  | "draft_stale"
  | "draft_locked"
  | "recipients_required"
  | "upload_unverified"
  | "idempotency_conflict"
  | "send_unavailable"
  | "sent_copy_unavailable";

/** The body of a send route rejection. */
export interface SendErrorBody {
  error: {
    code: SendErrorCode;
    message: string;
    /** Present on `draft_stale`: the revision the server currently holds. */
    currentRevision?: number;
  };
}

/** The wire status of one outbound snapshot (SPEC F7). */
export type OutboundStatusWire = "queued" | "sending" | "sent" | "failed" | "outcome_unknown";

/** The wire status of the separate Sent-copy append (SPEC F7 step 5). */
export type SentCopyStatusWire = "pending" | "appending" | "stored" | "failed" | "unknown";

/** One recipient-level SMTP result, without credentials. */
export interface RecipientResultView {
  address: string;
  accepted: boolean;
  response: unknown;
}

/** One outbound snapshot in its wire form. */
export interface OutboundView {
  id: string;
  draftId: string | null;
  accountId: string;
  status: OutboundStatusWire;
  sentCopyStatus: SentCopyStatusWire;
  identity: MessageAddress;
  recipients: MessageRecipients;
  subject: string | null;
  /** The generated identifier, frozen before SMTP. */
  rfcMessageId: string;
  recipientResults: RecipientResultView[];
  smtpResponse: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  createdAt: string;
  sentAt: string | null;
}

/** Response of `POST /drafts/:id/send` and the send status reads. */
export interface OutboundResponse {
  outbound: OutboundView;
}

/** The body of `POST /drafts/:id/send`. */
export interface SendDraftRequestBody {
  /** The idempotency key of this send request (SPEC F7 step 2). */
  idempotencyKey: string;
  /** The draft revision the sender based this request on. */
  baseRevision: number;
}

/** Timeouts one SMTP submission may override. */
export interface SmtpSubmitTimeouts {
  connectMs?: number;
  greetingMs?: number;
  socketMs?: number;
}

/** One SMTP submission request against a verified endpoint (SPEC F7 step 3). */
export interface SmtpSubmitRequest {
  host: string;
  port: number;
  security: SmtpSecurityMode;
  username: string;
  password: string;
  /** Envelope sender and every recipient, blind copies included. */
  envelope: { from: string; to: string[] };
  /** The exact, durably stored MIME bytes to submit. */
  raw: Uint8Array;
  timeouts?: SmtpSubmitTimeouts;
  /** Test-only trust anchors. Production uses the system trust store. */
  trustedCaPem?: string[];
}

/** One per-recipient SMTP outcome, recorded without credentials. */
export interface SmtpRecipientOutcome {
  address: string;
  accepted: boolean;
  /** The response line the server gave for this recipient, when one arrived. */
  response: string | null;
}

/**
 * How one SMTP submission ended (SPEC F7 steps 4 and 6). `accepted` means the
 * final response was positive; `rejected` means a definitive refusal before
 * any content was accepted; `unknown` covers every outcome the client cannot
 * classify, including a lost final response.
 */
export type SmtpSubmitState = "accepted" | "rejected" | "unknown";

/** The classified report of one SMTP submission attempt. */
export interface SmtpSubmitReport {
  state: SmtpSubmitState;
  /** The final response line, when one arrived. */
  response: string | null;
  responseCode: number | null;
  recipients: SmtpRecipientOutcome[];
  /** The classified error, without credentials. Present when `state` is not `accepted`. */
  error: { code: string; message: string } | null;
}

/** Connection test rejection codes, from `SPEC.md` F1 and section 9. */
export type TransportErrorCode =
  | "network_error"
  | "tls_unavailable"
  | "tls_invalid"
  | "authentication_failed"
  | "protocol_error"
  | "internal_error";

/** Search rejection codes: query parsing, filters, and saved searches (SPEC F5). */
export type SearchErrorCode = "invalid_request" | "invalid_query" | "not_found" | "name_conflict";

/** The body of a search route rejection. */
export interface SearchErrorBody {
  error: {
    code: SearchErrorCode;
    message: string;
  };
}

/** The Jev message classes a `type:` operator selects (SPEC F8). */
export type JevClassWire =
  | "correspondence"
  | "receipt"
  | "newsletter"
  | "notification"
  | "marketing"
  | "security_alert"
  | "bounce"
  | "other";

/** The scope a search or saved search runs in (SPEC F5). */
export interface SearchScopeWire {
  /** Account filter chips; absent means every account. */
  accountIds?: string[];
  /** One folder scope; absent means no folder restriction. */
  folderId?: string | null;
  /** Domain filter chips. */
  domains?: string[];
  /** The local archive filter: records without active occurrences only. */
  localOnly?: boolean;
}

/** One search result row in its wire form. */
export interface SearchResultItem {
  messageId: string;
  accountId: string;
  accountLabel: string;
  accountColor: string;
  threadId: string | null;
  subject: string | null;
  snippet: string | null;
  sender: MessageAddress | null;
  /** Effective send time: the header date, or the earliest internal date. */
  sentAt: string | null;
  fetchedBody: boolean;
  hasAttachments: boolean;
  /** At least one active occurrence in scope holds the flag (SPEC F4). */
  unread: boolean;
  flagged: boolean;
  /** Active occurrences in the current scope; zero marks a retained record. */
  activeOccurrences: number;
  /** True when no server copy remains anywhere (SPEC F5). */
  noServerCopy: boolean;
  /** Sent-copy state of the outgoing record this message is, when it is one. */
  sentCopyStatus: SentCopyStatusWire | null;
  /** Text-search rank; `null` when the query had no free text. */
  rank: number | null;
  /** Marked-up match context; `null` when only addresses matched. */
  highlight: string | null;
  highlightSource: "subject" | "body" | null;
}

/** Response of `GET /search`. */
export interface SearchResultsResponse {
  results: SearchResultItem[];
  /** Total rows the query matches, past the returned page. */
  total: number;
  /** Body-indexing progress across the account scope (SPEC F5). */
  indexing: { messages: number; bodies: number };
}

/** One saved search in its wire form: its query state, not its results. */
export interface SavedSearchView {
  id: string;
  name: string;
  query: string;
  scope: SearchScopeWire;
  createdAt: string;
  updatedAt: string;
}

/** Response of `GET /searches/saved`. */
export interface SavedSearchesResponse {
  searches: SavedSearchView[];
}

/** The body of `POST /searches/saved`. */
export interface CreateSavedSearchRequestBody {
  name: string;
  query: string;
  scope?: SearchScopeWire | null;
}

/** Safe-reader rejection codes, from `SPEC.md` F3 and section 8. */
export type ReadingErrorCode = "invalid_request" | "not_found";

/** The body of a message-reader route rejection. */
export interface ReadingErrorBody {
  error: {
    code: ReadingErrorCode;
    message: string;
  };
}

/** One received attachment in its wire form (SPEC F3). */
export interface MessageAttachmentView {
  id: string;
  filename: string | null;
  contentType: string | null;
  /** Decoded size, which is what a download delivers. */
  sizeBytes: number;
  /** MIME Content-ID without angle brackets; not a unique key. */
  contentId: string | null;
  /** `attachment` or `inline` when the part declared one. */
  disposition: string | null;
  /**
   * True when exactly one part of this message holds this Content-ID and the
   * part is an image, so a `cid:` reference may resolve to it (SPEC F3).
   * Ambiguous identifiers stay download items.
   */
  inlineResolvable: boolean;
}

/** One message in full, as the reader shows it (SPEC F3). */
export interface MessageDetailView {
  id: string;
  accountId: string;
  threadId: string | null;
  subject: string | null;
  sender: MessageAddress | null;
  /** Visible recipients; blind copies never appear here. */
  recipients: { to: MessageAddress[]; cc: MessageAddress[] } | null;
  sentAt: string | null;
  /** False while only headers exist; the reader says so instead of guessing. */
  fetchedBody: boolean;
  /** Sanitized HTML derivative; the original bytes are never sent (SPEC section 8). */
  htmlSanitized: string | null;
  textPlain: string | null;
  attachments: MessageAttachmentView[];
}

/** Response of `GET /messages/:id`. */
export interface MessageDetailResponse {
  message: MessageDetailView;
}

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
