import { and, eq, isNull, or } from "drizzle-orm";
import { folders, type MailHubDatabase } from "@mail-hub/database";
import { SyncError } from "./errors.ts";
import type { BackfillService } from "./backfill.ts";
import type { BodyFetchOutcome, BodyFetchService } from "./bodies.ts";
import type { MailboxSession } from "./mailbox.ts";

/**
 * One account's bounded synchronization cycle (SPEC F2).
 *
 * Backfill holds one IMAP connection per account and yields between batches,
 * so polls and user actions keep their turn. A cycle runs a bounded number of
 * windows per folder, then a bounded number of body jobs, and reports what it
 * did. Callers schedule cycles; folders that need no work cost one read.
 */

/** Windows one cycle fetches per folder before it moves on. */
export const DEFAULT_BATCHES_PER_FOLDER = 10;

/** Body jobs one cycle resolves per account. */
export const DEFAULT_BODIES_PER_CYCLE = 25;

export interface SyncRunnerOptions {
  /** Windows one cycle fetches per folder. */
  batchesPerFolder?: number;
  /** Body jobs one cycle resolves. */
  bodiesPerCycle?: number;
}

/** What one cycle changed. */
export interface AccountCycleSummary {
  accountId: string;
  folders: number;
  batches: number;
  imported: number;
  bodiesFetched: number;
  generationChanges: number;
}

export interface CycleControl {
  /** Abort between batches; an aborted cycle ends without error. */
  signal?: AbortSignal;
}

export class SyncRunner {
  private readonly batchesPerFolder: number;
  private readonly bodiesPerCycle: number;

  constructor(
    private readonly db: MailHubDatabase,
    private readonly backfill: BackfillService,
    private readonly bodies: BodyFetchService,
    options: SyncRunnerOptions = {},
  ) {
    this.batchesPerFolder = positiveInteger(options.batchesPerFolder, DEFAULT_BATCHES_PER_FOLDER, "batches per folder");
    this.bodiesPerCycle = positiveInteger(options.bodiesPerCycle, DEFAULT_BODIES_PER_CYCLE, "bodies per cycle");
  }

  /**
   * Run one bounded cycle for one account through one open session. Folder
   * generation changes stop that folder's work for the cycle; reconciliation
   * owns the reset (SPEC F2).
   */
  async runAccountCycle(
    session: MailboxSession,
    accountId: string,
    control: CycleControl = {},
  ): Promise<AccountCycleSummary> {
    const summary: AccountCycleSummary = {
      accountId,
      folders: 0,
      batches: 0,
      imported: 0,
      bodiesFetched: 0,
      generationChanges: 0,
    };

    const due = await this.db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.accountId, accountId),
          or(isNull(folders.uidvalidity), eq(folders.backfillComplete, false)),
        ),
      )
      .orderBy(folders.name);

    for (const folder of due) {
      summary.folders += 1;
      for (let batch = 0; batch < this.batchesPerFolder; batch += 1) {
        if (aborted(control)) {
          return summary;
        }
        const outcome = await this.backfill.runBatch(session, accountId, folder.id);
        summary.batches += 1;
        if (outcome.state === "imported") {
          summary.imported += outcome.imported;
        }
        if (outcome.state === "generation_changed") {
          summary.generationChanges += 1;
          break;
        }
        // Covers a completed folder and a folder initialized empty.
        if ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete) {
          break;
        }
        // Yield between batches so polls and user actions can run.
        await yieldControl();
      }
      await yieldControl();
    }

    const pending = await this.bodies.pendingBodies(accountId, this.bodiesPerCycle);
    for (const job of pending) {
      if (aborted(control)) {
        return summary;
      }
      const outcome: BodyFetchOutcome = await this.bodies.fetchBody(session, accountId, job);
      if (outcome.state === "fetched") {
        summary.bodiesFetched += 1;
      }
      await yieldControl();
    }
    return summary;
  }
}

function aborted(control: CycleControl): boolean {
  return control.signal?.aborted === true;
}

/** One turn of the event loop between remote batches. */
function yieldControl(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function positiveInteger(value: number | undefined, fallback: number, kind: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SyncError("invalid_request", `${kind} must be a positive integer.`);
  }
  return value;
}
