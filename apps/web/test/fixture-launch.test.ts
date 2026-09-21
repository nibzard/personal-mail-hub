import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  allocatePort,
  buildInto,
  launchFixture,
  listenWithRetries,
  verifyFixtureIdentity,
} from "../e2e/fixture-launch.mjs";
import { fingerprintDir } from "../scripts/build-fingerprint.mjs";
import { isProcessAlive, sweepAbandonedDirs } from "../e2e/run-isolation.mjs";
import { createFixtureHandler } from "../e2e/fixture-server.mjs";

/*
 * The fixture launcher's contracts (T112): one run owns its port, its
 * build directory, and its identity; a foreign or stale server can never
 * answer a run's checks. All binds stay on 127.0.0.1; nothing leaves the
 * machine.
 */

/** Servers and directories one test opened; cleaned after each test. */
const opened: Array<{ server?: Server; dir?: string }> = [];
const madeDirs: string[] = [];

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    if (entry.server !== undefined) {
      await new Promise<void>((resolve) => entry.server!.close(() => resolve()));
    }
  }
});

afterAll(async () => {
  await Promise.all(madeDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

/** One throwaway directory a test can build or write into. */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mail-hub-${prefix}-`));
  madeDirs.push(dir);
  return dir;
}

/** A minimal build output the launcher can fingerprint and serve. */
async function fakeDist(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><title>fixture</title>");
}

/** A loopback server running the real fixture handler, plus its origin. */
async function fixtureOn(port: number, identity: { runToken: string; fingerprint: string } | null) {
  const distDir = await tempDir("handler-dist");
  await fakeDist(distDir);
  const { handler } = createFixtureHandler({ port, distDir, identity });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  opened.push({ server });
  return { server, baseURL: `http://127.0.0.1:${port}` };
}

/** Polls a fetch until it answers, so a bind that is still pending is not read as a refusal. */
async function pollFetch(url: string, deadlineMs = 5_000): Promise<Response> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await fetch(url);
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** One port held by a plain server, to force allocation and bind races. */
async function heldPort(): Promise<{
  port: number;
  server: Server;
  release(): Promise<void>;
}> {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const port = holder.address();
  if (port === null || typeof port === "string") {
    throw new Error("the holder did not report a port");
  }
  return {
    port: port.port,
    server: holder,
    release: () =>
      new Promise<void>((resolve) => holder.close(() => resolve())),
  };
}

describe("allocatePort", () => {
  it("returns the exact port E2E_PORT names, without probing it", async () => {
    expect(await allocatePort("4180")).toBe(4180);
  });

  it.each(["0", "-1", "65536", "not-a-port", ""] as const)(
    "rejects an E2E_PORT that names no port (%s)",
    async (value) => {
      await expect(allocatePort(value)).rejects.toThrow(/E2E_PORT/);
    },
  );

  it("picks an ephemeral port that is free and not one another server holds", async () => {
    const held = await heldPort();
    try {
      const port = await allocatePort(undefined);
      expect(port).not.toBe(held.port);
      // The port answers a bind: the allocation returned something usable.
      const probe = createServer();
      opened.push({ server: probe });
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(port, "127.0.0.1", resolve);
      });
    } finally {
      await held.release();
    }
  });
});

describe("listenWithRetries", () => {
  it("binds a free port on the first attempt", async () => {
    const port = await allocatePort(undefined);
    const server = await listenWithRetries(() => createServer(), port);
    opened.push({ server });
    expect(server.listening).toBe(true);
  });

  it("reports a held port clearly when retries run out", async () => {
    const held = await heldPort();
    try {
      await expect(
        listenWithRetries(() => createServer(), held.port, { attempts: 2, delayMs: 10, explicit: true }),
      ).rejects.toThrow(
        new RegExp(`cannot listen on 127\\.0\\.0\\.1:${held.port}.*E2E_PORT=${held.port}.*refuses to reuse`),
      );
    } finally {
      await held.release();
    }
  });

  it("succeeds when a transient holder releases between attempts", async () => {
    const held = await heldPort();
    const port = held.port;
    // The holder leaves shortly after the first failed attempt; the retry
    // window below spans several attempts so the release always lands.
    setTimeout(() => void held.release(), 120);
    const server = await listenWithRetries(() => createServer(), port, { attempts: 5, delayMs: 100 });
    opened.push({ server });
    expect(server.listening).toBe(true);
  });
});

describe("launchFixture", () => {
  it("holds the port with 503 while building, then serves this run's identity", async () => {
    const port = await allocatePort(undefined);
    const distDir = await tempDir("launch-dist");
    let finishBuild: (() => void) | undefined = undefined;
    const buildGate = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    const launched = launchFixture({
      port,
      runToken: "tok-hold",
      distDir,
      build: async (dir) => {
        await fakeDist(dir);
        await buildGate;
      },
    });
    // Not yet resolved, not yet refused: the port answers, with 503, so a
    // readiness poll waits instead of testing a half-built fixture.
    const duringBuild = await pollFetch(`http://127.0.0.1:${port}/api/fixture/identity`);
    expect(duringBuild.status).toBe(503);
    finishBuild!();
    const fixture = await launched;
    opened.push({ server: fixture.server });
    const identity = await verifyFixtureIdentity({
      baseURL: `http://127.0.0.1:${port}`,
      expectedToken: "tok-hold",
    });
    expect(identity.fingerprint).toBe(await fingerprintDir(distDir));
    await fixture.close();
  });

  it("closes its listener when the build fails, freeing the port", async () => {
    const port = await allocatePort(undefined);
    const distDir = await tempDir("launch-fail");
    await expect(
      launchFixture({
        port,
        runToken: "tok-fail",
        distDir,
        build: async () => {
          throw new Error("vite build failed with exit code 1");
        },
      }),
    ).rejects.toThrow("vite build failed");
    // The failed run left the port free: a fresh server can take it.
    const next = await listenWithRetries(() => createServer(), port, { attempts: 1 });
    opened.push({ server: next });
  });
});

describe("verifyFixtureIdentity", () => {
  it("accepts a server carrying this run's token", async () => {
    const { baseURL } = await fixtureOn(await allocatePort(undefined), {
      runToken: "tok-mine",
      fingerprint: "fp-1",
    });
    const identity = await verifyFixtureIdentity({ baseURL, expectedToken: "tok-mine" });
    expect(identity.fingerprint).toBe("fp-1");
  });

  it("rejects a foreign run's server", async () => {
    const { baseURL } = await fixtureOn(await allocatePort(undefined), {
      runToken: "tok-other",
      fingerprint: "fp-1",
    });
    await expect(verifyFixtureIdentity({ baseURL, expectedToken: "tok-mine" })).rejects.toThrow(
      /another run owns that port/,
    );
  });

  it("rejects a server without the identity route", async () => {
    const stranger = createServer((_request, response) => {
      response.writeHead(404);
      response.end("not the fixture");
    });
    await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", resolve));
    opened.push({ server: stranger });
    const address = stranger.address();
    if (address === null || typeof address === "string") {
      throw new Error("the stranger did not report a port");
    }
    await expect(
      verifyFixtureIdentity({
        baseURL: `http://127.0.0.1:${address.port}`,
        expectedToken: "tok-mine",
      }),
    ).rejects.toThrow(/not this run's fixture launcher/);
  });

  it("rejects a mid-run build change through the fingerprint", async () => {
    const { baseURL } = await fixtureOn(await allocatePort(undefined), {
      runToken: "tok-mine",
      fingerprint: "fp-new",
    });
    await expect(
      verifyFixtureIdentity({ baseURL, expectedToken: "tok-mine", expectedFingerprint: "fp-old" }),
    ).rejects.toThrow(/changed mid-run/);
  });

  it("rejects an origin nothing answers", async () => {
    const port = await allocatePort(undefined);
    await expect(
      verifyFixtureIdentity({ baseURL: `http://127.0.0.1:${port}`, expectedToken: "tok-mine" }),
    ).rejects.toThrow(/did not answer/);
  });
});

describe("buildInto", () => {
  it("builds the client and the service worker into an isolated directory", async () => {
    const distDir = await tempDir("build-into");
    await buildInto(distDir);
    const index = await readFile(join(distDir, "index.html"), "utf8");
    expect(index).toContain("<!doctype html");
    const worker = await readFile(join(distDir, "sw.js"), "utf8");
    expect(worker).toContain("__MAILHUB_VERSION");
    // The fingerprint covers the finished tree, worker included.
    expect(await fingerprintDir(distDir)).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});

describe("launcher CLI", () => {
  const script = fileURLToPath(new URL("../e2e/fixture-launch.mjs", import.meta.url));

  it("fails on a held port without leaving its directory, and the holder survives", async () => {
    const held = await heldPort();
    const exit = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        env: {
          ...process.env,
          E2E_PORT: String(held.port),
          E2E_RUN_TOKEN: randomUUID(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        out += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
    });
    try {
      expect(exit.code).toBe(1);
      expect(exit.out).toMatch(new RegExp(`cannot listen on 127\\.0\\.0\\.1:${held.port}`));
      // The directory the launcher said it was building into is gone: the
      // printed path is the launcher's own, not a hand-copied rule.
      const printed = /building into (\S+)/.exec(exit.out)?.[1];
      expect(printed).toBeDefined();
      await expect(access(printed!)).rejects.toThrow();
      // And it touched nothing it did not own: the holder still holds.
      expect(held.server.listening).toBe(true);
    } finally {
      await held.release();
    }
  }, 30_000);

  it("removes its directory on SIGTERM even with a keep-alive socket open", async () => {
    const port = await allocatePort(undefined);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, E2E_PORT: String(port), E2E_RUN_TOKEN: randomUUID() },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    // A client that holds its connection open after one response, the way a
    // browser holds keep-alive sockets: naive close() would wait for it.
    // The launcher binds its hold listener within moments of starting, so a
    // short retry window covers the child's boot.
    const socket = await new Promise<Socket>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const attempt = () => {
        const tried = connect(port, "127.0.0.1");
        tried.once("connect", () => resolve(tried));
        tried.once("error", (error) => {
          tried.destroy();
          if (Date.now() > deadline) {
            reject(error);
          } else {
            setTimeout(attempt, 100);
          }
        });
      };
      attempt();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", (error) => reject(error));
        child.stdout?.on("data", (chunk) => {
          out += chunk;
          if (out.includes("ready on")) resolve();
        });
        child.once("close", () => reject(new Error("the launcher exited before ready")));
        setTimeout(() => reject(new Error("the launcher never reported ready")), 240_000).unref?.();
      });
      socket.write(
        `GET /api/fixture/identity HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
      );
      await new Promise<void>((resolve) => {
        socket.once("data", () => resolve());
      });
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => {
        child.once("close", (exitCode) => resolve(exitCode));
        setTimeout(() => resolve(-1), 10_000).unref?.();
      });
      expect(code).toBe(0);
      const printed = /building into (\S+)/.exec(out)?.[1];
      expect(printed).toBeDefined();
      await expect(access(printed!)).rejects.toThrow();
    } finally {
      socket.destroy();
      child.kill("SIGKILL");
    }
  }, 300_000);

  it("cleans up its directory when signaled mid-build", async () => {
    const port = await allocatePort(undefined);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, E2E_PORT: String(port), E2E_RUN_TOKEN: randomUUID() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer | string) => {
        out += chunk;
        if (/building into (\S+)/.test(out)) resolve();
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
    });
    const printed = /building into (\S+)/.exec(out)?.[1];
    // The signal lands while the build runs — the phase the old launcher
    // could not clean up after.
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => {
      child.once("close", (exitCode) => resolve(exitCode));
      setTimeout(() => resolve(-1), 30_000).unref?.();
    });
    expect(code).toBe(0);
    expect(printed).toBeDefined();
    await expect(access(printed!)).rejects.toThrow();
  }, 60_000);
});

describe("run isolation", () => {
  it("sweeps only directories that name a dead process", async () => {
    const root = await tempDir("run-sweep");
    const shortLived = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve) => shortLived.once("close", () => resolve()));
    const abandoned = join(root, `run-${shortLived.pid}-deadbeef`);
    const live = join(root, `run-${process.pid}-feedface`);
    const foreign = join(root, "run-without-a-pid");
    for (const dir of [abandoned, live, foreign]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "marker"), "x");
    }
    await sweepAbandonedDirs(root, "run-");
    await expect(access(abandoned)).rejects.toThrow();
    await expect(access(live)).resolves.toBeUndefined();
    await expect(access(foreign)).resolves.toBeUndefined();
  });

  it("leaves a missing root alone", async () => {
    const absent = join(tmpdir(), `mail-hub-absent-${randomUUID().slice(0, 8)}`);
    await sweepAbandonedDirs(absent, "run-");
  });

  it("reports this process alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe("fingerprintDir", () => {
  it("hashes equal trees equal and any changed byte different", async () => {
    const first = await tempDir("fp-a");
    const second = await tempDir("fp-b");
    await fakeDist(first);
    await fakeDist(second);
    expect(await fingerprintDir(first)).toBe(await fingerprintDir(second));
    await writeFile(join(first, "index.html"), "<!doctype html><title>changed</title>");
    expect(await fingerprintDir(first)).not.toBe(await fingerprintDir(second));
  });

  it("hashes the file's name into the result", async () => {
    const first = await tempDir("fp-name-a");
    const second = await tempDir("fp-name-b");
    await writeFile(join(first, "one.html"), "<!doctype html>");
    await writeFile(join(second, "two.html"), "<!doctype html>");
    expect(await fingerprintDir(first)).not.toBe(await fingerprintDir(second));
  });

  it("refuses to fingerprint an empty directory", async () => {
    const empty = await tempDir("fp-empty");
    await expect(fingerprintDir(empty)).rejects.toThrow(/no files to fingerprint/);
  });
});
