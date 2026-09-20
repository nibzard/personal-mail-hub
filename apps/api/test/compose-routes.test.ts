import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  ComposeErrorBody,
  DraftAttachmentsResponse,
  DraftResponse,
  DraftsResponse,
  DraftUploadVerificationResponse,
  UploadResponse,
} from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import {
  ComposeError,
  DRAFT_BODY_MAX_BYTES,
  MARKDOWN_MAX,
  type DraftAttachmentRecord,
  type DraftRecord,
  type MutationContext,
  type UploadRecord,
} from "@mail-hub/compose";
import { buildApp } from "../src/app.ts";
import { registerComposeRoutes, type ComposeServiceForRoutes } from "../src/compose-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F6, F9, and section 9): origin and session
 * enforcement, recovery-generation forwarding, error mapping with the stale
 * revision, raw upload bodies, and wire views. Durable writes, locking, and
 * revision rules are covered by the `@mail-hub/compose` suite.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const DRAFT_ID = "c65d4ac2-1b6e-45f0-9be4-7ac1a89be9a0";
const UPLOAD_ID = "5f2d51f3-9f0b-4c8e-a4e1-2f0e1e9a1b52";
const MESSAGE_ID = "3f0c8a21-77aa-4d5b-9e64-1c2b3a4d5e6f";
const OUTBOUND_ID = "7e1d2c3b-4f5a-6b7c-8d9e-0f1a2b3c4d5e";
const THREAD_ID = "0aa5b6c4-2211-4c8d-8f22-9b6c5d4e3f2a";
const NOW = new Date("2026-09-18T10:00:00.000Z");

const DRAFT: DraftRecord = {
  id: DRAFT_ID,
  accountId: ACCOUNT_ID,
  identity: { address: "user@example.com", name: "Main User" },
  recipients: { to: [{ address: "friend@example.com", name: null }] },
  subject: "Hello",
  markdown: "**Hi**",
  revision: 1,
  lockedBySend: null,
  replyParentId: null,
  threadId: null,
  inReplyTo: null,
  referenceIds: [],
  updatedAt: NOW,
};

/** A reply draft as the service returns it: frozen parent and references. */
const REPLY_DRAFT: DraftRecord = {
  ...DRAFT,
  recipients: { to: [{ address: "sender@example.com", name: null }] },
  subject: "Re: Hello",
  replyParentId: MESSAGE_ID,
  threadId: THREAD_ID,
  inReplyTo: "<parent@example.com>",
  referenceIds: ["<parent@example.com>"],
};

const UPLOAD: UploadRecord = {
  id: UPLOAD_ID,
  accountId: ACCOUNT_ID,
  filename: "notes.txt",
  contentType: "text/plain",
  sizeBytes: 4,
  sha256: "a".repeat(64),
  createdAt: NOW,
};

const ATTACHMENT: DraftAttachmentRecord = { ...UPLOAD, ordinal: 0 };

/** What the fake service recorded, for call assertions. */
interface ServiceCalls {
  generations: (string | null | undefined)[];
  createdAccounts: string[];
  replyParents: string[];
  replyModes: string[];
  resentOutbounds: string[];
  updatedIds: string[];
  deletedIds: string[];
  uploadedAccounts: (string | null)[];
  uploadedBytes: Uint8Array[];
  attached: { draftId: string; uploadId: string }[];
  detached: { draftId: string; uploadId: string }[];
}

/** A controllable stand-in for the compose service. */
function fakeService(
  overrides: Partial<ComposeServiceForRoutes> = {},
): ComposeServiceForRoutes & { calls: ServiceCalls } {
  const calls: ServiceCalls = {
    generations: [],
    createdAccounts: [],
    replyParents: [],
    replyModes: [],
    resentOutbounds: [],
    updatedIds: [],
    deletedIds: [],
    uploadedAccounts: [],
    uploadedBytes: [],
    attached: [],
    detached: [],
  };
  const track = (context: MutationContext) => {
    calls.generations.push(context.requestGeneration);
  };
  const base = {
    async listDrafts() {
      return [DRAFT];
    },
    async readDraft(id: string) {
      if (id !== DRAFT_ID) {
        throw new ComposeError("not_found", "No draft exists with this identifier.");
      }
      return DRAFT;
    },
    async createDraft(context: MutationContext, input: { accountId: string }) {
      track(context);
      calls.createdAccounts.push(input.accountId);
      return { ...DRAFT, accountId: input.accountId };
    },
    async createReplyDraft(
      context: MutationContext,
      input: { messageId: string; mode: string; accountId?: string },
    ) {
      track(context);
      calls.replyParents.push(input.messageId);
      calls.replyModes.push(input.mode);
      if (input.accountId === undefined) {
        // A grouped copy in several accounts: the choice is required.
        throw new ComposeError("account_choice_required", "Choose the account to reply from.");
      }
      return { ...REPLY_DRAFT, accountId: input.accountId };
    },
    async createResendDraft(context: MutationContext, outboundId: string) {
      track(context);
      calls.resentOutbounds.push(outboundId);
      return { ...DRAFT, subject: "Re-sent copy" };
    },
    async updateDraft(context: MutationContext, id: string, input: { baseRevision: number; markdown?: string }) {
      track(context);
      calls.updatedIds.push(id);
      if (input.baseRevision !== DRAFT.revision) {
        throw new ComposeError("draft_stale", "This draft changed elsewhere.", DRAFT.revision);
      }
      if (input.markdown === "locked") {
        throw new ComposeError("draft_locked", "This draft is locked by a queued send.");
      }
      return { ...DRAFT, revision: DRAFT.revision + 1, markdown: input.markdown ?? DRAFT.markdown };
    },
    async deleteDraft(context: MutationContext, id: string) {
      track(context);
      calls.deletedIds.push(id);
    },
    async createUpload(
      context: MutationContext,
      input: { accountId: string; bytes: Uint8Array; filename: string; contentType?: string | null },
    ) {
      track(context);
      calls.uploadedAccounts.push(input.accountId);
      calls.uploadedBytes.push(input.bytes);
      return {
        ...UPLOAD,
        filename: input.filename,
        contentType: input.contentType ?? "application/octet-stream",
        sizeBytes: input.bytes.byteLength,
      };
    },
    async attachUpload(context: MutationContext, draftId: string, uploadId: string) {
      track(context);
      calls.attached.push({ draftId, uploadId });
      return ATTACHMENT;
    },
    async detachUpload(context: MutationContext, draftId: string, uploadId: string) {
      track(context);
      calls.detached.push({ draftId, uploadId });
    },
    async listDraftAttachments(draftId: string) {
      if (draftId !== DRAFT_ID) {
        throw new ComposeError("not_found", "No draft exists with this identifier.");
      }
      return [ATTACHMENT];
    },
    async verifyDraftUploads(draftId: string) {
      return { draftId, ok: true, uploads: [{ uploadId: UPLOAD_ID, filename: "notes.txt", verified: true }] };
    },
  };
  const merged = { ...base, ...overrides } as ComposeServiceForRoutes;
  return Object.assign(merged, { calls });
}

/** Build one app with compose routes and a signed-in session. */
async function makeApp(service: ComposeServiceForRoutes): Promise<FastifyInstance> {
  const app = buildApp();
  await registerComposeRoutes(app, {
    service,
    origin: ORIGIN,
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
const originHeaders = { origin: ORIGIN, cookie: sessionCookie };

describe("compose routes", () => {
  it("lists drafts for a live session only", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const anonymous = await app.inject({ method: "GET", url: "/drafts" });
    expect(anonymous.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: "/drafts",
      headers: { cookie: `${SESSION_COOKIE}=wrong` },
    });
    expect(badToken.statusCode).toBe(401);

    const listed = await app.inject({ method: "GET", url: "/drafts", headers: { cookie: sessionCookie } });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<DraftsResponse>();
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0]).toEqual({
      id: DRAFT_ID,
      accountId: ACCOUNT_ID,
      identity: { address: "user@example.com", name: "Main User" },
      recipients: { to: [{ address: "friend@example.com", name: null }], cc: [], bcc: [] },
      subject: "Hello",
      markdown: "**Hi**",
      revision: 1,
      lockedBySend: null,
      replyParentId: null,
      threadId: null,
      inReplyTo: null,
      referenceIds: [],
      updatedAt: NOW.toISOString(),
    });
  });

  it("creates a draft from the deployed origin with the captured generation", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const foreignOrigin = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { origin: "https://evil.example", cookie: sessionCookie, "content-type": "application/json" },
      payload: { accountId: ACCOUNT_ID },
    });
    expect(foreignOrigin.statusCode).toBe(403);

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { accountId: ACCOUNT_ID },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...originHeaders, "content-type": "application/json", "x-recovery-generation": GENERATION },
      payload: {
        accountId: ACCOUNT_ID,
        identity: { address: "alias@example.com" },
        recipients: { to: [{ address: "friend@example.com" }] },
        subject: "Hello",
        markdown: "**Hi**",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<DraftResponse>().draft.id).toBe(DRAFT_ID);
    expect(service.calls.generations).toEqual([GENERATION]);
    expect(service.calls.createdAccounts).toEqual([ACCOUNT_ID]);

    const invalid = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { accountId: "not-a-uuid" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("creates a reply draft and maps its choice rejections", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const choiceRequired = await app.inject({
      method: "POST",
      url: "/drafts/reply",
      headers: { ...originHeaders, "content-type": "application/json", "x-recovery-generation": GENERATION },
      payload: { messageId: MESSAGE_ID, mode: "reply" },
    });
    expect(choiceRequired.statusCode).toBe(409);
    expect(choiceRequired.json<ComposeErrorBody>().error.code).toBe("account_choice_required");

    const created = await app.inject({
      method: "POST",
      url: "/drafts/reply",
      headers: { ...originHeaders, "content-type": "application/json", "x-recovery-generation": GENERATION },
      payload: {
        messageId: MESSAGE_ID,
        accountId: ACCOUNT_ID,
        mode: "reply_all",
        identity: { address: "alias@example.com" },
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<DraftResponse>().draft;
    expect(draft.replyParentId).toBe(MESSAGE_ID);
    expect(draft.inReplyTo).toBe("<parent@example.com>");
    expect(draft.referenceIds).toEqual(["<parent@example.com>"]);
    expect(service.calls.replyParents).toEqual([MESSAGE_ID, MESSAGE_ID]);
    expect(service.calls.replyModes).toEqual(["reply", "reply_all"]);
    expect(service.calls.generations).toEqual([GENERATION, GENERATION]);

    const invalidMode = await app.inject({
      method: "POST",
      url: "/drafts/reply",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { messageId: MESSAGE_ID, mode: "forward" },
    });
    expect(invalidMode.statusCode).toBe(400);

    const anonymous = await app.inject({
      method: "POST",
      url: "/drafts/reply",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: { messageId: MESSAGE_ID, mode: "reply" },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("issues the resend copy of an unresolved send from the deployed origin", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const foreignOrigin = await app.inject({
      method: "POST",
      url: `/outbound/${OUTBOUND_ID}/resend-draft`,
      headers: { origin: "https://evil.example", cookie: sessionCookie },
    });
    expect(foreignOrigin.statusCode).toBe(403);

    const anonymous = await app.inject({
      method: "POST",
      url: `/outbound/${OUTBOUND_ID}/resend-draft`,
      headers: { origin: ORIGIN },
    });
    expect(anonymous.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: `/outbound/${OUTBOUND_ID}/resend-draft`,
      headers: { ...originHeaders, "x-recovery-generation": GENERATION },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<DraftResponse>().draft;
    expect(draft.id).toBe(DRAFT_ID);
    expect(draft.subject).toBe("Re-sent copy");
    expect(draft.lockedBySend).toBeNull();
    expect(service.calls.resentOutbounds).toEqual([OUTBOUND_ID]);
    expect(service.calls.generations).toEqual([GENERATION]);

    const invalid = await app.inject({
      method: "POST",
      url: "/outbound/not-a-uuid/resend-draft",
      headers: originHeaders,
    });
    expect(invalid.statusCode).toBe(400);

    // A resolved send refuses the copy through the error contract.
    const refused = fakeService({
      createResendDraft: async () => {
        throw new ComposeError(
          "invalid_request",
          "Only a send whose outcome is unknown can be resent from a copy.",
        );
      },
    });
    const refusalApp = await makeApp(refused);
    const rejected = await refusalApp.inject({
      method: "POST",
      url: `/outbound/${OUTBOUND_ID}/resend-draft`,
      headers: originHeaders,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<ComposeErrorBody>().error.code).toBe("invalid_request");
  });

  it("maps stale revisions to 409 with the current revision", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const stale = await app.inject({
      method: "PATCH",
      url: `/drafts/${DRAFT_ID}`,
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { baseRevision: 99, markdown: "late edit" },
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json<ComposeErrorBody>();
    expect(body.error.code).toBe("draft_stale");
    expect(body.error.currentRevision).toBe(1);

    const accepted = await app.inject({
      method: "PATCH",
      url: `/drafts/${DRAFT_ID}`,
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { baseRevision: 1, markdown: "fresh edit" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<DraftResponse>().draft.revision).toBe(2);

    const locked = await app.inject({
      method: "PATCH",
      url: `/drafts/${DRAFT_ID}`,
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { baseRevision: 1, markdown: "locked" },
    });
    expect(locked.statusCode).toBe(423);
    expect(locked.json<ComposeErrorBody>().error.code).toBe("draft_locked");

    const missing = await app.inject({
      method: "GET",
      url: `/drafts/${ACCOUNT_ID}`,
      headers: { cookie: sessionCookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("deletes a draft and detaches its uploads on request", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const removed = await app.inject({ method: "DELETE", url: `/drafts/${DRAFT_ID}`, headers: originHeaders });
    expect(removed.statusCode).toBe(204);
    expect(service.calls.deletedIds).toEqual([DRAFT_ID]);

    const detached = await app.inject({
      method: "DELETE",
      url: `/drafts/${DRAFT_ID}/uploads/${UPLOAD_ID}`,
      headers: originHeaders,
    });
    expect(detached.statusCode).toBe(204);
    expect(service.calls.detached).toEqual([{ draftId: DRAFT_ID, uploadId: UPLOAD_ID }]);
  });

  it("receives raw upload bodies under their own media type", async () => {
    const service = fakeService();
    const app = await makeApp(service);
    const bytes = new TextEncoder().encode("%PDF-1.7 fake");

    const upload = await app.inject({
      method: "POST",
      url: `/uploads?accountId=${ACCOUNT_ID}&filename=report.pdf`,
      headers: { ...originHeaders, "content-type": "application/pdf" },
      payload: Buffer.from(bytes),
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json<UploadResponse>().upload;
    expect(body.filename).toBe("report.pdf");
    expect(body.contentType).toBe("application/pdf");
    expect(body.sizeBytes).toBe(bytes.byteLength);
    expect(service.calls.uploadedAccounts).toEqual([ACCOUNT_ID]);
    expect(Buffer.from(service.calls.uploadedBytes[0]!)).toEqual(Buffer.from(bytes));

    // The account and the file name are required query parameters.
    const unnamed = await app.inject({
      method: "POST",
      url: `/uploads?accountId=${ACCOUNT_ID}`,
      headers: { ...originHeaders, "content-type": "application/pdf" },
      payload: Buffer.from(bytes),
    });
    expect(unnamed.statusCode).toBe(400);

    const anonymous = await app.inject({
      method: "POST",
      url: `/uploads?accountId=${ACCOUNT_ID}&filename=report.pdf`,
      headers: { origin: ORIGIN, "content-type": "application/pdf" },
      payload: Buffer.from(bytes),
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("lists, attaches, and verifies draft uploads", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const listed = await app.inject({
      method: "GET",
      url: `/drafts/${DRAFT_ID}/uploads`,
      headers: { cookie: sessionCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<DraftAttachmentsResponse>().attachments[0]!.ordinal).toBe(0);

    const attached = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/uploads`,
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { uploadId: UPLOAD_ID },
    });
    expect(attached.statusCode).toBe(201);
    expect(attached.json().ordinal).toBe(0);
    expect(service.calls.attached).toEqual([{ draftId: DRAFT_ID, uploadId: UPLOAD_ID }]);

    const verified = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/verify-uploads`,
      headers: originHeaders,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json<DraftUploadVerificationResponse>()).toEqual({
      draftId: DRAFT_ID,
      ok: true,
      uploads: [{ uploadId: UPLOAD_ID, filename: "notes.txt", verified: true }],
    });
  });

  it("reports blocked recovery before any compose write", async () => {
    const service = fakeService({
      createDraft: async () => {
        throw new RecoveryBlockedError("recovery_required");
      },
    });
    const app = await makeApp(service);

    const blocked = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { accountId: ACCOUNT_ID },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<ComposeErrorBody>().error.code).toBe("recovery_required");
  });

  it("keeps JSON bodies on the draft routes working beside the raw parser", async () => {
    const service = fakeService();
    const app = await makeApp(service);
    const spy = vi.spyOn(service, "updateDraft");

    const patched = await app.inject({
      method: "PATCH",
      url: `/drafts/${DRAFT_ID}`,
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { baseRevision: 1, markdown: "still json" },
    });
    expect(patched.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
  });

  it("accepts a large Markdown draft past the ordinary JSON limit", async () => {
    const lengths: (number | undefined)[] = [];
    const service = fakeService({
      createDraft: async (_context, input: { accountId: string; markdown?: string }) => {
        lengths.push(input.markdown?.length);
        return { ...DRAFT, markdown: input.markdown ?? "" };
      },
    });
    const app = await makeApp(service);

    // Markdown at its character ceiling, padded past the one MiB every
    // other JSON route accepts: the draft must reach the service, not die
    // in the parser with a generic 413.
    const padded =
      " ".repeat(64 * 1024) +
      JSON.stringify({ accountId: ACCOUNT_ID, markdown: "a".repeat(MARKDOWN_MAX) });
    expect(padded.length).toBeGreaterThan(1024 * 1024);
    const large = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: padded,
    });
    expect(large.statusCode).toBe(201);
    expect(lengths).toEqual([MARKDOWN_MAX]);

    // Over the ceiling the refusal stays inside the error contract.
    const oversized = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { accountId: ACCOUNT_ID, markdown: "a".repeat(DRAFT_BODY_MAX_BYTES) },
    });
    expect(oversized.statusCode).toBe(413);
    const body = oversized.json<ComposeErrorBody>();
    expect(body.error.code).toBe("invalid_request");
    expect(typeof body.error.message).toBe("string");
  });

  it("answers an unclassified failure with a generic internal error", async () => {
    const service = fakeService({
      createDraft: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:5432 topology secret");
      },
    });
    const app = await makeApp(service);

    const failed = await app.inject({
      method: "POST",
      url: "/drafts",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { accountId: ACCOUNT_ID },
    });
    expect(failed.statusCode).toBe(500);
    const body = failed.json<ComposeErrorBody>();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toContain("ECONNREFUSED");
    expect(failed.rawPayload).not.toContain("ECONNREFUSED");
  });
});
