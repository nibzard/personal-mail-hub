#!/usr/bin/env node
/*
 * Fixture launcher for the browser checks (T112). One test run gets one
 * fixture: its own port, its own build output, and a run token that ties
 * the two together, so no run can silently test a stale server or a build
 * another run replaced.
 *
 * The sequence closes the races the old `npm run build && node
 * fixture-server.mjs` command left open:
 *
 * 1. Bind the port immediately, before any build work: while the build
 *    runs, every request — Playwright's readiness poll included — gets
 *    503, so nothing can steal a moment between build and serve, and a
 *    stolen allocation cannot look ready.
 * 2. Build into an isolated directory under the system temp directory, so
 *    concurrent runs never overwrite a shared `dist` under each other.
 * 3. Fingerprint the finished build (same hash family the service worker
 *    stamps) and swap the real fixture handler in behind the still-bound
 *    listener: no rebind, no window.
 * 4. Serve the identity at `/api/fixture/identity` as `{ runToken,
 *    fingerprint, port }`. Playwright's global setup verifies the token
 *    before the first test and the fingerprint again at teardown, so a
 *    foreign or rebuilt server fails the run loudly.
 *
 * Port choice: `E2E_PORT` names the exact port to use — a collision is a
 * hard, clearly reported error, never a reuse. Without it, an ephemeral
 * loopback port is allocated; a collision there (another process took the
 * port between allocation and bind) retries a bounded number of times and
 * then fails with the same clear report.
 *
 * The process owns exactly what it started: the listener, the build
 * children, and the temp build directory. SIGTERM and SIGINT —
 * Playwright's teardown and Ctrl+C — stop the build children, close the
 * listener, and remove the directory in every phase, including mid-build;
 * nothing else is touched, so an unrelated server on any port survives
 * every run. At startup the launcher also retires build trees of
 * launchers that are gone (the pid in each tree's name says whose it is),
 * so a SIGKILLed run cannot litter the temp directory forever.
 *
 * Usage: `E2E_RUN_TOKEN=<uuid> node e2e/fixture-launch.mjs` (the token
 * defaults to a fresh uuid for manual runs). Environment: `E2E_PORT`
 * (optional), `E2E_RUN_TOKEN` (optional).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFixtureHandler } from "./fixture-server.mjs";
import { sweepAbandonedDirs } from "./run-isolation.mjs";
import { fingerprintDir } from "../scripts/build-fingerprint.mjs";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

/** The last lines of captured child output, for a failure report. */
function tail(text, lines = 20) {
  return text.split(/\r?\n/).filter((line) => line.length > 0).slice(-lines).join("\n");
}

/**
 * The port one run serves on: the exact port `E2E_PORT` names, or an
 * ephemeral loopback port the kernel picks. `undefined` — the variable is
 * absent — means ephemeral; any value, empty included, is an explicit
 * choice and must name a port, because silently ignoring a set-but-empty
 * override is how a run lands somewhere unintended. An explicit port is
 * returned without probing — a collision must surface at bind time,
 * reported, not be papered over here.
 */
export async function allocatePort(explicitPort) {
  if (explicitPort !== undefined) {
    const port = Number(explicitPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `fixture launcher: E2E_PORT must name a port between 1 and 65535, not ${JSON.stringify(explicitPort)}.`,
      );
    }
    return port;
  }
  const probe = createServer();
  const port = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      resolve(/** @type {import("node:net").AddressInfo} */ (probe.address()).port);
    });
  });
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Bind one server to `port`, retrying a bounded number of times when the
 * port is in use — the race window between an ephemeral allocation and
 * this bind is short, so a transient holder gives way. A holder that
 * stays loses loudly: the error names the port and what to do about it.
 * `makeServer` builds a fresh, unlistened server per attempt.
 */
export async function listenWithRetries(makeServer, port, { attempts = 5, delayMs = 250, explicit = false } = {}) {
  let lastError = new Error("no attempt was made");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const server = makeServer();
    try {
      await new Promise((ready, failed) => {
        const onError = (/** @type {Error} */ error) => {
          server.removeListener("error", onError);
          failed(error);
        };
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onError);
          ready(undefined);
        });
      });
      return server;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EADDRINUSE") {
        throw error;
      }
      lastError = /** @type {Error} */ (error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const guidance = explicit
    ? `E2E_PORT=${port} names a port another process already holds; this run refuses to reuse it. Stop that process or pick another port.`
    : `Another process took the port between allocation and bind and held it through ${attempts} attempts. Re-run, or set E2E_PORT to a port you know is free.`;
  throw new Error(
    `fixture launcher: cannot listen on 127.0.0.1:${port}. ${guidance} (${lastError.message})`,
  );
}

/** Runs one child step, rejecting with its name and output tail on failure. */
/** Build children this launcher started, so a signal can stop a build mid-flight. */
const buildChildren = new Set();

function runStep(name, command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    buildChildren.add(child);
    child.once("close", () => buildChildren.delete(child));
    child.once("error", () => buildChildren.delete(child));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", (error) => {
      reject(new Error(`fixture launcher: ${name} never started (${error.message}).`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`fixture launcher: ${name} failed with exit code ${code}:\n${tail(output)}`));
    });
  });
}

/**
 * Vite's bin script, found by walking up from `cwd`: npm workspaces hoist
 * dependencies to the repository root, so the package's own
 * `node_modules` may not hold it.
 */
function viteBin(cwd) {
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, "node_modules", "vite", "bin", "vite.js");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`fixture launcher: no node_modules/vite/bin/vite.js above ${cwd}.`);
    }
    dir = parent;
  }
}

/**
 * Builds the client into `distDir`: `vite build --outDir`, then the
 * service-worker step against the same directory. Both run from the
 * workspace root, exactly what `npm run build` runs against the shared
 * `dist` — only the target directory differs.
 */
export async function buildInto(distDir, { cwd = webRoot } = {}) {
  await runStep("vite build", process.execPath, [viteBin(cwd), "build", "--outDir", distDir], cwd);
  await runStep("build-sw", process.execPath, ["scripts/build-sw.mjs", "--dist", distDir], cwd);
}

/** Answers 503 while the build runs: ready for nothing, dead to no one. */
function holdHandler(request, response) {
  response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("fixture build in progress");
}

/** Closes a listening server and waits for its handle to leave. */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve(undefined));
  });
}

/**
 * One run's fixture: binds `port` first, builds into `distDir`, then
 * swaps the real fixture handler in behind the bound listener. Resolves
 * with the server, the build fingerprint, and a `close` that shuts the
 * listener — the caller that owns the directory removes it.
 */
export async function launchFixture({ port, runToken, distDir, build = buildInto, listen }) {
  const bind = listen ?? ((makeServer, bindPort) => listenWithRetries(makeServer, bindPort));
  /** Swapped from the hold handler to the fixture handler after the build. */
  let handler = holdHandler;
  const server = await bind(() => createServer((request, response) => handler(request, response)), port);
  let fingerprint;
  try {
    await build(distDir);
    fingerprint = await fingerprintDir(distDir);
    ({ handler } = createFixtureHandler({ port, distDir, identity: { runToken, fingerprint } }));
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return {
    server,
    port,
    fingerprint,
    close: () => closeServer(server),
  };
}

/**
 * Verifies the server answering on `baseURL` is this run's fixture: its
 * identity route answers, the run token matches, and — when
 * `expectedFingerprint` is given — the build fingerprint still does, which
 * is how a finished run proves its build never changed mid-run. Every
 * mismatch throws with the contamination spelled out; a run that cannot
 * verify its own server fails instead of testing whatever answered.
 */
export async function verifyFixtureIdentity({
  baseURL,
  expectedToken,
  expectedFingerprint = null,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(`${baseURL}/api/fixture/identity`);
  } catch (error) {
    throw new Error(
      `fixture identity: ${baseURL}/api/fixture/identity did not answer (${error instanceof Error ? error.message : String(error)}). No server of this run is reachable there; refusing to run tests.`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      `fixture identity: the server on ${baseURL} has no /api/fixture/identity route — it is not this run's fixture launcher. Refusing to run tests against an unknown server.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `fixture identity: ${baseURL}/api/fixture/identity answered ${response.status}, not 200. Refusing to run tests against an unknown server.`,
    );
  }
  const identity = await response.json();
  const port = new URL(baseURL).port;
  if (String(identity.port) !== port) {
    throw new Error(
      `fixture identity: the server on ${baseURL} reports port ${identity.port}. The readiness poll and the fixture disagree about the origin; refusing to run tests.`,
    );
  }
  if (identity.runToken !== expectedToken) {
    throw new Error(
      `fixture identity: the server on ${baseURL} carries run token ${JSON.stringify(identity.runToken)}, not this run's ${JSON.stringify(expectedToken)} — another run owns that port. Refusing to run tests against a foreign fixture.`,
    );
  }
  if (expectedFingerprint !== null && identity.fingerprint !== expectedFingerprint) {
    const shorten = (value) => (typeof value === "string" ? value.slice(0, 12) : String(value));
    throw new Error(
      `fixture identity: the build under test changed mid-run on ${baseURL} (${shorten(expectedFingerprint)} became ${shorten(identity.fingerprint)}). A run's results must describe one build; failing instead.`,
    );
  }
  return identity;
}

//
// CLI: what Playwright's webServer starts.
//
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const explicit = process.env.E2E_PORT !== undefined;
  const runToken = process.env.E2E_RUN_TOKEN ?? randomUUID();
  // The pid in the name lets any later launcher tell this tree from an
  // abandoned one without trusting a clock.
  const distDir = join(tmpdir(), `mail-hub-e2e-${process.pid}-${runToken.slice(0, 8)}`);
  // Retire build trees of launchers that are gone; live launchers keep
  // theirs, this run's own tree included (this pid is alive).
  await sweepAbandonedDirs(tmpdir(), "mail-hub-e2e-");

  /** The fixture once the build finished; null until then. */
  let fixture = null;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Stop any build child first and give it a moment to die: it would
    // otherwise keep writing into the directory this shutdown removes.
    for (const child of buildChildren) {
      child.kill("SIGTERM");
    }
    await Promise.all(
      [...buildChildren].map((child) =>
        Promise.race([
          new Promise((resolve) => child.once("close", () => resolve(undefined))),
          new Promise((resolve) => setTimeout(() => resolve(undefined), 3000)),
        ]),
      ),
    );
    // Remove the build directory before closing the listener: close()
    // waits for lingering keep-alive sockets, and the supervisor's kill
    // timeout can land first. Destroying the connections lets close()
    // finish at once.
    await rm(distDir, { recursive: true, force: true }).catch(() => undefined);
    if (fixture !== null) {
      fixture.server.closeAllConnections?.();
      await fixture.close();
    }
    process.exit(0);
  };
  // Registered before any directory exists or build starts, so a signal
  // in any phase — mid-build included — still cleans up. Playwright's
  // teardown sends SIGTERM; Ctrl+C reaches the whole foreground group.
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  try {
    const port = await allocatePort(process.env.E2E_PORT);
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    console.log(`fixture launcher: port ${port}, building into ${distDir}`);
    fixture = await launchFixture({
      port,
      runToken,
      distDir,
      listen: (makeServer, bindPort) => listenWithRetries(makeServer, bindPort, { explicit }),
    });
    console.log(
      `fixture launcher: ready on http://127.0.0.1:${port} token ${runToken} fingerprint ${fixture.fingerprint.slice(0, 12)}`,
    );
  } catch (error) {
    // A run that cannot start leaves nothing behind: not its listener (it
    // never got one, or launchFixture closed it) and not its directory.
    await rm(distDir, { recursive: true, force: true }).catch(() => undefined);
    // A signal that already started shutdown() — mid-build, or during
    // that await — owns the exit. The build child it killed must not be
    // misread as a start failure, so park and let shutdown() finish its
    // own cleanup and exit(0). Nothing can start a shutdown between this
    // check and the exit: that stretch is synchronous.
    if (shuttingDown) {
      await new Promise(() => {});
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
