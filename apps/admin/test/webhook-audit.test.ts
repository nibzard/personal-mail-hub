import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// The audit is a plain Node script, so it carries no type declarations;
// the surface under test is pinned here.
// @ts-expect-error No declaration file for the deploy script.
import { buildTestModeDecision, classifyCoolifyResponse, classifyDeliveries, classifyHook, classifyReceiverStatus, coolifyPlan, deliveryFacts, ghOutcome, isMainRef, quoteBigIntegers, refBranch, signatureHeaderValid } from "../../../deploy/webhook-audit.mjs";

/*
 * The webhook deployment audit's contracts (T117): the signature check
 * verifies the exact bytes a receiver saw, the classifiers distinguish
 * acceptance from deployment, and the test modes stay blocked until they
 * are explicitly allowed. The receiver harness runs on an ephemeral
 * loopback port in this process; nothing leaves the machine and no
 * network service is contacted.
 */

/** A valid GitHub signature header for `body` under `secret`. */
function sign(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("signatureHeaderValid", () => {
  const secret = "a-test-secret";
  const body = JSON.stringify({ ref: "refs/heads/main", after: "abc123" });

  it("accepts the signature of the exact body bytes", () => {
    expect(signatureHeaderValid(secret, body, sign(secret, body))).toBe(true);
  });

  it("verifies raw bytes, not re-serialized JSON", () => {
    // This body holds a JSON escape that parsing expands, so a receiver
    // that re-serializes what it parsed verifies different bytes and the
    // honest signature fails — the classic raw-body bug, pinned here.
    const escaped = '{"ref":"refs/heads/\\u006dain","after":"abc123"}';
    const reSerialized = JSON.stringify(JSON.parse(escaped));
    expect(reSerialized).not.toBe(escaped);
    expect(signatureHeaderValid(secret, reSerialized, sign(secret, escaped))).toBe(false);
    expect(signatureHeaderValid(secret, escaped, sign(secret, escaped))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(signatureHeaderValid(secret, body, sign("other-secret", body))).toBe(false);
  });

  it("rejects a signature over mutated bytes", () => {
    const mutated = body.replace("main", "maim");
    expect(signatureHeaderValid(secret, mutated, sign(secret, body))).toBe(false);
  });

  it("rejects a missing header, a header without the prefix, and non-hex input", () => {
    expect(signatureHeaderValid(secret, body, undefined)).toBe(false);
    expect(signatureHeaderValid(secret, body, "hmac=deadbeef")).toBe(false);
    expect(signatureHeaderValid(secret, body, "sha256=not-hex-at-all")).toBe(false);
  });

  it("rejects an empty secret even against a matching header", () => {
    expect(signatureHeaderValid("", body, sign("", body))).toBe(false);
  });
});

describe("ref classification", () => {
  it("extracts the branch from a push ref", () => {
    expect(refBranch("refs/heads/main")).toBe("main");
    expect(refBranch("refs/heads/feature/x")).toBe("feature/x");
  });

  it("reports null for tags and non-refs", () => {
    expect(refBranch("refs/tags/v1")).toBe(null);
    expect(refBranch(null)).toBe(null);
  });

  it("names main and only main as the deploying branch", () => {
    expect(isMainRef("refs/heads/main")).toBe(true);
    expect(isMainRef("refs/heads/main-2")).toBe(false);
    expect(isMainRef("refs/tags/v1")).toBe(false);
  });
});

describe("classifyHook", () => {
  const baseHook = {
    id: 1,
    active: true,
    events: ["push"],
    config: { url: "https://coolify.example.com/webhook/xyz", content_type: "json", insecure_ssl: "0" },
  };

  it("passes one active push hook with a https destination", () => {
    const result = classifyHook([baseHook]);
    expect(result.state).toBe("ok");
    expect(result.host).toBe("coolify.example.com");
    // The hook path is a capability: the classification must not carry it.
    expect(JSON.stringify(result)).not.toContain("/webhook/");
  });

  it("fails each named configuration problem", () => {
    expect(classifyHook([]).category).toBe("no_webhook_configured");
    expect(classifyHook([{ ...baseHook, events: ["ping"] }]).category).toBe("no_push_subscription");
    expect(classifyHook([baseHook, { ...baseHook, id: 2 }]).category).toBe("multiple_push_hooks");
    expect(classifyHook([{ ...baseHook, active: false }]).category).toBe("webhook_disabled");
    expect(
      classifyHook([{ ...baseHook, config: { ...baseHook.config, url: "http://coolify.example.com/hook" } }]).category,
    ).toBe("destination_not_https");
    expect(
      classifyHook([{ ...baseHook, config: { ...baseHook.config, insecure_ssl: "1" } }]).category,
    ).toBe("tls_verification_disabled");
  });
});

describe("classifyDeliveries", () => {
  it("fails an empty history as never delivered", () => {
    expect(classifyDeliveries([])).toMatchObject({ state: "failed", category: "never_delivered" });
  });

  it("passes a window where every delivery was accepted", () => {
    const result = classifyDeliveries([{ status_code: 200 }, { status_code: 204 }]);
    expect(result.state).toBe("ok");
    expect(result.category).toBe(null);
    expect(result.acceptedCount).toBe(2);
  });

  it("fails when the most recent delivery was rejected, and says acceptance is not deployment", () => {
    const result = classifyDeliveries([{ status_code: 502 }, { status_code: 200 }]);
    expect(result).toMatchObject({ state: "failed", category: "last_delivery_rejected", lastStatusCode: 502 });
    expect(result.note).toContain("not a deployment");
  });

  it("names the older-rejected case instead of failing without a category", () => {
    const result = classifyDeliveries([{ status_code: 200 }, { status_code: 502 }]);
    expect(result).toMatchObject({ state: "failed", category: "earlier_delivery_rejected", lastStatusCode: 200 });
  });
});

describe("deliveryFacts", () => {
  it("extracts the ref and shortens the SHA", () => {
    const detail = {
      request: { payload: { ref: "refs/heads/main", after: "17095e49ae75f9b81acc57e5880abe1e35c05b07" } },
    };
    expect(deliveryFacts(detail)).toEqual({ ref: "refs/heads/main", sha: "17095e49ae75" });
  });

  it("returns nulls when the payload is missing or malformed", () => {
    expect(deliveryFacts({})).toEqual({ ref: null, sha: null });
    expect(deliveryFacts(null)).toEqual({ ref: null, sha: null });
  });
});

describe("classifyReceiverStatus", () => {
  it("maps status codes to observable receiver outcomes", () => {
    expect(classifyReceiverStatus(200)).toMatchObject({ state: "accepted" });
    expect(classifyReceiverStatus(301)).toMatchObject({ state: "rejected", category: "redirected" });
    expect(classifyReceiverStatus(401)).toMatchObject({ state: "rejected", category: "signature_or_auth_rejected" });
    expect(classifyReceiverStatus(403)).toMatchObject({ state: "rejected", category: "signature_or_auth_rejected" });
    expect(classifyReceiverStatus(410)).toMatchObject({ state: "rejected", category: "endpoint_gone" });
    expect(classifyReceiverStatus(500)).toMatchObject({ state: "failed", category: "delivery_failed" });
  });
});

describe("quoteBigIntegers", () => {
  it("preserves a delivery id JSON.parse would round", () => {
    const text = '{"id": 3843995279374155776, "status_code": 200}';
    const parsed = JSON.parse(quoteBigIntegers(text)) as { id: string; status_code: number };
    expect(parsed.id).toBe("3843995279374155776");
    expect(parsed.status_code).toBe(200);
  });

  it("leaves small numbers, other keys, and digit runs inside strings untouched", () => {
    const text = '{"repository_id": 1377034226, "after": "17095e49ae7599aa", "note": "delivery: 3843995279374155776, next"}';
    expect(quoteBigIntegers(text)).toBe(text);
  });
});

describe("ghOutcome", () => {
  it("reads a 404 from gh's stderr, not from a status field execFile never sets", () => {
    expect(ghOutcome({ code: 1 }, "", "gh: Not Found (HTTP 404)")).toMatchObject({
      ok: false,
      category: "not_found",
    });
    expect(ghOutcome({ code: 1 }, "", "gh: Bad credentials (HTTP 401)")).toMatchObject({
      ok: false,
      category: "gh_failed",
    });
    expect(ghOutcome(new Error("spawn failed"), "", undefined)).toMatchObject({ ok: false, category: "gh_failed" });
  });

  it("treats an empty body as the success the ping and redelivery endpoints answer with", () => {
    expect(ghOutcome(null, "", "")).toEqual({ ok: true, data: null });
    expect(ghOutcome(null, "\n", undefined)).toEqual({ ok: true, data: null });
  });

  it("parses JSON and keeps big ids exact", () => {
    const outcome = ghOutcome(null, '{"id": 3843995279374155776}', "");
    expect(outcome.ok).toBe(true);
    expect((outcome.data as { id: string }).id).toBe("3843995279374155776");
  });

  it("classifies non-JSON output as unparsable", () => {
    expect(ghOutcome(null, "not json at all", "")).toEqual({ ok: false, category: "gh_unparsable" });
  });
});

describe("classifyCoolifyResponse", () => {
  it("separates a rejected token from an unexpected answer and an unreachable host", () => {
    expect(classifyCoolifyResponse(true, 200)).toMatchObject({ state: "ok" });
    expect(classifyCoolifyResponse(true, 401)).toMatchObject({ state: "failed", category: "coolify_token_rejected" });
    expect(classifyCoolifyResponse(true, 403)).toMatchObject({ state: "failed", category: "coolify_token_rejected" });
    expect(classifyCoolifyResponse(true, 500)).toMatchObject({ state: "failed", category: "coolify_unexpected_status" });
    expect(classifyCoolifyResponse(true, 502)).toMatchObject({ state: "failed", category: "coolify_unexpected_status" });
    expect(classifyCoolifyResponse(false, null)).toMatchObject({ state: "failed", category: "coolify_unreachable" });
  });
});

describe("coolifyPlan", () => {
  it("reports a full configuration as configured", () => {
    expect(coolifyPlan({ DEPLOY_COOLIFY_URL: "https://coolify.example.com", COOLIFY_TOKEN: "t" }))
      .toMatchObject({ configured: true, missing: [] });
  });

  it("names the missing keys of partial and absent configurations", () => {
    expect(coolifyPlan({ DEPLOY_COOLIFY_URL: "https://coolify.example.com" }).missing).toEqual(["COOLIFY_TOKEN"]);
    expect(coolifyPlan({}).missing).toEqual(["DEPLOY_COOLIFY_URL", "COOLIFY_TOKEN"]);
    expect(coolifyPlan(undefined).configured).toBe(false);
  });
});

describe("buildTestModeDecision", () => {
  it("stays read-only without flags", () => {
    expect(buildTestModeDecision([], () => null)).toMatchObject({ action: null, allowed: true });
    expect(buildTestModeDecision(undefined, () => null).action).toBe(null);
  });

  it("maps --send-test to a ping that never deploys", () => {
    expect(buildTestModeDecision(["--send-test"], () => null)).toMatchObject({ action: "ping", warning: null });
  });

  it("rejects --redeliver without a delivery id", () => {
    expect(buildTestModeDecision(["--redeliver"], () => null)).toMatchObject({
      action: "error",
      reason: expect.stringContaining("delivery id") as unknown,
    });
  });

  it("blocks redelivery until explicitly allowed and names the deployment risk", () => {
    const blocked = buildTestModeDecision(["--redeliver", "123"], () => ({ ref: "refs/heads/main", sha: "abc" }));
    expect(blocked).toMatchObject({ action: "redeliver", allowed: false, ref: "refs/heads/main" });
    expect(blocked.warning).toContain("deployment");

    const allowed = buildTestModeDecision(["--redeliver", "123", "--allow-deployment"], () => null);
    expect(allowed).toMatchObject({ action: "redeliver", allowed: true, warning: null });
  });

  it("reads the delivery's ref before the operator allows it", () => {
    const seen: string[] = [];
    buildTestModeDecision(["--redeliver", "42"], (id: string) => {
      seen.push(id);
      return { ref: "refs/heads/feature/x", sha: "def" };
    });
    expect(seen).toEqual(["42"]);
  });
});

/*
 * Receiver harness: the smallest receiver that follows the GitHub webhook
 * contract — verify the signature over the raw request bytes, deduplicate
 * by delivery id, deploy only main. It runs on an ephemeral loopback port
 * so the HTTP semantics (raw-body signing among them) are exercised for
 * real without contacting any network service.
 */
function startReceiver(secret: string) {
  const deployments: string[] = [];
  const duplicates: string[] = [];
  const rejected: Array<{ delivery: string; reason: string }> = [];
  const seen = new Set<string>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const delivery = String(request.headers["x-github-delivery"] ?? "");
      const signature = request.headers["x-hub-signature-256"];
      if (typeof signature !== "string" || !signatureHeaderValid(secret, body, signature)) {
        rejected.push({ delivery, reason: "signature" });
        response.writeHead(403, { "content-type": "text/plain" });
        response.end("invalid signature");
        return;
      }
      if (seen.has(delivery)) {
        duplicates.push(delivery);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("duplicate delivery ignored");
        return;
      }
      seen.add(delivery);
      const payload = JSON.parse(body.toString("utf8")) as { ref?: string; after?: string };
      if (!isMainRef(payload.ref ?? null)) {
        rejected.push({ delivery, reason: "non-main-ref" });
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("accepted; ref is not main so no deployment started");
        return;
      }
      deployments.push(payload.after ?? "");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("deployment started");
    });
  });
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return {
    ready,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve(undefined)));
    },
    state: { deployments, duplicates, rejected },
  };
}

/** Posts one delivery the way GitHub would. */
async function postDelivery(
  port: number,
  { secret, guid, ref }: { secret: string; guid: string; ref: string },
) {
  const body = JSON.stringify({ ref, after: `sha-${guid}` });
  const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": guid,
      "x-hub-signature-256": sign(secret, body),
    },
    body,
  });
  await response.arrayBuffer();
  return response.status;
}

const receivers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(receivers.splice(0).map((receiver) => receiver.close()));
});

describe("receiver harness over real HTTP", () => {
  const secret = "shared-webhook-secret";

  it("deploys exactly the signed main pushes", async () => {
    const receiver = startReceiver(secret);
    receivers.push(receiver);
    const port = await receiver.ready;

    expect(await postDelivery(port, { secret, guid: "g-main", ref: "refs/heads/main" })).toBe(200);
    expect(await postDelivery(port, { secret, guid: "g-main-2", ref: "refs/heads/main" })).toBe(200);
    expect(receiver.state.deployments).toEqual(["sha-g-main", "sha-g-main-2"]);
    expect(receiver.state.rejected).toEqual([]);
  });

  it("rejects a wrong-secret signature with 403 and deploys nothing", async () => {
    const receiver = startReceiver(secret);
    receivers.push(receiver);
    const port = await receiver.ready;

    const status = await postDelivery(port, { secret: "attacker-secret", guid: "g-bad", ref: "refs/heads/main" });
    expect(status).toBe(403);
    expect(receiver.state.deployments).toEqual([]);
    expect(receiver.state.rejected).toEqual([{ delivery: "g-bad", reason: "signature" }]);
  });

  it("accepts signed non-main pushes without deploying them", async () => {
    const receiver = startReceiver(secret);
    receivers.push(receiver);
    const port = await receiver.ready;

    expect(await postDelivery(port, { secret, guid: "g-branch", ref: "refs/heads/feature/x" })).toBe(200);
    expect(receiver.state.deployments).toEqual([]);
    expect(receiver.state.rejected).toEqual([{ delivery: "g-branch", reason: "non-main-ref" }]);
  });

  it("treats a replayed delivery id as a duplicate, not a second deployment", async () => {
    const receiver = startReceiver(secret);
    receivers.push(receiver);
    const port = await receiver.ready;

    await postDelivery(port, { secret, guid: "g-once", ref: "refs/heads/main" });
    await postDelivery(port, { secret, guid: "g-once", ref: "refs/heads/main" });
    expect(receiver.state.deployments).toEqual(["sha-g-once"]);
    expect(receiver.state.duplicates).toEqual(["g-once"]);
  });

  it("answers 503 while stopped, which the audit reads as delivery failure, not rejection", () => {
    // No receiver is started for this case; the classification of an
    // unanswered destination is pinned directly.
    expect(classifyReceiverStatus(503)).toMatchObject({ state: "failed", category: "delivery_failed" });
  });
});
