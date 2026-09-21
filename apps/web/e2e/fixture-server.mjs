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
 * - `POST /api/auth/login/start` and `POST /api/auth/login/complete`
 *                             the passkey sign-in ceremony (SPEC section 9),
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
 * - `GET /api/home`           the Home overview, one visit per read (SPEC F13),
 * - `GET /api/home/sections/:id`, `GET /api/home/work`, and
 *   `GET /api/home/priorities` the Home detail reads,
 * - `POST /api/home/work` and `POST /api/home/work/:id/{reschedule,complete,
 *   reopen,cancel}` the saved-work writes,
 * - `PUT /api/home/priorities` and `POST/DELETE /api/home/dismissals`
 *                             the choice writes,
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
 * The guards the deployed API enforces are mirrored here, so a client
 * regression the real server would refuse fails these checks too: every
 * mutation must carry the deployed origin and the recovery generation the
 * session probe issued (SPEC sections 7 and 9), and without a session every
 * route but the availability probe and the sign-in ceremony answers 401.
 * `POST /api/fixture/session` with `{ "signedIn": false }` flips one
 * browser context into that signed-out state, which is how the sign-in
 * screen's path stays covered (SPEC section 12).
 *
 * Usage (standalone): `node e2e/fixture-server.mjs [port]` (default 4180,
 * `PORT` also works), serving `../dist` in the foreground. The browser
 * checks do not start it this way: `e2e/fixture-launch.mjs` (T112) builds
 * into an isolated directory, installs this handler on a port it owns,
 * and serves `/api/fixture/identity` with its run token and build
 * fingerprint, so a run can prove it tests its own build and no other.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  accounts,
  ACTION_KINDS,
  attachmentBytes,
  authStatus,
  cleanViews,
  FLAG_KINDS,
  foldersByAccount,
  homeCoverage,
  homeInitialBoundary,
  homeNextBoundary,
  homeSeedWork,
  homeSuggestionReasons,
  LOGIN_CHALLENGE,
  LOGIN_CREDENTIAL_ID,
  messageDetails,
  messageRows,
  namedRows,
  RECOVERY_GENERATION,
  settings,
  settingsSchema,
  syncStatus,
} from "./fixture-data.mjs";

/**
 * The fixture handler for one origin (T112): the API routes above plus the
 * static build, as one async request listener. The launcher and the
 * standalone CLI below each install it on the server they own. `distDir`
 * names the build output to serve; `identity` carries the run token and
 * build fingerprint the launcher reports at `/api/fixture/identity`.
 */
export function createFixtureHandler({ port, distDir, identity = null }) {
  /** The origin clients must present, the role `BASE_URL` plays in production. */
  const origin = `http://127.0.0.1:${port}`;
  /** The WebAuthn relying party the fixture's origin implies. */
  const rpId = new URL(origin).hostname;
  /** Cookie-keyed session state; one handler instance holds its own. */
  const sessions = new Map();

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
    // False while the context sits on the sign-in screen; the login
    // ceremony flips it back (SPEC section 9).
    signedIn: true,
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
    // Home state (SPEC F13): saved work, priority choices, suggestion
    // dismissals, and one visit boundary per device.
    home: {
      work: structuredClone(homeSeedWork),
      priorities: [],
      dismissals: [],
      boundaries: new Map(),
      sequence: 0,
    },
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

/**
 * The session this request belongs to, issuing a cookie for new contexts.
 * Must run before the response writes its headers.
 */
function sessionFor(request, response, sessions) {
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

//
// Home (SPEC F13): the sections build from the named rows plus the
// per-session work, priority choices, dismissals, and one visit boundary
// per device, so the shipped client meets the same shapes the API serves.
//

/** The inbox folder ids across every account. */
const INBOX_FOLDER_IDS = new Set(
  Object.values(foldersByAccount).flatMap((entry) =>
    entry.folders.filter((folder) => folder.role === "inbox").map((folder) => folder.id),
  ),
);

/** The named rows with the session's action patches applied, newest first. */
function homeBaseRows(session) {
  return namedRows
    .map((base) => {
      const patch = session.rowPatches.get(base.messageId);
      return patch === undefined ? base : { ...base, ...patch };
    })
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
}

/** The Home summary of one row: no folder or occurrence internals. */
function homeSummaryOf(item) {
  return {
    messageId: item.messageId,
    accountId: item.accountId,
    accountLabel: item.accountLabel,
    accountColor: item.accountColor,
    threadId: item.threadId,
    subject: item.subject,
    snippet: item.snippet,
    sender: item.sender,
    sentAt: item.sentAt,
    unread: item.unread,
    flagged: item.flagged,
    hasAttachments: item.hasAttachments,
  };
}

/** The summary shape a Home row carries one work record as. */
function workSummaryOf(work) {
  return {
    id: work.id,
    kind: work.kind,
    status: work.status,
    dueAt: work.dueAt,
    timeZone: work.timeZone,
    revision: work.revision,
    anchorUnavailable: work.anchorUnavailable,
  };
}

/** The full work record, with its anchor summary rebuilt from the rows. */
function homeWorkRecord(session, work) {
  const anchor = homeBaseRows(session).find((row) => row.messageId === work.anchorMessageId);
  return {
    ...workSummaryOf(work),
    accountId: work.accountId,
    anchorMessageId: work.anchorMessageId,
    anchor: anchor === undefined ? null : homeSummaryOf(anchor),
    occurrences: anchor?.occurrences ?? [],
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    completedAt: work.completedAt,
  };
}

/** One Home entry built from one row. */
function homeEntryOf(item, reasons, work) {
  return {
    entryKey: item.threadId ?? item.messageId,
    message: homeSummaryOf(item),
    messageIds: [item.messageId],
    reasons,
    work,
    occurrences: item.occurrences,
    noServerCopy: false,
  };
}

/** The work summaries of one row, due soonest first. */
function workOfRow(openWorkByMessage, messageId) {
  return (openWorkByMessage.get(messageId) ?? []).sort((a, b) => {
    if (a.dueAt === null) {
      return 1;
    }
    if (b.dueAt === null) {
      return -1;
    }
    return a.dueAt < b.dueAt ? -1 : 1;
  });
}

/**
 * Every Home section (SPEC F13): one conversation appears once, in the
 * highest section that applies. Choices rank ahead of recency inside a
 * section; reminders order by their due time; reply later orders oldest
 * first. `boundary` is the visit boundary this read uses; the caller
 * decides whether the read also records a new one.
 */
function buildHomeSections(session, boundary) {
  const rows = homeBaseRows(session);
  const taken = new Set();
  const openWork = session.home.work.filter((work) => work.status === "open");
  const openWorkByMessage = new Map();
  for (const work of openWork) {
    const list = openWorkByMessage.get(work.anchorMessageId) ?? [];
    list.push(work);
    openWorkByMessage.set(work.anchorMessageId, list);
  }
  const dismissed = new Set(
    session.home.dismissals.map((entry) => `${entry.accountId}:${entry.messageId}`),
  );

  /** The choice reasons a recorded priority justifies for one row. */
  const priorityReasonsOf = (row) => {
    const reasons = [];
    const sender = row.sender?.address.toLowerCase() ?? null;
    for (const choice of session.home.priorities) {
      if (choice.accountId !== row.accountId) {
        continue;
      }
      if (choice.target.kind === "sender" && sender !== null && choice.target.sender === sender) {
        reasons.push({ code: "you_prioritized_sender", origin: "choice" });
      }
      if (choice.target.kind === "thread" && choice.target.threadId === row.threadId) {
        reasons.push({ code: "you_prioritized_thread", origin: "choice" });
      }
    }
    return reasons;
  };

  // Due now: open reminders whose due time passed, earliest first.
  const now = new Date().toISOString();
  const dueItems = [];
  for (const work of openWork
    .filter((entry) => entry.kind === "reminder" && entry.dueAt !== null && entry.dueAt <= now)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1))) {
    const anchor = rows.find((row) => row.messageId === work.anchorMessageId);
    if (anchor === undefined) {
      continue;
    }
    taken.add(anchor.messageId);
    dueItems.push(
      homeEntryOf(anchor, [{ code: "reminder_due", origin: "choice" }], workOfRow(openWorkByMessage, anchor.messageId)),
    );
  }

  // Needs attention: inbox rows a choice or a stored answer justifies,
  // your choices first, then recency. A dismissed suggestion drops its row
  // unless a choice keeps it.
  const attention = [];
  for (const row of rows) {
    if (taken.has(row.messageId) || !INBOX_FOLDER_IDS.has(row.folderId)) {
      continue;
    }
    const choiceReasons = priorityReasonsOf(row);
    const suggestionReasons =
      dismissed.has(`${row.accountId}:${row.messageId}`) || choiceReasons.length > 0
        ? []
        : (homeSuggestionReasons.get(row.messageId) ?? []);
    if (choiceReasons.length === 0 && suggestionReasons.length === 0) {
      continue;
    }
    attention.push({
      row,
      reasons: [...choiceReasons, ...suggestionReasons],
      chosen: choiceReasons.length > 0,
    });
  }
  const attentionItems = attention
    .sort((a, b) => Number(b.chosen) - Number(a.chosen))
    .map((entry) => {
      taken.add(entry.row.messageId);
      return homeEntryOf(entry.row, entry.reasons, workOfRow(openWorkByMessage, entry.row.messageId));
    });

  // Reply later: open reply intentions, oldest first.
  const replyItems = [];
  for (const work of openWork
    .filter((entry) => entry.kind === "reply_later")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
    const anchor = rows.find((row) => row.messageId === work.anchorMessageId);
    if (anchor === undefined || taken.has(anchor.messageId)) {
      continue;
    }
    taken.add(anchor.messageId);
    replyItems.push(
      homeEntryOf(anchor, [{ code: "reply_planned", origin: "choice" }], workOfRow(openWorkByMessage, anchor.messageId)),
    );
  }

  // Since your last visit: inbox rows newer than the boundary this read
  // used; a first visit has no boundary and shows no arrivals.
  const arrivalItems =
    boundary === null
      ? []
      : rows
          .filter(
            (row) =>
              !taken.has(row.messageId) &&
              INBOX_FOLDER_IDS.has(row.folderId) &&
              row.sentAt > boundary,
          )
          .map((row) => {
            taken.add(row.messageId);
            return homeEntryOf(row, [{ code: "new_arrival", origin: "notice" }], []);
          });

  // Saved: starred rows no earlier section took.
  const savedItems = rows
    .filter((row) => !taken.has(row.messageId) && row.flagged)
    .map((row) => homeEntryOf(row, [{ code: "you_starred", origin: "choice" }], []));

  const sectionOf = (id, items) => ({ id, total: items.length, items, nextCursor: null });
  return [
    sectionOf("due_now", dueItems),
    sectionOf("needs_attention", attentionItems),
    sectionOf("reply_later", replyItems),
    sectionOf("since_visit", arrivalItems),
    sectionOf("saved", savedItems),
  ];
}

/** True when a string names a zone the platform calendar accepts. */
function timeZoneLooksValid(zone) {
  if (typeof zone !== "string" || zone.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A parseable instant in its normalized form, or `null`. */
function parseInstant(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** The visit boundary a device's next full Home read reports, then advances. */
function homeBoundaryFor(session, deviceId) {
  return session.home.boundaries.get(deviceId) ?? homeInitialBoundary;
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

/** The generation shape the recovery gate accepts (SPEC section 7). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Runs the guards every mutation passes in the deployed API (SPEC sections
 * 7 and 9), in the route order the real preHandlers use: the deployed
 * origin, then the session, then the recovery generation the session probe
 * issued. Sends the rejection and returns false when a guard refuses.
 */
function guardMutation(request, session, response) {
  if (request.headers.origin !== origin) {
    sendError(
      response,
      403,
      "origin_forbidden",
      "Requests must come from the deployed origin of this application.",
    );
    return false;
  }
  if (!session.signedIn) {
    sendError(response, 401, "unauthorized", "Sign in to continue.");
    return false;
  }
  const header = request.headers["x-recovery-generation"];
  const generation = typeof header === "string" ? header.trim().toLowerCase() : "";
  if (!UUID_PATTERN.test(generation)) {
    sendError(
      response,
      400,
      "invalid_recovery_generation",
      "Mail mutations must carry the recovery generation issued when the client state was created.",
    );
    return false;
  }
  if (generation !== RECOVERY_GENERATION) {
    sendError(
      response,
      409,
      "recovery_required",
      "The server was restored from an earlier history. Review the pending change, then retry under the current recovery generation.",
      { currentGeneration: RECOVERY_GENERATION },
    );
    return false;
  }
  return true;
}

/**
 * The shape the passkey assertion must have (SPEC section 9). The client
 * posts `{ response: assertion }`; the fixture does not verify the
 * signature, it only refuses a malformed ceremony.
 */
function assertionLooksValid(body) {
  const assertion = body?.response;
  return (
    assertion?.type === "public-key" &&
    typeof assertion.id === "string" &&
    assertion.id.length > 0 &&
    typeof assertion.rawId === "string" &&
    typeof assertion.response?.clientDataJSON === "string" &&
    typeof assertion.response?.authenticatorData === "string" &&
    typeof assertion.response?.signature === "string"
  );
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
  let file = candidate;
  if (info.isDirectory()) {
    file = join(candidate, "index.html");
    try {
      await stat(file);
    } catch {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
  }
  const type = MIME_TYPES.get(extname(file)) ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  // The tree can change under an open response (this launcher's shutdown
  // removes the directory). A file that vanishes is a 404 or a cut
  // response, never a crash of the server.
  createReadStream(file)
    .on("error", () => {
      if (!response.headersSent) {
        response.writeHead(404);
        response.end("Not found");
      } else {
        response.destroy();
      }
    })
    .pipe(response);
}

  const handler = async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (!pathname.startsWith("/api/")) {
      await serveStatic(request, response, pathname);
      return;
    }

    // The run identity (T112): a browser run verifies, before its tests
    // start, that the server answering on its port is the one its launcher
    // built — this token, this build fingerprint — and fails loudly rather
    // than test against a stale or foreign server. No session applies.
    if (pathname === "/api/fixture/identity" && request.method === "GET") {
      sendJson(response, 200, {
        runToken: identity?.runToken ?? null,
        fingerprint: identity?.fingerprint ?? null,
        port,
      });
      return;
    }

    const session = sessionFor(request, response, sessions);
    let match = null;

    // The control surface the checks drive directly: it flips this context
    // between signed in and signed out, so the sign-in path runs against
    // the shipped client. No API guard applies; the checks act as the
    // operator here, the way the console does in production.
    if (pathname === "/api/fixture/session" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (body === null || typeof body.signedIn !== "boolean") {
        sendError(response, 400, "invalid_request", "The control body must name signedIn.");
        return;
      }
      session.signedIn = body.signedIn;
      sendJson(response, 200, { signedIn: session.signedIn });
      return;
    }

    // The sign-in ceremony stays available without a session, the way the
    // deployed API keeps authentication open while mail work is blocked
    // (SPEC section 10). Only the origin guard applies.
    if (pathname === "/api/auth/login/start" && request.method === "POST") {
      if (request.headers.origin !== origin) {
        sendError(
          response,
          403,
          "origin_forbidden",
          "Requests must come from the deployed origin of this application.",
        );
        return;
      }
      sendJson(response, 200, {
        options: {
          challenge: LOGIN_CHALLENGE,
          timeout: 60_000,
          rpId,
          allowCredentials: [{ type: "public-key", id: LOGIN_CREDENTIAL_ID }],
          userVerification: "preferred",
        },
      });
      return;
    }

    if (pathname === "/api/auth/login/complete" && request.method === "POST") {
      if (request.headers.origin !== origin) {
        sendError(
          response,
          403,
          "origin_forbidden",
          "Requests must come from the deployed origin of this application.",
        );
        return;
      }
      if (!assertionLooksValid(await readJsonBody(request))) {
        sendError(
          response,
          400,
          "invalid_request",
          "The passkey response is not a WebAuthn assertion.",
        );
        return;
      }
      session.signedIn = true;
      const opened = new Date();
      sendJson(response, 200, {
        kind: "standard",
        verifiedAt: opened.toISOString(),
        expiresAt: new Date(opened.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
      return;
    }

    // Without a session every route but the availability probe refuses
    // (SPEC section 9), which is how a signed-out context reads 401.
    if (!session.signedIn && pathname !== "/api/auth/status") {
      sendError(response, 401, "unauthorized", "Sign in to continue.");
      return;
    }

    // Every write passes the deployed API's mutation guards first, so a
    // client that drops the origin or the recovery generation cannot pass
    // these checks (SPEC sections 7 and 9).
    if (request.method !== "GET" && !guardMutation(request, session, response)) {
      return;
    }

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

    //
    // Home writes (SPEC F13). Every one passed the mutation guards above,
    // so what remains is shape validation and the revision gates.
    //

    if (pathname === "/api/home/work" && request.method === "POST") {
      const body = await readJsonBody(request);
      const account = session.accounts.find((entry) => entry.id === body?.accountId);
      const anchor = homeBaseRows(session).find((row) => row.messageId === body?.anchorMessageId);
      if (account === undefined || anchor === undefined || anchor.accountId !== account.id) {
        sendError(response, 404, "not_found", "No such account or anchor message in the fixture.");
        return;
      }
      if (body === null || (body.kind !== "reply_later" && body.kind !== "reminder")) {
        sendError(response, 400, "invalid_request", "The work kind must be reply later or a reminder.");
        return;
      }
      let dueAt = null;
      if (body.kind === "reminder") {
        dueAt = parseInstant(body.dueAt);
        if (dueAt === null) {
          sendError(response, 400, "due_time_invalid", "The reminder needs a due time it can resolve.");
          return;
        }
        if (!timeZoneLooksValid(body.timeZone)) {
          sendError(response, 400, "time_zone_invalid", "The reminder needs a known time zone.");
          return;
        }
      }
      const now = new Date().toISOString();
      session.home.sequence += 1;
      const work = {
        id: `hw-${session.home.sequence}`,
        kind: body.kind,
        status: "open",
        dueAt,
        timeZone: body.kind === "reminder" ? body.timeZone : null,
        revision: 1,
        anchorUnavailable: false,
        accountId: account.id,
        anchorMessageId: anchor.messageId,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      session.home.work.push(work);
      sendJson(response, 201, { work: homeWorkRecord(session, work) });
      return;
    }

    match = /^\/api\/home\/work\/([^/]+)\/(reschedule|complete|reopen|cancel)$/.exec(pathname);
    if (match !== null && request.method === "POST") {
      const work = session.home.work.find((entry) => entry.id === match[1]);
      if (work === undefined) {
        sendError(response, 404, "not_found", "No such saved work in the fixture.");
        return;
      }
      const body = await readJsonBody(request);
      if (body?.revision !== work.revision) {
        sendError(response, 409, "work_stale", "This work changed on another device.", {
          currentRevision: work.revision,
        });
        return;
      }
      if (match[2] === "reschedule") {
        const dueAt = parseInstant(body.dueAt);
        if (dueAt === null) {
          sendError(response, 400, "due_time_invalid", "The reminder needs a due time it can resolve.");
          return;
        }
        if (!timeZoneLooksValid(body.timeZone)) {
          sendError(response, 400, "time_zone_invalid", "The reminder needs a known time zone.");
          return;
        }
        work.dueAt = dueAt;
        work.timeZone = body.timeZone;
      } else if (match[2] === "complete") {
        work.status = "done";
        work.completedAt = new Date().toISOString();
      } else if (match[2] === "reopen") {
        work.status = "open";
        work.completedAt = null;
      } else {
        session.home.work = session.home.work.filter((entry) => entry !== work);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      work.revision += 1;
      work.updatedAt = new Date().toISOString();
      sendJson(response, 200, { work: homeWorkRecord(session, work) });
      return;
    }

    if (pathname === "/api/home/priorities" && request.method === "PUT") {
      const body = await readJsonBody(request);
      const account = session.accounts.find((entry) => entry.id === body?.accountId);
      const target = body?.target;
      const targetValid =
        (target?.kind === "sender" && typeof target.sender === "string" && target.sender.length > 0) ||
        (target?.kind === "thread" && typeof target.threadId === "string" && target.threadId.length > 0);
      if (account === undefined) {
        sendError(response, 404, "not_found", "No such account in the fixture.");
        return;
      }
      if (body === null || !targetValid || typeof body.prioritized !== "boolean") {
        sendError(response, 400, "invalid_request", "The priority body names no account, target, or choice.");
        return;
      }
      const normalized = {
        kind: target.kind,
        ...(target.kind === "sender"
          ? { sender: target.sender.toLowerCase() }
          : { threadId: target.threadId }),
      };
      const existing = session.home.priorities.find(
        (choice) => choice.accountId === account.id && JSON.stringify(choice.target) === JSON.stringify(normalized),
      );
      if (body.prioritized) {
        const now = new Date().toISOString();
        if (existing === undefined) {
          session.home.sequence += 1;
          session.home.priorities.push({
            id: `hp-${session.home.sequence}`,
            accountId: account.id,
            target: normalized,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        if (existing === undefined) {
          sendError(response, 404, "not_found", "That priority choice is not recorded.");
          return;
        }
        if (body.revision !== existing.revision) {
          sendError(response, 409, "work_stale", "This priority changed on another device.", {
            currentRevision: existing.revision,
          });
          return;
        }
        session.home.priorities = session.home.priorities.filter((choice) => choice !== existing);
      }
      sendJson(response, 200, { priorities: session.home.priorities });
      return;
    }

    if (pathname === "/api/home/dismissals" && request.method === "POST") {
      const body = await readJsonBody(request);
      const account = session.accounts.find((entry) => entry.id === body?.accountId);
      const anchor = homeBaseRows(session).find((row) => row.messageId === body?.messageId);
      if (account === undefined || anchor === undefined || anchor.accountId !== account.id) {
        sendError(response, 404, "not_found", "No such account or message in the fixture.");
        return;
      }
      if (
        session.home.dismissals.some(
          (entry) => entry.accountId === account.id && entry.messageId === anchor.messageId,
        )
      ) {
        sendJson(response, 200, { dismissed: { accountId: account.id, messageId: anchor.messageId } });
        return;
      }
      session.home.dismissals.push({ accountId: account.id, messageId: anchor.messageId });
      sendJson(response, 201, { dismissed: { accountId: account.id, messageId: anchor.messageId } });
      return;
    }

    match = /^\/api\/home\/dismissals\/([^/]+)$/.exec(pathname);
    if (match !== null && request.method === "DELETE") {
      const accountId = url.searchParams.get("accountId");
      session.home.dismissals = session.home.dismissals.filter(
        (entry) => !(entry.messageId === match[1] && entry.accountId === accountId),
      );
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
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

    //
    // Home reads (SPEC F13): the full read is one visit, so it reports the
    // boundary it used and records the next one; the per-section route a
    // refresh takes never advances the boundary.
    //

    if (pathname === "/api/home") {
      const deviceId = url.searchParams.get("deviceId");
      if (deviceId === null || deviceId.length < 8 || deviceId.length > 100) {
        sendError(response, 400, "invalid_request", "The Home read names no valid device.");
        return;
      }
      const boundary = homeBoundaryFor(session, deviceId);
      session.home.boundaries.set(deviceId, homeNextBoundary);
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        sections: buildHomeSections(session, boundary),
        classification: structuredClone(homeCoverage),
        visitBoundary: boundary,
      });
      return;
    }

    match = /^\/api\/home\/sections\/([a-z_]+)$/.exec(pathname);
    if (match !== null) {
      const deviceId = url.searchParams.get("deviceId");
      if (deviceId === null || deviceId.length < 8 || deviceId.length > 100) {
        sendError(response, 400, "invalid_request", "The Home read names no valid device.");
        return;
      }
      const requestedBoundary = url.searchParams.get("visitBoundary");
      const boundary = requestedBoundary === "none" ? null : requestedBoundary ?? homeBoundaryFor(session, deviceId);
      const section = buildHomeSections(session, boundary).find(
        (entry) => entry.id === match[1],
      );
      if (section === undefined) {
        sendError(response, 404, "not_found", "The fixture holds no such Home section.");
        return;
      }
      sendJson(response, 200, { section });
      return;
    }

    if (pathname === "/api/home/work") {
      sendJson(response, 200, {
        work: session.home.work.filter((work) => {
          const status = url.searchParams.get("status");
          const kind = url.searchParams.get("kind");
          return (status === null || work.status === status) && (kind === null || work.kind === kind);
        }).map((work) => homeWorkRecord(session, work)),
        nextCursor: null,
      });
      return;
    }

    if (pathname === "/api/home/priorities") {
      sendJson(response, 200, { priorities: session.home.priorities });
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
  };

  return { handler, origin, rpId };
}

// The standalone CLI: serve the shared `dist` build on one port. The
// browser checks use the launcher instead; this path stays for manual
// inspection of the fixture against a build already on disk.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4180);
  const distDir = fileURLToPath(new URL("../dist", import.meta.url));
  // Fail fast when the build is missing: the checks would otherwise chase a
  // blank page.
  try {
    await readFile(join(distDir, "index.html"));
  } catch {
    console.error(`fixture server: ${distDir} holds no index.html. Run \`npm run build\` first.`);
    process.exit(1);
  }
  const { handler } = createFixtureHandler({ port, distDir });
  const server = createServer(handler);
  server.listen(port, "127.0.0.1", () => {
    console.log(`fixture server listening on http://127.0.0.1:${port}`);
  });
}
