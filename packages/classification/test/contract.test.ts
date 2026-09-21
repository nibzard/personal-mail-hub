import { describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_API_BASE_URL,
  JEV_MODEL,
  TypeSafeJevAdapter,
} from "../src/index.ts";
import {
  CONTRACT_AUTHENTICATION,
  CONTRACT_BODY_KEYS,
  CONTRACT_CONTENT_TYPE,
  CONTRACT_ENDPOINT_PATH,
  CONTRACT_ERROR_RESPONSES,
  CONTRACT_METHOD,
  CONTRACT_PROVENANCE,
  CONTRACT_REQUEST_QUESTIONS,
  CONTRACT_SUCCESS_RESPONSE,
} from "./fixtures/typesafe-contract.ts";

/**
 * The offline contract check (T108): what the adapter sends and accepts must
 * equal the documented fixture, and a deliberately incorrect fixture must
 * fail the comparison. No test opens a socket.
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

/** The request the real adapter emits for one synthetic message. */
async function emittedRequest(): Promise<{
  url: URL;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}> {
  const { transport, requests } = recordingTransport(structuredClone(CONTRACT_SUCCESS_RESPONSE));
  await new TypeSafeJevAdapter({ apiKey: "contract-test-key", fetch: transport }).ask({
    text: "From: contract@example.net\nSubject: s\n\nbody",
  });
  const request = requests[0]!;
  return {
    url: new URL(request.url),
    method: String(request.init.method),
    body: JSON.parse(String(request.init.body)) as Record<string, unknown>,
    headers: request.init.headers as Record<string, string>,
  };
}

/** The adapter request judged against one contract; every field must match. */
function requestMatchesContract(
  request: { url: URL; method: string; body: Record<string, unknown>; headers: Record<string, string> },
  contract: { endpointPath: string; method: string; model: string; questions: unknown },
): boolean {
  return (
    request.method === contract.method &&
    request.url.pathname === contract.endpointPath &&
    request.body.model === contract.model &&
    JSON.stringify(request.body.questions) === JSON.stringify(contract.questions)
  );
}

/** The working contract, as the fixture states it. */
function fixtureContract() {
  return {
    endpointPath: CONTRACT_ENDPOINT_PATH,
    method: CONTRACT_METHOD,
    model: CONTRACT_PROVENANCE.reviewedModel,
    questions: CONTRACT_REQUEST_QUESTIONS,
  };
}

describe("type-safe contract fixtures", () => {
  it("keeps the fixture provenance current and pinned to the adapter model", () => {
    // A stale review date or an unpinned model must not pass silently.
    expect(CONTRACT_PROVENANCE.documentation).toBe("https://docs.typesafe.ai/api");
    expect(CONTRACT_PROVENANCE.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CONTRACT_PROVENANCE.reviewedModel).toBe(JEV_MODEL);
  });

  it("sends exactly the documented request: endpoint, method, auth, headers, body keys", async () => {
    const request = await emittedRequest();
    const contract = fixtureContract();

    expect(requestMatchesContract(request, contract)).toBe(true);
    expect(request.url.origin).toBe(DEFAULT_JEV_API_BASE_URL);
    expect(request.url.search).toBe("");
    expect(request.headers.Authorization?.startsWith("Bearer ")).toBe(true);
    expect(request.headers["Content-Type"]).toBe(CONTRACT_CONTENT_TYPE);
    expect(Object.keys(request.body).sort()).toEqual([...CONTRACT_BODY_KEYS].sort());
    expect(request.body.state).toBe("From: contract@example.net\nSubject: s\n\nbody");
    expect(CONTRACT_AUTHENTICATION).toBe("bearer");
  });

  it.each([
    ["method", { endpointPath: CONTRACT_ENDPOINT_PATH, method: "GET", model: CONTRACT_PROVENANCE.reviewedModel, questions: CONTRACT_REQUEST_QUESTIONS }],
    ["endpoint", { endpointPath: "/v1/evaluate", method: CONTRACT_METHOD, model: CONTRACT_PROVENANCE.reviewedModel, questions: CONTRACT_REQUEST_QUESTIONS }],
    ["model", { endpointPath: CONTRACT_ENDPOINT_PATH, method: CONTRACT_METHOD, model: "jev-1.12.0", questions: CONTRACT_REQUEST_QUESTIONS }],
    [
      "question set",
      {
        endpointPath: CONTRACT_ENDPOINT_PATH,
        method: CONTRACT_METHOD,
        model: CONTRACT_PROVENANCE.reviewedModel,
        questions: { ...CONTRACT_REQUEST_QUESTIONS, asks_reply: undefined },
      },
    ],
    [
      "question typing",
      {
        endpointPath: CONTRACT_ENDPOINT_PATH,
        method: CONTRACT_METHOD,
        model: CONTRACT_PROVENANCE.reviewedModel,
        questions: {
          ...CONTRACT_REQUEST_QUESTIONS,
          class_hint: { ...CONTRACT_REQUEST_QUESTIONS.class_hint, type: "score" },
        },
      },
    ],
  ])("fails a deliberately incorrect %s fixture", async (_name, wrongContract) => {
    const request = await emittedRequest();
    expect(requestMatchesContract(request, wrongContract)).toBe(false);
  });

  it("accepts the documented success response and lifts its fields", async () => {
    const { transport } = recordingTransport(structuredClone(CONTRACT_SUCCESS_RESPONSE));
    const decision = await new TypeSafeJevAdapter({ apiKey: "k", fetch: transport }).ask({ text: "x" });

    expect(decision.model).toBe(CONTRACT_SUCCESS_RESPONSE.model);
    expect(decision.answers).toEqual({
      classHint: "newsletter",
      senderRelationship: "bulk_sender",
      asksAction: false,
      asksReply: false,
      timeSensitive: false,
    });
    expect(decision.confidence.classHint).toBe(0.91);
    expect(decision.confidence.asksAction).toBe(0.2);
    expect(decision.inputTokens).toBe(1843);
  });

  it("rejects response fixtures that corrupt the documented shape", async () => {
    const wrongModel = structuredClone(CONTRACT_SUCCESS_RESPONSE) as { model: string };
    wrongModel.model = "jev-1.12.0";
    await expect(
      new TypeSafeJevAdapter({ apiKey: "k", fetch: recordingTransport(wrongModel).transport }).ask({ text: "x" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });

    const wrongChoice = structuredClone(CONTRACT_SUCCESS_RESPONSE) as {
      answers: { class_hint: { choice: string } };
    };
    wrongChoice.answers.class_hint.choice = "urgent_letter";
    await expect(
      new TypeSafeJevAdapter({ apiKey: "k", fetch: recordingTransport(wrongChoice).transport }).ask({ text: "x" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each(CONTRACT_ERROR_RESPONSES)(
    "classifies the documented error status $status without echoing the body",
    async ({ status, body }) => {
      const { transport } = recordingTransport(body, status);
      await expect(
        new TypeSafeJevAdapter({ apiKey: "k", fetch: transport }).ask({ text: "x" }),
      ).rejects.toMatchObject({ kind: "request_failed" });
    },
  );
});
