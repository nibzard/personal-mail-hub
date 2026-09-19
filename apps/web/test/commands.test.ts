// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountSummary,
  FolderSummary,
  SearchResultItem,
} from "@mail-hub/contracts";
import {
  buildMailCommands,
  nextSelectedIndex,
  shortcutCommandId,
  type MailCommandHandlers,
  type MailCommandsInput,
} from "../src/mail/commands.ts";
import { prefixFilter } from "../src/components/mail/command-palette.tsx";
import { rescueDialogFocus } from "../src/lib/focus.ts";
import { shouldRunSingleKey } from "../src/lib/keyboard.ts";
import { isPaletteShortcut, paletteShortcutKeys } from "../src/lib/platform.ts";

/*
 * The command registry and its keyboard rules (SPEC F3 and F11): the palette
 * content, availability with reasons, nested choosers, the single-key table,
 * the shortcut scope guard, and focus restoration fallbacks.
 */

const ACCOUNT_A: AccountSummary = {
  id: "a1",
  label: "Personal",
  color: "#336699",
  imapHost: "imap.example",
  imapPort: 993,
  smtpHost: "smtp.example",
  smtpPort: 465,
  smtpSecurity: "implicit_tls",
  username: "me@example.com",
  identities: [],
  classifyEnabled: false,
  createdAt: "2026-01-01T00:00:00Z",
};

const ACCOUNT_B: AccountSummary = { ...ACCOUNT_A, id: "a2", label: "Work" };

const FOLDERS_A: FolderSummary[] = [
  { id: "f-archive", name: "Old", role: "archive" },
  { id: "f-inbox", name: "INBOX", role: "inbox" },
  { id: "f-misc", name: "Zebra", role: null },
];

function row(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    messageId: "m1",
    accountId: "a1",
    accountLabel: "Personal",
    accountColor: "#336699",
    threadId: null,
    subject: "Quarterly report",
    snippet: "Numbers attached.",
    sender: { address: "boss@example.com", name: "Boss" },
    sentAt: "2026-09-18T08:00:00Z",
    fetchedBody: true,
    hasAttachments: false,
    unread: true,
    flagged: false,
    activeOccurrences: 1,
    noServerCopy: false,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
    ...overrides,
  };
}

/** The command set plus the handler spies the commands run through. */
function build(overrides: Partial<MailCommandsInput> = {}) {
  const handlers: MailCommandHandlers = {
    changeScope: vi.fn(),
    focusSearch: vi.fn(),
    moveSelection: vi.fn(),
    openSelection: vi.fn(),
    setTheme: vi.fn(),
    setSingleKeyShortcuts: vi.fn(),
  };
  const input: MailCommandsInput = {
    accounts: [ACCOUNT_A, ACCOUNT_B],
    folders: new Map([["a1", FOLDERS_A]]),
    scope: { kind: "unified-inbox" },
    rows: [row()],
    selected: row(),
    singleKeyShortcuts: true,
    theme: "system",
    handlers,
  };
  return { handlers, commands: buildMailCommands({ ...input, ...overrides, handlers }) };
}

describe("buildMailCommands", () => {
  it("lists every command the palette must include (SPEC F11)", () => {
    const unread = build({ selected: row({ unread: true }) }).commands;
    const read = build({ selected: row({ unread: false, flagged: true }) }).commands;
    const labels = unread.map((command) => command.label);

    for (const expected of [
      "Go to Inbox",
      "Go to All Mail",
      "Go to account or folder…",
      "Search mail",
      "New message",
      "Reply",
      "Reply all",
      "Archive",
      "Move to folder…",
      "Theme…",
      "Open settings",
    ]) {
      expect(labels).toContain(expected);
    }
    // The read/unread and star/unstar pairs follow the selected message.
    expect(unread.map((command) => command.label)).toContain("Mark as unread");
    expect(read.map((command) => command.label)).toContain("Mark as read");
    expect(unread.map((command) => command.label)).toContain("Star");
    expect(read.map((command) => command.label)).toContain("Remove star");
  });

  it("runs navigation commands through the shared handlers", () => {
    const { commands, handlers } = build();
    const byLabel = (label: string) =>
      commands.find((command) => command.label === label)!;

    byLabel("Go to Inbox").run?.();
    expect(handlers.changeScope).toHaveBeenCalledWith({ kind: "unified-inbox" });
    byLabel("Go to All Mail").run?.();
    expect(handlers.changeScope).toHaveBeenCalledWith({ kind: "all-mail" });
    byLabel("Search mail").run?.();
    expect(handlers.focusSearch).toHaveBeenCalledOnce();
    byLabel("Next message").run?.();
    expect(handlers.moveSelection).toHaveBeenCalledWith(1);
    byLabel("Previous message").run?.();
    expect(handlers.moveSelection).toHaveBeenCalledWith(-1);
    byLabel("Open the selected message").run?.();
    expect(handlers.openSelection).toHaveBeenCalledOnce();
  });

  it("keeps unavailable commands listed with their reason", () => {
    const withSelection = build().commands;
    const messageActions = withSelection.filter(
      (command) => command.group === "message-actions",
    );
    expect(messageActions.length).toBeGreaterThanOrEqual(4);
    for (const command of messageActions) {
      expect(command.unavailableReason).toMatch(/routes for flags and moves/);
      // The frozen target stays visible next to the reason (SPEC F11).
      expect(command.scopeNote).toBe("Personal · Quarterly report");
    }
    expect(
      withSelection.find((command) => command.id === "new-message")!.unavailableReason,
    ).toMatch(/compose editor/);
    expect(
      withSelection.find((command) => command.id === "open-settings")!.unavailableReason,
    ).toMatch(/settings screen/);

    // Without a selection, every contextual command says so first.
    const withoutSelection = build({ selected: null }).commands;
    for (const id of [
      "open-message",
      "mark-read",
      "star",
      "archive",
      "move",
      "reply",
      "reply-all",
      "send",
    ]) {
      expect(withoutSelection.find((command) => command.id === id)?.unavailableReason).toBe(
        "Select a message first.",
      );
    }
  });

  it("offers the account and folder chooser as nested choices", () => {
    const { commands, handlers } = build();
    const goFolder = commands.find((command) => command.id === "go-folder")!;
    expect(goFolder.unavailableReason).toBeNull();

    const choices = goFolder.choices?.() ?? [];
    expect(choices.map((choice) => choice.label)).toEqual([
      // One account has folders; mapped roles sort before unfiled ones.
      "Personal, all folders",
      "INBOX",
      "Old",
      "Zebra",
      // The other account has no folder list yet, only its all-folders view.
      "Work, all folders",
    ]);
    expect(choices.map((choice) => choice.group)).toEqual([
      "Personal",
      "Personal",
      "Personal",
      "Personal",
      "Work",
    ]);
    choices[1]!.run();
    expect(handlers.changeScope).toHaveBeenCalledWith({
      kind: "account",
      accountId: "a1",
      folderId: "f-inbox",
    });
    choices[4]!.run();
    expect(handlers.changeScope).toHaveBeenCalledWith({
      kind: "account",
      accountId: "a2",
      folderId: null,
    });
  });

  it("disables the folder chooser until an account exists", () => {
    const { commands } = build({ accounts: [], rows: [], selected: null });
    expect(
      commands.find((command) => command.id === "go-folder")!.unavailableReason,
    ).toBe("No accounts are configured yet.");
  });

  it("marks the current theme choice and applies a new one", () => {
    const { commands, handlers } = build({ theme: "dark" });
    const theme = commands.find((command) => command.id === "theme")!;
    expect(theme.scopeNote).toBe("Current: dark");
    const choices = theme.choices?.() ?? [];
    expect(choices.find((choice) => choice.label === "Dark")?.current).toBe(true);
    expect(choices.filter((choice) => choice.current === true)).toHaveLength(1);
    choices.find((choice) => choice.label === "System")!.run();
    expect(handlers.setTheme).toHaveBeenCalledWith("system");
  });

  it("flips the single-key shortcut preference command", () => {
    const on = build({ singleKeyShortcuts: true });
    on.commands.find((command) => command.id === "toggle-shortcuts")!.run?.();
    expect(on.handlers.setSingleKeyShortcuts).toHaveBeenCalledWith(false);
    expect(
      on.commands.find((command) => command.id === "toggle-shortcuts")!.label,
    ).toBe("Turn single-key shortcuts off");

    const off = build({ singleKeyShortcuts: false });
    expect(
      off.commands.find((command) => command.id === "toggle-shortcuts")!.label,
    ).toBe("Turn single-key shortcuts on");
  });

  it("keeps list navigation honest about an empty list", () => {
    const { commands } = build({ rows: [], selected: null });
    expect(
      commands.find((command) => command.id === "next-message")!.unavailableReason,
    ).toBe("The message list is empty.");
  });
});

describe("shortcutCommandId", () => {
  const selected = row();

  it("maps the SPEC F3 keys", () => {
    expect(shortcutCommandId("j", { selected })).toBe("next-message");
    expect(shortcutCommandId("k", { selected })).toBe("previous-message");
    expect(shortcutCommandId("o", { selected })).toBe("open-message");
    expect(shortcutCommandId("/", { selected })).toBe("search");
    expect(shortcutCommandId("e", { selected })).toBe("archive");
    expect(shortcutCommandId("r", { selected })).toBe("reply");
  });

  it("follows the selected message for the toggling keys", () => {
    expect(shortcutCommandId("u", { selected: row({ unread: true }) })).toBe("mark-unread");
    expect(shortcutCommandId("u", { selected: row({ unread: false }) })).toBe("mark-read");
    expect(shortcutCommandId("s", { selected: row({ flagged: true }) })).toBe("unstar");
    expect(shortcutCommandId("s", { selected: row({ flagged: false }) })).toBe("star");
  });

  it("leaves unbound keys alone", () => {
    expect(shortcutCommandId("x", { selected })).toBeNull();
    expect(shortcutCommandId("J", { selected })).toBeNull();
  });
});

describe("nextSelectedIndex", () => {
  it("starts at the newest row for j and the oldest for k", () => {
    expect(nextSelectedIndex(5, -1, 1)).toBe(0);
    expect(nextSelectedIndex(5, -1, -1)).toBe(4);
  });

  it("steps and clamps at both ends", () => {
    expect(nextSelectedIndex(5, 2, 1)).toBe(3);
    expect(nextSelectedIndex(5, 2, -1)).toBe(1);
    expect(nextSelectedIndex(5, 0, -1)).toBe(0);
    expect(nextSelectedIndex(5, 4, 1)).toBe(4);
  });

  it("returns null for an empty list", () => {
    expect(nextSelectedIndex(0, -1, 1)).toBeNull();
  });
});

describe("shouldRunSingleKey", () => {
  it("runs for plain shell targets", () => {
    const button = document.createElement("button");
    expect(
      shouldRunSingleKey({ target: button, isComposing: false, repeat: false }, { mutation: false }),
    ).toBe(true);
  });

  it("stays inactive inside text entry, editable content, and dialogs", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.append(inner);

    for (const target of [input, textarea, editable, inner]) {
      expect(
        shouldRunSingleKey({ target, isComposing: false, repeat: false }, { mutation: false }),
      ).toBe(false);
    }
  });

  it("ignores composition and key repeats for mutations", () => {
    const button = document.createElement("button");
    expect(
      shouldRunSingleKey({ target: button, isComposing: true, repeat: false }, { mutation: false }),
    ).toBe(false);
    expect(
      shouldRunSingleKey({ target: button, isComposing: false, repeat: true }, { mutation: true }),
    ).toBe(false);
    // Held navigation keys keep moving; only mutations refuse repeats.
    expect(
      shouldRunSingleKey({ target: button, isComposing: false, repeat: true }, { mutation: false }),
    ).toBe(true);
  });
});

describe("prefixFilter", () => {
  const OPEN_MESSAGE = "open-message Open the selected message open read";

  it("keeps loose letter sequences from matching across words", () => {
    // The fuzzy default ranked this item above "Theme…" for "theme".
    expect(prefixFilter(OPEN_MESSAGE, "theme")).toBe(0);
    expect(prefixFilter(OPEN_MESSAGE, "them")).toBe(0);
    expect(prefixFilter("theme Theme… appearance", "theme")).toBe(1);
    expect(prefixFilter("theme Theme… appearance", "THEM")).toBe(1);
  });

  it("matches whole words and multi-word queries", () => {
    expect(prefixFilter(OPEN_MESSAGE, "open")).toBe(1);
    expect(prefixFilter(OPEN_MESSAGE, "message")).toBe(1);
    expect(prefixFilter(OPEN_MESSAGE, "open message")).toBe(1);
    expect(prefixFilter(OPEN_MESSAGE, "open unread")).toBe(0);
  });

  it("keeps every command visible for an empty query", () => {
    expect(prefixFilter(OPEN_MESSAGE, "")).toBe(1);
    expect(prefixFilter(OPEN_MESSAGE, "   ")).toBe(1);
  });
});

describe("platform shortcut labels", () => {
  it("shows native symbols on Apple platforms and Ctrl elsewhere", () => {
    expect(paletteShortcutKeys("apple")).toEqual(["⌘", "K"]);
    expect(paletteShortcutKeys("other")).toEqual(["Ctrl", "K"]);
  });

  it("matches the palette chord per platform and never the print shortcut", () => {
    expect(
      isPaletteShortcut({ metaKey: true, ctrlKey: false, altKey: false, key: "k" }, "apple"),
    ).toBe(true);
    expect(
      isPaletteShortcut({ metaKey: false, ctrlKey: true, altKey: false, key: "k" }, "other"),
    ).toBe(true);
    // The other platform's modifier, an alt combination, and every other
    // key stay untouched, including Cmd+P and Ctrl+P (SPEC F11).
    expect(
      isPaletteShortcut({ metaKey: false, ctrlKey: true, altKey: false, key: "k" }, "apple"),
    ).toBe(false);
    expect(
      isPaletteShortcut({ metaKey: false, ctrlKey: true, altKey: false, key: "p" }, "other"),
    ).toBe(false);
    expect(
      isPaletteShortcut({ metaKey: false, ctrlKey: true, altKey: true, key: "k" }, "other"),
    ).toBe(false);
  });
});

describe("rescueDialogFocus", () => {
  beforeEach(() => {
    // Removing the fixtures also releases focus back to `body`.
    document.body.replaceChildren();
  });

  it("keeps the focus the dialog or its command placed", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const fallback = vi.fn(() => null);
    rescueDialogFocus([fallback]);
    expect(document.activeElement).toBe(input);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("moves focus to the nearest surviving row when the opener is gone", () => {
    const rowButton = document.createElement("button");
    rowButton.setAttribute("data-message-row", "m1");
    rowButton.setAttribute("aria-current", "true");
    document.body.append(rowButton);
    expect(document.activeElement).toBe(document.body);

    rescueDialogFocus([
      () => document.querySelector<HTMLElement>("[data-message-row][aria-current='true']"),
    ]);
    expect(document.activeElement).toBe(rowButton);
  });

  it("falls back to the list heading when no row survives", () => {
    const heading = document.createElement("h2");
    heading.setAttribute("id", "message-list-heading");
    heading.tabIndex = -1;
    document.body.append(heading);
    rescueDialogFocus([
      () => document.querySelector<HTMLElement>("[data-message-row][aria-current='true']"),
      () => document.querySelector<HTMLElement>("#message-list-heading"),
    ]);
    expect(document.activeElement).toBe(heading);
  });
});
