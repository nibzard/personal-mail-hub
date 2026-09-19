import {
  Archive,
  Ban,
  ChevronDown,
  ChevronRight,
  FilePen,
  Folder,
  Inbox,
  Mail,
  Send,
  Trash,
} from "lucide-react";
import type { ComponentType } from "react";
import { useState } from "react";
import type { AccountSummary, FolderSummary } from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { orderFolders, type MailScope } from "@/mail/view";

/*
 * The navigation pane (SPEC F3): the unified inbox, All Mail, and one
 * expandable section per account with its folders. Account colors stay small
 * and always travel with the account name (SPEC F12).
 */

const ROLE_ICONS: Record<NonNullable<FolderSummary["role"]>, ComponentType<{ className?: string }>> = {
  inbox: Inbox,
  sent: Send,
  drafts: FilePen,
  archive: Archive,
  trash: Trash,
  junk: Ban,
};

interface NavPaneProps {
  accounts: AccountSummary[];
  folders: Map<string, FolderSummary[]> | null;
  foldersFailed: boolean;
  onRetryFolders: () => void;
  scope: MailScope;
  onScopeChange: (scope: MailScope) => void;
  className?: string;
}

export function NavPane({
  accounts,
  folders,
  foldersFailed,
  onRetryFolders,
  scope,
  onScopeChange,
  className,
}: NavPaneProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  return (
    <nav aria-label="Mail navigation" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-3">
        <h2 className="px-2 pb-1 font-medium text-muted-foreground">Views</h2>
        <ul className="flex flex-col gap-0.5">
          <NavLeaf
            icon={Inbox}
            label="Inbox"
            selected={scope.kind === "unified-inbox"}
            onSelect={() => onScopeChange({ kind: "unified-inbox" })}
          />
          <NavLeaf
            icon={Mail}
            label="All Mail"
            selected={scope.kind === "all-mail"}
            onSelect={() => onScopeChange({ kind: "all-mail" })}
          />
        </ul>

        <h2 className="px-2 pb-1 pt-5 font-medium text-muted-foreground">Accounts</h2>
        <ul className="flex flex-col gap-0.5">
          {foldersFailed ? (
            <li className="flex items-center gap-2 px-2 py-1 text-muted-foreground">
              <span className="truncate">Folders cannot be loaded.</span>
              <Button variant="ghost" size="sm" className="ms-auto" onClick={onRetryFolders}>
                Retry
              </Button>
            </li>
          ) : (
            accounts.map((account) => (
              <AccountSection
                key={account.id}
                account={account}
                folders={folders?.get(account.id) ?? null}
                scope={scope}
                collapsed={collapsed.has(account.id)}
                onToggle={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(account.id)) {
                      next.delete(account.id);
                    } else {
                      next.add(account.id);
                    }
                    return next;
                  })
                }
                onScopeChange={onScopeChange}
              />
            ))
          )}
        </ul>
      </div>
    </nav>
  );
}

function NavLeaf({
  icon: Icon,
  label,
  selected,
  onSelect,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={onSelect}
        className={cn(
          "flex h-control-md w-full items-center gap-2 rounded-md px-2 text-left",
          "transition-colors duration-feedback ease-out-quiet",
          selected ? "bg-selection font-medium" : "hover:bg-muted active:bg-muted/70",
        )}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}

function AccountSection({
  account,
  folders,
  scope,
  collapsed,
  onToggle,
  onScopeChange,
}: {
  account: AccountSummary;
  folders: FolderSummary[] | null;
  scope: MailScope;
  collapsed: boolean;
  onToggle: () => void;
  onScopeChange: (scope: MailScope) => void;
}) {
  const accountSelected =
    scope.kind === "account" && scope.accountId === account.id && scope.folderId === null;

  return (
    <li>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} folders of ${account.label}`}
          className={cn(
            "flex size-control-sm shrink-0 items-center justify-center rounded-md",
            "text-muted-foreground transition-colors duration-feedback ease-out-quiet",
            "hover:bg-muted hover:text-foreground",
          )}
        >
          {collapsed ? (
            <ChevronRight aria-hidden="true" className="size-3.5" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          aria-current={accountSelected ? "page" : undefined}
          onClick={() => onScopeChange({ kind: "account", accountId: account.id, folderId: null })}
          className={cn(
            "flex h-control-md min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left",
            "transition-colors duration-feedback ease-out-quiet",
            accountSelected ? "bg-selection font-medium" : "hover:bg-muted active:bg-muted/70",
          )}
        >
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
            style={{ backgroundColor: account.color }}
          />
          <span className="truncate">{account.label}</span>
        </button>
      </div>

      {!collapsed && (
        <ul className="mt-0.5 flex flex-col gap-0.5 ps-5">
          {folders === null ? (
            [0, 1, 2].map((line) => (
              <li key={line} className="px-2 py-1.5">
                <Skeleton className="h-4 w-3/4" />
              </li>
            ))
          ) : (
            orderFolders(folders).map((folder) => {
              const selected =
                scope.kind === "account" &&
                scope.accountId === account.id &&
                scope.folderId === folder.id;
              const Icon = folder.role === null ? Folder : ROLE_ICONS[folder.role];
              return (
                <li key={folder.id}>
                  <button
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    onClick={() =>
                      onScopeChange({
                        kind: "account",
                        accountId: account.id,
                        folderId: folder.id,
                      })
                    }
                    className={cn(
                      "flex h-control-md w-full items-center gap-2 rounded-md px-2 text-left",
                      "transition-colors duration-feedback ease-out-quiet",
                      selected ? "bg-selection font-medium" : "hover:bg-muted active:bg-muted/70",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{folder.name}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </li>
  );
}
