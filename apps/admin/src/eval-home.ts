import { readFile } from "node:fs/promises";
import { ClassificationService } from "@mail-hub/classification";
import { createDatabase, createPool } from "@mail-hub/database";
import {
  evaluateHome,
  HomeError,
  HomeService,
  parseHomeLabels,
  type HomeEvaluation,
} from "@mail-hub/home";
import type { MutationGate } from "@mail-hub/recovery";
import { SettingsService } from "@mail-hub/settings";

/**
 * The Home selection evaluation command (SPEC F13, plan step 7):
 *
 *   npm run eval:home -- --labels <file.jsonl>
 *
 * The label file holds one JSON object per line — `messageId`, `class`, and
 * any of `asksAction`, `asksReply`, and `timeSensitive` — over mail the owner
 * read themselves. The command measures what the Home overview surfaces
 * against those labels and prints the numbers. It records no verdict and
 * touches no owner data: Home stays advisory whatever these numbers say, so
 * nothing is written anywhere. This run is separate from the routing gate;
 * a passed routing gate is not proof of Home quality.
 */

const USAGE = `Usage: npm run eval:home -- --labels <file.jsonl>

Measures what the Home overview surfaces against a hand-labeled set.
Each label line is one JSON object:
  {"messageId": "<uuid>", "class": "<message class>", "asksAction": true}

The exit code is 0 when nothing unexplained is missing and nothing
routine was suggested, and 1 otherwise. Nothing is recorded anywhere.
`;

interface AdminEnvironment {
  DATABASE_URL?: string;
}

/** Where the command writes. Injectable so tests capture output. */
export interface EvalHomeIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const STANDARD_IO: EvalHomeIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** The gate the evaluation never reaches: it performs no mutation. */
const READ_ONLY_GATE: MutationGate = {
  async gateMutation(): Promise<{ generation: string }> {
    throw new Error("The Home evaluation never mutates; the gate is never reached.");
  },
};

/** Run one Home evaluation. Returns the process exit code. */
export async function runEvalHome(
  args: string[],
  env: AdminEnvironment = process.env,
  io: EvalHomeIO = STANDARD_IO,
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
    labels = parseHomeLabels(labelText);
  } catch (error) {
    if (!(error instanceof HomeError)) {
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
    const settings = new SettingsService(db, READ_ONLY_GATE);
    const circuit = new ClassificationService(db, { settings, adapter: null });
    const service = new HomeService(db, READ_ONLY_GATE, { settings, circuit });

    let evaluation;
    try {
      evaluation = await evaluateHome(db, service, labels);
    } catch (error) {
      if (error instanceof HomeError) {
        io.stderr(`${error.message}\n`);
        return 1;
      }
      io.stderr(`The evaluation could not read the database: ${(error as Error).message}\n`);
      return 1;
    }

    writeReport(io, evaluation);
    io.stdout(
      evaluation.passed
        ? "Home stays advisory: nothing is recorded, and nothing unexplained is missing.\n"
        : "Home stays advisory: nothing is recorded. Read the misses above before trusting the overview.\n",
    );
    return evaluation.passed ? 0 : 1;
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
function writeReport(io: EvalHomeIO, evaluation: HomeEvaluation): void {
  const coverage =
    evaluation.importantAnswered === 0
      ? "no answered important mail to cover"
      : `${((evaluation.importantPresent / evaluation.importantAnswered) * 100).toFixed(1)}% of answered important mail`;
  io.stdout(
    `Home evaluation\n` +
      `Labeled: ${evaluation.labeled} message(s); ${evaluation.answered} carry a stored answer.\n` +
      `Important by the labels: ${evaluation.importantLabeled} (${evaluation.importantAnswered} answered).\n` +
      `Held by the attention sections: ${evaluation.importantPresent} — ${coverage}.\n` +
      `Found beyond the first page: ${evaluation.importantBeyondFirstPage} (page limit ${evaluation.pageLimit}).\n` +
      `Attention rows the walk collected: ${evaluation.attentionRows}.\n` +
      `Misses: ${evaluation.attentionMisses.length}; routine suggestions: ${evaluation.routineSuggestions.length}.\n` +
      `Important with no stored answer: ${evaluation.importantUnanswered.length} (the blind spot the coverage line names).\n`,
  );
  for (const miss of evaluation.attentionMisses) {
    io.stdout(
      `  Miss ${miss.messageId} (${miss.sender ?? "no sender"}): ${miss.status}. ` +
        `Labeled ${miss.labeled.classHint}` +
        `${miss.labeled.asksAction ? " asking action" : ""}` +
        `${miss.labeled.asksReply ? " asking reply" : ""}` +
        `${miss.labeled.timeSensitive ? " time sensitive" : ""}; ` +
        `stored ${miss.stored.classHint ?? "no class"}. ${explainMiss(miss.status)}\n`,
    );
  }
  for (const suggestion of evaluation.routineSuggestions) {
    io.stdout(
      `  Routine suggestion ${suggestion.messageId} (${suggestion.sender ?? "no sender"}): ` +
        `labeled ${suggestion.labeledClassHint}, stored ${suggestion.storedClassHint ?? "no class"}, ` +
        `reasons ${suggestion.reasonCodes.join(", ")}.\n`,
    );
  }
  for (const unanswered of evaluation.importantUnanswered) {
    io.stdout(
      `  No stored answer ${unanswered.messageId} (${unanswered.sender ?? "no sender"}): ` +
        `Home cannot suggest it; classification has not reached it.\n`,
    );
  }
}

/** The one-line meaning of a miss status. */
function explainMiss(status: "dismissed" | "outside_inbox" | "no_attention_signal"): string {
  switch (status) {
    case "dismissed":
      return "You dismissed it; the absence is your choice.";
    case "outside_inbox":
      return "It sits outside the inbox; the scope excludes it.";
    case "no_attention_signal":
      return "No stored answer explains the absence; this is the defect.";
  }
}

const exitCode = await runEvalHome(process.argv.slice(2));
process.exitCode = exitCode;
