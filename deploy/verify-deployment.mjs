#!/usr/bin/env node
// Deployment verification (T111). Run from an authorized workstation or on
// the host: npm run deploy:verify. One read-only command answers whether the
// deployed mail hub is actually working — not just whether its containers
// are healthy. Container health alone missed the stalled folders.
//
// Evidence comes from three places, each optional and each classified when
// unavailable: the Docker API over SSH (or local Docker) for containers,
// revision, and restarts; the public health endpoint for recovery, sync
// states, and send counters; and narrow aggregate database queries through
// psql in the database container for folder-backfill and classification
// progress. The command never sends or mutates mail.
//
// Privacy: output holds states, counts, timestamps, UUIDs, container and
// image names, and the transport target (the SSH destination, the same
// operator-side fact deploy/access-check.mjs prints). Never folder names,
// account addresses, subjects, message content, raw logs, or secrets.
// UUIDs are public in the health report already.
//
// The verdict is one of:
//   verified   — every required check ran and passed (untested areas listed)
//   failed     — one check proved a problem: broken sync, wrong revision,
//                a container not running or restart-looping, unreachable
//                database round trip
//   unverified — a required check could not run: no Docker access, missing
//                privileges, no containers found, observation timeout. A
//                partial picture is never reported as verified.
//
// Configuration (environment; deploy/access.env is loaded too):
//   DEPLOY_SSH_HOST         SSH destination for Docker (empty: local Docker)
//   DEPLOY_APP_URL          deployed origin; health is read at /api/healthz
//   DEPLOY_COMPOSE_PROJECT  compose project label (default: mail-hub)
//   DEPLOY_DB_CONTAINER     database container name override
//   DEPLOY_DB_USER          psql user (default: mail_hub)
//   DEPLOY_DB_NAME          psql database (default: mail_hub)
//
// Flags: --json, --expect-revision <image-or-label>, --sample-interval <s>
// (5..300; two samples this many seconds apart decide progress).

import { execFile } from "node:child_process";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyDockerFailure,
  findUnsafeOperand,
  parseAccessEnv,
} from "./access-check.mjs";

/** One Docker or psql command gets this many milliseconds. */
const COMMAND_TIMEOUT_MS = 15_000;

/** The health endpoint gets this many milliseconds. */
const HEALTH_TIMEOUT_MS = 10_000;

/** A container that restarted at least this often reads as failing. */
const RESTART_FAIL_THRESHOLD = 3;
/** A restart count this fresh suggests a loop in progress. */
const RESTART_RECENT_MS = 15 * 60 * 1000;

/** Compose services that belong to the application. */
const APP_SERVICES = new Set(["api", "worker", "web", "app"]);

/** The compose project the stack runs under (deploy/docker-compose.yml). */
const DEFAULT_COMPOSE_PROJECT = "mail-hub";
const DEFAULT_DB_USER = "mail_hub";
const DEFAULT_DB_NAME = "mail_hub";

/**
 * Parse `docker ps` output rows: name, compose service, image, status. The
 * caller controls the format string; malformed rows are skipped, never
 * guessed into a container.
 */
export function parseDockerPs(stdout) {
  const containers = [];
  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    const [name, service, image, status] = line.split("\t");
    if (name === undefined || image === undefined || status === undefined) {
      continue;
    }
    containers.push({
      name,
      service: service === "" ? null : service,
      image,
      status,
    });
  }
  return containers;
}

/**
 * One container status string onto its state. Compose status strings look
 * like `Up 4 minutes (healthy)`, `Up 5 seconds (health: starting)`,
 * `Up 2 minutes (Paused)`, `Restarting (1) 7 seconds ago`, or
 * `Exited (137) 3 hours ago`.
 */
export function classifyContainerStatus(status) {
  const text = String(status ?? "");
  if (text.startsWith("Restarting")) {
    return { running: false, restarting: true, exited: false, exitCode: null, health: "none", paused: false };
  }
  if (text.startsWith("Exited")) {
    const code = /^Exited \((\d+)\)/.exec(text);
    return { running: false, restarting: false, exited: true, exitCode: code === null ? null : Number(code[1]), health: "none", paused: false };
  }
  if (text.startsWith("Up")) {
    const health = text.includes("(healthy)")
      ? "healthy"
      : text.includes("(unhealthy)")
        ? "unhealthy"
        : text.includes("(health: starting)")
          ? "starting"
          : "none";
    return { running: true, restarting: false, exited: false, exitCode: null, health, paused: text.includes("(Paused)") };
  }
  // `Created` and anything unrecognized: the container is not serving.
  return { running: false, restarting: false, exited: false, exitCode: null, health: "unknown", paused: false };
}

/**
 * Split the application containers out of one compose project. Names are
 * never hard-coded: containers are matched by the compose project and
 * service labels, so any suffix scheme works. An explicit database
 * container override wins over discovery.
 */
export function resolveStackContainers(containers, options) {
  const { project, dbContainer } = options ?? {};
  const app = [];
  let db = null;
  for (const container of containers) {
    // Without compose labels, fall back to the service position in the
    // generated name: any segment may carry it, and project names often
    // hold dashes of their own (mail-hub-api-1).
    const isApp =
      container.service !== null
        ? APP_SERVICES.has(container.service)
        : container.name.split("-").some((segment) => APP_SERVICES.has(segment));
    if (isApp) {
      app.push(container);
      continue;
    }
    const isDb =
      container.service === "db" ||
      (container.service === null && /^postgres[:/]/.test(container.image ?? ""));
    if (isDb) {
      db = db === null ? container : db;
    }
  }
  if (typeof dbContainer === "string" && dbContainer !== "") {
    db = { name: dbContainer, service: "db", image: null, status: null, explicit: true };
  }
  return { app, db, project: project ?? null };
}

/**
 * Parse `docker inspect` output for one container: restarts, start time,
 * state, image identity, and the revision label when the image carries one.
 */
export function parseDockerInspect(stdout) {
  const text = String(stdout ?? "").trim();
  if (text === "") {
    // No output is no observation, not a healthy zero: keep it null so the
    // caller reports the container without inventing inspect facts.
    return null;
  }
  const [restartCount, startedAt, state, image, imageId, revision] = text.split("\t");
  return {
    restartCount: Number.isFinite(Number(restartCount)) ? Number(restartCount) : null,
    startedAt: startedAt === "" ? null : startedAt,
    state: state === "" ? null : state,
    image: image === "" ? null : image,
    imageId: imageId === "" || imageId === undefined ? null : imageId,
    revision: revision === "" || revision === undefined ? null : revision,
  };
}

/**
 * Compare the deployed revision with the expected one. A match means the
 * expected string appears in the image reference, equals the revision
 * label, or matches the image identity digest; anything else reads as the
 * wrong revision. An empty expectation matches nothing, because
 * `includes("")` is true for every string.
 */
export function revisionMatches(found, expected) {
  const wanted = String(expected ?? "");
  if (wanted === "") {
    return false;
  }
  const image = found?.image ?? "";
  const revision = found?.revision ?? "";
  const imageId = found?.imageId ?? "";
  return (
    image.includes(wanted) ||
    (revision !== "" && revision === wanted) ||
    (imageId !== "" && (imageId === wanted || imageId.replace(/^sha256:/, "") === wanted.replace(/^sha256:/, "")))
  );
}

/**
 * Parse psql `-tA -F'|'` output into rows of strings. An empty result is an
 * empty list, not an error.
 */
export function parsePsqlRows(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(0 rows)")
    .map((line) => line.split("|"));
}

/**
 * Folder-backfill rows onto aggregates. Counts only: no folder names leave
 * the database.
 */
export function folderAggregatesFromRows(rows) {
  return rows
    .filter((cells) => cells.length >= 5)
    .map((cells) => ({
      accountId: cells[0],
      folders: Number(cells[1]) || 0,
      complete: Number(cells[2]) || 0,
      backfilling: Number(cells[3]) || 0,
      unscanned: Number(cells[4]) || 0,
    }));
}

/**
 * Classification rows onto aggregates: messages held and how many carry a
 * recorded decision.
 */
export function classificationFromRows(rows) {
  return rows
    .filter((cells) => cells.length >= 3)
    .map((cells) => ({
      accountId: cells[0],
      messages: Number(cells[1]) || 0,
      decided: Number(cells[2]) || 0,
    }));
}

/**
 * The pending work one account holds, from its health-report sync block.
 * Nulls read as zero; the states stay comparable across samples.
 */
function pendingOf(sync) {
  return {
    pendingBodies: typeof sync.pendingBodies === "number" ? sync.pendingBodies : 0,
    backfillPendingFolders: typeof sync.backfillPendingFolders === "number" ? sync.backfillPendingFolders : 0,
    pendingThreads: typeof sync.pendingThreads === "number" ? sync.pendingThreads : 0,
  };
}

/**
 * Judge one account's progress between two samples. Failing beats stalled:
 * `degraded` reports cycle failures and `stale` means no cycle was recorded
 * for the stale window, so both fail even without pending work. No pending
 * work otherwise means idle, which is never a failure. Any counter change —
 * down or up, because growing pending work also proves the worker runs —
 * means progressing. Pending work without movement means stalled, the
 * healthy-container-broken-sync case this command exists to catch. Without
 * a first sample no verdict is guessed.
 */
export function classifyAccountProgress(before, after, foldersBefore, foldersAfter) {
  if (after.sync.state === "degraded" || after.sync.state === "stale") {
    return "failing";
  }
  const pendingAfter = pendingOf(after.sync);
  const pendingTotal =
    pendingAfter.pendingBodies + pendingAfter.backfillPendingFolders + pendingAfter.pendingThreads;
  if (pendingTotal === 0) {
    return "idle";
  }
  if (before === undefined) {
    return "unknown";
  }
  const pendingBefore = pendingOf(before.sync);
  const folderBefore = foldersBefore?.find((entry) => entry.accountId === after.accountId);
  const folderAfter = foldersAfter?.find((entry) => entry.accountId === after.accountId);
  const moved =
    pendingAfter.pendingBodies !== pendingBefore.pendingBodies ||
    pendingAfter.backfillPendingFolders !== pendingBefore.backfillPendingFolders ||
    pendingAfter.pendingThreads !== pendingBefore.pendingThreads ||
    after.sync.lastCycleAt !== before.sync.lastCycleAt;
  const backfillMoved =
    folderBefore !== undefined &&
    folderAfter !== undefined &&
    (folderAfter.backfilling !== folderBefore.backfilling || folderAfter.complete !== folderBefore.complete);
  return moved || backfillMoved ? "progressing" : "stalled";
}

/**
 * Fold section outcomes into one verdict. Any failed section fails; any
 * unavailable section keeps the result unverified; only a complete and
 * passing picture reads as verified.
 */
export function aggregateVerdict(sections) {
  const failing = sections.filter((section) => section.outcome === "failed");
  const unavailable = sections.filter((section) => section.outcome === "unverified");
  if (failing.length > 0) {
    return { verdict: "failed", failing, unavailable };
  }
  if (unavailable.length > 0) {
    return { verdict: "unverified", failing, unavailable };
  }
  return { verdict: "verified", failing, unavailable };
}

/** Run one command with a bounded timeout; never throws. */
function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        timedOut: error !== null && Boolean(error.killed),
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/**
 * One health fetch: the parsed report, or a classified failure. A single
 * request supplies the status and the body; the endpoint is never polled
 * twice for one sample.
 */
async function fetchHealth(appUrl) {
  let response;
  try {
    response = await fetch(`${appUrl}/api/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const name = error !== null && typeof error === "object" ? error.name : "";
    return { state: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
  }
  if (response.status !== 200) {
    return { state: "status", status: response.status };
  }
  try {
    return { state: "ok", status: 200, json: JSON.parse(await response.text()) };
  } catch {
    return { state: "unreadable", status: 200 };
  }
}

/** The accounts a health report lists, always an array. */
function accountsOf(report) {
  return Array.isArray(report?.accounts) ? report.accounts : [];
}

/**
 * The narrow aggregate queries the verifier runs. Each names counts only:
 * never a folder name, address, subject, or body.
 */
const FOLDER_QUERY = [
  "select account_id,",
  "count(*)::int,",
  "count(*) filter (where backfill_complete)::int,",
  "count(*) filter (where not backfill_complete and backfill_before_uid is not null)::int,",
  "count(*) filter (where uidvalidity is null)::int",
  "from folders group by account_id",
].join(" ");

const CLASSIFICATION_QUERY = [
  "select m.account_id, count(*)::int,",
  "count(*) filter (where d.id is not null)::int",
  "from messages m left join decisions d on d.message_id = m.id",
  "group by m.account_id",
].join(" ");

async function main() {
  const jsonMode = process.argv.includes("--json");
  const rawInterval = flagValue("--sample-interval");
  const sampleInterval = Number(rawInterval ?? 0);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  try {
    const loaded = parseAccessEnv(await readFile(join(scriptDir, "access.env"), "utf8"));
    for (const [key, value] of Object.entries(loaded)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // No access.env: the environment alone configures the command.
  }

  const sshHost = (process.env.DEPLOY_SSH_HOST ?? "").trim();
  const appUrl = (process.env.DEPLOY_APP_URL ?? "").trim().replace(/\/+$/, "");
  const project = (process.env.DEPLOY_COMPOSE_PROJECT ?? DEFAULT_COMPOSE_PROJECT).trim() || DEFAULT_COMPOSE_PROJECT;
  const dbContainer = (process.env.DEPLOY_DB_CONTAINER ?? "").trim();
  const dbUser = (process.env.DEPLOY_DB_USER ?? DEFAULT_DB_USER).trim() || DEFAULT_DB_USER;
  const dbName = (process.env.DEPLOY_DB_NAME ?? DEFAULT_DB_NAME).trim() || DEFAULT_DB_NAME;
  const expectRevision = (flagValue("--expect-revision") ?? "").trim() || null;

  const unsafeKey = findUnsafeOperand({
    DEPLOY_SSH_HOST: sshHost,
    DEPLOY_APP_URL: appUrl,
    DEPLOY_COMPOSE_PROJECT: project,
    DEPLOY_DB_CONTAINER: dbContainer,
    DEPLOY_DB_USER: dbUser,
    DEPLOY_DB_NAME: dbName,
  });
  // NaN would pass every range comparison, and delay(NaN) re-samples at
  // once, so a working-but-slow sync would read as stalled. Reject it.
  const intervalInvalid =
    rawInterval !== null &&
    (!Number.isFinite(sampleInterval) || sampleInterval < 5 || sampleInterval > 300);
  if (unsafeKey !== null || intervalInvalid) {
    process.stdout.write(
      unsafeKey !== null
        ? `config: FAILED (unsafe_operand) — ${unsafeKey} starts with "-". Fix deploy/access.env or the environment.\n`
        : "config: FAILED (bad_interval) — --sample-interval must be between 5 and 300 seconds.\n",
    );
    process.stdout.write("deployment-verify: FAIL — missing capabilities: config\n");
    process.exitCode = 1;
    return;
  }

  /**
   * Docker runs locally or through ssh. Over ssh, OpenSSH joins the argv
   * elements after the destination into one string and the remote shell
   * re-parses it, so every argument is single-quoted for that shell. The
   * quoting keeps tab-and-quote `--format` templates intact and stops any
   * configured value from acting as shell syntax.
   */
  const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const sshOptions = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
  const docker = (subArgs) =>
    sshHost === ""
      ? run("docker", subArgs, COMMAND_TIMEOUT_MS)
      : run("ssh", [...sshOptions, sshHost, ["docker", ...subArgs].map(shQuote).join(" ")], COMMAND_TIMEOUT_MS);

  const result = {
    command: "deployment-verify",
    checkedAt: new Date().toISOString(),
    dockerTransport: sshHost === "" ? "local" : `ssh:${sshHost}`,
    project,
    expectedRevision: expectRevision,
    sampleIntervalSeconds: sampleInterval === 0 ? null : sampleInterval,
  };
  const sections = [];
  const untested = [];

  // Containers: resolve by labels, then inspect each application container.
  const psRun = await docker([
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.Names}}\t{{.Label \"com.docker.compose.service\"}}\t{{.Image}}\t{{.Status}}",
  ]);
  let containers = { app: [], db: null, project };
  if (!psRun.ok) {
    sections.push({
      name: "containers",
      outcome: "unverified",
      reason: classifyDockerFailure(psRun.stderr),
      detail: psRun.timedOut ? "observation timeout" : undefined,
    });
  } else {
    containers = resolveStackContainers(parseDockerPs(psRun.stdout), { project, dbContainer });
    if (containers.app.length === 0) {
      sections.push({
        name: "containers",
        outcome: "unverified",
        reason: "no application containers",
      });
    } else {
      const containerReports = [];
      let containerFailed = false;
      let containerStarting = false;
      for (const container of containers.app) {
        const state = classifyContainerStatus(container.status);
        const inspectRun = await docker([
          "inspect",
          "--format",
          "{{.RestartCount}}\t{{.State.StartedAt}}\t{{.State.Status}}\t{{.Config.Image}}\t{{.Image}}\t{{index .Config.Labels \"org.opencontainers.image.revision\"}}",
          container.name,
        ]);
        const inspect = inspectRun.ok ? parseDockerInspect(inspectRun.stdout) : null;
        const restartCount = inspect?.restartCount ?? null;
        // RestartCount is cumulative since creation and never decays, so it
        // only counts while the current start is recent: a high count with
        // an old start time is history, not a loop in progress.
        const startedRecently =
          inspect?.startedAt !== null &&
          inspect?.startedAt !== undefined &&
          Date.now() - Date.parse(inspect.startedAt) < RESTART_RECENT_MS;
        const failed =
          !state.running ||
          state.paused ||
          state.health === "unhealthy" ||
          (restartCount !== null && restartCount >= RESTART_FAIL_THRESHOLD && startedRecently);
        containerStarting = containerStarting || state.health === "starting";
        containerFailed = containerFailed || failed;
        containerReports.push({
          name: container.name,
          service: container.service,
          status: container.status,
          running: state.running,
          health: state.health,
          paused: state.paused,
          restartCount,
          image: inspect?.image ?? container.image,
          imageId: inspect?.imageId ?? null,
          revision: inspect?.revision ?? null,
          startedAt: inspect?.startedAt ?? null,
          failed,
        });
      }
      sections.push({
        name: "containers",
        outcome: containerFailed ? "failed" : containerStarting ? "unverified" : "verified",
        reason: containerFailed
          ? "a container is not running, unhealthy, paused, or restart-looping"
          : containerStarting
            ? "a container health check is still starting; re-run after the start period"
            : undefined,
        containers: containerReports,
      });
      result.containers = containerReports;
    }
  }

  // Revision: compare the API container's image with the expectation, when
  // the operator stated one. docker ps order is arbitrary, so pick the
  // service that serves the API rather than whichever container came first.
  const firstContainer =
    result.containers?.find((container) => container.service === "api" || container.service === "app") ??
    result.containers?.[0] ??
    null;
  if (expectRevision === null) {
    untested.push("revision (no --expect-revision given)");
  } else if (firstContainer === null) {
    sections.push({ name: "revision", outcome: "unverified", reason: "no container to read the revision from" });
  } else {
    const matches = revisionMatches(firstContainer, expectRevision);
    sections.push({
      name: "revision",
      outcome: matches ? "verified" : "failed",
      reason: matches ? undefined : "the deployed image does not match the expected revision",
    });
  }
  result.revision = {
    container: firstContainer?.name ?? null,
    image: firstContainer?.image ?? null,
    imageId: firstContainer?.imageId ?? null,
    label: firstContainer?.revision ?? null,
    expected: expectRevision,
  };

  // Health: the public report carries recovery, per-account sync, sends.
  let health = null;
  if (appUrl === "") {
    sections.push({ name: "health", outcome: "unverified", reason: "DEPLOY_APP_URL is not configured" });
    untested.push("health, recovery, sync states, send outcomes (no DEPLOY_APP_URL)");
  } else {
    const fetched = await fetchHealth(appUrl);
    if (fetched.state === "timeout" || fetched.state === "unreachable") {
      sections.push({ name: "health", outcome: "unverified", reason: "health endpoint unreachable" });
    } else if (fetched.state === "unreadable") {
      sections.push({ name: "health", outcome: "unverified", reason: "health report unreadable" });
    } else if (fetched.state === "status" && fetched.status === 503) {
      sections.push({ name: "health", outcome: "failed", reason: "the database round trip failed (503)" });
    } else if (fetched.state === "status") {
      sections.push({ name: "health", outcome: "failed", reason: `health endpoint answered ${fetched.status}` });
    } else {
      health = fetched.json;
      const recoveryState = health?.recovery?.state ?? "unknown";
      // Account sync states are judged on the first sample already, so a
      // degraded or stale account cannot hide behind a single-sample run.
      const syncFailed = accountsOf(health).filter((account) =>
        ["degraded", "stale"].includes(account.sync?.state ?? ""),
      );
      sections.push({
        name: "health",
        outcome: recoveryState === "ready" && syncFailed.length === 0 ? "verified" : "failed",
        reason:
          recoveryState !== "ready"
            ? `recovery state is ${recoveryState}`
            : syncFailed.length > 0
              ? `${syncFailed.length} account(s) report ${syncFailed[0].sync?.state} sync`
              : undefined,
      });
    }
  }
  if (health !== null) {
    result.health = {
      status: health.status ?? null,
      recovery: health.recovery?.state ?? null,
      sends: health.sends ?? null,
      classification: health.classification ?? null,
      queue: health.queue?.state ?? null,
    };
  }

  // Database aggregates: folder backfill and classification progress.
  async function readAggregates() {
    if (containers.db === null) {
      return { ok: false, reason: "no database container" };
    }
    const psql = (query) =>
      docker(["exec", containers.db.name, "psql", "-U", dbUser, "-d", dbName, "-tA", "-F|", "-c", query]);
    const foldersRun = await psql(FOLDER_QUERY);
    const classifyRun = await psql(CLASSIFICATION_QUERY);
    if (!foldersRun.ok || !classifyRun.ok) {
      const failed = !foldersRun.ok ? foldersRun : classifyRun;
      return { ok: false, reason: failed.timedOut ? "observation timeout" : classifyDockerFailure(failed.stderr) };
    }
    return {
      ok: true,
      folders: folderAggregatesFromRows(parsePsqlRows(foldersRun.stdout)),
      classification: classificationFromRows(parsePsqlRows(classifyRun.stdout)),
    };
  }

  let aggregatesBefore = null;
  const firstRead = await readAggregates();
  if (!firstRead.ok) {
    sections.push({ name: "database", outcome: "unverified", reason: firstRead.reason });
    untested.push("folder checkpoints and classification progress (no database access)");
  } else {
    aggregatesBefore = firstRead;
    sections.push({ name: "database", outcome: "verified" });
    result.backfill = firstRead.folders;
    result.classificationProgress = firstRead.classification;
  }

  // Sampling: two samples decide progress, but only where work is pending.
  const accountsBefore = new Map(accountsOf(health).map((account) => [account.accountId, account]));
  const progress = [];
  if (sampleInterval === 0 || health === null) {
    untested.push(
      sampleInterval === 0
        ? "progress sampling (single sample; pass --sample-interval)"
        : "progress sampling (no health report to sample)",
    );
  } else {
    await delay(sampleInterval * 1000);
    const second = await fetchHealth(appUrl);
    const healthAfter = second.state === "ok" ? second.json : null;
    const aggregatesAfterRead = healthAfter === null ? null : await readAggregates();
    const foldersAfter = aggregatesAfterRead?.ok ? aggregatesAfterRead.folders : undefined;
    for (const account of accountsOf(healthAfter)) {
      let verdictFor = classifyAccountProgress(
        accountsBefore.get(account.accountId),
        account,
        aggregatesBefore?.folders,
        foldersAfter,
      );
      // A failed second database read hides folder movement, so a stalled
      // judgment would blame the deployment for our own observation gap.
      if (verdictFor === "stalled" && aggregatesAfterRead !== null && !aggregatesAfterRead.ok) {
        verdictFor = "unknown";
      }
      progress.push({
        accountId: account.accountId,
        progress: verdictFor,
        state: account.sync?.state ?? null,
      });
    }
    if (healthAfter === null) {
      // The operator asked for a progress judgment; a missing second sample
      // must gate the verdict, not slip past it as a note.
      sections.push({
        name: "progress",
        outcome: "unverified",
        reason: "the second health sample could not be read",
      });
    } else if (progress.length === 0) {
      untested.push("progress sampling (no accounts enrolled)");
    } else {
      const anyFailing = progress.some((entry) => entry.progress === "failing");
      const anyStalled = progress.some((entry) => entry.progress === "stalled");
      const anyUnknown = progress.some((entry) => entry.progress === "unknown");
      sections.push({
        name: "progress",
        outcome: anyFailing || anyStalled ? "failed" : anyUnknown ? "unverified" : "verified",
        reason: anyFailing
          ? "an account reports failing or stale sync"
          : anyStalled
            ? "an account holds pending work that did not move between the samples"
            : anyUnknown
              ? "an account could not be judged"
              : undefined,
      });
    }
  }
  result.progress = progress;

  // Accounts with no enrollment leave the sync workflows untested, not
  // passed. Claim that only when at least one source was observed and
  // neither the health report nor the folder rows name an account.
  const observedAccounts =
    health !== null || aggregatesBefore !== null
      ? new Set([
          ...accountsOf(health).map((account) => account.accountId),
          ...(aggregatesBefore?.folders ?? []).map((row) => row.accountId),
        ])
      : null;
  if (observedAccounts !== null && observedAccounts.size === 0) {
    untested.push("sync and send workflows (no accounts enrolled)");
  }

  const { verdict, failing, unavailable } = aggregateVerdict(sections);
  result.verdict = verdict;
  result.failing = failing.map((section) => ({ name: section.name, reason: section.reason }));
  result.unavailable = unavailable.map((section) => ({ name: section.name, reason: section.reason }));
  result.untested = untested;
  result.sections = sections.map((section) => ({ name: section.name, outcome: section.outcome }));

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    renderReport(result);
  }
  process.exitCode = verdict === "verified" ? 0 : 1;
}

function flagValue(name) {
  const argv = process.argv;
  const at = argv.indexOf(name);
  if (at === -1 || at + 1 >= argv.length) {
    return null;
  }
  return argv[at + 1];
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The short human report. Counts and states only; never private data. */
function renderReport(result) {
  process.stdout.write(`deployment-verify: ${result.checkedAt} docker=${result.dockerTransport} project=${result.project}\n`);
  for (const container of result.containers ?? []) {
    const marks = container.failed ? "FAILED" : "ok";
    process.stdout.write(
      `container: ${marks} ${container.service ?? "?"} running=${container.running} health=${container.health} restarts=${container.restartCount ?? "?"} image=${container.image ?? "?"}\n`,
    );
  }
  if (result.revision?.expected !== null && result.revision !== undefined) {
    process.stdout.write(
      `revision: expected ${result.revision.expected} deployed ${result.revision.image ?? "none"} (${result.revision.container ?? "no container"})\n`,
    );
  } else {
    process.stdout.write(
      `revision: ${result.revision?.image ?? "unknown"} label=${result.revision?.label ?? "none"} (no expectation set)\n`,
    );
  }
  if (result.health !== undefined) {
    process.stdout.write(
      `health: status=${result.health.status} recovery=${result.health.recovery} queue=${result.health.queue} sends=${JSON.stringify(result.health.sends)}\n`,
    );
    process.stdout.write(
      `classification: circuit=${result.health.classification?.circuit} calls=${result.health.classification?.calls} errors=${result.health.classification?.errors}\n`,
    );
  }
  for (const entry of result.backfill ?? []) {
    process.stdout.write(
      `backfill: account=${entry.accountId} folders=${entry.folders} complete=${entry.complete} backfilling=${entry.backfilling} unscanned=${entry.unscanned}\n`,
    );
  }
  for (const entry of result.classificationProgress ?? []) {
    process.stdout.write(
      `classification-progress: account=${entry.accountId} decided=${entry.decided}/${entry.messages}\n`,
    );
  }
  for (const entry of result.progress ?? []) {
    process.stdout.write(`progress: account=${entry.accountId} ${entry.progress} (state=${entry.state})\n`);
  }
  for (const item of result.untested) {
    process.stdout.write(`untested: ${item}\n`);
  }
  for (const item of result.failing) {
    process.stdout.write(`failing: ${item.name} — ${item.reason}\n`);
  }
  for (const item of result.unavailable) {
    process.stdout.write(`unavailable: ${item.name} — ${item.reason}\n`);
  }
  process.stdout.write(`deployment-verify: ${result.verdict.toUpperCase()}\n`);
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
