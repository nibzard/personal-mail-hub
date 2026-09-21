import { describe, expect, it } from "vitest";
import type { JevAdapter, JevDecision } from "@mail-hub/classification";
import { runVerifyClassify, type VerifyClassifyIO } from "../src/verify-classify.ts";

/**
 * The synthetic smoke command (T108): one call, approved output fields only,
 * and an explicit unverified result when credentials are missing. The output
 * must never carry the API key or a raw response.
 */

const SENTINEL_KEY = "sentinel-key-value-must-not-print";

/** Captures command output for assertions. */
function capture() {
  let out = "";
  let err = "";
  const io: VerifyClassifyIO = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  return { io, out: () => out, err: () => err };
}

function decision(overrides: Partial<JevDecision> = {}): JevDecision {
  return {
    model: "jev-1.13.0",
    answers: {
      classHint: "notification",
      senderRelationship: "service_in_use",
      asksAction: false,
      asksReply: false,
      timeSensitive: false,
    },
    confidence: {
      classHint: 0.9,
      senderRelationship: 0.8,
      asksAction: 0.2,
      asksReply: 0.1,
      timeSensitive: 0.05,
    },
    latencyMs: 431,
    inputTokens: 96,
    ...overrides,
  };
}

/** A stub adapter the command tests control; no socket is opened. */
function stubAdapter(result: Promise<JevDecision> | Error): { adapter: JevAdapter; asked: string[] } {
  const asked: string[] = [];
  const adapter: JevAdapter = {
    async ask(input) {
      asked.push(input.text);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
  return { adapter, asked };
}

describe("runVerifyClassify", () => {
  it("reports an explicit unverified result when the key is missing", async () => {
    const { io, out } = capture();
    // The factory mirrors jevAdapterFromEnv: a blank key builds no adapter,
    // so no call can happen and the result states that.
    const code = await runVerifyClassify([], { TYPE_SAFE_API_KEY: "  " }, io, () => null);
    expect(code).toBe(1);
    expect(out()).toContain("UNVERIFIED");
    expect(out()).toContain("TYPE_SAFE_API_KEY");
    expect(out()).toContain("was not called");
  });

  it("prints approved fields only and verifies a parsed decision", async () => {
    const { adapter, asked } = stubAdapter(Promise.resolve(decision()));
    const { io, out } = capture();
    const code = await runVerifyClassify([], { TYPE_SAFE_API_KEY: SENTINEL_KEY }, io, () => adapter);
    expect(code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("invented for a service check");
    expect(out()).toContain("model=jev-1.13.0");
    expect(out()).toContain("questions=classify-2");
    expect(out()).toContain("class=notification");
    expect(out()).toContain("latencyMs=431");
    expect(out()).toContain("inputTokens=96");
    expect(out()).toContain("calls=1");
    expect(out()).toContain("VERIFIED");
    // The key never prints, and no raw response field exists to print.
    expect(out()).not.toContain(SENTINEL_KEY);
  });

  it("fails with the failure kind and keeps the message free of secrets", async () => {
    const kinds = [
      Object.assign(new Error("Jev did not answer within 10000 ms."), { kind: "timeout" }),
      Object.assign(new Error("The Jev evaluation endpoint answered with HTTP 429."), { kind: "request_failed" }),
      Object.assign(new Error("A Jev answer did not match its question type."), { kind: "invalid_response" }),
    ];
    for (const error of kinds) {
      const { adapter } = stubAdapter(error);
      const { io, out } = capture();
      const code = await runVerifyClassify([], { TYPE_SAFE_API_KEY: SENTINEL_KEY }, io, () => adapter);
      expect(code).toBe(1);
      expect(out()).toContain(`FAILED (${error.kind})`);
      expect(out()).not.toContain(SENTINEL_KEY);
    }
  });

  it("fails when the service reports a model other than the pinned one", async () => {
    const { adapter } = stubAdapter(Promise.resolve(decision({ model: "jev-1.12.0" })));
    const { io, out } = capture();
    const code = await runVerifyClassify([], { TYPE_SAFE_API_KEY: "k" }, io, () => adapter);
    expect(code).toBe(1);
    expect(out()).toContain("model_mismatch");
    expect(out()).toContain("jev-1.12.0");
  });

  it("prints usage and fails on unexpected arguments", async () => {
    const { io, out } = capture();
    const code = await runVerifyClassify(["--unexpected"], {}, io, () => null);
    expect(code).toBe(1);
    expect(out()).toContain("Usage: npm run verify:classify");
  });
});
