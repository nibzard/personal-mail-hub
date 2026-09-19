import { Command as CommandIcon, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountSummary, SearchResultItem } from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
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
import { useFolderIndex, useMessageList } from "@/mail/data";
import {
  buildMailCommands,
  nextSelectedIndex,
  shortcutCommandId,
  type MailCommand,
} from "@/mail/commands";
import { scopeKey, scopeTitle, type MailScope } from "@/mail/view";
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

export function AppShell({
  accounts,
  onSessionLost,
}: {
  accounts: AccountSummary[];
  onSessionLost: () => void;
}) {
  const [scope, setScope] = useState<MailScope>({ kind: "unified-inbox" });
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const folders = useFolderIndex(accounts);
  const list = useMessageList(scope, debouncedQuery, folders.data);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("list");
  const threePane = useMediaQuery(THREE_PANE_QUERY);
  const { theme, setTheme } = useTheme();
  const singleKeyShortcuts = useSingleKeyShortcuts();
  const platform = useMemo(shortcutPlatform, []);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const rows = list.state.phase === "ready" ? list.state.rows : [];
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

  const handleScopeChange = useCallback((next: MailScope) => {
    setScope(next);
    setSelectedId(null);
    setPane("list");
  }, []);

  const handleSelect = useCallback((item: SearchResultItem) => {
    setSelectedId(item.messageId);
    setPane("reader");
  }, []);

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
          setTheme,
          setSingleKeyShortcuts,
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
      setTheme,
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
          className="lg:hidden"
          onClick={() => setPane("nav")}
          aria-label="Open navigation"
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>
        <h1 className="font-semibold">Mail</h1>
        <span className="truncate text-muted-foreground">{title}</span>
        <div className="ms-auto flex items-center gap-1">
          <SyncStatusChip />
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
          <ThemeToggle />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
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
          <MessageListPane
            className="min-h-0 flex-1"
            title={title}
            scopeResetKey={scopeKey(scope)}
            state={list.state}
            onLoadMore={list.loadMore}
            onReload={list.reload}
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
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {selected === null ? "" : `Selected: ${selected.subject ?? "(no subject)"}`}
      </p>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={handlePaletteOpenChange}
        commands={commands}
        onRestoreFocus={restorePaletteFocus}
      />
    </div>
  );
}
