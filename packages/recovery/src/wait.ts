import type { ControlStatus } from "./status.ts";

/** The control status that unblocks workers. */
export interface ReadyStatus {
  state: "ready";
  generation: string;
}

export interface WaitForReadyOptions {
  /** Delay between control-state reads. The default is 5000 ms. */
  intervalMs?: number;
  /** Aborts the wait; the returned promise rejects. */
  signal?: AbortSignal;
  /** Receives every blocked status read. Callers report state changes. */
  onStatus?: (status: ControlStatus) => void;
}

/**
 * Wait until the control state is `ready`. Workers stay blocked while they
 * wait (SPEC section 10, step 2) instead of crashing, so they resume without
 * a restart once the operator completes recovery.
 */
export async function waitForReadyService(
  controls: { readStatus(): Promise<ControlStatus> },
  options: WaitForReadyOptions = {},
): Promise<ReadyStatus> {
  const intervalMs = options.intervalMs ?? 5000;
  for (;;) {
    const status = await controls.readStatus();
    if (status.state === "ready") {
      return status;
    }
    options.onStatus?.(status);
    await sleep(intervalMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Shutdown was requested while waiting for the recovery control state."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
