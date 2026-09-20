import { parseCredentialsKey, createCredentialCipher, AccountService } from "@mail-hub/accounts";
import { ActionService, TwoWayActionExecutor } from "@mail-hub/actions";
import { ClassificationService, jevAdapterFromEnv } from "@mail-hub/classification";
import {
  createDatabase,
  createJobQueue,
  createPool,
  createStorage,
  sweepTempFiles,
  TEMP_FILE_STALE_MS,
} from "@mail-hub/database";
import { IngestionService } from "@mail-hub/ingestion";
import {
  RecoveryControls,
  assessJob,
  describeControlStatus,
  waitForReadyService,
  type ReadyStatus,
} from "@mail-hub/recovery";
import { OutboundService } from "@mail-hub/send";
import { SettingsService } from "@mail-hub/settings";
import { submitSmtpMessage } from "@mail-hub/transport";
import {
  BackfillService,
  BodyFetchService,
  ImapMailboxSessionFactory,
  ReconciliationService,
  SteadyStateService,
  SyncError,
  SyncRunner,
  ThreadService,
} from "@mail-hub/sync";

/** The queue that drives one synchronization cycle across every account. */
const SYNC_CYCLE_QUEUE = "sync.cycle";

/** How often a cycle runs. Overridable for tests and slow deployments. */
const DEFAULT_SYNC_CYCLE_CRON = "*/30 * * * * *";

/** The queue that sweeps queued outbound snapshots into SMTP submissions. */
const SEND_CYCLE_QUEUE = "send.cycle";

/** How often queued sends are claimed. Overridable for tests and slow deployments. */
const DEFAULT_SEND_CYCLE_CRON = "*/5 * * * * *";

/** The queue that runs the separate Sent-copy append and reconciliation job. */
const SENT_COPY_CYCLE_QUEUE = "send.sent-copy-cycle";

/** How often due Sent copies and unknown outcomes are reconciled. */
const DEFAULT_SENT_COPY_CYCLE_CRON = "*/15 * * * * *";

/** The queue that classifies fetched messages in shadow mode (SPEC F8). */
const CLASSIFY_CYCLE_QUEUE = "classify.cycle";

/** How often pending classifications run. Overridable for tests. */
const DEFAULT_CLASSIFY_CYCLE_CRON = "*/60 * * * * *";

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
  // (SPEC section 9). Without it no cycle can run, and an idle process with
  // no workers or schedules ignores SIGTERM: its handlers only abort a
  // controller nothing reads, so the entrypoint wait hangs until SIGKILL.
  // Tear the queue and pool down and exit non-zero instead.
  const credentialsKey = parseCredentialsKey(process.env.CREDENTIALS_KEY);
  if (credentialsKey === null) {
    console.warn(
      "CREDENTIALS_KEY must hold 32 bytes as base64 or hex. The worker exits instead of running no cycles.",
    );
    await queue.stop();
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const storageRoot = process.env.STORAGE_ROOT ?? DEFAULT_STORAGE_ROOT;
  const storage = createStorage(storageRoot);
  // Crash recovery for the storage tree: a killed write leaves its temp
  // file behind, the durable tree keeps it, and the nightly backup would
  // copy the debris. The staleness bound protects temp files the API
  // process may still be filling, so the sweep repeats hourly and collects
  // whatever a restart found too fresh.
  const sweptAtStartup = await sweepTempFiles(storageRoot);
  if (sweptAtStartup > 0) {
    console.log(`Cleared ${sweptAtStartup} temp file(s) that a crashed write left behind.`);
  }
  const tempSweep = setInterval(() => {
    void sweepTempFiles(storageRoot).then(
      (removed) => {
        if (removed > 0) {
          console.log(`Cleared ${removed} temp file(s) that a crashed write left behind.`);
        }
      },
      (cause) => {
        console.error(`Storage temp sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      },
    );
  }, TEMP_FILE_STALE_MS);
  tempSweep.unref();
  const accounts = new AccountService(db, createCredentialCipher(credentialsKey), controls);
  const ingestion = new IngestionService(db, storage);

  // Shadow-mode classification (SPEC F8). Without TYPE_SAFE_API_KEY the
  // adapter stays null and the cycle reports itself unconfigured; mail
  // synchronization and sending never wait on it either way.
  const settings = new SettingsService(db, controls);
  const classification = new ClassificationService(db, {
    settings,
    adapter: jevAdapterFromEnv(process.env),
  });
  const backfill = new BackfillService(db);
  const bodies = new BodyFetchService(db, ingestion);
  const threads = new ThreadService(db);
  const steady = new SteadyStateService(db);
  const reconcile = new ReconciliationService(db);
  const runner = new SyncRunner(db, backfill, bodies, threads, steady, reconcile);
  const sessions = new ImapMailboxSessionFactory();
  // Two-way writes ride the same verified connection the sync cycle opens
  // (SPEC F4 and section 7, step 6): pending actions re-drive per account,
  // every target refreshed before any replay.
  const actions = new ActionService(db, controls, new TwoWayActionExecutor());
  // Outbound submissions use the same stored credentials the sync cycles open
  // (SPEC F7 step 3). The atomic claim inside the service is what enforces
  // one submission per snapshot; this schedule only sweeps.
  const outbound = new OutboundService(db, storage, controls, {
    submit: submitSmtpMessage,
    resolveCredentials: async (accountId) => {
      const credentials = await accounts.resolveCredentials(accountId);
      return {
        host: credentials.smtp.host,
        port: credentials.smtp.port,
        security: credentials.smtp.security,
        username: credentials.username,
        password: credentials.password,
      };
    },
    // The Sent-copy job rides one verified IMAP connection per account, the
    // same way the sync cycles open theirs (SPEC F7 step 5).
    openSentCopy: async (accountId) => {
      const credentials = await accounts.resolveCredentials(accountId);
      return sessions.open({
        host: credentials.imap.host,
        port: credentials.imap.port,
        username: credentials.username,
        password: credentials.password,
      });
    },
  });

  // Startup recovery (SPEC F7): hold the attempts a crash left behind as
  // unknown before any cycle runs, so nothing is replayed blindly. The send
  // and Sent-copy cycles repeat the same pass under the attempt lease, so a
  // crash between restarts also resolves.
  const logRecoveredAttempts = async (cycle: string): Promise<void> => {
    const abandoned = await outbound.recoverAbandonedAttempts();
    if (abandoned.blocked) {
      console.warn(`${cycle}: attempt recovery is blocked by the control state; nothing was replayed.`);
      return;
    }
    if (abandoned.heldSends > 0 || abandoned.heldAppends > 0) {
      console.log(
        `${cycle}: held ${abandoned.heldSends} expired submission(s) and ` +
          `${abandoned.heldAppends} expired append(s) as unknown.`,
      );
    }
  };
  const abandoned = await outbound.recoverAbandonedAttempts();
  if (abandoned.blocked) {
    console.warn("Startup recovery is blocked by the control state; no attempt was replayed.");
  } else if (abandoned.heldSends > 0 || abandoned.heldAppends > 0) {
    console.log(
      `Startup recovery held ${abandoned.heldSends} abandoned submission(s) and ` +
        `${abandoned.heldAppends} abandoned append(s) as unknown.`,
    );
  }

  await ensureExclusiveQueue(queue, SYNC_CYCLE_QUEUE);
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
      await runAccountCycle(accounts, runner, actions, sessions, account.id, shutdown.signal);
    }
  });

  await queue.createQueue(SEND_CYCLE_QUEUE);
  await queue.work<{ generation: string }>(SEND_CYCLE_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0];
    if (job === undefined) {
      return;
    }
    const assessment = assessJob(await controls.readStatus(), job.data.generation);
    if (assessment === "stale") {
      console.warn(`Discarded a ${SEND_CYCLE_QUEUE} job from generation ${job.data.generation}.`);
      return;
    }
    if (assessment === "blocked") {
      throw new Error(`Recovery control state is not ready; the ${SEND_CYCLE_QUEUE} job will retry.`);
    }

    // Recovery runs every cycle, not only at startup: the attempt lease
    // makes a hold safe while submissions are live, so a crashed worker's
    // rows resolve without waiting for the next restart.
    await logRecoveredAttempts("Send cycle");
    const summary = await outbound.executeQueued();
    if (summary.submitted > 0 || summary.skippedStale > 0 || summary.rowErrors > 0) {
      console.log(
        `Send cycle: ${summary.submitted} submitted, ${summary.skippedStale} held for reconciliation` +
          (summary.rowErrors > 0
            ? `, ${summary.rowErrors} attempt(s) errored and keep their claims until the lease expires.`
            : "."),
      );
    }
  });

  await queue.createQueue(SENT_COPY_CYCLE_QUEUE);
  await queue.work<{ generation: string }>(SENT_COPY_CYCLE_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0];
    if (job === undefined) {
      return;
    }
    const assessment = assessJob(await controls.readStatus(), job.data.generation);
    if (assessment === "stale") {
      console.warn(`Discarded a ${SENT_COPY_CYCLE_QUEUE} job from generation ${job.data.generation}.`);
      return;
    }
    if (assessment === "blocked") {
      throw new Error(`Recovery control state is not ready; the ${SENT_COPY_CYCLE_QUEUE} job will retry.`);
    }

    // The Sent-copy job never touches SMTP: it appends stored bytes and
    // reconciles uncertain outcomes from durable evidence alone (SPEC F7
    // steps 5 and 7).
    await logRecoveredAttempts("Sent-copy cycle");
    const copies = await outbound.appendDueSentCopies();
    if (copies.attempted > 0 || copies.skippedStale > 0 || copies.rowErrors > 0) {
      console.log(
        `Sent-copy cycle: ${copies.attempted} attempted, ${copies.skippedStale} held for reconciliation` +
          (copies.rowErrors > 0 ? `, ${copies.rowErrors} attempt(s) errored and keep their claims.` : "."),
      );
    }
    const unknown = await outbound.reconcileUnknownOutcomes();
    if (unknown.resolved > 0 || unknown.rowErrors > 0) {
      console.log(
        `Sent-copy cycle: ${unknown.resolved} unknown outcome(s) resolved from server evidence` +
          (unknown.rowErrors > 0 ? `, ${unknown.rowErrors} pass(es) errored.` : "."),
      );
    }
  });

  await queue.createQueue(CLASSIFY_CYCLE_QUEUE);
  await queue.work<{ generation: string }>(CLASSIFY_CYCLE_QUEUE, { batchSize: 1 }, async (jobs) => {
    const job = jobs[0];
    if (job === undefined) {
      return;
    }
    const assessment = assessJob(await controls.readStatus(), job.data.generation);
    if (assessment === "stale") {
      console.warn(`Discarded a ${CLASSIFY_CYCLE_QUEUE} job from generation ${job.data.generation}.`);
      return;
    }
    if (assessment === "blocked") {
      throw new Error(`Recovery control state is not ready; the ${CLASSIFY_CYCLE_QUEUE} job will retry.`);
    }

    // Classification failures never fail the queue: the service records a
    // `class.error` event per failure and the circuit breaker opens from
    // those, so a broken endpoint pauses suggestions without a retry storm.
    const summary = await classification.runCycle();
    if (summary.classified > 0) {
      console.log(
        `Classify cycle: ${summary.classified} answered ` +
          `(manual ${summary.bySource.manual}, override ${summary.bySource.override}, ` +
          `rule ${summary.bySource.rule}, jev ${summary.bySource.jev}).`,
      );
    } else if (summary.skipped === "circuit_open" || summary.skipped === "cost_cap") {
      console.warn(`Classify cycle paused (${summary.skipped}).`);
    }
  });

  const syncCycleCron = cycleCron("SYNC_CYCLE_CRON", DEFAULT_SYNC_CYCLE_CRON);
  const sendCycleCron = cycleCron("SEND_CYCLE_CRON", DEFAULT_SEND_CYCLE_CRON);
  const sentCopyCycleCron = cycleCron("SENT_COPY_CYCLE_CRON", DEFAULT_SENT_COPY_CYCLE_CRON);
  const classifyCycleCron = cycleCron("CLASSIFY_CYCLE_CRON", DEFAULT_CLASSIFY_CYCLE_CRON);
  await armSchedule(queue, ready.generation, SYNC_CYCLE_QUEUE, syncCycleCron);
  console.log(`Synchronization cycles scheduled (${syncCycleCron}).`);
  await armSchedule(queue, ready.generation, SEND_CYCLE_QUEUE, sendCycleCron);
  console.log(`Send cycles scheduled (${sendCycleCron}).`);
  await armSchedule(queue, ready.generation, SENT_COPY_CYCLE_QUEUE, sentCopyCycleCron);
  console.log(`Sent-copy cycles scheduled (${sentCopyCycleCron}).`);
  await armSchedule(queue, ready.generation, CLASSIFY_CYCLE_QUEUE, classifyCycleCron);
  console.log(`Classify cycles scheduled (${classifyCycleCron}).`);

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
  actions: ActionService,
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
    // Queued mail actions re-drive on the connection the sync just used,
    // after it refreshed every occurrence the sync saw (SPEC section 7,
    // step 6). Receipts land per item; a held or stale action keeps its row
    // for the restore disposition instead of replaying blindly.
    const actionSummary = await actions.reconcileIncomplete(accountId, session);
    if (actionSummary.executed > 0 || actionSummary.held > 0 || actionSummary.generationMismatch > 0) {
      console.log(
        `Action cycle for account ${accountId}: ${actionSummary.executed} executed, ` +
          `${actionSummary.held} held for recovery, ${actionSummary.generationMismatch} stale.`,
      );
    }
  } catch (cause) {
    const detail = cause instanceof SyncError ? cause.message : "unexpected failure";
    console.error(`Sync cycle for account ${accountId} failed: ${detail}`);
  } finally {
    await session?.logout().catch(() => undefined);
  }
}

/**
 * Read one optional schedule override; a blank value keeps the default.
 * Deployment files pass the variables through unset (an empty string after
 * interpolation), and an empty expression schedules every minute, so blank
 * must never reach the scheduler.
 */
function cycleCron(name: string, fallback: string): string {
  const override = process.env[name]?.trim();
  return override ? override : fallback;
}

/**
 * Create the sync cycle queue under the `exclusive` policy, which admits at
 * most one queued or active job. While a cycle is in flight, the schedule's
 * next tick is dropped instead of queued, so a cycle slower than the tick
 * (the initial backfill over many accounts) cannot pile up thousands of
 * redundant jobs and run them back to back once it finishes.
 *
 * createQueue leaves an existing queue row alone, and the policy column
 * cannot be updated through the queue API, so a queue from an earlier
 * deployment is deleted and recreated. The queued jobs that deletion drops
 * are exactly the backlog this policy exists to prevent.
 */
async function ensureExclusiveQueue(
  queue: ReturnType<typeof createJobQueue>,
  name: string,
): Promise<void> {
  const existing = await queue.getQueue(name);
  if (existing !== null && existing.policy === "exclusive") {
    return;
  }
  if (existing !== null) {
    await queue.deleteQueue(name);
  }
  await queue.createQueue(name, { policy: "exclusive" });
}

/**
 * Schedule one cycle queue under the current generation. A schedule from an
 * earlier generation would only produce stale jobs, so replace it (SPEC
 * section 7).
 */
async function armSchedule(
  queue: ReturnType<typeof createJobQueue>,
  generation: string,
  queueName: string,
  cron: string,
): Promise<void> {
  const existing = await queue.getSchedule(queueName);
  if (existing !== null) {
    const scheduled = (existing.data as { generation?: string } | null)?.generation;
    if (scheduled === generation && existing.cron === cron) {
      return;
    }
    await queue.unschedule(queueName);
  }
  await queue.schedule(queueName, cron, { generation });
}

await main(connectionString);
