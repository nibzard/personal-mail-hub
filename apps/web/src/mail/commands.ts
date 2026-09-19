import type {
  AccountSummary,
  FolderSummary,
  MailActionKindWire,
  SearchResultItem,
} from "@mail-hub/contracts";
import type { Theme } from "@/theme";
import { orderFolders, type MailScope } from "./view";

/*
 * The command registry (SPEC F11): one source for the palette, the shortcut
 * table, and future menus and buttons. Each command names its group, its
 * single-key hint, the scope it would act on, why it cannot run, and either a
 * handler or a nested chooser. Filtering stays local; no command depends on
 * the network or classification.
 */

export type CommandGroupId = "navigation" | "message-actions" | "compose" | "settings";

/** Palette groups, in display order (SPEC F11). */
export const COMMAND_GROUPS: ReadonlyArray<{ id: CommandGroupId; title: string }> = [
  { id: "navigation", title: "Navigation" },
  { id: "message-actions", title: "Message actions" },
  { id: "compose", title: "Compose" },
  { id: "settings", title: "Settings" },
];

/** One option of a nested chooser a command opens. */
export interface CommandChoice {
  id: string;
  label: string;
  /** Grouping heading inside the chooser, for example the account label. */
  group?: string;
  /** True when this choice is the state currently in effect. */
  current?: boolean;
  /** Extra words local filtering matches beyond the label. */
  keywords?: string[];
  run: () => void;
}

/** One command in the registry. */
export interface MailCommand {
  id: string;
  group: CommandGroupId;
  label: string;
  /** Extra words local filtering matches beyond the label. */
  keywords?: string[];
  /** The single-key hint, identical on every platform. */
  shortcut?: { key: string; mutation: boolean };
  /** Why the command cannot run now; `null` when it can. */
  unavailableReason: string | null;
  /** The frozen target the command would act on (SPEC F11). */
  scopeNote: string | null;
  /** Activating opens a nested chooser instead of running. */
  choices?: () => CommandChoice[];
  run?: () => void;
}

/** What the registry needs from the shell to build and run commands. */
export interface MailCommandHandlers {
  changeScope(scope: MailScope): void;
  focusSearch(): void;
  moveSelection(step: 1 | -1): void;
  openSelection(): void;
  /** Submits one management action over the selected message (SPEC F4). */
  mailAction(kind: MailActionKindWire): void;
  /** Submits one move of the selected message to one folder (SPEC F4). */
  moveSelectionTo(destinationFolderId: string): void;
  setTheme(theme: Theme): void;
  setSingleKeyShortcuts(on: boolean): void;
  openSettings(): void;
}

export interface MailCommandsInput {
  accounts: AccountSummary[];
  folders: Map<string, FolderSummary[]> | null;
  scope: MailScope;
  rows: SearchResultItem[];
  selected: SearchResultItem | null;
  singleKeyShortcuts: boolean;
  theme: Theme;
  handlers: MailCommandHandlers;
}

/*
 * Reasons one listed command cannot run. The commands stay listed and
 * discoverable, disabled with their reason (SPEC F11).
 */
const NO_SELECTION = "Select a message first.";
const EMPTY_LIST = "The message list is empty.";
const NO_ACCOUNTS = "No accounts are configured yet.";
const NO_SERVER_COPY =
  "This message has no server copy, so no server action can run on it.";
const NO_ARCHIVE_FOLDER =
  "This account has no archive folder mapped. Choose one in settings first.";
const NO_MOVE_DESTINATION = "This account has no other folder to move to.";
const COMPOSING = "The compose editor is not part of this build yet.";

/** Builds the full command set for the current shell state. */
export function buildMailCommands(input: MailCommandsInput): MailCommand[] {
  const { handlers, selected } = input;
  const listEmpty = input.rows.length === 0;
  const selectionNote =
    selected === null
      ? null
      : `${selected.accountLabel} · ${selected.subject ?? "(no subject)"}`;
  // A retained record has no occurrence to act on, so its server actions
  // stay listed with their reason instead of failing on submit (SPEC F5).
  const noMail =
    selected === null ? NO_SELECTION : selected.occurrences.length === 0 ? NO_SERVER_COPY : null;
  const actionScopeNote =
    selected === null ? null : `${selectionNote} · ${occurrenceScopeNote(selected, input.folders)}`;
  const archiveFolder =
    selected === null
      ? null
      : (input.folders?.get(selected.accountId) ?? []).find((folder) => folder.role === "archive") ??
        null;
  const moveTargets = selected === null ? [] : moveChoices(input);
  const noCompose = selected === null ? NO_SELECTION : COMPOSING;

  return [
    // Navigation.
    {
      id: "go-inbox",
      group: "navigation",
      label: "Go to Inbox",
      keywords: ["unified", "inbox"],
      unavailableReason: null,
      scopeNote: null,
      run: () => handlers.changeScope({ kind: "unified-inbox" }),
    },
    {
      id: "go-all-mail",
      group: "navigation",
      label: "Go to All Mail",
      keywords: ["everything", "all"],
      unavailableReason: null,
      scopeNote: null,
      run: () => handlers.changeScope({ kind: "all-mail" }),
    },
    {
      id: "go-folder",
      group: "navigation",
      label: "Go to account or folder…",
      keywords: ["switch", "folder", "account"],
      unavailableReason: input.accounts.length === 0 ? NO_ACCOUNTS : null,
      scopeNote: null,
      choices: () => folderChoices(input),
    },
    {
      id: "search",
      group: "navigation",
      label: "Search mail",
      keywords: ["find", "query"],
      shortcut: { key: "/", mutation: false },
      unavailableReason: null,
      scopeNote: null,
      run: () => handlers.focusSearch(),
    },
    {
      id: "next-message",
      group: "navigation",
      label: "Next message",
      keywords: ["down", "later"],
      shortcut: { key: "j", mutation: false },
      unavailableReason: listEmpty ? EMPTY_LIST : null,
      scopeNote: null,
      run: () => handlers.moveSelection(1),
    },
    {
      id: "previous-message",
      group: "navigation",
      label: "Previous message",
      keywords: ["up", "earlier"],
      shortcut: { key: "k", mutation: false },
      unavailableReason: listEmpty ? EMPTY_LIST : null,
      scopeNote: null,
      run: () => handlers.moveSelection(-1),
    },
    {
      id: "open-message",
      group: "navigation",
      label: "Open the selected message",
      keywords: ["read", "enter"],
      shortcut: { key: "o", mutation: false },
      unavailableReason: selected === null ? NO_SELECTION : null,
      scopeNote: selectionNote,
      run: () => handlers.openSelection(),
    },

    // Message actions (SPEC F4). Each one submits through the action service
    // with the occurrences the selected row froze, so the scope it names is
    // the scope the server writes.
    {
      id: selected?.unread === true ? "mark-unread" : "mark-read",
      group: "message-actions",
      label: selected?.unread === true ? "Mark as unread" : "Mark as read",
      keywords: ["unread", "read", "seen"],
      shortcut: { key: "u", mutation: true },
      unavailableReason: noMail,
      scopeNote: actionScopeNote,
      run: () => handlers.mailAction(selected?.unread === true ? "mark_unread" : "mark_read"),
    },
    {
      id: selected?.flagged === true ? "unstar" : "star",
      group: "message-actions",
      label: selected?.flagged === true ? "Remove star" : "Star",
      keywords: ["star", "flag", "pin"],
      shortcut: { key: "s", mutation: true },
      unavailableReason: noMail,
      scopeNote: actionScopeNote,
      run: () => handlers.mailAction(selected?.flagged === true ? "unstar" : "star"),
    },
    {
      id: "archive",
      group: "message-actions",
      label: "Archive",
      keywords: ["done", "file away"],
      shortcut: { key: "e", mutation: true },
      // Archive needs the account's mapped destination before it queues
      // (SPEC F4); the Work fixture account maps none, by design.
      unavailableReason: noMail ?? (archiveFolder === null ? NO_ARCHIVE_FOLDER : null),
      scopeNote: actionScopeNote,
      run: () => handlers.mailAction("archive"),
    },
    {
      id: "move",
      group: "message-actions",
      label: "Move to folder…",
      keywords: ["move", "destination"],
      unavailableReason: noMail ?? (moveTargets.length === 0 ? NO_MOVE_DESTINATION : null),
      scopeNote: actionScopeNote,
      choices: () => moveTargets,
    },

    // Compose.
    {
      id: "new-message",
      group: "compose",
      label: "New message",
      keywords: ["compose", "write", "draft"],
      unavailableReason: COMPOSING,
      scopeNote: null,
      run: undefined,
    },
    {
      id: "reply",
      group: "compose",
      label: "Reply",
      keywords: ["answer"],
      shortcut: { key: "r", mutation: false },
      unavailableReason: noCompose,
      scopeNote: selectionNote,
      run: undefined,
    },
    {
      id: "reply-all",
      group: "compose",
      label: "Reply all",
      keywords: ["answer", "everyone"],
      unavailableReason: noCompose,
      scopeNote: selectionNote,
      run: undefined,
    },
    {
      id: "send",
      group: "compose",
      label: "Send",
      keywords: ["submit", "outbound"],
      // Send only ever opens the addressed draft for review (SPEC F11); with
      // no editor to open, it stays disabled with that reason.
      unavailableReason:
        selected === null ? NO_SELECTION : "Sending opens the addressed draft, and the compose editor is not part of this build yet.",
      scopeNote: selectionNote,
      run: undefined,
    },

    // Settings.
    {
      id: "theme",
      group: "settings",
      label: "Theme…",
      keywords: ["appearance", "light", "dark", "system"],
      unavailableReason: null,
      scopeNote: `Current: ${input.theme}`,
      choices: () => [
        {
          id: "theme-system",
          label: "System",
          current: input.theme === "system",
          run: () => handlers.setTheme("system"),
        },
        {
          id: "theme-light",
          label: "Light",
          current: input.theme === "light",
          run: () => handlers.setTheme("light"),
        },
        {
          id: "theme-dark",
          label: "Dark",
          current: input.theme === "dark",
          run: () => handlers.setTheme("dark"),
        },
      ],
    },
    {
      id: "toggle-shortcuts",
      group: "settings",
      label: input.singleKeyShortcuts
        ? "Turn single-key shortcuts off"
        : "Turn single-key shortcuts on",
      keywords: ["keyboard", "j", "k", "disable", "enable"],
      unavailableReason: null,
      scopeNote: input.singleKeyShortcuts
        ? "Single-key shortcuts are on"
        : "Single-key shortcuts are off",
      run: () => handlers.setSingleKeyShortcuts(!input.singleKeyShortcuts),
    },
    {
      id: "open-settings",
      group: "settings",
      label: "Open settings",
      keywords: ["preferences", "configuration", "density", "classification"],
      unavailableReason: null,
      scopeNote: null,
      run: () => handlers.openSettings(),
    },
  ];
}

/** The destinations of the account and folder chooser, grouped per account. */
function folderChoices(input: MailCommandsInput): CommandChoice[] {
  const { handlers } = input;
  const choices: CommandChoice[] = [];
  for (const account of input.accounts) {
    choices.push({
      id: `account:${account.id}`,
      label: `${account.label}, all folders`,
      group: account.label,
      run: () =>
        handlers.changeScope({ kind: "account", accountId: account.id, folderId: null }),
    });
    const folders = input.folders?.get(account.id);
    if (folders === undefined) {
      continue;
    }
    for (const folder of orderFolders(folders)) {
      choices.push({
        id: `folder:${folder.id}`,
        label: folder.name,
        group: account.label,
        keywords: folder.role === null ? [] : [folder.role],
        run: () =>
          handlers.changeScope({
            kind: "account",
            accountId: account.id,
            folderId: folder.id,
          }),
      });
    }
  }
  return choices;
}

/**
 * The frozen scope one message action names (SPEC F11): the occurrences the
 * selected row shows and the folders that hold them, so a bulk mutation is
 * confirmed before it runs.
 */
function occurrenceScopeNote(
  selected: SearchResultItem,
  folders: Map<string, FolderSummary[]> | null,
): string {
  const count = selected.occurrences.length;
  const noun = count === 1 ? "occurrence" : "occurrences";
  const namesById = new Map(
    (folders?.get(selected.accountId) ?? []).map((folder) => [folder.id, folder.name]),
  );
  const folderNames = [
    ...new Set(
      selected.occurrences
        .map((occurrence) => namesById.get(occurrence.folderId))
        .filter((name): name is string => name !== undefined),
    ),
  ];
  return folderNames.length === 0 ? `${count} ${noun}` : `${count} ${noun} in ${folderNames.join(", ")}`;
}

/**
 * The destinations the move chooser offers: every folder of the selected
 * message's account except one that already holds one of its occurrences,
 * because a move to its own source cannot freeze a new placement (SPEC F4).
 */
function moveChoices(input: MailCommandsInput): CommandChoice[] {
  const { handlers, selected } = input;
  if (selected === null) {
    return [];
  }
  const account = input.accounts.find((entry) => entry.id === selected.accountId);
  const sourceFolderIds = new Set(selected.occurrences.map((occurrence) => occurrence.folderId));
  return orderFolders(input.folders?.get(selected.accountId) ?? [])
    .filter((folder) => !sourceFolderIds.has(folder.id))
    .map((folder) => ({
      id: `move:${folder.id}`,
      label: folder.name,
      group: account?.label,
      keywords: folder.role === null ? [] : [folder.role],
      run: () => handlers.moveSelectionTo(folder.id),
    }));
}

/**
 * The command one single-key shortcut dispatches (SPEC F3), or `null` when
 * the key is not bound. `u`, `s`, and `r` follow the selected message's
 * current state, so one key never fires two different actions.
 */
export function shortcutCommandId(
  key: string,
  state: { selected: SearchResultItem | null },
): string | null {
  switch (key) {
    case "j":
      return "next-message";
    case "k":
      return "previous-message";
    case "o":
      return "open-message";
    case "/":
      return "search";
    case "e":
      return "archive";
    case "s":
      return state.selected?.flagged === true ? "unstar" : "star";
    case "u":
      return state.selected?.unread === true ? "mark-unread" : "mark-read";
    case "r":
      return "reply";
    default:
      return null;
  }
}

/**
 * The row index a `j` or `k` step lands on, or `null` when the list is
 * empty. An absent selection starts at the newest row for `j` and the oldest
 * for `k`.
 */
export function nextSelectedIndex(
  rowCount: number,
  currentIndex: number,
  step: 1 | -1,
): number | null {
  if (rowCount === 0) {
    return null;
  }
  if (currentIndex < 0) {
    return step === 1 ? 0 : rowCount - 1;
  }
  return Math.min(rowCount - 1, Math.max(0, currentIndex + step));
}
