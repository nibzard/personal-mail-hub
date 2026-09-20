import type { AccountSummary, FolderSummary, SearchResultItem } from "@mail-hub/contracts";

/*
 * The navigation model (SPEC F3): one unified inbox, one all-mail view, and
 * one section per account that can narrow to a single folder.
 */

/** Which messages the list shows. */
export type MailScope =
  | { kind: "unified-inbox" }
  | { kind: "all-mail" }
  | { kind: "account"; accountId: string; folderId: string | null };

/** True when both scopes select the same rows. */
export function scopeEquals(a: MailScope, b: MailScope): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "account" && b.kind === "account") {
    return a.accountId === b.accountId && a.folderId === b.folderId;
  }
  return true;
}

/** Stable identity of a scope, used as a fetch key. */
export function scopeKey(scope: MailScope): string {
  if (scope.kind === "account") {
    return `account:${scope.accountId}:${scope.folderId ?? "*"}`;
  }
  return scope.kind;
}

/** The folder one account mapped to a role, when the role is mapped. */
export function folderForRole(
  folders: FolderSummary[],
  role: NonNullable<FolderSummary["role"]>,
): FolderSummary | null {
  return folders.find((folder) => folder.role === role) ?? null;
}

/**
 * The downloaded rows one scope can show offline (SPEC F9). The scope filter
 * reads each row's cached occurrences, so the fallback never mixes accounts
 * or folders: the unified inbox keeps rows an indexed folder maps to inbox,
 * and an account scope keeps its own account, narrowed to the folder when
 * one is chosen. Without a folder index no role is known, so no row
 * qualifies for the unified inbox. The server stays the only full-text
 * index; a query narrows the downloaded rows by the text each row itself
 * carries, which the offline notice states beside the list.
 */
export function filterCachedRows(
  rows: SearchResultItem[],
  scope: MailScope,
  folderIndex: Map<string, FolderSummary[]> | null,
  query: string,
): SearchResultItem[] {
  const inboxFolderIds = new Set<string>();
  if (scope.kind === "unified-inbox" && folderIndex !== null) {
    for (const folders of folderIndex.values()) {
      const inbox = folderForRole(folders, "inbox");
      if (inbox !== null) {
        inboxFolderIds.add(inbox.id);
      }
    }
  }
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (scope.kind === "unified-inbox") {
      if (!row.occurrences.some((occurrence) => inboxFolderIds.has(occurrence.folderId))) {
        return false;
      }
    } else if (scope.kind === "account") {
      if (row.accountId !== scope.accountId) {
        return false;
      }
      const folderId = scope.folderId;
      if (
        folderId !== null &&
        !row.occurrences.some((occurrence) => occurrence.folderId === folderId)
      ) {
        return false;
      }
    }
    if (needle.length === 0) {
      return true;
    }
    const haystack = [
      row.subject ?? "",
      row.snippet ?? "",
      row.sender?.address ?? "",
      row.sender?.name ?? "",
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** Folders in navigation order: mapped roles first, then the rest by name. */
export function orderFolders(folders: FolderSummary[]): FolderSummary[] {
  const order: Record<NonNullable<FolderSummary["role"]>, number> = {
    inbox: 0,
    sent: 1,
    drafts: 2,
    archive: 3,
    trash: 4,
    junk: 5,
  };
  return [...folders].sort((a, b) => {
    const rankA = a.role === null ? order.inbox + 6 : order[a.role];
    const rankB = b.role === null ? order.inbox + 6 : order[b.role];
    return rankA !== rankB ? rankA - rankB : a.name.localeCompare(b.name);
  });
}

/** The title of a scope, resolved against the known accounts and folders. */
export function scopeTitle(
  scope: MailScope,
  accounts: AccountSummary[] | null,
  folders: Map<string, FolderSummary[]> | null,
): string {
  if (scope.kind === "unified-inbox") {
    return "Inbox";
  }
  if (scope.kind === "all-mail") {
    return "All Mail";
  }
  const account = accounts?.find((entry) => entry.id === scope.accountId) ?? null;
  const folder =
    scope.folderId === null
      ? null
      : (folders?.get(scope.accountId)?.find((entry) => entry.id === scope.folderId) ?? null);
  if (folder !== null) {
    return folder.name;
  }
  return account === null ? "Account" : `${account.label}, all folders`;
}
