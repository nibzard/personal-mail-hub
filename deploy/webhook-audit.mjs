#!/usr/bin/env node
// Webhook deployment audit (T117). Run from the operator workstation:
// npm run webhook:audit. The release merge fires a signed GitHub push
// webhook; this command audits that path without trusting any single
// signal. An active hook, a reachable destination, and 2xx delivery
// responses prove GitHub delivered and something answered — they do not
// prove a deployment ran. The Coolify side closes that gap only through
// its API or deploy:verify, and the audit says so instead of guessing.
//
// Every check is read-only unless an explicit test-mode flag is passed:
//   --send-test        ask GitHub to send a ping to the hook (no deploy)
//   --redeliver <id>   ask GitHub to replay one delivery (deploys when
//                      its ref is main; requires --allow-deployment)
//
// Output holds states, categories, hosts, refs, and short SHAs only.
// The hook URL path, the signature header, the secret, and every token
// value stay out of the output. Configuration: DEPLOY_COOLIFY_URL and
// COOLIFY_TOKEN (both optional; see deploy/access.env.example), read
// through the same loader as deploy/access-check.mjs.

import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Keys this script reads from the environment or deploy/access.env. */
export const WEBHOOK_ENV_KEYS = ["DEPLOY_COOLIFY_URL", "COOLIFY_TOKEN"];

/** How many recent deliveries the audit inspects. */
export const DELIVERY_WINDOW = 10;

/** One GitHub API call gets this many seconds before it is killed. */
const GH_TIMEOUT_MS = 20_000;

/**
 * True when `header` is the GitHub signature of `body` under `secret`.
 * GitHub sends `X-Hub-Signature-256: sha256=<hex hmac>`; the comparison
 * is constant-time over equal-length buffers.
 */
export function signatureHeaderValid(secret, body, header) {
  if (typeof secret !== "string" || secret.length === 0) {
    return false;
  }
  if (typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  let received;
  try {
    received = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  if (received.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(received, expected);
}

/** The branch a push ref names, or null for tags and odd refs. */
export function refBranch(ref) {
  if (typeof ref !== "string") {
    return null;
  }
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

/** True when the ref names the branch the webhook deploys. */
export function isMainRef(ref) {
  return refBranch(ref) === "main";
}

/**
 * Classify the hooks list. The audit needs one active hook subscribed to
 * push with a https destination; anything else is a named failure.
 */
export function classifyHook(hooks) {
  const list = Array.isArray(hooks) ? hooks : [];
  const push = list.filter((hook) => (hook?.events ?? []).includes("push"));
  if (list.length === 0) {
    return { state: "failed", category: "no_webhook_configured" };
  }
  if (push.length === 0) {
    return { state: "failed", category: "no_push_subscription" };
  }
  if (push.length > 1) {
    return { state: "failed", category: "multiple_push_hooks" };
  }
  const hook = push[0];
  if (hook.active !== true) {
    return { state: "failed", category: "webhook_disabled", id: hook.id };
  }
  const url = String(hook.config?.url ?? "");
  if (!url.startsWith("https://")) {
    return { state: "failed", category: "destination_not_https", id: hook.id };
  }
  if (String(hook.config?.insecure_ssl ?? "0") !== "0") {
    return { state: "failed", category: "tls_verification_disabled", id: hook.id };
  }
  return {
    state: "ok",
    id: hook.id,
    host: new URL(url).host,
    events: hook.events,
  };
}

/**
 * Summarize recent deliveries. A delivery 2xx means the destination
 * accepted the request, nothing more; the summary keeps that distinction
 * explicit so no reader mistakes acceptance for a deployment.
 */
export function classifyDeliveries(deliveries) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  if (list.length === 0) {
    return { state: "failed", category: "never_delivered", acceptedCount: 0 };
  }
  const accepted = list.filter((entry) => entry?.status_code >= 200 && entry?.status_code < 300);
  const last = list[0];
  const lastOk = last?.status_code >= 200 && last?.status_code < 300;
  const allAccepted = accepted.length === list.length;
  return {
    state: allAccepted && lastOk ? "ok" : "failed",
    category: lastOk ? (allAccepted ? null : "earlier_delivery_rejected") : "last_delivery_rejected",
    inspected: list.length,
    acceptedCount: accepted.length,
    lastStatusCode: last?.status_code ?? null,
    lastDeliveredAt: last?.delivered_at ?? null,
    note: "a 2xx records acceptance by the destination, not a deployment",
  };
}

/** The ref and short SHA one delivery detail carried, or nulls. */
export function deliveryFacts(detail) {
  const payload = detail?.request?.payload ?? {};
  const sha = typeof payload.after === "string" ? payload.after : null;
  return {
    ref: typeof payload.ref === "string" ? payload.ref : null,
    sha: sha === null ? null : sha.slice(0, 12),
  };
}

/**
 * Classify what a receiver status code says about a signed delivery.
 * Categories stay observable from GitHub's delivery log alone.
 */
export function classifyReceiverStatus(code) {
  if (code >= 200 && code < 300) {
    return { state: "accepted", category: null };
  }
  if (code === 403 || code === 401) {
    return { state: "rejected", category: "signature_or_auth_rejected" };
  }
  if (code >= 300 && code < 400) {
    return { state: "rejected", category: "redirected" };
  }
  if (code === 410) {
    return { state: "rejected", category: "endpoint_gone" };
  }
  return { state: "failed", category: "delivery_failed" };
}

/**
 * Decide a test-mode action from raw argv. Redelivery can start a real
 * deployment, so it stays blocked until the explicit allowance is present;
 * the decision names the ref to check before allowing it.
 */
export function buildTestModeDecision(argv, factsForId) {
  const args = Array.isArray(argv) ? argv : [];
  const redeliverAt = args.indexOf("--redeliver");
  if (redeliverAt !== -1) {
    const deliveryId = args[redeliverAt + 1];
    if (deliveryId === undefined || deliveryId === "") {
      return { action: "error", reason: "--redeliver needs a delivery id" };
    }
    const facts = factsForId(deliveryId) ?? {};
    const allowed = args.includes("--allow-deployment");
    return {
      action: "redeliver",
      deliveryId,
      allowed,
      ref: facts.ref ?? null,
      sha: facts.sha ?? null,
      warning: allowed
        ? null
        : "redelivery replays the push delivery; when the ref is main it starts a deployment — pass --allow-deployment after confirming the window",
    };
  }
  if (args.includes("--send-test")) {
    return { action: "ping", allowed: true, warning: null };
  }
  return { action: null, allowed: true, warning: null };
}

/**
 * Which Coolify keys a partially filled configuration still lacks. The
 * Coolify side is optional: a half-set configuration is named, an absent
 * one is a plain not-configured, and neither is a failure.
 */
export function coolifyPlan(env) {
  const missing = WEBHOOK_ENV_KEYS.filter((key) => env?.[key] === undefined);
  return { configured: missing.length === 0, missing };
}

/**
 * GitHub writes delivery ids as bare JSON numbers too large for a JS
 * double. `JSON.parse` rounds them, and every later id-keyed request then
 * targets a delivery that does not exist (a silent 404, found live on
 * 2026-09-21). The quoting is scoped to the `"id"` key: a bare `:`
 * followed by digits also occurs inside string values, and quoting there
 * would corrupt the JSON. Only this script's `id` fields exceed 2^53.
 */
export function quoteBigIntegers(text) {
  return String(text).replace(/("id":\s*)(\d{15,})(?=[,}\]])/g, '$1"$2"');
}

/**
 * Turn one gh child result into an outcome. `error.status` does not exist
 * on execFile errors (they carry `code`, not HTTP status), so a 404 is
 * read from gh's stderr line "(HTTP 404)". The ping and redelivery
 * endpoints answer 204 with an empty body, which is a success.
 */
export function ghOutcome(error, stdout, stderr) {
  if (error !== null) {
    return { ok: false, category: /\(HTTP 404\)/.test(String(stderr ?? "")) ? "not_found" : "gh_failed" };
  }
  const raw = String(stdout).trim();
  if (raw === "") {
    return { ok: true, data: null };
  }
  try {
    return { ok: true, data: JSON.parse(quoteBigIntegers(raw)) };
  } catch {
    return { ok: false, category: "gh_unparsable" };
  }
}

/** Run gh api and return parsed JSON, or a classified failure. */
async function ghApi(path, method = "GET") {
  return await new Promise((resolve) => {
    execFile(
      "gh",
      ["api", "--method", method, path],
      { timeout: GH_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        resolve(ghOutcome(error, stdout, stderr));
      },
    );
  });
}

/** One request with a bounded timeout. Never prints what it sends. */
async function httpRequest(url, method = "GET", headers) {
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: headers ?? {},
    });
    await response.arrayBuffer().catch(() => undefined);
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, status: null };
  }
}

/**
 * Classify the Coolify API probe. Only 401 and 403 say anything about the
 * token; every other answered status is an unexpected answer, not a
 * rejection, and an unanswered probe never blames the token.
 */
export function classifyCoolifyResponse(reached, status) {
  if (!reached) {
    return { state: "failed", category: "coolify_unreachable" };
  }
  if (status >= 200 && status < 300) {
    return { state: "ok", note: "correlate the deployment record with npm run deploy:verify" };
  }
  if (status === 401 || status === 403) {
    return { state: "failed", category: "coolify_token_rejected" };
  }
  return { state: "failed", category: "coolify_unexpected_status" };
}

/** Load deploy/access.env when present; the process environment wins. */
async function loadEnv() {
  const merged = {};
  try {
    const { parseAccessEnv } = await import("./access-check.mjs");
    const raw = await readFile(new URL("./access.env", import.meta.url), "utf8");
    Object.assign(merged, parseAccessEnv(raw));
  } catch {
    // No access.env or no permission to read it: environment only.
  }
  for (const key of WEBHOOK_ENV_KEYS) {
    if (process.env[key] !== undefined && process.env[key] !== "") {
      merged[key] = process.env[key];
    }
  }
  return merged;
}

async function main() {
  const jsonMode = process.argv.includes("--json");
  const repoFlag = process.argv.slice(2).find((arg) => arg.startsWith("--repo="));
  const repo = repoFlag !== undefined ? repoFlag.slice("--repo=".length) : "nibzard/personal-mail-hub";
  const env = await loadEnv();
  const lines = [];

  const push = (name, result) => {
    lines.push({ name, ...result });
  };

  // Hook configuration, from GitHub.
  const hooks = await ghApi(`/repos/${repo}/hooks`);
  const hookClass = hooks.ok ? classifyHook(hooks.data) : { state: "failed", category: hooks.category };
  const mask = { ...hookClass };
  delete mask.events;
  push("hook", mask);
  const hookId = hookClass.state === "ok" ? hookClass.id : null;

  // The secret: GitHub never returns it. State the honest unknown and the
  // two ways to prove it instead of pretending absence is a pass.
  push("secret", {
    state: "unknown",
    reason: "GitHub does not expose the secret; prove it with a signed redelivery during an authorized window or inspect the Coolify resource",
  });

  // Destination reachability: touch the origin only, never the hook path.
  if (hookClass.state === "ok") {
    try {
      const response = await fetch(`https://${hookClass.host}`, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      push("destination", { state: "ok", host: hookClass.host, probeStatus: response.status });
    } catch {
      push("destination", { state: "failed", category: "destination_unreachable", host: hookClass.host });
    }
  }

  // Recent deliveries: acceptance, plus the ref of the latest push.
  if (hookId !== null) {
    const deliveries = await ghApi(`/repos/${repo}/hooks/${hookId}/deliveries?per_page=${DELIVERY_WINDOW}`);
    if (!deliveries.ok) {
      push("deliveries", { state: "failed", category: deliveries.category });
    } else {
      const summary = classifyDeliveries(deliveries.data);
      push("deliveries", summary);
      const latest = deliveries.data.find((entry) => entry?.event === "push");
      if (latest !== undefined) {
        const detail = await ghApi(`/repos/${repo}/hooks/${hookId}/deliveries/${latest.id}`);
        if (detail.ok) {
          const facts = deliveryFacts(detail.data);
          push("latest-push", {
            state: "ok",
            ref: facts.ref,
            branch: refBranch(facts.ref),
            sha: facts.sha,
            deliveredAt: latest.delivered_at,
            receiver: classifyReceiverStatus(latest.status_code),
            deployed: isMainRef(facts.ref) ? "yes-if-configured" : "no-non-main-ref",
          });
        } else {
          push("latest-push", { state: "failed", category: detail.category });
        }
      }
    }
  }

  // Coolify side: the only source that can turn acceptance into a
  // deployment record. Unconfigured is a state, not a failure.
  const coolifyConfig = coolifyPlan(env);
  if (coolifyConfig.configured) {
    const probe = await httpRequest(`${env.DEPLOY_COOLIFY_URL.replace(/\/$/, "")}/api/v1/teams/current`, "GET", {
      authorization: `Bearer ${env.COOLIFY_TOKEN}`,
    });
    push("coolify", classifyCoolifyResponse(probe.ok, probe.status));
  } else {
    push("coolify", {
      state: "not_configured",
      reason: coolifyConfig.missing.length === WEBHOOK_ENV_KEYS.length
        ? "set DEPLOY_COOLIFY_URL and COOLIFY_TOKEN to check the Coolify API"
        : `configuration is incomplete; missing ${coolifyConfig.missing.join(" and ")}`,
    });
  }

  // Test modes: explicit, warned, and off by default.
  const decision = buildTestModeDecision(process.argv, () => null);
  if (decision.action === "error") {
    console.error(`webhook audit: ${decision.reason}`);
    process.exitCode = 1;
    return;
  }
  if (decision.action === "redeliver" && hookId !== null) {
    // Name the delivery before any operator allows it: the ref it pushed
    // decides whether the replay deploys.
    let facts = { ref: null, sha: null };
    const detail = await ghApi(`/repos/${repo}/hooks/${hookId}/deliveries/${decision.deliveryId}`);
    if (detail.ok) {
      facts = deliveryFacts(detail.data);
    }
    if (!decision.allowed) {
      console.error(`webhook audit: ${decision.warning}`);
      if (facts.ref !== null) {
        console.error(
          `webhook audit: delivery ${decision.deliveryId} pushed ${facts.ref} at ${facts.sha}; that ref decides whether the replay deploys`,
        );
      }
      process.exitCode = 1;
      return;
    }
    const replay = await ghApi(`/repos/${repo}/hooks/${hookId}/deliveries/${decision.deliveryId}/attempts`, "POST");
    push("redeliver", replay.ok
      ? { state: "ok", deliveryId: decision.deliveryId, ref: facts.ref, sha: facts.sha, note: "GitHub queued the replay; watch the delivery log" }
      : { state: "failed", category: replay.category });
  }
  if (decision.action === "ping" && hookId !== null) {
    // /pings sends a ping event; /tests would replay the latest push
    // payload, which deploys when the hook subscribes to push — the
    // opposite of what this mode promises.
    const ping = await ghApi(`/repos/${repo}/hooks/${hookId}/pings`, "POST");
    push("send-test", ping.ok
      ? { state: "ok", note: "GitHub sent a ping; a ping never starts a deployment" }
      : { state: "failed", category: ping.category });
  }

  const runnable = lines.filter((line) => line.state !== "not_configured" && line.state !== "unknown");
  const ok = runnable.every((line) => line.state === "ok");
  if (jsonMode) {
    console.log(JSON.stringify({ repo, checkedAt: new Date().toISOString(), ok, lines }, null, 2));
  } else {
    console.log(`webhook audit: ${repo}`);
    for (const line of lines) {
      const extra = line.category !== undefined && line.category !== null ? ` (${line.category})` : "";
      console.log(`  ${line.name.padEnd(12)} ${String(line.state)}${extra}`);
    }
    console.log(ok
      ? "  Every runnable check passed. Acceptance is proven; a deployment record needs the Coolify side."
      : "  A runnable check failed; see the categories above.");
  }
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
