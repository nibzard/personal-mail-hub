import type { FlagDesire } from "./kinds.ts";

/**
 * The remote mailbox view the action service needs (SPEC section 7, step 3).
 *
 * The base port stays read-only: the service refreshes target state and checks
 * the folder generation before any mutation, then hands the prepared item to
 * an executor that owns the write. The synchronization session satisfies this
 * interface structurally, so one open connection serves both. A session that
 * also carries the two-way writes implements `WritableActionMailbox`, and the
 * same executor drives them (SPEC F2 and F4).
 */

/** One selected mailbox: its generation and the next predicted UID. */
export interface ActionMailboxState {
  uidValidity: number;
  uidNext: number;
}

/** One observed flag set of the selected folder. */
export interface ActionMailboxFlags {
  uid: number;
  unread: boolean;
  flagged: boolean;
  /**
   * The server modification sequence this observation carried, when the
   * session reports one. A later conditional write captures it (SPEC F2).
   */
  modseq?: string | null;
}

/** One open mailbox connection bound to a single selected folder at a time. */
export interface ActionMailbox {
  /**
   * Select one folder and report its generation. Selecting is always a fresh
   * `SELECT`, so the returned `uidValidity` is the server's current answer,
   * never a cached one (SPEC F2).
   */
  select(folder: string): Promise<ActionMailboxState>;

  /**
   * Flags for specific UIDs of the selected folder. UIDs the server omits
   * from the answer no longer exist; the service treats them as absent.
   */
  fetchFlags(uids: number[]): Promise<ActionMailboxFlags[]>;

  /** Re-select the current folder and report its generation again. */
  revalidate(): Promise<ActionMailboxState>;
}

/** The capabilities the two-way write paths consult (SPEC F2 and F4). */
export interface ActionMailboxCapabilities {
  /**
   * True when conditional writes are usable on this session: the server
   * advertises CONDSTORE, the session enabled it, and the selected folder
   * reports modification sequences.
   */
  condstore: boolean;
  /** True when the server advertises IMAP `MOVE` (SPEC F4). */
  move: boolean;
}

/** One explicit flag assignment the mailbox must perform (SPEC F2). */
export interface FlagWriteRequest {
  uid: number;
  flag: FlagDesire["flag"];
  value: boolean;
  /**
   * The server modification sequence captured when the target froze. A
   * non-null value asks for a conditional write; `null` writes
   * unconditionally. Implementations may only honor the condition when they
   * also report `condstore: true`.
   */
  unchangedSince: string | null;
}

/** One move the mailbox must perform (SPEC F4). */
export interface MoveWriteRequest {
  uid: number;
  /** The destination folder path, resolved from the frozen identifier. */
  destinationFolder: string;
}

/**
 * The answer of one flag write. `accepted` means the server accepted the
 * command, not that the value now holds: the executor reads the flag back
 * before it confirms anything (SPEC F2).
 */
export type FlagWriteResult =
  | { result: "accepted" }
  | { result: "rejected" }
  | { result: "uncertain"; reason: string };

/**
 * The answer of one move. `moved` carries the destination the server
 * reported; `uncertain` means the response was lost and the outcome needs
 * reconciliation, never a blind replay (SPEC F4).
 */
export type MoveWriteResult =
  | { result: "moved"; destination: MoveDestination }
  | { result: "rejected" }
  | { result: "uncertain"; reason: string };

/** Where a moved message landed, as far as the server reported it. */
export interface MoveDestination {
  folder: string;
  uidvalidity: number | null;
  uid: number | null;
}

/**
 * One open mailbox connection that also performs the two-way writes. The
 * writes are the only mutating surface: every read stays a read.
 */
export interface WritableActionMailbox extends ActionMailbox {
  /** Report the write capabilities of this session and its selected folder. */
  capabilities(): Promise<ActionMailboxCapabilities>;

  /**
   * Set one flag of one UID to one explicit value. The request never toggles:
   * `value` is the desired state (SPEC F2).
   */
  writeFlag(request: FlagWriteRequest): Promise<FlagWriteResult>;

  /**
   * Move one UID to the destination folder. An implementation reports
   * `rejected` rather than falling back to a copy-and-expunge; this version
   * defines no `EXPUNGE` path (SPEC F4).
   */
  moveMessage(request: MoveWriteRequest): Promise<MoveWriteResult>;
}
