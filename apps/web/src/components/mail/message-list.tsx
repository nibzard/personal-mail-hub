import { RotateCw, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { SearchResultItem } from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCount } from "@/lib/format";
import type { MessageListState } from "@/mail/data";
import { MessageRow } from "./message-row";

/*
 * The message list pane (SPEC F3 and F12). Rendering stays bounded: rows sit
 * at the density's fixed height and only the visible window plus overscan is
 * mounted, while paging keeps requests at one page each. Loading uses
 * layout-matched skeletons, and failures stay inspectable with one action.
 */

/** Rows mounted above and below the viewport. */
const OVERSCAN = 6;

/** Skeleton rows shown while the first page loads. */
const SKELETON_ROWS = 10;

export interface MessageListPaneProps {
  title: string;
  /** Scope identity; a change resets the scroll to the top. */
  scopeResetKey: string;
  state: MessageListState;
  onLoadMore: () => void;
  onReload: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  selectedId: string | null;
  onSelect: (item: SearchResultItem) => void;
  showAccountLabels: boolean;
  onSessionLost: () => void;
  /** The search box the `/` shortcut and the palette focus (SPEC F3). */
  searchInputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}

export function MessageListPane({
  title,
  scopeResetKey,
  state,
  onLoadMore,
  onReload,
  query,
  onQueryChange,
  selectedId,
  onSelect,
  showAccountLabels,
  onSessionLost,
  searchInputRef,
  className,
}: MessageListPaneProps) {
  const rowHeight = useRowHeight();
  const trimmed = query.trim();

  return (
    <section
      id="message-list"
      aria-label={`${title} message list`}
      aria-busy={state.phase === "loading" || undefined}
      className={cn("flex min-h-0 flex-col bg-background", className)}
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {/* Focusable, so palette focus restoration has a heading target
            when the opener is gone (SPEC F11). */}
        <h2 id="message-list-heading" tabIndex={-1} className="truncate font-semibold">
          {title}
        </h2>
        {state.phase === "ready" && (
          <p className="shrink-0 text-muted-foreground">
            {formatCount(state.rows.length)} of {formatCount(state.total)}
          </p>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ms-auto"
          onClick={onReload}
          disabled={state.phase === "loading"}
          aria-label="Refresh this view"
        >
          <RotateCw
            aria-hidden="true"
            className={cn("size-4", state.loadingMore && "animate-spin")}
          />
        </Button>
      </header>

      <form
        role="search"
        aria-label="Search the current view"
        onSubmit={(event) => event.preventDefault()}
        className="shrink-0 border-b px-3 py-2"
      >
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search mail"
            aria-label="Search mail"
            className="ps-8"
          />
        </div>
      </form>

      {state.error !== null && state.rows.length > 0 && !state.offlineFromCache && (
        <p role="alert" className="shrink-0 bg-destructive-muted px-3 py-1.5 text-destructive-muted-foreground">
          {state.error.message}
        </p>
      )}

      {state.offlineFromCache && (
        <p role="status" className="shrink-0 bg-surface px-3 py-1.5 text-muted-foreground">
          Offline. Showing downloaded mail.
        </p>
      )}

      {state.phase === "loading" ? (
        <LoadingRows rowHeight={rowHeight} />
      ) : state.phase === "error" ? (
        <ListError state={state} onReload={onReload} onSessionLost={onSessionLost} />
      ) : state.rows.length === 0 ? (
        <EmptyList trimmed={trimmed} onClear={() => onQueryChange("")} onReload={onReload} />
      ) : (
        <RowWindow
          key={scopeResetKey}
          rows={state.rows}
          rowHeight={rowHeight}
          selectedId={selectedId}
          onSelect={onSelect}
          showAccountLabels={showAccountLabels}
          canLoadMore={state.canLoadMore}
          loadingMore={state.loadingMore}
          onLoadMore={onLoadMore}
        />
      )}

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1.5 text-muted-foreground">
        <p className="truncate">
          {indexingText(state) ??
            `Showing ${formatCount(state.rows.length)} of ${formatCount(state.total)}`}
        </p>
        {state.canLoadMore && (
          <Button variant="ghost" size="sm" onClick={onLoadMore} pending={state.loadingMore}>
            Show more
          </Button>
        )}
      </footer>

      <p role="status" aria-live="polite" className="sr-only">
        {state.phase === "ready" && state.error === null
          ? state.rows.length === 0
            ? "No messages"
            : `Loaded ${formatCount(state.rows.length)} messages`
          : state.error !== null
            ? state.error.message
            : ""}
      </p>
    </section>
  );
}

/** Body-indexing progress while the scope is still being indexed (SPEC F5). */
function indexingText(state: MessageListPaneProps["state"]): string | null {
  if (state.indexing === null || state.indexing.bodies >= state.indexing.messages) {
    return null;
  }
  return `Bodies indexed: ${formatCount(state.indexing.bodies)} of ${formatCount(
    state.indexing.messages,
  )}`;
}

/**
 * Row height follows the `--row-height` density token; the observer catches
 * density changes that do not remount the list.
 */
function useRowHeight(): number {
  const [height, setHeight] = useState(72);
  useLayoutEffect(() => {
    const measure = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--row-height").trim();
      const value = Number.parseFloat(raw);
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }
      // The token is relative, so the row tracks the root font size with the
      // text it holds.
      const pixels = raw.endsWith("rem") ? value * readRootFontSize() : value;
      setHeight((current) => (current === pixels ? current : pixels));
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-density"],
    });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return height;
}

function readRootFontSize(): number {
  const fontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
}

function LoadingRows({ rowHeight }: { rowHeight: number }) {
  return (
    <div className="flex-1 overflow-hidden" aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div
          key={index}
          className="flex flex-col justify-center gap-1.5 border-b px-3"
          style={{ height: rowHeight }}
        >
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function ListError({
  state,
  onReload,
  onSessionLost,
}: {
  state: MessageListState;
  onReload: () => void;
  onSessionLost: () => void;
}) {
  const unauthorized = state.error?.unauthorized === true;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-medium">{unauthorized ? "Your session ended." : "This view cannot be loaded."}</p>
      <p className="max-w-sm text-muted-foreground">{state.error?.message ?? ""}</p>
      {unauthorized ? (
        <Button onClick={onSessionLost}>Sign in again</Button>
      ) : (
        <Button variant="outline" onClick={onReload}>
          Try again
        </Button>
      )}
    </div>
  );
}

function EmptyList({
  trimmed,
  onClear,
  onReload,
}: {
  trimmed: string;
  onClear: () => void;
  onReload: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-medium">
        {trimmed.length > 0 ? `No messages match "${trimmed}".` : "No messages in this view."}
      </p>
      {trimmed.length > 0 ? (
        <Button variant="outline" onClick={onClear}>
          Clear search
        </Button>
      ) : (
        <Button variant="outline" onClick={onReload}>
          Refresh
        </Button>
      )}
    </div>
  );
}

interface RowWindowProps {
  rows: SearchResultItem[];
  rowHeight: number;
  selectedId: string | null;
  onSelect: (item: SearchResultItem) => void;
  showAccountLabels: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function RowWindow({
  rows,
  rowHeight,
  selectedId,
  onSelect,
  showAccountLabels,
  canLoadMore,
  loadingMore,
  onLoadMore,
}: RowWindowProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [viewport, setViewport] = useState(0);

  const handleScroll = useCallback(() => {
    if (frameRef.current !== 0) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const element = scrollerRef.current;
      if (element !== null) {
        setScrollOffset(element.scrollTop);
      }
    });
  }, []);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    setViewport(element.clientHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollOffset / rowHeight) - OVERSCAN);
  const end = Math.min(
    rows.length,
    Math.ceil((scrollOffset + viewport) / rowHeight) + OVERSCAN,
  );

  // Near the end of the loaded rows, fetch the next page (SPEC F12: the
  // action never waits on an animation, and the scroll position holds).
  useEffect(() => {
    if (end >= rows.length - 4 && canLoadMore && !loadingMore) {
      onLoadMore();
    }
  }, [end, rows.length, canLoadMore, loadingMore, onLoadMore]);

  // Keep the keyboard selection inside the visible window (SPEC F3, j/k).
  // Selection by pointer is already visible, so it never fights the scroll.
  useEffect(() => {
    const index = rows.findIndex((row) => row.messageId === selectedId);
    const element = scrollerRef.current;
    if (index < 0 || element === null) {
      return;
    }
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }, [selectedId, rows, rowHeight]);

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <ul className="relative m-0 list-none p-0" style={{ height: rows.length * rowHeight }}>
        {rows.slice(start, end).map((item, position) => (
          <li
            key={item.messageId}
            className="absolute inset-x-0"
            style={{ top: (start + position) * rowHeight, height: rowHeight }}
          >
            <MessageRow
              item={item}
              selected={item.messageId === selectedId}
              onSelect={onSelect}
              showAccount={showAccountLabels}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
