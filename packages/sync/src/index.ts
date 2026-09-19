/**
 * Resumable IMAP backfill, steady-state polling, and reconciliation
 * (SPEC F2).
 *
 * Header import runs in bounded UID windows, newest first, with transactional
 * checkpoints and `UIDVALIDITY` checks on both sides of every fetch. Body
 * fetches run as background work over the durable pending set: the imported
 * rows themselves. Steady state polls each folder on its cadence: arrivals
 * above the scanned bound, flag refreshes, and expunge detection, with a
 * nightly full inventory and generation resets that hand a folder back to
 * backfill. Logical-message threading resolves parents from message
 * identifiers only, keeps ambiguous and pending links unlinked, and moves
 * whole chains onto their root's thread. One session per account carries the
 * whole cycle, yielding between batches.
 */
export { SyncError, type SyncErrorCode } from "./errors.ts";
export {
  BackfillService,
  DEFAULT_BACKFILL_WINDOW,
  type BackfillBatchOutcome,
  type BackfillOptions,
} from "./backfill.ts";
export {
  BodyFetchService,
  type BodyFetchOutcome,
  type PendingBody,
} from "./bodies.ts";
export { parseHeaderBlock, type ImportedHeaders } from "./headers.ts";
export {
  IMPORTED_HEADER_FIELDS,
  type MailboxConnection,
  type MailboxFlags,
  type MailboxHeaders,
  type MailboxSession,
  type MailboxSessionFactory,
  type MailboxState,
} from "./mailbox.ts";
export { ImapMailboxSessionFactory, ImapMailboxSession } from "./imap-session.ts";
export {
  FOLDER_INVENTORY_EVENT,
  FOLDER_GENERATION_RESET_EVENT,
  INVENTORY_INTERVAL_MS,
  DEFAULT_REPAIR_LIMIT,
  ReconciliationService,
  type InventoryOutcome,
  type ReconciliationOptions,
  type ResetOutcome,
} from "./reconcile.ts";
export {
  SyncRunner,
  DEFAULT_BATCHES_PER_FOLDER,
  DEFAULT_BODIES_PER_CYCLE,
  DEFAULT_THREADS_PER_CYCLE,
  type AccountCycleSummary,
  type CycleControl,
  type SyncRunnerOptions,
} from "./runner.ts";
export {
  DEFAULT_THREAD_BATCH,
  ThreadService,
  extractMessageIds,
  resolveParentReference,
  type ParentReference,
  type ThreadOptions,
  type ThreadReconciliationSummary,
} from "./threads.ts";
export {
  FOLDER_POLLED_EVENT,
  INBOX_POLL_INTERVAL_MS,
  OTHER_FOLDER_POLL_INTERVAL_MS,
  DEFAULT_FLAG_BATCH,
  SteadyStateService,
  type PollOutcome,
  type SteadyStateOptions,
} from "./steady.ts";
