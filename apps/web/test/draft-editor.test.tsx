// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountSummary, DraftView } from "@mail-hub/contracts";

/*
 * The editor's dispose path and send gate: an edit inside the two-second
 * debounce window still belongs to the draft, so closing the editor or
 * switching drafts saves it instead of dropping it. And a send whose flush
 * first fails never leaves with the stale revision the server acknowledges.
 */

const harness = vi.hoisted(() => ({
  saves: [] as Array<{ draftId: string; baseRevision: number; patch: unknown }>,
  draft: null as DraftView | null,
  /** When set, every save attempt ends in this outcome instead of saving. */
  saveOutcome: null as { state: "offline" } | { state: "error"; message: string } | null,
  /** Every send request the editor issued. */
  sendRequests: [] as Array<{ draftId: string; baseRevision: number; idempotencyKey: string }>,
}));

vi.mock("../src/mail/compose-data.ts", () => ({
  readDraft: async () => harness.draft,
  draftSaveRunner:
    () =>
    async (draftId: string, baseRevision: number, patch: unknown) => {
      harness.saves.push({ draftId, baseRevision, patch });
      if (harness.saveOutcome !== null) {
        return harness.saveOutcome;
      }
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
  requestDraftSend: async (
    draftId: string,
    baseRevision: number,
    idempotencyKey: string,
  ) => {
    harness.sendRequests.push({ draftId, baseRevision, idempotencyKey });
    return { state: "rejected", message: "" };
  },
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
  harness.saveOutcome = null;
  harness.sendRequests.length = 0;
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

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === label,
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

function sendNote(): string | null {
  return document.querySelector<HTMLElement>('[data-testid="send-note"]')?.textContent ?? null;
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

describe("the draft editor's send gate", () => {
  it("holds the send back when the flush before it fails", async () => {
    harness.draft = draftOf("d-1");
    harness.saveOutcome = { state: "error", message: "The draft could not be saved." };
    mountEditor("d-1");
    await act(async () => {});
    await editBody("edit the save cannot land");

    await act(async () => {
      buttonNamed("Send").click();
    });

    // The flush ran and failed, so the edit stays pending. The send never
    // leaves with revision 4, the last one the server acknowledged.
    expect(harness.saves).toHaveLength(1);
    expect(harness.sendRequests).toEqual([]);
    expect(sendNote()).toBe("The draft could not be saved. Try saving again before sending.");
  });

  it("holds the send back when the flush parks the edit offline", async () => {
    harness.draft = draftOf("d-1");
    harness.saveOutcome = { state: "offline" };
    mountEditor("d-1");
    await act(async () => {});
    await editBody("edit waiting on this device");

    await act(async () => {
      buttonNamed("Send").click();
    });

    expect(harness.sendRequests).toEqual([]);
    expect(sendNote()).toBe(
      "Offline. The draft edits wait on this device. Reconnect before sending.",
    );
  });

  it("keeps the send control off while a save sits on an error", async () => {
    harness.draft = draftOf("d-1");
    harness.saveOutcome = { state: "error", message: "The draft could not be saved." };
    mountEditor("d-1");
    await act(async () => {});
    await editBody("edit the save cannot land");

    // Save now, so the error surfaces before any send attempt.
    await act(async () => {
      buttonNamed("Save now").click();
    });
    expect(harness.saves).toHaveLength(1);

    expect(buttonNamed("Send").disabled).toBe(true);
    expect(harness.sendRequests).toEqual([]);
  });
});
