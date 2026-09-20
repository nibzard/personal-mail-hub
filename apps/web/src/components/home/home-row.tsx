import { Archive, BellRing, Check, Clock, MoreHorizontal, Star, Undo2 } from "lucide-react";
import { useState } from "react";
import type {
  HomeItemView,
  HomePriorityTargetWire,
  HomePriorityView,
  HomeReasonCode,
  HomeReasonOrigin,
  HomeSectionIdWire,
  HomeWorkSummary,
  SearchResultItem,
} from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatListTime, senderLabel } from "@/lib/format";
import { describeInstant } from "@/home/reminder-times";
import { ReminderPanel, type ReminderChoice } from "./reminder-panel";

/*
 * One Home entry (SPEC F13): the representative message, every reason it
 * appears, its saved work, and the actions that apply to it. The reason
 * labels are a fixed client-side vocabulary; a row never renders free text
 * from the server. Home-specific changes need a connection, so they disable
 * with an explanation while offline; the mailbox actions star and archive
 * keep their established queueing behavior.
 */

/** The fixed reason vocabulary (SPEC F13). */
export const HOME_REASON_LABELS: Record<HomeReasonCode, string> = {
  you_prioritized_sender: "You prioritized this sender",
  you_prioritized_thread: "You prioritized this thread",
  security_alert: "Security alert",
  may_need_action: "May need your action",
  may_need_reply: "May need your reply",
  time_sensitive: "Time sensitive",
  reminder_due: "Reminder due",
  reply_planned: "You planned to reply",
  new_arrival: "New arrival",
  you_starred: "You starred this",
};

/** The section descriptions under each heading. */
export const HOME_SECTION_DESCRIPTIONS: Record<HomeSectionIdWire, string> = {
  due_now: "Reminders you set",
  needs_attention: "Priority mail and suggestions",
  reply_later: "Messages you chose to answer",
  since_visit: "New arrivals",
  saved: "Starred messages for quick reference",
};

/** One Home entry as the reader and the mail actions consume it. */
export function rowOfItem(item: HomeItemView): SearchResultItem {
  const message = item.message;
  return {
    messageId: message.messageId,
    accountId: message.accountId,
    accountLabel: message.accountLabel,
    accountColor: message.accountColor,
    threadId: message.threadId,
    subject: message.subject,
    snippet: message.snippet,
    sender: message.sender,
    sentAt: message.sentAt,
    fetchedBody: true,
    hasAttachments: message.hasAttachments,
    unread: message.unread,
    flagged: message.flagged,
    activeOccurrences: item.occurrences.length,
    occurrences: item.occurrences,
    noServerCopy: item.noServerCopy,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
  };
}

/** Every change one row can start. The screen owns the network calls. */
export interface HomeRowActions {
  open(item: HomeItemView, row: SearchResultItem): void;
  replyLater(item: HomeItemView): void;
  remind(item: HomeItemView, choice: ReminderChoice): void;
  rescheduleWork(work: HomeWorkSummary, choice: ReminderChoice): void;
  completeWork(work: HomeWorkSummary): void;
  reopenWork(work: HomeWorkSummary): void;
  cancelWork(work: HomeWorkSummary): void;
  dismiss(item: HomeItemView): void;
  prioritize(item: HomeItemView, target: HomePriorityTargetWire): void;
  unprioritize(choice: HomePriorityView): void;
  star(item: HomeItemView): void;
  archive(item: HomeItemView): void;
}

export function HomeRow({
  item,
  selected,
  offline,
  priority,
  timeZone,
  busy,
  actions,
}: {
  item: HomeItemView;
  selected: boolean;
  /** True while Home-specific changes cannot reach the server. */
  offline: boolean;
  /** The recorded priority choice that covers this entry, when one exists. */
  priority: HomePriorityView | null;
  timeZone: string;
  /** True while one of this row's changes is in flight. */
  busy: boolean;
  actions: HomeRowActions;
}) {
  const [panel, setPanel] = useState<{ kind: "create" } | { kind: "reschedule"; work: HomeWorkSummary } | null>(
    null,
  );
  const message = item.message;
  const openReply = item.work.find((work) => work.kind === "reply_later" && work.status === "open") ?? null;
  const openReminder = item.work.find((work) => work.kind === "reminder" && work.status === "open") ?? null;
  const openWork = item.work.filter((work) => work.status === "open");
  const doneWork = item.work.filter((work) => work.status === "done");
  const hasSuggestion = item.reasons.some((reason) => reason.origin === "suggestion");

  return (
    <li
      data-home-entry={item.entryKey}
      className={cn(
        "border-b border-border",
        selected ? "bg-selection" : "hover:bg-muted/60 active:bg-muted/40",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => actions.open(item, rowOfItem(item))}
        className="flex w-full flex-col items-start gap-0.5 px-3 pt-2 text-left"
      >
        <span className="flex w-full items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full ring-1 ring-border"
            style={{ backgroundColor: message.accountColor }}
          />
          <span
            className={cn(
              "min-w-0 truncate",
              message.unread ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
            )}
          >
            {senderLabel(message.sender)}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">{message.accountLabel}</span>
          {item.messageIds.length > 1 && (
            <span className="shrink-0 text-muted-foreground">{item.messageIds.length} messages</span>
          )}
          <span className="ms-auto shrink-0 text-muted-foreground">{formatListTime(message.sentAt)}</span>
        </span>
        <span className={cn("w-full truncate", message.unread && "font-semibold")}>
          {message.subject ?? "(no subject)"}
        </span>
        <span className="w-full truncate text-muted-foreground">{message.snippet ?? ""}</span>
      </button>

      {(item.reasons.length > 0 || item.noServerCopy) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1.5">
          {item.reasons.map((reason) => (
            <ReasonChip key={`${reason.code}:${reason.origin}`} code={reason.code} origin={reason.origin} />
          ))}
          {item.noServerCopy && (
            <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">
              No server copy left
            </span>
          )}
        </div>
      )}

      {(openReminder !== null || openReply !== null || doneWork.length > 0) && (
        <div className="flex flex-col gap-1 px-3 pt-1.5">
          {openWork.map((work) => (
            <WorkLine
              key={work.id}
              label={work.kind === "reply_later" ? "Reply planned"
                : `Reminder${work.dueAt === null ? "" : `: ${describeInstant(new Date(work.dueAt), work.timeZone ?? timeZone)}`}`}
              work={work} offline={offline} busy={busy} actions={actions}
              onReschedule={work.kind === "reminder"
                ? () => setPanel({ kind: "reschedule", work }) : null}
            />
          ))}
          {doneWork.map((work) => (
            <WorkLine
              key={work.id}
              label={work.kind === "reminder" ? "Reminder completed" : "Reply completed"}
              work={work}
              offline={offline}
              busy={busy}
              actions={actions}
              onReschedule={null}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1.5">
        {openReply === null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={offline || busy}
            onClick={() => actions.replyLater(item)}
          >
            Reply later
          </Button>
        )}
        {openReminder === null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={offline || busy}
            aria-expanded={panel?.kind === "create"}
            onClick={() => setPanel((current) => (current === null ? { kind: "create" } : null))}
          >
            <BellRing aria-hidden="true" className="size-3.5" />
            Remind me
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={item.noServerCopy || busy}
          onClick={() => actions.star(item)}
        >
          <Star
            aria-hidden="true"
            className={cn("size-3.5", message.flagged && "fill-current")}
          />
          {message.flagged ? "Unstar" : "Star"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={item.noServerCopy || busy}
          onClick={() => actions.archive(item)}
        >
          <Archive aria-hidden="true" className="size-3.5" />
          Archive
        </Button>
        {hasSuggestion && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={offline || busy}
            onClick={() => actions.dismiss(item)}
          >
            Dismiss
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-label="More actions">
              <MoreHorizontal aria-hidden="true" className="size-3.5" />
              More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={offline || busy}
              onSelect={() => {
                if (message.sender !== null) {
                  actions.prioritize(item, { kind: "sender", sender: message.sender.address });
                }
              }}
            >
              Prioritize sender
            </DropdownMenuItem>
            {message.threadId !== null && (
              <DropdownMenuItem
                disabled={offline || busy}
                onSelect={() => actions.prioritize(item, { kind: "thread", threadId: message.threadId! })}
              >
                Prioritize thread
              </DropdownMenuItem>
            )}
            {priority !== null && (
              <DropdownMenuItem disabled={offline || busy} onSelect={() => actions.unprioritize(priority)}>
                Remove priority
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {panel !== null && (
        <div className="px-3 pb-3">
          {panel.kind === "create" ? (
            <ReminderPanel
              timeZone={timeZone}
              busy={busy}
              onChoose={(choice) => {
                setPanel(null);
                actions.remind(item, choice);
              }}
            />
          ) : (
            <ReminderPanel
              timeZone={panel.work.timeZone ?? timeZone}
              busy={busy}
              onChoose={(choice) => {
                const work = panel.work;
                setPanel(null);
                actions.rescheduleWork(work, choice);
              }}
            />
          )}
        </div>
      )}
    </li>
  );
}

/** One reason a row appears, with its origin spelled out for screen readers. */
function ReasonChip({ code, origin }: { code: HomeReasonCode; origin: HomeReasonOrigin }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs",
        origin === "choice"
          ? "border border-border bg-surface text-foreground"
          : "border border-dashed border-border text-muted-foreground",
      )}
    >
      {origin !== "notice" && <span className="sr-only">{origin === "choice" ? "Your choice: " : "Suggestion: "}</span>}
      {HOME_REASON_LABELS[code]}
    </span>
  );
}

/** One saved work line: what it is, and the controls that act on it. */
export function WorkLine({
  label,
  work,
  offline,
  busy,
  actions,
  onReschedule,
}: {
  label: string;
  work: HomeWorkSummary;
  offline: boolean;
  busy: boolean;
  actions: HomeRowActions;
  /** Opens the reschedule panel; `null` when the kind has no due time. */
  onReschedule: (() => void) | null;
}) {
  const done = work.status === "done";
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 text-muted-foreground",
        work.anchorUnavailable && "border-dashed",
      )}
    >
      {work.kind === "reminder" ? (
        <Clock aria-hidden="true" className="size-3.5" />
      ) : (
        <Check aria-hidden="true" className="size-3.5" />
      )}
      <span>{label}</span>
      {work.anchorUnavailable && (
        <span className="text-foreground">The anchor message is unavailable on the server.</span>
      )}
      {done ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ms-auto"
          disabled={offline || busy}
          onClick={() => actions.reopenWork(work)}
        >
          <Undo2 aria-hidden="true" className="size-3.5" />
          Reopen
        </Button>
      ) : (
        <span className="ms-auto flex items-center gap-1">
          {onReschedule !== null && (
            <Button type="button" variant="ghost" size="sm" disabled={offline || busy} onClick={onReschedule}>
              Move
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={offline || busy}
            onClick={() => actions.completeWork(work)}
          >
            <Check aria-hidden="true" className="size-3.5" />
            Done
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={offline || busy}
            onClick={() => actions.cancelWork(work)}
          >
            Remove
          </Button>
        </span>
      )}
    </p>
  );
}
