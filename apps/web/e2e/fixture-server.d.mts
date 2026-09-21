/**
 * Declarations for the fixture server module (T112), hand-written for its
 * TypeScript importers — the vitest suite that drives the handler and the
 * launcher tests. The module itself stays plain JavaScript.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** The identity the launcher reports: who owns the server, which build it holds. */
export interface FixtureHandlerIdentity {
  runToken: string;
  fingerprint: string;
}

/** One installed fixture: the request listener and the origin it guards. */
export interface FixtureHandler {
  handler: (request: IncomingMessage, response: ServerResponse) => void;
  origin: string;
  rpId: string;
}

/**
 * The full fixture API and static build as one request listener for one
 * origin. `distDir` is the build output to serve; `identity` feeds the
 * `/api/fixture/identity` route and may be null for standalone use.
 */
export declare function createFixtureHandler(options: {
  port: number;
  distDir: string;
  identity?: FixtureHandlerIdentity | null;
}): FixtureHandler;
