import { createHash } from "node:crypto";
import type { ActionItemTarget } from "@mail-hub/database";

import { ActionError } from "./errors.ts";

/**
 * The action kinds and their desired state (SPEC F4).
 *
 * Every action sets an explicit value; none of them toggles a remote value.
 * Flag kinds change one flag of one occurrence. `archive` and `move` carry a
 * destination folder that the request freezes before queueing.
 */

/** One flag an action can set, with the value it sets it to. */
export interface FlagDesire {
  flag: "unread" | "flagged";
  value: boolean;
}

/** The flag kinds and the value each one sets (SPEC F4). */
export const FLAG_KINDS = {
  mark_read: { flag: "unread", value: false },
  mark_unread: { flag: "unread", value: true },
  star: { flag: "flagged", value: true },
  unstar: { flag: "flagged", value: false },
} as const satisfies Record<string, FlagDesire>;

export type FlagActionKind = keyof typeof FLAG_KINDS;

/** Kinds that move an occurrence to a destination folder (SPEC F4). */
export type MoveActionKind = "archive" | "move";

export type ActionKind = FlagActionKind | MoveActionKind;

export const ACTION_KINDS: readonly ActionKind[] = [
  ...Object.keys(FLAG_KINDS),
  "archive",
  "move",
] as readonly ActionKind[];

/**
 * Kinds whose remote operation is idempotent. Restart reconciliation may
 * replay one of these after refreshing its target (SPEC section 7, step 6).
 * A move never replays blindly: an interrupted move holds `unknown` until
 * reconciliation proves where the message went (SPEC F4).
 */
const REPLAYABLE_KINDS: ReadonlySet<string> = new Set(Object.keys(FLAG_KINDS));

/** Whether one kind may replay after a restart, target refreshed first. */
export function isReplayableKind(kind: string): boolean {
  return REPLAYABLE_KINDS.has(kind);
}

/** The destination a move or archive kind requires before queueing. */
export function requiresDestination(kind: ActionKind): kind is MoveActionKind {
  return kind === "archive" || kind === "move";
}

/** The flag value one flag kind sets. Move kinds have none. */
export function flagDesireOf(kind: ActionKind): FlagDesire | null {
  const desire = FLAG_KINDS[kind as FlagActionKind];
  return desire === undefined ? null : desire;
}

/** The most targets one action may freeze (SPEC F4 bulk selection). */
export const MAX_ACTION_TARGETS = 500;

/** Longest idempotency key accepted, so keys stay index-friendly. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One durable mail-mutation request as a client submits it (SPEC section 7). */
export interface MailActionSubmission {
  accountId: string;
  kind: ActionKind;
  /** The recovery generation issued to the client when it froze this request. */
  recoveryGeneration: string;
  idempotencyKey: string;
  /**
   * Occurrence identifiers the client selected. The service freezes each
   * target's folder generation, revision, and observed flags at queue time
   * (SPEC F2); duplicates collapse.
   */
  occurrenceIds: string[];
  /** Destination folder for `archive` and `move`. Required before queueing. */
  destinationFolderId?: string;
}

/** The immutable request scope stored on the action row. */
export interface ActionScope {
  kind: ActionKind;
  accountId: string;
  occurrenceIds: string[];
  destinationFolderId: string | null;
}

/** Reject a malformed submission before any database work (SPEC section 7, step 1). */
export function validateSubmission(submission: MailActionSubmission): void {
  const label = (field: string, problem: string) =>
    new ActionError("invalid_request", `The ${field} of a mail action ${problem}.`);

  if (!UUID_PATTERN.test(submission.accountId)) {
    throw label("account id", "must be a UUID");
  }
  if (typeof submission.idempotencyKey !== "string" || submission.idempotencyKey.length === 0) {
    throw label("idempotency key", "must be a non-empty string");
  }
  if (submission.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw label("idempotency key", `must hold at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (!ACTION_KINDS.includes(submission.kind)) {
    throw label("kind", `is not one of: ${ACTION_KINDS.join(", ")}`);
  }
  if (!Array.isArray(submission.occurrenceIds) || submission.occurrenceIds.length === 0) {
    throw label("target list", "must hold at least one occurrence");
  }
  const distinct = new Set(submission.occurrenceIds);
  if (distinct.size > MAX_ACTION_TARGETS) {
    throw label("target list", `must hold at most ${MAX_ACTION_TARGETS} occurrences`);
  }
  for (const id of distinct) {
    if (!UUID_PATTERN.test(id)) {
      throw label("target list", "must hold occurrence UUIDs");
    }
  }
  if (requiresDestination(submission.kind)) {
    if (submission.destinationFolderId === undefined || !UUID_PATTERN.test(submission.destinationFolderId)) {
      throw label("destination folder", "must be a UUID before a move or archive is queued");
    }
  } else if (submission.destinationFolderId !== undefined) {
    throw label("destination folder", "only belongs to a move or archive");
  }
}

/**
 * The canonical scope of a submission: the exact payload an idempotency key
 * binds to. A repeated key with a changed payload conflicts (SPEC section 7,
 * step 2).
 */
export function canonicalScope(submission: MailActionSubmission): ActionScope {
  return {
    kind: submission.kind,
    accountId: submission.accountId.toLowerCase(),
    occurrenceIds: [...new Set(submission.occurrenceIds)].map((id) => id.toLowerCase()).sort(),
    destinationFolderId: submission.destinationFolderId?.toLowerCase() ?? null,
  };
}

/** Hash the canonical scope. The request row stores the scope and this hash. */
export function hashScope(scope: ActionScope): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

/** The frozen target of one queued item, ready for the `action_items` row. */
export function frozenTarget(occurrence: {
  id: string;
  accountId: string;
  folderId: string;
  uidvalidity: number;
  uid: number;
  revision: number;
  unread: boolean;
  flagged: boolean;
  modseq: string | null;
}): ActionItemTarget {
  return {
    occurrenceId: occurrence.id,
    accountId: occurrence.accountId,
    folderId: occurrence.folderId,
    uidvalidity: occurrence.uidvalidity,
    uid: occurrence.uid,
    revision: occurrence.revision,
    observed: { unread: occurrence.unread, flagged: occurrence.flagged },
    modseq: occurrence.modseq,
  };
}
