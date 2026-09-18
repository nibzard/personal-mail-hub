import { describe, expect, it } from "vitest";
import { waitForReadyService, type ControlStatus } from "../src/index.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";

/** Controls stub that replays a scripted status sequence. */
class ScriptedControls {
  reads = 0;

  constructor(private readonly statuses: ControlStatus[]) {}

  readStatus(): Promise<ControlStatus> {
    const status = this.statuses[Math.min(this.reads, this.statuses.length - 1)]!;
    this.reads += 1;
    return Promise.resolve(status);
  }
}

describe("waitForReadyService", () => {
  it("resolves once ready and reports each blocked status", async () => {
    const seen: string[] = [];
    const controls = new ScriptedControls([
      { state: "config_missing" },
      { state: "uninitialized", deploymentGeneration: GENERATION },
      { state: "ready", generation: GENERATION },
    ]);

    const ready = await waitForReadyService(controls, {
      intervalMs: 1,
      onStatus: (status) => seen.push(status.state),
    });

    expect(ready).toEqual({ state: "ready", generation: GENERATION });
    expect(seen).toEqual(["config_missing", "uninitialized"]);
  });

  it("rejects when shutdown is requested while blocked", async () => {
    const controls = new ScriptedControls([{ state: "config_missing" }]);
    const shutdown = new AbortController();

    const pending = waitForReadyService(controls, { intervalMs: 60_000, signal: shutdown.signal });
    shutdown.abort();

    await expect(pending).rejects.toThrow(/Shutdown was requested/);
  });
});
