import type { ConnectionTimeouts } from "@mail-hub/transport";

/**
 * The mailbox view synchronization needs (SPEC F2).
 *
 * One session is one open connection to one account. Backfill holds one
 * session per account and walks its folders in turn, so polls and user
 * actions keep their turn on the event loop between batches. Everything a
 * session reads is read with `BODY.PEEK`: synchronization never changes
 * server state.
 */

/** One selected mailbox: its generation and the next predicted UID. */
export interface MailboxState {
  uidValidity: number;
  uidNext: number;
}

/**
 * Header fields the header import fetches. The server returns only these
 * lines, which bounds each fetch exactly like the UID window does.
 */
export const IMPORTED_HEADER_FIELDS = [
  "date",
  "from",
  "sender",
  "reply-to",
  "to",
  "cc",
  "bcc",
  "subject",
  "message-id",
  "in-reply-to",
  "references",
] as const;

/** One header-import record from the selected folder. */
export interface MailboxHeaders {
  uid: number;
  /** True when the server flags lack `\Seen`. */
  unread: boolean;
  flagged: boolean;
  internalDate: Date;
  /** `RFC822.SIZE` in octets. */
  sizeBytes: number;
  /** The raw header lines exactly as the server returned them. */
  rawHeaders: Uint8Array;
}

/** One observed flag set of the selected folder. */
export interface MailboxFlags {
  uid: number;
  unread: boolean;
  flagged: boolean;
  /**
   * The modification sequence the answer carried. Present only on a session
   * with CONDSTORE enabled; a conditional write captures it (SPEC F2).
   */
  modseq?: string | null;
}

/** One open mailbox connection bound to a single selected folder at a time. */
export interface MailboxSession {
  /**
   * Select one folder and report its generation. Selecting again is always a
   * fresh `SELECT`, so the returned `uidValidity` is the server's current
   * answer, never a cached one.
   */
  select(folder: string): Promise<MailboxState>;

  /** The UIDs that exist inside one inclusive range. Ranges may hold gaps. */
  searchUids(low: number, high: number): Promise<number[]>;

  /** Headers and flags for specific UIDs of the selected folder. */
  fetchHeaders(uids: number[]): Promise<MailboxHeaders[]>;

  /**
   * Flags only, for specific UIDs of the selected folder. UIDs the server
   * omits from the answer no longer exist; callers treat them as absent.
   */
  fetchFlags(uids: number[]): Promise<MailboxFlags[]>;

  /** The complete bytes of one message, or `null` when the UID no longer exists. */
  fetchOriginal(uid: number): Promise<Uint8Array | null>;

  /** Re-select the current folder and report its generation again. */
  revalidate(): Promise<MailboxState>;

  /** Close the connection gracefully. */
  logout(): Promise<void>;
}

/** Connection settings and opened credentials for one account. Workers only. */
export interface MailboxConnection {
  host: string;
  port: number;
  username: string;
  password: string;
  /**
   * PEM certificate authorities to trust in addition to the system store.
   * Tests inject their trusted test authority here; production passes
   * nothing (SPEC section 9).
   */
  trustedCaPem?: string[];
  timeouts?: Partial<ConnectionTimeouts>;
}

/** Opens one verified mailbox connection per call. */
export interface MailboxSessionFactory {
  open(connection: MailboxConnection): Promise<MailboxSession>;
}

/**
 * The classified answer of one message append (SPEC F7 step 5). `appended`
 * carries the destination coordinates the server reported, which need the
 * UIDPLUS extension; `uncertain` means the response was lost and the outcome
 * needs reconciliation, never a blind replay.
 */
export type AppendMessageResult =
  | { result: "appended"; uidvalidity: number | null; uid: number | null }
  | { result: "rejected" }
  | { result: "uncertain"; reason: string };

/**
 * A session that can store sent copies and locate them again by their
 * generated identifier (SPEC F7 step 5). The outbound pipeline declares the
 * same shape as its own port, so one open connection serves both without a
 * dependency between the packages.
 */
export interface SentCopyMailboxSession extends MailboxSession {
  /**
   * UIDs in the selected folder whose `Message-ID` header carries the
   * identifier. The match is a substring one; callers verify candidate
   * content before trusting it.
   */
  searchByMessageId(rfcMessageId: string): Promise<number[]>;

  /** Append complete message bytes to one folder. */
  appendMessage(folder: string, bytes: Uint8Array): Promise<AppendMessageResult>;
}
