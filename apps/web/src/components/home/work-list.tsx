import { useEffect, useState } from "react";
import type { HomeWorkListResponse, HomeWorkRecordView, SearchResultItem } from "@mail-hub/contracts";
import { apiGet, toApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { describeInstant, localTimeZone } from "@/home/reminder-times";
import { rowOfItem, WorkLine, type HomeRowActions } from "./home-row";
import { ReminderPanel } from "./reminder-panel";

/** All saved work remains reachable after it leaves the overview. */
export function WorkList({ status, version, offline, busyKey, actions, onOpenMessage }: {
  status: "open" | "done";
  version: number;
  offline: boolean;
  busyKey: string | null;
  actions: HomeRowActions;
  onOpenMessage: (key: string, row: SearchResultItem) => void;
}) {
  const [records, setRecords] = useState<HomeWorkRecordView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const title = status === "open" ? "Active work" : "Completed work";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiGet<HomeWorkListResponse>(`/home/work?status=${status}&limit=50`, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return;
        setRecords(response.work);
        setCursor(response.nextCursor ?? null);
        setLoading(false);
      },
      (cause) => {
        if (controller.signal.aborted) return;
        setError(toApiError(cause).message);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [status, version, retry]);

  async function loadMore() {
    if (cursor === null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<HomeWorkListResponse>(
        `/home/work?status=${status}&limit=50&cursor=${encodeURIComponent(cursor)}`);
      setRecords((current) => [...new Map([...current, ...response.work].map((work) => [work.id, work])).values()]);
      setCursor(response.nextCursor ?? null);
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label={title} className="border-b">
      <h3 className="px-3 pt-3 font-medium">{title}</h3>
      <p className="px-3 pb-2 text-muted-foreground">
        {status === "open" ? "All reminders, including future dates, and replies you planned."
          : "Review completed reminders and replies. Reopen any item to restore it."}
      </p>
      {error !== null && <div role="alert" className="px-3 py-2">
        <p>{error}</p>
        <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>Try again</Button>
      </div>}
      {loading && <p role="status" className="px-3 py-2 text-muted-foreground">Loading saved work…</p>}
      {!loading && error === null && records.length === 0 &&
        <p className="p-3 text-muted-foreground">{status === "open" ? "No active work." : "No completed work."}</p>}
      <ol aria-label={title}>
        {records.map((work) => {
          const key = `work:${work.id}`;
          const busy = busyKey === key;
          return <li key={work.id} data-home-entry={key} className="border-t px-3 py-2">
            <button type="button" disabled={work.anchor === null}
              className="mb-1 min-h-8 w-full text-left font-medium"
              onClick={() => {
                if (work.anchor === null) return;
                onOpenMessage(key, rowOfItem({ entryKey: key, message: work.anchor,
                  messageIds: [work.anchorMessageId], reasons: [], work: [work],
                  occurrences: work.occurrences ?? [], noServerCopy: (work.occurrences?.length ?? 0) === 0 }));
              }}>
              {work.anchor?.subject ?? "Message unavailable"}
              {work.anchor !== null && <span className="ms-2 font-normal text-muted-foreground">{work.anchor.accountLabel}</span>}
            </button>
            <WorkLine work={work} offline={offline} busy={busy} actions={actions}
              label={work.kind === "reply_later" ? "Reply planned" : `Reminder: ${work.dueAt === null ? "No date" : describeInstant(new Date(work.dueAt), work.timeZone ?? localTimeZone())}`}
              onReschedule={work.status === "open" && work.kind === "reminder"
                ? () => setRescheduling(work.id) : null} />
            {rescheduling === work.id && <div className="pt-2"><ReminderPanel
              timeZone={work.timeZone ?? localTimeZone()} busy={busy || offline}
              onChoose={(choice) => {
                setRescheduling(null);
                actions.rescheduleWork(work, choice);
              }} /></div>}
          </li>;
        })}
      </ol>
      {cursor !== null && <div className="p-3"><Button variant="outline" size="sm"
        disabled={loading || offline} onClick={() => void loadMore()}>Show more work</Button></div>}
    </section>
  );
}
