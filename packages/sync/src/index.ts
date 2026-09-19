/**
 * Resumable IMAP backfill and background body fetching (SPEC F2).
 *
 * Header import runs in bounded UID windows, newest first, with
 * transactional checkpoints and `UIDVALIDITY` checks on both sides of every
 * fetch. Body fetches run as background work over the durable pending set:
 * the imported rows themselves. One session per account carries the whole
 * cycle, yielding between batches.
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
  type MailboxHeaders,
  type MailboxSession,
  type MailboxSessionFactory,
  type MailboxState,
} from "./mailbox.ts";
export { ImapMailboxSessionFactory, ImapMailboxSession } from "./imap-session.ts";
export {
  SyncRunner,
  DEFAULT_BATCHES_PER_FOLDER,
  DEFAULT_BODIES_PER_CYCLE,
  type AccountCycleSummary,
  type CycleControl,
  type SyncRunnerOptions,
} from "./runner.ts";
