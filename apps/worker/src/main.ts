import { parseCredentialsKey, createCredentialCipher, AccountService } from "@mail-hub/accounts";
import { createDatabase, createJobQueue, createPool, createStorage } from "@mail-hub/database";
import { IngestionService } from "@mail-hub/ingestion";
import {
  RecoveryControls,
  assessJob,
  describeControlStatus,
  waitForReadyService,
  type ReadyStatus,
} from "@mail-hub/recovery";
import {
  BackfillService,
  BodyFetchService,
  ImapMailboxSessionFactory,
  ReconciliationService,
  SteadyStateService,
  SyncError,
  SyncRunner,
} from "@mail-hub/sync";

/** The queue that drives one synchronization cycle across every account. */
const SYNC_CYCLE_QUEUE = "sync.cycle";

/** How often a cycle runs. Overridable for tests and slow deployments. */
const DEFAULT_SYNC_CYCLE_CRON = "*/30 * * * * *";

/** Durable originals live under this root (SPEC section 8). */
const DEFAULT_STORAGE_ROOT = "data/storage";

const connectionString = process.env.DATABASE_URL;

if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

async function main(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  const db = createDatabase(pool);
  const controls = new RecoveryControls(db, {
    deploymentGeneration: process.env.RECOVERY_GENERATION,
  });

  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());

  // Startup control check (SPEC section 10, step 2): stay blocked without
  // crashing, so workers resume without a restart once recovery completes.
  let lastReportedState: string | undefined;
  let ready: ReadyStatus;
  try {
    ready = await waitForReadyService(controls, {
      intervalMs: 5000,
      signal: shutdown.signal,
      onStatus: (status) => {
        if (status.state !== lastReportedState) {
          lastReportedState = status.state;
          console.warn(`Workers blocked: ${describeControlStatus(status)}.`);
        }
      },
    });
  } catch {
    // Shutdown was requested while blocked.
    await pool.end();
    return;
  }

  const queue = createJobQueue(databaseUrl);
  await queue.start();
  console.log(`Recovery control state is ready (generation ${ready.generation}). Job queue started.`);

  // Sync opens stored mailbox credentials, which only CREDENTIALS_KEY seals
  // (SPEC section 9). Without it the worker stays up but runs no cycles.
  const credentialsKey = parseCredentialsKey(process.env.CREDENTIALS_KEY);
  if (credentialsKey === null) {
    console.warn(
      "CREDENTIALS_KEY must hold 32 bytes as base64 or hex. Synchronization stays closed until it is set.",
    );
    return;
  }

  const storage = createStorage(process.env.STORAGE_ROOT ?? DEFAULT_STORAGE_ROOT);
  const accounts = new AccountService(db, createCredentialCipher(credentialsKey), controls);
  const ingestion = new IngestionService(db, storage);
  const backfill = new BackfillService(db);
  const bodies = new BodyFetchService(db, ingestion);
  const steady = new SteadyStateService(db);
  const reconcile = new ReconciliationService(db);
  const runner = new SyncRunner(db, backfill, bodies, steady, reconcile);
  const sessions = new ImapMailboxSessionFactory();

  await queue.createQueue(SYNC_CYCLE_QUEUE);
  await queue.work<{ generation: string }>(SYNC_CYCLE_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0];
    if (job === undefined) {
      return;
    }
    // A job keeps the generation it was created with (SPEC section 7). Stale
    // jobs never execute; blocked ones fail so the queue retries after
    // recovery settles.
    const assessment = assessJob(await controls.readStatus(), job.data.generation);
    if (assessment === "stale") {
      console.warn(`Discarded a ${SYNC_CYCLE_QUEUE} job from generation ${job.data.generation}.`);
      return;
    }
    if (assessment === "blocked") {
      throw new Error(`Recovery control state is not ready; the ${SYNC_CYCLE_QUEUE} job will retry.`);
    }

    for (const account of await accounts.listAccounts()) {
      if (shutdown.signal.aborted) {
        break;
      }
      await runAccountCycle(accounts, runner, sessions, account.id, shutdown.signal);
    }
  });

  await armSchedule(queue, ready.generation);
  console.log(`Synchronization cycles scheduled (${process.env.SYNC_CYCLE_CRON ?? DEFAULT_SYNC_CYCLE_CRON}).`);

  const stop = async () => {
    shutdown.abort();
    await queue.stop();
    await pool.end();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

/**
 * Run one bounded cycle for one account over one connection (SPEC F2). A
 * mailbox failure is logged without credentials or content and never stops
 * the accounts that follow.
 */
async function runAccountCycle(
  accounts: AccountService,
  runner: SyncRunner,
  sessions: ImapMailboxSessionFactory,
  accountId: string,
  signal: AbortSignal,
): Promise<void> {
  let session;
  try {
    const credentials = await accounts.resolveCredentials(accountId);
    session = await sessions.open({
      host: credentials.imap.host,
      port: credentials.imap.port,
      username: credentials.username,
      password: credentials.password,
    });
    const summary = await runner.runAccountCycle(session, accountId, { signal });
    console.log(
      `Sync cycle for account ${accountId}: ${summary.folders} folders, ${summary.batches} batches, ` +
        `${summary.imported} imported, ${summary.bodiesFetched} bodies fetched, ` +
        `${summary.generationChanges} generation changes.`,
    );
  } catch (cause) {
    const detail = cause instanceof SyncError ? cause.message : "unexpected failure";
    console.error(`Sync cycle for account ${accountId} failed: ${detail}`);
  } finally {
    await session?.logout().catch(() => undefined);
  }
}

/**
 * Schedule cycles under the current generation. A schedule from an earlier
 * generation would only produce stale jobs, so replace it (SPEC section 7).
 */
async function armSchedule(queue: ReturnType<typeof createJobQueue>, generation: string): Promise<void> {
  const cron = process.env.SYNC_CYCLE_CRON ?? DEFAULT_SYNC_CYCLE_CRON;
  const existing = await queue.getSchedule(SYNC_CYCLE_QUEUE);
  if (existing !== null) {
    const scheduled = (existing.data as { generation?: string } | null)?.generation;
    if (scheduled === generation && existing.cron === cron) {
      return;
    }
    await queue.unschedule(SYNC_CYCLE_QUEUE);
  }
  await queue.schedule(SYNC_CYCLE_QUEUE, cron, { generation });
}

await main(connectionString);
