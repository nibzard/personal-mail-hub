import { and, eq, isNull, or, sql } from "drizzle-orm";
import { folders, type Folder, type MailHubDatabase } from "@mail-hub/database";
import { classifyFailure } from "./diagnostics.ts";
import { SyncError } from "./errors.ts";
import type { BackfillService } from "./backfill.ts";
import type { BodyFetchOutcome, BodyFetchService } from "./bodies.ts";
import type { MailboxSession } from "./mailbox.ts";
import type { ReconciliationService } from "./reconcile.ts";
import type { SteadyStateService } from "./steady.ts";
import type { ThreadService } from "./threads.ts";
import { loadFolder, recordAccountEvent } from "./store.ts";

/**
 * One account's bounded synchronization cycle (SPEC F2).
 *
 * Backfill holds one IMAP connection per account and yields between batches,
 * so polls and user actions keep their turn. A cycle runs a bounded number of
 * windows per folder that still needs them, polls the folders whose interval
 * is due, runs a nightly inventory when that interval is due, resolves a
 * bounded number of body jobs, then a bounded number of thread jobs — bodies
 * and merges are what change identifiers — and emits one sync-status event
 * for the account. A folder generation change resets that folder's
 * checkpoints and occurrences, then backfill resumes with the cycle's
 * remaining budget. A failing folder or body job is contained and counted,
 * so one stale job never costs the thread pass or the status event.
 */

/** Windows one cycle fetches per folder before it moves on. */
export const DEFAULT_BATCHES_PER_FOLDER = 10;

/** Body jobs one cycle resolves per account. */
export const DEFAULT_BODIES_PER_CYCLE = 25;

/** Thread jobs one cycle resolves per account. */
export const DEFAULT_THREADS_PER_CYCLE = 100;

/** Approved failure kinds one cycle records per failure surface. */
const MAX_RECORDED_KINDS = 8;

export interface SyncRunnerOptions {
  /** Windows one cycle fetches per folder. */
  batchesPerFolder?: number;
  /** Body jobs one cycle resolves. */
  bodiesPerCycle?: number;
  /** Thread jobs one cycle resolves. */
  threadsPerCycle?: number;
  /**
   * Where contained failures land. A cycle counts a failing folder or body
   * job and moves on; without a logger the diagnostic behind the counter is
   * lost, so the worker passes one.
   */
  logger?: SyncLogger;
}

/** The logging surface the runner needs. */
export interface SyncLogger {
  warn(message: string): void;
}

/** What one cycle changed. */
export interface AccountCycleSummary {
  accountId: string;
  /** Folders that ran backfill windows. */
  folders: number;
  batches: number;
  imported: number;
  bodiesFetched: number;
  generationChanges: number;
  /** Generation resets applied; each restarts that folder's backfill. */
  resets: number;
  /** Folders polled for arrivals, flags, and expunges. */
  polled: number;
  arrivalsImported: number;
  flagsRefreshed: number;
  expungesMarked: number;
  /** Nightly inventories run. */
  inventories: number;
  /** Thread jobs resolved and links they changed. */
  threadsResolved: number;
  threadLinksChanged: number;
  /** Folders whose window, poll, or inventory failed and was contained. */
  folderErrors: number;
  /** Body jobs that failed, for example a stale job after a move. */
  bodyErrors: number;
  /** Thread passes that failed and were contained. */
  threadErrors: number;
  /** Approved failure kinds among contained folder failures, first seen first. */
  folderFailureKinds: string[];
  /** Approved failure kinds among contained body failures, first seen first. */
  bodyFailureKinds: string[];
  /** Approved failure kinds among contained thread failures, first seen first. */
  threadFailureKinds: string[];
}

export interface CycleControl {
  /** Abort between batches; an aborted cycle ends without error. */
  signal?: AbortSignal;
}

export class SyncRunner {
  private readonly batchesPerFolder: number;
  private readonly bodiesPerCycle: number;
  private readonly threadsPerCycle: number;
  private readonly logger: SyncLogger | null;

  constructor(
    private readonly db: MailHubDatabase,
    private readonly backfill: BackfillService,
    private readonly bodies: BodyFetchService,
    private readonly threads: ThreadService,
    private readonly steady: SteadyStateService,
    private readonly reconcile: ReconciliationService,
    options: SyncRunnerOptions = {},
  ) {
    this.batchesPerFolder = positiveInteger(options.batchesPerFolder, DEFAULT_BATCHES_PER_FOLDER, "batches per folder");
    this.bodiesPerCycle = positiveInteger(options.bodiesPerCycle, DEFAULT_BODIES_PER_CYCLE, "bodies per cycle");
    this.threadsPerCycle = positiveInteger(options.threadsPerCycle, DEFAULT_THREADS_PER_CYCLE, "threads per cycle");
    this.logger = options.logger ?? null;
  }

  /**
   * Run one bounded cycle for one account through one open session. Each
   * folder runs backfill while it needs windows, one poll when its interval
   * is due, and one inventory when the nightly interval is due. The cycle
   * always ends with one sync-status event for the account.
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
      resets: 0,
      polled: 0,
      arrivalsImported: 0,
      flagsRefreshed: 0,
      expungesMarked: 0,
      inventories: 0,
      threadsResolved: 0,
      threadLinksChanged: 0,
      folderErrors: 0,
      bodyErrors: 0,
      threadErrors: 0,
      folderFailureKinds: [],
      bodyFailureKinds: [],
      threadFailureKinds: [],
    };

    const accountFolders = await this.db
      .select()
      .from(folders)
      .where(eq(folders.accountId, accountId))
      .orderBy(folders.name);

    for (const folder of accountFolders) {
      if (aborted(control)) {
        break;
      }
      try {
        await this.synchronizeFolder(session, accountId, folder, control, summary);
      } catch (cause) {
        // One failing folder never stops the folders that follow, the body
        // jobs, or the status event; the next cycle retries it. The count
        // alone cannot say why, so the diagnostic goes to the logger — with
        // the folder's internal id and an approved failure kind only: a
        // folder name is personal data, and error text can repeat query
        // parameters with private mail content (SPEC section 9).
        const kind = classifyFailure(cause);
        summary.folderErrors += 1;
        recordFailureKind(summary.folderFailureKinds, kind);
        this.logger?.warn(
          `folder sync failed and was contained: account=${accountId} folder=${folder.id} kind=${kind}`,
        );
      }
      await yieldControl();
    }

    const pending = await this.bodies.pendingBodies(accountId, this.bodiesPerCycle);
    for (const job of pending) {
      if (aborted(control)) {
        break;
      }
      try {
        const outcome: BodyFetchOutcome = await this.bodies.fetchBody(session, accountId, job);
        if (outcome.state === "fetched") {
          summary.bodiesFetched += 1;
        }
      } catch (cause) {
        // One stale job — its occurrence moved or expired after the listing —
        // is skipped, not allowed to abort the account cycle. The count alone
        // cannot say which job or why, so the diagnostic goes to the logger,
        // carrying the job's internal identifiers and an approved kind. The
        // folder name stays out: it is personal data (SPEC section 9).
        const kind = classifyFailure(cause);
        summary.bodyErrors += 1;
        recordFailureKind(summary.bodyFailureKinds, kind);
        this.logger?.warn(
          `body fetch failed and was contained: account=${accountId} folder=${job.folderId} message=${job.messageId} uid=${job.uid} kind=${kind}`,
        );
      }
      await yieldControl();
    }

    // Thread jobs run after bodies: fetching a body can rewrite identifiers
    // and byte-identical copies merge here, so this cycle's merges reconcile
    // in this cycle (SPEC F2).
    if (!aborted(control)) {
      try {
        const reconciled = await this.threads.reconcileAccount(accountId, this.threadsPerCycle);
        summary.threadsResolved = reconciled.examined;
        summary.threadLinksChanged = reconciled.linksChanged;
      } catch (cause) {
        // A failed thread pass must not cost the status event: the account
        // still completed its folders, bodies, and polls, and the next cycle
        // retries the links. The count cannot say why, so the diagnostic
        // goes to the logger with an approved kind only.
        const kind = classifyFailure(cause);
        summary.threadErrors += 1;
        recordFailureKind(summary.threadFailureKinds, kind);
        this.logger?.warn(
          `thread pass failed and was contained: account=${accountId} kind=${kind}`,
        );
      }
    }

    await this.recordStatus(accountId, summary);
    return summary;
  }

  /**
   * Drive one folder through backfill, poll, and inventory with a shared
   * window budget. A detected generation change resets the folder, and the
   * remaining budget backfills the new generation right away.
   */
  private async synchronizeFolder(
    session: MailboxSession,
    accountId: string,
    folder: Folder,
    control: CycleControl,
    summary: AccountCycleSummary,
  ): Promise<void> {
    let budget = this.batchesPerFolder;

    // Backfill while the folder needs windows.
    if (needsBackfill(folder)) {
      summary.folders += 1;
    }
    let current = folder;
    while (needsBackfill(current) && budget > 0 && !aborted(control)) {
      const outcome = await this.backfill.runBatch(session, accountId, current.id);
      summary.batches += 1;
      budget -= 1;
      if (outcome.state === "generation_changed") {
        await this.applyReset(accountId, current.id, outcome.recorded, outcome.observed, summary);
        current = await loadFolder(this.db, accountId, current.id);
        continue;
      }
      if (outcome.state === "imported") {
        summary.imported += outcome.imported;
      }
      // Covers a completed folder and a folder initialized empty.
      if ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete) {
        break;
      }
      // Yield between batches so polls and user actions can run.
      await yieldControl();
    }

    // Poll an initialized folder whose interval is due, even mid-backfill:
    // arrival progress is independent of the historical scan (SPEC F2).
    current = await loadFolder(this.db, accountId, current.id);
    if (!aborted(control) && current.uidvalidity !== null && (await this.steady.pollDue(current))) {
      summary.polled += 1;
      const poll = await this.steady.pollFolder(session, accountId, current.id);
      if (poll.state === "polled") {
        summary.arrivalsImported += poll.imported;
        summary.flagsRefreshed += poll.flagsChanged;
        summary.expungesMarked += poll.expunged;
      }
      if (poll.state === "generation_changed") {
        await this.applyReset(accountId, current.id, poll.recorded, poll.observed, summary);
        current = await this.runResetBackfill(session, accountId, current.id, budget, control, summary);
      }
    }

    // The nightly inventory runs once the folder's history is imported.
    if (
      !aborted(control) &&
      current.backfillComplete &&
      (await this.reconcile.inventoryDue(current.id))
    ) {
      summary.inventories += 1;
      const inventory = await this.reconcile.inventoryFolder(session, accountId, current.id);
      if (inventory.state === "inventoried") {
        summary.expungesMarked += inventory.expunged;
      }
      if (inventory.state === "generation_changed") {
        await this.applyReset(accountId, current.id, inventory.recorded, inventory.observed, summary);
        await this.runResetBackfill(session, accountId, current.id, budget, control, summary);
      }
    }
  }

  /** Backfill a just-reset folder with the budget the cycle has left. */
  private async runResetBackfill(
    session: MailboxSession,
    accountId: string,
    folderId: string,
    budget: number,
    control: CycleControl,
    summary: AccountCycleSummary,
  ): Promise<Folder> {
    let current = await loadFolder(this.db, accountId, folderId);
    while (needsBackfill(current) && budget > 0 && !aborted(control)) {
      const outcome = await this.backfill.runBatch(session, accountId, folderId);
      summary.batches += 1;
      budget -= 1;
      if (outcome.state === "generation_changed") {
        await this.applyReset(accountId, folderId, outcome.recorded, outcome.observed, summary);
        current = await loadFolder(this.db, accountId, folderId);
        continue;
      }
      if (outcome.state === "imported") {
        summary.imported += outcome.imported;
      }
      if ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete) {
        break;
      }
      await yieldControl();
    }
    return loadFolder(this.db, accountId, folderId);
  }

  /**
   * Count and apply one folder generation reset (SPEC F2 reconciliation). The
   * caller's recorded generation guards the reset, so an observation another
   * cycle already overtook changes nothing.
   */
  private async applyReset(
    accountId: string,
    folderId: string,
    recorded: number,
    observed: number,
    summary: AccountCycleSummary,
  ): Promise<void> {
    summary.generationChanges += 1;
    const reset = await this.reconcile.resetFolderGeneration(accountId, folderId, recorded, observed);
    if (reset.state === "reset") {
      summary.resets += 1;
    }
  }

  /**
   * One sync-status event per account per cycle. Pending body and thread
   * counts are recorded separately from header sync progress (SPEC F2).
   */
  private async recordStatus(accountId: string, summary: AccountCycleSummary): Promise<void> {
    const pending = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(folders)
      .where(
        and(
          eq(folders.accountId, accountId),
          or(isNull(folders.uidvalidity), eq(folders.backfillComplete, false)),
        ),
      );
    await recordAccountEvent(this.db, accountId, "sync.status", {
      folders: summary.folders,
      batches: summary.batches,
      imported: summary.imported,
      bodiesFetched: summary.bodiesFetched,
      generationChanges: summary.generationChanges,
      resets: summary.resets,
      polled: summary.polled,
      arrivalsImported: summary.arrivalsImported,
      flagsRefreshed: summary.flagsRefreshed,
      expungesMarked: summary.expungesMarked,
      inventories: summary.inventories,
      threadsResolved: summary.threadsResolved,
      threadLinksChanged: summary.threadLinksChanged,
      folderErrors: summary.folderErrors,
      bodyErrors: summary.bodyErrors,
      threadErrors: summary.threadErrors,
      // Approved failure kinds, so a durable status read can tell a database
      // fault from a mailbox fault without any private error text.
      folderFailureKinds: summary.folderFailureKinds,
      bodyFailureKinds: summary.bodyFailureKinds,
      threadFailureKinds: summary.threadFailureKinds,
      // Header sync progress: how many folders still owe historical windows.
      backfillPendingFolders: pending[0]?.count ?? 0,
      // Body sync progress, independent of headers.
      pendingBodies: await this.bodies.pendingBodyCount(accountId),
      // Thread reconciliation progress, independent of both.
      pendingThreads: await this.threads.pendingCount(accountId),
    });
  }
}

/** Whether one folder still owes backfill windows. */
function needsBackfill(folder: Folder): boolean {
  return folder.uidvalidity === null || !folder.backfillComplete;
}

function aborted(control: CycleControl): boolean {
  return control.signal?.aborted === true;
}

/** Record one approved failure kind, deduplicated and bounded per surface. */
function recordFailureKind(kinds: string[], kind: string): void {
  if (!kinds.includes(kind) && kinds.length < MAX_RECORDED_KINDS) {
    kinds.push(kind);
  }
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
