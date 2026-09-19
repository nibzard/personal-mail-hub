/** The current API version exposed by the application. */
export const API_VERSION = "v1" as const;

/** The response returned by a ready API instance. */
export interface HealthResponse {
  service: "api";
  status: "ok";
  version: typeof API_VERSION;
}

/** The overall verdict of `GET /healthz` (SPEC section 11). */
export type HealthzStatus = "ok" | "degraded";

/** Database reachability, proven by one round trip. */
export interface HealthzDatabase {
  state: "ok" | "unavailable";
  /** Round-trip time of the probe, in milliseconds. */
  roundTripMs: number | null;
}

/**
 * Recovery control state as the health check reports it. The check is
 * public, so it names states only: the generation values stay behind the
 * session-gated routes (SPEC sections 9 and 11).
 */
export interface HealthzRecovery {
  state:
    | "ready"
    | "reconciling"
    | "generation_mismatch"
    | "uninitialized"
    | "config_missing"
    | "unknown";
  /** Mode of the `service_state` row, when one exists. */
  mode: "ready" | "reconciling" | null;
  /** Operator-readable summary. Names states, never generation values. */
  description: string;
}

/** Queue age across the job queue and the durable work rows. */
export interface HealthzQueue {
  /** `unknown` when the queue schema is absent, so nothing can be read. */
  state: "ok" | "unknown";
  /** Pending jobs in the queue, or `null` when unreadable. */
  depth: number | null;
  /** When the oldest pending job was created. */
  oldestJobAt: string | null;
  /** Age of the oldest pending job, in seconds. */
  oldestJobAgeSeconds: number | null;
  /** When the oldest queued send or pending action was created. */
  oldestPendingWorkAt: string | null;
  /** Age of that oldest queued send or pending action, in seconds. */
  oldestPendingWorkAgeSeconds: number | null;
}

/** Classification state as the health check reports it (SPEC section 11). */
export interface HealthzClassification {
  /** `unknown` when the circuit state itself could not be read. */
  circuit: "closed" | "open" | "not_configured" | "unknown";
  /** Recorded Jev answers, from the `decisions` table. */
  calls: number;
  /** Recorded Jev failures, from `class.error` audit events. */
  errors: number;
  /** Operator-readable summary. Never includes message content. */
  description: string;
}

/** Body of `GET /healthz` when the database round trip fails. */
export interface HealthzUnavailableBody {
  error: {
    code: "database_unavailable";
    message: string;
  };
}

/** Outbound counters for the weekly review (SPEC section 11). */
export interface HealthzSends {
  queued: number;
  failed: number;
  outcomeUnknown: number;
}

/** Synchronization lag of one account. */
export interface HealthzSyncLag {
  /** When the account's newest sync cycle ended, or `null` when none ran. */
  lastCycleAt: string | null;
  /** Seconds since that cycle, or `null` when none ran. */
  cycleAgeSeconds: number | null;
  /** Folders that still owe backfill windows, from the newest cycle report. */
  backfillPendingFolders: number | null;
  /** Messages whose body has not been fetched yet. */
  pendingBodies: number;
}

/** The per-account metrics `GET /healthz` tracks (SPEC section 11). */
export interface HealthzAccountMetrics {
  messagesSynced: number;
  bodiesFetched: number;
  /** When the newest full-folder inventory completed, or `null` when none ran. */
  lastFullReconciliationAt: string | null;
  jevCalls: number;
  jevErrors: number;
}

/**
 * Lag and metrics of one account, as the public health check reports them.
 * The check names accounts by identifier only; labels and colors stay
 * behind the session-gated account routes.
 */
export interface HealthzAccount {
  accountId: string;
  sync: HealthzSyncLag;
  metrics: HealthzAccountMetrics;
}

/**
 * Response of `GET /healthz`: database round trip, sync lag per account,
 * oldest queued job, classification circuit state, and recovery mode (SPEC
 * sections 10 and 11).
 */
export interface HealthzResponse {
  service: "api";
  status: HealthzStatus;
  version: typeof API_VERSION;
  /** When the report was assembled, as an ISO 8601 timestamp. */
  checkedAt: string;
  database: HealthzDatabase;
  recovery: HealthzRecovery;
  queue: HealthzQueue;
  classification: HealthzClassification;
  sends: HealthzSends;
  accounts: HealthzAccount[];
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
  | "challenge_rate_limited"
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
  /**
   * The recovery generation the server accepts for new client work (SPEC
   * section 10). Authenticated sessions expose it so devices can stamp
   * drafts, uploads, and queued actions, and notice a restore. `null` when
   * deployment configuration carries no generation yet.
   */
  recoveryGeneration: string | null;
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

/**
 * One active occurrence a result row summarizes, as a mail action targets it
 * (SPEC F4): the identifier to freeze, the folder that holds it, and the
 * revision observed when the row was read.
 */
export interface OccurrenceRefWire {
  occurrenceId: string;
  folderId: string;
  /** The local revision observed when the row was read. */
  revision: number;
  /** The CONDSTORE value observed when the row was read, when one did. */
  modseq: string | null;
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
  /**
   * The active occurrences in scope, frozen for mail actions (SPEC F4).
   * Empty for a retained record, which no server action can target.
   */
  occurrences: OccurrenceRefWire[];
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

/** Mail action rejection codes, from `SPEC.md` F4 and section 7. */
export type ActionErrorCode = "invalid_request" | "not_found" | "idempotency_conflict";

/** The body of a mail action route rejection. */
export interface ActionErrorBody {
  error: {
    code: ActionErrorCode;
    message: string;
  };
}

/** The management actions one client may submit (SPEC F4). */
export type MailActionKindWire =
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "archive"
  | "move";

/** The life cycle states of one submitted action. */
export type ActionStatusWire = "queued" | "executing" | "complete";

/** The per-target receipt states of one action (SPEC section 7, step 5). */
export type ActionItemStatusWire =
  | "queued"
  | "executing"
  | "confirmed"
  | "conflicted"
  | "failed"
  | "unknown";

/** One per-target receipt: the occurrence key it answers for (SPEC F4). */
export interface ActionItemReceiptWire {
  itemKey: string;
  status: ActionItemStatusWire;
  /** The durable outcome detail, as the action service recorded it. */
  outcome: Record<string, unknown> | null;
}

/** The durable answer of one action: its state and every target receipt. */
export interface ActionReceiptWire {
  actionId: string;
  kind: MailActionKindWire;
  status: ActionStatusWire;
  idempotencyKey: string;
  items: ActionItemReceiptWire[];
}

/** The body of `POST /actions` (SPEC section 7, step 1). */
export interface SubmitMailActionBody {
  accountId: string;
  kind: MailActionKindWire;
  /** The idempotency key of this submission (SPEC section 7, step 2). */
  idempotencyKey: string;
  /** The occurrence identifiers frozen in the current view (SPEC F4). */
  occurrenceIds: string[];
  /** Destination folder; required for `archive` and `move`. */
  destinationFolderId?: string;
}

/** Response of `POST /actions` and `GET /actions/:id`. */
export interface MailActionResponse {
  action: ActionReceiptWire;
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

/** The message classes classification offers (SPEC F8 question set). */
export const MESSAGE_CLASSES = [
  "correspondence",
  "receipt",
  "newsletter",
  "notification",
  "marketing",
  "security_alert",
  "bounce",
  "other",
] as const;

/** One message class, as `class_hint` stores it (SPEC F8). */
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

/** The sender relationships classification offers (SPEC F8 question set). */
export const SENDER_RELATIONSHIPS = [
  "known_contact",
  "service_in_use",
  "bulk_sender",
  "unknown",
] as const;

/** One sender relationship, as message metadata stores it (SPEC F8). */
export type SenderRelationship = (typeof SENDER_RELATIONSHIPS)[number];

/**
 * Which precedence level answered for one message (SPEC F8): manual placement,
 * a sender override, a deterministic rule, or Jev. Top wins.
 */
export type SuggestionSource = "manual" | "override" | "rule" | "jev";

/**
 * The visible classification suggestion for one message (SPEC F8 shadow
 * mode). It never routes mail; the reader shows it as advice only.
 */
export interface MessageClassificationView {
  /** The suggested class, or `null` while nothing has answered yet. */
  classHint: MessageClass | null;
  /** Which precedence level answered, or `null` before anything did. */
  source: SuggestionSource | null;
  /** Jev yes/no answers; `null` while no Jev call has answered. */
  asksAction: boolean | null;
  asksReply: boolean | null;
  timeSensitive: boolean | null;
}

/** The scopes one correction may choose (SPEC F8): never guess the scope. */
export const CORRECTION_SCOPES = ["message", "sender", "rule"] as const;

/** One correction scope: this message only, this sender, or the rule. */
export type CorrectionScope = (typeof CORRECTION_SCOPES)[number];

/** The body of `POST /messages/:id/classification/correction`. */
export interface ClassificationCorrectionBody {
  /** What the correction applies to: one message, one sender, or the rule. */
  scope: CorrectionScope;
  /** The corrected class; `null` records "no class for this scope". */
  classHint: MessageClass | null;
  /** Why, in the owner's words. Kept with the correction event. */
  note?: string | null;
}

/** Response of `POST /messages/:id/classification/correction`. */
export interface ClassificationCorrectionResponse {
  correction: {
    scope: CorrectionScope;
    classHint: MessageClass | null;
    /** The sender address the correction named, when one did. */
    sender: string | null;
    /** The rule that answered the corrected message, for rule scope. */
    rule: string | null;
    /** The answer that stood before the correction, when one did. */
    previous: { source: SuggestionSource | null; classHint: MessageClass | null } | null;
    /** Messages that now carry the corrected answer. */
    reapplied: number;
  };
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
  /** The shadow-mode suggestion, never a routing decision (SPEC F8). */
  classification: MessageClassificationView;
}

/** Response of `GET /messages/:id`. */
export interface MessageDetailResponse {
  message: MessageDetailView;
}

/** Which path produced a clean view (SPEC F3). */
export type CleanViewSource = "extracted" | "original_fallback";

/** Response of `GET /messages/:id/clean-view`. */
export interface CleanViewResponse {
  /** Extracted and sanitized HTML, or the sanitized original on fallback. */
  html: string;
  source: CleanViewSource;
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
  | "bytes_mismatch"
  | "message_too_large";

/** Settings rejection code, from `SPEC.md` F10 and section 7. */
export type SettingsErrorCode = "invalid_request";

/** The body of a settings route rejection. */
export interface SettingsErrorBody {
  error: {
    code: SettingsErrorCode;
    message: string;
  };
}

/** The theme choices settings offer. System follows the device (SPEC F10). */
export type SettingsTheme = "system" | "light" | "dark";

/** The reading densities settings offer. Compact is the default (SPEC F10). */
export type SettingsDensity = "compact" | "comfortable";

/** The application settings the `settings` table stores (SPEC F10). */
export interface AppSettings {
  theme: SettingsTheme;
  density: SettingsDensity;
  /** Whether the single-key shortcuts respond (SPEC F11). */
  singleKeyShortcuts: boolean;
  /** Whether the reader opens messages in clean view by default (SPEC F3). */
  cleanViewDefault: boolean;
  /** Whether Jev classification runs for enabled accounts (SPEC F8). */
  classificationEnabled: boolean;
  /** Monthly Jev cost ceiling in US dollars; `null` means no cap (SPEC F8). */
  classificationMonthlyCostCapUsd: number | null;
  /** Whether the historical backfill classifies stored messages (SPEC F8). */
  backfillClassification: boolean;
}

/** Response of `GET /settings` and `PUT /settings`. */
export interface SettingsResponse {
  settings: AppSettings;
}

/** The body of `PUT /settings`: only the keys being changed. */
export type SettingsUpdateBody = Partial<AppSettings>;

/**
 * The per-account synchronization and queue status the settings screen shows.
 * Every number comes from the same durable records `GET /healthz` reads, so
 * the interface and the health check can never disagree (SPEC section 11).
 */
export interface SyncStatusResponse {
  /** When the report was assembled, as an ISO 8601 timestamp. */
  checkedAt: string;
  queue: HealthzQueue;
  sends: HealthzSends;
  classification: HealthzClassification;
  accounts: HealthzAccount[];
}

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
