import { Command as CommandIcon, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountSummary, MailActionKindWire, SearchResultItem } from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { ThemeToggle } from "@/components/theme-toggle";
import { useDebouncedValue, useMediaQuery } from "@/lib/hooks";
import { shouldRunSingleKey } from "@/lib/keyboard";
import { rescueDialogFocus } from "@/lib/focus";
import {
  isPaletteShortcut,
  paletteShortcutKeys,
  shortcutPlatform,
} from "@/lib/platform";
import { cn } from "@/lib/utils";
import { setSingleKeyShortcuts, useSingleKeyShortcuts } from "@/shortcuts";
import { useTheme } from "@/theme";
import { useAppSettings } from "@/settings/settings-context";
import { useFolderIndex, useMessageList, type MessageListState } from "@/mail/data";
import {
  buildMailCommands,
  nextSelectedIndex,
  shortcutCommandId,
  type MailCommand,
} from "@/mail/commands";
import { scopeKey, scopeTitle, type MailScope } from "@/mail/view";
import { runMailAction, type MailActionOutcome } from "@/mail/actions";
import { ComposeScreen, type ComposeIntent } from "./compose-screen";
import { CommandPalette } from "./command-palette";
import { MessageListPane } from "./message-list";
import { NavPane } from "./nav-pane";
import { ReaderPane } from "./reader-pane";
import { SyncStatusChip } from "./sync-status";

/*
 * The application shell (SPEC F3 and F12): three panes at wide widths, one
 * pane at a time below them. The panes stay mounted on small screens, so
 * back navigation restores the list's scroll position and selection. The
 * navigation collapses first, behind the menu button in the header.
 *
 * The shell also owns the keyboard controls (SPEC F11): one keydown
 * listener dispatches the palette chord and the single-key shortcuts
 * through the shared command registry, so one key event can never submit
 * two actions.
 */

/** Which pane is visible below the three-pane breakpoint. */
type Pane = "nav" | "list" | "reader";

const PANE_ORDER: Record<Pane, number> = { nav: 0, list: 1, reader: 2 };

/** The width at which navigation, list, and reader show side by side. */
const THREE_PANE_QUERY = "(min-width: 1024px)";

/** How the interface names each action in feedback (SPEC F4). */
const ACTION_LABELS: Record<MailActionKindWire, string> = {
  mark_read: "Marked as read",
  mark_unread: "Marked as unread",
  star: "Starred",
  unstar: "Star removed",
  archive: "Archived",
  move: "Moved",
};

/** The flag a flag kind patches locally once every target confirms. */
function confirmedFlagPatch(
  kind: MailActionKindWire,
): { unread?: boolean; flagged?: boolean } | null {
  switch (kind) {
    case "mark_read":
      return { unread: false };
    case "mark_unread":
      return { unread: true };
    case "star":
      return { flagged: true };
    case "unstar":
      return { flagged: false };
    default:
      return null;
  }
}

export function AppShell({
  accounts,
  recoveryGeneration,
  onSessionLost,
  onAccountsChanged,
}: {
  accounts: AccountSummary[];
  /** The generation settings and account mutations must carry (SPEC section 7). */
  recoveryGeneration: string | null;
  onSessionLost: () => void;
  /** Refetches the account list after a settings mutation changes it. */
  onAccountsChanged: () => void;
}) {
  const [scope, setScope] = useState<MailScope>({ kind: "unified-inbox" });
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const folders = useFolderIndex(accounts);
  const folderIndexError = folders.phase === "error" ? folders.error : null;
  const list = useMessageList(scope, debouncedQuery, folders.data, folderIndexError);
  // While the unified inbox waits on a failed folder read, the list's retry
  // must retry that read; reloading the list alone would never leave the
  // failure, because the list cannot query without the folder roles.
  const retryList =
    scope.kind === "unified-inbox" && folderIndexError !== null ? folders.reload : list.reload;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("list");
  const threePane = useMediaQuery(THREE_PANE_QUERY);
  const { theme, setTheme } = useTheme();
  const singleKeyShortcuts = useSingleKeyShortcuts();
  const appSettings = useAppSettings();
  const platform = useMemo(shortcutPlatform, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeIntent, setComposeIntent] = useState<ComposeIntent | null>(null);

  // Confirmed actions paint locally until the next server read replaces
  // them: no optimistic flip happens before the receipts confirm (SPEC F2).
  const [flagPatches, setFlagPatches] = useState<Map<string, { unread?: boolean; flagged?: boolean }>>(
    new Map(),
  );
  const [movedAside, setMovedAside] = useState<Set<string>>(new Set());
  const [actionNote, setActionNote] = useState<string | null>(null);
  const noteTimer = useRef<number | null>(null);
  const markedOnOpen = useRef<Set<string>>(new Set());

  const rows = useMemo(() => {
    const raw = list.state.phase === "ready" ? list.state.rows : [];
    if (flagPatches.size === 0 && movedAside.size === 0) {
      return raw;
    }
    return raw.flatMap((row) =>
      movedAside.has(row.messageId)
        ? []
        : [{ ...row, ...(flagPatches.get(row.messageId) ?? {}) }],
    );
  }, [list.state, flagPatches, movedAside]);
  // The pane draws the overlaid rows too, so confirmed actions paint in the
  // list without a scroll-resetting reload (SPEC F2).
  const listState = useMemo<MessageListState>(
    () => (list.state.phase === "ready" ? { ...list.state, rows } : list.state),
    [list.state, rows],
  );
  const selected = rows.find((row) => row.messageId === selectedId) ?? null;
  const title = scopeTitle(scope, accounts, folders.data);

  const commandsButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const paletteOpenerRef = useRef<HTMLElement | null>(null);
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;

  // The single keydown listener reads the latest state through refs, so it
  // is bound exactly once (SPEC F11).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const singleKeyRef = useRef(singleKeyShortcuts);
  singleKeyRef.current = singleKeyShortcuts;

  /** Shows one action result for a while, replacing any earlier note. */
  const showActionNote = useCallback((text: string | null) => {
    if (noteTimer.current !== null) {
      window.clearTimeout(noteTimer.current);
      noteTimer.current = null;
    }
    setActionNote(text);
    if (text !== null) {
      noteTimer.current = window.setTimeout(() => setActionNote(null), 8000);
    }
  }, []);

  useEffect(
    () => () => {
      if (noteTimer.current !== null) {
        window.clearTimeout(noteTimer.current);
      }
    },
    [],
  );

  /** Applies a fully confirmed action to the local view (SPEC F4). */
  const applyConfirmed = useCallback((kind: MailActionKindWire, row: SearchResultItem) => {
    const patch = confirmedFlagPatch(kind);
    if (patch !== null) {
      // Merge, because one row can confirm a read and a star before the
      // next server read replaces the overlay.
      setFlagPatches(
        (previous) => new Map(previous).set(row.messageId, { ...previous.get(row.messageId), ...patch }),
      );
      return;
    }
    setMovedAside((previous) => new Set(previous).add(row.messageId));
  }, []);

  /** Reports one outcome and paints what the receipts confirmed. */
  const reportOutcome = useCallback(
    (outcome: MailActionOutcome, row: SearchResultItem, options: { silent: boolean }) => {
      if (outcome.state === "submitted") {
        const total = outcome.confirmed + outcome.pending + outcome.needsAttention;
        if (outcome.confirmed === total) {
          applyConfirmed(outcome.kind, row);
          if (!options.silent) {
            showActionNote(`${ACTION_LABELS[outcome.kind]}.`);
          }
          return;
        }
        if (!options.silent) {
          showActionNote(
            outcome.needsAttention > 0
              ? `${ACTION_LABELS[outcome.kind]}: ${outcome.needsAttention} target${
                  outcome.needsAttention === 1 ? "" : "s"
                } need attention. The server state changed; refresh and reapply.`
              : `${ACTION_LABELS[outcome.kind]}: ${outcome.pending} target${
                  outcome.pending === 1 ? "" : "s"
                } still executing on the server.`,
          );
        }
        return;
      }
      if (outcome.state === "queued-offline") {
        if (!options.silent) {
          showActionNote("Offline. The action is queued on this device and replays on return.");
        }
        return;
      }
      showActionNote(outcome.message);
    },
    [applyConfirmed, showActionNote],
  );

  /** Submits one management action over one row (SPEC F4). */
  const submitMailAction = useCallback(
    (kind: MailActionKindWire, row: SearchResultItem, destinationFolderId?: string) => {
      void runMailAction({ kind, row, destinationFolderId, recoveryGeneration }).then((outcome) =>
        reportOutcome(outcome, row, { silent: false }),
      );
    },
    [recoveryGeneration, reportOutcome],
  );

  /** Reading a message marks it seen, once per session per message. */
  const markReadOnOpen = useCallback(
    (row: SearchResultItem) => {
      if (!row.unread || row.occurrences.length === 0 || markedOnOpen.current.has(row.messageId)) {
        return;
      }
      markedOnOpen.current.add(row.messageId);
      void runMailAction({ kind: "mark_read", row, recoveryGeneration }).then((outcome) =>
        reportOutcome(outcome, row, { silent: outcome.state !== "rejected" }),
      );
    },
    [recoveryGeneration, reportOutcome],
  );

  const handleScopeChange = useCallback((next: MailScope) => {
    setScope(next);
    setSelectedId(null);
    setPane("list");
  }, []);

  const handleSelect = useCallback(
    (item: SearchResultItem) => {
      setSelectedId(item.messageId);
      setPane("reader");
      markReadOnOpen(item);
    },
    [markReadOnOpen],
  );

  const openPalette = useCallback(() => {
    // Remember what held focus before the dialog traps it, so closing can
    // return there (SPEC F11).
    const active = document.activeElement;
    paletteOpenerRef.current = active instanceof HTMLElement ? active : null;
    setPaletteOpen(true);
  }, []);

  const focusSearch = useCallback(() => {
    // Placed one frame later, after the palette starts closing, so the
    // dialog's focus trap does not reclaim it. The restore step then keeps
    // it, because it only acts when focus landed nowhere.
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (input !== null) {
        input.focus();
        input.select();
      }
    });
  }, []);

  const moveSelection = useCallback((step: 1 | -1) => {
    const current = rowsRef.current;
    const index = current.findIndex((row) => row.messageId === selectedRef.current?.messageId);
    const next = nextSelectedIndex(current.length, index, step);
    const row = next === null ? undefined : current[next];
    if (row !== undefined) {
      setSelectedId(row.messageId);
    }
  }, []);

  const openSelection = useCallback(() => {
    const row = rowsRef.current.find((entry) => entry.messageId === selectedRef.current?.messageId);
    if (row !== undefined) {
      handleSelect(row);
    }
  }, [handleSelect]);

  // Palette choices persist through the settings record, so they follow the
  // account to every device (SPEC F10). The local store paints at once.
  const persistTheme = useCallback(
    (choice: "system" | "light" | "dark") => {
      setTheme(choice);
      appSettings.update({ theme: choice });
    },
    [setTheme, appSettings],
  );
  const persistSingleKeyShortcuts = useCallback(
    (on: boolean) => {
      setSingleKeyShortcuts(on);
      appSettings.update({ singleKeyShortcuts: on });
    },
    [appSettings],
  );
  const openSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  // Compose opens on one intent; a fresh intent object reopens the surface
  // even when a previous one is still set (SPEC F6).
  const openCompose = useCallback((intent: ComposeIntent) => {
    setComposeIntent(intent);
    setComposeOpen(true);
  }, []);
  const composeNew = useCallback(
    (accountId: string) => {
      openCompose({ kind: "new", accountId });
    },
    [openCompose],
  );
  const composeReply = useCallback(
    (mode: "reply" | "reply_all") => {
      const row = selectedRef.current;
      if (row === null) {
        return;
      }
      openCompose({ kind: "reply", messageId: row.messageId, mode });
    },
    [openCompose],
  );
  const openDrafts = useCallback(() => {
    openCompose({ kind: "list" });
  }, [openCompose]);

  // The command registry drives every management action (SPEC F11). Archive
  // resolves the account's mapped destination before it queues, because the
  // request must freeze one (SPEC F4).
  const mailAction = useCallback(
    (kind: MailActionKindWire) => {
      const row = selectedRef.current;
      if (row === null) {
        return;
      }
      if (kind === "archive") {
        const destination = (folders.data?.get(row.accountId) ?? []).find(
          (folder) => folder.role === "archive",
        );
        if (destination === undefined) {
          return;
        }
        submitMailAction("archive", row, destination.id);
        return;
      }
      submitMailAction(kind, row);
    },
    [folders.data, submitMailAction],
  );

  const moveSelectionTo = useCallback(
    (destinationFolderId: string) => {
      const row = selectedRef.current;
      if (row === null) {
        return;
      }
      submitMailAction("move", row, destinationFolderId);
    },
    [submitMailAction],
  );

  const commands = useMemo<MailCommand[]>(
    () =>
      buildMailCommands({
        accounts,
        folders: folders.data,
        scope,
        rows,
        selected,
        singleKeyShortcuts,
        theme,
        handlers: {
          changeScope: handleScopeChange,
          focusSearch,
          moveSelection,
          openSelection,
          mailAction,
          moveSelectionTo,
          composeNew,
          composeReply,
          openDrafts,
          setTheme: persistTheme,
          setSingleKeyShortcuts: persistSingleKeyShortcuts,
          openSettings,
        },
      }),
    [
      accounts,
      folders.data,
      scope,
      rows,
      selected,
      singleKeyShortcuts,
      theme,
      handleScopeChange,
      focusSearch,
      moveSelection,
      openSelection,
      mailAction,
      moveSelectionTo,
      composeNew,
      composeReply,
      openDrafts,
      persistTheme,
      persistSingleKeyShortcuts,
      openSettings,
    ],
  );
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const dispatchKeydown = useRef<(event: KeyboardEvent) => void>(() => {});
  dispatchKeydown.current = (event: KeyboardEvent) => {
    // The palette chord works everywhere, including while an input or the
    // editor holds focus. `Cmd+P` and `Ctrl+P` stay reserved for printing.
    if (isPaletteShortcut(event, platform)) {
      event.preventDefault();
      if (paletteOpenRef.current) {
        setPaletteOpen(false);
      } else {
        openPalette();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (!singleKeyRef.current) {
      return;
    }
    const commandId = shortcutCommandId(event.key, { selected: selectedRef.current });
    if (commandId === null) {
      return;
    }
    const command = commandsRef.current.find((entry) => entry.id === commandId);
    if (
      command === undefined ||
      command.choices !== undefined ||
      command.unavailableReason !== null
    ) {
      return;
    }
    if (!shouldRunSingleKey(event, { mutation: command.shortcut?.mutation ?? false })) {
      return;
    }
    event.preventDefault();
    command.run?.();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => dispatchKeydown.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handlePaletteOpenChange = useCallback((open: boolean) => {
    setPaletteOpen(open);
  }, []);

  /**
   * Runs once the palette dialog has fully unmounted: keep any focus a
   * command placed, else return to the opener, else the nearest surviving
   * row, the list heading, or the Commands button (SPEC F11).
   */
  const restorePaletteFocus = useCallback(() => {
    rescueDialogFocus([
      () => {
        const opener = paletteOpenerRef.current;
        return opener !== null && opener !== document.body && opener.isConnected
          ? opener
          : null;
      },
      () =>
        document.querySelector<HTMLElement>(
          "#message-list [data-message-row][aria-current='true']",
        ),
      () => document.querySelector<HTMLElement>("#message-list-heading"),
      () => commandsButtonRef.current,
    ]);
  }, []);

  /** Off-screen panes slide rather than unmount, keeping their scroll. */
  const paneWrapperClass = (name: Pane, widthClasses: string) =>
    cn(
      "absolute inset-0 flex bg-background",
      "transition-transform duration-panel ease-out-quiet",
      "lg:static lg:translate-x-0 lg:transition-none",
      name === pane
        ? "translate-x-0"
        : PANE_ORDER[name] < PANE_ORDER[pane]
          ? "-translate-x-full"
          : "translate-x-full",
      widthClasses,
    );

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground [padding-bottom:env(safe-area-inset-bottom)]">
      <header className="flex h-control-lg max-md:h-11 shrink-0 items-center gap-2 border-b bg-surface px-2 lg:px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          className="max-md:size-11 lg:hidden"
          onClick={() => setPane("nav")}
          aria-label="Open navigation"
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>
        <h1 className="font-semibold">Mail</h1>
        <span className="truncate text-muted-foreground">{title}</span>
        <div className="ms-auto flex items-center gap-1">
          <SyncStatusChip onSessionLost={onSessionLost} />
          <Button
            ref={commandsButtonRef}
            variant="ghost"
            size="sm"
            className="gap-1.5 max-md:size-11 max-md:px-0"
            onClick={openPalette}
            aria-label={`Commands (${paletteShortcutKeys(platform).join("+")})`}
            aria-keyshortcuts={platform === "apple" ? "Meta+K" : "Control+K"}
          >
            <CommandIcon aria-hidden="true" className="size-4" />
            <span className="hidden md:inline">Commands</span>
            <span className="hidden md:inline-flex items-center gap-0.5" aria-hidden="true">
              {paletteShortcutKeys(platform).map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
          </Button>
          <ThemeToggle onChoose={(choice) => appSettings.update({ theme: choice })} />
        </div>
      </header>

      <main className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          className={paneWrapperClass("nav", "lg:w-60 lg:shrink-0 lg:border-e")}
          inert={!threePane && pane !== "nav"}
        >
          <NavPane
            className="min-h-0 flex-1"
            accounts={accounts}
            folders={folders.data}
            foldersFailed={folders.phase === "error"}
            onRetryFolders={folders.reload}
            scope={scope}
            onScopeChange={handleScopeChange}
          />
        </div>

        <div
          className={paneWrapperClass("list", "lg:w-[26rem] lg:shrink-0 lg:border-e xl:w-[28rem]")}
          inert={!threePane && pane !== "list"}
        >
          {actionNote !== null && (
            <p
              role="status"
              className="shrink-0 border-b bg-surface px-3 py-1.5 text-muted-foreground"
            >
              {actionNote}
            </p>
          )}
          <MessageListPane
            className="min-h-0 flex-1"
            title={title}
            scopeResetKey={scopeKey(scope)}
            state={listState}
            onLoadMore={list.loadMore}
            onReload={retryList}
            query={query}
            onQueryChange={setQuery}
            selectedId={selectedId}
            onSelect={handleSelect}
            showAccountLabels={scope.kind !== "account"}
            onSessionLost={onSessionLost}
            searchInputRef={searchInputRef}
          />
        </div>

        <div
          className={paneWrapperClass("reader", "lg:min-w-0 lg:flex-1")}
          inert={!threePane && pane !== "reader"}
        >
          <ReaderPane
            className="min-h-0 flex-1"
            message={selected}
            onBack={() => setPane("list")}
            onSessionLost={onSessionLost}
          />
        </div>
      </main>

      <p role="status" aria-live="polite" className="sr-only">
        {selected === null ? "" : `Selected: ${selected.subject ?? "(no subject)"}`}
      </p>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={handlePaletteOpenChange}
        commands={commands}
        onRestoreFocus={restorePaletteFocus}
      />

      <SettingsScreen
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        accounts={accounts}
        folders={folders.data}
        recoveryGeneration={recoveryGeneration}
        onAccountsChanged={onAccountsChanged}
        onFoldersChanged={folders.reload}
        onSessionLost={onSessionLost}
      />

      <ComposeScreen
        open={composeOpen}
        onOpenChange={setComposeOpen}
        accounts={accounts}
        recoveryGeneration={recoveryGeneration}
        intent={composeIntent}
        onSessionLost={onSessionLost}
      />
    </div>
  );
}
