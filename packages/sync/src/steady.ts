import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  folders,
  messageOccurrences,
  type Folder,
  type MailHubDatabase,
} from "@mail-hub/database";
import { SyncError } from "./errors.ts";
import type { MailboxSession } from "./mailbox.ts";
import {
  importHeaderRecord,
  lastFolderEventAt,
  loadFolder,
  lockFolder,
  recordFolderEvent,
  requireUuid,
} from "./store.ts";

/**
 * Steady-state folder polling (SPEC F2).
 *
 * A poll selects the folder, captures `UIDNEXT - 1` as its arrival bound, and
 * imports arrivals above `arrival_scanned_uid` through that bound in bounded
 * batches, each committing with the checkpoint it covered. It then compares
 * the server's UID set with the active occurrences of the current generation
 * and marks absent ones expunged, and refreshes flags in bounded batches
 * without change-tracking extensions, reading the occurrences themselves in
 * pages of the same size. Every database commit rechecks the folder
 * generation first, so a worker discards its results when the generation
 * moves under it.
 */

/** The event that marks one folder polled; its newest row sets the due time. */
export const FOLDER_POLLED_EVENT = "sync.folder_polled";

/** Inbox poll cadence (SPEC F2 steady state). */
export const INBOX_POLL_INTERVAL_MS = 60_000;

/** Cadence for every folder that is not the Inbox. */
export const OTHER_FOLDER_POLL_INTERVAL_MS = 15 * 60_000;

/** Flags move in bounded batches, like header windows. */
export const DEFAULT_FLAG_BATCH = 200;

/** Arrivals import in bounded batches, like header windows (SPEC F2). */
export const DEFAULT_ARRIVAL_BATCH = 200;

/** What one poll did. */
export type PollOutcome =
  | {
      state: "polled";
      folderId: string;
      uidvalidity: number;
      /** `UIDNEXT - 1` captured by this poll. */
      bound: number;
      /** Server UIDs inside the arrival range. */
      found: number;
      imported: number;
      /** UIDs an occurrence already covered; a repeated poll replays safely. */
      skipped: number;
      /** Active occurrences whose flags the server answered. */
      flagsObserved: number;
      /** Occurrences whose observed flags changed; each bumps its revision. */
      flagsChanged: number;
      /** Active occurrences the server no longer holds. */
      expunged: number;
    }
  | { state: "generation_changed"; folderId: string; recorded: number; observed: number }
  | { state: "uninitialized"; folderId: string };

/** One flag observation for one occurrence. */
interface FlagChange {
  occurrenceId: string;
  unread: boolean;
  flagged: boolean;
}

export interface SteadyStateOptions {
  /** Maximum occurrences per flag fetch. */
  flagBatch?: number;
  /** Maximum UIDs one arrival import fetches and commits. */
  arrivalBatch?: number;
}

export class SteadyStateService {
  private readonly flagBatch: number;
  private readonly arrivalBatch: number;

  constructor(
    private readonly db: MailHubDatabase,
    options: SteadyStateOptions = {},
  ) {
    const flagBatch = options.flagBatch ?? DEFAULT_FLAG_BATCH;
    if (!Number.isSafeInteger(flagBatch) || flagBatch < 1) {
      throw new SyncError("invalid_request", "The flag batch size must be a positive integer.");
    }
    this.flagBatch = flagBatch;
    const arrivalBatch = options.arrivalBatch ?? DEFAULT_ARRIVAL_BATCH;
    if (!Number.isSafeInteger(arrivalBatch) || arrivalBatch < 1) {
      throw new SyncError("invalid_request", "The arrival batch size must be a positive integer.");
    }
    this.arrivalBatch = arrivalBatch;
  }

  /** The poll interval of one folder: the Inbox polls every minute. */
  pollIntervalMs(folder: Folder): number {
    return folder.role === "inbox" ? INBOX_POLL_INTERVAL_MS : OTHER_FOLDER_POLL_INTERVAL_MS;
  }

  /** When one folder was last polled, from the audit trail. */
  lastPolledAt(folderId: string): Promise<Date | null> {
    return lastFolderEventAt(this.db, folderId, FOLDER_POLLED_EVENT);
  }

  /** Whether one folder's poll interval has elapsed. A never-polled folder is due. */
  async pollDue(folder: Folder, now: Date = new Date()): Promise<boolean> {
    const last = await this.lastPolledAt(folder.id);
    if (last === null) {
      return true;
    }
    return now.getTime() - last.getTime() >= this.pollIntervalMs(folder);
  }

  /**
   * Poll one folder: arrivals, expunges, then flags. A generation change at
   * any point stops the poll with nothing further applied; reconciliation
   * owns the reset.
   */
  async pollFolder(
    session: MailboxSession,
    accountId: string,
    folderId: string,
  ): Promise<PollOutcome> {
    requireUuid("account id", accountId);
    requireUuid("folder id", folderId);
    const folder = await loadFolder(this.db, accountId, folderId);

    // Selection validates the generation before any fetch (SPEC F2).
    const mailbox = await session.select(folder.name);
    if (folder.uidvalidity !== null && folder.uidvalidity !== mailbox.uidValidity) {
      return {
        state: "generation_changed",
        folderId,
        recorded: folder.uidvalidity,
        observed: mailbox.uidValidity,
      };
    }
    if (folder.uidvalidity === null || folder.backfillBeforeUid === null) {
      // First contact belongs to backfill; it initializes the checkpoints.
      return { state: "uninitialized", folderId };
    }
    const generation = folder.uidvalidity;

    const arrivals = await this.importArrivals(
      session,
      accountId,
      folder,
      mailbox.uidNext,
      generation,
    );
    if (arrivals.state === "generation_changed") {
      return arrivals;
    }

    const expunged = await this.markExpunges(session, accountId, folderId, generation);
    if (expunged.state === "generation_changed") {
      return { ...expunged, folderId };
    }

    const flags = await this.refreshFlags(session, accountId, folderId, generation);
    if (flags.state === "generation_changed") {
      return { ...flags, folderId };
    }

    const outcome: PollOutcome = {
      state: "polled",
      folderId,
      uidvalidity: generation,
      bound: arrivals.bound,
      found: arrivals.found,
      imported: arrivals.imported,
      skipped: arrivals.skipped,
      flagsObserved: flags.observed,
      flagsChanged: flags.changed,
      expunged: expunged.count,
    };
    await recordFolderEvent(this.db, accountId, folderId, FOLDER_POLLED_EVENT, {
      uidvalidity: generation,
      bound: outcome.bound,
      found: outcome.found,
      imported: outcome.imported,
      skipped: outcome.skipped,
      flagsObserved: outcome.flagsObserved,
      flagsChanged: outcome.flagsChanged,
      expunged: outcome.expunged,
    });
    return outcome;
  }

  /**
   * Import arrivals above `arrival_scanned_uid` through the captured bound.
   * The range moves in bounded batches — downtime can owe thousands of UIDs —
   * and each batch commits its rows with the checkpoint it covered, so a
   * restart re-covers at most the batch in flight. The last batch carries the
   * poll's bound itself, so UIDs the search found nothing for above the
   * newest arrival are never searched again (SPEC F2 steady state).
   */
  private async importArrivals(
    session: MailboxSession,
    accountId: string,
    folder: Folder,
    uidNext: number,
    generation: number,
  ): Promise<
    | { state: "ok"; bound: number; found: number; imported: number; skipped: number }
    | { state: "generation_changed"; folderId: string; recorded: number; observed: number }
  > {
    const bound = Math.max(0, uidNext - 1);
    if (bound <= folder.arrivalScannedUid) {
      return { state: "ok", bound, found: 0, imported: 0, skipped: 0 };
    }

    const uids = await session.searchUids(folder.arrivalScannedUid + 1, bound);
    // Ascending: one batch's checkpoint is the newest UID it imported.
    const ordered = [...uids].sort((a, b) => a - b);
    const windows: number[][] = [];
    for (let offset = 0; offset < ordered.length; offset += this.arrivalBatch) {
      windows.push(ordered.slice(offset, offset + this.arrivalBatch));
    }
    if (windows.length === 0) {
      // The range holds no message; its bound still needs one commit.
      windows.push([]);
    }

    let found = 0;
    let imported = 0;
    let skipped = 0;
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index]!;
      const records = await session.fetchHeaders(window);

      // Discard the fetch when the generation moved before its commit (SPEC F2).
      const recheck = await session.revalidate();
      if (recheck.uidValidity !== generation) {
        return { state: "generation_changed", folderId: folder.id, recorded: generation, observed: recheck.uidValidity };
      }

      const committed = await this.db.transaction(async (tx) => {
        const locked = await lockFolder(tx, accountId, folder.id);
        if (locked.uidvalidity !== generation) {
          return null;
        }
        let batchImported = 0;
        let batchSkipped = 0;
        for (const record of records) {
          const wasImported = await importHeaderRecord(tx, accountId, folder.id, generation, record);
          if (wasImported) {
            batchImported += 1;
          } else {
            batchSkipped += 1;
          }
        }
        // The checkpoint is monotonic: only a higher value moves it.
        const covered = index === windows.length - 1 ? bound : window[window.length - 1]!;
        const scanned = Math.max(locked.arrivalScannedUid, covered);
        await tx
          .update(folders)
          .set({ arrivalScannedUid: scanned })
          .where(eq(folders.id, folder.id));
        return { imported: batchImported, skipped: batchSkipped };
      });
      if (committed === null) {
        // Another cycle already moved the folder while this poll was in
        // flight. The committed generation stands: report it as observed, so
        // the guarded reset recognizes the folder as already current.
        const observed = (await loadFolder(this.db, accountId, folder.id)).uidvalidity ?? generation;
        return { state: "generation_changed", folderId: folder.id, recorded: generation, observed };
      }
      found += window.length;
      imported += committed.imported;
      skipped += committed.skipped;
    }
    return { state: "ok", bound, found, imported, skipped };
  }

  /**
   * Compare the server's UID set with the active occurrences of this
   * generation and mark absent ones expunged. Originals and message rows stay
   * (SPEC section 8: expunged mail remains readable locally).
   */
  private async markExpunges(
    session: MailboxSession,
    accountId: string,
    folderId: string,
    generation: number,
  ): Promise<{ state: "ok"; count: number } | { state: "generation_changed"; recorded: number; observed: number }> {
    const bound = Math.max(0, (await session.revalidate()).uidNext - 1);
    const present = new Set(bound >= 1 ? await session.searchUids(1, bound) : []);

    const active = await this.db
      .select({ id: messageOccurrences.id, uid: messageOccurrences.uid })
      .from(messageOccurrences)
      .where(
        and(
          eq(messageOccurrences.accountId, accountId),
          eq(messageOccurrences.folderId, folderId),
          eq(messageOccurrences.uidvalidity, generation),
          isNull(messageOccurrences.expungedAt),
          isNull(messageOccurrences.invalidatedAt),
        ),
      );
    // A UID above the snapshot bound is an arrival this snapshot never judged:
    // the search window stops at the bound, so a concurrent import above it
    // must not read as an expunge (SPEC F2).
    const absent = active.filter((row) => row.uid <= bound && !present.has(row.uid));
    if (absent.length === 0) {
      return { state: "ok", count: 0 };
    }

    const recheck = await session.revalidate();
    if (recheck.uidValidity !== generation) {
      return { state: "generation_changed", recorded: generation, observed: recheck.uidValidity };
    }
    const marked = await this.db.transaction(async (tx) => {
      const locked = await lockFolder(tx, accountId, folderId);
      if (locked.uidvalidity !== generation) {
        return null;
      }
      const updated = await tx
        .update(messageOccurrences)
        .set({ expungedAt: new Date() })
        .where(
          and(
            inArray(
              messageOccurrences.id,
              absent.map((row) => row.id),
            ),
            isNull(messageOccurrences.expungedAt),
          ),
        )
        .returning({ id: messageOccurrences.id });
      return updated.length;
    });
    if (marked === null) {
      return { state: "generation_changed", recorded: generation, observed: generation };
    }
    return { state: "ok", count: marked };
  }

  /**
   * Refresh observed flags in bounded batches. The occurrences themselves are
   * read in pages of the same bound — a folder can hold every message an
   * account ever kept — and each page commits its own changes after the
   * generation is rechecked. Only a changed observation writes: the revision
   * stays stable while the server state does, so a queued action target does
   * not go stale because a poll looked at it.
   */
  private async refreshFlags(
    session: MailboxSession,
    accountId: string,
    folderId: string,
    generation: number,
  ): Promise<{ state: "ok"; observed: number; changed: number } | { state: "generation_changed"; recorded: number; observed: number }> {
    let observed = 0;
    let changed = 0;
    // Keyset pagination on the UID: one page's newest UID is the next page's
    // exclusive lower bound, so no page depends on row offsets.
    let uidAfter = 0;
    for (;;) {
      const batch = await this.db
        .select({
          id: messageOccurrences.id,
          uid: messageOccurrences.uid,
          unread: messageOccurrences.unread,
          flagged: messageOccurrences.flagged,
        })
        .from(messageOccurrences)
        .where(
          and(
            eq(messageOccurrences.accountId, accountId),
            eq(messageOccurrences.folderId, folderId),
            eq(messageOccurrences.uidvalidity, generation),
            isNull(messageOccurrences.expungedAt),
            isNull(messageOccurrences.invalidatedAt),
            gt(messageOccurrences.uid, uidAfter),
          ),
        )
        .orderBy(messageOccurrences.uid)
        .limit(this.flagBatch);
      if (batch.length === 0) {
        break;
      }
      uidAfter = batch[batch.length - 1]!.uid;

      const answers = await session.fetchFlags(batch.map((row) => row.uid));
      const byUid = new Map(answers.map((answer) => [answer.uid, answer]));
      const changes: FlagChange[] = [];
      for (const occurrence of batch) {
        // A UID the server omitted from the answer no longer exists; expunge
        // detection owns that marking.
        const answer = byUid.get(occurrence.uid);
        if (answer === undefined) {
          continue;
        }
        observed += 1;
        if (answer.unread !== occurrence.unread || answer.flagged !== occurrence.flagged) {
          changes.push({
            occurrenceId: occurrence.id,
            unread: answer.unread,
            flagged: answer.flagged,
          });
        }
      }
      if (changes.length === 0) {
        continue;
      }

      const recheck = await session.revalidate();
      if (recheck.uidValidity !== generation) {
        return { state: "generation_changed", recorded: generation, observed: recheck.uidValidity };
      }
      const applied = await this.db.transaction(async (tx) => {
        const locked = await lockFolder(tx, accountId, folderId);
        if (locked.uidvalidity !== generation) {
          return null;
        }
        for (const change of changes) {
          await tx
            .update(messageOccurrences)
            .set({
              unread: change.unread,
              flagged: change.flagged,
              // Increment in the statement itself, so a revision another writer
              // committed between the read and this lock still counts.
              revision: sql`${messageOccurrences.revision} + 1`,
              observedAt: new Date(),
            })
            .where(eq(messageOccurrences.id, change.occurrenceId));
        }
        return changes.length;
      });
      if (applied === null) {
        return { state: "generation_changed", recorded: generation, observed: generation };
      }
      changed += applied;
    }
    return { state: "ok", observed, changed };
  }
}
