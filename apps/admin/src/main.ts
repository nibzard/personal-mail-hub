import { createDatabase, createPool } from "@mail-hub/database";
import {
  RecoveryControls,
  describeControlStatus,
  type BeginOutcome,
  type CompleteOutcome,
  type InitializeOutcome,
} from "@mail-hub/recovery";

/**
 * The operator command line for recovery control (SPEC sections 9 and 10).
 * Run it inside the app container: `npm run admin -- recovery status`.
 */

const USAGE = `Usage: npm run admin -- <command>

Commands:
  recovery status     Show the recovery control state.
  recovery init       Initialize control state on a fresh installation.
  recovery begin      Record the deployment generation and enter reconciling.
  recovery complete   Finish recovery and reopen normal work.
`;

interface AdminEnvironment {
  DATABASE_URL?: string;
  RECOVERY_GENERATION?: string;
}

/** Run one admin command. Returns the process exit code. */
export async function runAdminCommand(args: string[], env: AdminEnvironment = process.env): Promise<number> {
  const [group, command] = args;
  if (group !== "recovery" || command === undefined) {
    process.stdout.write(USAGE);
    return 1;
  }

  const connectionString = env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    process.stderr.write("DATABASE_URL must be set.\n");
    return 1;
  }

  const pool = createPool(connectionString);
  try {
    const controls = new RecoveryControls(createDatabase(pool), {
      deploymentGeneration: env.RECOVERY_GENERATION,
    });
    switch (command) {
      case "status":
        await runStatus(controls);
        return 0;
      case "init":
        return printInitialize(await controls.initialize());
      case "begin":
        return printBegin(await controls.beginRecovery());
      case "complete":
        return printComplete(await controls.completeRecovery());
      default:
        process.stdout.write(USAGE);
        return 1;
    }
  } finally {
    await pool.end();
  }
}

async function runStatus(controls: RecoveryControls): Promise<void> {
  process.stdout.write(`${describeControlStatus(await controls.readStatus())}\n`);
}

function printInitialize(outcome: InitializeOutcome): number {
  if (outcome.result === "initialized") {
    process.stdout.write(`Initialized control state: ready (generation ${outcome.generation}).\n`);
    return 0;
  }
  switch (outcome.reason) {
    case "deployment_config_missing":
      process.stderr.write("RECOVERY_GENERATION must be set to a UUID.\n");
      return 1;
    case "already_initialized":
      process.stderr.write("Control state already exists. Use 'recovery begin' after a restore.\n");
      return 1;
    case "database_not_empty":
      process.stderr.write(
        "The database holds mail or queued work. Set a new RECOVERY_GENERATION and run 'recovery begin'.\n",
      );
      return 1;
  }
}

function printBegin(outcome: BeginOutcome): number {
  if (outcome.result === "started") {
    process.stdout.write(
      `Recovery started: reconciling (generation ${outcome.generation}).\n` +
        "Reconcile restored sends and actions, complete passkey recovery, then run 'recovery complete'.\n",
    );
    return 0;
  }
  if (outcome.result === "resumed") {
    process.stdout.write(
      `Recovery resumed: reconciling (generation ${outcome.generation}). Restored credentials were not revoked again.\n`,
    );
    return 0;
  }
  switch (outcome.reason) {
    case "deployment_config_missing":
      process.stderr.write("RECOVERY_GENERATION must be set to a UUID.\n");
      return 1;
    case "already_ready":
      process.stderr.write("The service is already ready for this generation. There is nothing to begin.\n");
      return 1;
  }
}

function printComplete(outcome: CompleteOutcome): number {
  if (outcome.result === "completed") {
    process.stdout.write(
      `Recovery complete: ready (generation ${outcome.generation}). New work may proceed; old jobs remain disabled.\n`,
    );
    return 0;
  }
  switch (outcome.reason) {
    case "deployment_config_missing":
      process.stderr.write("RECOVERY_GENERATION must be set to a UUID.\n");
      return 1;
    case "no_active_recovery":
      process.stderr.write("There is no active recovery to complete.\n");
      return 1;
    case "generation_mismatch":
      process.stderr.write(
        "The deployment generation changed after 'recovery begin'. Set the generation used to begin, or begin again.\n",
      );
      return 1;
    case "owner_missing":
      process.stderr.write("No owner credential is registered. Complete passkey recovery first.\n");
      return 1;
    case "pending_operations":
      process.stderr.write(
        `Undispositioned restored operations: ${outcome.pendingOperations?.actions ?? 0} actions, ` +
          `${outcome.pendingOperations?.outboundMessages ?? 0} outbound sends.\n`,
      );
      return 1;
  }
}

const exitCode = await runAdminCommand(process.argv.slice(2));
process.exitCode = exitCode;
