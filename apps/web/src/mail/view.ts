import type { AccountSummary, FolderSummary } from "@mail-hub/contracts";

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
