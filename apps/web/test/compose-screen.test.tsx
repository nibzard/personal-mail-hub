// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@mail-hub/contracts";
import { ApiError } from "../src/lib/api.ts";
import { ComposeScreen } from "../src/components/mail/compose-screen.tsx";
import type { ComposeIntent } from "../src/components/mail/compose-screen.tsx";

/*
 * The compose surface's state machine: which account's identities a reply
 * choice offers, and whether the draft the user opened survives a creation
 * that was still in flight.
 */

const harness = vi.hoisted(() => ({
  drafts: [] as Array<{
    id: string;
    subject: string | null;
    lockedBySend: string | null;
    recipients: { to: Array<{ address: string }> };
    updatedAt: string;
  }> | null,
  phase: "ready" as "loading" | "ready" | "error",
  reload: vi.fn(),
  createNew: null as ((draft: { id: string }) => void) | null,
  createReply: null as ((error: unknown) => void) | null,
}));

vi.mock("../src/mail/compose-data.ts", () => ({
  useDrafts: () => ({
    phase: harness.phase,
    data: harness.drafts,
    error: null,
    reload: harness.reload,
  }),
  createNewDraft: () =>
    new Promise((resolve) => {
      harness.createNew = (draft) => resolve(draft);
    }),
  createReplyDraft: () =>
    new Promise((_, reject) => {
      harness.createReply = (error) => reject(error);
    }),
  parseRecipientList: (text: string) =>
    text
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((address) => ({ address })),
  invalidAddresses: () => [],
}));

vi.mock("../src/components/mail/draft-editor.tsx", () => ({
  DraftEditor: ({ draftId }: { draftId: string }) => (
    <div data-testid="draft-editor">{draftId}</div>
  ),
}));

function account(id: string, label: string, addresses: string[]): AccountSummary {
  return {
    id,
    label,
    color: "#2563eb",
    username: `user@${id}`,
    identities: addresses.map((address, index) => ({
      address,
      name: null,
      isDefault: index === 0,
    })),
  } as AccountSummary;
}

const ACCOUNTS = [
  account("acc-1", "Main", ["one@a.example"]),
  account("acc-2", "Side", ["two@b.example"]),
];

interface Mount {
  render(intent: ComposeIntent | null): void;
  text(): string;
  openDraft(id: string): void;
  cleanup(): void;
}

function mountScreen(): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const screen = (intent: ComposeIntent | null) => (
    <ComposeScreen
      open
      onOpenChange={() => undefined}
      accounts={ACCOUNTS}
      recoveryGeneration="gen-1"
      intent={intent}
      onSessionLost={() => undefined}
    />
  );
  return {
    render: (intent) => {
      act(() => {
        root.render(screen(intent));
      });
    },
    // The dialog portals into the document body, not the container.
    text: () => document.body.textContent ?? "",
    openDraft: (id) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="draft-list"] button'),
      );
      act(() => {
        rows.find((row) => row.textContent?.includes(id))?.click();
      });
    },
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const mounts: Mount[] = [];

function freshScreen(): Mount {
  const made = mountScreen();
  mounts.push(made);
  return made;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const made of mounts.splice(0)) {
    made.cleanup();
  }
  harness.drafts = [];
  harness.phase = "ready";
  harness.createNew = null;
  harness.createReply = null;
  harness.reload.mockClear();
});

describe("the compose screen", () => {
  it("asks for the account when the reply names none and the identity is open", async () => {
    const made = freshScreen();
    made.render({ kind: "reply", messageId: "m-1", mode: "reply" });
    await act(async () => {
      harness.createReply?.(
        new ApiError(409, "identity_choice_required", "Choose the From identity."),
      );
    });

    // The client cannot tell which account holds the parent, so it must not
    // offer another account's identities: every pick would come back
    // identity_invalid.
    expect(made.text()).toContain("Which account holds the message you reply to?");
    expect(made.text()).not.toContain("Which identity sends this reply?");
  });

  it("offers the named account's identities when the reply carries its account", async () => {
    const made = freshScreen();
    made.render({ kind: "reply", messageId: "m-1", accountId: "acc-2", mode: "reply" });
    await act(async () => {
      harness.createReply?.(
        new ApiError(409, "identity_choice_required", "Choose the From identity."),
      );
    });

    expect(made.text()).toContain("Which identity sends this reply?");
    expect(made.text()).toContain("two@b.example");
    expect(made.text()).not.toContain("one@a.example");
  });

  it("keeps the draft the user opened ahead of a creation still in flight", async () => {
    harness.drafts = [
      {
        id: "d-existing",
        subject: "Existing draft",
        lockedBySend: null,
        recipients: { to: [{ address: "someone@example.com" }] },
        updatedAt: "2026-09-18T10:00:00Z",
      },
    ];
    const made = freshScreen();
    made.render({ kind: "new", accountId: "acc-1" });
    expect(made.text()).toContain("Starting the draft.");

    // The user opens a draft while the creation request is still out.
    made.openDraft("Existing draft");
    expect(made.text()).toContain("d-existing");
    expect(made.text()).not.toContain("Starting the draft.");

    // The creation resolving must not overwrite the user's choice.
    await act(async () => {
      harness.createNew?.({ id: "d-new" });
    });
    await act(async () => {});
    expect(made.text()).toContain("d-existing");
    expect(made.text()).not.toContain("d-new");
    expect(harness.reload).toHaveBeenCalled();
  });

  it("clears a visible choice step when an intent opens a draft", async () => {
    const made = freshScreen();
    made.render({ kind: "reply", messageId: "m-1", mode: "reply" });
    await act(async () => {
      harness.createReply?.(
        new ApiError(409, "identity_choice_required", "Choose the From identity."),
      );
    });
    expect(made.text()).toContain("Which account holds the message");

    made.render({ kind: "draft", draftId: "d-9" });
    await act(async () => {});
    expect(made.text()).toContain("d-9");
    expect(made.text()).not.toContain("Which account holds the message");
  });

  it("keeps the drafts list on screen while a reload runs", () => {
    harness.drafts = [
      {
        id: "d-existing",
        subject: "Existing draft",
        lockedBySend: null,
        recipients: { to: [{ address: "someone@example.com" }] },
        updatedAt: "2026-09-18T10:00:00Z",
      },
    ];
    // A reload in flight keeps the last answer (SPEC F12): the list stays
    // mounted and the spinner overlays it instead of replacing it.
    harness.phase = "loading";
    const made = freshScreen();
    made.render(null);

    expect(document.querySelector('[data-testid="draft-list"]')).not.toBeNull();
    expect(made.text()).toContain("Existing draft");
    expect(made.text()).not.toContain("Loading drafts.");
    expect(document.querySelector('[data-testid="drafts-refreshing"]')).not.toBeNull();
  });

  it("shows the loading line only before the first answer arrives", () => {
    harness.drafts = null;
    harness.phase = "loading";
    const made = freshScreen();
    made.render(null);

    expect(document.querySelector('[data-testid="draft-list"]')).toBeNull();
    expect(made.text()).toContain("Loading drafts.");
  });
});
