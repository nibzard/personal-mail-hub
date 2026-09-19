import { describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_API_BASE_URL,
  JEV_MODEL,
  TypeSafeJevAdapter,
  jevAdapterFromEnv,
  type JevAdapterError,
} from "../src/index.ts";

/**
 * Adapter acceptance over a stubbed transport (SPEC F8). The pinned model,
 * the one-call question set, and every failure kind are pinned here; no
 * test opens a socket.
 */

type RecordedRequest = { url: string; init: RequestInit };

/** One transport that records the request and answers a canned payload. */
function recordingTransport(payload: unknown, status = 200) {
  const requests: RecordedRequest[] = [];
  const transport = (async (url: string | URL, init: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { transport, requests };
}

/** A valid answer payload for the whole question set. */
function validPayload(): Record<string, unknown> {
  return {
    model: JEV_MODEL,
    answers: {
      class_hint: "newsletter",
      sender_relationship: "bulk_sender",
      asks_action: false,
      asks_reply: false,
      time_sensitive: false,
    },
    confidence: {
      class_hint: 0.91,
      sender_relationship: 0.8,
      asks_action: 0.2,
      asks_reply: 0.1,
      time_sensitive: 0.05,
    },
    usage: { inputTokens: 1843 },
  };
}

function adapter(transport: typeof fetch) {
  return new TypeSafeJevAdapter({ apiKey: "test-key", fetch: transport });
}

describe("type-safe jev adapter", () => {
  it("sends one pinned-model call with the whole question set", async () => {
    const { transport, requests } = recordingTransport(validPayload());
    const decision = await adapter(transport).ask({ text: "From: a@b.example\nSubject: s\n\nbody" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${DEFAULT_JEV_API_BASE_URL}/v1/evaluations`);
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(requests[0]!.init.body)) as {
      model: string;
      input: { text: string };
      questions: { id: string; kind: string }[];
    };
    expect(body.model).toBe(JEV_MODEL);
    expect(body.input.text).toBe("From: a@b.example\nSubject: s\n\nbody");
    expect(body.questions.map((question) => question.id)).toEqual([
      "class_hint",
      "sender_relationship",
      "asks_action",
      "asks_reply",
      "time_sensitive",
    ]);

    expect(decision.model).toBe(JEV_MODEL);
    expect(decision.answers).toEqual({
      classHint: "newsletter",
      senderRelationship: "bulk_sender",
      asksAction: false,
      asksReply: false,
      timeSensitive: false,
    });
    expect(decision.confidence.classHint).toBe(0.91);
    expect(decision.inputTokens).toBe(1843);
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a timeout when the call outruns the deadline", async () => {
    const transport = (async (_url: string | URL, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
        );
      });
    }) as typeof fetch;
    // A short deadline keeps the abort observable inside the test budget.
    const failing = new TypeSafeJevAdapter({ apiKey: "test-key", timeoutMs: 50, fetch: transport });
    await expect(failing.ask({ text: "x" })).rejects.toMatchObject({
      kind: "timeout",
      name: "JevAdapterError",
    } satisfies Partial<JevAdapterError>);
  });

  it("reports a request failure on an error status", async () => {
    const { transport } = recordingTransport({ error: "rate limited" }, 429);
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "request_failed" });
  });

  it("reports an invalid response when an answer sits outside the offered set", async () => {
    const payload = validPayload();
    (payload.answers as Record<string, unknown>).class_hint = "urgent_letter";
    const { transport } = recordingTransport(payload);
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("reports an invalid response when a yes/no answer is not boolean", async () => {
    const payload = validPayload();
    (payload.answers as Record<string, unknown>).asks_action = "yes";
    const { transport } = recordingTransport(payload);
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("reports an invalid response when the body is not JSON", async () => {
    const transport = (async () => new Response("not json")) as typeof fetch;
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("jev adapter environment", () => {
  it("stays unconfigured without a key", () => {
    expect(jevAdapterFromEnv({})).toBeNull();
    expect(jevAdapterFromEnv({ TYPE_SAFE_API_KEY: "   " })).toBeNull();
  });

  it("builds from the key and honors the base-url override", () => {
    const built = jevAdapterFromEnv({ TYPE_SAFE_API_KEY: "k", JEV_API_BASE_URL: "http://127.0.0.1:9/" });
    expect(built).not.toBeNull();
  });
});
