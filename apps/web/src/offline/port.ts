import type {
  DraftResponse,
  DraftView,
  MailActionKindWire,
  MailActionResponse,
  OutboundResponse,
  UploadResponse,
} from "@mail-hub/contracts";
import {
  OfflineSync,
  type DraftEditPatch,
  type OfflinePort,
  type OfflineStore,
  type QueuedPayload,
  type ReplayOutcome,
} from "@mail-hub/offline";
import { apiGet, apiPatch, apiPost, apiPostBytes, toApiError } from "@/lib/api";
import { offlineStore } from "./store.ts";

/*
 * The transport port of the offline queue (SPEC F9): one implementation per
 * queued kind over the JSON API. Every request carries the recovery
 * generation the queue stamped when the action was created, which the
 * controller has already matched against the generation the server issues
 * now.
 */

/** The header the API's recovery gate reads (SPEC section 10). */
const RECOVERY_GENERATION_HEADER = "x-recovery-generation";

/** How one failed replay attempt classifies (SPEC F7 and F9). */
export function classifyReplayFailure(
  error: unknown,
  options: { lostResponseIsUncertain?: boolean } = {},
): ReplayOutcome {
  const failure = toApiError(error);
  if (failure.network) {
    // A request that never reached the service is retryable, unless its
    // response could have been lost after acceptance: a send (SPEC F7).
    return options.lostResponseIsUncertain === true
      ? { state: "review", reason: "uncertain_send" }
      : { state: "retry", reason: failure.message };
  }
  if (failure.code === "draft_stale") {
    return { state: "review", reason: "draft_conflict" };
  }
  if (failure.code === "recovery_required") {
    // The server's generation moved; only the review path may continue.
    return { state: "review", reason: "server_restored" };
  }
  if (failure.status >= 500 || failure.status === 429) {
    // Recovery in progress and other server-side trouble stay retryable.
    return { state: "retry", reason: failure.message };
  }
  // Every other answer is a definitive refusal the interface must surface.
  return { state: "failed", reason: failure.message };
}

/** The replay body of one queued mail action, back in wire form (SPEC F4). */
function mailActionBodyOf(
  payload: Extract<QueuedPayload, { kind: "flag" | "move" }>,
): { accountId: string; kind: MailActionKindWire; idempotencyKey: string; occurrenceIds: string[]; destinationFolderId?: string } {
  const accountId = payload.targets[0]?.accountId ?? "";
  const occurrenceIds = payload.targets.map((target) => target.occurrenceId);
  if (payload.kind === "move") {
    return {
      accountId,
      kind: "move",
      idempotencyKey: payload.idempotencyKey,
      occurrenceIds,
      destinationFolderId: payload.destinationFolderId,
    };
  }
  const kind: MailActionKindWire =
    payload.flag === "unread"
      ? payload.value
        ? "mark_unread"
        : "mark_read"
      : payload.value
        ? "star"
        : "unstar";
  return { accountId, kind, idempotencyKey: payload.idempotencyKey, occurrenceIds };
}

/** Strip the fields the draft edit route cannot carry. */
function editBody(patch: DraftEditPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.identity !== undefined && patch.identity !== null) {
    body.identity = { address: patch.identity.address };
  }
  if (patch.recipients !== undefined && patch.recipients !== null) {
    body.recipients = patch.recipients;
  }
  if (patch.subject !== undefined) {
    body.subject = patch.subject;
  }
  if (patch.markdown !== undefined) {
    body.markdown = patch.markdown;
  }
  return body;
}

/** Build the web port over one store. */
export function webOfflinePort(store: OfflineStore): OfflinePort {
  const generationHeaders = async (): Promise<Record<string, string>> => {
    const generation = await store.serverGeneration();
    return generation === null ? {} : { [RECOVERY_GENERATION_HEADER]: generation };
  };

  return {
    saveDraft: async (payload) => {
      try {
        const response = await apiPatch<DraftResponse>(
          `/drafts/${payload.draftId}`,
          { baseRevision: payload.baseRevision, ...editBody(payload.patch) },
          { headers: await generationHeaders() },
        );
        return { state: "synced", revision: response.draft.revision };
      } catch (error) {
        return classifyReplayFailure(error);
      }
    },
    uploadBytes: async (upload) => {
      const query = new URLSearchParams({
        accountId: upload.accountId,
        filename: upload.filename,
      });
      try {
        const response = await apiPostBytes<UploadResponse>(
          `/uploads?${query.toString()}`,
          upload.bytes,
          upload.contentType,
          await generationHeaders(),
        );
        return { state: "synced", serverUploadId: response.upload.id };
      } catch (error) {
        return classifyReplayFailure(error);
      }
    },
    queueSend: async (payload) => {
      try {
        await apiPost<OutboundResponse>(
          `/drafts/${payload.draftId}/send`,
          { idempotencyKey: payload.idempotencyKey, baseRevision: payload.baseRevision },
          { headers: await generationHeaders() },
        );
        return { state: "synced" };
      } catch (error) {
        // A lost response may hide an accepted snapshot: uncertain, never
        // an automatic resend (SPEC F7).
        return classifyReplayFailure(error, { lostResponseIsUncertain: true });
      }
    },
    // Mail actions replay against the action routes with the targets frozen
    // at queue time (SPEC F4 and F9): the scope never grows to messages that
    // arrived later.
    runMailAction: async (payload) => {
      if (payload.targets.length === 0) {
        return { state: "failed", reason: "The queued action held no targets." };
      }
      try {
        await apiPost<MailActionResponse>(
          "/actions",
          mailActionBodyOf(payload),
          { headers: await generationHeaders() },
        );
        return { state: "synced" };
      } catch (error) {
        return classifyReplayFailure(error);
      }
    },
  };
}

/** The one sync controller of this device. */
let controller: OfflineSync | null = null;

/** The shared controller, or `null` where IndexedDB is absent. */
export function offlineSync(): OfflineSync | null {
  if (controller === null) {
    const store = offlineStore();
    if (store === null) {
      return null;
    }
    controller = new OfflineSync(store, webOfflinePort(store));
  }
  return controller;
}

/** Forget the shared controller. Tests use this between windows. */
export function resetOfflineSync(): void {
  controller = null;
}

/** One server draft for the review comparison (SPEC F9). */
export async function fetchServerDraft(draftId: string): Promise<DraftView | null> {
  try {
    const response = await apiGet<DraftResponse>(`/drafts/${draftId}`);
    return response.draft;
  } catch {
    return null;
  }
}
