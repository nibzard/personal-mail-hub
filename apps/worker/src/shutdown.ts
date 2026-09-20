/*
 * The worker's SIGTERM path (SPEC section 10). Stopping is two steps: the
 * cycle signal aborts, so no account beyond the current one starts, and the
 * queue stops gracefully, so the in-flight cycle transaction commits before
 * the queue tears down. A rejected queue stop is reported and fails the
 * exit instead of passing silently; the pool closes either way.
 */

/**
 * How long the graceful stop waits for the in-flight cycle. The bound stays
 * under the ten seconds a default `docker stop` gives the runtime before
 * SIGKILL, so the wait is a real chance to commit, not a wish.
 */
export const SHUTDOWN_GRACE_MS = 8000;

/** The queue surface the shutdown path needs; tests substitute this. */
export interface StoppableQueue {
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
}

/** The pool surface the shutdown path needs; tests substitute this. */
export interface EndablePool {
  end(): Promise<void>;
}

/** Where the shutdown path reports a failure it cannot recover from. */
export type ShutdownReporter = (message: string) => void;

/**
 * Runs the shutdown sequence and returns the process exit code it earned.
 * The pool closes on every path, so a failing queue stop never leaks the
 * connections the exit still needs to drain.
 */
export async function stopWorker(input: {
  queue: StoppableQueue;
  pool: EndablePool;
  shutdown: AbortController;
  report?: ShutdownReporter;
}): Promise<number> {
  input.shutdown.abort();
  try {
    await input.queue.stop({ graceful: true, timeout: SHUTDOWN_GRACE_MS });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    input.report?.(`Queue stop failed: ${detail}. The in-flight cycle may not have committed.`);
    await input.pool.end().catch(() => undefined);
    return 1;
  }
  await input.pool.end().catch(() => undefined);
  return 0;
}
