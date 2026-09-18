import { createDatabase, createJobQueue, createPool } from "@mail-hub/database";
import {
  RecoveryControls,
  describeControlStatus,
  waitForReadyService,
  type ReadyStatus,
} from "@mail-hub/recovery";

const connectionString = process.env.DATABASE_URL;

if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required to start the worker.");
}

async function main(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  const controls = new RecoveryControls(createDatabase(pool), {
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

  const stop = async () => {
    shutdown.abort();
    await queue.stop();
    await pool.end();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

await main(connectionString);
