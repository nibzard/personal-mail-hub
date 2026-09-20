import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AccountSummary,
  HomeClassificationCoverage,
  HomeItemView,
  HomePriorityView,
  HomeSectionIdWire,
  HomeWorkSummary,
  SearchResultItem,
} from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatAge, formatCount, formatFullTime } from "@/lib/format";
import { useOffline, useHomeData, type HomeDataState } from "@/home/data";
import { describeInstant, localTimeZone } from "@/home/reminder-times";
import {
  cancelHomeWork,
  completeHomeWork,
  createHomeWork,
  dismissHomeSuggestion,
  HomeMutationError,
  listHomePriorities,
  reopenHomeWork,
  rescheduleHomeWork,
  setHomePriority,
  undismissHomeSuggestion,
} from "@/home/mutations";
import { runMailAction } from "@/mail/actions";
import { HomeRow, HOME_SECTION_DESCRIPTIONS, rowOfItem, type HomeRowActions } from "./home-row";
import type { ReminderChoice } from "./reminder-panel";

/*
 * The Home screen (SPEC F13): important mail, explicit commitments, and
 * reminders in one column of compact rows. Mounting the screen is one visit:
 * the data hook loads every section once, refreshes run per section so the
 * visit boundary stays frozen, and Home-specific changes need a connection
 * and the recovery generation the session captured.
 */

/** The section headings, in the display order the server sends. */
export const HOME_SECTION_TITLES: Record<HomeSectionIdWire, string> = {
  due_now: "Due now",
  needs_attention: "Needs attention",
  reply_later: "Reply later",
  since_visit: "Since your last visit",
  saved: "Saved",
};

/** One result line with an optional undo control. */
interface HomeNote {
  text: string;
  undo?: { label: string; run: () => void };
}

/** How long a note stays, unless a newer one replaces it. */
const NOTE_TIMEOUT_MS = 10_000;

export function HomeScreen({
  accounts,
  recoveryGeneration,
  active,
  onOpenMessage,
  onOpenInbox,
  onOpenSettings,
  onSessionLost,
  className,
}: {
  accounts: AccountSummary[];
  recoveryGeneration: string | null;
  /** True while Home is the visible pane, for focus restoration. */
  active: boolean;
  onOpenMessage: (row: SearchResultItem) => void;
  onOpenInbox: () => void;
  onOpenSettings: () => void;
  onSessionLost: () => void;
  className?: string;
}) {
  const data = useHomeData(recoveryGeneration);
  const connectionOffline = useOffline();
  const offline = connectionOffline || data.state.offlineFromCache;
  const timeZone = useMemo(localTimeZone, []);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [note, setNote] = useState<HomeNote | null>(null);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const [priorities, setPriorities] = useState<HomePriorityView[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const noteTimer = useRef<number | null>(null);
  const lastOpened = useRef<string | null>(null);

  /** Shows one result for a while; an undo control stays until dismissed. */
  const showNote = useCallback((next: HomeNote | null) => {
    if (noteTimer.current !== null) {
      window.clearTimeout(noteTimer.current);
      noteTimer.current = null;
    }
    setNote(next);
    if (next !== null && next.undo === undefined) {
      noteTimer.current = window.setTimeout(() => setNote(null), NOTE_TIMEOUT_MS);
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

  // The recorded priority choices, for remove controls and their revisions.
  useEffect(() => {
    let live = true;
    listHomePriorities().then(
      (choices) => {
        if (live) {
          setPriorities(choices);
        }
      },
      () => {
        // A failed read only leaves the remove controls hidden.
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // New arrivals announce themselves after a refresh found them (SPEC F13).
  const sinceCount =
    data.state.sections.find((section) => section.id === "since_visit")?.items.length ?? 0;
  const previousSince = useRef<number | null>(null);
  useEffect(() => {
    if (previousSince.current !== null && sinceCount > previousSince.current) {
      const arrived = sinceCount - previousSince.current;
      showNote({ text: `${arrived} new message${arrived === 1 ? "" : "s"} arrived.` });
    }
    previousSince.current = sinceCount;
  }, [sinceCount, showNote]);

  // Returning from the reader puts focus back on the row that opened it,
  // when focus fell nowhere while Home was covered (SPEC F13).
  useEffect(() => {
    if (!active || typeof document === "undefined") {
      return;
    }
    if (document.activeElement !== document.body) {
      return;
    }
    const key = lastOpened.current ?? selectedKey;
    if (key === null) {
      return;
    }
    const row = document.querySelector<HTMLElement>(
      `[data-home-entry="${cssEscape(key)}"] > button`,
    );
    row?.focus();
  }, [active, selectedKey]);

  /** Turns one rejection into the note it deserves. */
  const noteFailure = useCallback(
    (cause: unknown) => {
      if (cause instanceof HomeMutationError && cause.cause.unauthorized) {
        onSessionLost();
        return;
      }
      showNote({
        text:
          cause instanceof HomeMutationError
            ? cause.cause.message
            : "The change could not be saved. Try again.",
      });
    },
    [onSessionLost, showNote],
  );

  /** Runs one Home change: busy row, note, refresh, and failure handling. */
  const runChange = useCallback(
    async (entryKey: string, run: () => Promise<string | HomeNote>) => {
      setBusyEntry(entryKey);
      try {
        const outcome = await run();
        showNote(typeof outcome === "string" ? { text: outcome } : outcome);
        data.refresh();
      } catch (cause) {
        if (cause instanceof HomeMutationError && cause.cause.code === "work_stale") {
          showNote({ text: "This work changed on another device. The rows now show the current state." });
          data.refresh();
        } else {
          noteFailure(cause);
        }
      } finally {
        setBusyEntry(null);
      }
    },
    [data, noteFailure, showNote],
  );

  const actions = useMemo<HomeRowActions>(
    () => ({
      open: (item, row) => {
        lastOpened.current = item.entryKey;
        setSelectedKey(item.entryKey);
        onOpenMessage(row);
      },
      replyLater: (item) => {
        void runChange(item.entryKey, async () => {
          await createHomeWork(recoveryGeneration, {
            accountId: item.message.accountId,
            anchorMessageId: item.message.messageId,
            kind: "reply_later",
          });
          return "Saved to reply later.";
        });
      },
      remind: (item, choice: ReminderChoice) => {
        void runChange(item.entryKey, async () => {
          await createHomeWork(recoveryGeneration, {
            accountId: item.message.accountId,
            anchorMessageId: item.message.messageId,
            kind: "reminder",
            dueAt: choice.dueAt,
            timeZone: choice.timeZone,
          });
          return `Reminder set for ${describeInstant(new Date(choice.dueAt), choice.timeZone)}.`;
        });
      },
      rescheduleWork: (work, choice: ReminderChoice) => {
        void runChange(workKey(work), async () => {
          await rescheduleHomeWork(recoveryGeneration, work.id, {
            revision: work.revision,
            dueAt: choice.dueAt,
            timeZone: choice.timeZone,
          });
          return `Reminder moved to ${describeInstant(new Date(choice.dueAt), choice.timeZone)}.`;
        });
      },
      completeWork: (work) => {
        void runChange(workKey(work), async () => {
          const done = await completeHomeWork(recoveryGeneration, work.id, work.revision);
          return {
            text: "Completed.",
            undo: {
              label: "Undo",
              run: () => {
                void runChange(workKey(work), async () => {
                  await reopenHomeWork(recoveryGeneration, done.id, done.revision);
                  return "Reopened.";
                });
              },
            },
          };
        });
      },
      reopenWork: (work) => {
        void runChange(workKey(work), async () => {
          await reopenHomeWork(recoveryGeneration, work.id, work.revision);
          return "Reopened.";
        });
      },
      cancelWork: (work) => {
        void runChange(workKey(work), async () => {
          await cancelHomeWork(recoveryGeneration, work.id, work.revision);
          return "Removed.";
        });
      },
      dismiss: (item) => {
        const accountId = item.message.accountId;
        const messageId = item.message.messageId;
        void (async () => {
          setBusyEntry(item.entryKey);
          try {
            await dismissHomeSuggestion(recoveryGeneration, { accountId, messageId });
            data.removeEntry(sectionOf(data.state, item), item.entryKey);
            showNote({
              text: "Suggestion removed.",
              undo: {
                label: "Undo",
                run: () => {
                  void runChange(item.entryKey, async () => {
                    await undismissHomeSuggestion(recoveryGeneration, accountId, messageId);
                    return "Suggestion restored.";
                  });
                },
              },
            });
          } catch (cause) {
            noteFailure(cause);
          } finally {
            setBusyEntry(null);
          }
        })();
      },
      prioritize: (item, target) => {
        void runChange(item.entryKey, async () => {
          const choices = await setHomePriority(recoveryGeneration, {
            accountId: item.message.accountId,
            target,
            prioritized: true,
          });
          setPriorities(choices);
          return target.kind === "sender" ? "Sender prioritized." : "Thread prioritized.";
        });
      },
      unprioritize: (choice) => {
        void runChange(`priority:${choice.id}`, async () => {
          const choices = await setHomePriority(recoveryGeneration, {
            accountId: choice.accountId,
            target: choice.target,
            prioritized: false,
            revision: choice.revision,
          });
          setPriorities(choices);
          return "Priority removed.";
        });
      },
      star: (item) => {
        void runMailAction({
          kind: item.message.flagged ? "unstar" : "star",
          row: rowOfItem(item),
          recoveryGeneration,
        }).then((outcome) => {
          reportMailOutcome(outcome, item.message.flagged ? "Unstarred." : "Starred.");
          if (outcome.state === "submitted") {
            data.refresh();
          }
        });
      },
      archive: (item) => {
        void runMailAction({
          kind: "archive",
          row: rowOfItem(item),
          recoveryGeneration,
        }).then((outcome) => {
          reportMailOutcome(outcome, "Archived.");
          if (outcome.state === "submitted") {
            data.removeEntry(sectionOf(data.state, item), item.entryKey);
            data.refresh();
          }
        });
      },
    }),
    [data, noteFailure, recoveryGeneration, runChange, showNote],
  );

  /** Reports one mailbox action; these queue offline, unlike Home changes. */
  function reportMailOutcome(
    outcome: Awaited<ReturnType<typeof runMailAction>>,
    confirmedText: string,
  ): void {
    if (outcome.state === "submitted") {
      const total = outcome.confirmed + outcome.pending + outcome.needsAttention;
      const bare = confirmedText.replace(/\.$/, "");
      showNote({
        text:
          outcome.confirmed === total
            ? confirmedText
            : outcome.needsAttention > 0
              ? `${bare}: ${outcome.needsAttention} target${
                  outcome.needsAttention === 1 ? "" : "s"
                } need attention. Refresh and reapply.`
              : `${bare}: ${outcome.pending} still executing on the server.`,
      });
      return;
    }
    if (outcome.state === "queued-offline") {
      showNote({ text: "Offline. The action is queued on this device and replays on return." });
      return;
    }
    showNote({ text: outcome.message });
  }

  const state = data.state;
  const allEmpty =
    state.phase === "ready" && state.sections.every((section) => section.total === 0);

  return (
    <section aria-label="Home" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 id="home-heading" className="font-semibold">
            Home
          </h2>
          <p className="text-muted-foreground">{updatedLabel(state)} · All accounts</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={state.phase !== "ready" || state.refreshing}
          onClick={data.refresh}
        >
          {state.refreshing ? (
            <Spinner aria-hidden="true" className="size-3.5" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-3.5" />
          )}
          Update
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onOpenInbox}>
          Open Inbox
        </Button>
      </div>

      {state.offlineFromCache && (
        <p className="border-b bg-surface px-3 py-1.5 text-muted-foreground">
          Offline. Showing Home data cached at{" "}
          {state.cachedAt === null
            ? "an unknown time"
            : formatFullTime(new Date(state.cachedAt).toISOString())}
          . It may be incomplete, and changes stay disabled until you reconnect.
        </p>
      )}
      {!state.offlineFromCache && connectionOffline && (
        <p className="border-b bg-surface px-3 py-1.5 text-muted-foreground">
          No connection. Home changes stay disabled until you reconnect.
        </p>
      )}
      {state.classification !== null && (
        <CoverageLine coverage={state.classification} onOpenSettings={onOpenSettings} />
      )}
      {offline && (
        <p className="border-b bg-surface px-3 py-1.5 text-muted-foreground">
          Home changes need a connection, so their controls are disabled here.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {note !== null && (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 border-b bg-surface px-3 py-1.5 text-muted-foreground"
          >
            <span className="min-w-0 flex-1">{note.text}</span>
            {note.undo !== undefined && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const undo = note.undo;
                  showNote(null);
                  undo?.run();
                }}
              >
                {note.undo.label}
              </Button>
            )}
          </p>
        )}

        {accounts.length === 0 ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <p className="font-medium">No accounts are configured yet.</p>
            <p className="text-muted-foreground">Add an account, and Home follows its mail.</p>
            <Button type="button" variant="outline" size="sm" onClick={onOpenSettings}>
              Open settings
            </Button>
          </div>
        ) : state.phase === "loading" ? (
          <LoadingSkeleton />
        ) : state.phase === "error" ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <p className="font-medium">
              {state.error?.unauthorized === true ? "Your session ended." : "Home cannot be loaded."}
            </p>
            <p className="text-muted-foreground">
              {state.error?.message ?? "The mail service cannot be reached."}
            </p>
            {state.error?.unauthorized === true ? (
              <Button type="button" size="sm" onClick={onSessionLost}>
                Sign in again
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={data.reload}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <>
            {allEmpty && (
              <div className="flex flex-col items-start gap-2 p-4">
                <p className="font-medium">No suggestions right now.</p>
                <p className="text-muted-foreground">
                  Nothing needs your attention. Your mail stays in the Inbox.
                </p>
                <Button type="button" variant="outline" size="sm" onClick={onOpenInbox}>
                  Open Inbox
                </Button>
              </div>
            )}
            {state.sections.map((section) => (
              <HomeSectionList
                key={section.id}
                section={section}
                collapsed={section.id === "saved" && !expanded.has("saved")}
                onToggleSaved={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has("saved")) {
                      next.delete("saved");
                    } else {
                      next.add("saved");
                    }
                    return next;
                  })
                }
                offline={offline}
                timeZone={timeZone}
                busyEntry={busyEntry}
                selectedKey={selectedKey}
                priorities={priorities}
                actions={actions}
                onLoadMore={() => data.loadMore(section.id)}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** One section: heading, description, count, rows, and the expansion control. */
function HomeSectionList({
  section,
  collapsed,
  onToggleSaved,
  offline,
  timeZone,
  busyEntry,
  selectedKey,
  priorities,
  actions,
  onLoadMore,
}: {
  section: HomeDataState["sections"][number];
  collapsed: boolean;
  onToggleSaved: () => void;
  offline: boolean;
  timeZone: string;
  busyEntry: string | null;
  selectedKey: string | null;
  priorities: HomePriorityView[];
  actions: HomeRowActions;
  onLoadMore: () => void;
}) {
  if (section.total === 0 && section.items.length === 0) {
    return null;
  }
  const hidden = section.total - section.items.length;
  return (
    <section aria-labelledby={`home-section-${section.id}`} className="border-b last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2 px-3 pb-1 pt-3">
        <h3 id={`home-section-${section.id}`} className="font-medium">
          {HOME_SECTION_TITLES[section.id]}
        </h3>
        <span className="text-muted-foreground">{HOME_SECTION_DESCRIPTIONS[section.id]}</span>
        <span className="ms-auto text-muted-foreground">
          {formatCount(section.total)}
          {section.items.length < section.total ? ` (${formatCount(section.items.length)} shown)` : ""}
        </span>
      </div>
      {collapsed ? (
        <div className="px-3 pb-3">
          <Button type="button" variant="outline" size="sm" onClick={onToggleSaved}>
            Show {formatCount(section.total)} starred
          </Button>
        </div>
      ) : (
        <>
          <ol aria-label={HOME_SECTION_TITLES[section.id]} className="flex flex-col">
            {section.items.map((item) => (
              <HomeRow
                key={item.entryKey}
                item={item}
                selected={item.entryKey === selectedKey}
                offline={offline}
                priority={priorityFor(item, priorities)}
                timeZone={timeZone}
                busy={busyEntry === item.entryKey}
                actions={actions}
              />
            ))}
          </ol>
          {(section.nextCursor !== null || hidden > 0) && (
            <div className="flex items-center gap-2 px-3 py-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={section.loadingMore}
                onClick={onLoadMore}
              >
                {section.loadingMore ? <Spinner aria-hidden="true" className="size-3.5" /> : null}
                {section.loadingMore
                  ? "Loading…"
                  : hidden > 0
                    ? `Show ${formatCount(hidden)} more`
                    : "Show more"}
              </Button>
              <span className="text-muted-foreground">
                {formatCount(section.total)} in {HOME_SECTION_TITLES[section.id]}
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** How much classification stands behind the suggestions (SPEC F13). */
function CoverageLine({
  coverage,
  onOpenSettings,
}: {
  coverage: HomeClassificationCoverage;
  onOpenSettings: () => void;
}) {
  let content: ReactNode = coverage.description;
  if (coverage.state === "active") {
    content = (
      <>
        Suggestions cover {formatCount(coverage.answered)} of {formatCount(coverage.considered)} inbox
        messages with stored answers
        {coverage.newestAnswerAt !== null ? `; newest ${formatFullTime(coverage.newestAnswerAt)}` : ""}.
        Stored answers cannot promise every important message was found.
      </>
    );
  } else if (coverage.state === "disabled") {
    content = (
      <>
        Classification is off. Home shows your choices, saved work, and new arrivals.{" "}
        <Button type="button" variant="ghost" size="sm" className="h-auto px-1" onClick={onOpenSettings}>
          Open settings
        </Button>
      </>
    );
  } else if (coverage.state === "paused") {
    content = (
      <>
        {coverage.description} Stored suggestions stay, with their age
        {coverage.newestAnswerAt !== null ? `; newest ${formatFullTime(coverage.newestAnswerAt)}` : ""}.
      </>
    );
  }
  return <p className="border-b bg-surface px-3 py-1.5 text-muted-foreground">{content}</p>;
}

function LoadingSkeleton() {
  return (
    <div aria-label="Loading Home" className="flex flex-col gap-3 p-3">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** "Updated just now", from the answer's generation time. */
function updatedLabel(state: HomeDataState): string {
  if (state.generatedAt === null) {
    return "Updating…";
  }
  const parsed = Date.parse(state.generatedAt);
  if (Number.isNaN(parsed)) {
    return "Updated";
  }
  const ageSeconds = Math.max(0, (Date.now() - parsed) / 1000);
  return ageSeconds < 45 ? "Updated just now" : `Updated ${formatAge(ageSeconds)}`;
}

/** The section an entry sits in, for local removals after a confirmed change. */
function sectionOf(state: HomeDataState, item: HomeItemView): HomeSectionIdWire {
  const section = state.sections.find((candidate) =>
    candidate.items.some((entry) => entry.entryKey === item.entryKey),
  );
  return section?.id ?? "needs_attention";
}

/** The recorded priority choice covering one entry, when one exists. */
function priorityFor(item: HomeItemView, priorities: HomePriorityView[]): HomePriorityView | null {
  const accountId = item.message.accountId;
  const sender = item.message.sender?.address.toLowerCase() ?? null;
  const threadId = item.message.threadId;
  return (
    priorities.find(
      (choice) =>
        choice.accountId === accountId &&
        ((choice.target.kind === "sender" && sender !== null && choice.target.sender === sender) ||
          (choice.target.kind === "thread" && threadId !== null && choice.target.threadId === threadId)),
    ) ?? null
  );
}

/** One saved work item's busy key; a work line marks its own row busy. */
function workKey(work: HomeWorkSummary): string {
  return `work:${work.id}`;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(value) : value;
}
