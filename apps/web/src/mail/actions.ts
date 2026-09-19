import type {
  MailActionKindWire,
  MailActionResponse,
  SearchResultItem,
} from "@mail-hub/contracts";
import type { FrozenTarget, QueuedPayload } from "@mail-hub/offline";
import { apiPost, toApiError } from "@/lib/api";
import { offlineSync } from "@/offline/port.ts";

/*
 * The client half of the mail actions (SPEC F4 and section 7). Every
 * management command freezes the occurrences the current row shows and
 * submits exactly those. A device without a connection queues the frozen
 * action for replay; a submission that cannot run at all reports why.
 */

/** The header the API's recovery gate reads (SPEC section 10). */
const RECOVERY_GENERATION_HEADER = "x-recovery-generation";

/** How one submitted action ended, in the words the interface shows. */
export type MailActionOutcome =
  | {
      state: "submitted";
      kind: MailActionKindWire;
      /** Targets the server confirmed with its observed state. */
      confirmed: number;
      /** Targets still queued or executing; the receipt stays readable. */
      pending: number;
      /** Targets that conflicted, failed, or stayed unknown. */
      needsAttention: number;
    }
  | { state: "queued-offline"; kind: MailActionKindWire }
  | { state: "rejected"; kind: MailActionKindWire; message: string };

/** One action request: the kind, the frozen row, and an optional destination. */
export interface RunMailActionInput {
  kind: MailActionKindWire;
  row: SearchResultItem;
  destinationFolderId?: string;
  /** The generation the session probe issued, when it had one. */
  recoveryGeneration: string | null;
}

/** Submits one mail action, or queues it when the device is offline. */
export async function runMailAction(input: RunMailActionInput): Promise<MailActionOutcome> {
  const { kind, row } = input;
  if (row.occurrences.length === 0) {
    return {
      state: "rejected",
      kind,
      message: "This message has no server copy, so no server action can run on it.",
    };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return enqueueOffline(input);
  }
  if (input.recoveryGeneration === null) {
    return {
      state: "rejected",
      kind,
      message: "The server has not issued a recovery generation yet. Reload and try again.",
    };
  }
  try {
    const response = await apiPost<MailActionResponse>(
      "/actions",
      {
        accountId: row.accountId,
        kind,
        idempotencyKey: newIdempotencyKey(),
        occurrenceIds: row.occurrences.map((occurrence) => occurrence.occurrenceId),
        ...(input.destinationFolderId === undefined
          ? {}
          : { destinationFolderId: input.destinationFolderId }),
      },
      { headers: { [RECOVERY_GENERATION_HEADER]: input.recoveryGeneration } },
    );
    return summarize(kind, response.action.items);
  } catch (error) {
    const failure = toApiError(error);
    if (failure.network) {
      // The request never reached the service, so nothing executed: the
      // frozen action may queue and replay exactly as submitted.
      return enqueueOffline(input);
    }
    if (failure.unauthorized) {
      return { state: "rejected", kind, message: "Your session ended. Sign in and try again." };
    }
    return { state: "rejected", kind, message: failure.message };
  }
}

/** Counts one receipt's items into the three buckets the interface reports. */
function summarize(
  kind: MailActionKindWire,
  items: MailActionResponse["action"]["items"],
): MailActionOutcome {
  const summary = { confirmed: 0, pending: 0, needsAttention: 0 };
  for (const item of items) {
    if (item.status === "confirmed") {
      summary.confirmed += 1;
    } else if (item.status === "queued" || item.status === "executing") {
      summary.pending += 1;
    } else {
      summary.needsAttention += 1;
    }
  }
  return { state: "submitted", kind, ...summary };
}

/** Freezes the action into the offline queue for replay (SPEC F9). */
async function enqueueOffline(input: RunMailActionInput): Promise<MailActionOutcome> {
  const controller = offlineSync();
  if (controller === null) {
    return {
      state: "rejected",
      kind: input.kind,
      message: "This browser keeps no offline queue, and the server cannot be reached.",
    };
  }
  try {
    await controller.enqueueMailAction(queuePayloadOf(input));
    return { state: "queued-offline", kind: input.kind };
  } catch {
    return {
      state: "rejected",
      kind: input.kind,
      message: "The action could not be queued on this device. Try again.",
    };
  }
}

/** The queue payload of one request: the same frozen targets, stamped at replay. */
function queuePayloadOf(
  input: RunMailActionInput,
): Extract<QueuedPayload, { kind: "flag" | "move" }> {
  const { kind, row } = input;
  const targets: FrozenTarget[] = row.occurrences.map((occurrence) => ({
    accountId: row.accountId,
    folderId: occurrence.folderId,
    messageId: row.messageId,
    occurrenceId: occurrence.occurrenceId,
    revision: occurrence.revision,
    modseq: occurrence.modseq,
  }));
  const idempotencyKey = newIdempotencyKey();
  if (kind === "mark_read") {
    return { kind: "flag", flag: "unread", value: false, targets, idempotencyKey };
  }
  if (kind === "mark_unread") {
    return { kind: "flag", flag: "unread", value: true, targets, idempotencyKey };
  }
  if (kind === "star") {
    return { kind: "flag", flag: "flagged", value: true, targets, idempotencyKey };
  }
  if (kind === "unstar") {
    return { kind: "flag", flag: "flagged", value: false, targets, idempotencyKey };
  }
  return {
    kind: "move",
    targets,
    destinationFolderId: input.destinationFolderId ?? "",
    idempotencyKey,
  };
}

/** One fresh idempotency key, so a retry never collides with its request. */
function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `act-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
