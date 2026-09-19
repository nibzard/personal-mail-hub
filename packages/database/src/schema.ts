import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Data model for the mail hub, from `SPEC.md` sections 8 and 9.
 *
 * Mail storage and owner authentication share one schema but separate
 * migrations: `0000_mail_storage.sql` and `0001_owner_auth.sql`.
 */

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

/** One address as it appears in a header: an email address and an optional display name. */
export interface EmailAddress {
  address: string;
  name: string | null;
}

/** An address pair an account may send from. Exactly one identity per account is the default. */
export interface AccountIdentity extends EmailAddress {
  isDefault: boolean;
}

/** Visible recipient lists for a message or draft. */
export interface Recipients {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
}

/** One recipient-level SMTP result, kept without credentials. */
export interface RecipientResult {
  address: string;
  accepted: boolean;
  response: unknown;
}

/** The frozen target of one action item: an occurrence with its folder generation and local revision. */
export interface ActionItemTarget {
  occurrenceId: string;
  accountId: string;
  folderId: string;
  uidvalidity: number;
  uid: number;
  revision: number;
}

export type RecoveryMode = "ready" | "reconciling";
export type FolderRole = "inbox" | "sent" | "drafts" | "archive" | "trash" | "junk";
/** SMTP security modes. Plaintext and optional upgrades are unavailable (SPEC F1). */
export type SmtpSecurityMode = "starttls_required" | "implicit_tls";
export type ThreadLinkState = "root" | "pending" | "linked" | "ambiguous";
export type OutboundStatus = "queued" | "sending" | "sent" | "failed" | "outcome_unknown";
export type SentCopyStatus = "pending" | "appending" | "stored" | "failed" | "unknown";
export type ActionItemStatus = "queued" | "executing" | "confirmed" | "conflicted" | "failed" | "unknown";

/** Why one WebAuthn challenge exists. A challenge never changes purpose. */
export type ChallengePurpose =
  | "first_enrollment"
  | "recovery_enrollment"
  | "add_credential"
  | "login"
  | "reverify";

/** Why one enrollment grant exists. Console commands issue both kinds. */
export type GrantPurpose = "bootstrap" | "recovery";

/** Standard sessions open while service is ready; inspection sessions during recovery. */
export type OwnerSessionKind = "standard" | "inspection";

/** Singleton control row compared against `RECOVERY_GENERATION` on startup. */
export const serviceState = pgTable(
  "service_state",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    recoveryGeneration: uuid("recovery_generation").notNull(),
    recoveryMode: text("recovery_mode").$type<RecoveryMode>().notNull().default("ready"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check("service_state_singleton_check", sql`"singleton"`),
    check(
      "service_state_recovery_mode_check",
      sql`"recovery_mode" in ('ready', 'reconciling')`,
    ),
  ],
);

/** One mailbox connection. Credentials stay encrypted at rest. */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    color: text("color").notNull(),
    imapHost: text("imap_host").notNull().default("imap.purelymail.com"),
    imapPort: integer("imap_port").notNull().default(993),
    imapSecurity: text("imap_security").notNull().default("implicit_tls"),
    smtpHost: text("smtp_host").notNull().default("smtp.purelymail.com"),
    smtpPort: integer("smtp_port").notNull().default(587),
    smtpSecurity: text("smtp_security").$type<SmtpSecurityMode>().notNull().default("starttls_required"),
    username: text("username").notNull(),
    /** AES-256-GCM ciphertext; the key comes from `CREDENTIALS_KEY` and never enters the database. */
    passwordEnc: text("password_enc").notNull(),
    identities: jsonb("identities").$type<AccountIdentity[]>().notNull().default([]),
    classifyEnabled: boolean("classify_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check("accounts_imap_security_check", sql`"imap_security" = 'implicit_tls'`),
    check(
      "accounts_smtp_security_check",
      sql`"smtp_security" in ('starttls_required', 'implicit_tls')`,
    ),
  ],
);

/** One IMAP folder with its sync checkpoints. Checkpoints belong to one folder generation. */
export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** IMAP path. */
    name: text("name").notNull(),
    role: text("role").$type<FolderRole>(),
    uidvalidity: bigint("uidvalidity", { mode: "number" }),
    arrivalScannedUid: bigint("arrival_scanned_uid", { mode: "number" }).notNull().default(0),
    backfillUpperUid: bigint("backfill_upper_uid", { mode: "number" }),
    backfillBeforeUid: bigint("backfill_before_uid", { mode: "number" }),
    backfillComplete: boolean("backfill_complete").notNull().default(false),
  },
  (t) => [
    unique("folders_id_account_id_key").on(t.id, t.accountId),
    unique("folders_account_id_name_key").on(t.accountId, t.name),
    uniqueIndex("folders_account_id_role_uidx").on(t.accountId, t.role).where(sql`"role" is not null`),
  ],
);

/** A conversation within one account. */
export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    subjectNorm: text("subject_norm"),
    participants: jsonb("participants").$type<EmailAddress[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("threads_id_account_id_key").on(t.id, t.accountId)],
);

/**
 * A logical message: content owned once per account, with one or more occurrences.
 * `message_id` is a grouping hint, never a unique key. Index text columns feed the
 * generated `search` vector; bodies enter after fetching, so header matches work first.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    referenceIds: jsonb("reference_ids").$type<string[]>().notNull().default([]),
    threadId: uuid("thread_id"),
    parentMessageId: uuid("parent_message_id"),
    threadLinkState: text("thread_link_state").$type<ThreadLinkState>().notNull().default("pending"),
    /**
     * Durable thread-reconciliation job marker (SPEC F2). Every transaction
     * that imports, changes, or removes message identifiers sets it; one
     * bounded reconciliation pass clears it as the row resolves.
     */
    threadDirty: boolean("thread_dirty").notNull().default(true),
    sender: jsonb("sender").$type<EmailAddress>(),
    /** Null means the header is absent; an empty array means it was invalid or empty. */
    replyTo: jsonb("reply_to").$type<EmailAddress[]>(),
    recipients: jsonb("recipients").$type<Recipients>(),
    subject: text("subject"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    snippet: text("snippet"),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    fetchedBody: boolean("fetched_body").notNull().default(false),
    /** Denormalized latest Jev answer. */
    classHint: text("class_hint"),
    asksAction: boolean("asks_action"),
    asksReply: boolean("asks_reply"),
    timeSensitive: boolean("time_sensitive"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Durable locator for the complete original MIME bytes. */
    originalStorageKey: text("original_storage_key"),
    originalSha256: text("original_sha256"),
    senderText: text("sender_text").notNull().default(""),
    recipientsText: text("recipients_text").notNull().default(""),
    subjectText: text("subject_text").notNull().default(""),
    bodyIndexText: text("body_index_text").notNull().default(""),
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', "sender_text"), 'A') ||
          setweight(to_tsvector('simple', "recipients_text"), 'A') ||
          setweight(to_tsvector('simple', "subject_text"), 'A') ||
          setweight(to_tsvector('simple', "body_index_text"), 'B')`,
    ),
  },
  (t) => [
    unique("messages_id_account_id_key").on(t.id, t.accountId),
    foreignKey({ columns: [t.threadId, t.accountId], foreignColumns: [threads.id, threads.accountId] }),
    // The self reference uses the callback's own column proxy to avoid a
    // circular type dependency on `messages` itself.
    foreignKey({ columns: [t.parentMessageId, t.accountId], foreignColumns: [t.id, t.accountId] }),
    check("messages_parent_message_id_check", sql`"parent_message_id" <> "id"`),
    check(
      "messages_thread_link_state_check",
      sql`"thread_link_state" in ('root', 'pending', 'linked', 'ambiguous')`,
    ),
    check(
      "messages_thread_link_state_parent_check",
      sql`("thread_link_state" = 'linked') = ("parent_message_id" is not null)`,
    ),
    index("messages_thread_id_idx").on(t.threadId),
    index("messages_account_id_sent_at_idx").on(t.accountId, sql`${t.sentAt} desc`),
    index("messages_message_id_idx").on(t.messageId),
    index("messages_account_id_in_reply_to_idx").on(t.accountId, t.inReplyTo),
    index("messages_reference_ids_idx").using("gin", t.referenceIds),
    // Children of one parent, for thread-membership propagation after a link
    // changes; and the dirty set, newest first, for bounded reconciliation.
    index("messages_parent_message_id_idx").on(t.parentMessageId),
    index("messages_thread_dirty_idx")
      .on(t.accountId, sql`${t.sentAt} desc`)
      .where(sql`"thread_dirty"`),
    index("messages_class_hint_idx").on(t.classHint).where(sql`"class_hint" is not null`),
    index("messages_search_idx").using("gin", t.search),
    index("messages_sender_text_trgm_idx").using("gin", sql`${t.senderText} gin_trgm_ops`),
    index("messages_subject_text_trgm_idx").using("gin", sql`${t.subjectText} gin_trgm_ops`),
    uniqueIndex("messages_account_id_original_sha256_uidx")
      .on(t.accountId, t.originalSha256)
      .where(sql`"original_sha256" is not null`),
  ],
);

/** A message copy in one folder generation, with its own flags and local revision. */
export const messageOccurrences = pgTable(
  "message_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    messageId: uuid("message_id").notNull(),
    folderId: uuid("folder_id").notNull(),
    uidvalidity: bigint("uidvalidity", { mode: "number" }).notNull(),
    uid: bigint("uid", { mode: "number" }).notNull(),
    internalDate: timestamp("internal_date", { withTimezone: true }).notNull(),
    unread: boolean("unread").notNull().default(true),
    flagged: boolean("flagged").notNull().default(false),
    /** Optional server modification sequence from CONDSTORE. */
    modseq: numeric("modseq", { precision: 20, scale: 0 }),
    /** Local observed-state revision, bumped on each committed observation. */
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    expungedAt: timestamp("expunged_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey(
      { columns: [t.messageId, t.accountId], foreignColumns: [messages.id, messages.accountId] },
    ),
    foreignKey({ columns: [t.folderId, t.accountId], foreignColumns: [folders.id, folders.accountId] }),
    unique("message_occurrences_folder_id_uidvalidity_uid_key").on(t.folderId, t.uidvalidity, t.uid),
    index("message_occurrences_message_id_idx").on(t.messageId),
    index("message_occurrences_active_folder_uid_idx")
      .on(t.folderId, t.uid)
      .where(sql`"expunged_at" is null and "invalidated_at" is null`),
  ],
);

/** Sanitized derived body content. The durable original stays the record; never render it directly. */
export const bodies = pgTable("bodies", {
  messageId: uuid("message_id")
    .primaryKey()
    .references(() => messages.id),
  textPlain: text("text_plain"),
  htmlSanitized: text("html_sanitized"),
  sanitizerVersion: text("sanitizer_version").notNull(),
});

/** A verified attachment locator into the stored original MIME tree. */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    /** Position in the original MIME tree, for example `/2/1`. */
    partPath: text("part_path").notNull(),
    locatorVersion: smallint("locator_version").notNull().default(1),
    /** Hash of the decoded bytes, used to verify regeneration. */
    decodedSha256: text("decoded_sha256").notNull(),
    /** MIME Content-ID; not a unique key. */
    contentId: text("content_id"),
    disposition: text("disposition"),
    filename: text("filename"),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Disposable extracted copy; regenerate from the original when absent. */
    storageKey: text("storage_key"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  },
  (t) => [
    check("attachments_locator_version_check", sql`"locator_version" > 0`),
    check("attachments_size_bytes_check", sql`"size_bytes" >= 0`),
    unique("attachments_message_id_part_path_key").on(t.messageId, t.partPath),
  ],
);

/** An editable draft. Locking is irreversible: queued sends freeze their own snapshot. */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    identity: jsonb("identity").$type<EmailAddress>().notNull(),
    threadId: uuid("thread_id"),
    replyParentId: uuid("reply_parent_id"),
    inReplyTo: text("in_reply_to"),
    referenceIds: jsonb("reference_ids").$type<string[]>().notNull().default([]),
    recipients: jsonb("recipients").$type<Recipients>().notNull().default(sql`'{}'::jsonb`),
    subject: text("subject"),
    markdown: text("markdown").notNull().default(""),
    revision: bigint("revision", { mode: "number" }).notNull().default(1),
    lockedBySend: uuid("locked_by_send"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.threadId, t.accountId], foreignColumns: [threads.id, threads.accountId] }),
    foreignKey(
      { columns: [t.replyParentId, t.accountId], foreignColumns: [messages.id, messages.accountId] },
    ),
    foreignKey({ columns: [t.lockedBySend], foreignColumns: [outboundMessages.id] }),
  ],
);

/** A durable, immutable uploaded file. Bytes are written before the row commits. */
export const uploads = pgTable("uploads", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull().unique(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Position of an upload inside one draft. */
export const draftUploads = pgTable(
  "draft_uploads",
  {
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => uploads.id),
    ordinal: integer("ordinal").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.uploadId] }),
    unique("draft_uploads_draft_id_ordinal_key").on(t.draftId, t.ordinal),
  ],
);

/** The immutable snapshot and execution record of one send attempt. */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    recoveryGeneration: uuid("recovery_generation").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    requestHash: text("request_hash").notNull(),
    draftId: uuid("draft_id").references((): AnyPgColumn => drafts.id),
    draftRevision: bigint("draft_revision", { mode: "number" }).notNull(),
    /** Frozen From address and name. */
    identity: jsonb("identity").$type<EmailAddress>().notNull(),
    envelopeSender: text("envelope_sender").notNull(),
    envelopeRecipients: jsonb("envelope_recipients").$type<string[]>().notNull(),
    status: text("status").$type<OutboundStatus>().notNull(),
    /** Populated on confirmed acceptance. */
    logicalMessageId: uuid("logical_message_id").unique(),
    threadId: uuid("thread_id"),
    replyParentId: uuid("reply_parent_id"),
    inReplyTo: text("in_reply_to"),
    referenceIds: jsonb("reference_ids").$type<string[]>().notNull().default([]),
    recipients: jsonb("recipients").$type<Recipients>().notNull(),
    subject: text("subject"),
    markdownSource: text("markdown_source").notNull(),
    html: text("html"),
    /** Generated once, before SMTP. */
    rfcMessageId: text("rfc_message_id").notNull().unique(),
    /** Durable locator for the exact submitted MIME bytes. */
    mimeStorageKey: text("mime_storage_key").notNull(),
    mimeSha256: text("mime_sha256").notNull(),
    /** Protocol result only; never credentials. */
    smtpResponse: jsonb("smtp_response").$type<Record<string, unknown>>(),
    recipientResults: jsonb("recipient_results").$type<RecipientResult[]>().notNull().default([]),
    sendingStartedAt: timestamp("sending_started_at", { withTimezone: true }),
    sentCopyStatus: text("sent_copy_status").$type<SentCopyStatus>().notNull().default("pending"),
    sentFolderId: uuid("sent_folder_id").references(() => folders.id),
    sentUidvalidity: bigint("sent_uidvalidity", { mode: "number" }),
    sentUid: bigint("sent_uid", { mode: "number" }),
    lastError: jsonb("last_error").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "outbound_messages_status_check",
      sql`"status" in ('queued', 'sending', 'sent', 'failed', 'outcome_unknown')`,
    ),
    check(
      "outbound_messages_sent_copy_status_check",
      sql`"sent_copy_status" in ('pending', 'appending', 'stored', 'failed', 'unknown')`,
    ),
    check(
      "outbound_messages_sent_requires_message_check",
      sql`"status" <> 'sent' or "logical_message_id" is not null`,
    ),
    foreignKey({ columns: [t.threadId, t.accountId], foreignColumns: [threads.id, threads.accountId] }),
    foreignKey(
      { columns: [t.logicalMessageId, t.accountId], foreignColumns: [messages.id, messages.accountId] },
    ),
    foreignKey(
      { columns: [t.replyParentId, t.accountId], foreignColumns: [messages.id, messages.accountId] },
    ),
  ],
);

/** Position of an upload inside one queued outbound snapshot. Outbound references keep files alive. */
export const outboundUploads = pgTable(
  "outbound_uploads",
  {
    outboundId: uuid("outbound_id")
      .notNull()
      .references(() => outboundMessages.id),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => uploads.id),
    ordinal: integer("ordinal").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.outboundId, t.uploadId] }),
    unique("outbound_uploads_outbound_id_ordinal_key").on(t.outboundId, t.ordinal),
  ],
);

/** An immutable mail-mutation request executed by the action service. */
export const actions = pgTable("actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  recoveryGeneration: uuid("recovery_generation").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  requestHash: text("request_hash").notNull(),
  kind: text("kind").notNull(),
  /** Immutable scope and desired state. */
  request: jsonb("request").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-target receipt inside one action. Successful items never replay on partial failure. */
export const actionItems = pgTable(
  "action_items",
  {
    actionId: uuid("action_id")
      .notNull()
      .references(() => actions.id),
    itemKey: text("item_key").notNull(),
    target: jsonb("target").$type<ActionItemTarget>().notNull(),
    status: text("status").$type<ActionItemStatus>().notNull(),
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.actionId, t.itemKey] })],
);

/** One raw Jev answer set for a logical message. */
export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id),
  /** Hash of the exact text sent. */
  inputHash: text("input_hash").notNull(),
  /** Pinned model version. */
  model: text("model").notNull(),
  questionSet: text("question_set").notNull(),
  answers: jsonb("answers").$type<Record<string, unknown>>().notNull(),
  confidence: jsonb("confidence").$type<Record<string, unknown>>(),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Precedence level 2: a sender-specific class override. */
export const senderOverrides = pgTable(
  "sender_overrides",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    sender: text("sender").notNull(),
    classHint: text("class_hint"),
    note: text("note"),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.sender] })],
);

/** Reserved for phase 2 work states. No code path reads it in this version. */
export const conversationState = pgTable("conversation_state", {
  conversationId: uuid("conversation_id").primaryKey(),
  workState: text("work_state"),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit trail. Payloads must never contain message bodies or credentials. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** user, system, or api. */
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    // Synchronization reads the newest event of one type for one folder every
    // cycle to decide what is due (SPEC F2 steady state).
    index("events_type_entity_id_idx").on(t.type, t.entityId),
  ],
);

/** Application settings as key-value pairs (SPEC F10). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The single product owner (SPEC section 9). One row exists after the first
 * passkey is registered. Operator recovery preserves this identifier.
 */
export const owner = pgTable(
  "owner",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    /** Unique so credentials, sessions, and challenges can reference it. */
    id: uuid("id").notNull().defaultRandom().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("owner_singleton_check", sql`"singleton"`)],
);

/** A registered passkey. Only the public key is stored. */
export const ownerCredentials = pgTable(
  "owner_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owner.id),
    /** Base64url WebAuthn credential identifier, unique across the owner. */
    credentialId: text("credential_id").notNull().unique(),
    /** Operator-visible name, shown in settings. */
    label: text("label").notNull(),
    /** Base64url COSE public key. */
    publicKey: text("public_key").notNull(),
    /** Signature counter from the last verified assertion. */
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: jsonb("transports").$type<string[] | null>(),
    deviceType: text("device_type"),
    backedUp: boolean("backed_up").notNull().default(false),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  () => [
    check(
      "owner_credentials_device_type_check",
      sql`"device_type" is null or "device_type" in ('singleDevice', 'multiDevice')`,
    ),
  ],
);

/**
 * One owner session. The cookie carries the raw token; this row stores only
 * its SHA-256 hash. Sessions are bound to the recovery generation that was
 * current when they opened.
 */
export const ownerSessions = pgTable(
  "owner_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owner.id),
    tokenHash: text("token_hash").notNull().unique(),
    recoveryGeneration: uuid("recovery_generation").notNull(),
    kind: text("kind").$type<OwnerSessionKind>().notNull().default("standard"),
    /** Time of the last successful passkey verification in this session. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  () => [check("owner_sessions_kind_check", sql`"kind" in ('standard', 'inspection')`)],
);

/**
 * One WebAuthn challenge. Challenges are single-use, expire after five
 * minutes, and are bound to one purpose, one owner, and one recovery
 * generation (SPEC section 9).
 */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose").$type<ChallengePurpose>().notNull(),
    /** Null only for first enrollment: the owner row does not exist yet. */
    ownerId: uuid("owner_id").references(() => owner.id),
    /** Base64url challenge value handed to the client. */
    challenge: text("challenge").notNull(),
    recoveryGeneration: uuid("recovery_generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "webauthn_challenges_purpose_check",
      sql`"purpose" in ('first_enrollment', 'recovery_enrollment', 'add_credential', 'login', 'reverify')`,
    ),
    check(
      "webauthn_challenges_owner_check",
      sql`"owner_id" is not null or "purpose" = 'first_enrollment'`,
    ),
    index("webauthn_challenges_challenge_idx").on(t.challenge),
  ],
);

/**
 * One enrollment grant issued by an operator command. Grants expire after
 * ten minutes, are consumed by first-passkey registration, and store only
 * the SHA-256 of the printed token (SPEC section 9).
 */
export const enrollmentGrants = pgTable(
  "enrollment_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose").$type<GrantPurpose>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    recoveryGeneration: uuid("recovery_generation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("enrollment_grants_purpose_check", sql`"purpose" in ('bootstrap', 'recovery')`),
    // A new grant invalidates any earlier grant for the same purpose.
    uniqueIndex("enrollment_grants_live_purpose_uidx")
      .on(t.purpose)
      .where(sql`"consumed_at" is null and "revoked_at" is null`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MessageOccurrence = typeof messageOccurrences.$inferSelect;
export type Body = typeof bodies.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type Upload = typeof uploads.$inferSelect;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type Action = typeof actions.$inferSelect;
export type ActionItem = typeof actionItems.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Owner = typeof owner.$inferSelect;
export type OwnerCredential = typeof ownerCredentials.$inferSelect;
export type OwnerSession = typeof ownerSessions.$inferSelect;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
export type EnrollmentGrant = typeof enrollmentGrants.$inferSelect;
