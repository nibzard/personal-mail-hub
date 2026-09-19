import type {
  ActionMailboxCapabilities,
  ActionMailboxFlags,
  ActionMailboxState,
  FlagWriteRequest,
  FlagWriteResult,
  MoveDestination,
  MoveWriteRequest,
  MoveWriteResult,
  WritableActionMailbox,
} from "../src/index.ts";

/**
 * An in-memory mailbox for the action suite.
 *
 * It implements the session contract the action service refreshes targets
 * through, with scriptable generations, flag answers, and write results. The
 * default write behavior applies the request the way a server would and lets
 * the readback observe it, so both halves of the procedure stay observable.
 */

/** One message the fake mailbox holds. */
export interface FakeMailboxMessage {
  uid: number;
  unread: boolean;
  flagged: boolean;
  /** The modification sequence this copy reports, when CONDSTORE is on. */
  modseq?: string | null;
}

/** What one write does. Unscripted writes apply and answer like a server. */
export type ScriptedWrite =
  /** `vanishAfter` applies the write, then removes the target: the write
   * landed but the readback cannot find it. */
  | { kind: "apply"; vanishAfter?: boolean }
  /** The server accepts the command but the value does not end up holding. */
  | { kind: "accept_without_effect" }
  | { kind: "reject" }
  | { kind: "uncertain"; reason: string }
  | { kind: "throw"; error: Error }
  /** A move that succeeds; the optional destination overrides the answer. */
  | { kind: "move"; destination?: Partial<MoveDestination> };

export class FakeActionMailbox implements WritableActionMailbox {
  /** The generation every select of one folder reports. Change it to script a reset. */
  readonly uidValidity = new Map<string, number>();
  /** Folder path to messages, keyed by folder name. */
  readonly mailboxes = new Map<string, FakeMailboxMessage[]>();
  /** Every folder path that was selected, in order. */
  readonly selections: string[] = [];
  /** The write capabilities the session reports. */
  readonly writes: ActionMailboxCapabilities = { condstore: false, move: true };
  /** Every flag write the session received, in order. */
  readonly flagWrites: FlagWriteRequest[] = [];
  /** Every move the session received, in order. */
  readonly moveRequests: MoveWriteRequest[] = [];

  private readonly script: ScriptedWrite[] = [];
  private current: string | null = null;

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

  /** Queue the behavior of the next writes, in order. */
  queue(...behaviors: ScriptedWrite[]): this {
    this.script.push(...behaviors);
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
      .map((message) => ({
        uid: message.uid,
        unread: message.unread,
        flagged: message.flagged,
        ...(message.modseq === undefined ? {} : { modseq: message.modseq }),
      }));
  }

  async revalidate(): Promise<ActionMailboxState> {
    if (this.current === null) {
      throw new Error("No mailbox is selected to revalidate.");
    }
    return this.stateOf(this.current);
  }

  async capabilities(): Promise<ActionMailboxCapabilities> {
    return { condstore: this.writes.condstore, move: this.writes.move };
  }

  async writeFlag(request: FlagWriteRequest): Promise<FlagWriteResult> {
    const behavior = this.script.shift() ?? { kind: "apply" };
    this.flagWrites.push(request);
    if (behavior.kind === "throw") {
      throw behavior.error;
    }
    if (behavior.kind === "reject") {
      return { result: "rejected" };
    }
    if (behavior.kind === "uncertain") {
      return { result: "uncertain", reason: behavior.reason };
    }
    const message = this.messageOf(request.uid);
    if (message === undefined) {
      return { result: "rejected" };
    }
    if (behavior.kind === "apply") {
      message[request.flag] = request.value;
      if (request.unchangedSince !== null) {
        // A server advances the modification sequence of a stored message.
        message.modseq = nextModseq(message.modseq);
      }
      if (behavior.vanishAfter === true) {
        const folder = this.current!;
        this.mailboxes.set(folder, this.messagesOf(folder).filter((candidate) => candidate.uid !== request.uid));
      }
    }
    return { result: "accepted" };
  }

  async moveMessage(request: MoveWriteRequest): Promise<MoveWriteResult> {
    const behavior = this.script.shift() ?? { kind: "move" as const };
    this.moveRequests.push(request);
    if (behavior.kind === "throw") {
      throw behavior.error;
    }
    if (behavior.kind === "reject") {
      return { result: "rejected" };
    }
    if (behavior.kind === "uncertain") {
      return { result: "uncertain", reason: behavior.reason };
    }
    if (behavior.kind !== "move") {
      return { result: "rejected" };
    }
    const source = this.current ?? "";
    const message = this.messageOf(request.uid);
    if (message === undefined) {
      return { result: "rejected" };
    }
    if (!this.mailboxes.has(request.destinationFolder)) {
      return { result: "rejected" };
    }
    // The message leaves the source and lands at the destination's next UID,
    // exactly as a `MOVE` would place it.
    this.mailboxes.set(
      source,
      this.messagesOf(source).filter((candidate) => candidate.uid !== request.uid),
    );
    const destinationMessages = this.messagesOf(request.destinationFolder);
    const landed: FakeMailboxMessage = { ...message, uid: nextUid(destinationMessages) };
    destinationMessages.push(landed);
    const destination: MoveDestination = {
      folder: request.destinationFolder,
      uidvalidity: this.uidValidity.get(request.destinationFolder) ?? 1,
      uid: landed.uid,
      ...behavior.destination,
    };
    return { result: "moved", destination };
  }

  private messageOf(uid: number): FakeMailboxMessage | undefined {
    const folder = this.current;
    if (folder === null) {
      return undefined;
    }
    return (this.mailboxes.get(folder) ?? []).find((candidate) => candidate.uid === uid);
  }

  private messagesOf(folder: string): FakeMailboxMessage[] {
    return this.mailboxes.get(folder) ?? [];
  }

  private stateOf(folder: string): ActionMailboxState {
    const messages = this.messagesOf(folder);
    const uidNext = messages.reduce((largest, message) => Math.max(largest, message.uid), 0) + 1;
    return { uidValidity: this.uidValidity.get(folder) ?? 1, uidNext };
  }
}

function nextModseq(modseq: string | null | undefined): string {
  return String(Number(modseq ?? "0") + 1);
}

function nextUid(messages: FakeMailboxMessage[]): number {
  return messages.reduce((largest, message) => Math.max(largest, message.uid), 100) + 1;
}
