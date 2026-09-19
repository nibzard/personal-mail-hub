import { describe, expect, it } from "vitest";
import type { ActionItemTarget } from "@mail-hub/database";
import type { PreparedActionItem } from "../src/executor.ts";
import { TwoWayActionExecutor } from "../src/two-way-executor.ts";
import { FakeActionMailbox } from "./fake-action-mailbox.ts";

/**
 * The two-way flag and move decision table (SPEC F2 and F4), exercised
 * against the in-memory mailbox. The service suite covers the persistence
 * these outcomes drive; this one pins which outcome each server answer
 * produces.
 */

const executor = new TwoWayActionExecutor();

function target(overrides: Partial<ActionItemTarget> = {}): ActionItemTarget {
  return {
    occurrenceId: "0b156060-59ac-4a01-b6d7-48bf1c0fd48e",
    accountId: ACCOUNT,
    folderId: "7c97d5b2-51bd-4a8e-9c47-c6b53a6d0000",
    uidvalidity: 1,
    uid: 4,
    revision: 1,
    observed: { unread: true, flagged: false },
    modseq: null,
    ...overrides,
  };
}

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function prepared(
  desired: PreparedActionItem["desired"],
  itemTarget: ActionItemTarget = target(),
): PreparedActionItem {
  return {
    actionId: "22222222-2222-4222-8222-222222222222",
    itemKey: itemTarget.occurrenceId,
    kind: "mark_read",
    accountId: ACCOUNT,
    folder: { id: itemTarget.folderId, name: "INBOX", uidvalidity: itemTarget.uidvalidity },
    target: itemTarget,
    remote: { uid: itemTarget.uid, unread: true, flagged: false },
    desired,
  };
}

/** One selected mailbox holding one unread, unflagged message at UID 4. */
function mailboxWithMessage(modseq?: string): FakeActionMailbox {
  const mailbox = new FakeActionMailbox();
  mailbox.load("INBOX", [{ uid: 4, unread: true, flagged: false, ...(modseq === undefined ? {} : { modseq }) }]);
  mailbox.load("Archive", []);
  void mailbox.select("INBOX");
  return mailbox;
}

describe("TwoWayActionExecutor flags", () => {
  it("writes only the requested flag and confirms from the readback", async () => {
    const mailbox = mailboxWithMessage();
    const outcome = await executor.apply(mailbox, prepared({ type: "flags", desire: { flag: "unread", value: false } }));
    // Unconditional: no CONDSTORE, so no captured sequence travels (SPEC F2).
    expect(mailbox.flagWrites).toEqual([
      { uid: 4, flag: "unread", value: false, unchangedSince: null },
    ]);
    expect(outcome).toEqual({
      outcome: "confirmed",
      observed: { uid: 4, unread: false, flagged: false },
    });
    const message = mailbox.mailboxes.get("INBOX")![0]!;
    expect([message.unread, message.flagged]).toEqual([false, false]);
  });

  it("writes conditionally when the session and the frozen target allow it", async () => {
    const mailbox = mailboxWithMessage("5");
    mailbox.writes.condstore = true;
    const outcome = await executor.apply(
      mailbox,
      prepared({ type: "flags", desire: { flag: "flagged", value: true } }, target({ modseq: "5" })),
    );
    expect(mailbox.flagWrites).toEqual([
      { uid: 4, flag: "flagged", value: true, unchangedSince: "5" },
    ]);
    expect(outcome).toEqual({
      outcome: "confirmed",
      observed: { uid: 4, unread: true, flagged: true, modseq: "6" },
    });
  });

  it("falls back to an unconditional write when no sequence was captured", async () => {
    const mailbox = mailboxWithMessage();
    mailbox.writes.condstore = true;
    await executor.apply(mailbox, prepared({ type: "flags", desire: { flag: "unread", value: false } }));
    expect(mailbox.flagWrites).toEqual([
      { uid: 4, flag: "unread", value: false, unchangedSince: null },
    ]);
  });

  it("conflicts with the refreshed state when a conditional write is rejected", async () => {
    const mailbox = mailboxWithMessage("5");
    mailbox.writes.condstore = true;
    // The server accepts the command, but a concurrent change wins and the
    // value never holds (SPEC F2: refresh and conflict check).
    mailbox.queue({ kind: "accept_without_effect" });
    const outcome = await executor.apply(
      mailbox,
      prepared({ type: "flags", desire: { flag: "flagged", value: true } }, target({ modseq: "5" })),
    );
    expect(outcome).toEqual({
      outcome: "conflicted",
      reason: "condstore_rejected",
      observed: { uid: 4, unread: true, flagged: false, modseq: "5" },
    });
  });

  it("confirms a plain write that raced a concurrent change, latest state shown", async () => {
    const mailbox = mailboxWithMessage();
    mailbox.queue({ kind: "accept_without_effect" });
    const outcome = await executor.apply(mailbox, prepared({ type: "flags", desire: { flag: "unread", value: false } }));
    expect(outcome).toEqual({
      outcome: "confirmed",
      observed: { uid: 4, unread: true, flagged: false },
    });
  });

  it("fails a plainly rejected write", async () => {
    const mailbox = mailboxWithMessage();
    mailbox.queue({ kind: "reject" });
    const outcome = await executor.apply(mailbox, prepared({ type: "flags", desire: { flag: "unread", value: false } }));
    expect(outcome).toEqual({
      outcome: "failed",
      code: "write_rejected",
      message: "The server rejected the flag write.",
    });
  });

  it("holds an uncertain or thrown write as unknown", async () => {
    const uncertain = mailboxWithMessage();
    uncertain.queue({ kind: "uncertain", reason: "The final response was lost." });
    await expect(
      executor.apply(uncertain, prepared({ type: "flags", desire: { flag: "unread", value: false } })),
    ).resolves.toEqual({ outcome: "unknown", reason: "The final response was lost." });

    const thrown = mailboxWithMessage();
    thrown.queue({ kind: "throw", error: new Error("The socket closed.") });
    await expect(
      executor.apply(thrown, prepared({ type: "flags", desire: { flag: "unread", value: false } })),
    ).resolves.toEqual({ outcome: "unknown", reason: "The socket closed." });
  });

  it("holds an accepted write unknown when the target left before the readback", async () => {
    const mailbox = mailboxWithMessage();
    // The write applies, then the message moves away under the readback.
    mailbox.queue({ kind: "apply", vanishAfter: true });
    const outcome = await executor.apply(mailbox, prepared({ type: "flags", desire: { flag: "unread", value: false } }));
    expect(outcome).toEqual({
      outcome: "unknown",
      reason: "The target left the folder before the write could be read back.",
    });
  });

  it("conflicts a rejected write whose target already left", async () => {
    const mailbox = mailboxWithMessage();
    mailbox.queue({ kind: "reject" });
    mailbox.mailboxes.set("INBOX", []);
    const outcome = await executor.apply(mailbox, prepared({ type: "flags", desire: { flag: "unread", value: false } }));
    expect(outcome).toEqual({
      outcome: "conflicted",
      reason: "absent_remote",
      observed: { uid: 4, unread: true, flagged: false },
    });
  });
});

describe("TwoWayActionExecutor moves", () => {
  const moveDesired = {
    type: "move" as const,
    destinationFolderId: "7c97d5b2-51bd-4a8e-9c47-c6b53a6d0fff",
    destinationFolderName: "Archive",
  };

  it("reports moves unavailable without the MOVE capability", async () => {
    const mailbox = mailboxWithMessage();
    mailbox.writes.move = false;
    const outcome = await executor.apply(mailbox, prepared(moveDesired));
    expect(outcome).toEqual({
      outcome: "failed",
      code: "move_unsupported",
      message: "The server does not support MOVE, so move and archive are unavailable.",
    });
    expect(mailbox.moveRequests).toEqual([]);
  });

  it("confirms a move with the destination the server reported", async () => {
    const mailbox = mailboxWithMessage();
    const outcome = await executor.apply(mailbox, prepared(moveDesired));
    expect(mailbox.moveRequests).toEqual([{ uid: 4, destinationFolder: "Archive" }]);
    expect(mailbox.mailboxes.get("INBOX")).toEqual([]);
    expect(mailbox.mailboxes.get("Archive")!).toEqual([
      { uid: 101, unread: true, flagged: false },
    ]);
    expect(outcome).toEqual({
      outcome: "confirmed",
      observed: { uid: 4, unread: true, flagged: false },
      movedTo: { folder: "Archive", uidvalidity: 1, uid: 101 },
    });
  });

  it("holds a lost move response unknown", async () => {
    const mailbox = mailboxWithMessage();
    mailbox.queue({ kind: "uncertain", reason: "The connection dropped." });
    const outcome = await executor.apply(mailbox, prepared(moveDesired));
    expect(outcome).toEqual({ outcome: "unknown", reason: "The connection dropped." });
    // The message never left; nothing replays it (SPEC F4).
    expect(mailbox.mailboxes.get("INBOX")).toHaveLength(1);
  });

  it("fails a move the server rejected", async () => {
    const mailbox = mailboxWithMessage();
    mailbox.queue({ kind: "reject" });
    const outcome = await executor.apply(mailbox, prepared(moveDesired));
    expect(outcome).toEqual({
      outcome: "failed",
      code: "move_rejected",
      message: "The server rejected the move.",
    });
  });
});
