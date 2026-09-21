#!/usr/bin/env node
// Operator access check (deployment runbook). Run from a workstation that
// should hold deployment access: npm run deploy:access. Unlike
// deploy/preflight.mjs, which validates the container environment, this
// script checks the operator side: the SSH identity, the route to the pilot
// host, Docker control over SSH, and — when configured — the Coolify API and
// the deployed health endpoint.
//
// Every check is read-only. The script prints states, categories, and
// non-secret facts only: never token values, never environment variables,
// never key material. It generates no credentials.
//
// Configuration comes from the environment, with deploy/access.env (git
// ignored) loaded first and only for the keys listed below. The process
// environment always wins.
//
//   DEPLOY_SSH_HOST       SSH destination (default: awc-pilot, resolved
//                         through ~/.ssh/config)
//   DEPLOY_SSH_IDENTITY   dedicated identity file (default:
//                         ~/.ssh/id_ed25519_awc_pilot)
//   DEPLOY_COOLIFY_URL    Coolify base URL; checked together with
//                         COOLIFY_TOKEN when both are set
//   DEPLOY_APP_URL        deployed HTTPS origin; checked at /api/healthz

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

/** The only keys deploy/access.env may set. */
export const ACCESS_ENV_KEYS = [
  "DEPLOY_SSH_HOST",
  "DEPLOY_SSH_IDENTITY",
  "DEPLOY_COOLIFY_URL",
  "COOLIFY_TOKEN",
  "DEPLOY_APP_URL",
];

/** One ssh connect attempt gets this many seconds before it is killed. */
const SSH_TIMEOUT_MS = 20_000;

/** One HTTP request gets this many seconds before it is aborted. */
const HTTP_TIMEOUT_MS = 10_000;

/** Categories the ssh check reports, one per failure mode. */
export const SSH_FAILURE_CATEGORIES = [
  "hostname_unresolved",
  "host_key_mismatch",
  "network_unreachable",
  "connection_refused",
  "identity_unreadable",
  "ssh_auth_denied",
  "ssh_failed",
];

/**
 * Name the first configured value that could be parsed as an option by ssh
 * (CWE-88: OpenSSH re-parses argv elements that start with a dash). Such a
 * value is a configuration error, never a host name or a path.
 */
export function findUnsafeOperand(config) {
  for (const [key, value] of Object.entries(config ?? {})) {
    if (typeof value === "string" && value.trim().startsWith("-")) {
      return key;
    }
  }
  return null;
}

/** What one access line on the command list means. */
const CATEGORY_GUIDANCE = {
  hostname_unresolved:
    "The host name did not resolve. Fix the HostName in the ssh config entry.",
  host_key_mismatch:
    "The host key changed. Verify the host, then update known_hosts (see the runbook).",
  network_unreachable:
    "No route to the host. The pilot is offline, or the LAN or tailnet path is missing.",
  connection_refused:
    "The host answered, but nothing listens on the ssh port. Check sshd.",
  identity_unreadable:
    "The identity file is missing or unreadable. Restore it or set DEPLOY_SSH_IDENTITY.",
  ssh_auth_denied:
    "The host rejected the key. Enroll the public key (see the runbook).",
  ssh_failed: "The ssh attempt failed for an unmapped reason.",
  docker_missing: "Docker is not installed on the host.",
  docker_forbidden:
    "The ssh user may not use Docker. Add it to the docker group or use sudo.",
  docker_daemon_unreachable: "The Docker daemon is not running.",
  docker_unavailable: "The Docker check failed.",
  coolify_token_rejected:
    "Coolify rejected the token. Create a fresh API token and update COOLIFY_TOKEN.",
  coolify_unexpected_status: "Coolify answered with an unexpected status.",
  coolify_unreachable: "Coolify did not answer.",
  app_database_unavailable:
    "The deployed health endpoint answered 503: the database round trip failed.",
  app_unhealthy: "The deployed health endpoint answered with an error status.",
  app_unreachable: "The deployed health endpoint did not answer.",
};

/**
 * Map ssh output onto one failure category. The patterns cover the OpenSSH
 * client messages the check can meet; unknown output reads as `ssh_failed`.
 */
export function classifySshFailure(output) {
  const text = output ?? "";
  if (/could not resolve hostname/i.test(text)) {
    return "hostname_unresolved";
  }
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text) ||
    /HOST KEY VERIFICATION FAILED/i.test(text) ||
    /host key verification failed/i.test(text)
  ) {
    return "host_key_mismatch";
  }
  if (
    /no route to host/i.test(text) ||
    /connection timed out/i.test(text) ||
    /operation timed out/i.test(text) ||
    /network is unreachable/i.test(text) ||
    /timed out/i.test(text)
  ) {
    return "network_unreachable";
  }
  if (/connection refused/i.test(text)) {
    return "connection_refused";
  }
  if (
    /identity file .* not accessible/i.test(text) ||
    /load key/i.test(text)
  ) {
    return "identity_unreadable";
  }
  if (/permission denied/i.test(text)) {
    return "ssh_auth_denied";
  }
  return "ssh_failed";
}

/**
 * Map a failed Docker command over ssh onto one failure category.
 */
export function classifyDockerFailure(output) {
  const text = output ?? "";
  if (/command not found/i.test(text) || /not found/i.test(text)) {
    return "docker_missing";
  }
  if (/permission denied/i.test(text)) {
    return "docker_forbidden";
  }
  if (/cannot connect to the docker daemon/i.test(text)) {
    return "docker_daemon_unreachable";
  }
  return "docker_unavailable";
}

/**
 * Parse deploy/access.env content. Only whitelisted keys pass; malformed
 * lines are ignored. Values keep their raw text after quote stripping.
 */
export function parseAccessEnv(text) {
  const allowed = new Set(ACCESS_ENV_KEYS);
  const parsed = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const splitAt = line.indexOf("=");
    if (splitAt <= 0) {
      continue;
    }
    const key = line.slice(0, splitAt).trim();
    if (!allowed.has(key)) {
      continue;
    }
    let value = line.slice(splitAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** Resolve `~` so an identity path works from any shell. */
function expandHome(path) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Run one command and return stdout, stderr, and the exit outcome. */
function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        killed: error !== null && Boolean(error.killed),
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/**
 * One GET with a bounded timeout and optional headers. Never throws; it
 * classifies instead. Header values leave this process only toward the
 * named URL and are never printed.
 */
export async function httpGet(url, headers) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: headers ?? {},
    });
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, status: null };
  }
}

/** The first non-empty output line, bounded, for unknown failures only. */
function firstLine(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  if (line === undefined) {
    return null;
  }
  return line.length > 160 ? `${line.slice(0, 160)}...` : line;
}

/** One capability result: ok, failed with a category, or skipped. */
function ok(extra) {
  return { state: "ok", ...(extra ?? {}) };
}
function failed(category, extra) {
  return { state: "failed", category, ...(extra ?? {}) };
}
function skipped(reason) {
  return { state: "skipped", reason };
}
function notConfigured(reason) {
  return { state: "not_configured", reason };
}

async function main() {
  const jsonMode = process.argv.includes("--json");

  // The access file sits beside this script, so the check works from any
  // working directory. Process environment values win over file values.
  const accessEnvPath = join(dirname(fileURLToPath(import.meta.url)), "access.env");
  try {
    const loaded = parseAccessEnv(await readFile(accessEnvPath, "utf8"));
    for (const [key, value] of Object.entries(loaded)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No access.env: the environment alone configures the check.
  }

  const host = (process.env.DEPLOY_SSH_HOST ?? "awc-pilot").trim() || "awc-pilot";
  const rawIdentity =
    (process.env.DEPLOY_SSH_IDENTITY ?? "~/.ssh/id_ed25519_awc_pilot").trim() ||
    "~/.ssh/id_ed25519_awc_pilot";
  const identityPath = expandHome(rawIdentity);
  const identityExplicit = (process.env.DEPLOY_SSH_IDENTITY ?? "").trim() !== "";
  const coolifyUrl = (process.env.DEPLOY_COOLIFY_URL ?? "").trim().replace(/\/+$/, "");
  const coolifyToken = (process.env.COOLIFY_TOKEN ?? "").trim();
  const appUrl = (process.env.DEPLOY_APP_URL ?? "").trim().replace(/\/+$/, "");

  // A configured value that starts with "-" would reach ssh as an option,
  // so the check stops before running anything. The message names the
  // variable, never its value.
  const unsafeKey = findUnsafeOperand({
    DEPLOY_SSH_HOST: host,
    DEPLOY_SSH_IDENTITY: rawIdentity,
    DEPLOY_COOLIFY_URL: coolifyUrl,
    DEPLOY_APP_URL: appUrl,
  });
  if (unsafeKey !== null) {
    const failure = {
      checkedAt: new Date().toISOString(),
      host,
      config: { state: "failed", category: "unsafe_operand", variable: unsafeKey },
      ok: false,
      missing: ["config"],
    };
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    } else {
      process.stdout.write(
        `config: FAILED (unsafe_operand) — ${unsafeKey} starts with "-" and could be parsed as an option. Fix deploy/access.env or the environment.\n`,
      );
      process.stdout.write("access-check: FAIL — missing capabilities: config\n");
    }
    process.exitCode = 1;
    return;
  }

  const results = { checkedAt: new Date().toISOString(), host };

  // Identity: the file must exist. The check never reads its contents.
  try {
    await access(identityPath, constants.R_OK);
    results.identity = ok({ path: identityPath });
  } catch {
    results.identity = failed("identity_unreadable");
  }

  // SSH: one read-only connect attempt in batch mode, so no prompt can hang.
  const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
  if (identityExplicit) {
    sshArgs.push("-i", identityPath);
  }
  sshArgs.push(host, "true");
  const sshRun = await run("ssh", sshArgs, SSH_TIMEOUT_MS);
  if (sshRun.ok) {
    results.ssh = ok();
  } else {
    const combined = `${sshRun.stderr}\n${sshRun.stdout}`;
    let category = classifySshFailure(combined);
    if (sshRun.killed && category === "ssh_failed") {
      category = "network_unreachable";
    }
    results.ssh = failed(category, category === "ssh_failed" ? { detail: firstLine(combined) } : {});
  }

  // Docker: read-only version query over the same transport.
  if (results.ssh.state !== "ok") {
    results.docker = skipped("ssh did not connect");
  } else {
    const dockerRun = await run(
      "ssh",
      [...sshArgs.slice(0, -2), host, "docker", "version", "--format", "{{.Server.Version}}"],
      SSH_TIMEOUT_MS,
    );
    if (dockerRun.ok && dockerRun.stdout.trim() !== "") {
      results.docker = ok({ serverVersion: dockerRun.stdout.trim() });
    } else if (dockerRun.ok) {
      results.docker = failed("docker_daemon_unreachable");
    } else {
      results.docker = failed(classifyDockerFailure(`${dockerRun.stderr}\n${dockerRun.stdout}`));
    }
  }

  // Coolify: optional. A URL without a token stays not configured.
  if (coolifyUrl === "") {
    results.coolify = notConfigured("set DEPLOY_COOLIFY_URL and COOLIFY_TOKEN to check the Coolify API");
  } else if (coolifyToken === "") {
    results.coolify = notConfigured("DEPLOY_COOLIFY_URL is set but COOLIFY_TOKEN is missing");
  } else {
    const response = await httpGet(`${coolifyUrl}/api/v1/teams`, {
      Authorization: `Bearer ${coolifyToken}`,
    });
    if (response.ok && response.status >= 200 && response.status < 300) {
      results.coolify = ok();
    } else if (response.ok && (response.status === 401 || response.status === 403)) {
      results.coolify = failed("coolify_token_rejected");
    } else if (response.ok) {
      results.coolify = failed("coolify_unexpected_status", { status: response.status });
    } else {
      results.coolify = failed("coolify_unreachable");
    }
  }

  // Deployed app: optional public health probe.
  if (appUrl === "") {
    results.app = notConfigured("set DEPLOY_APP_URL to check the deployed health endpoint");
  } else {
    const response = await httpGet(`${appUrl}/api/healthz`);
    if (response.ok && response.status === 200) {
      results.app = ok({ status: 200 });
    } else if (response.ok && response.status === 503) {
      results.app = failed("app_database_unavailable", { status: 503 });
    } else if (response.ok) {
      results.app = failed("app_unhealthy", { status: response.status });
    } else {
      results.app = failed("app_unreachable");
    }
  }

  // Identity, ssh, and docker gate the result. A configured optional check
  // that fails gates it too; an unconfigured one never does.
  const missing = [
    ["identity", results.identity],
    ["ssh", results.ssh],
    ["docker", results.docker],
    ["coolify", results.coolify],
    ["app", results.app],
  ]
    .filter(([, result]) => result.state === "failed")
    .map(([name]) => name);
  results.ok = missing.length === 0;
  results.missing = missing;

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write(`access-check: deployment access for ${host}\n`);
    for (const label of ["identity", "ssh", "docker", "coolify", "app"]) {
      process.stdout.write(describeLine(label, results[label]));
    }
    if (results.ok) {
      process.stdout.write("access-check: PASS — required access confirmed\n");
    } else {
      process.stdout.write(
        `access-check: FAIL — missing capabilities: ${missing.join(", ")}\n`,
      );
    }
  }
  process.exitCode = results.ok ? 0 : 1;
}

/** One human-readable result line. Guidance names the fix, never a secret. */
function describeLine(label, result) {
  if (result.state === "ok") {
    const extra = result.serverVersion !== undefined
      ? ` (Docker server ${result.serverVersion})`
      : result.path !== undefined
        ? ` (${result.path})`
        : result.status !== undefined
          ? ` (HTTP ${result.status})`
          : "";
    return `${label}: ok${extra}\n`;
  }
  if (result.state === "skipped") {
    return `${label}: skipped (${result.reason})\n`;
  }
  if (result.state === "not_configured") {
    return `${label}: not configured (${result.reason})\n`;
  }
  const guidance = CATEGORY_GUIDANCE[result.category] ?? "";
  const detail = result.detail !== undefined && result.detail !== null ? ` — ${result.detail}` : "";
  const status = result.status !== undefined ? ` (HTTP ${result.status})` : "";
  return `${label}: FAILED (${result.category})${status} — ${guidance}${detail}\n`;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  // A closed pipe (grep, head) must exit quietly, not with a stack trace.
  process.stdout.on("error", (error) => {
    if (error !== null && typeof error === "object" && error.code === "EPIPE") {
      process.exit(1);
    }
    throw error;
  });
  await main();
}
