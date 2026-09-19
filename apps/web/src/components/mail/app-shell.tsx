import { PanelLeft } from "lucide-react";
import { useState } from "react";
import type { AccountSummary, SearchResultItem } from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { useDebouncedValue, useMediaQuery } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useFolderIndex, useMessageList } from "@/mail/data";
import { scopeKey, scopeTitle, type MailScope } from "@/mail/view";
import { MessageListPane } from "./message-list";
import { NavPane } from "./nav-pane";
import { ReaderPane } from "./reader-pane";

/*
 * The application shell (SPEC F3 and F12): three panes at wide widths, one
 * pane at a time below them. The panes stay mounted on small screens, so
 * back navigation restores the list's scroll position and selection. The
 * navigation collapses first, behind the menu button in the header.
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

  const rows = list.state.phase === "ready" ? list.state.rows : [];
  const selected = rows.find((row) => row.messageId === selectedId) ?? null;
  const title = scopeTitle(scope, accounts, folders.data);

  const handleScopeChange = (next: MailScope) => {
    setScope(next);
    setSelectedId(null);
    setPane("list");
  };

  const handleSelect = (item: SearchResultItem) => {
    setSelectedId(item.messageId);
    setPane("reader");
  };

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
      <header className="flex h-control-lg shrink-0 items-center gap-2 border-b bg-surface px-2 lg:px-3">
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
        <div className="ms-auto">
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
          />
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {selected === null ? "" : `Selected: ${selected.subject ?? "(no subject)"}`}
      </p>
    </div>
  );
}
