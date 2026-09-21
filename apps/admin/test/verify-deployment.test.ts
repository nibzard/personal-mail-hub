import { describe, expect, it } from "vitest";
// The verifier is a plain Node script, so it carries no type declarations;
// the pure engine under test is pinned here.
// @ts-expect-error No declaration file for the deploy script.
import { aggregateVerdict, classificationFromRows, classifyAccountProgress, classifyContainerStatus, folderAggregatesFromRows, parseDockerInspect, parseDockerPs, parsePsqlRows, resolveStackContainers, revisionMatches } from "../../../deploy/verify-deployment.mjs";

/**
 * The pure engine of deploy/verify-deployment.mjs (T111). The verdicts must
 * stay honest: pending work without movement fails, idle never does, and
 * missing evidence keeps the result unverified.
 */

const PS_ROWS = [
  "mail-hub-api-1\tapi\tmail-hub-api\tUp 2 minutes (healthy)",
  "mail-hub-worker-1\tworker\tmail-hub-worker\tUp 2 minutes",
  "mail-hub-web-1\tweb\tmail-hub-web\tUp 2 minutes",
  "mail-hub-db-1\tdb\tpostgres:16-alpine\tUp 3 minutes (healthy)",
].join("\n");

describe("parseDockerPs", () => {
  it("splits label-filtered rows into containers", () => {
    const containers = parseDockerPs(PS_ROWS);
    expect(containers).toHaveLength(4);
    expect(containers[0]).toEqual({
      name: "mail-hub-api-1",
      service: "api",
      image: "mail-hub-api",
      status: "Up 2 minutes (healthy)",
    });
  });

  it("skips malformed and empty rows instead of guessing", () => {
    expect(parseDockerPs("only-one-column\n\nnoise\ttoo\tfew\n")).toEqual([]);
    expect(parseDockerPs("")).toEqual([]);
  });
});

describe("classifyContainerStatus", () => {
  it("reads healthy, plain, and unhealthy running containers", () => {
    expect(classifyContainerStatus("Up 2 minutes (healthy)")).toMatchObject({ running: true, health: "healthy" });
    expect(classifyContainerStatus("Up 2 minutes")).toMatchObject({ running: true, health: "none" });
    expect(classifyContainerStatus("Up 2 minutes (unhealthy)")).toMatchObject({ running: true, health: "unhealthy" });
  });

  it("reads health still starting and paused containers as inconclusive", () => {
    expect(classifyContainerStatus("Up 5 seconds (health: starting)")).toMatchObject({
      running: true,
      health: "starting",
    });
    expect(classifyContainerStatus("Up 2 minutes (Paused)")).toMatchObject({ running: true, paused: true });
    expect(classifyContainerStatus("Up 2 minutes (healthy)")).toMatchObject({ paused: false });
  });

  it("reads restart loops and exits with their codes", () => {
    expect(classifyContainerStatus("Restarting (1) 7 seconds ago")).toMatchObject({
      running: false,
      restarting: true,
    });
    expect(classifyContainerStatus("Exited (137) 3 hours ago")).toMatchObject({ exited: true, exitCode: 137 });
  });

  it("marks unknown status text as not running and unknown health", () => {
    expect(classifyContainerStatus("Created")).toMatchObject({ running: false, health: "unknown" });
    expect(classifyContainerStatus(undefined)).toMatchObject({ health: "unknown" });
  });
});

describe("resolveStackContainers", () => {
  it("separates application services from the database without name rules", () => {
    const stack = resolveStackContainers(parseDockerPs(PS_ROWS), { project: "mail-hub", dbContainer: "" });
    expect(stack.app.map((container: { service: string | null }) => container.service)).toEqual([
      "api",
      "worker",
      "web",
    ]);
    expect(stack.db).toMatchObject({ service: "db", image: "postgres:16-alpine" });
  });

  it("falls back to name segments when labels are missing", () => {
    // A missing compose label prints an empty service column.
    const unlabeled = parseDockerPs("somestack-api-x7f\t\timg\tUp 1 minute\nsomestack-db-q9k\t\tpostgres:16\tUp 1 minute");
    const stack = resolveStackContainers(unlabeled, { project: "somestack", dbContainer: "" });
    expect(stack.app).toHaveLength(1);
    expect(stack.db).toMatchObject({ image: "postgres:16" });
  });

  it("reports an empty stack and honors the database override", () => {
    const empty = resolveStackContainers([], { project: "mail-hub", dbContainer: "" });
    expect(empty.app).toEqual([]);
    expect(empty.db).toBeNull();
    const overridden = resolveStackContainers([], { project: "mail-hub", dbContainer: "coolify-pg-1" });
    expect(overridden.db).toMatchObject({ name: "coolify-pg-1", explicit: true });
  });
});

describe("parseDockerInspect and revisionMatches", () => {
  const INSPECT =
    "2\t2026-09-21T01:00:00Z\trunning\tmail-hub-api:latest\tsha256:abc123\t";

  it("reads restarts, state, image identity, and the absent label", () => {
    expect(parseDockerInspect(INSPECT)).toEqual({
      restartCount: 2,
      startedAt: "2026-09-21T01:00:00Z",
      state: "running",
      image: "mail-hub-api:latest",
      imageId: "sha256:abc123",
      revision: null,
    });
    expect(parseDockerInspect("")).toBeNull();
  });

  it("matches the expectation against the image reference, label, or digest", () => {
    expect(revisionMatches({ image: "ghcr.io/x/mail-hub:9c1f2ab", revision: null }, "9c1f2ab")).toBe(true);
    expect(revisionMatches({ image: "mail-hub-api:latest", revision: "9c1f2ab" }, "9c1f2ab")).toBe(true);
    expect(
      revisionMatches({ image: "mail-hub-api", revision: null, imageId: "sha256:063eb60c" }, "sha256:063eb60c"),
    ).toBe(true);
    expect(
      revisionMatches({ image: "mail-hub-api", revision: null, imageId: "sha256:063eb60c" }, "063eb60c"),
    ).toBe(true);
    expect(revisionMatches({ image: "mail-hub-api:latest", revision: null }, "deadbeef")).toBe(false);
  });

  it("matches nothing for an empty expectation", () => {
    expect(revisionMatches({ image: "mail-hub-api", revision: null }, "")).toBe(false);
    expect(revisionMatches({ image: "mail-hub-api", revision: null }, null)).toBe(false);
  });
});

describe("psql row parsing", () => {
  it("parses aggregate rows and drops empty results", () => {
    expect(parsePsqlRows("a1|3|1|2|0\na2|2|2|0|0\n")).toEqual([
      ["a1", "3", "1", "2", "0"],
      ["a2", "2", "2", "0", "0"],
    ]);
    expect(parsePsqlRows("")).toEqual([]);
  });

  it("lifts folder and classification aggregates, skipping short rows", () => {
    expect(folderAggregatesFromRows([["a1", "4", "3", "1", "0"], ["bad"]])).toEqual([
      { accountId: "a1", folders: 4, complete: 3, backfilling: 1, unscanned: 0 },
    ]);
    expect(classificationFromRows([["a1", "10", "7"]])).toEqual([{ accountId: "a1", messages: 10, decided: 7 }]);
  });
});

/** One account snapshot, the shape the health report carries. */
function account(overrides: Record<string, unknown> & { sync?: Record<string, unknown> }) {
  return {
    accountId: "a1",
    sync: {
      state: "ok",
      lastCycleAt: "2026-09-21T01:00:00Z",
      pendingBodies: 0,
      backfillPendingFolders: 0,
      pendingThreads: 0,
      ...(overrides.sync ?? {}),
    },
  };
}

const FOLDERS_A1 = [{ accountId: "a1", folders: 4, complete: 2, backfilling: 2, unscanned: 0 }];

describe("classifyAccountProgress", () => {
  it("reads an account without pending work as idle, first sample or not", () => {
    expect(classifyAccountProgress(undefined, account({}), FOLDERS_A1, FOLDERS_A1)).toBe("idle");
  });

  it("lets a degraded cycle fail even with no pending work", () => {
    const failing = account({ sync: { state: "degraded", folderErrors: 2 } });
    expect(classifyAccountProgress(account({}), failing, FOLDERS_A1, FOLDERS_A1)).toBe("failing");
  });

  it("lets a stale sync record fail even with no pending work", () => {
    // Stale means no cycle was recorded for the stale window: the worker
    // stopped cycling behind healthy containers.
    const stale = account({ sync: { state: "stale" } });
    expect(classifyAccountProgress(stale, stale, [], [])).toBe("failing");
  });

  it("reads shrinking pending counters as progressing", () => {
    const before = account({ sync: { pendingBodies: 10, lastCycleAt: "2026-09-21T01:00:00Z" } });
    const after = account({ sync: { pendingBodies: 7, lastCycleAt: "2026-09-21T01:00:30Z" } });
    expect(classifyAccountProgress(before, after, FOLDERS_A1, FOLDERS_A1)).toBe("progressing");
  });

  it("reads growing pending counters as progressing, not stalled", () => {
    // Discovery grows the backlog while the worker runs; two samples inside
    // one cycle share lastCycleAt, so growth is the visible movement.
    const before = account({ sync: { pendingBodies: 100, lastCycleAt: "T1" } });
    const after = account({ sync: { pendingBodies: 120, lastCycleAt: "T1" } });
    expect(classifyAccountProgress(before, after, [], [])).toBe("progressing");
  });

  it("reads advancing folder checkpoints as progressing", () => {
    const before = account({ sync: { pendingBodies: 5 } });
    const after = account({ sync: { pendingBodies: 5 } });
    const foldersAfter = [{ accountId: "a1", folders: 4, complete: 3, backfilling: 1, unscanned: 0 }];
    expect(classifyAccountProgress(before, after, FOLDERS_A1, foldersAfter)).toBe("progressing");
  });

  it("fails the healthy-container-broken-sync case: pending work, no movement", () => {
    const before = account({ sync: { pendingBodies: 5, backfillPendingFolders: 2 } });
    const after = account({ sync: { pendingBodies: 5, backfillPendingFolders: 2 } });
    expect(classifyAccountProgress(before, after, FOLDERS_A1, FOLDERS_A1)).toBe("stalled");
  });

  it("refuses to guess without a first sample", () => {
    const after = account({ sync: { pendingBodies: 1 } });
    expect(classifyAccountProgress(undefined, after, undefined, FOLDERS_A1)).toBe("unknown");
  });

  it("treats null counters as zero pending work", () => {
    const after = account({ sync: { pendingBodies: null, backfillPendingFolders: null, pendingThreads: null } });
    expect(classifyAccountProgress(undefined, after, undefined, undefined)).toBe("idle");
  });
});

describe("aggregateVerdict", () => {
  const section = (name: string, outcome: string) => ({ name, outcome });

  it("fails when any section failed", () => {
    expect(
      aggregateVerdict([section("containers", "verified"), section("progress", "failed")]).verdict,
    ).toBe("failed");
  });

  it("stays unverified while any section could not run", () => {
    const outcome = aggregateVerdict([
      section("containers", "verified"),
      section("health", "unverified"),
    ]);
    expect(outcome.verdict).toBe("unverified");
    expect(outcome.unavailable).toHaveLength(1);
  });

  it("verifies only a complete passing picture", () => {
    expect(
      aggregateVerdict([section("containers", "verified"), section("health", "verified")]).verdict,
    ).toBe("verified");
  });
});
