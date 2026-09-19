#!/usr/bin/env node
/*
 * Fixture server for the browser checks (SPEC section 12, "Interface
 * acceptance"). It serves the production `dist` build on one origin with
 * the fixture API behind `/api`, so a real browser exercises the shipped
 * client against controlled mail data without a database or IMAP server.
 *
 * Endpoints mirror the routes the client reads and the settings screen
 * writes:
 *
 * - `GET /api/auth/status`    the availability probe,
 * - `GET /api/accounts`       the session probe with the recovery generation,
 * - `GET /api/accounts/:id/folders`,
 * - `GET /api/search`         filtered, paged rows for one scope,
 * - `GET /api/messages/:id`   one sanitized detail,
 * - `GET /api/messages/:id/clean-view`,
 * - `GET /api/messages/:id/attachments/:attachmentId`,
 * - `GET/PUT /api/settings`   the settings record (SPEC F10),
 * - `GET /api/sync/status`    per-account sync and queue status,
 * - `PATCH /api/accounts/:id` the classification toggle,
 * - `PUT /api/accounts/:id/identities`,
 * - `PUT/DELETE /api/accounts/:id/folders/:folderId/role`.
 *
 * The settings screen mutates state, so account, folder, and settings data
 * is scoped per `fixture-session` cookie. Every browser context holds its
 * own cookie jar, which keeps parallel checks isolated while one context
 * still reads its own writes back across reloads.
 *
 * Usage: `node e2e/fixture-server.mjs [port]` (default 4180, `PORT` also
 * works). The process stays in the foreground; Playwright's `webServer`
 * starts and stops it.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accounts,
  attachmentBytes,
  authStatus,
  cleanViews,
  foldersByAccount,
  messageDetails,
  messageRows,
  settings,
  settingsSchema,
  syncStatus,
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

/** The mutable data one browser context works on. */
function freshSession() {
  return {
    settings: structuredClone(settings),
    accounts: structuredClone(accounts),
    foldersByAccount: structuredClone(foldersByAccount),
  };
}

const SESSION_COOKIE = "fixture-session";
const sessions = new Map();

/**
 * The session this request belongs to, issuing a cookie for new contexts.
 * Must run before the response writes its headers.
 */
function sessionFor(request, response) {
  const cookie = request.headers.cookie ?? "";
  const id = /(?:^|;\s*)fixture-session=([^;]+)/u.exec(cookie)?.[1];
  const known = id === undefined ? undefined : sessions.get(id);
  if (known !== undefined) {
    return known;
  }
  const fresh = freshSession();
  const newId = id === undefined ? randomUUID() : id;
  sessions.set(newId, fresh);
  response.setHeader("set-cookie", `${SESSION_COOKIE}=${newId}; Path=/; HttpOnly; SameSite=Lax`);
  return fresh;
}

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

/** Reads one JSON request body. */
async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** True when one settings value fits its key's schema. */
function settingsValueFits(key, value) {
  const schema = settingsSchema[key];
  if (schema === undefined) {
    return false;
  }
  if (Array.isArray(schema)) {
    return schema.includes(value);
  }
  if (schema === "boolean") {
    return typeof value === "boolean";
  }
  // The cost cap: a non-negative number, or null to clear it.
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/** Applies one settings patch in memory, or returns the rejection reason. */
function applySettingsPatch(session, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return "The settings body must be an object.";
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!settingsValueFits(key, value)) {
      return `The value of ${key} does not fit the settings schema.`;
    }
  }
  Object.assign(session.settings, patch);
  return null;
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

    const session = sessionFor(request, response);
    let match = null;

    // The writes the settings screen makes, before the read guard below.
    if (pathname === "/api/settings" && request.method === "PUT") {
      const rejection = applySettingsPatch(session, await readJsonBody(request));
      if (rejection !== null) {
        sendError(response, 400, "invalid_request", rejection);
        return;
      }
      sendJson(response, 200, { settings: session.settings });
      return;
    }

    match = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
    if (match !== null && request.method === "PATCH") {
      const account = session.accounts.find((entry) => entry.id === match[1]);
      const body = await readJsonBody(request);
      if (account === undefined) {
        sendError(response, 404, "not_found", "No such account in the fixture.");
        return;
      }
      if (body === null || typeof body.classifyEnabled !== "boolean") {
        sendError(
          response,
          400,
          "invalid_request",
          "Only the classification toggle exists in the fixture.",
        );
        return;
      }
      account.classifyEnabled = body.classifyEnabled;
      sendJson(response, 200, { account });
      return;
    }

    match = /^\/api\/accounts\/([^/]+)\/identities$/.exec(pathname);
    if (match !== null && request.method === "PUT") {
      const account = session.accounts.find((entry) => entry.id === match[1]);
      const body = await readJsonBody(request);
      if (account === undefined) {
        sendError(response, 404, "not_found", "No such account in the fixture.");
        return;
      }
      const identities = body?.identities;
      if (
        !Array.isArray(identities) ||
        identities.length > 64 ||
        identities.some(
          (identity) =>
            typeof identity?.address !== "string" ||
            identity.address.length === 0 ||
            typeof identity?.isDefault !== "boolean",
        ) ||
        (identities.length > 0 && identities.filter((identity) => identity.isDefault).length !== 1)
      ) {
        sendError(
          response,
          400,
          "invalid_request",
          "Identities need an address each and exactly one default.",
        );
        return;
      }
      account.identities = identities.map((identity) => ({
        address: identity.address,
        name: typeof identity.name === "string" && identity.name.length > 0 ? identity.name : null,
        isDefault: identity.isDefault,
      }));
      sendJson(response, 200, { account });
      return;
    }

    match = /^\/api\/accounts\/([^/]+)\/folders\/([^/]+)\/role$/.exec(pathname);
    if (match !== null && (request.method === "PUT" || request.method === "DELETE")) {
      const entry = session.foldersByAccount[match[1]];
      const folder = entry?.folders.find((candidate) => candidate.id === match[2]);
      if (entry === undefined || folder === undefined) {
        sendError(response, 404, "not_found", "No such folder in the fixture.");
        return;
      }
      let role = null;
      if (request.method === "PUT") {
        role = (await readJsonBody(request))?.role;
        if (!["inbox", "sent", "drafts", "archive", "trash", "junk"].includes(role)) {
          sendError(response, 400, "invalid_request", "The role is not a folder role.");
          return;
        }
      }
      // One role per account: the choice replaces the folder that held it.
      if (role !== null) {
        for (const other of entry.folders) {
          if (other !== folder && other.role === role) {
            other.role = null;
          }
        }
      }
      folder.role = role;
      sendJson(response, 200, folder);
      return;
    }

    if (request.method !== "GET") {
      sendError(response, 405, "method_not_allowed", "The fixture holds no such write.");
      return;
    }

    if (pathname === "/api/auth/status") {
      sendJson(response, 200, authStatus);
      return;
    }

    if (pathname === "/api/settings") {
      sendJson(response, 200, { settings: session.settings });
      return;
    }

    if (pathname === "/api/sync/status") {
      sendJson(response, 200, syncStatus);
      return;
    }

    if (pathname === "/api/accounts") {
      sendJson(response, 200, { accounts: session.accounts, recoveryGeneration: "gen-fixture-1" });
      return;
    }

    match = /^\/api\/accounts\/([^/]+)\/folders$/.exec(pathname);
    if (match !== null) {
      const entry = session.foldersByAccount[match[1]];
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

    match = /^\/api\/messages\/([^/]+)\/clean-view$/.exec(pathname);
    if (match !== null) {
      const cleanView = cleanViews.get(match[1]);
      if (cleanView === undefined) {
        sendError(
          response,
          400,
          "invalid_request",
          "This message has no sanitized HTML body to extract a clean view from.",
        );
        return;
      }
      sendJson(response, 200, cleanView);
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
