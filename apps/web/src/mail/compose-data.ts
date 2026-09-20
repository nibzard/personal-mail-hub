import type {
  DraftAttachmentView,
  DraftResponse,
  DraftView,
  DraftsResponse,
  MessageAddress,
  MessageRecipients,
  OutboundResponse,
  OutboundView,
  ReplyMode,
  UploadResponse,
} from "@mail-hub/contracts";
import {
  DraftAutosaver,
  type AutosaveOutcome,
  type AutosavePatch,
} from "@mail-hub/compose/autosave";
import { GenerationUnknownError } from "@mail-hub/offline";
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, apiPostBytes, toApiError } from "@/lib/api";
import { offlineStore, uploadFits } from "@/offline/store.ts";
import { offlineSync } from "@/offline/port.ts";
import { useResource } from "./use-resource";

/*
 * The compose and send data layer (SPEC F6 and F7) over the draft, upload,
 * and send routes. Mutations carry the recovery generation the session
 * probe issued; a device without a connection freezes the same work into
 * the offline queue instead, so the review surface stays the only path a
 * restore or an uncertain send continues through.
 */

/** The header the API's recovery gate reads (SPEC section 10). */
const RECOVERY_GENERATION_HEADER = "x-recovery-generation";

/** What every mutation here needs from the session. */
export interface ComposeSession {
  recoveryGeneration: string | null;
}

function generationHeaders(session: ComposeSession): Record<string, string> {
  return session.recoveryGeneration === null
    ? {}
    : { [RECOVERY_GENERATION_HEADER]: session.recoveryGeneration };
}

/** True when this device currently reports no connection. */
function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

//
// Recipient editing
//

/**
 * Parses one recipient line. Entries separate by commas or semicolons; each
 * entry is a bare address or `Name <address>`. Unparseable entries become
 * addresses verbatim, so `invalidAddresses` can name them for correction.
 */
export function parseRecipientList(text: string): MessageAddress[] {
  return text
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const bracketed = /^([^<]*)<([^>]+)>$/.exec(entry);
      if (bracketed !== null) {
        const name = bracketed[1]!.trim();
        return { address: bracketed[2]!.trim(), name: name.length > 0 ? name : null };
      }
      return { address: entry, name: null };
    });
}

/** One recipient line from an address list: `Name <address>` when named. */
export function formatRecipientList(addresses: readonly MessageAddress[]): string {
  return addresses
    .map((address) =>
      address.name == null || address.name.length === 0
        ? address.address
        : `${address.name} <${address.address}>`,
    )
    .join(", ");
}

/** One rough address shape check; the server validates for real (SPEC F6). */
const ADDRESS_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** The entries of one list that do not look like addresses. */
export function invalidAddresses(
  addresses: readonly MessageAddress[],
): string[] {
  return addresses.filter((address) => !ADDRESS_PATTERN.test(address.address)).map((a) => a.address);
}

/** The visible recipient count of one set. */
export function recipientCount(recipients: MessageRecipients): number {
  return recipients.to.length + (recipients.cc?.length ?? 0) + (recipients.bcc?.length ?? 0);
}

//
// Draft reads and mutations
//

/** Every live draft, newest edit first. */
export function useDrafts(enabled: boolean) {
  return useResource<DraftView[]>(
    async (signal) =>
      enabled ? (await apiGet<DraftsResponse>("/drafts", signal)).drafts : [],
    [enabled],
  );
}

/** Starts one new draft on one account; the server picks the default From. */
export async function createNewDraft(
  session: ComposeSession,
  accountId: string,
): Promise<DraftView> {
  const response = await apiPost<DraftResponse>(
    "/drafts",
    { accountId },
    { headers: generationHeaders(session) },
  );
  return response.draft;
}

/** One reply draft request: the parent, its account, and the mode. */
export interface ReplyDraftRequest {
  messageId: string;
  /** The holding account; required when the parent has copies in several. */
  accountId?: string;
  mode: ReplyMode;
  /** The explicit From choice an `identity_choice_required` rejection asks for. */
  identity?: { address: string };
  /** The corrected recipients a `recipients_required` rejection asks for. */
  recipients?: MessageRecipients;
}

/**
 * Derives one reply draft from the selected parent (SPEC F6). Derivations
 * the server cannot make safely reject with a choice code; the interface
 * answers by repeating the request with the matching explicit choice.
 */
export async function createReplyDraft(
  session: ComposeSession,
  request: ReplyDraftRequest,
): Promise<DraftView> {
  const response = await apiPost<DraftResponse>(
    "/drafts/reply",
    {
      messageId: request.messageId,
      mode: request.mode,
      ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
      ...(request.identity === undefined ? {} : { identity: request.identity }),
      ...(request.recipients === undefined ? {} : { recipients: request.recipients }),
    },
    { headers: generationHeaders(session) },
  );
  return response.draft;
}

/** Reads one draft; a deleted draft rejects with `not_found`. */
export async function readDraft(draftId: string): Promise<DraftView> {
  return (await apiGet<DraftResponse>(`/drafts/${draftId}`)).draft;
}

/** Soft-deletes one draft. Upload rows stay for their outbound references. */
export async function discardDraft(session: ComposeSession, draftId: string): Promise<void> {
  await apiDelete(`/drafts/${draftId}`, { headers: generationHeaders(session) });
}

//
// Attachments and uploads
//

/** The uploads one draft references, in attachment order. */
export async function listDraftAttachments(draftId: string): Promise<DraftAttachmentView[]> {
  const response = await apiGet<{ attachments: DraftAttachmentView[] }>(
    `/drafts/${draftId}/uploads`,
  );
  return response.attachments;
}

/** Detaches one upload from a draft; the stored file itself remains. */
export async function detachDraftAttachment(
  session: ComposeSession,
  draftId: string,
  uploadId: string,
): Promise<void> {
  await apiDelete(`/drafts/${draftId}/uploads/${uploadId}`, {
    headers: generationHeaders(session),
  });
}

/** How one file add ended, in the words the editor shows. */
export type FileAddOutcome =
  | { state: "attached"; attachment: DraftAttachmentView }
  | { state: "queued-offline"; filename: string }
  | { state: "rejected"; message: string };

/**
 * Adds one file to a draft (SPEC F6). Online, the bytes reach durable
 * storage and are acknowledged before the draft references them. Offline,
 * the bytes persist in this device's store and the upload queues behind the
 * connection; a browser quota error reports itself without queueing.
 */
export async function addFileToDraft(
  session: ComposeSession,
  draft: Pick<DraftView, "id" | "accountId">,
  file: File,
): Promise<FileAddOutcome> {
  if (!uploadFits({ sizeBytes: file.size })) {
    return {
      state: "rejected",
      message: `${file.name} is larger than the 25 MB upload limit.`,
    };
  }
  if (offline() || session.recoveryGeneration === null) {
    return queueUpload(draft, file);
  }
  try {
    const query = new URLSearchParams({ accountId: draft.accountId, filename: file.name });
    const uploaded = await apiPostBytes<UploadResponse>(
      `/uploads?${query.toString()}`,
      file,
      file.type.length > 0 ? file.type : "application/octet-stream",
      generationHeaders(session),
    );
    const attachment = await attachUpload(session, draft.id, uploaded.upload.id);
    return { state: "attached", attachment };
  } catch (error) {
    const failure = toApiError(error);
    if (failure.network) {
      // The bytes never received an acknowledgement, so the file queues
      // exactly as an offline add would (SPEC F6).
      return queueUpload(draft, file);
    }
    return { state: "rejected", message: failure.message };
  }
}

/** Attaches one acknowledged upload to the draft at the next position. */
async function attachUpload(
  session: ComposeSession,
  draftId: string,
  uploadId: string,
): Promise<DraftAttachmentView> {
  const response = await apiPost<DraftAttachmentView>(
    `/drafts/${draftId}/uploads`,
    { uploadId },
    { headers: generationHeaders(session) },
  );
  return response;
}

/** Persists the bytes on this device and queues their upload (SPEC F9). */
async function queueUpload(
  draft: Pick<DraftView, "id" | "accountId">,
  file: File,
): Promise<FileAddOutcome> {
  const controller = offlineSync();
  const store = offlineStore();
  if (controller === null || store === null) {
    return {
      state: "rejected",
      message: "This browser keeps no offline storage, and the file cannot reach the server.",
    };
  }
  try {
    const generation = await store.serverGeneration();
    if (generation === null) {
      throw new GenerationUnknownError();
    }
    await controller.enqueueUpload({
      draftId: draft.id,
      accountId: draft.accountId,
      filename: file.name,
      contentType: file.type.length > 0 ? file.type : "application/octet-stream",
      sizeBytes: file.size,
      bytes: file,
      serverId: null,
      recoveryGeneration: generation,
    });
    return { state: "queued-offline", filename: file.name };
  } catch (error) {
    if (error instanceof GenerationUnknownError) {
      return {
        state: "rejected",
        message: "The server has not issued a recovery generation yet. Reload and try again.",
      };
    }
    return {
      state: "rejected",
      message: `${file.name} could not be stored on this device, so it was not queued.`,
    };
  }
}

/** One upload this device still holds bytes for, as the editor shows it. */
export interface WaitingUpload {
  localId: string;
  filename: string;
  sizeBytes: number;
}

/**
 * The uploads of one draft whose bytes stay on this device (SPEC F6). The
 * list empties as replays earn their server acknowledgement.
 */
export async function localUploadsOf(draftId: string): Promise<WaitingUpload[]> {
  const store = offlineStore();
  if (store === null) {
    return [];
  }
  try {
    const uploads = await store.uploadsForDraft(draftId);
    return uploads
      .filter((upload) => upload.serverId === null)
      .map((upload) => ({
        localId: upload.localId,
        filename: upload.filename,
        sizeBytes: upload.sizeBytes,
      }));
  } catch {
    return [];
  }
}

/**
 * Attaches uploads the server acknowledged but the draft does not reference
 * yet, which happens when a queued upload replayed while the editor was
 * closed. Returns true when the attachment list changed.
 */
export async function attachAcknowledgedUploads(
  session: ComposeSession,
  draftId: string,
  attached: readonly DraftAttachmentView[],
): Promise<boolean> {
  const known = new Set(attached.map((attachment) => attachment.id));
  const store = offlineStore();
  if (store === null) {
    return false;
  }
  let changed = false;
  try {
    for (const upload of await store.uploadsForDraft(draftId)) {
      if (upload.serverId === null || known.has(upload.serverId)) {
        continue;
      }
      try {
        await attachUpload(session, draftId, upload.serverId);
        changed = true;
      } catch {
        // The attach retries on the next pass; the acknowledged file is safe.
      }
    }
  } catch {
    return changed;
  }
  return changed;
}

//
// Sending
//

/** How one queue-send request ended, before any status polling starts. */
export type SendRequestOutcome =
  | { state: "queued"; outbound: OutboundView }
  | { state: "queued-offline" }
  | { state: "uncertain"; message: string }
  | { state: "rejected"; message: string; currentRevision?: number };

/** One fresh idempotency key, so a deliberate resend never reuses one. */
export function newSendIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Queues one send (SPEC F7 steps 1 and 2). The request freezes the draft
 * revision and carries its own idempotency key. Offline, the same request
 * queues on this device and replays on return. A lost response is uncertain:
 * the first attempt may hold a frozen snapshot, so only an acknowledged
 * duplicate warning may repeat the send (SPEC F7 step 6).
 */
export async function requestDraftSend(
  session: ComposeSession,
  draftId: string,
  baseRevision: number,
  idempotencyKey: string,
): Promise<SendRequestOutcome> {
  if (offline()) {
    return enqueueSend(draftId, idempotencyKey, baseRevision);
  }
  if (session.recoveryGeneration === null) {
    return {
      state: "rejected",
      message: "The server has not issued a recovery generation yet. Reload and try again.",
    };
  }
  try {
    const response = await apiPost<OutboundResponse>(
      `/drafts/${draftId}/send`,
      { idempotencyKey, baseRevision },
      { headers: generationHeaders(session) },
    );
    return { state: "queued", outbound: response.outbound };
  } catch (error) {
    const failure = toApiError(error);
    if (failure.network) {
      return {
        state: "uncertain",
        message: "The send request left without an answer. It may already be queued on the server.",
      };
    }
    if (failure.unauthorized) {
      return { state: "rejected", message: "Your session ended. Sign in and try again." };
    }
    return {
      state: "rejected",
      message: failure.message,
      ...(failure.currentRevision === undefined
        ? {}
        : { currentRevision: failure.currentRevision }),
    };
  }
}

/** Freezes one send into the offline queue for replay (SPEC F9). */
async function enqueueSend(
  draftId: string,
  idempotencyKey: string,
  baseRevision: number,
): Promise<SendRequestOutcome> {
  const controller = offlineSync();
  if (controller === null) {
    return {
      state: "rejected",
      message: "This browser keeps no offline queue, and the server cannot be reached.",
    };
  }
  try {
    await controller.enqueueSend(draftId, idempotencyKey, baseRevision);
    return { state: "queued-offline" };
  } catch (error) {
    if (error instanceof GenerationUnknownError) {
      return {
        state: "rejected",
        message: "The server has not issued a recovery generation yet. Reload and try again.",
      };
    }
    return { state: "rejected", message: (error as Error).message };
  }
}

/** Reads one outbound snapshot; the worker, not the API, moves its state. */
export async function readOutbound(outboundId: string): Promise<OutboundView> {
  return (await apiGet<OutboundResponse>(`/outbound/${outboundId}`)).outbound;
}

/**
 * Issues the deliberate resend of one unresolved send (SPEC F7 step 6). The
 * owner has acknowledged the duplicate warning; the frozen snapshot becomes
 * a new, unlocked draft, and the next send takes its own key. The uncertain
 * attempt itself is not touched — reconciliation still decides it.
 */
export async function createResendDraft(
  session: ComposeSession,
  outboundId: string,
): Promise<DraftView> {
  const response = await apiPost<DraftResponse>(
    `/outbound/${outboundId}/resend-draft`,
    {},
    { headers: generationHeaders(session) },
  );
  return response.draft;
}

/** How fast the send panel polls a snapshot that can still change. */
const OUTBOUND_POLL_MS = 2000;

/**
 * One outbound snapshot, polled while either of its two jobs can still
 * change on their own (SPEC F7). Terminal snapshots stop the polling.
 */
export function useOutbound(outboundId: string | null) {
  const [entry, setEntry] = useState<{
    phase: "loading" | "ready" | "error";
    outbound: OutboundView | null;
    message: string | null;
  }>({ phase: "loading", outbound: null, message: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (outboundId === null) {
      return;
    }
    let live = true;
    let timer: number | null = null;
    const load = async () => {
      try {
        const outbound = await readOutbound(outboundId);
        if (!live) {
          return;
        }
        setEntry({ phase: "ready", outbound, message: null });
        if (
          outbound.status === "queued" ||
          outbound.status === "sending" ||
          outbound.sentCopyStatus === "pending" ||
          outbound.sentCopyStatus === "appending"
        ) {
          timer = window.setTimeout(load, OUTBOUND_POLL_MS);
        }
      } catch (error) {
        if (!live) {
          return;
        }
        setEntry({ phase: "error", outbound: null, message: toApiError(error).message });
      }
    };
    setEntry({ phase: "loading", outbound: null, message: null });
    void load();
    return () => {
      live = false;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [outboundId, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { ...entry, reload };
}

//
// Autosave wiring
//

/** What the autosave runner needs besides its arguments. */
export interface DraftSaveRunnerInput {
  /** Reads the generation live, so a probe refresh applies mid-session. */
  recoveryGeneration(): string | null;
  /** Records the last server copy the editor knows. */
  noteServerDraft(draft: DraftView): void;
  /** Receives the message of the last failed save, for the status line. */
  onError?(message: string): void;
}

/**
 * Builds the save function one `DraftAutosaver` runs with (SPEC F9). The
 * returned runner speaks the API online, freezes the same patch into the
 * offline queue when the connection is gone, keeps the local Dexie copy
 * current for the review comparison, and turns a stale rejection into the
 * conflict the editor asks you to resolve.
 */
export function draftSaveRunner(
  input: DraftSaveRunnerInput,
): (draftId: string, baseRevision: number, patch: AutosavePatch) => Promise<AutosaveOutcome> {
  return async (draftId, baseRevision, patch) => {
    const generation = input.recoveryGeneration();
    if (offline() || generation === null) {
      return queueDraftSave(draftId, baseRevision, patch);
    }
    try {
      const response = await apiPatch<DraftResponse>(
        `/drafts/${draftId}`,
        { baseRevision, ...patch },
        { headers: { [RECOVERY_GENERATION_HEADER]: generation } },
      );
      input.noteServerDraft(response.draft);
      await writeLocalDraft(response.draft, false);
      return { state: "saved", revision: response.draft.revision };
    } catch (error) {
      const failure = toApiError(error);
      if (failure.network) {
        return queueDraftSave(draftId, baseRevision, patch);
      }
      if (failure.code === "draft_stale") {
        // Keep the local edits; the editor shows both copies and the choice
        // (SPEC F9). The autosaver holds its pending patch until then.
        const revision = failure.currentRevision ?? baseRevision + 1;
        return { state: "conflict", currentRevision: revision };
      }
      if (failure.unauthorized) {
        input.onError?.("Your session ended. Sign in and try again.");
        return { state: "error", message: "Your session ended. Sign in and try again." };
      }
      input.onError?.(failure.message);
      return { state: "error", message: failure.message };
    }
  };
}

/** Freezes one coalesced edit into the offline queue (SPEC F9). */
async function queueDraftSave(
  draftId: string,
  baseRevision: number,
  patch: AutosavePatch,
): Promise<AutosaveOutcome> {
  const controller = offlineSync();
  const store = offlineStore();
  if (controller === null || store === null) {
    // No durable store: the autosaver keeps the edits in memory.
    return { state: "offline" };
  }
  try {
    await controller.enqueueDraftSave(draftId, baseRevision, patch);
  } catch (error) {
    if (error instanceof GenerationUnknownError) {
      return { state: "offline" };
    }
    return { state: "error", message: (error as Error).message };
  }
  await writeLocalDraftFor(draftId, patch, baseRevision);
  return { state: "offline" };
}

/** Writes the local Dexie copy of one acknowledged draft. */
async function writeLocalDraft(draft: DraftView, dirty: boolean): Promise<void> {
  const store = offlineStore();
  if (store === null) {
    return;
  }
  const existing = await store.getLocalDraft(draft.id).catch(() => null);
  const generation =
    existing?.recoveryGeneration ??
    (await store.serverGeneration().catch(() => null)) ??
    draftFallbackGeneration();
  try {
    await store.putLocalDraft({
      draftId: draft.id,
      accountId: draft.accountId,
      server: draft,
      identity: { address: draft.identity.address },
      recipients: draft.recipients,
      subject: draft.subject,
      markdown: draft.markdown,
      baseRevision: draft.revision,
      dirty,
      recoveryGeneration: generation,
      updatedAt: 0,
    });
  } catch {
    // The local copy is best effort; the server copy stays the truth.
  }
}

/** Writes the local Dexie copy of one queued edit, marked dirty. */
async function writeLocalDraftFor(
  draftId: string,
  patch: AutosavePatch,
  baseRevision: number,
): Promise<void> {
  const store = offlineStore();
  if (store === null) {
    return;
  }
  const existing = await store.getLocalDraft(draftId).catch(() => null);
  const base = existing?.server;
  if (existing === null || base === null) {
    // No server copy exists to edit offline; the queue holds the edits.
    return;
  }
  try {
    await store.putLocalDraft({
      ...existing,
      identity:
        patch.identity !== undefined && patch.identity !== null
          ? { address: patch.identity.address }
          : existing.identity,
      recipients: patch.recipients ?? existing.recipients,
      subject: patch.subject !== undefined ? patch.subject : existing.subject,
      markdown:
        patch.markdown !== undefined && patch.markdown !== null
          ? patch.markdown
          : existing.markdown,
      baseRevision,
      dirty: true,
    });
  } catch {
    // Best effort; the queue holds the edits either way.
  }
}

/** A generation-shaped stand-in, so an ungenerated device can still cache. */
function draftFallbackGeneration(): string {
  return "00000000-0000-4000-8000-000000000000";
}

export type { DraftAutosaver };
