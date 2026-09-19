import type {
  ActionMailbox,
  ActionMailboxFlags,
  ActionMailboxState,
} from "../src/mailbox.ts";

/**
 * An in-memory mailbox for the action suite.
 *
 * It implements the read-only session contract the action service refreshes
 * targets through, with scriptable generations and flag answers. The fake
 * executor owns the writes, so both halves of the procedure stay observable.
 */

/** One message the fake mailbox holds. */
export interface FakeMailboxMessage {
  uid: number;
  unread: boolean;
  flagged: boolean;
}

export class FakeActionMailbox implements ActionMailbox {
  /** The generation every select of one folder reports. Change it to script a reset. */
  readonly uidValidity = new Map<string, number>();
  /** Folder path to messages, keyed by folder name. */
  readonly mailboxes = new Map<string, FakeMailboxMessage[]>();
  /** Every folder path that was selected, in order. */
  readonly selections: string[] = [];

  /** Load one folder's messages. */
  load(folder: string, messages: FakeMailboxMessage[], uidValidity = 1): this {
    this.mailboxes.set(folder, messages);
    this.uidValidity.set(folder, uidValidity);
    return this;
  }

  /** Rewrite one folder's generation, as a server rebuild would. */
  setUidValidity(folder: string, uidValidity: number): this {
    this.uidValidity.set(folder, uidValidity);
    return this;
  }

  async select(folder: string): Promise<ActionMailboxState> {
    if (!this.mailboxes.has(folder)) {
      throw new Error(`No mailbox named ${folder} exists.`);
    }
    this.current = folder;
    this.selections.push(folder);
    return this.stateOf(folder);
  }

  async fetchFlags(uids: number[]): Promise<ActionMailboxFlags[]> {
    const current = this.current;
    if (current === null) {
      throw new Error("No mailbox is selected.");
    }
    const wanted = new Set(uids);
    return this.messagesOf(current)
      .filter((message) => wanted.has(message.uid))
      .map((message) => ({ uid: message.uid, unread: message.unread, flagged: message.flagged }));
  }

  async revalidate(): Promise<ActionMailboxState> {
    if (this.current === null) {
      throw new Error("No mailbox is selected to revalidate.");
    }
    return this.stateOf(this.current);
  }

  private current: string | null = null;

  private messagesOf(folder: string): FakeMailboxMessage[] {
    return this.mailboxes.get(folder) ?? [];
  }

  private stateOf(folder: string): ActionMailboxState {
    const messages = this.messagesOf(folder);
    const uidNext = messages.reduce((largest, message) => Math.max(largest, message.uid), 0) + 1;
    return { uidValidity: this.uidValidity.get(folder) ?? 1, uidNext };
  }
}
