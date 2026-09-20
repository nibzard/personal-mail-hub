import { createDatabase, createPool, type MailHubDatabase } from "@mail-hub/database";
import {
  RecoveryControls,
  describeControlStatus,
  type BeginOutcome,
  type CompleteOutcome,
  type InitializeOutcome,
} from "@mail-hub/recovery";
import { AuthError, ConsoleAuthService, createRecoveryHooks } from "@mail-hub/auth";
import { ActionService, type ActionExecutor, type ActionMailbox } from "@mail-hub/actions";

/**
 * The operator command line (SPEC sections 9 and 10). Run it inside the app
 * container: `npm run admin -- recovery status` or `npm run admin -- auth
 * bootstrap`. Enrollment tokens print once, to this terminal only.
 */

const USAGE = `Usage: npm run admin -- <command>

Commands:
  recovery status        Show the recovery control state.
  recovery init          Initialize control state on a fresh installation.
  recovery begin         Record the deployment generation and enter reconciling.
  recovery complete      Finish recovery and reopen normal work.
  recovery hold-actions  Hold restored actions so recovery can complete.
  auth bootstrap         Issue the first-passkey enrollment token.
  auth recover           Revoke all access and issue a replacement token.
`;

interface AdminEnvironment {
  DATABASE_URL?: string;
  RECOVERY_GENERATION?: string;
  BASE_URL?: string;
}

/** Run one admin command. Returns the process exit code. */
export async function runAdminCommand(args: string[], env: AdminEnvironment = process.env): Promise<number> {
  const [group, command] = args;
  if ((group !== "recovery" && group !== "auth") || command === undefined) {
    process.stdout.write(USAGE);
    return 1;
  }
  if (args.length > 2) {
    // Extra arguments used to be ignored, so a typo after the command ran
    // the command anyway. Reject what the CLI never understood.
    process.stderr.write(`Unknown argument(s): ${args.slice(2).join(" ")}\n\n`);
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
    const db = createDatabase(pool);
    const controls = new RecoveryControls(db, {
      deploymentGeneration: env.RECOVERY_GENERATION,
      hooks: createRecoveryHooks(),
    });
    if (group === "recovery") {
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
        case "hold-actions":
          return runHoldActions(db, controls);
        default:
          process.stdout.write(USAGE);
          return 1;
      }
    }

    const consoleAuth = new ConsoleAuthService(db, controls);
    switch (command) {
      case "bootstrap":
        return printGrant(await consoleAuth.issueBootstrapGrant(), env, "first passkey");
      case "recover":
        return printGrant(await consoleAuth.issueRecoveryGrant(), env, "replacement passkey");
      default:
        process.stdout.write(USAGE);
        return 1;
    }
  } catch (error) {
    if (error instanceof AuthError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

function printGrant(
  grant: { token: string; expiresAt: Date },
  env: AdminEnvironment,
  kind: string,
): number {
  const where = env.BASE_URL === undefined || env.BASE_URL === "" ? "the setup form" : `the setup form at ${env.BASE_URL}`;
  process.stdout.write(
    `Enrollment token for the ${kind} (expires ${grant.expiresAt.toISOString()}):\n` +
      `\n  ${grant.token}\n` +
      "\nPaste this token into " +
      where +
      ". Never put it in a URL.\n" +
      "This is the only time the token is shown; only its hash is stored.\n",
  );
  return 0;
}

async function runStatus(controls: RecoveryControls): Promise<void> {
  process.stdout.write(`${describeControlStatus(await controls.readStatus())}\n`);
}

/**
 * Disposition the actions a restore left behind (SPEC section 10, step 5):
 * old queued items become conflicted, old executing items unknown. The
 * operator reviews them; nothing replays across a generation.
 */
async function runHoldActions(db: MailHubDatabase, controls: RecoveryControls): Promise<number> {
  const status = await controls.readStatus();
  if (status.state !== "reconciling" && status.state !== "ready") {
    process.stderr.write("Control state holds no generation. Run 'recovery init' or 'recovery begin' first.\n");
    return 1;
  }
  const service = new ActionService(db, controls, HOLD_ONLY_EXECUTOR);
  const summary = await service.dispositionRestoredActions(status.generation);
  process.stdout.write(
    `Held restored actions: ${summary.actions} ` +
      `(${summary.conflicted} conflicted, ${summary.unknown} unknown). Run 'recovery complete'.\n`,
  );
  return 0;
}

/** The hold path only disposition rows; an executor call here is a defect. */
const HOLD_ONLY_EXECUTOR: ActionExecutor<ActionMailbox> = {
  async apply() {
    throw new Error("Holding restored actions must not execute an item.");
  },
};

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
