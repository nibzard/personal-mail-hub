import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { MessageDetailResponse, ReadingErrorBody } from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { ReadingError, type MessageAttachment, type MessageDetail, type OpenedAttachment } from "@mail-hub/reading";
import { buildApp } from "../src/app.ts";
import { registerMessageRoutes, type ReadingServiceForRoutes } from "../src/message-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F3 and section 9): session enforcement, wire
 * views, error mapping, and download headers that stored MIME metadata
 * cannot inject into. Sanitizing and cache verification are covered by the
 * `@mail-hub/reading` and `@mail-hub/ingestion` suites.
 */

const TOKEN = "session-token-abc123";
const MESSAGE_ID = "3f0c8a21-77aa-4d5b-9e64-1c2b3a4d5e6f";
const ATTACHMENT_ID = "7a1d4e9b-3c2f-4e58-a067-3f5d2c1b4a98";
const ACCOUNT_ID = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const THREAD_ID = "0aa5b6c4-2211-4c8d-8f22-9b6c5d4e3f2a";
const SENT_AT = new Date("2026-09-18T10:00:00.000Z");
const DECODED = new Uint8Array([102, 111, 111, 98, 97, 114]);

const ATTACHMENT: MessageAttachment = {
  id: ATTACHMENT_ID,
  filename: "chart.png",
  contentType: "image/png",
  sizeBytes: DECODED.byteLength,
  contentId: "chart@reports",
  disposition: "inline",
  inlineResolvable: true,
};

const DETAIL: MessageDetail = {
  id: MESSAGE_ID,
  accountId: ACCOUNT_ID,
  threadId: THREAD_ID,
  subject: "Quarterly report",
  sender: { address: "alice@work.example", name: "Alice" },
  recipients: {
    to: [{ address: "bob@example.com", name: null }],
    cc: [{ address: "carol@example.com", name: "Carol" }],
  },
  sentAt: SENT_AT,
  fetchedBody: true,
  htmlSanitized: '<p>Numbers look <b>great</b>.</p>',
  textPlain: "Numbers look great.",
  attachments: [ATTACHMENT],
};

/** What the fake service recorded, for call assertions. */
interface ServiceCalls {
  readIds: string[];
  opened: { messageId: string; attachmentId: string }[];
}

/** A controllable stand-in for the reading service. */
function fakeService(
  overrides: Partial<ReadingServiceForRoutes> = {},
): ReadingServiceForRoutes & { calls: ServiceCalls } {
  const calls: ServiceCalls = { readIds: [], opened: [] };
  const base = {
    async readMessage(messageId: string): Promise<MessageDetail> {
      calls.readIds.push(messageId);
      if (messageId !== MESSAGE_ID) {
        throw new ReadingError("not_found", "No message exists with this identifier.");
      }
      return DETAIL;
    },
    async openAttachment(messageId: string, attachmentId: string): Promise<OpenedAttachment> {
      calls.opened.push({ messageId, attachmentId });
      if (attachmentId === MISSING_ID) {
        throw new ReadingError("not_found", "No attachment of this message exists with this identifier.");
      }
      return {
        attachment: { ...ATTACHMENT, ...pickMetadata(attachmentId) },
        bytes: DECODED,
      };
    },
  };
  const merged = { ...base, ...overrides } as ReadingServiceForRoutes;
  return Object.assign(merged, { calls });
}

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const INJECTING_ID = "11111111-1111-4111-8111-111111111111";
const NONIMAGE_ID = "22222222-2222-4222-8222-222222222222";

/** Per-id metadata used by the injection cases. */
function pickMetadata(attachmentId: string): Partial<MessageAttachment> {
  if (attachmentId === INJECTING_ID) {
    return {
      id: INJECTING_ID,
      filename: 'evil\r\nSet-Cookie: pwn=1; "tricky\\".png',
      contentType: "image/png; x=\r\nEvil: 1",
      inlineResolvable: false,
    };
  }
  if (attachmentId === NONIMAGE_ID) {
    return { id: NONIMAGE_ID, filename: "métriques éü.pdf", contentType: null, disposition: "attachment", contentId: null, inlineResolvable: false };
  }
  return {};
}

/** Build one app with reader routes and a signed-in session. */
async function makeApp(service: ReadingServiceForRoutes): Promise<FastifyInstance> {
  const app = buildApp();
  await registerMessageRoutes(app, {
    service,
    verifySession: (token) => {
      if (token !== TOKEN) {
        throw new AuthError("unauthorized", "Sign in to continue.");
      }
      return Promise.resolve(null);
    },
  });
  await app.ready();
  return app;
}

const sessionCookie = `${SESSION_COOKIE}=${TOKEN}`;
const sessionHeaders = { cookie: sessionCookie };

describe("message routes", () => {
  it("serves the wire detail for a live session only", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const anonymous = await app.inject({ method: "GET", url: `/messages/${MESSAGE_ID}` });
    expect(anonymous.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: `/messages/${MESSAGE_ID}`,
      headers: { cookie: `${SESSION_COOKIE}=wrong` },
    });
    expect(badToken.statusCode).toBe(401);

    // A fetch carries no Origin header; the session cookie is the credential.
    const detail = await app.inject({
      method: "GET",
      url: `/messages/${MESSAGE_ID}`,
      headers: sessionHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(service.calls.readIds).toEqual([MESSAGE_ID]);
    expect(detail.json<MessageDetailResponse>()).toEqual({
      message: {
        id: MESSAGE_ID,
        accountId: ACCOUNT_ID,
        threadId: THREAD_ID,
        subject: "Quarterly report",
        sender: { address: "alice@work.example", name: "Alice" },
        recipients: {
          to: [{ address: "bob@example.com", name: null }],
          cc: [{ address: "carol@example.com", name: "Carol" }],
        },
        sentAt: SENT_AT.toISOString(),
        fetchedBody: true,
        htmlSanitized: "<p>Numbers look <b>great</b>.</p>",
        textPlain: "Numbers look great.",
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: "chart.png",
            contentType: "image/png",
            sizeBytes: DECODED.byteLength,
            contentId: "chart@reports",
            disposition: "inline",
            inlineResolvable: true,
          },
        ],
      },
    });
  });

  it("downloads verified bytes with neutralized headers", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const download = await app.inject({
      method: "GET",
      url: `/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`,
      headers: sessionHeaders,
    });
    expect(download.statusCode).toBe(200);
    expect([...download.rawPayload]).toEqual([...DECODED]);
    expect(download.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(DECODED.byteLength),
      "content-disposition": `attachment; filename="chart.png"; filename*=UTF-8''chart.png`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    expect(service.calls.opened).toEqual([{ messageId: MESSAGE_ID, attachmentId: ATTACHMENT_ID }]);

    // A header the sender tried to smuggle through the metadata never lands:
    // the media type keeps only a parsable type/subtype and the filename
    // keeps only printable ASCII in the fallback form.
    const injected = await app.inject({
      method: "GET",
      url: `/messages/${MESSAGE_ID}/attachments/${INJECTING_ID}`,
      headers: sessionHeaders,
    });
    expect(injected.statusCode).toBe(200);
    expect(injected.headers["content-type"]).toBe("image/png");
    // No newlines, quotes, or backslashes survive; the attacker's text stays
    // inert content inside one quoted filename value.
    expect(injected.headers["content-disposition"]).toBe(
      'attachment; filename="evil__Set-Cookie: pwn=1; _tricky__.png"; '
        + `filename*=UTF-8''${encodeURIComponent('evil\r\nSet-Cookie: pwn=1; "tricky\\".png')}`,
    );

    // A missing media type serves a generic stream, and a non-ASCII filename
    // arrives through the UTF-8 extended form.
    const plain = await app.inject({
      method: "GET",
      url: `/messages/${MESSAGE_ID}/attachments/${NONIMAGE_ID}`,
      headers: sessionHeaders,
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-type"]).toBe("application/octet-stream");
    expect(plain.headers["content-disposition"]).toBe(
      `attachment; filename="m_triques __.pdf"; filename*=UTF-8''${encodeURIComponent("métriques éü.pdf")}`,
    );
  });

  it("maps reader rejections and rejects malformed identifiers", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const unknown = await app.inject({
      method: "GET",
      url: `/messages/${MISSING_ID}`,
      headers: sessionHeaders,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<ReadingErrorBody>()).toEqual({
      error: { code: "not_found", message: "No message exists with this identifier." },
    });

    const missingAttachment = await app.inject({
      method: "GET",
      url: `/messages/${MESSAGE_ID}/attachments/${MISSING_ID}`,
      headers: sessionHeaders,
    });
    expect(missingAttachment.statusCode).toBe(404);
    expect(missingAttachment.json<ReadingErrorBody>().error.code).toBe("not_found");

    const malformed = await app.inject({
      method: "GET",
      url: "/messages/not-a-uuid",
      headers: sessionHeaders,
    });
    expect(malformed.statusCode).toBe(400);

    const anonymous = await app.inject({
      method: "GET",
      url: `/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
