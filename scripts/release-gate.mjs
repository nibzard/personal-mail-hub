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
 * Exit status: 0 when every applicable check passed, 1 otherwise. The log
 * directory is removed after a passing run and kept after a failing one, so
 * the printed log paths stay inspectable.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (testDatabaseUrl === undefined || testDatabaseUrl.length === 0) {
  console.error(
    "release gate: TEST_DATABASE_URL is not set. The PostgreSQL-backed suites " +
      "skip silently without it, so the gate refuses to run. Point it at a " +
      "server whose user may create databases, for example " +
      "TEST_DATABASE_URL='postgres://user:pass@127.0.0.1:5432/postgres'.",
  );
  process.exit(1);
}

const logDir = await mkdtemp(join(tmpdir(), "mail-hub-release-gate-"));
const results = [];

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

/**
 * Run a command, capture its output in a log file, and report the outcome.
 * The log path prints so a failed check can be inspected in full, and the
 * log directory survives any FAIL verdict.
 */
function run(name, command, args, options = {}) {
  const logPath = join(logDir, `${name.replace(/[^a-z0-9-]/g, "-")}.log`);
  const started = Date.now();
  console.log(`\n▶ ${name}`);
  const child = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(logPath, child.stdout ?? "");
  writeFileSync(`${logPath}.err`, child.stderr ?? "");
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = child.status === 0;
  console.log(`  ${ok ? "command finished" : "command failed"} in ${seconds}s; output in ${logPath}`);
  return { ok, status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "", logPath };
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
function parseVitestSummary(output, label, expectedRuns) {
  const lines = output.split(/\r?\n/).filter((line) => /^\s*(Test Files|Tests)\s+\d/.test(line));
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
function testCommandVerdict(command, parsed) {
  if (command.ok) {
    return parsed;
  }
  const exit = command.status === null ? "the command never started" : `npm exited ${command.status}`;
  const summary = parsed.ok ? "the printed summary looks clean, but the exit code decides" : parsed.note;
  return { ok: false, note: `${exit} — ${summary}` };
}

function countUnit(line, unit) {
  const match = line.match(new RegExp(`(\\d+)\\s+${unit}`));
  return match === null ? 0 : Number(match[1]);
}

// 1. Task files: the list, the schema, and the plan links stay consistent.
{
  const taskFiles = run("task-files", "node", ["scripts/validate-tasks.mjs"]);
  record(
    "task-files",
    taskFiles.ok ? "pass" : "fail",
    taskFiles.ok ? "task list, schema, and plan links are consistent" : "see the task-files log",
  );
}

// 2. Type checks in every workspace.
{
  const typecheck = run("typecheck", "npm", ["run", "check"]);
  record("typecheck", typecheck.ok ? "pass" : "fail", typecheck.ok ? "every workspace type-checks" : "see the typecheck log");
}

// 3. Migrations apply cleanly through the deployment path.
{
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
    const applied = run("migrations", "npm", ["run", "db:migrate"], {
      cwd: join(repoRoot, "packages", "database"),
      env: { DATABASE_URL: scratchUrl.toString() },
    });
    if (!applied.ok) {
      ok = false;
      note = "drizzle-kit migrate failed on the scratch database";
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
          const again = run("migrations-again", "npm", ["run", "db:migrate"], {
            cwd: join(repoRoot, "packages", "database"),
            env: { DATABASE_URL: scratchUrl.toString() },
          });
          const recounted = await pool.query(
            "select count(*)::text as count from drizzle.__drizzle_migrations",
          );
          const secondCount = Number(recounted.rows[0]?.count ?? "0");
          if (!again.ok || secondCount !== appliedCount) {
            ok = false;
            note = `the re-run changed the applied set (${appliedCount} to ${secondCount})`;
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
{
  // The expected summary count comes from the workspace inventory, because
  // the root `test` script fans out with `--if-present`: a workspace whose
  // test script is missing or mistyped runs nothing, prints no summary, and
  // leaves npm's exit status at 0. An inventory that cannot be read fails
  // the check rather than lowering the expected count.
  const inventory = run("test-inventory", "npm", ["query", "--json", ".workspace"]);
  let expectedRuns = null;
  let inventoryNote = "";
  try {
    if (!inventory.ok) {
      inventoryNote = `npm query exited with status ${inventory.status}`;
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
    const tests = run("integration-tests", "npm", ["test"]);
    const parsed = testCommandVerdict(
      tests,
      parseVitestSummary(tests.stdout, "workspace suite", expectedRuns),
    );
    record("integration-tests", parsed.ok ? "pass" : "fail", parsed.note);
  }
}

// 5. Action-service permission suites.
{
  const permissionSuites = ["@mail-hub/actions", "@mail-hub/api"];
  const permissions = run(
    "action-permissions",
    "npm",
    ["test", ...permissionSuites.flatMap((name) => ["--workspace", name])],
  );
  const parsed = testCommandVerdict(
    permissions,
    parseVitestSummary(permissions.stdout, "actions and api suites", permissionSuites.length),
  );
  record("action-permissions", parsed.ok ? "pass" : "fail", parsed.note);
}

// 6 and 7. Interface checks, once the interface milestone ships a runner.
const webPackage = JSON.parse(await readFile(join(repoRoot, "apps", "web", "package.json"), "utf8"));
{
  const script = ["test:e2e", "e2e"].find((key) => typeof webPackage.scripts?.[key] === "string");
  if (script === undefined) {
    record(
      "browser-workflows",
      "defer",
      "no end-to-end runner in apps/web yet; blocked on the interface milestone (T015+) and T033",
    );
  } else {
    const e2e = run("browser-workflows", "npm", ["run", script, "--workspace", "@mail-hub/web"]);
    record("browser-workflows", e2e.ok ? "pass" : "fail", `npm run ${script}`);
  }
}
{
  const script = ["test:a11y", "a11y"].find((key) => typeof webPackage.scripts?.[key] === "string");
  if (script === undefined) {
    record(
      "interface-checks",
      "defer",
      "no accessibility and visual runner in apps/web yet; blocked on T033",
    );
  } else {
    const a11y = run("interface-checks", "npm", ["run", script, "--workspace", "@mail-hub/web"]);
    record("interface-checks", a11y.ok ? "pass" : "fail", `npm run ${script}`);
  }
}

// Verdict.
const failed = results.filter((result) => result.status === "fail");
const deferred = results.filter((result) => result.status === "defer");
const gateFailed = failed.length > 0 || (strict && deferred.length > 0);
console.log("");
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
