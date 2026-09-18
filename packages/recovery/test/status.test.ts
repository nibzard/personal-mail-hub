import { describe, expect, it } from "vitest";
import {
  assessJob,
  classifyControlState,
  decideMutationGate,
  describeControlStatus,
  parseDeploymentGeneration,
  type ControlStatus,
} from "../src/index.ts";

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";

const READY_A: ControlStatus = { state: "ready", generation: GENERATION_A };
const RECONCILING_A: ControlStatus = { state: "reconciling", generation: GENERATION_A };
const UNINITIALIZED_A: ControlStatus = { state: "uninitialized", deploymentGeneration: GENERATION_A };
const MISMATCH_A_B: ControlStatus = {
  state: "generation_mismatch",
  deploymentGeneration: GENERATION_A,
  databaseGeneration: GENERATION_B,
  mode: "ready",
};
const CONFIG_MISSING: ControlStatus = { state: "config_missing" };

describe("parseDeploymentGeneration", () => {
  it("accepts a UUID in any letter case", () => {
    expect(parseDeploymentGeneration(GENERATION_A)).toBe(GENERATION_A);
    expect(parseDeploymentGeneration(GENERATION_A.toUpperCase())).toBe(GENERATION_A);
    expect(parseDeploymentGeneration(`  ${GENERATION_A}  `)).toBe(GENERATION_A);
  });

  it("rejects absent or malformed values", () => {
    expect(parseDeploymentGeneration(undefined)).toBeNull();
    expect(parseDeploymentGeneration("")).toBeNull();
    expect(parseDeploymentGeneration("not-a-uuid")).toBeNull();
    expect(parseDeploymentGeneration("11111111-1111-4111-8111-11111111111")).toBeNull();
  });
});

describe("classifyControlState", () => {
  it("blocks when deployment configuration is missing", () => {
    expect(classifyControlState({ recoveryGeneration: GENERATION_A, recoveryMode: "ready" }, null)).toEqual(
      CONFIG_MISSING,
    );
  });

  it("reports a database without control state as uninitialized", () => {
    expect(classifyControlState(null, GENERATION_A)).toEqual(UNINITIALIZED_A);
  });

  it("agrees on ready and reconciling generations", () => {
    expect(classifyControlState({ recoveryGeneration: GENERATION_A, recoveryMode: "ready" }, GENERATION_A)).toEqual(
      READY_A,
    );
    expect(
      classifyControlState({ recoveryGeneration: GENERATION_A, recoveryMode: "reconciling" }, GENERATION_A),
    ).toEqual(RECONCILING_A);
  });

  it("reports a mismatch with both generations", () => {
    expect(classifyControlState({ recoveryGeneration: GENERATION_B, recoveryMode: "ready" }, GENERATION_A)).toEqual(
      MISMATCH_A_B,
    );
  });
});

describe("decideMutationGate", () => {
  it("rejects requests without a usable generation", () => {
    expect(decideMutationGate(READY_A, undefined)).toEqual({ decision: "invalid_generation" });
    expect(decideMutationGate(READY_A, null)).toEqual({ decision: "invalid_generation" });
    expect(decideMutationGate(READY_A, "junk")).toEqual({ decision: "invalid_generation" });
  });

  it("keeps requests blocked and retryable without deployment configuration", () => {
    expect(decideMutationGate(CONFIG_MISSING, GENERATION_A)).toEqual({ decision: "recovery_in_progress" });
  });

  it("allows a matching generation once ready", () => {
    expect(decideMutationGate(READY_A, GENERATION_A)).toEqual({ decision: "allow", generation: GENERATION_A });
    expect(decideMutationGate(READY_A, GENERATION_A.toUpperCase())).toEqual({
      decision: "allow",
      generation: GENERATION_A,
    });
  });

  it("rejects an old generation before any idempotency lookup", () => {
    expect(decideMutationGate(READY_A, GENERATION_B)).toEqual({
      decision: "recovery_required",
      currentGeneration: GENERATION_A,
    });
    // The request key is absent from a restored database; the old generation
    // still blocks it (SPEC section 10).
    expect(decideMutationGate(MISMATCH_A_B, GENERATION_B)).toEqual({
      decision: "recovery_required",
      currentGeneration: GENERATION_A,
    });
  });

  it("holds a matching generation until the state is ready", () => {
    expect(decideMutationGate(RECONCILING_A, GENERATION_A)).toEqual({ decision: "recovery_in_progress" });
    expect(decideMutationGate(UNINITIALIZED_A, GENERATION_A)).toEqual({ decision: "recovery_in_progress" });
    expect(decideMutationGate(MISMATCH_A_B, GENERATION_A)).toEqual({ decision: "recovery_in_progress" });
    expect(decideMutationGate(UNINITIALIZED_A, GENERATION_B)).toEqual({
      decision: "recovery_required",
      currentGeneration: GENERATION_A,
    });
  });
});

describe("assessJob", () => {
  it("executes only current-generation jobs once ready", () => {
    expect(assessJob(READY_A, GENERATION_A)).toBe("execute");
    expect(assessJob(READY_A, GENERATION_A.toUpperCase())).toBe("execute");
    expect(assessJob(READY_A, GENERATION_B)).toBe("stale");
  });

  it("blocks every job unless the control state is ready", () => {
    expect(assessJob(RECONCILING_A, GENERATION_A)).toBe("blocked");
    expect(assessJob(UNINITIALIZED_A, GENERATION_A)).toBe("blocked");
    expect(assessJob(MISMATCH_A_B, GENERATION_B)).toBe("blocked");
    expect(assessJob(CONFIG_MISSING, GENERATION_A)).toBe("blocked");
  });
});

describe("describeControlStatus", () => {
  it("names each state without secrets", () => {
    expect(describeControlStatus(READY_A)).toContain("ready");
    expect(describeControlStatus(CONFIG_MISSING)).toContain("RECOVERY_GENERATION");
    expect(describeControlStatus(MISMATCH_A_B)).toContain("generation mismatch");
    expect(describeControlStatus(UNINITIALIZED_A)).toContain("uninitialized");
    expect(describeControlStatus(RECONCILING_A)).toContain("reconciling");
  });
});
