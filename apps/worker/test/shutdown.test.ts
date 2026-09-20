import { describe, expect, it } from "vitest";
import { SHUTDOWN_GRACE_MS, stopWorker, type StoppableQueue } from "../src/shutdown.ts";

/*
 * The worker's SIGTERM path: the queue stops gracefully — the in-flight
 * cycle commits before the queue tears down — and a rejected stop is
 * reported and fails the exit instead of passing silently. The pool closes
 * on every path.
 */

/** One queue double that records the stop call and can resolve or reject it. */
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

/** One pool double that records when end() ran. */
function poolDouble() {
  const events: string[] = [];
  return { events, pool: { end: () => (events.push("pool-end"), Promise.resolve()) } };
}

describe("stopWorker", () => {
  it("stops the queue gracefully with the shutdown grace, then closes the pool", async () => {
    const queue = queueDouble();
    const { events, pool } = poolDouble();
    const shutdown = new AbortController();

    const code = await stopWorker({ queue, pool, shutdown });

    expect(code).toBe(0);
    expect(queue.calls).toEqual([{ graceful: true, timeout: SHUTDOWN_GRACE_MS }]);
    expect(shutdown.signal.aborted).toBe(true);
    expect(events).toEqual(["pool-end"]);
  });

  it("waits for the graceful stop before the pool closes", async () => {
    const order: string[] = [];
    const queue: StoppableQueue = {
      stop: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            order.push("queue-stopped");
            resolve();
          }, 5);
        }),
    };
    const pool = { end: () => (order.push("pool-end"), Promise.resolve()) };

    const code = await stopWorker({ queue, pool, shutdown: new AbortController() });

    expect(code).toBe(0);
    // The in-flight cycle settles inside queue.stop; the pool may only close
    // after it, or the commit loses its connections first.
    expect(order).toEqual(["queue-stopped", "pool-end"]);
  });

  it("reports a rejected queue stop and exits non-zero, pool still closed", async () => {
    const queue = queueDouble("reject");
    const { events, pool } = poolDouble();
    const reports: string[] = [];

    const code = await stopWorker({
      queue,
      pool,
      shutdown: new AbortController(),
      report: (message) => reports.push(message),
    });

    expect(code).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Queue stop failed: the queue schema is locked");
    expect(events).toEqual(["pool-end"]);
  });
});
