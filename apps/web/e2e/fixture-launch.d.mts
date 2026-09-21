/**
 * Declarations for the fixture launcher (T112), written by hand because
 * the launcher itself is plain JavaScript — the repo's convention for
 * node scripts — while the Playwright config and the vitest suites that
 * drive it are TypeScript.
 */
import type { Server } from "node:http";

/** The port one run serves on: the exact `E2E_PORT`, or an ephemeral one. */
export declare function allocatePort(explicitPort: string | undefined): Promise<number>;

/**
 * Bind a fresh server from `makeServer` to `port`, retrying transient
 * `EADDRINUSE` a bounded number of times before failing with a report
 * that names the port and the guidance for it.
 */
export declare function listenWithRetries(
  makeServer: () => Server,
  port: number,
  options?: { attempts?: number; delayMs?: number; explicit?: boolean },
): Promise<Server>;

/** Build the client into `distDir`: vite build, then the service worker. */
export declare function buildInto(distDir: string, options?: { cwd?: string }): Promise<void>;

/** One run's fixture server: the listener, its identity, and its close. */
export interface LaunchedFixture {
  server: Server;
  port: number;
  fingerprint: string;
  close(): Promise<void>;
}

/**
 * Bind first, build into `distDir`, then swap the fixture handler in
 * behind the bound listener. `build` and `listen` are injectable for the
 * unit suites; production uses `buildInto` and `listenWithRetries`.
 */
export declare function launchFixture(options: {
  port: number;
  runToken: string;
  distDir: string;
  build?: (distDir: string) => Promise<void>;
  listen?: (makeServer: () => Server, port: number) => Promise<Server>;
}): Promise<LaunchedFixture>;

/** The identity route's answer: who owns the server and which build it holds. */
export interface FixtureIdentity {
  runToken: string | null;
  fingerprint: string | null;
  port: number;
}

/**
 * Verify the server on `baseURL` is this run's fixture: identity route
 * answers, token matches, fingerprint matches when given. Every mismatch
 * throws with the contamination spelled out.
 */
export declare function verifyFixtureIdentity(options: {
  baseURL: string;
  expectedToken: string;
  expectedFingerprint?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<FixtureIdentity>;
