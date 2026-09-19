import type { ActionExecutor, ExecutorOutcome, PreparedActionItem } from "../src/index.ts";
import type { FakeActionMailbox } from "./fake-action-mailbox.ts";

/**
 * A scriptable executor for the action suite.
 *
 * The default behavior applies the prepared item to the fake mailbox the way
 * a server would and confirms with the flags it read back. Tests queue
 * exceptions and unknown outcomes per call.
 */

/** What one executor call does. */
export type ScriptedExecution =
  | { kind: "confirm" }
  | { kind: "unknown"; reason: string }
  | { kind: "throw"; error: Error };

export class FakeActionExecutor implements ActionExecutor<FakeActionMailbox> {
  /** Every prepared item the executor received, in order. */
  readonly calls: PreparedActionItem[] = [];
  private readonly script: ScriptedExecution[] = [];

  /** Queue the behavior of the next calls, in order. Unqueued calls confirm. */
  queue(...behaviors: ScriptedExecution[]): this {
    this.script.push(...behaviors);
    return this;
  }

  async apply(mailbox: FakeActionMailbox, item: PreparedActionItem): Promise<ExecutorOutcome> {
    this.calls.push(item);
    const behavior = this.script.shift() ?? { kind: "confirm" };
    if (behavior.kind === "throw") {
      throw behavior.error;
    }
    if (behavior.kind === "unknown") {
      return { outcome: "unknown", reason: behavior.reason };
    }
    const message = mailbox.mailboxes
      .get(item.folder.name)
      ?.find((candidate) => candidate.uid === item.target.uid);
    if (message === undefined) {
      return { outcome: "failed", code: "absent", message: "The UID no longer exists on the server." };
    }
    if (item.desired.type === "flags") {
      message[item.desired.desire.flag] = item.desired.desire.value;
    }
    return { outcome: "confirmed", observed: { uid: message.uid, unread: message.unread, flagged: message.flagged } };
  }
}
