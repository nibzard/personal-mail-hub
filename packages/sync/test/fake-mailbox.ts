import { SyncError } from "../src/errors.ts";
import type {
  MailboxFlags,
  MailboxHeaders,
  MailboxSession,
  MailboxState,
} from "../src/mailbox.ts";

/**
 * An in-memory mailbox for the synchronization suite.
 *
 * It implements the whole session contract with scripted state: UID gaps,
 * generation changes, missing messages, and failures between commands. The
 * scripted IMAP server of the harness task covers the wire protocol; this
 * double lets every checkpoint rule run against the real database.
 */

/** One message the fake mailbox holds. */
export interface FakeMessage {
  uid: number;
  /** Raw header lines, exactly what a header fetch would return. */
  headers: string;
  /** Body placed after the blank line to form the complete bytes. */
  body: string;
  /** Server flags, for example `["\\Seen", "\\Flagged"]`. */
  flags?: string[];
  internalDate?: Date;
}

/** Errors the fake throws when scripted to. */
export interface FakeFailures {
  select?: Error;
  search?: Error;
  fetchHeaders?: Error;
  fetchFlags?: Error;
  fetchOriginal?: Error;
  revalidate?: Error;
}

export class FakeMailboxSession implements MailboxSession {
  /** The generation every select reports. Change it to script a reset. */
  uidValidity = 1;
  /**
   * The least UIDNEXT a select reports. A folder always reports at least its
   * newest UID plus one, so loading messages is enough; raise this field to
   * script a server that reserved UIDs no message holds.
   */
  uidNext = 1;
  /** Folder path to messages, keyed by folder name. */
  readonly mailboxes = new Map<string, FakeMessage[]>();
  /** Failures to raise once, before the named step succeeds again. */
  readonly failures: FakeFailures = {};
  /** Every folder path that was selected, in order. */
  readonly selections: string[] = [];

  private current: string | null = null;

  /** Load one folder's messages. UIDs need no order; gaps may exist. */
  load(folder: string, messages: FakeMessage[]): this {
    this.mailboxes.set(folder, messages);
    return this;
  }

  async select(folder: string): Promise<MailboxState> {
    this.failOnce("select");
    if (!this.mailboxes.has(folder)) {
      throw new SyncError("mailbox_error", `No mailbox named ${folder} exists.`);
    }
    this.current = folder;
    this.selections.push(folder);
    return { uidValidity: this.uidValidity, uidNext: this.nextUid(folder) };
  }

  async searchUids(low: number, high: number): Promise<number[]> {
    this.failOnce("search");
    return this.messagesOfCurrent()
      .map((message) => message.uid)
      .filter((uid) => uid >= low && uid <= high)
      .sort((a, b) => a - b);
  }

  async fetchHeaders(uids: number[]): Promise<MailboxHeaders[]> {
    this.failOnce("fetchHeaders");
    const wanted = new Set(uids);
    return this.messagesOfCurrent()
      .filter((message) => wanted.has(message.uid))
      .map((message) => ({
        uid: message.uid,
        unread: !(message.flags ?? []).includes("\\Seen"),
        flagged: (message.flags ?? []).includes("\\Flagged"),
        internalDate: message.internalDate ?? new Date("2026-09-01T09:00:00Z"),
        sizeBytes: completeBytes(message).byteLength,
        rawHeaders: new TextEncoder().encode(message.headers),
      }));
  }

  async fetchFlags(uids: number[]): Promise<MailboxFlags[]> {
    this.failOnce("fetchFlags");
    const wanted = new Set(uids);
    return this.messagesOfCurrent()
      .filter((message) => wanted.has(message.uid))
      .map((message) => ({
        uid: message.uid,
        unread: !(message.flags ?? []).includes("\\Seen"),
        flagged: (message.flags ?? []).includes("\\Flagged"),
      }));
  }

  async fetchOriginal(uid: number): Promise<Uint8Array | null> {
    this.failOnce("fetchOriginal");
    const message = this.messagesOfCurrent().find((candidate) => candidate.uid === uid);
    return message === undefined ? null : completeBytes(message);
  }

  async revalidate(): Promise<MailboxState> {
    this.failOnce("revalidate");
    if (this.current === null) {
      throw new SyncError("mailbox_error", "No mailbox is selected to revalidate.");
    }
    return { uidValidity: this.uidValidity, uidNext: this.nextUid(this.current) };
  }

  async logout(): Promise<void> {
    this.current = null;
  }

  /** Raise a scripted failure once, then clear it. */
  private failOnce(step: keyof FakeFailures): void {
    const error = this.failures[step];
    if (error !== undefined) {
      delete this.failures[step];
      throw error;
    }
  }

  private messagesOfCurrent(): FakeMessage[] {
    if (this.current === null) {
      throw new SyncError("mailbox_error", "No mailbox is selected.");
    }
    return this.mailboxes.get(this.current) ?? [];
  }

  /** UIDNEXT for one folder: past its newest UID, never below the floor. */
  private nextUid(folder: string): number {
    const messages = this.mailboxes.get(folder) ?? [];
    const maxUid = messages.reduce((largest, message) => Math.max(largest, message.uid), 0);
    return Math.max(this.uidNext, maxUid + 1);
  }
}

/** The complete message bytes: headers, blank line, then the body. */
function completeBytes(message: FakeMessage): Uint8Array {
  const text = `${message.headers}\r\n\r\n${message.body}`;
  return new TextEncoder().encode(text);
}
