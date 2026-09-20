// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountSummary, DraftView } from "@mail-hub/contracts";

/*
 * The editor's dispose path: an edit inside the two-second debounce window
 * still belongs to the draft, so closing the editor or switching drafts
 * saves it instead of dropping it.
 */

const harness = vi.hoisted(() => ({
  saves: [] as Array<{ draftId: string; baseRevision: number; patch: unknown }>,
  draft: null as DraftView | null,
}));

vi.mock("../src/mail/compose-data.ts", () => ({
  readDraft: async () => harness.draft,
  draftSaveRunner:
    () =>
    async (draftId: string, baseRevision: number, patch: unknown) => {
      harness.saves.push({ draftId, baseRevision, patch });
      return { state: "saved", revision: baseRevision + 1 };
    },
  listDraftAttachments: async () => [],
  localUploadsOf: async () => [],
  useOutbound: () => ({ phase: "ready", outbound: null, message: null, reload: async () => {} }),
  addFileToDraft: async () => ({ state: "rejected", message: "" }),
  attachAcknowledgedUploads: async () => ({ changed: false, failed: 0 }),
  createResendDraft: async () => {
    throw new Error("unused");
  },
  detachDraftAttachment: async () => undefined,
  discardDraft: async () => undefined,
  newSendIdempotencyKey: () => "key",
  parseRecipientList: (text: string) =>
    text
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((address) => ({ address })),
  invalidAddresses: () => [],
  recipientCount: (recipients: { to: unknown[]; cc?: unknown[]; bcc?: unknown[] }) =>
    recipients.to.length + (recipients.cc?.length ?? 0) + (recipients.bcc?.length ?? 0),
  requestDraftSend: async () => ({ state: "rejected", message: "" }),
}));

vi.mock("../src/offline/sync-context.tsx", () => ({
  useOfflineSync: () => ({
    snapshot: null,
    online: true,
    syncing: false,
    observe: async () => undefined,
    resolve: async () => undefined,
    retry: async () => undefined,
    discard: async () => undefined,
  }),
}));

vi.mock("../src/components/mail/markdown-editor.tsx", () => ({
  MarkdownEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (markdown: string) => void;
  }) => (
    <textarea
      aria-label="Draft body in Markdown"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("../src/components/mail/message-body.tsx", () => ({
  useReaderColors: () => ({}),
  SanitizedMessageFrame: () => null,
}));

vi.mock("../src/components/mail/send-panel.tsx", () => ({
  SendPanel: () => null,
}));

import { DraftEditor } from "../src/components/mail/draft-editor.tsx";

function draftOf(id: string): DraftView {
  return {
    id,
    accountId: "acc-1",
    identity: { address: "one@a.example", name: null },
    recipients: { to: [{ address: "someone@example.com" }] },
    subject: "Subject",
    markdown: "original",
    revision: 4,
    lockedBySend: null,
    replyParentId: null,
    threadId: null,
    inReplyTo: null,
    referenceIds: [],
    updatedAt: "2026-09-18T10:00:00Z",
  };
}

const accounts: AccountSummary[] = [
  {
    id: "acc-1",
    label: "Main",
    color: "#2563eb",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecurity: "starttls_required",
    username: "user@a.example",
    identities: [{ address: "one@a.example", name: null, isDefault: true }],
    classifyEnabled: true,
    createdAt: "2026-09-01T00:00:00Z",
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root !== null) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  harness.saves.length = 0;
  harness.draft = null;
});

function mountEditor(draftId: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <DraftEditor
        session={{ recoveryGeneration: "gen-1" }}
        accounts={accounts}
        draftId={draftId}
        onDraftChanged={() => undefined}
        onDraftDiscarded={() => undefined}
        onSessionLost={() => undefined}
      />,
    );
  });
}

async function editBody(text: string) {
  const editor = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Draft body in Markdown"]',
  );
  expect(editor).not.toBeNull();
  await act(async () => {
    // React's controlled textarea deduplicates direct value writes; the
    // native setter keeps the change visible as a user edit.
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(editor!, text);
    editor!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the draft editor's dispose path", () => {
  it("saves an edit still inside the debounce window on close", async () => {
    harness.draft = draftOf("d-1");
    mountEditor("d-1");
    await act(async () => {});
    await editBody("edited behind the debounce");

    // No timer fired: the edit sits in the two-second window.
    expect(harness.saves).toEqual([]);

    act(() => {
      root!.unmount();
    });
    root = null;
    await act(async () => {});

    expect(harness.saves).toHaveLength(1);
    expect(harness.saves[0]!.draftId).toBe("d-1");
    expect(harness.saves[0]!.baseRevision).toBe(4);
    expect(harness.saves[0]!.patch).toEqual({ markdown: "edited behind the debounce" });
  });

  it("saves a pending edit when the switch targets another draft", async () => {
    harness.draft = draftOf("d-1");
    mountEditor("d-1");
    await act(async () => {});
    await editBody("edit before the switch");
    expect(harness.saves).toEqual([]);

    harness.draft = draftOf("d-2");
    act(() => {
      root!.render(
        <DraftEditor
          session={{ recoveryGeneration: "gen-1" }}
          accounts={accounts}
          draftId="d-2"
          onDraftChanged={() => undefined}
          onDraftDiscarded={() => undefined}
          onSessionLost={() => undefined}
        />,
      );
    });
    await act(async () => {});

    const forFirst = harness.saves.filter((save) => save.draftId === "d-1");
    expect(forFirst).toHaveLength(1);
    expect(forFirst[0]!.patch).toEqual({ markdown: "edit before the switch" });
  });
});
