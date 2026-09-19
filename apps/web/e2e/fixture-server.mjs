#!/usr/bin/env node
/*
 * Fixture server for the browser checks (SPEC section 12, "Interface
 * acceptance"). It serves the production `dist` build on one origin with
 * the fixture API behind `/api`, so a real browser exercises the shipped
 * client against controlled mail data without a database or IMAP server.
 *
 * Endpoints mirror the routes the client reads:
 *
 * - `GET /api/auth/status`    the availability probe,
 * - `GET /api/accounts`       the session probe with the recovery generation,
 * - `GET /api/accounts/:id/folders`,
 * - `GET /api/search`         filtered, paged rows for one scope,
 * - `GET /api/messages/:id`   one sanitized detail,
 * - `GET /api/messages/:id/attachments/:attachmentId`.
 *
 * Usage: `node e2e/fixture-server.mjs [port]` (default 4180, `PORT` also
 * works). The process stays in the foreground; Playwright's `webServer`
 * starts and stops it.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accounts,
  attachmentBytes,
  authStatus,
  foldersByAccount,
  messageDetails,
  messageRows,
} from "./fixture-data.mjs";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4180);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** Rows of one scope: account and folder filters plus a free-text query. */
function rowsFor({ accountIds, folderId, query }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  return messageRows.filter((item) => {
    if (accountIds.length > 0 && !accountIds.includes(item.accountId)) {
      return false;
    }
    if (folderId !== null && item.folderId !== folderId) {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    const haystack = [
      item.subject ?? "",
      item.snippet ?? "",
      item.sender?.name ?? "",
      item.sender?.address ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** The wire row: the fixture's folder field never leaves the server. */
function toWireRow(item) {
  const { folderId, ...wire } = item;
  return wire;
}

/** Sends one JSON body. */
function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

/** Sends one API rejection in the shared error shape. */
function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

/** Serves one file from `dist`, falling back to the shell for `/`. */
async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = normalize(join(distDir, relative));
  if (!candidate.startsWith(distDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  let info;
  try {
    info = await stat(candidate);
  } catch {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const file = info.isDirectory() ? join(candidate, "index.html") : candidate;
  const type = MIME_TYPES.get(extname(file)) ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (!pathname.startsWith("/api/")) {
      await serveStatic(request, response, pathname);
      return;
    }

    if (request.method !== "GET") {
      sendError(response, 405, "method_not_allowed", "Only reads exist in the fixture.");
      return;
    }

    if (pathname === "/api/auth/status") {
      sendJson(response, 200, authStatus);
      return;
    }

    if (pathname === "/api/accounts") {
      sendJson(response, 200, { accounts, recoveryGeneration: "gen-fixture-1" });
      return;
    }

    let match = /^\/api\/accounts\/([^/]+)\/folders$/.exec(pathname);
    if (match !== null) {
      const entry = foldersByAccount[match[1]];
      if (entry === undefined) {
        sendError(response, 404, "not_found", "No such account in the fixture.");
        return;
      }
      sendJson(response, 200, entry);
      return;
    }

    if (pathname === "/api/search") {
      const params = url.searchParams;
      const accountIds = params.getAll("account");
      const folderId = params.get("folder");
      const rows = rowsFor({
        accountIds,
        folderId: folderId === null || folderId === "" ? null : folderId,
        query: params.get("q") ?? "",
      });
      const limit = Math.min(Number(params.get("limit") ?? 50), 100);
      const offset = Math.max(Number(params.get("offset") ?? 0), 0);
      sendJson(response, 200, {
        results: rows.slice(offset, offset + limit).map(toWireRow),
        total: rows.length,
        indexing: { messages: rows.length, bodies: rows.length },
      });
      return;
    }

    match = /^\/api\/messages\/([^/]+)$/.exec(pathname);
    if (match !== null) {
      const detail = messageDetails.get(match[1]);
      if (detail === undefined) {
        sendError(response, 404, "not_found", "No such message in the fixture.");
        return;
      }
      sendJson(response, 200, { message: detail });
      return;
    }

    match = /^\/api\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
    if (match !== null) {
      const detail = messageDetails.get(match[1]);
      const attachment = detail?.attachments.find((entry) => entry.id === match[2]);
      const bytes = attachmentBytes.get(match[2]);
      if (detail === undefined || attachment === undefined || bytes === undefined) {
        sendError(response, 404, "not_found", "No such attachment in the fixture.");
        return;
      }
      response.writeHead(200, {
        "content-type": attachment.contentType ?? "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
      });
      response.end(bytes);
      return;
    }

    sendError(response, 404, "not_found", "The fixture API has no such route.");
  } catch (error) {
    sendError(
      response,
      500,
      "fixture_error",
      error instanceof Error ? error.message : String(error),
    );
  }
});

// Fail fast when the build is missing: the checks would otherwise chase a
// blank page.
try {
  await readFile(join(distDir, "index.html"));
} catch {
  console.error(`fixture server: ${distDir} holds no index.html. Run \`npm run build\` first.`);
  process.exit(1);
}

server.listen(port, "127.0.0.1", () => {
  console.log(`fixture server listening on http://127.0.0.1:${port}`);
});
