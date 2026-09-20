import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GenerationUnknownError,
  OfflineStore,
  OfflineSync,
  RESTORE_REVIEW_MESSAGE,
  ReviewChoiceError,
  UploadsUnverifiedError,
  type OfflinePort,
  type ReplayOutcome,
} from "../src/index.ts";

/*
 * The replay controls (SPEC F9 and section 10): the current generation
 * stamps new work, replay stops on a generation change after a restore, an
 * uncertain send never replays itself, an ended session pauses the pass
 * until sign-in, and every review resolution needs the explicit step its
 * kind requires.
 */

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";

const stores: OfflineStore[] = [];

/** One deterministic controller over a fresh store. */
function makeSync(port: OfflinePort) {
  let clock = 1_000;
  let sequence = 0;
  const store = new OfflineStore({
    name: `sync-test-${Math.random().toString(36).slice(2)}`,
    now: () => clock,
    newId: () => `local-${(sequence += 1)}`,
  });
  stores.push(store);
  return {
    store,
    sync: new OfflineSync(store, port),
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

/** One local draft record, ready to be customized. */
function draftRecord(overrides: Record<string, unknown> = {}) {
  return {
    draftId: "d1",
    accountId: "a1",
    server: null,
    identity: null,
    recipients: null,
    subject: null,
    markdown: "Local text.",
    baseRevision: 1,
    dirty: true,
    recoveryGeneration: GENERATION_A,
    updatedAt: 0,
    ...overrides,
  };
}

/** One frozen occurrence target. */
function target(messageId: string, revision: number) {
  return {
    accountId: "a1",
    folderId: "f1",
    messageId,
    occurrenceId: `o-${messageId}`,
    revision,
    modseq: null,
  };
}

describe("generation stamping", () => {
  it("refuses new durable work before the server issued a generation", async () => {
    const { sync } = makeSync({});
    await expect(sync.enqueueDraftSave("d1", 1, { markdown: "Hi." })).rejects.toBeInstanceOf(
      GenerationUnknownError,
    );
  });

  it("stamps every queued action with the observed generation", async () => {
    const { sync } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    const action = await sync.enqueueDraftSave("d1", 1, { markdown: "Hi." });
    expect(action.recoveryGeneration).toBe(GENERATION_A);
    expect((await sync.snapshot()).serverGeneration).toBe(GENERATION_A);
  });

  it("ignores generation observations that are not UUIDs", async () => {
    const { sync } = makeSync({});
    await sync.observeGeneration("not-a-uuid");
    expect((await sync.snapshot()).serverGeneration).toBeNull();
  });
});

describe("replay", () => {
  it("replays pending actions oldest first and settles each record", async () => {
    const seen: string[] = [];
    const port: OfflinePort = {
      saveDraft: async (payload) => {
        seen.push(`save:${payload.draftId}:${payload.baseRevision}:${payload.patch.markdown}`);
        return { state: "synced", revision: payload.baseRevision + 1 };
      },
      uploadBytes: async (upload) => {
        seen.push(`upload:${upload.filename}`);
        return { state: "synced", serverUploadId: "upload-1" };
      },
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    await store.putLocalDraft(draftRecord({ markdown: "First" }));
    const { upload } = await sync.enqueueUpload({
      draftId: "d1",
      accountId: "a1",
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      bytes: new Blob([new Uint8Array([1, 2, 3])]),
      serverId: null,
      recoveryGeneration: GENERATION_A,
    });
    await sync.enqueueDraftSave("d1", 1, { markdown: "First" });

    const report = await sync.sync();
    expect(report.synced).toBe(2);
    expect(report.attempted).toBe(2);
    expect(report.stoppedForRestore).toBe(false);
    // The upload was queued first, so its bytes replay first.
    expect(seen).toEqual(["upload:a.pdf", "save:d1:1:First"]);

    const snapshot = await sync.snapshot();
    expect(snapshot.pendingActions).toBe(0);
    expect(snapshot.pendingUploads).toBe(0);
    expect(snapshot.dirtyDrafts).toBe(0);
    expect(snapshot.lastSyncedAt).not.toBeNull();

    const draft = await sync.localDraft("d1");
    expect(draft?.baseRevision).toBe(2);
    expect(draft?.dirty).toBe(false);
    expect((await store.getUpload(upload.localId))?.serverId).toBe("upload-1");
    expect((await store.getUpload(upload.localId))?.bytes.size).toBe(0);
  });

  it("keeps a draft dirty while a later queued edit still waits", async () => {
    let revision = 1;
    const port: OfflinePort = {
      saveDraft: async (payload) => {
        revision += 1;
        return payload.baseRevision === 1
          ? { state: "synced", revision }
          : { state: "retry", reason: "offline" };
      },
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    await store.putLocalDraft(draftRecord());
    await sync.enqueueDraftSave("d1", 1, { markdown: "First" });
    await sync.enqueueDraftSave("d1", 2, { markdown: "Second" });

    await sync.sync();
    const draft = await sync.localDraft("d1");
    expect(draft?.baseRevision).toBe(2);
    expect(draft?.dirty).toBe(true);
    expect((await sync.snapshot()).pendingActions).toBe(1);
  });

  it("chains the revision through queued saves of one draft", async () => {
    // Two coalesced edits queued while offline both froze the revision the
    // editor held at enqueue time; replaying the second against that frozen
    // revision would collide with the first and land in review (SPEC F9).
    const seen: string[] = [];
    const port: OfflinePort = {
      saveDraft: async (payload) => {
        seen.push(`${payload.draftId}:${payload.baseRevision}`);
        return { state: "synced", revision: payload.baseRevision + 1 };
      },
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    await store.putLocalDraft(draftRecord());
    await store.putLocalDraft(draftRecord({ draftId: "d2" }));
    await sync.enqueueDraftSave("d1", 1, { markdown: "First" });
    await sync.enqueueDraftSave("d2", 1, { markdown: "Another draft" });
    await sync.enqueueDraftSave("d1", 1, { markdown: "Second" });

    const report = await sync.sync();
    expect(report.synced).toBe(3);
    expect(seen).toEqual(["d1:1", "d2:1", "d1:2"]);

    const snapshot = await sync.snapshot();
    expect(snapshot.pendingActions).toBe(0);
    expect(snapshot.reviewActions).toHaveLength(0);
    expect((await sync.localDraft("d1"))?.baseRevision).toBe(3);
    expect((await sync.localDraft("d1"))?.dirty).toBe(false);
  });

  it("never chains a save the queue already rebased past the synced revision", async () => {
    const seen: number[] = [];
    const port: OfflinePort = {
      saveDraft: async (payload) => {
        seen.push(payload.baseRevision);
        return payload.baseRevision === 1
          ? { state: "synced", revision: 2 }
          : { state: "review", reason: "draft_conflict" };
      },
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    await sync.enqueueDraftSave("d1", 1, { markdown: "Earlier enqueue" });
    // A review rebase set this item's base onto the shown server revision.
    const rebased = await store.enqueue(
      { kind: "draft-save", draftId: "d1", baseRevision: 7, patch: { markdown: "Rebased" } },
      GENERATION_A,
    );
    expect(rebased.payload).toMatchObject({ baseRevision: 7 });

    await sync.sync();
    // The chain moved nothing backward: the rebased save kept revision 7.
    expect(seen).toEqual([1, 7]);
  });

  it("keeps items pending on a retryable failure and records definitive failures", async () => {
    let attempts = 0;
    const port: OfflinePort = {
      uploadBytes: async () => {
        attempts += 1;
        return attempts === 1
          ? { state: "retry", reason: "network offline" }
          : { state: "failed", reason: "413 too large" };
      },
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    await sync.enqueueUpload({
      draftId: "d1",
      accountId: "a1",
      filename: "big.bin",
      contentType: "application/octet-stream",
      sizeBytes: 5,
      bytes: new Blob([new Uint8Array([9, 9, 9, 9, 9])]),
      serverId: null,
      recoveryGeneration: GENERATION_A,
    });

    let snapshot = (await sync.sync()).snapshot;
    expect(snapshot.pendingActions).toBe(1);
    expect(snapshot.pendingUploads).toBe(1);

    snapshot = (await sync.sync()).snapshot;
    expect(snapshot.failedActions).toHaveLength(1);
    expect(snapshot.failedActions[0]).toMatchObject({
      kind: "upload",
      failure: "413 too large",
      draftId: "d1",
    });
    expect(snapshot.pendingActions).toBe(0);

    const failedId = (await store.allActions()).find((entry) => entry.state === "failed")!.localId;
    snapshot = await sync.retryFailure(failedId);
    expect(snapshot.pendingActions).toBe(1);
  });

  it("leaves kinds without a handler pending and counts them as unsupported", async () => {
    const { sync } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    await sync.enqueueMailAction({
      kind: "flag",
      targets: [target("m1", 4)],
      flag: "flagged",
      value: true,
      idempotencyKey: "key-1",
    });

    const report = await sync.sync();
    expect(report.attempted).toBe(0);
    const snapshot = await sync.snapshot();
    expect(snapshot.unsupportedActions).toBe(1);
    expect(snapshot.pendingActions).toBe(1);
  });

  it("replays exactly the frozen occurrence targets", async () => {
    const seenTargets: unknown[] = [];
    const port: OfflinePort = {
      runMailAction: async (payload) => {
        seenTargets.push(payload.targets);
        return { state: "synced" };
      },
    };
    const { sync } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    const targets = [target("m1", 7)];
    await sync.enqueueMailAction({
      kind: "move",
      targets,
      destinationFolderId: "f2",
      idempotencyKey: "key-2",
    });
    // A message that arrives later must never join the frozen scope.
    targets.push(target("m2", 1));

    await sync.sync();
    expect(seenTargets).toEqual([[{ ...target("m1", 7) }]]);
  });
});

describe("sends", () => {
  it("queues only after every referenced upload is acknowledged", async () => {
    const { sync, store } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    const { upload } = await sync.enqueueUpload({
      draftId: "d1",
      accountId: "a1",
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      bytes: new Blob([new Uint8Array([1, 2, 3])]),
      serverId: null,
      recoveryGeneration: GENERATION_A,
    });

    await expect(sync.enqueueSend("d1", "key-1", 2)).rejects.toBeInstanceOf(
      UploadsUnverifiedError,
    );

    await store.markUploadAcknowledged(upload.localId, "upload-1");
    const action = await sync.enqueueSend("d1", "key-1", 2);
    expect(action.payload).toEqual({
      kind: "send",
      draftId: "d1",
      idempotencyKey: "key-1",
      baseRevision: 2,
    });
  });

  it("counts queued sends as waiting on this device", async () => {
    const { sync } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    await sync.enqueueSend("d1", "key-1", 2);
    const snapshot = await sync.snapshot();
    expect(snapshot.waitingSends).toBe(1);
    expect(snapshot.pendingActions).toBe(1);
  });

  it("holds an uncertain send for review and never replays it by itself", async () => {
    const queueSend = vi.fn(async (): Promise<ReplayOutcome> => ({
      state: "review",
      reason: "uncertain_send",
    }));
    const { sync } = makeSync({ queueSend });
    await sync.observeGeneration(GENERATION_A);
    const action = await sync.enqueueSend("d1", "key-1", 2);

    await sync.sync();
    expect(queueSend).toHaveBeenCalledTimes(1);

    await sync.sync();
    await sync.sync();
    expect(queueSend).toHaveBeenCalledTimes(1);

    const snapshot = await sync.snapshot();
    expect(snapshot.reviewActions).toEqual([
      {
        localId: action.localId,
        kind: "send",
        reason: "uncertain_send",
        queuedAt: action.queuedAt,
        draftId: "d1",
      },
    ]);
  });

  it("resends only after the duplicate warning, with a new key", async () => {
    const keys: string[] = [];
    const port: OfflinePort = {
      queueSend: async (payload) => {
        keys.push(payload.idempotencyKey);
        return keys.length === 1
          ? { state: "review", reason: "uncertain_send" }
          : { state: "synced" };
      },
    };
    const { sync } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    const action = await sync.enqueueSend("d1", "key-original", 2);
    await sync.sync();

    await expect(sync.resolveReview(action.localId, { choice: "rebase" })).rejects.toBeInstanceOf(
      ReviewChoiceError,
    );

    let snapshot = await sync.resolveReview(action.localId, {
      choice: "rebase",
      duplicateWarningAcknowledged: true,
    });
    expect(snapshot.pendingActions).toBe(1);
    expect(snapshot.reviewActions).toHaveLength(0);

    snapshot = (await sync.sync()).snapshot;
    expect(snapshot.pendingActions).toBe(0);
    expect(keys).toEqual(["key-original", expect.any(String)]);
    expect(keys[1]).not.toBe("key-original");
  });

  it("discards a reviewed send but keeps the local draft", async () => {
    const { sync, store } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    await store.putLocalDraft(draftRecord({ markdown: "Local text stays." }));
    const action = await sync.enqueueSend("d1", "key-1", 2);
    await store.updateAction(action.localId, {
      state: "review",
      reviewReason: "uncertain_send",
    });

    const snapshot = await sync.resolveReview(action.localId, { choice: "discard" });
    expect(snapshot.reviewActions).toHaveLength(0);
    expect((await sync.localDraft("d1"))?.markdown).toBe("Local text stays.");
  });
});

describe("the restore review", () => {
  it("marks earlier-generation work for review and stops replay", async () => {
    const saveDraft = vi.fn(async (): Promise<ReplayOutcome> => ({ state: "synced", revision: 2 }));
    const { sync, store } = makeSync({ saveDraft });
    await sync.observeGeneration(GENERATION_A);
    await store.putLocalDraft(draftRecord({ markdown: "Offline edits" }));
    const oldAction = await sync.enqueueDraftSave("d1", 1, { markdown: "Offline edits" });

    const snapshot = await sync.observeGeneration(GENERATION_B);
    expect(snapshot.reviewRequired).toBe(true);
    expect(snapshot.restore).toEqual({
      serverGeneration: GENERATION_B,
      previousGeneration: GENERATION_A,
      markedAt: expect.any(Number),
    });
    expect(snapshot.reviewActions.map((item) => item.localId)).toEqual([oldAction.localId]);
    expect(snapshot.dirtyDrafts).toBe(1);

    // Replay never reaches the port after the generation change.
    const report = await sync.sync();
    expect(report.attempted).toBe(0);
    expect(saveDraft).not.toHaveBeenCalled();

    // The stored generation stays the old one until an explicit rebase.
    const stored = (await store.allActions()).find(
      (entry) => entry.localId === oldAction.localId,
    );
    expect(stored?.recoveryGeneration).toBe(GENERATION_A);
  });

  it("stops a pass mid-queue when an item predates the stored generation", async () => {
    // An interrupted generation switch can leave a pending item stamped with
    // the earlier generation while the store already knows the new one.
    const saveDraft = vi.fn(async (): Promise<ReplayOutcome> => ({ state: "synced", revision: 2 }));
    const { sync, store } = makeSync({ saveDraft });
    await sync.observeGeneration(GENERATION_A);
    const stale = await store.enqueue(
      { kind: "draft-save", draftId: "d2", baseRevision: 1, patch: { markdown: "Old work" } },
      GENERATION_A,
    );
    // The switch lands between the two enqueues, so only the first item
    // keeps the earlier generation.
    await store.writeMeta("serverGeneration", GENERATION_B);
    const fresh = await sync.enqueueDraftSave("d1", 1, { markdown: "New work" });

    const report = await sync.sync();
    expect(report.stoppedForRestore).toBe(true);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(
      (await store.allActions()).find((entry) => entry.localId === stale.localId)?.state,
    ).toBe("review");
    expect(
      (await store.allActions()).find((entry) => entry.localId === fresh.localId)?.state,
    ).toBe("pending");
  });

  it("needs no review when nothing local holds the earlier generation", async () => {
    const { sync } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    await sync.observeGeneration(GENERATION_B);
    const snapshot = await sync.snapshot();
    expect(snapshot.reviewRequired).toBe(false);
    expect(snapshot.restore).toBeNull();
  });

  it("rebases a draft save only after the comparison, onto the shown revision", async () => {
    const seen: number[] = [];
    const port: OfflinePort = {
      saveDraft: async (payload) => {
        seen.push(payload.baseRevision);
        return { state: "synced", revision: payload.baseRevision + 1 };
      },
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    await store.putLocalDraft(draftRecord());
    const action = await sync.enqueueDraftSave("d1", 1, { markdown: "Local wins." });
    await sync.observeGeneration(GENERATION_B);

    await expect(
      sync.resolveReview(action.localId, {
        choice: "rebase",
        duplicateWarningAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(ReviewChoiceError);

    const snapshot = await sync.resolveReview(action.localId, {
      choice: "rebase",
      comparedWithServer: true,
      serverRevision: 5,
    });
    expect(snapshot.pendingActions).toBe(1);

    await sync.sync();
    expect(seen).toEqual([5]);
    expect((await sync.localDraft("d1"))?.baseRevision).toBe(6);
  });

  it("keeps the restore message stable for the interface", () => {
    expect(RESTORE_REVIEW_MESSAGE).toBe("Server restored; review pending changes");
  });
});

describe("an ended session during replay", () => {
  it("keeps the items pending, pauses the pass, and asks for sign-in", async () => {
    const saveDraft = vi.fn(async (): Promise<ReplayOutcome> => ({
      state: "retry",
      reason: "The session ended.",
      signInRequired: true,
    }));
    const { sync, store } = makeSync({ saveDraft });
    await sync.observeGeneration(GENERATION_A);
    await sync.enqueueDraftSave("d1", 1, { markdown: "One" });
    await sync.enqueueDraftSave("d2", 1, { markdown: "Two" });

    const report = await sync.sync();
    // The pass paused at the first refusal; the second item never attempted.
    expect(report.pausedForSignIn).toBe(true);
    expect(report.attempted).toBe(1);
    expect(saveDraft).toHaveBeenCalledTimes(1);

    const snapshot = await sync.snapshot();
    expect(snapshot.signInRequired).toBe(true);
    expect(snapshot.pendingActions).toBe(2);
    expect(snapshot.failedActions).toHaveLength(0);
    expect((await store.allActions()).every((entry) => entry.state === "pending")).toBe(true);
  });

  it("clears the sign-in request once a later pass replays the queue", async () => {
    let expired = true;
    const port: OfflinePort = {
      saveDraft: async (payload) => {
        if (expired) {
          return { state: "retry", reason: "The session ended.", signInRequired: true };
        }
        return { state: "synced", revision: payload.baseRevision + 1 };
      },
    };
    const { sync } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    await sync.enqueueDraftSave("d1", 1, { markdown: "One" });

    await sync.sync();
    expect((await sync.snapshot()).signInRequired).toBe(true);

    expired = false;
    const report = await sync.sync();
    expect(report.pausedForSignIn).toBe(false);
    expect(report.synced).toBe(1);
    const snapshot = await sync.snapshot();
    expect(snapshot.signInRequired).toBe(false);
    expect(snapshot.pendingActions).toBe(0);
  });
});

describe("orphaned uploads", () => {
  /** One upload record, as a crash left it: persisted without its action. */
  async function orphanedUpload(store: OfflineStore, filename: string) {
    return store.putPendingUpload({
      draftId: "d1",
      accountId: "a1",
      filename,
      contentType: "application/pdf",
      sizeBytes: 3,
      bytes: new Blob([new Uint8Array([1, 2, 3])]),
      serverId: null,
      recoveryGeneration: GENERATION_A,
    });
  }

  it("requeues and drains an upload whose action a crash never wrote", async () => {
    const uploaded: string[] = [];
    const port: OfflinePort = {
      uploadBytes: async (upload) => {
        uploaded.push(upload.filename);
        return { state: "synced", serverUploadId: "upload-9" };
      },
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    const orphan = await orphanedUpload(store, "orphan.pdf");

    const report = await sync.sync();
    expect(report.synced).toBe(1);
    expect(uploaded).toEqual(["orphan.pdf"]);
    expect((await store.getUpload(orphan.localId))?.serverId).toBe("upload-9");

    // The drained upload no longer blocks a send for its draft.
    const send = await sync.enqueueSend("d1", "key-1", 2);
    expect(send.payload).toMatchObject({ kind: "send", draftId: "d1" });
  });

  it("does not duplicate the action of an upload that already holds one", async () => {
    const uploadBytes = vi.fn(async (): Promise<ReplayOutcome> => ({
      state: "retry",
      reason: "offline",
    }));
    const { sync, store } = makeSync({ uploadBytes });
    await sync.observeGeneration(GENERATION_A);
    const { action } = await sync.enqueueUpload({
      draftId: "d1",
      accountId: "a1",
      filename: "kept.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      bytes: new Blob([new Uint8Array([1, 2, 3])]),
      serverId: null,
      recoveryGeneration: GENERATION_A,
    });

    await sync.sync();
    await sync.sync();
    // One action exists per upload, so exactly one replay happens per pass.
    expect(uploadBytes).toHaveBeenCalledTimes(2);
    expect(
      (await store.allActions()).filter(
        (entry) => entry.payload.kind === "upload" && entry.localId !== action.localId,
      ),
    ).toHaveLength(0);
  });

  it("does not resurrect an upload a review deliberately discarded", async () => {
    const uploadBytes = vi.fn(async (): Promise<ReplayOutcome> => ({ state: "synced" }));
    const { sync, store } = makeSync({ uploadBytes });
    await sync.observeGeneration(GENERATION_A);
    const { action, upload } = await sync.enqueueUpload({
      draftId: "d1",
      accountId: "a1",
      filename: "given-up.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      bytes: new Blob([new Uint8Array([1, 2, 3])]),
      serverId: null,
      recoveryGeneration: GENERATION_A,
    });
    await store.updateAction(action.localId, {
      state: "review",
      reviewReason: "server_restored",
    });

    const snapshot = await sync.resolveReview(action.localId, { choice: "discard" });
    expect(snapshot.reviewActions).toHaveLength(0);
    expect(snapshot.pendingUploads).toBe(0);
    expect(await store.getUpload(upload.localId)).toBeNull();

    await sync.sync();
    expect(uploadBytes).not.toHaveBeenCalled();
    expect((await sync.snapshot()).pendingActions).toBe(0);
  });
});

describe("failed actions", () => {
  it("discards a failed upload with its bytes so the draft can send", async () => {
    const port: OfflinePort = {
      uploadBytes: async () => ({ state: "failed", reason: "413 too large" }),
    };
    const { sync, store } = makeSync(port);
    await sync.observeGeneration(GENERATION_A);
    const { action, upload } = await sync.enqueueUpload({
      draftId: "d1",
      accountId: "a1",
      filename: "big.bin",
      contentType: "application/octet-stream",
      sizeBytes: 5,
      bytes: new Blob([new Uint8Array([9, 9, 9, 9, 9])]),
      serverId: null,
      recoveryGeneration: GENERATION_A,
    });
    await sync.sync();
    expect((await sync.snapshot()).failedActions).toHaveLength(1);
    await expect(sync.enqueueSend("d1", "key-1", 2)).rejects.toBeInstanceOf(
      UploadsUnverifiedError,
    );

    const snapshot = await sync.discardFailure(action.localId);
    expect(snapshot.failedActions).toHaveLength(0);
    expect(snapshot.pendingUploads).toBe(0);
    expect(await store.getUpload(upload.localId)).toBeNull();

    // The bytes are gone, so a later pass cannot resurrect the failure.
    await sync.sync();
    expect((await sync.snapshot()).failedActions).toHaveLength(0);
    await expect(sync.enqueueSend("d1", "key-1", 2)).resolves.toMatchObject({
      payload: { kind: "send", draftId: "d1" },
    });
  });

  it("discards a failed edit while its local draft stays", async () => {
    const { sync, store } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    await store.putLocalDraft(draftRecord({ markdown: "Local text stays." }));
    const action = await sync.enqueueDraftSave("d1", 1, { markdown: "Local text stays." });
    await store.updateAction(action.localId, {
      state: "failed",
      failure: "400 invalid_request",
    });

    const snapshot = await sync.discardFailure(action.localId);
    expect(snapshot.failedActions).toHaveLength(0);
    expect((await sync.localDraft("d1"))?.markdown).toBe("Local text stays.");
  });

  it("retries a failed action back into the queue", async () => {
    const { sync, store } = makeSync({});
    await sync.observeGeneration(GENERATION_A);
    const action = await sync.enqueueDraftSave("d1", 1, { markdown: "Hi." });
    await store.updateAction(action.localId, { state: "failed", failure: "400 bad" });

    const snapshot = await sync.retryFailure(action.localId);
    expect(snapshot.pendingActions).toBe(1);
    expect(snapshot.failedActions).toHaveLength(0);
    expect(
      (await store.allActions()).find((entry) => entry.localId === action.localId)?.failure,
    ).toBeNull();
  });
});
