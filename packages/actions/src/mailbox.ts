/**
 * The remote mailbox view the action service needs (SPEC section 7, step 3).
 *
 * The port stays read-only: the service refreshes target state and checks the
 * folder generation before any mutation, then hands the prepared item to an
 * executor that owns the write. The synchronization session satisfies this
 * interface structurally, so one open connection serves both.
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
