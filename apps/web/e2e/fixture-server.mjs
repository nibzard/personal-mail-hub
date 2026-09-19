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
 * - `POST /api/actions`       mail management actions with receipts (SPEC F4),
 * - `GET /api/actions/:id`    one action's receipts,
 * - `POST /api/drafts`        a new draft, and `POST /api/drafts/reply` a
 *                             derived reply (SPEC F6),
 * - `GET/PATCH/DELETE /api/drafts/:id` and `GET /api/drafts`,
 * - `POST /api/uploads`       one raw byte upload,
 * - `GET/POST /api/drafts/:id/uploads` and `DELETE .../uploads/:uploadId`,
 * - `POST /api/drafts/:id/send` and `GET /api/outbound/:id` (SPEC F7),
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
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accounts,
  ACTION_KINDS,
  attachmentBytes,
  authStatus,
  cleanViews,
  FLAG_KINDS,
  foldersByAccount,
  messageDetails,
  messageRows,
  RECOVERY_GENERATION,
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
    // Row patches applied mail actions made, keyed by message id, plus the
    // receipts those actions returned, keyed by id and idempotency key.
    rowPatches: new Map(),
    actions: new Map(),
    actionsByKey: new Map(),
    // Compose state (SPEC F6 and F7): drafts and their attachments, byte
    // uploads, outbound snapshots, and sends keyed for idempotent replay.
    drafts: new Map(),
    attachments: new Map(),
    uploads: new Map(),
    outbounds: new Map(),
    sendsByKey: new Map(),
    sequence: 0,
  };
}

/**
 * The compose fixtures derive recipient outcomes from the addresses
 * themselves, so one send's path stays chosen by the check that sends it.
 *
 * - an address holding `reject@` is refused while the others are accepted,
 * - an address holding `fail@` fails the whole attempt permanently,
 * - an address holding `unknown@` loses the attempt's outcome.
 */
function recipientFate(address) {
  if (address.includes("fail@")) {
    return "fail";
  }
  if (address.includes("unknown@")) {
    return "unknown";
  }
  if (address.includes("reject@")) {
    return "reject";
  }
  return "accept";
}

/** Every address one draft's recipients name, in send order. */
function flatRecipients(recipients) {
  return [...recipients.to, ...(recipients.cc ?? []), ...(recipients.bcc ?? [])];
}

/**
 * One read of an outbound advances its state machine a single step (SPEC
 * F7): queued, then sending, then the outcome the addresses chose, then the
 * Sent copy settles. A definitive failure unlocks the draft; every other
 * terminal outcome keeps it locked.
 */
function advanceOutbound(outbound, draft) {
  if (outbound.status === "queued") {
    outbound.status = "sending";
    return;
  }
  if (outbound.status === "sending") {
    const addresses = [...new Set(flatRecipients(outbound.recipients).map((r) => r.address))];
    const fates = addresses.map((address) => ({ address, fate: recipientFate(address) }));
    const now = new Date().toISOString();
    if (fates.some((entry) => entry.fate === "fail")) {
      outbound.status = "failed";
      outbound.sentAt = now;
      outbound.recipientResults = fates.map((entry) => ({
        address: entry.address,
        accepted: false,
        response: "550 Requested action aborted: permanent failure",
      }));
      outbound.lastError = { message: "550 Requested action aborted: permanent failure" };
      outbound.sentCopyStatus = "failed";
      if (draft !== undefined) {
        draft.lockedBySend = null;
      }
      return;
    }
    if (fates.some((entry) => entry.fate === "unknown")) {
      outbound.status = "outcome_unknown";
      outbound.recipientResults = [];
      outbound.sentCopyStatus = "unknown";
      return;
    }
    outbound.sentAt = now;
    outbound.recipientResults = fates.map((entry) => ({
      address: entry.address,
      accepted: entry.fate !== "reject",
      response: entry.fate === "reject" ? "550 User unknown" : "250 Ok",
    }));
    // Partial acceptance stays visible through the recipient results; the
    // wire status stays `sent` (SPEC F7).
    outbound.status = "sent";
    outbound.sentCopyStatus = "appending";
    return;
  }
  if (
    (outbound.status === "sent" || outbound.status === "failed") &&
    outbound.sentCopyStatus === "appending"
  ) {
    outbound.sentCopyStatus = "stored";
  }
}

/** The reply body the fixture derives: the parent quoted under a header. */
function quotedReplyMarkdown(parent) {
  const body = parent.textPlain ?? "(no text body)";
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const sender = parent.sender === null ? "somebody" : parent.sender.name ?? parent.sender.address;
  return `\n\nOn ${parent.sentAt}, ${sender} wrote:\n\n${quoted}\n`;
}

/** Creates one draft record with the next fixture identifiers. */
function newDraft(session, fields) {
  session.sequence += 1;
  const draft = {
    id: `d-${session.sequence}`,
    revision: 1,
    lockedBySend: null,
    subject: null,
    markdown: "",
    recipients: { to: [], cc: [], bcc: [] },
    referenceIds: [],
    updatedAt: new Date().toISOString(),
    ...fields,
  };
  session.drafts.set(draft.id, draft);
  session.attachments.set(draft.id, []);
  return draft;
}

/** The identity a draft's From address names, when the account holds it. */
function identityByAddress(account, address) {
  return account.identities.find((identity) => identity.address === address) ?? null;
}

/** Applies one draft patch after the stale and lock gates (SPEC F6). */
function applyDraftPatch(draft, body) {
  if (body.baseRevision !== draft.revision) {
    return { status: 409, code: "draft_stale", extra: { currentRevision: draft.revision } };
  }
  if (draft.lockedBySend !== null) {
    return { status: 409, code: "draft_locked", extra: {} };
  }
  if (body.recipients !== undefined) {
    draft.recipients = {
      to: body.recipients.to ?? [],
      cc: body.recipients.cc ?? [],
      bcc: body.recipients.bcc ?? [],
    };
  }
  if (body.subject !== undefined) {
    draft.subject = body.subject;
  }
  if (body.markdown !== undefined) {
    draft.markdown = body.markdown;
  }
  draft.revision += 1;
  draft.updatedAt = new Date().toISOString();
  return null;
}

/** Reads one raw request body as bytes. */
async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The occurrence ids one row exposes, keyed by message id. */
const OCCURRENCES_BY_MESSAGE = new Map(
  messageRows.map((item) => [item.messageId, item.occurrences]),
);

/** The message row an occurrence id belongs to, keyed by occurrence id. */
const MESSAGE_BY_OCCURRENCE = new Map(
  messageRows.flatMap((item) =>
    item.occurrences.map((occurrence) => [occurrence.occurrenceId, item]),
  ),
);

/** Applies one mail action in memory and returns its receipts (SPEC F4). */
function applyMailAction(session, body) {
  const flagged = FLAG_KINDS[body.kind];
  for (const occurrenceId of body.occurrenceIds) {
    const row = MESSAGE_BY_OCCURRENCE.get(occurrenceId);
    if (row === undefined) {
      continue;
    }
    const patch = session.rowPatches.get(row.messageId) ?? {};
    if (flagged === undefined) {
      // A move or archive re-files the row; the source folder is left as
      // the row's own occurrence history records it.
      patch.folderId = body.destinationFolderId;
    } else {
      patch[flagged.flag] = flagged.value;
    }
    session.rowPatches.set(row.messageId, patch);
  }
  return {
    actionId: randomUUID(),
    kind: body.kind,
    status: "complete",
    idempotencyKey: body.idempotencyKey,
    items: body.occurrenceIds.map((occurrenceId) => ({
      itemKey: occurrenceId,
      status: "confirmed",
      outcome: null,
    })),
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

/** Rows of one scope with the session's action patches applied. */
function rowsFor(session, { accountIds, folderId, query }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  const rows = [];
  for (const base of messageRows) {
    const patch = session.rowPatches.get(base.messageId);
    const item = patch === undefined ? base : { ...base, ...patch };
    if (accountIds.length > 0 && !accountIds.includes(item.accountId)) {
      continue;
    }
    if (folderId !== null && item.folderId !== folderId) {
      continue;
    }
    if (terms.length > 0) {
      const haystack = [
        item.subject ?? "",
        item.snippet ?? "",
        item.sender?.name ?? "",
        item.sender?.address ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) {
        continue;
      }
    }
    rows.push(item);
  }
  return rows;
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
function sendError(response, status, code, message, extra = {}) {
  sendJson(response, status, { error: { code, message, ...extra } });
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

    // Mail management actions (SPEC F4): the fixture freezes nothing, but it
    // validates the submission's shape and reads its own writes back.
    if (pathname === "/api/actions" && request.method === "POST") {
      const body = await readJsonBody(request);
      const account = session.accounts.find((entry) => entry.id === body?.accountId);
      const kind = ACTION_KINDS.find((candidate) => candidate === body?.kind);
      const needsDestination = kind === "move" || kind === "archive";
      const destinationKnown =
        !needsDestination ||
        session.foldersByAccount[body.accountId]?.folders.some(
          (folder) => folder.id === body.destinationFolderId,
        );
      if (
        body === null ||
        account === undefined ||
        kind === undefined ||
        typeof body.idempotencyKey !== "string" ||
        body.idempotencyKey.length === 0 ||
        !Array.isArray(body.occurrenceIds) ||
        body.occurrenceIds.length === 0 ||
        (needsDestination && destinationKnown === false)
      ) {
        sendError(
          response,
          400,
          "invalid_request",
          "The action body names no account, kind, key, occurrences, or a known destination.",
        );
        return;
      }
      const replayed = session.actionsByKey.get(body.idempotencyKey);
      if (replayed !== undefined) {
        sendJson(response, 200, { action: replayed });
        return;
      }
      const receipt = applyMailAction(session, body);
      session.actions.set(receipt.actionId, receipt);
      session.actionsByKey.set(receipt.idempotencyKey, receipt);
      sendJson(response, 201, { action: receipt });
      return;
    }

    match = /^\/api\/actions\/([^/]+)$/.exec(pathname);
    if (match !== null && request.method === "GET") {
      const receipt = session.actions.get(match[1]);
      if (receipt === undefined) {
        sendError(response, 404, "not_found", "No action exists with that identifier.");
        return;
      }
      sendJson(response, 200, { action: receipt });
      return;
    }

    //
    // Compose and send (SPEC F6 and F7).
    //

    if (pathname === "/api/drafts" && request.method === "POST") {
      const body = await readJsonBody(request);
      const account = session.accounts.find((entry) => entry.id === body?.accountId);
      if (account === undefined) {
        sendError(response, 404, "not_found", "No such account in the fixture.");
        return;
      }
      const identity = account.identities.find((entry) => entry.isDefault) ?? account.identities[0];
      const draft = newDraft(session, {
        accountId: account.id,
        identity: { address: identity.address, name: identity.name ?? null },
        replyParentId: null,
        threadId: null,
        inReplyTo: null,
      });
      sendJson(response, 201, { draft });
      return;
    }

    if (pathname === "/api/drafts/reply" && request.method === "POST") {
      const body = await readJsonBody(request);
      const parent = messageDetails.get(body?.messageId);
      if (parent === undefined) {
        sendError(response, 404, "not_found", "No such message in the fixture.");
        return;
      }
      // The fixture always asks for the account, so the interface's choice
      // step stays reachable on every reply.
      if (typeof body.accountId !== "string") {
        sendError(
          response,
          409,
          "account_choice_required",
          "Several accounts hold this message. Name the account to reply from.",
        );
        return;
      }
      const account = session.accounts.find((entry) => entry.id === body.accountId);
      if (account === undefined) {
        sendError(response, 404, "not_found", "No such account in the fixture.");
        return;
      }
      let identity = null;
      if (body.identity !== undefined) {
        identity = identityByAddress(account, body.identity.address);
        if (identity === null) {
          sendError(response, 400, "invalid_request", "That identity is not on the account.");
          return;
        }
      } else if (account.identities.length > 1) {
        sendError(
          response,
          409,
          "identity_choice_required",
          "This account holds several identities. Choose the one to send from.",
        );
        return;
      } else {
        identity = account.identities[0];
      }
      const self = identity.address;
      let recipients = null;
      if (body.recipients !== undefined) {
        recipients = body.recipients;
      } else {
        const others = (parent.recipients?.to ?? []).concat(parent.recipients?.cc ?? []).filter(
          (entry) => entry.address !== self,
        );
        recipients =
          body.mode === "reply_all" && others.length > 0
            ? { to: [parent.sender], cc: others }
            : { to: [parent.sender] };
      }
      if (recipients.to.length === 0) {
        sendError(
          response,
          409,
          "recipients_required",
          "The reply has no recipient. Name the recipients.",
        );
        return;
      }
      const subject = parent.subject === null ? null : parent.subject.replace(/^Re: /u, "");
      const draft = newDraft(session, {
        accountId: account.id,
        identity: { address: identity.address, name: identity.name ?? null },
        recipients: {
          to: recipients.to,
          cc: recipients.cc ?? [],
          bcc: recipients.bcc ?? [],
        },
        subject: `Re: ${subject ?? "(no subject)"}`,
        markdown: quotedReplyMarkdown(parent),
        replyParentId: parent.id,
        threadId: parent.threadId,
        inReplyTo: `<${parent.threadId}@fixture>`,
      });
      sendJson(response, 201, { draft });
      return;
    }

    if (pathname === "/api/drafts" && request.method === "GET") {
      const drafts = [...session.drafts.values()].sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
      sendJson(response, 200, { drafts });
      return;
    }

    match = /^\/api\/drafts\/([^/]+)$/.exec(pathname);
    if (match !== null && request.method === "GET") {
      const draft = session.drafts.get(match[1]);
      if (draft === undefined) {
        sendError(response, 404, "not_found", "No such draft in the fixture.");
        return;
      }
      sendJson(response, 200, { draft });
      return;
    }

    if (match !== null && request.method === "PATCH") {
      const draft = session.drafts.get(match[1]);
      if (draft === undefined) {
        sendError(response, 404, "not_found", "No such draft in the fixture.");
        return;
      }
      const body = await readJsonBody(request);
      if (body.identity !== undefined) {
        const account = session.accounts.find((entry) => entry.id === draft.accountId);
        const identity = account === undefined ? null : identityByAddress(account, body.identity.address);
        if (identity === null) {
          sendError(response, 400, "invalid_request", "That identity is not on the account.");
          return;
        }
        draft.identity = { address: identity.address, name: identity.name ?? null };
      }
      const rejection = applyDraftPatch(draft, body);
      if (rejection !== null) {
        sendError(
          response,
          rejection.status,
          rejection.code,
          "The draft could not accept that patch.",
          rejection.extra,
        );
        return;
      }
      sendJson(response, 200, { draft });
      return;
    }

    if (match !== null && request.method === "DELETE") {
      const draft = session.drafts.get(match[1]);
      if (draft === undefined) {
        sendError(response, 404, "not_found", "No such draft in the fixture.");
        return;
      }
      if (draft.lockedBySend !== null) {
        sendError(response, 409, "draft_locked", "A queued send holds this draft.");
        return;
      }
      session.drafts.delete(match[1]);
      session.attachments.delete(match[1]);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    if (pathname === "/api/uploads" && request.method === "POST") {
      const accountId = url.searchParams.get("accountId");
      const filename = url.searchParams.get("filename");
      const account = session.accounts.find((entry) => entry.id === accountId);
      if (account === undefined || filename === null || filename.length === 0) {
        sendError(response, 400, "invalid_request", "The upload names no account or filename.");
        return;
      }
      const bytes = await readRawBody(request);
      session.sequence += 1;
      const upload = {
        id: `u-${session.sequence}`,
        accountId,
        filename,
        contentType: request.headers["content-type"] ?? "application/octet-stream",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: new Date().toISOString(),
      };
      session.uploads.set(upload.id, upload);
      sendJson(response, 201, { upload });
      return;
    }

    match = /^\/api\/drafts\/([^/]+)\/uploads$/.exec(pathname);
    if (match !== null && request.method === "GET") {
      const attachments = session.attachments.get(match[1]);
      if (attachments === undefined) {
        sendError(response, 404, "not_found", "No such draft in the fixture.");
        return;
      }
      sendJson(response, 200, { attachments });
      return;
    }

    if (match !== null && request.method === "POST") {
      const attachments = session.attachments.get(match[1]);
      const body = await readJsonBody(request);
      const upload = session.uploads.get(body?.uploadId);
      if (attachments === undefined || upload === undefined) {
        sendError(response, 404, "not_found", "No such draft or upload in the fixture.");
        return;
      }
      if (attachments.some((entry) => entry.id === upload.id)) {
        sendError(response, 409, "invalid_request", "The draft already holds that upload.");
        return;
      }
      const attachment = { ...upload, ordinal: attachments.length + 1 };
      attachments.push(attachment);
      sendJson(response, 201, attachment);
      return;
    }

    match = /^\/api\/drafts\/([^/]+)\/uploads\/([^/]+)$/.exec(pathname);
    if (match !== null && request.method === "DELETE") {
      const attachments = session.attachments.get(match[1]);
      if (attachments === undefined || !attachments.some((entry) => entry.id === match[2])) {
        sendError(response, 404, "not_found", "No such attachment on the draft.");
        return;
      }
      session.attachments.set(
        match[1],
        attachments.filter((entry) => entry.id !== match[2]),
      );
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    match = /^\/api\/drafts\/([^/]+)\/send$/.exec(pathname);
    if (match !== null && request.method === "POST") {
      const draft = session.drafts.get(match[1]);
      if (draft === undefined) {
        sendError(response, 404, "not_found", "No such draft in the fixture.");
        return;
      }
      const body = await readJsonBody(request);
      if (typeof body?.idempotencyKey !== "string" || body.idempotencyKey.length === 0) {
        sendError(response, 400, "invalid_request", "The send names no idempotency key.");
        return;
      }
      const replayed = session.sendsByKey.get(body.idempotencyKey);
      if (replayed !== undefined) {
        sendJson(response, 200, { outbound: replayed });
        return;
      }
      if (body.baseRevision !== draft.revision) {
        sendJson(response, 409, "draft_stale", "The draft changed before the send.", {
          currentRevision: draft.revision,
        });
        return;
      }
      if (draft.lockedBySend !== null) {
        sendError(response, 409, "draft_locked", "A queued send already holds this draft.");
        return;
      }
      session.sequence += 1;
      const outbound = {
        id: `ob-${session.sequence}`,
        draftId: draft.id,
        accountId: draft.accountId,
        status: "queued",
        sentCopyStatus: "pending",
        identity: draft.identity,
        recipients: draft.recipients,
        subject: draft.subject,
        rfcMessageId: `<${randomUUID()}@fixture>`,
        recipientResults: [],
        smtpResponse: null,
        lastError: null,
        createdAt: new Date().toISOString(),
        sentAt: null,
      };
      session.outbounds.set(outbound.id, outbound);
      session.sendsByKey.set(body.idempotencyKey, outbound);
      draft.lockedBySend = outbound.id;
      sendJson(response, 202, { outbound });
      return;
    }

    match = /^\/api\/outbound\/([^/]+)$/.exec(pathname);
    if (match !== null && request.method === "GET") {
      const outbound = session.outbounds.get(match[1]);
      if (outbound === undefined) {
        sendError(response, 404, "not_found", "No such outbound attempt in the fixture.");
        return;
      }
      advanceOutbound(outbound, session.drafts.get(outbound.draftId ?? ""));
      sendJson(response, 200, { outbound });
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
      sendJson(response, 200, {
        accounts: session.accounts,
        recoveryGeneration: RECOVERY_GENERATION,
      });
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
      const rows = rowsFor(session, {
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
