import type {
  CreateHomeDismissalBody,
  CreateHomeWorkBody,
  HomeDismissalResponse,
  HomePrioritiesResponse,
  HomePriorityView,
  HomeWorkRecordView,
  HomeWorkResponse,
  RescheduleHomeWorkBody,
  SetHomePriorityBody,
} from "@mail-hub/contracts";
import { ApiError, apiDelete, apiGet, apiPost, apiPut, toApiError } from "@/lib/api";

/*
 * The client half of the Home mutations (SPEC F13). Every change needs a
 * connection, the recovery generation the session captured, and the revision
 * the last read observed. These calls never queue for replay: an unsaved
 * reminder must not read as saved, so a failure keeps the row and reports.
 */

/** The header the API's recovery gate reads (SPEC section 10). */
const RECOVERY_GENERATION_HEADER = "x-recovery-generation";

/** One rejection the controls can show beside the row they came from. */
export class HomeMutationError extends Error {
  /** The API error the change failed with. */
  override readonly cause: ApiError;

  constructor(cause: ApiError) {
    super(cause.message);
    this.cause = cause;
    this.name = "HomeMutationError";
  }
}

/** Throws when this device has no connection for a Home change. */
function requireConnection(): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new HomeMutationError(
      new ApiError(0, "offline", "Home changes need a connection. Reconnect and try again."),
    );
  }
}

/** Throws when the session carries no recovery generation yet. */
function requireGeneration(generation: string | null): string {
  if (generation === null) {
    throw new HomeMutationError(
      new ApiError(
        0,
        "invalid_recovery_generation",
        "The server has not issued a recovery generation yet. Reload and try again.",
      ),
    );
  }
  return generation;
}

/** Wraps one mutation so every failure lands as one `HomeMutationError`. */
async function send<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new HomeMutationError(toApiError(cause));
  }
}

function generationHeaders(generation: string): Record<string, string> {
  return { [RECOVERY_GENERATION_HEADER]: generation };
}

/** Saves reply later work or a dated reminder (SPEC F13). */
export function createHomeWork(
  recoveryGeneration: string | null,
  body: CreateHomeWorkBody,
): Promise<HomeWorkRecordView> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    const response = await apiPost<HomeWorkResponse>("/home/work", body, {
      headers: generationHeaders(generation),
    });
    return response.work;
  });
}

/** Moves one reminder to a new due instant (SPEC F13). */
export function rescheduleHomeWork(
  recoveryGeneration: string | null,
  workId: string,
  body: RescheduleHomeWorkBody,
): Promise<HomeWorkRecordView> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    const response = await apiPost<HomeWorkResponse>(`/home/work/${workId}/reschedule`, body, {
      headers: generationHeaders(generation),
    });
    return response.work;
  });
}

/** Completes one saved work item; the provider message never moves. */
export function completeHomeWork(
  recoveryGeneration: string | null,
  workId: string,
  revision: number,
): Promise<HomeWorkRecordView> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    const response = await apiPost<HomeWorkResponse>(
      `/home/work/${workId}/complete`,
      { revision },
      { headers: generationHeaders(generation) },
    );
    return response.work;
  });
}

/** Reopens one completed work item. */
export function reopenHomeWork(
  recoveryGeneration: string | null,
  workId: string,
  revision: number,
): Promise<HomeWorkRecordView> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    const response = await apiPost<HomeWorkResponse>(
      `/home/work/${workId}/reopen`,
      { revision },
      { headers: generationHeaders(generation) },
    );
    return response.work;
  });
}

/** Cancels one open work item; completed history stays reviewable. */
export function cancelHomeWork(
  recoveryGeneration: string | null,
  workId: string,
  revision: number,
): Promise<void> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    await apiPost(`/home/work/${workId}/cancel`, { revision }, {
      headers: generationHeaders(generation),
    });
  });
}

/** Records or removes one priority choice, answering with the full list. */
export function setHomePriority(
  recoveryGeneration: string | null,
  body: SetHomePriorityBody,
): Promise<HomePriorityView[]> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    const response = await apiPut<HomePrioritiesResponse>("/home/priorities", body, {
      headers: generationHeaders(generation),
    });
    return response.priorities;
  });
}

/** The recorded priority choices, for revisions and remove controls. */
export function listHomePriorities(): Promise<HomePriorityView[]> {
  return send(async () => {
    const response = await apiGet<HomePrioritiesResponse>("/home/priorities");
    return response.priorities;
  });
}

/** Hides one suggestion from Home. Undo restores it. */
export function dismissHomeSuggestion(
  recoveryGeneration: string | null,
  body: CreateHomeDismissalBody,
): Promise<void> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    await apiPost<HomeDismissalResponse>("/home/dismissals", body, {
      headers: generationHeaders(generation),
    });
  });
}

/** Restores one dismissed suggestion. */
export function undismissHomeSuggestion(
  recoveryGeneration: string | null,
  accountId: string,
  messageId: string,
): Promise<void> {
  requireConnection();
  return send(async () => {
    const generation = requireGeneration(recoveryGeneration);
    await apiDelete(
      `/home/dismissals/${messageId}?accountId=${encodeURIComponent(accountId)}`,
      { headers: generationHeaders(generation) },
    );
  });
}
