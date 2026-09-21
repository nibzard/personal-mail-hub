#!/usr/bin/env node
/**
 * Release validation gate (SPEC section 12, "Definition of done for any
 * change").
 *
 * The gate runs, in order:
 *
 * 1. task-files         The task list, its schema, and the plan documents
 *                       it references stay mutually consistent
 *                       (`npm run validate:tasks`, T114).
 * 2. typecheck          `npm run check` in every workspace.
 * 3. migrations         Apply every migration to a scratch database through
 *                       the deployment path (`npm run db:migrate`), verify the
 *                       applied count against the journal, and apply again to
 *                       prove the run is clean when nothing is pending.
 * 4. integration-tests  `npm test` in every workspace with
 *                       `TEST_DATABASE_URL` set, and fail when any workspace
 *                       reports a failed, skipped, or empty run. The skip
 *                       check is what stops a missing test database from
 *                       turning the gate green while the PostgreSQL suites
 *                       quietly skip.
 * 5. action-permissions The action service and API suites, which carry the
 *                       recovery-generation gate, the scope validation, and
 *                       the restore hold.
 * 6. browser-workflows  The `apps/web` end-to-end runner (`test:e2e` or
 *                       `e2e` script) once the interface milestone ships one.
 * 7. interface-checks   The `apps/web` accessibility and visual runner
 *                       (`test:a11y` or `a11y` script) once T033 ships one.
 *
 * Checks 4 and 5 judge a test run by its npm exit status and by the count of
 * per-run vitest summaries, never by the summary text alone: a run that
 * prints a clean summary but exits non-zero (a global-teardown crash, an
 * out-of-memory kill, a failing posttest step) fails, and so does a
 * workspace that the `--if-present` fan-out skips without a summary.
 *
 * Checks 6 and 7 are deferred until their runner exists, because no interface
 * has shipped to validate. A deferred check never passes silently: the verdict
 * lists it, and `--strict` (the mode for cutting a release) fails on it.
 *
 * Every step runs as its own process group and streams its output to the
 * console while it runs (T115): a quiet step prints a heartbeat at least
 * every 30 seconds, so a long check never looks hung. The complete stdout
 * and stderr land in the step's log files as the bytes arrive; only the
 * vitest summary lines (and, for steps that ask for it, a capped capture)
 * stay in memory. Each step carries a timeout — `RELEASE_GATE_STEP_TIMEOUT_MS`
 * overrides the 30-minute default, and `0` disables it. A timeout or an
 * interrupt (Ctrl-C or SIGTERM) tears down the step's whole process tree,
 * and the step resolves only once that tree is gone, so no child the gate
 * spawned outlives its step.
 *
 * Exit status: 0 when every applicable check passed, 1 otherwise (130 or 143
 * when interrupted). The log directory is removed after a passing run and
 * kept after a failing one, so the printed log paths stay inspectable.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The vitest summary lines the test checks judge; everything else is noise. */
const SUMMARY_LINE = /^\s*(Test Files|Tests)\s+\d/;
/**
 * ANSI escape sequences. CI environments set CI=true, and vitest then colors
 * its summary lines even through a pipe; every pattern below reads plain
 * text, so the codes stop where lines enter the gate.
 */
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
/** A hostile ceiling on summary lines held in memory; the log keeps the rest. */
const SUMMARY_LINE_CAP = 10_000;
/** Default per-step timeout: 30 minutes. */
const DEFAULT_STEP_TIMEOUT_MS = 1_800_000;

/**
 * The configured per-step timeout, from RELEASE_GATE_STEP_TIMEOUT_MS. An
 * unset or empty value means the default (`VAR= cmd` clears the override in
 * POSIX shells); `0` disables the timeout outright.
 */
export function stepTimeoutFromEnvironment() {
  const raw = process.env.RELEASE_GATE_STEP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_STEP_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `release gate: RELEASE_GATE_STEP_TIMEOUT_MS must be a non-negative number of milliseconds, not "${raw}".`,
    );
  }
  return value === 0 ? Infinity : value;
}

/**
 * Run one gate step (T115). The command runs detached, in its own process
 * group, so a timeout or an interrupt can take down the whole tree it
 * spawned. Output streams line by line to `out` while the step runs and to
 * the step's log files byte for byte; a quiet step heartbeats through `out`
 * at least every `heartbeatMs`. The exit code alone decides `ok`; output
 * text never does.
 *
 * `signal` (an AbortSignal) kills the tree when aborted — that is how the
 * gate's own SIGINT and SIGTERM reach the running step. The result carries
 * `status` (the exit code, null when the step never exited on its own),
 * `closeSignal` (the signal that ended the child, when one did), `timedOut`,
 * `interrupted`, `spawnError`, `summaryText` (the vitest summary lines), and
 * `stdout` (only for steps that pass `keepStdout`; the capture stops at
 * `captureCapBytes` and flags `truncated`).
 */
export async function runStep(name, command, args, options = {}) {
  const {
    cwd,
    env,
    logDir,
    timeoutMs = stepTimeoutFromEnvironment(),
    heartbeatMs = 30_000,
    killGraceMs = 5_000,
    keepStdout = false,
    captureCapBytes = 8 * 1024 * 1024,
    signal = null,
    out = () => {},
  } = options;
  const logPath = join(logDir, `${name.replace(/[^a-z0-9-]/g, "-")}.log`);
  const errPath = `${logPath}.err`;
  const startedAt = Date.now();
  const stdoutStream = createWriteStream(logPath);
  const stderrStream = createWriteStream(errPath);
  const summaryLines = [];
  let captured = "";
  let truncated = false;
  let stderrBytes = 0;
  let lastOutputAt = startedAt;
  let timedOut = false;
  let interrupted = false;
  let status = null;
  let spawnError = null;
  let killEscalation = null;

  /**
   * Handle one complete output line: forward it, and keep the pieces later
   * checks judge. Only summary lines (and a capped stdout capture) stay in
   * memory; the log file already holds everything. Escape codes come off
   * here, so the echo, the summaries, and the captures all read plain text
   * on every host; the log files keep the raw bytes.
   */
  const handleLine = (rawLine, isStdout) => {
    const line = rawLine.replace(ANSI_ESCAPE, "");
    out({ kind: "line", stream: isStdout ? "stdout" : "stderr", name, text: line });
    if (!isStdout) {
      return;
    }
    if (SUMMARY_LINE.test(line) && summaryLines.length < SUMMARY_LINE_CAP) {
      summaryLines.push(line);
    }
    if (keepStdout && !truncated) {
      if (captured.length + line.length + 1 > captureCapBytes) {
        truncated = true;
      } else {
        captured += `${line}\n`;
      }
    }
  };

  /** A streaming sink: writes bytes to the log and splits them into lines. */
  const makeSink = (fileStream, isStdout) => {
    let partial = "";
    // One decoder per stream: a multibyte character split across chunks of
    // one stream must never meet bytes of the other.
    const decoder = new TextDecoder("utf-8");
    return {
      write(chunk) {
        lastOutputAt = Date.now();
        scheduleHeartbeat();
        fileStream.write(chunk);
        if (!isStdout) {
          stderrBytes += chunk.byteLength;
        }
        partial += decoder.decode(chunk, { stream: true });
        const lines = partial.split(/\r?\n/);
        partial = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line, isStdout);
        }
      },
      flush() {
        partial += decoder.decode();
        if (partial.length > 0) {
          handleLine(partial, isStdout);
          partial = "";
        }
      },
    };
  };
  const outSink = makeSink(stdoutStream, true);
  const errSink = makeSink(stderrStream, false);

  let child;
  try {
    child = spawn(command, args, {
      cwd: cwd ?? repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }
  if (child !== undefined) {
    child.stdout?.on("data", (chunk) => outSink.write(chunk));
    child.stderr?.on("data", (chunk) => errSink.write(chunk));
    child.once("error", (error) => {
      if (spawnError === null) {
        spawnError = error instanceof Error ? error.message : String(error);
      }
    });
  }

  /** Signal the whole process group, falling back to the child itself. */
  const killTree = (signalName) => {
    if (child === undefined || child.pid === undefined || child.killed) {
      return;
    }
    try {
      process.kill(-child.pid, signalName);
    } catch {
      child.kill(signalName);
    }
  };
  const stopTree = () => {
    killTree("SIGTERM");
    killEscalation = setTimeout(() => killTree("SIGKILL"), killGraceMs);
  };

  const timeoutTimer =
    timeoutMs === Infinity ? null : setTimeout(() => { timedOut = true; stopTree(); }, timeoutMs);
  // The heartbeat is scheduled from the last output, not on a fixed interval:
  // a fixed-phase tick can land a quarter-period late, which would break the
  // "at least every heartbeatMs" promise. Each output chunk re-arms the timer,
  // so the next beat fires one quiet period after the output stops.
  let heartbeatTimer = null;
  let heartbeatArmed = true;
  const fireHeartbeat = () => {
    lastOutputAt = Date.now();
    out({
      kind: "heartbeat",
      name,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    scheduleHeartbeat();
  };
  const scheduleHeartbeat = () => {
    if (!heartbeatArmed) {
      return;
    }
    if (heartbeatTimer !== null) {
      clearTimeout(heartbeatTimer);
    }
    heartbeatTimer = setTimeout(fireHeartbeat, Math.max(0, lastOutputAt + heartbeatMs - Date.now()));
  };
  scheduleHeartbeat();
  const onAbort = () => {
    if (!timedOut) {
      interrupted = true;
      stopTree();
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }

  const closeInfo = await new Promise((resolve) => {
    if (child === undefined) {
      resolve({ code: null, signal: null });
      return;
    }
    child.once("close", (code, termSignal) => resolve({ code: code ?? null, signal: termSignal ?? null }));
  });

  // The direct child has closed, but a tree member that traps SIGTERM and
  // holds no pipes (a grandchild the escalation exists for) can still be
  // alive in the step's process group. Keep the armed SIGKILL escalation and
  // wait for the group to empty, so nothing the step spawned outlives it.
  const groupGone = () => {
    if (child?.pid === undefined) {
      return true;
    }
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  if (killEscalation !== null && !groupGone()) {
    const deadline = Date.now() + killGraceMs + 2_000;
    while (!groupGone() && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  if (timeoutTimer !== null) {
    clearTimeout(timeoutTimer);
  }
  heartbeatArmed = false;
  if (heartbeatTimer !== null) {
    clearTimeout(heartbeatTimer);
  }
  if (killEscalation !== null) {
    clearTimeout(killEscalation);
  }
  signal?.removeEventListener("abort", onAbort);
  status = closeInfo.code;
  const closeSignal = closeInfo.signal;
  outSink.flush();
  errSink.flush();
  await Promise.all([
    new Promise((resolve) => stdoutStream.end(resolve)),
    new Promise((resolve) => stderrStream.end(resolve)),
  ]);
  return {
    ok: spawnError === null && !timedOut && !interrupted && status === 0,
    status,
    timedOut,
    interrupted,
    spawnError,
    closeSignal,
    durationMs: Date.now() - startedAt,
    logPath,
    errPath,
    stderrBytes,
    summaryText: summaryLines.join("\n"),
    stdout: keepStdout ? captured : "",
    truncated,
  };
}

/** Why a failed step failed, in one short phrase, or null when it exited. */
function failurePhrase(step) {
  if (step.spawnError !== null) {
    return `the command never started (${step.spawnError})`;
  }
  if (step.timedOut) {
    return `the step timed out after ${(step.durationMs / 1000).toFixed(1)}s`;
  }
  if (step.interrupted) {
    return "the gate was interrupted";
  }
  if (step.status === null) {
    // The child started and died under a signal the gate did not send — an
    // operator kill or a kernel out-of-memory kill — leaving no exit code.
    return step.closeSignal === null || step.closeSignal === undefined
      ? "the command died without an exit code"
      : `the command was killed by ${step.closeSignal}`;
  }
  return null;
}

/**
 * Summarize a vitest run. Every `Test Files` and `Tests` summary line must
 * report zero failed and zero skipped: a skipped line is how a silently
 * skipped PostgreSQL suite looks when `TEST_DATABASE_URL` is missing. Every
 * vitest invocation prints exactly one `Test Files` line, so the count of
 * those lines is the count of runs that reported, and it must equal
 * expectedRuns: the per-workspace test fan-out runs with `--if-present`, so
 * a workspace with a missing or mistyped test script contributes no summary
 * and npm still exits 0.
 */
export function parseVitestSummary(output, label, expectedRuns) {
  const lines = output.split(/\r?\n/).filter((line) => SUMMARY_LINE.test(line));
  const runs = lines.filter((line) => /^\s*Test Files\s+\d/.test(line)).length;
  if (runs !== expectedRuns) {
    return {
      ok: false,
      note:
        `${label}: found ${runs} of ${expectedRuns} expected vitest summaries — ` +
        "a test script is missing, mistyped, or crashed before reporting",
    };
  }
  let failed = 0;
  let skipped = 0;
  let testsPassed = 0;
  for (const line of lines) {
    failed += countUnit(line, "failed");
    skipped += countUnit(line, "skipped");
    if (line.trim().startsWith("Tests")) {
      testsPassed += countUnit(line, "passed");
    }
  }
  if (failed > 0 || skipped > 0 || testsPassed === 0) {
    return {
      ok: false,
      note: `${label}: ${failed} failed or skipped units — every suite must run in full`,
    };
  }
  return { ok: true, note: `${label}: ${testsPassed} tests passed, 0 failed, 0 skipped` };
}

/**
 * Weigh a test command's exit status against its parsed vitest summary. The
 * summary alone never clears a run: a global-teardown crash, an out-of-memory
 * kill with buffered output, or a failing posttest step can leave output that
 * parses as a pass while npm exits non-zero. The exit code wins.
 */
export function testCommandVerdict(command, parsed) {
  if (command.ok) {
    return parsed;
  }
  const exit = failurePhrase(command) ?? `npm exited ${command.status}`;
  const summary = parsed.ok ? "the printed summary looks clean, but the exit code decides" : parsed.note;
  return { ok: false, note: `${exit} — ${summary}` };
}

function countUnit(line, unit) {
  const match = line.match(new RegExp(`(\\d+)\\s+${unit}`));
  return match === null ? 0 : Number(match[1]);
}

async function main() {
  const strict = process.argv.includes("--strict");
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
    console.error(
      "release gate: TEST_DATABASE_URL is not set. The PostgreSQL-backed suites " +
        "skip silently without it, so the gate refuses to run. Point it at a " +
        "server whose user may create databases, for example " +
        "TEST_DATABASE_URL='postgres://user@localhost/postgres?host=/var/run/postgresql'.",
    );
    process.exit(1);
  }

  const logDir = await mkdtemp(join(tmpdir(), "mail-hub-release-gate-"));
  const results = [];
  const gateStartedAt = Date.now();

  console.log("Release validation gate");
  console.log(`Logs: ${logDir}`);
  if (strict) {
    console.log("Mode: strict — a deferred check fails the gate (use when cutting a release).");
  }

  /** Record one named gate check with its outcome and a short human note. */
  function record(name, status, note) {
    results.push({ name, status, note });
    const mark = status === "pass" ? "PASS" : status === "defer" ? "DEFERRED" : "FAIL";
    console.log(`  ${mark.padEnd(8)} ${name}${note === "" ? "" : ` — ${note}`}`);
  }

  // The interrupt path: SIGINT and SIGTERM abort the step that runs, which
  // kills its whole process tree; the gate then stops between steps.
  let interruptSignal = null;
  let activeController = null;
  const onSignal = (signalName) => {
    if (interruptSignal === null) {
      interruptSignal = signalName;
    }
    activeController?.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  const stopped = () => interruptSignal !== null;

  /**
   * Run one step of this gate: the streaming runner below, with this gate's
   * console attached. Output lines stream indented under the step's heading;
   * a quiet step heartbeats.
   */
  async function run(name, command, args, stepOptions = {}) {
    console.log(`\n▶ ${name}`);
    const controller = new AbortController();
    // A signal that landed while no step ran (between steps, or during one of
    // the gate's own database calls) aborts nothing by itself. Carry it into
    // this step, so the step dies at spawn instead of running to completion.
    if (stopped()) {
      controller.abort();
    }
    activeController = controller;
    const step = await runStep(name, command, args, {
      ...stepOptions,
      logDir,
      signal: controller.signal,
      out: (event) => {
        if (event.kind === "line") {
          console.log(`  ${event.text}`);
        } else {
          console.log(`  … ${event.name} still running (${event.seconds}s)`);
        }
      },
    });
    activeController = null;
    const seconds = (step.durationMs / 1000).toFixed(1);
    const logs =
      `output in ${step.logPath}` +
      (step.stderrBytes > 0 ? `; errors in ${step.errPath}` : "");
    const failure = step.ok ? null : failurePhrase(step);
    if (step.spawnError !== null) {
      console.log(`  command never started in ${seconds}s; ${step.spawnError}`);
    } else if (failure !== null) {
      console.log(`  ${failure}; ${logs}`);
    } else {
      console.log(`  ${step.ok ? "command finished" : "command failed"} in ${seconds}s; ${logs}`);
    }
    return step;
  }

  // 1. Task files: the list, the schema, and the plan links stay consistent.
  {
    const taskFiles = await run("task-files", "node", ["scripts/validate-tasks.mjs"]);
    record(
      "task-files",
      taskFiles.ok ? "pass" : "fail",
      taskFiles.ok ? "task list, schema, and plan links are consistent" : "see the task-files log",
    );
  }

  // 2. Type checks in every workspace.
  if (!stopped()) {
    const typecheck = await run("typecheck", "npm", ["run", "check"]);
    record("typecheck", typecheck.ok ? "pass" : "fail", typecheck.ok ? "every workspace type-checks" : "see the typecheck log");
  }

  // 3. Migrations apply cleanly through the deployment path.
  if (!stopped()) {
    const drizzleFolder = join(repoRoot, "packages", "database", "drizzle");
    const journal = JSON.parse(await readFile(join(drizzleFolder, "meta", "_journal.json"), "utf8"));
    const sqlFiles = (await readdir(drizzleFolder)).filter((name) => name.endsWith(".sql"));
    const journalCount = journal.entries.length;
    let note = "";
    let ok = true;

    const maintenanceUrl = new URL(testDatabaseUrl);
    maintenanceUrl.pathname = "/postgres";
    const scratchName = `mail_hub_gate_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const scratchUrl = new URL(testDatabaseUrl);
    scratchUrl.pathname = `/${scratchName}`;
    const admin = new Pool({ connectionString: maintenanceUrl.toString() });
    try {
      await admin.query(`create database ${scratchName}`);
      const applied = await run("migrations", "npm", ["run", "db:migrate"], {
        cwd: join(repoRoot, "packages", "database"),
        env: { DATABASE_URL: scratchUrl.toString() },
      });
      if (!applied.ok) {
        ok = false;
        note = failurePhrase(applied) ?? "drizzle-kit migrate failed on the scratch database";
      } else {
        const pool = new Pool({ connectionString: scratchUrl.toString() });
        try {
          const counted = await pool.query(
            "select count(*)::text as count from drizzle.__drizzle_migrations",
          );
          const appliedCount = Number(counted.rows[0]?.count ?? "0");
          if (appliedCount !== journalCount || journalCount !== sqlFiles.length) {
            ok = false;
            note = `applied ${appliedCount}, journal lists ${journalCount}, folder holds ${sqlFiles.length} files`;
          } else {
            const again = await run("migrations-again", "npm", ["run", "db:migrate"], {
              cwd: join(repoRoot, "packages", "database"),
              env: { DATABASE_URL: scratchUrl.toString() },
            });
            const recounted = await pool.query(
              "select count(*)::text as count from drizzle.__drizzle_migrations",
            );
            const secondCount = Number(recounted.rows[0]?.count ?? "0");
            if (!again.ok || secondCount !== appliedCount) {
              ok = false;
              note =
                failurePhrase(again) ??
                `the re-run changed the applied set (${appliedCount} to ${secondCount})`;
            } else {
              note = `${appliedCount} migrations applied and re-run clean on a scratch database`;
            }
          }
        } finally {
          await pool.end();
        }
      }
    } catch (error) {
      ok = false;
      note = error instanceof Error ? error.message : String(error);
    } finally {
      await dropScratch(admin, scratchName);
      await admin.end();
    }
    record("migrations", ok ? "pass" : "fail", note);
  }

  // 4. Integration tests across every workspace, with nothing skipped.
  if (!stopped()) {
    // The expected summary count comes from the workspace inventory, because
    // the root `test` script fans out with `--if-present`: a workspace whose
    // test script is missing or mistyped runs nothing, prints no summary, and
    // leaves npm's exit status at 0. An inventory that cannot be read fails
    // the check rather than lowering the expected count.
    const inventory = await run("test-inventory", "npm", ["query", "--json", ".workspace"], {
      keepStdout: true,
    });
    let expectedRuns = null;
    let inventoryNote = "";
    try {
      if (inventory.truncated) {
        inventoryNote = "the workspace inventory output exceeded the capture cap";
      } else if (!inventory.ok) {
        inventoryNote = failurePhrase(inventory) ?? `npm query exited with status ${inventory.status}`;
      } else {
        const withTests = JSON.parse(inventory.stdout).filter(
          (node) => typeof node.scripts?.test === "string",
        );
        if (withTests.length === 0) {
          inventoryNote = "no workspace declares a test script";
        } else {
          expectedRuns = withTests.length;
        }
      }
    } catch (error) {
      inventoryNote = `npm query output is not workspace JSON (${error instanceof Error ? error.message : String(error)})`;
    }
    if (expectedRuns === null) {
      record("integration-tests", "fail", `cannot count the workspace test scripts — ${inventoryNote}`);
    } else {
      const tests = await run("integration-tests", "npm", ["test"]);
      const parsed = testCommandVerdict(
        tests,
        parseVitestSummary(tests.summaryText, "workspace suite", expectedRuns),
      );
      record("integration-tests", parsed.ok ? "pass" : "fail", parsed.note);
    }
  }

  // 5. Action-service permission suites.
  if (!stopped()) {
    const permissionSuites = ["@mail-hub/actions", "@mail-hub/api"];
    const permissions = await run(
      "action-permissions",
      "npm",
      ["test", ...permissionSuites.flatMap((name) => ["--workspace", name])],
    );
    const parsed = testCommandVerdict(
      permissions,
      parseVitestSummary(permissions.summaryText, "actions and api suites", permissionSuites.length),
    );
    record("action-permissions", parsed.ok ? "pass" : "fail", parsed.note);
  }

  // 6 and 7. Interface checks, once the interface milestone ships a runner.
  const webPackage = JSON.parse(await readFile(join(repoRoot, "apps", "web", "package.json"), "utf8"));
  if (!stopped()) {
    const script = ["test:e2e", "e2e"].find((key) => typeof webPackage.scripts?.[key] === "string");
    if (script === undefined) {
      record(
        "browser-workflows",
        "defer",
        "no end-to-end runner in apps/web yet; blocked on the interface milestone (T015+) and T033",
      );
    } else {
      const e2e = await run("browser-workflows", "npm", ["run", script, "--workspace", "@mail-hub/web"]);
      record("browser-workflows", e2e.ok ? "pass" : "fail", `npm run ${script}`);
    }
  }
  if (!stopped()) {
    const script = ["test:a11y", "a11y"].find((key) => typeof webPackage.scripts?.[key] === "string");
    if (script === undefined) {
      record(
        "interface-checks",
        "defer",
        "no accessibility and visual runner in apps/web yet; blocked on T033",
      );
    } else {
      const a11y = await run("interface-checks", "npm", ["run", script, "--workspace", "@mail-hub/web"]);
      record("interface-checks", a11y.ok ? "pass" : "fail", `npm run ${script}`);
    }
  }

  // Verdict.
  const failed = results.filter((result) => result.status === "fail");
  const deferred = results.filter((result) => result.status === "defer");
  const gateFailed = failed.length > 0 || (strict && deferred.length > 0);
  const totalSeconds = ((Date.now() - gateStartedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`Summary (${totalSeconds}s total):`);
  for (const result of results) {
    const mark = result.status === "pass" ? "PASS" : result.status === "defer" ? "DEFERRED" : "FAIL";
    console.log(`  ${mark.padEnd(8)} ${result.name}`);
  }
  console.log("");
  if (interruptSignal !== null) {
    console.log(`Verdict: INTERRUPTED (${interruptSignal}) — logs kept for inspection: ${logDir}`);
    process.exit(interruptSignal === "SIGINT" ? 130 : 143);
  }
  if (failed.length > 0) {
    console.log(`Verdict: FAIL — ${failed.map((result) => result.name).join(", ")} did not pass.`);
  } else if (deferred.length > 0 && strict) {
    console.log(`Verdict: FAIL (strict) — ${deferred.map((result) => result.name).join(", ")} still deferred.`);
  } else if (deferred.length > 0) {
    console.log(
      `Verdict: PASS with ${deferred.length} deferred check${deferred.length === 1 ? "" : "s"}; ` +
        "run with --strict before cutting a release.",
    );
  } else {
    console.log("Verdict: PASS — every check ran and passed.");
  }
  if (gateFailed) {
    // The log paths printed above must survive the failure they explain.
    console.log(`Logs kept for inspection: ${logDir}`);
  } else {
    await rm(logDir, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(gateFailed ? 1 : 0);
}

/**
 * Drop the scratch database, retrying while a transient backend holds it.
 * `DROP DATABASE ... WITH (FORCE)` fails with "permission denied to terminate
 * process" when a backend of another role — an autovacuum worker visiting a
 * freshly churned database — holds the database; the holder leaves on its
 * own, so the drop retries instead of failing the gate.
 */
async function dropScratch(admin, name) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await admin.query(`drop database if exists ${name} with (force)`);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "42501" && code !== "55006") {
        console.error(
          `release gate: dropping ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
  console.error(`release gate: dropping ${name} still blocked after 20 attempts.`);
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  let stepTimeoutError = null;
  try {
    stepTimeoutFromEnvironment();
  } catch (error) {
    stepTimeoutError = error;
  }
  if (stepTimeoutError !== null) {
    console.error(stepTimeoutError.message);
    process.exit(1);
  }
  await main();
}
