import { describe, expect, it } from "vitest";
import type { FolderSummary, SearchResultItem } from "@mail-hub/contracts";
import { filterCachedRows, folderForRole } from "../src/mail/view.ts";

/*
 * The offline fallback's scope decisions (SPEC F9): downloaded rows only
 * stand in for the view that downloaded them, and a query narrows them by
 * the text the row itself carries.
 */

let rowSeq = 0;

/** One downloaded row with its cached occurrences. */
function row(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  rowSeq += 1;
  return {
    messageId: `m-${rowSeq}`,
    accountId: "acc-personal",
    accountLabel: "Personal",
    accountColor: "#0f766e",
    threadId: null,
    subject: "Dinner on Saturday",
    snippet: "We booked the table for six.",
    sender: { address: "sam@example.net", name: "Sam" },
    sentAt: "2026-09-18T10:00:00Z",
    fetchedBody: true,
    hasAttachments: false,
    unread: false,
    flagged: false,
    activeOccurrences: 1,
    occurrences: [{ occurrenceId: "occ-1", folderId: "f-inbox", revision: 1, modseq: null }],
    noServerCopy: false,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
    ...overrides,
  };
}

/** A folder list with the roles one account maps. */
function folders(...entries: { id: string; name: string; role: FolderSummary["role"] }[]) {
  return entries.map((entry) => ({ ...entry }));
}

const INDEX = new Map<string, FolderSummary[]>([
  ["acc-personal", folders({ id: "f-inbox", name: "INBOX", role: "inbox" }, { id: "f-archive", name: "Archive", role: "archive" })],
  ["acc-work", folders({ id: "w-inbox", name: "INBOX", role: "inbox" })],
]);

describe("folderForRole", () => {
  it("finds the mapped folder and skips the unmapped", () => {
    const list = folders(
      { id: "f-projects", name: "Projects", role: null },
      { id: "f-inbox", name: "INBOX", role: "inbox" },
    );
    expect(folderForRole(list, "inbox")?.id).toBe("f-inbox");
    expect(folderForRole(list, "archive")).toBeNull();
  });
});

describe("filterCachedRows", () => {
  it("keeps only rows an indexed inbox folder holds, across accounts", () => {
    const rows = [
      row({ messageId: "inbox-1" }),
      row({ messageId: "w-1", accountId: "acc-work", occurrences: [{ occurrenceId: "occ-w", folderId: "w-inbox", revision: 1, modseq: null }] }),
      row({ messageId: "archived", occurrences: [{ occurrenceId: "occ-a", folderId: "f-archive", revision: 1, modseq: null }] }),
    ];
    const kept = filterCachedRows(rows, { kind: "unified-inbox" }, INDEX, "");
    expect(kept.map((entry) => entry.messageId)).toEqual(["inbox-1", "w-1"]);
  });

  it("qualifies nothing for the unified inbox without a folder index", () => {
    const kept = filterCachedRows([row()], { kind: "unified-inbox" }, null, "");
    expect(kept).toEqual([]);
  });

  it("keeps one account's rows, narrowed to the chosen folder", () => {
    const rows = [
      row({ messageId: "inbox-1" }),
      row({ messageId: "w-1", accountId: "acc-work", occurrences: [{ occurrenceId: "occ-w", folderId: "w-inbox", revision: 1, modseq: null }] }),
      row({ messageId: "archived", occurrences: [{ occurrenceId: "occ-a", folderId: "f-archive", revision: 1, modseq: null }] }),
    ];
    const accountWide = filterCachedRows(rows, { kind: "account", accountId: "acc-personal", folderId: null }, INDEX, "");
    expect(accountWide.map((entry) => entry.messageId)).toEqual(["inbox-1", "archived"]);
    const oneFolder = filterCachedRows(rows, { kind: "account", accountId: "acc-personal", folderId: "f-archive" }, INDEX, "");
    expect(oneFolder.map((entry) => entry.messageId)).toEqual(["archived"]);
  });

  it("keeps every account for all mail", () => {
    const rows = [
      row({ messageId: "inbox-1" }),
      row({ messageId: "w-1", accountId: "acc-work", occurrences: [{ occurrenceId: "occ-w", folderId: "w-inbox", revision: 1, modseq: null }] }),
    ];
    const kept = filterCachedRows(rows, { kind: "all-mail" }, INDEX, "");
    expect(kept).toHaveLength(2);
  });

  it("narrows a query by the subject, snippet, and sender a row carries", () => {
    const rows = [
      row({ subject: "Dinner on Saturday" }),
      row({ subject: "Quarterly budget", snippet: "dinner costs included" }),
      row({ subject: "Hello", sender: { address: "chef@dinner.example", name: null } }),
      row({ subject: "Lunch plans" }),
    ];
    const kept = filterCachedRows(rows, { kind: "all-mail" }, INDEX, "dinner");
    expect(kept.map((entry) => entry.subject)).toEqual([
      "Dinner on Saturday",
      "Quarterly budget",
      "Hello",
    ]);
  });

  it("matches the query without regard to case and spacing", () => {
    const kept = filterCachedRows([row()], { kind: "all-mail" }, INDEX, "  DINNER  ");
    expect(kept).toHaveLength(1);
  });
});
