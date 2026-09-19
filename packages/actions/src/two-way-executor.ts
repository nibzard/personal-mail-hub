import type { ActionExecutor, ExecutorOutcome, PreparedActionItem } from "./executor.ts";
import type { FlagDesire } from "./kinds.ts";
import type { ActionMailboxFlags, WritableActionMailbox } from "./mailbox.ts";

/**
 * The two-way flag and move executor (SPEC F2 and F4).
 *
 * Every action sets a desired value; none of them toggles a remote value.
 * The two write paths follow the specification exactly:
 *
 * - Flags: when the session can run conditional writes and the target froze a
 *   server modification sequence, the write carries `UNCHANGEDSINCE` with that
 *   sequence. Otherwise the write applies only the requested flag, exactly as
 *   a `+FLAGS` or `-FLAGS` would. Either way the executor reads the flag back
 *   before it confirms anything. A conditional write whose readback misses the
 *   desired value conflicts, with the refreshed state attached. A plain write
 *   that raced a concurrent change confirms with the latest observed state;
 *   the specification forbids claiming timestamp-based ordering for it.
 * - Moves: IMAP `MOVE` only, and only when the server advertises it. Without
 *   the capability the item fails as unavailable; this version defines no
 *   `EXPUNGE` fallback. A lost move response stays unknown so reconciliation
 *   can prove where the message went; the executor never replays it.
 */
export class TwoWayActionExecutor implements ActionExecutor<WritableActionMailbox> {
  async apply(mailbox: WritableActionMailbox, item: PreparedActionItem): Promise<ExecutorOutcome> {
    let capabilities;
    try {
      capabilities = await mailbox.capabilities();
    } catch (cause) {
      return failed("capability_error", cause);
    }
    if (item.desired.type === "flags") {
      return this.applyFlags(mailbox, item, item.desired.desire, capabilities.condstore);
    }
    return this.applyMove(mailbox, item, item.desired.destinationFolderName, capabilities.move);
  }

  /**
   * One explicit flag assignment, with the readback that decides the receipt
   * (SPEC F2).
   */
  private async applyFlags(
    mailbox: WritableActionMailbox,
    item: PreparedActionItem,
    desire: FlagDesire,
    condstore: boolean,
  ): Promise<ExecutorOutcome> {
    // A conditional write needs both a capable session and a captured server
    // modification sequence; anything else writes unconditionally.
    const captured = item.target.modseq ?? null;
    const conditional = condstore && captured !== null;

    let write;
    try {
      write = await mailbox.writeFlag({
        uid: item.target.uid,
        flag: desire.flag,
        value: desire.value,
        unchangedSince: conditional ? captured : null,
      });
    } catch (cause) {
      // A write that threw never proved its outcome either way.
      return unknownOf(cause);
    }
    if (write.result === "uncertain") {
      return { outcome: "unknown", reason: write.reason };
    }

    const readback = await this.readback(mailbox, item.target.uid);
    if (readback === null) {
      // The refreshed mailbox no longer holds the UID. A definitive
      // rejection means the target left before the write; an accepted
      // command may still have applied before it left, so only that
      // outcome stays unknown.
      return write.result === "accepted"
        ? { outcome: "unknown", reason: "The target left the folder before the write could be read back." }
        : { outcome: "conflicted", reason: "absent_remote", observed: item.remote };
    }
    if (readback[desire.flag] === desire.value) {
      return { outcome: "confirmed", observed: readback };
    }
    if (write.result === "rejected" && !conditional) {
      return {
        outcome: "failed",
        code: "write_rejected",
        message: "The server rejected the flag write.",
      };
    }
    // A plain write that applied and still missed the value raced a later
    // concurrent change. The specification resolves that race by showing the
    // latest observed state, with no timestamp-based ordering claimed
    // (SPEC F2).
    if (write.result === "accepted" && !conditional) {
      return { outcome: "confirmed", observed: readback };
    }
    // What remains proved the precondition no longer holds: a rejected
    // condition, or a rejection on a conditional path. The item conflicts
    // with the refreshed state attached (SPEC F2).
    return {
      outcome: "conflicted",
      reason: conditional ? "condstore_rejected" : "write_rejected",
      observed: readback,
    };
  }

  /**
   * One move to a frozen destination, `MOVE` only (SPEC F4). A lost response
   * stays unknown; nothing here replays or falls back to `EXPUNGE`.
   */
  private async applyMove(
    mailbox: WritableActionMailbox,
    item: PreparedActionItem,
    destinationFolderName: string,
    move: boolean,
  ): Promise<ExecutorOutcome> {
    if (!move) {
      return {
        outcome: "failed",
        code: "move_unsupported",
        message: "The server does not support MOVE, so move and archive are unavailable.",
      };
    }
    let moved;
    try {
      moved = await mailbox.moveMessage({
        uid: item.target.uid,
        destinationFolder: destinationFolderName,
      });
    } catch (cause) {
      return unknownOf(cause);
    }
    if (moved.result === "uncertain") {
      return { outcome: "unknown", reason: moved.reason };
    }
    if (moved.result === "rejected") {
      return {
        outcome: "failed",
        code: "move_rejected",
        message: "The server rejected the move.",
      };
    }
    return { outcome: "confirmed", observed: item.remote, movedTo: moved.destination };
  }

  /** The flags of one UID after a write, or `null` when the UID is gone. */
  private async readback(mailbox: WritableActionMailbox, uid: number): Promise<ActionMailboxFlags | null> {
    const flags = await mailbox.fetchFlags([uid]);
    return flags.length === 0 ? null : flags[0]!;
  }
}

/** Map one thrown write to an unknown outcome with a bounded reason. */
function unknownOf(cause: unknown): ExecutorOutcome {
  return {
    outcome: "unknown",
    reason:
      cause instanceof Error && cause.message
        ? cause.message
        : "The mailbox ended the write without an answer.",
  };
}

function failed(code: string, cause: unknown): ExecutorOutcome {
  return {
    outcome: "failed",
    code,
    message:
      cause instanceof Error && cause.message
        ? cause.message
        : "The mailbox capabilities could not be read.",
  };
}
