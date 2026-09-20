import { describe, expect, it } from "vitest";
import { SHUTDOWN_GRACE_MS, type StoppableQueue } from "../src/shutdown.ts";

/*
 * The worker's signal path across startup. A signal that arrives before the
 * queue exists only aborts; once setup arms the stop gate, the stop runs —
 * also for a signal that arrived mid-setup and was consumed while no gate
 * existed. The graceful stop runs exactly once however many signals follow.
 */

process.env.DATABASE_URL ??= "postgresql://worker-tests.invalid/db";
const { installWorkerSignals } = await import("../src/main.ts");

/** One queue double that records stop calls and can resolve or reject them. */
function queueDouble(outcome: "resolve" | "reject" = "resolve") {
  const calls: Array<{ graceful?: boolean; timeout?: number } | undefined> = [];
  const queue: StoppableQueue & { calls: typeof calls } = {
    calls,
    stop(options) {
      calls.push(options);
      if (outcome === "reject") {
        return Promise.reject(new Error("the queue schema is locked"));
      }
      return Promise.resolve();
    },
  };
  return queue;
}

/** One signals harness with recording doubles in place of the process. */
function harness() {
  const listeners: Array<() => void> = [];
  const poolEvents: string[] = [];
  const exitCodes: number[] = [];
  const reports: string[] = [];
  const signals = installWorkerSignals({
    pool: { end: () => (poolEvents.push("pool-end"), Promise.resolve()) },
    report: (message) => reports.push(message),
    setExitCode: (code) => exitCodes.push(code),
    onSignal: (listener) => listeners.push(listener),
  });
  return {
    signals,
    /** Delivers one SIGINT or SIGTERM the way the process would. */
    signal: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    poolEvents,
    exitCodes,
    reports,
  };
}

/** Lets the fire-and-forget stop settle before the assertions read it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installWorkerSignals", () => {
  it("stops the worker at the end of setup for a signal that arrived during startup", async () => {
    const { signals, signal, poolEvents, exitCodes } = harness();
    const queue = queueDouble();

    // The signal arrives mid-setup: the abort is all it can do, because no
    // queue exists yet for a stop to tear down.
    signal();
    expect(signals.shutdown.signal.aborted).toBe(true);
    expect(queue.calls).toEqual([]);

    // Setup completes; the stop the consumed signal never ran runs now.
    expect(signals.armStop(queue)).toBe(true);
    await flush();

    expect(queue.calls).toEqual([{ graceful: true, timeout: SHUTDOWN_GRACE_MS }]);
    expect(poolEvents).toEqual(["pool-end"]);
    expect(exitCodes).toEqual([0]);
  });

  it("stops the worker for a signal after setup, once, whatever follows", async () => {
    const { signals, signal, poolEvents, exitCodes } = harness();
    const queue = queueDouble();

    expect(signals.armStop(queue)).toBe(false);
    signal();
    signal();
    await flush();

    expect(queue.calls).toHaveLength(1);
    expect(poolEvents).toEqual(["pool-end"]);
    expect(exitCodes).toEqual([0]);
  });

  it("reports a rejected queue stop and fails the exit, pool still closed", async () => {
    const { signals, signal, poolEvents, exitCodes, reports } = harness();
    const queue = queueDouble("reject");

    expect(signals.armStop(queue)).toBe(false);
    signal();
    await flush();

    expect(exitCodes).toEqual([1]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Queue stop failed: the queue schema is locked");
    expect(poolEvents).toEqual(["pool-end"]);
  });

  it("arms without stopping when no signal arrived", async () => {
    const { signals, poolEvents, exitCodes } = harness();
    const queue = queueDouble();

    expect(signals.armStop(queue)).toBe(false);

    expect(queue.calls).toEqual([]);
    expect(poolEvents).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});
