import { readFile } from "node:fs/promises";
import {
  ClassificationError,
  evaluateClassification,
  parseClassificationLabels,
  readRoutingState,
  recordClassificationGate,
  type ClassificationEvaluation,
} from "@mail-hub/classification";
import { createDatabase, createPool } from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";

/**
 * The classification evaluation command (SPEC section 12):
 *
 *   npm run eval:classify -- --labels <file.jsonl>
 *
 * The label file holds one JSON object per line — `messageId`, `class`, and
 * an optional `asksAction` — over 100 to 200 of the owner's own messages.
 * The command measures the stored answers against those labels and records
 * the routing verdict durably: routing may be enabled only when the labeled
 * set holds zero critical false negatives. Until then, shadow mode.
 */

const USAGE = `Usage: npm run eval:classify -- --labels <file.jsonl>

Measures stored classification answers against a hand-labeled set and
records the routing verdict. Each label line is one JSON object:
  {"messageId": "<uuid>", "class": "<message class>", "asksAction": true}

The exit code is 0 when the gate passes and 1 when it does not.
`;

interface AdminEnvironment {
  DATABASE_URL?: string;
  RECOVERY_GENERATION?: string;
}

/** Where the command writes. Injectable so tests capture output. */
export interface EvalClassifyIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const STANDARD_IO: EvalClassifyIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Run one evaluation. Returns the process exit code. */
export async function runEvalClassify(
  args: string[],
  env: AdminEnvironment = process.env,
  io: EvalClassifyIO = STANDARD_IO,
): Promise<number> {
  const labelsPath = parseArguments(args);
  if (labelsPath === null) {
    io.stdout(USAGE);
    return 1;
  }

  let labelText: string;
  try {
    labelText = await readFile(labelsPath, "utf8");
  } catch (error) {
    io.stderr(`The label file could not be read: ${(error as NodeJS.ErrnoException).code ?? "error"}.\n`);
    return 1;
  }
  let labels;
  try {
    labels = parseClassificationLabels(labelText);
  } catch (error) {
    if (!(error instanceof ClassificationError)) {
      throw error;
    }
    io.stderr(`${error.message}\n`);
    return 1;
  }

  const connectionString = env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    io.stderr("DATABASE_URL must be set.\n");
    return 1;
  }

  const pool = createPool(connectionString);
  try {
    const db = createDatabase(pool);
    const controls = new RecoveryControls(db, { deploymentGeneration: env.RECOVERY_GENERATION });
    const generation = controls.deploymentGeneration;
    if (generation === null) {
      io.stderr("RECOVERY_GENERATION must be set to a UUID.\n");
      return 1;
    }

    let evaluation;
    try {
      const before = await readRoutingState(db);
      evaluation = await evaluateClassification(db, labels);
      writeReport(io, evaluation);
      io.stdout(
        `Routing before this run: ${before.routingEnabled ? "enabled" : "shadow mode"}.\n` +
          `Gate: ${evaluation.gate.description}\n`,
      );
    } catch (error) {
      if (error instanceof ClassificationError) {
        io.stderr(`${error.message}\n`);
        return 1;
      }
      io.stderr(`The evaluation could not read the database: ${(error as Error).message}\n`);
      return 1;
    }

    try {
      await recordClassificationGate(db, controls, generation, evaluation);
    } catch (error) {
      if (!(error instanceof RecoveryBlockedError)) {
        throw error;
      }
      io.stderr(`${error.message}\n`);
      return 1;
    }
    const after = await readRoutingState(db);
    io.stdout(
      after.routingEnabled
        ? "Recorded the verdict: routing is enabled. Bundling may now act on suggestions.\n"
        : "Recorded the verdict: routing stays off. Classification stays in shadow mode.\n",
    );
    return after.routingEnabled ? 0 : 1;
  } finally {
    await pool.end();
  }
}

/** Read `--labels <path>` from the command line, or `null` when unusable. */
function parseArguments(args: string[]): string | null {
  let labelsPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--labels") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        return null;
      }
      labelsPath = value;
      index += 1;
      continue;
    }
    return null;
  }
  return labelsPath;
}

/** Print the measurement, most signal first. */
function writeReport(io: EvalClassifyIO, evaluation: ClassificationEvaluation): void {
  io.stdout(
    `Classification evaluation\n` +
      `Labeled: ${evaluation.labeled} message(s).\n` +
      `Answered: ${evaluation.answered} (coverage ${(evaluation.coverage * 100).toFixed(1)}%).\n` +
      `Answered by: manual ${evaluation.bySource.manual}, override ${evaluation.bySource.override}, ` +
      `rule ${evaluation.bySource.rule}, jev ${evaluation.bySource.jev}.\n` +
      `Critical false negatives: ${evaluation.criticalFalseNegatives.length}\n`,
  );
  for (const miss of evaluation.criticalFalseNegatives) {
    io.stdout(
      `  ${miss.messageId} (${miss.sender ?? "no sender"}): labeled ${miss.labeledClassHint}` +
        `${miss.labeledAsksAction ? " asking action" : ""}, suggested ${miss.suggestedClassHint}` +
        ` (${miss.source ?? "unknown source"}).\n`,
    );
  }
  io.stdout("Correction rate per sender:\n");
  for (const sender of evaluation.senders) {
    io.stdout(
      `  ${sender.sender === "" ? "(no sender address)" : sender.sender}: ` +
        `${sender.corrections} correction(s) over ${sender.labeled} labeled, ` +
        `${sender.answered} answered.\n`,
    );
  }
}

const exitCode = await runEvalClassify(process.argv.slice(2));
process.exitCode = exitCode;
