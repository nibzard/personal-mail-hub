import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// The gate is a plain Node script, so it carries no type declarations;
// the surface under test is pinned here.
// @ts-expect-error No declaration file for the script.
import { parseVitestSummary, runStep, stepTimeoutFromEnvironment, testCommandVerdict } from "../../../scripts/release-gate.mjs";

/*
 * The gate step runner's contracts (T115): output streams while a step
 * runs, a quiet step heartbeats, the exit code alone decides the outcome,
 * timeouts and interrupts take down the whole process tree the step
 * spawned, and only bounded pieces of the output stay in memory. All child
 * processes are local `node -e` scripts, plus the gate script itself with
 * a dummy database URL it is interrupted before it contacts; nothing
 * leaves the machine.
 */

const nodeBin = process.execPath;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const gateScript = join(repoRoot, "scripts", "release-gate.mjs");

/** Collects the progress events a step emits, in order, stamped on arrival. */
function collector() {
  const events: Array<Record<string, unknown>> = [];
  return { events, out: (event: Record<string, unknown>) => { events.push({ ...event, at: Date.now() }); } };
}

/** Runs a test body with a throwaway log directory. */
async function withLogDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "gate-step-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

/** True while `pid` names a live process; a zombie counts as gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0];
    return state !== "Z";
  } catch {
    return true;
  }
}

/** Waits up to two seconds for a pid to die, the way a killed tree settles. */
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!alive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

/**
 * A child that writes its own pid and a grandchild's pid to files, then
 * idles: the tree a timeout or an interrupt must take down. Each process
 * traps SIGTERM only when its flag says so — a tree where the parent dies
 * under SIGTERM but a trapping grandchild survives needs the SIGKILL
 * escalation, and the step must not resolve while that grandchild lives.
 */
function treeScript(parentTraps: boolean, grandTraps = parentTraps): string {
  const trap = (traps: boolean) => (traps ? "process.on('SIGTERM', () => {});" : "");
  const grandScript =
    `${trap(grandTraps)} require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
  return `
    const fs = require("fs");
    const { spawn } = require("child_process");
    ${trap(parentTraps)}
    const grand = spawn(process.execPath, ["-e", ${JSON.stringify(grandScript)}, process.argv[2]]);
    const ready = setInterval(() => {
      if (fs.existsSync(process.argv[2])) {
        fs.writeFileSync(process.argv[1], String(process.pid));
        clearInterval(ready);
      }
    }, 10);
    setInterval(() => {}, 1000);
  `;
}

/** Reads the pid a tree member wrote, once it has written it. */
async function readPid(dir: string, file: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return Number(await readFile(join(dir, file), "utf8"));
    } catch {
      await sleep(50);
    }
  }
  throw new Error(`${file} never appeared`);
}

describe("the gate step runner", () => {
  it("streams output lines as they arrive and keeps the whole log", async () => {
    await withLogDir(async (logDir) => {
      const { events, out } = collector();
      const script =
        "(async () => { for (let i = 0; i < 5; i += 1) { console.log('line ' + i); await new Promise((r) => setTimeout(r, 40)); } })()";
      const step = await runStep("slow", nodeBin, ["-e", script], { logDir, out, heartbeatMs: 60_000 });
      expect(step.ok).toBe(true);
      expect(step.status).toBe(0);
      const lines = events
        .filter((event) => event.kind === "line" && event.stream === "stdout")
        .map((event) => event.text);
      expect(lines).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4"]);
      const logged = await readFile(join(logDir, "slow.log"), "utf8");
      expect(logged.split("\n").filter((line) => line.length > 0)).toEqual(lines);
    });
  }, 15_000);

  it("heartbeats while a step stays quiet", async () => {
    await withLogDir(async (logDir) => {
      const { events, out } = collector();
      const script = "(async () => { await new Promise((r) => setTimeout(r, 650)); console.log('done'); })()";
      const step = await runStep("quiet", nodeBin, ["-e", script], { logDir, out, heartbeatMs: 150 });
      expect(step.ok).toBe(true);
      const beats = events.filter((event) => event.kind === "heartbeat");
      expect(beats.length).toBeGreaterThanOrEqual(2);
      expect(beats[0]).toMatchObject({ kind: "heartbeat", name: "quiet" });
      expect(Number.isFinite(Number((beats[0] as { seconds: number }).seconds))).toBe(true);
    });
  }, 15_000);

  it("does not heartbeat while output is flowing", async () => {
    await withLogDir(async (logDir) => {
      const { events, out } = collector();
      const script =
        "(async () => { for (let i = 0; i < 7; i += 1) { console.log('tick ' + i); await new Promise((r) => setTimeout(r, 100)); } })()";
      await runStep("flowing", nodeBin, ["-e", script], { logDir, out, heartbeatMs: 500 });
      expect(events.filter((event) => event.kind === "heartbeat")).toHaveLength(0);
    });
  }, 15_000);

  it("lets the exit code decide over a clean-looking summary", async () => {
    await withLogDir(async (logDir) => {
      const script =
        "console.log(' Test Files  2 passed (2)'); console.log('      Tests  10 passed (10)'); process.exit(3);";
      const step = await runStep("lying-summary", nodeBin, ["-e", script], { logDir, out: () => {} });
      expect(step.ok).toBe(false);
      expect(step.status).toBe(3);
      expect(step.summaryText).toContain("Test Files  2 passed (2)");
      const parsed = parseVitestSummary(step.summaryText, "suite", 1);
      expect(parsed.ok).toBe(true);
      const verdict = testCommandVerdict(step, parsed);
      expect(verdict.ok).toBe(false);
      expect(verdict.note).toMatch(/npm exited 3/);
      expect(verdict.note).toMatch(/exit code decides/);
    });
  }, 15_000);

  it("reports a timeout as the failure, not a clean summary", async () => {
    await withLogDir(async (logDir) => {
      const script =
        "console.log(' Test Files  1 passed (1)'); console.log('      Tests  4 passed (4)'); setInterval(() => {}, 1000);";
      const step = await runStep("hanging", nodeBin, ["-e", script], {
        logDir,
        out: () => {},
        timeoutMs: 250,
        killGraceMs: 4_000,
      });
      expect(step.ok).toBe(false);
      expect(step.timedOut).toBe(true);
      const parsed = parseVitestSummary(step.summaryText, "suite", 1);
      expect(parsed.ok).toBe(true);
      const verdict = testCommandVerdict(step, parsed);
      expect(verdict.ok).toBe(false);
      expect(verdict.note).toMatch(/timed out/);
    });
  }, 15_000);

  it("times out and kills the whole process tree", async () => {
    await withLogDir(async (logDir) => {
      const parentPidFile = join(logDir, "parent.pid");
      const grandPidFile = join(logDir, "grand.pid");
      const step = await runStep("tree", nodeBin, ["-e", treeScript(false), parentPidFile, grandPidFile], {
        logDir,
        out: () => {},
        timeoutMs: 400,
        killGraceMs: 4_000,
      });
      expect(step.timedOut).toBe(true);
      expect(step.ok).toBe(false);
      const parentPid = await readPid(logDir, "parent.pid");
      const grandPid = await readPid(logDir, "grand.pid");
      expect(await gone(parentPid)).toBe(true);
      expect(await gone(grandPid)).toBe(true);
    });
  }, 20_000);

  it("escalates to SIGKILL when the tree traps SIGTERM", async () => {
    await withLogDir(async (logDir) => {
      const parentPidFile = join(logDir, "parent.pid");
      const grandPidFile = join(logDir, "grand.pid");
      const step = await runStep("stubborn", nodeBin, ["-e", treeScript(true), parentPidFile, grandPidFile], {
        logDir,
        out: () => {},
        timeoutMs: 300,
        killGraceMs: 300,
      });
      expect(step.timedOut).toBe(true);
      const parentPid = await readPid(logDir, "parent.pid");
      const grandPid = await readPid(logDir, "grand.pid");
      expect(await gone(parentPid)).toBe(true);
      expect(await gone(grandPid)).toBe(true);
    });
  }, 20_000);

  it("an abort interrupts the step and kills its tree", async () => {
    await withLogDir(async (logDir) => {
      const controller = new AbortController();
      const parentPidFile = join(logDir, "parent.pid");
      const grandPidFile = join(logDir, "grand.pid");
      setTimeout(() => controller.abort(), 300);
      const step = await runStep("aborted", nodeBin, ["-e", treeScript(false), parentPidFile, grandPidFile], {
        logDir,
        out: () => {},
        signal: controller.signal,
        killGraceMs: 4_000,
      });
      expect(step.interrupted).toBe(true);
      expect(step.ok).toBe(false);
      const parentPid = await readPid(logDir, "parent.pid");
      const grandPid = await readPid(logDir, "grand.pid");
      expect(await gone(parentPid)).toBe(true);
      expect(await gone(grandPid)).toBe(true);
    });
  }, 20_000);

  it("keeps large output on disk and only summary lines in memory", async () => {
    await withLogDir(async (logDir) => {
      const script = `
        (async () => {
          const chunk = "x".repeat(64 * 1024) + "\\n";
          for (let i = 0; i < 40; i += 1) { process.stdout.write(chunk); }
          console.log(" Test Files  1 passed (1)");
          console.log("      Tests  5 passed (5)");
          await new Promise((r) => setTimeout(r, 200));
        })()
      `;
      const step = await runStep("large", nodeBin, ["-e", script], { logDir, out: () => {}, heartbeatMs: 60_000 });
      expect(step.ok).toBe(true);
      expect(step.summaryText.split("\n")).toHaveLength(2);
      const logged = await readFile(join(logDir, "large.log"), "utf8");
      expect(logged.length).toBeGreaterThan(2 * 1024 * 1024);
    });
  }, 20_000);

  it("caps the in-memory stdout capture for steps that ask for it", async () => {
    await withLogDir(async (logDir) => {
      const script = `
        (async () => {
          for (let i = 0; i < 200; i += 1) { console.log("capture line " + i + " " + "y".repeat(100)); }
          await new Promise((r) => setTimeout(r, 100));
        })()
      `;
      const step = await runStep("capped", nodeBin, ["-e", script], {
        logDir,
        out: () => {},
        keepStdout: true,
        captureCapBytes: 2048,
      });
      expect(step.ok).toBe(true);
      expect(step.truncated).toBe(true);
      expect(step.stdout.length).toBeLessThanOrEqual(2048);
    });
  }, 15_000);

  it("captures the full stdout of a small step", async () => {
    await withLogDir(async (logDir) => {
      const script = "console.log(JSON.stringify([{ scripts: { test: 'vitest' } }]));";
      const step = await runStep("inventory", nodeBin, ["-e", script], {
        logDir,
        out: () => {},
        keepStdout: true,
      });
      expect(step.ok).toBe(true);
      expect(step.truncated).toBe(false);
      expect(JSON.parse(step.stdout)).toEqual([{ scripts: { test: "vitest" } }]);
    });
  }, 15_000);

  it("keeps stderr in its own log and reports it", async () => {
    await withLogDir(async (logDir) => {
      const script = "console.error('boom'); process.exit(1);";
      const step = await runStep("stderr-step", nodeBin, ["-e", script], { logDir, out: () => {} });
      expect(step.ok).toBe(false);
      expect(step.stderrBytes).toBeGreaterThan(0);
      const errors = await readFile(join(logDir, "stderr-step.log.err"), "utf8");
      expect(errors).toContain("boom");
    });
  }, 15_000);

  it("reports a command that never started", async () => {
    await withLogDir(async (logDir) => {
      const step = await runStep("missing", "/no/such/command-bin", [], { logDir, out: () => {} });
      expect(step.ok).toBe(false);
      expect(step.spawnError).toContain("ENOENT");
      const verdict = testCommandVerdict(step, { ok: true, note: "clean" });
      expect(verdict.note).toMatch(/never started/);
    });
  }, 15_000);

  it("reports a step that an outside signal killed", async () => {
    await withLogDir(async (logDir) => {
      const pidFile = join(logDir, "child.pid");
      const script =
        "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
      const stepPromise = runStep("killed", nodeBin, ["-e", script, pidFile], { logDir, out: () => {} });
      const childPid = await readPid(logDir, "child.pid");
      const killer = spawn(nodeBin, [
        "-e",
        "process.kill(Number(process.argv[1]), 'SIGKILL');",
        String(childPid),
      ]);
      const step = await stepPromise;
      const killerExit = await new Promise<number | null>((resolvePromise) => {
        killer.once("close", (code) => resolvePromise(code));
      });
      expect(killerExit).toBe(0);
      expect(step.ok).toBe(false);
      expect(step.spawnError).toBeNull();
      expect(step.timedOut).toBe(false);
      expect(step.interrupted).toBe(false);
      expect(step.status).toBeNull();
      expect(step.closeSignal).toBe("SIGKILL");
      const verdict = testCommandVerdict(step, { ok: true, note: "clean" });
      expect(verdict.note).toMatch(/killed by SIGKILL/);
    });
  }, 15_000);

  it("schedules the first heartbeat one quiet period after the last output", async () => {
    await withLogDir(async (logDir) => {
      const startedAt = Date.now();
      const { events, out } = collector();
      const script = "(async () => { console.log('one line'); await new Promise((r) => setTimeout(r, 1100)); })()";
      const step = await runStep("bound", nodeBin, ["-e", script], { logDir, out, heartbeatMs: 400 });
      expect(step.ok).toBe(true);
      const beats = events.filter((event) => event.kind === "heartbeat");
      expect(beats.length).toBeGreaterThanOrEqual(1);
      const firstDelay = (beats[0] as { at: number }).at - startedAt;
      expect(firstDelay).toBeGreaterThanOrEqual(390);
      expect(firstDelay).toBeLessThanOrEqual(700);
    });
  }, 15_000);

  it("flushes a trailing line that ends without a newline", async () => {
    await withLogDir(async (logDir) => {
      const { events, out } = collector();
      const script = "process.stdout.write('tail without a newline');";
      const step = await runStep("tail", nodeBin, ["-e", script], { logDir, out });
      expect(step.ok).toBe(true);
      const lines = events
        .filter((event) => event.kind === "line" && event.stream === "stdout")
        .map((event) => event.text);
      expect(lines).toEqual(["tail without a newline"]);
      const logged = await readFile(join(logDir, "tail.log"), "utf8");
      expect(logged).toContain("tail without a newline");
    });
  }, 15_000);

  it("waits for a trapped grandchild until the escalation kills it", async () => {
    await withLogDir(async (logDir) => {
      const parentPidFile = join(logDir, "parent.pid");
      const grandPidFile = join(logDir, "grand.pid");
      const step = await runStep("mixed", nodeBin, ["-e", treeScript(false, true), parentPidFile, grandPidFile], {
        logDir,
        out: () => {},
        timeoutMs: 400,
        killGraceMs: 500,
      });
      expect(step.timedOut).toBe(true);
      const grandPid = await readPid(logDir, "grand.pid");
      // No polling here: the step must already have waited for the tree.
      expect(alive(grandPid)).toBe(false);
    });
  }, 20_000);
});

describe("the step timeout override", () => {
  const saved = process.env.RELEASE_GATE_STEP_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.RELEASE_GATE_STEP_TIMEOUT_MS;
    } else {
      process.env.RELEASE_GATE_STEP_TIMEOUT_MS = saved;
    }
  });

  it("reads the default, the disable value, and plain numbers", () => {
    const cases: Array<[string | undefined, number]> = [
      [undefined, 1_800_000],
      ["", 1_800_000],
      ["   ", 1_800_000],
      ["0", Number.POSITIVE_INFINITY],
      ["900000", 900_000],
    ];
    for (const [raw, expected] of cases) {
      if (raw === undefined) {
        delete process.env.RELEASE_GATE_STEP_TIMEOUT_MS;
      } else {
        process.env.RELEASE_GATE_STEP_TIMEOUT_MS = raw;
      }
      expect(stepTimeoutFromEnvironment(), `value ${JSON.stringify(raw)}`).toBe(expected);
    }
  });

  it("rejects values that are not non-negative numbers", () => {
    for (const raw of ["abc", "-1", "1.5.2"]) {
      process.env.RELEASE_GATE_STEP_TIMEOUT_MS = raw;
      expect(() => stepTimeoutFromEnvironment(), `value ${JSON.stringify(raw)}`).toThrow(
        /RELEASE_GATE_STEP_TIMEOUT_MS must be a non-negative number/,
      );
    }
  });
});

describe("the gate command line", () => {
  it("exits 130 with the interrupt verdict when SIGINT arrives mid-step", async () => {
    const child = spawn(nodeBin, [gateScript], {
      cwd: repoRoot,
      env: { ...process.env, TEST_DATABASE_URL: "postgres://gate-test@localhost/postgres" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let signaled = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!signaled && output.includes("▶ ")) {
        signaled = true;
        child.kill("SIGINT");
      }
    });
    const exit = await new Promise<number | null>((resolvePromise) => {
      child.once("close", (code) => resolvePromise(code));
    });
    expect(signaled).toBe(true);
    expect(exit).toBe(130);
    expect(output).toMatch(/Verdict: INTERRUPTED \(SIGINT\)/);
    expect(output).toMatch(/logs kept/i);
  }, 30_000);

  it("rejects a non-numeric timeout override before any check runs", async () => {
    const child = spawn(nodeBin, [gateScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TEST_DATABASE_URL: "postgres://gate-test@localhost/postgres",
        RELEASE_GATE_STEP_TIMEOUT_MS: "abc",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    const exit = await new Promise<number | null>((resolvePromise) => {
      child.once("close", (code) => resolvePromise(code));
    });
    expect(exit).toBe(1);
    expect(errors).toMatch(/RELEASE_GATE_STEP_TIMEOUT_MS must be a non-negative number/);
  }, 30_000);

  it("refuses to run without a test database", async () => {
    const env = { ...process.env };
    delete env.TEST_DATABASE_URL;
    const child = spawn(nodeBin, [gateScript], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    const exit = await new Promise<number | null>((resolvePromise) => {
      child.once("close", (code) => resolvePromise(code));
    });
    expect(exit).toBe(1);
    expect(errors).toMatch(/TEST_DATABASE_URL is not set/);
  }, 30_000);
});
