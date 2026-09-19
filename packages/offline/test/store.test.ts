import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchResultItem } from "@mail-hub/contracts";
import { OfflineStore, isQuotaError } from "../src/index.ts";

/*
 * The Dexie records (SPEC F9): recent mail with details, local drafts,
 * upload bytes until acknowledgement, and a queue whose payloads freeze at
 * queue time.
 */

const GENERATION = "11111111-1111-4111-8111-111111111111";

/** One deterministic store: a settable clock and sequential ids. */
function makeStore() {
  let clock = 1_000;
  let sequence = 0;
  const store = new OfflineStore({
    name: `store-test-${Math.random().toString(36).slice(2)}`,
    now: () => clock,
    newId: () => `local-${(sequence += 1)}`,
  });
  return {
    store,
    advance: (step: number) => {
      clock += step;
    },
    nextId: () => `local-${(sequence += 1)}`,
  };
}

const stores: OfflineStore[] = [];

function freshStore() {
  const made = makeStore();
  stores.push(made.store);
  return made;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

function row(messageId: string, sentAt: string): SearchResultItem {
  return {
    messageId,
    accountId: "a1",
    accountLabel: "Personal",
    accountColor: "#336699",
    threadId: null,
    subject: `Subject ${messageId}`,
    snippet: "Snippet.",
    sender: { address: "boss@example.com", name: "Boss" },
    sentAt,
    fetchedBody: true,
    hasAttachments: false,
    unread: true,
    flagged: false,
    activeOccurrences: 1,
    occurrences: [{ occurrenceId: "occ-1", folderId: "f-1", revision: 1, modseq: null }],
    noServerCopy: false,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
  };
}

describe("recent mail", () => {
  it("caches rows and details together, newest row first", async () => {
    const { store } = freshStore();
    await store.cacheMessageRow(row("m2", "2026-09-18T10:00:00Z"));
    await store.cacheMessageRow(row("m1", "2026-09-18T11:00:00Z"));
    await store.cacheMessageDetail({
      id: "m2",
      accountId: "a1",
      threadId: null,
      subject: "Subject m2",
      sender: null,
      recipients: null,
      sentAt: "2026-09-18T10:00:00Z",
      fetchedBody: true,
      htmlSanitized: "<p>Safe.</p>",
      textPlain: "Safe.",
      attachments: [],
      classification: {
        classHint: null,
        source: null,
        asksAction: null,
        asksReply: null,
        timeSensitive: null,
      },
    });

    const rows = await store.cachedRows();
    expect(rows.map((entry) => entry.messageId)).toEqual(["m1", "m2"]);
    expect((await store.cachedDetail("m2"))?.htmlSanitized).toBe("<p>Safe.</p>");
    expect(await store.cachedDetail("m1")).toBeNull();
  });

  it("prunes the oldest rows and keeps the newest", async () => {
    const { store, advance } = freshStore();
    await store.cacheMessageRow(row("m1", "2026-09-18T11:00:00Z"));
    advance(10);
    await store.cacheMessageRow(row("m2", "2026-09-18T10:00:00Z"));
    advance(10);
    await store.cacheMessageRow(row("m3", "2026-09-18T09:00:00Z"));

    await store.pruneRecentMail(2);
    const rows = await store.cachedRows();
    // The two newest downloads stay; the first one cached was pruned.
    expect(rows.map((entry) => entry.messageId)).toEqual(["m2", "m3"]);
  });
});

describe("local drafts", () => {
  it("keeps the local copy with its base revision and generation", async () => {
    const { store } = freshStore();
    await store.putLocalDraft({
      draftId: "d1",
      accountId: "a1",
      server: null,
      identity: { address: "me@example.com" },
      recipients: { to: [{ address: "boss@example.com" }] },
      subject: "Local edits",
      markdown: "Not yet acknowledged.",
      baseRevision: 3,
      dirty: true,
      recoveryGeneration: GENERATION,
      updatedAt: 0,
    });

    const draft = await store.getLocalDraft("d1");
    expect(draft?.markdown).toBe("Not yet acknowledged.");
    expect(draft?.dirty).toBe(true);
    expect(await store.getLocalDraft("missing")).toBeNull();
  });
});

describe("uploads", () => {
  it("holds bytes until acknowledgement, then clears them", async () => {
    const { store } = freshStore();
    const record = await store.putPendingUpload({
      draftId: "d1",
      accountId: "a1",
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      bytes: new Blob([new Uint8Array([1, 2, 3])]),
      serverId: null,
      recoveryGeneration: GENERATION,
    });

    expect((await store.pendingUploads()).map((entry) => entry.localId)).toEqual([
      record.localId,
    ]);
    expect((await store.getUpload(record.localId))?.bytes.size).toBe(3);

    await store.markUploadAcknowledged(record.localId, "server-upload-1");
    expect(await store.pendingUploads()).toHaveLength(0);
    expect((await store.getUpload(record.localId))?.serverId).toBe("server-upload-1");
    expect((await store.getUpload(record.localId))?.bytes.size).toBe(0);
    expect((await store.uploadsForDraft("d1")).map((entry) => entry.serverId)).toEqual([
      "server-upload-1",
    ]);
  });

  it("recognizes quota rejections from IndexedDB", () => {
    expect(isQuotaError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaError({ name: "DexieError", inner: { name: "QuotaExceededError" } })).toBe(true);
    expect(isQuotaError({ name: "DataCloneError" })).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe("the action queue", () => {
  it("freezes the payload at queue time", async () => {
    const { store } = freshStore();
    const targets = [
      {
        accountId: "a1",
        folderId: "f1",
        messageId: "m1",
        occurrenceId: "o1",
        revision: 7,
        modseq: "900",
      },
    ];
    const action = await store.enqueue(
      { kind: "flag", targets, flag: "unread", value: false, idempotencyKey: "key-1" },
      GENERATION,
    );
    targets[0]!.messageId = "m-later";

    const stored = (await store.allActions()).find((entry) => entry.localId === action.localId);
    expect(stored?.payload).toEqual({
      kind: "flag",
      targets: [
        {
          accountId: "a1",
          folderId: "f1",
          messageId: "m1",
          occurrenceId: "o1",
          revision: 7,
          modseq: "900",
        },
      ],
      flag: "unread",
      value: false,
      idempotencyKey: "key-1",
    });
    expect(stored?.state).toBe("pending");
    expect(stored?.recoveryGeneration).toBe(GENERATION);
  });

  it("lists pending actions oldest first and applies partial updates", async () => {
    const { store, advance } = freshStore();
    const first = await store.enqueue(
      { kind: "draft-save", draftId: "d1", baseRevision: 2, patch: { markdown: "One." } },
      GENERATION,
    );
    advance(5);
    const second = await store.enqueue(
      { kind: "draft-save", draftId: "d1", baseRevision: 3, patch: { markdown: "Two." } },
      GENERATION,
    );

    expect((await store.pendingActions()).map((entry) => entry.localId)).toEqual([
      first.localId,
      second.localId,
    ]);

    await store.updateAction(first.localId, { state: "synced", syncedAt: 9, attempts: 1 });
    expect((await store.pendingActions()).map((entry) => entry.localId)).toEqual([
      second.localId,
    ]);
    expect((await store.allActions()).find((entry) => entry.localId === first.localId)?.state).toBe(
      "synced",
    );
  });

  it("prunes only synced history, newest kept", async () => {
    const { store, advance } = freshStore();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const action = await store.enqueue(
        { kind: "draft-save", draftId: "d1", baseRevision: index + 1, patch: { markdown: "x" } },
        GENERATION,
      );
      advance(5);
      await store.updateAction(action.localId, { state: "synced", syncedAt: store.timestamp() });
      ids.push(action.localId);
    }
    const pending = await store.enqueue(
      { kind: "draft-save", draftId: "d1", baseRevision: 9, patch: { markdown: "y" } },
      GENERATION,
    );

    await store.pruneSyncedActions(1);
    const remaining = await store.allActions();
    expect(remaining.map((entry) => entry.localId)).toEqual([ids[2], pending.localId]);
  });
});

describe("metadata", () => {
  it("stores the server generation and restore marker", async () => {
    const { store } = freshStore();
    expect(await store.serverGeneration()).toBeNull();
    await store.writeMeta("serverGeneration", GENERATION);
    expect(await store.serverGeneration()).toBe(GENERATION);
    await store.writeMeta("restore", { previousGeneration: GENERATION, markedAt: 1 });
    const marker = await store.readMeta<{ previousGeneration: string }>("restore");
    expect(marker?.previousGeneration).toBe(GENERATION);
  });
});
