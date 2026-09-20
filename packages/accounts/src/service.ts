import { and, eq } from "drizzle-orm";
import {
  accounts,
  events,
  folders,
  type Account,
  type AccountIdentity,
  type Folder,
  type FolderRole,
  type SmtpSecurityMode,
} from "@mail-hub/database";
import type { MailHubDatabase } from "@mail-hub/database";
import type { RequiredFolderRole, RoleHintConflict } from "@mail-hub/contracts";
import type { MailHubTransaction, MutationGate } from "@mail-hub/recovery";
import { AccountError } from "./errors.ts";
import type { CredentialCipher } from "./crypto.ts";
import {
  folderKey,
  normalizeColor,
  normalizeDiscoveredFolders,
  normalizeIdentities,
  normalizeLabel,
  normalizePort,
  normalizeSmtpSecurity,
  normalizeHost,
  normalizeUsername,
  validatePassword,
} from "./validation.ts";

/**
 * Account and identity management (SPEC F1).
 *
 * One account is one mailbox: IMAP and SMTP settings plus a username and
 * password. The password is sealed with AES-256-GCM before it is stored and
 * never leaves this service except through `resolveCredentials`, which exists
 * for the sync and send workers. Folder discovery maps Inbox, Sent, and
 * Archive roles from server hints; missing or ambiguous destinations stay
 * unset until you choose them. Every mutation passes the recovery-generation
 * gate before it touches the database (SPEC section 7, step 1).
 */

/** Every role a folder can hold. */
const ALL_ROLES: FolderRole[] = ["inbox", "sent", "drafts", "archive", "trash", "junk"];

/** The roles folder-bound actions depend on (SPEC F1). */
const REQUIRED_ROLES: RequiredFolderRole[] = ["inbox", "sent", "archive"];

/** Context for one durable mutation: the generation the client captured. */
export interface MutationContext {
  requestGeneration?: string | null;
}

/** Input for one new account. Password stays plaintext only until sealing. */
export interface CreateAccountInput {
  label: string;
  color: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: string;
  username: string;
  password: string;
  identities?: { address: string; name?: string | null; isDefault: boolean }[];
  classifyEnabled?: boolean;
}

/** Editable account fields. Passwords and identities have their own paths. */
export interface UpdateAccountInput {
  label?: string;
  color?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: string;
  username?: string;
  classifyEnabled?: boolean;
}

/** One account as shown in settings. Password material never appears. */
export interface AccountSummary {
  id: string;
  label: string;
  color: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurityMode;
  username: string;
  identities: AccountIdentity[];
  classifyEnabled: boolean;
  createdAt: Date;
}

/** One folder as shown in settings. */
export interface FolderSummary {
  id: string;
  name: string;
  role: FolderRole | null;
}

/** The folders of one account, with the roles still needing a choice. */
export interface AccountFolders {
  folders: FolderSummary[];
  pendingRoleChoices: RequiredFolderRole[];
}

/** Result of importing one discovery run. */
export interface FolderImportResult {
  created: FolderSummary[];
  assignedRoles: Partial<Record<FolderRole, string>>;
  ambiguousRoles: FolderRole[];
  conflicts: RoleHintConflict[];
}

/** Connection settings and opened credentials for one account. Workers only. */
export interface ResolvedCredentials {
  accountId: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number; security: SmtpSecurityMode };
  username: string;
  password: string;
}

export class AccountService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly cipher: CredentialCipher,
    private readonly gate: MutationGate,
  ) {}

  /** List every account, oldest first. Never includes password material. */
  async listAccounts(): Promise<AccountSummary[]> {
    const rows = await this.db.select().from(accounts).orderBy(accounts.createdAt);
    return rows.map(toSummary);
  }

  /** Read one account. Rejects unknown identifiers. */
  async readAccount(accountId: string): Promise<AccountSummary> {
    return toSummary(await this.requireAccount(accountId));
  }

  /**
   * Open one account's credentials for the sync and send workers. This is the
   * only path that decrypts; no HTTP route reaches it.
   */
  async resolveCredentials(accountId: string): Promise<ResolvedCredentials> {
    const row = await this.requireAccount(accountId);
    return {
      accountId: row.id,
      imap: { host: row.imapHost, port: row.imapPort },
      smtp: { host: row.smtpHost, port: row.smtpPort, security: row.smtpSecurity },
      username: row.username,
      password: this.cipher.decrypt(row.passwordEnc),
    };
  }

  /** Create one account with its password sealed (SPEC F1). */
  async createAccount(context: MutationContext, input: CreateAccountInput): Promise<AccountSummary> {
    await this.gate.gateMutation(context.requestGeneration);
    const label = normalizeLabel(input.label);
    const color = normalizeColor(input.color);
    const imapHost = normalizeHost(input.imapHost ?? "imap.purelymail.com", "IMAP host");
    const imapPort = normalizePort(input.imapPort ?? 993, "IMAP port");
    const smtpHost = normalizeHost(input.smtpHost ?? "smtp.purelymail.com", "SMTP host");
    const smtpPort = normalizePort(input.smtpPort ?? 587, "SMTP port");
    const smtpSecurity = normalizeSmtpSecurity(input.smtpSecurity ?? "starttls_required");
    const username = normalizeUsername(input.username);
    const password = validatePassword(input.password);
    const identities = normalizeIdentities(input.identities ?? []);

    const passwordEnc = this.cipher.encrypt(password);
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(accounts)
        .values({
          label,
          color,
          imapHost,
          imapPort,
          smtpHost,
          smtpPort,
          smtpSecurity,
          username,
          passwordEnc,
          identities,
          classifyEnabled: input.classifyEnabled ?? true,
        })
        .returning();
      const row = inserted[0]!;
      await recordAccountEvent(tx, "account.created", row.id, {
        label,
        color,
        imapHost,
        imapPort,
        smtpHost,
        smtpPort,
        smtpSecurity,
        username,
        identityCount: identities.length,
      });
      return toSummary(row);
    });
  }

  /** Edit account labels, colors, connection settings, and the Jev toggle. */
  async updateAccount(
    context: MutationContext,
    accountId: string,
    input: UpdateAccountInput,
  ): Promise<AccountSummary> {
    await this.gate.gateMutation(context.requestGeneration);
    await this.requireAccount(accountId);
    const patch: Partial<typeof accounts.$inferInsert> = {};
    if (input.label !== undefined) {
      patch.label = normalizeLabel(input.label);
    }
    if (input.color !== undefined) {
      patch.color = normalizeColor(input.color);
    }
    if (input.imapHost !== undefined) {
      patch.imapHost = normalizeHost(input.imapHost, "IMAP host");
    }
    if (input.imapPort !== undefined) {
      patch.imapPort = normalizePort(input.imapPort, "IMAP port");
    }
    if (input.smtpHost !== undefined) {
      patch.smtpHost = normalizeHost(input.smtpHost, "SMTP host");
    }
    if (input.smtpPort !== undefined) {
      patch.smtpPort = normalizePort(input.smtpPort, "SMTP port");
    }
    if (input.smtpSecurity !== undefined) {
      patch.smtpSecurity = normalizeSmtpSecurity(input.smtpSecurity);
    }
    if (input.username !== undefined) {
      patch.username = normalizeUsername(input.username);
    }
    if (input.classifyEnabled !== undefined) {
      patch.classifyEnabled = input.classifyEnabled;
    }

    return this.db.transaction(async (tx) => {
      let row: Account | undefined;
      if (Object.keys(patch).length > 0) {
        const updated = await tx
          .update(accounts)
          .set(patch)
          .where(eq(accounts.id, accountId))
          .returning();
        row = updated[0];
        await recordAccountEvent(tx, "account.updated", accountId, {
          changed: Object.keys(patch),
        });
      } else {
        const rows = await tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
        row = rows[0];
      }
      return toSummary(row!);
    });
  }

  /** Replace the stored password. The previous envelope is simply superseded. */
  async updatePassword(context: MutationContext, accountId: string, password: string): Promise<void> {
    await this.gate.gateMutation(context.requestGeneration);
    const account = await this.requireAccount(accountId);
    const sealed = this.cipher.encrypt(validatePassword(password));
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(accounts)
        .set({ passwordEnc: sealed })
        .where(eq(accounts.id, accountId))
        .returning({ id: accounts.id });
      if (updated.length === 0) {
        throw new AccountError("not_found", "No account exists with this identifier.");
      }
      await recordAccountEvent(tx, "account.password_changed", accountId, { label: account.label });
    });
  }

  /** Replace the send-identity list. Exactly one identity must be the default. */
  async setIdentities(
    context: MutationContext,
    accountId: string,
    identities: { address: string; name?: string | null; isDefault: boolean }[],
  ): Promise<AccountSummary> {
    await this.gate.gateMutation(context.requestGeneration);
    await this.requireAccount(accountId);
    const normalized = normalizeIdentities(identities);
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(accounts)
        .set({ identities: normalized })
        .where(eq(accounts.id, accountId))
        .returning();
      const row = updated[0];
      if (row === undefined) {
        throw new AccountError("not_found", "No account exists with this identifier.");
      }
      await recordAccountEvent(tx, "account.identities_replaced", accountId, {
        count: normalized.length,
        defaultAddress: normalized.find((identity) => identity.isDefault)?.address ?? null,
      });
      return toSummary(row);
    });
  }

  /** List one account's folders with its role map. */
  async listFolders(accountId: string): Promise<AccountFolders> {
    await this.requireAccount(accountId);
    const rows = await this.selectFolders(this.db, accountId);
    return { folders: rows.map(toFolderSummary), pendingRoleChoices: pendingRoleChoices(rows) };
  }

  /**
   * Import one discovery run, such as the folder list a connection test
   * reports. New folders appear; unambiguous server hints fill empty roles.
   * A folder that hints at several roles keeps the first of them, because one
   * row holds one role. Ambiguous hints leave the role unset for a manual
   * choice, and a hint that disagrees with an existing assignment is
   * reported, not applied (SPEC F1). The reserved inbox name compares
   * without case (RFC 3501): a re-spelled inbox maps onto the stored row,
   * because every spelling names the one mailbox.
   */
  async importFolders(
    context: MutationContext,
    accountId: string,
    discovered: { name: string; specialUse?: string[] }[],
  ): Promise<FolderImportResult & AccountFolders> {
    await this.gate.gateMutation(context.requestGeneration);
    await this.requireAccount(accountId);
    const normalized = normalizeDiscoveredFolders(discovered);

    return this.db.transaction(async (tx) => {
      // Role assignments serialize on the account row, taken before any
      // folder row is read or inserted. Two concurrent imports — or an
      // import racing a manual assignment — cannot both fill one
      // still-empty role and hit the partial unique index with a raw 500.
      await lockAccountRow(tx, accountId);

      // The stored rows are read before the insert, so a discovery run that
      // spells the inbox differently than it was stored — "Inbox" after
      // "INBOX" — maps onto the row the account already holds instead of
      // inserting a second folder for the one mailbox.
      const stored = await this.selectFolders(tx, accountId);
      const storedByKey = new Map(stored.map((folder) => [folderKey(folder.name), folder]));
      const fresh: { accountId: string; name: string }[] = [];
      for (const folder of normalized) {
        const present = storedByKey.get(folderKey(folder.name));
        if (present === undefined) {
          fresh.push({ accountId, name: folder.name });
        } else {
          folder.name = present.name;
        }
      }

      // A connection test may report zero folders. An empty values() list is
      // a database error the client would see as a 500, so an empty run
      // imports nothing instead.
      const inserted =
        fresh.length === 0
          ? []
          : await tx
              .insert(folders)
              .values(fresh)
              .onConflictDoNothing()
              .returning();

      const current = await this.selectFolders(tx, accountId);
      const byName = new Map(current.map((folder) => [folder.name, folder]));
      const holders = new Map<FolderRole, Folder>();
      for (const folder of current) {
        if (folder.role !== null) {
          holders.set(folder.role, folder);
        }
      }

      const assignedRoles: Partial<Record<FolderRole, string>> = {};
      const ambiguousRoles: FolderRole[] = [];
      const conflicts: RoleHintConflict[] = [];

      for (const role of ALL_ROLES) {
        const candidates = normalized
          .filter((folder) => folder.roles.includes(role))
          .map((folder) => byName.get(folder.name))
          .filter((folder): folder is Folder => folder !== undefined)
          .filter((folder) => folder.role === null || folder.role === role);
        if (candidates.length === 0) {
          continue;
        }
        const holder = holders.get(role);
        if (candidates.length > 1) {
          ambiguousRoles.push(role);
          continue;
        }
        const candidate = candidates[0]!;
        if (holder === undefined) {
          await tx.update(folders).set({ role }).where(eq(folders.id, candidate.id));
          // The snapshot the later roles read must agree with the row. Without
          // this, one folder hinting at two roles reports both while the last
          // update alone reaches the row.
          candidate.role = role;
          holders.set(role, candidate);
          assignedRoles[role] = candidate.name;
        } else if (holder.id !== candidate.id) {
          conflicts.push({ role, current: holder.name, hinted: candidate.name });
        }
      }

      const finalFolders = await this.selectFolders(tx, accountId);
      await recordAccountEvent(tx, "account.folders_imported", accountId, {
        created: inserted.length,
        assignedRoles,
        ambiguousRoles,
        conflicts,
      });
      // `created` reads the final rows: the snapshot the INSERT returned
      // predates the role loop, so a folder this import just role-assigned
      // would report its role as null while `folders` reports it filled.
      const insertedIds = new Set(inserted.map((row) => row.id));
      return {
        created: finalFolders.filter((folder) => insertedIds.has(folder.id)).map(toFolderSummary),
        assignedRoles,
        ambiguousRoles,
        conflicts,
        folders: finalFolders.map(toFolderSummary),
        pendingRoleChoices: pendingRoleChoices(finalFolders),
      };
    });
  }

  /**
   * Assign one role manually. The explicit choice replaces the folder that
   * held the role, in the same transaction, so the one-role-per-account rule
   * always holds. The account row locks first, like every role write, so a
   * concurrent discovery import cannot interleave.
   */
  async assignFolderRole(
    context: MutationContext,
    accountId: string,
    folderId: string,
    role: FolderRole,
  ): Promise<FolderSummary> {
    await this.gate.gateMutation(context.requestGeneration);
    await this.requireAccount(accountId);
    return this.db.transaction(async (tx) => {
      await lockAccountRow(tx, accountId);
      const folder = await lockFolder(tx, accountId, folderId);
      if (folder.role === role) {
        return toFolderSummary(folder);
      }
      const cleared = await tx
        .update(folders)
        .set({ role: null })
        .where(and(eq(folders.accountId, accountId), eq(folders.role, role)))
        .returning({ name: folders.name });
      const updated = await tx
        .update(folders)
        .set({ role })
        .where(eq(folders.id, folder.id))
        .returning();
      await recordAccountEvent(tx, "account.folder_role_assigned", accountId, {
        role,
        folder: folder.name,
        replaced: cleared[0]?.name ?? null,
      });
      return toFolderSummary(updated[0]!);
    });
  }

  /** Remove one folder's role. The folder itself stays with its sync state. */
  async clearFolderRole(
    context: MutationContext,
    accountId: string,
    folderId: string,
  ): Promise<FolderSummary> {
    await this.gate.gateMutation(context.requestGeneration);
    await this.requireAccount(accountId);
    return this.db.transaction(async (tx) => {
      await lockAccountRow(tx, accountId);
      const folder = await lockFolder(tx, accountId, folderId);
      if (folder.role === null) {
        return toFolderSummary(folder);
      }
      const updated = await tx
        .update(folders)
        .set({ role: null })
        .where(eq(folders.id, folder.id))
        .returning();
      await recordAccountEvent(tx, "account.folder_role_cleared", accountId, {
        role: folder.role,
        folder: folder.name,
      });
      return toFolderSummary(updated[0]!);
    });
  }

  private async requireAccount(accountId: string): Promise<Account> {
    const rows = await this.db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new AccountError("not_found", "No account exists with this identifier.");
    }
    return row;
  }

  private async selectFolders(
    handle: MailHubDatabase | MailHubTransaction,
    accountId: string,
  ): Promise<Folder[]> {
    return handle.select().from(folders).where(eq(folders.accountId, accountId)).orderBy(folders.name);
  }
}

function toSummary(row: Account): AccountSummary {
  return {
    id: row.id,
    label: row.label,
    color: row.color,
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecurity: row.smtpSecurity,
    username: row.username,
    identities: row.identities,
    classifyEnabled: row.classifyEnabled,
    createdAt: row.createdAt,
  };
}

function toFolderSummary(row: Folder): FolderSummary {
  return { id: row.id, name: row.name, role: row.role };
}

/** Required roles no folder holds yet, in a stable order. */
function pendingRoleChoices(rows: Folder[]): RequiredFolderRole[] {
  const assigned = new Set(rows.filter((row) => row.role !== null).map((row) => row.role));
  return REQUIRED_ROLES.filter((role) => !assigned.has(role));
}

/**
 * Lock the account row for update. Every folder-role write takes this lock
 * first, so discovery imports and manual assignments serialize on the
 * account instead of racing the partial unique index on (account, role).
 */
async function lockAccountRow(tx: MailHubTransaction, accountId: string): Promise<void> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("update");
  if (rows.length === 0) {
    throw new AccountError("not_found", "No account exists with this identifier.");
  }
}

async function lockFolder(
  tx: MailHubTransaction,
  accountId: string,
  folderId: string,
): Promise<Folder> {
  const rows = await tx
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.accountId, accountId)))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new AccountError("not_found", "No folder of this account exists with that identifier.");
  }
  return row;
}

/** Record one account audit event. Payloads never contain passwords. */
async function recordAccountEvent(
  tx: MailHubTransaction,
  type: string,
  accountId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(events).values({ actor: "user", type, entityType: "account", entityId: accountId, payload });
}
