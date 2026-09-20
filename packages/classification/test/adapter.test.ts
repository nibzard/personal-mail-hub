import { describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_API_BASE_URL,
  JEV_MODEL,
  QUESTION_SET_VERSION,
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

/** Wire shape documented at https://docs.typesafe.ai/api (2026-09-20). */
function validPayload() {
  return {
    model: "jev-1.13.0",
    answers: {
      class_hint: {
        type: "choice", choice: "newsletter", confidence: 0.91,
        probabilities: { correspondence: 0.02, receipt: 0, newsletter: 0.95,
          notification: 0.01, marketing: 0.01, security_alert: 0, bounce: 0, other: 0.01 },
      },
      sender_relationship: {
        type: "choice", choice: "bulk_sender", confidence: 0.8,
        probabilities: { known_contact: 0.02, service_in_use: 0.06, bulk_sender: 0.9, unknown: 0.02 },
      },
      asks_action: { type: "noul", noul: 0.2 },
      asks_reply: { type: "noul", noul: 0.1 },
      time_sensitive: { type: "noul", noul: 0.05 },
    },
    usage: { input_tokens: 1843, output_tokens: 65 },
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
    expect(requests[0]!.url).toBe(`${DEFAULT_JEV_API_BASE_URL}/v1/systemone`);
    expect((requests[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(requests[0]!.init.body)) as {
      model: string;
      state: string;
      questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>;
    };
    expect(body.model).toBe("jev-1.13.0");
    expect(QUESTION_SET_VERSION).toBe("classify-2");
    expect(body).not.toHaveProperty("input");
    expect(body.state).toBe("From: a@b.example\nSubject: s\n\nbody");
    expect(Object.keys(body.questions)).toEqual([
      "class_hint",
      "sender_relationship",
      "asks_action",
      "asks_reply",
      "time_sensitive",
    ]);

    expect(body.questions.class_hint?.type).toBe("choice");
    expect(body.questions.class_hint?.criteria).toHaveProperty("correspondence");
    expect(body.questions.sender_relationship?.criteria).toHaveProperty("unknown");
    for (const key of ["asks_action", "asks_reply", "time_sensitive"]) {
      expect(body.questions[key]?.type).toBe("noul");
    }
    for (const question of Object.values(body.questions)) {
      expect(question.instructions.length).toBeGreaterThan(10);
    }
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

  it("reports a timeout when the response body stalls past the deadline", async () => {
    // The headers arrive; the body never does. Only the abort can end the
    // read, so the deadline must still cover `response.json()`: cleared at
    // the fetch, the timer leaves the caller hung forever.
    const transport = (async (_url: string | URL, init: RequestInit) => {
      const signal = init.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () =>
              controller.error(new Error("The operation was aborted.")),
            );
          },
        }),
      );
    }) as typeof fetch;
    const failing = new TypeSafeJevAdapter({ apiKey: "test-key", timeoutMs: 50, fetch: transport });
    await expect(failing.ask({ text: "x" })).rejects.toMatchObject({
      kind: "timeout",
      name: "JevAdapterError",
    } satisfies Partial<JevAdapterError>);
  }, 2_000);

  it("reports a request failure on an error status", async () => {
    const { transport } = recordingTransport({ error: "rate limited" }, 429);
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "request_failed" });
  });

  it("reports an invalid response when an answer sits outside the offered set", async () => {
    const payload = validPayload();
    payload.answers.class_hint.choice = "urgent_letter";
    const { transport } = recordingTransport(payload);
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([0, 0.2, 0.5, 0.8, 1])("preserves a Noul probability of %s for the action gate", async (probability) => {
    const payload = validPayload();
    payload.answers.asks_action.noul = probability;
    const { transport } = recordingTransport(payload);
    const decision = await adapter(transport).ask({ text: "x" });
    expect(decision.answers.asksAction).toBe(probability > 0.5);
    expect(decision.confidence.asksAction).toBe(probability);
  });

  it.each([-0.1, 1.1, null, "yes", true])("rejects an invalid Noul value (%s)", async (value) => {
    const payload = validPayload();
    Object.assign(payload.answers.asks_action, { noul: value });
    const { transport } = recordingTransport(payload);
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each(["class_hint", "sender_relationship", "asks_action", "asks_reply", "time_sensitive"])(
    "rejects a missing or wrongly typed %s answer", async (key) => {
      for (const replacement of [undefined, { type: "score", score: 1 }]) {
        const payload = validPayload();
        Object.assign(payload.answers, { [key]: replacement });
        const { transport } = recordingTransport(payload);
        await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
      }
    },
  );

  it("rejects a response from a different model", async () => {
    const payload = validPayload();
    payload.model = "different-model";
    const { transport } = recordingTransport(payload);
    await expect(adapter(transport).ask({ text: "x" })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("does not invent confidence when the choice omits it", async () => {
    const payload = validPayload();
    Object.assign(payload.answers.class_hint, { confidence: undefined });
    const { transport } = recordingTransport(payload);
    expect((await adapter(transport).ask({ text: "x" })).confidence.classHint).toBeNull();
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
