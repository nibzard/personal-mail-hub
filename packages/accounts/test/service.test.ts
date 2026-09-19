import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts as accountsTable,
  createDatabase,
  events,
  folders as foldersTable,
  runMigrations,
  type MailHubDatabase,
  dropTestDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";
import { AccountError, AccountService, createCredentialCipher, parseCredentialsKey } from "../src/index.ts";

/**
 * Account and identity management acceptance against a real PostgreSQL (SPEC
 * F1 and section 9). Set `TEST_DATABASE_URL` to a connection string whose user
 * may create databases; a throwaway database is created per run. Without the
 * variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";
const KEY_B64 = "3b731b7f1d7c4a2e9f0b5c8d2e6f4a197c8d5e3f2a1b4c6d8e0f3a5b7c9d1e64";

const readyContext = { requestGeneration: GENERATION };

/** Convert a rejected promise into its typed code or message fragment. */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string; name: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AccountError || error instanceof RecoveryBlockedError) {
      return { code: error.code, message: error.message, name: error.name };
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

suite("account and identity management", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let service: AccountService;
  let controls: RecoveryControls;
  let cipher: ReturnType<typeof createCredentialCipher>;

  beforeAll(async () => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    db = createDatabase(pool);

    controls = new RecoveryControls(db, { deploymentGeneration: GENERATION });
    const outcome = await controls.initialize();
    if (outcome.result !== "initialized") {
      throw new Error(`The test database could not be initialized: ${outcome.result}.`);
    }

    const key = parseCredentialsKey(KEY_B64);
    if (key === null) {
      throw new Error("The test key must parse.");
    }
    cipher = createCredentialCipher(key);
    service = new AccountService(db, cipher, controls);
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  it("creates an account with PurelyMail defaults and a sealed password", async () => {
    const account = await service.createAccount(readyContext, {
      label: "  Main mailbox  ",
      color: "#2563EB",
      username: " User@Example.COM ",
      password: "mailbox-secret",
      identities: [{ address: "user@example.com", name: " Main User ", isDefault: true }],
    });

    expect(account.label).toBe("Main mailbox");
    expect(account.color).toBe("#2563eb");
    expect(account.imapHost).toBe("imap.purelymail.com");
    expect(account.imapPort).toBe(993);
    expect(account.smtpHost).toBe("smtp.purelymail.com");
    expect(account.smtpPort).toBe(587);
    expect(account.smtpSecurity).toBe("starttls_required");
    // The login name keeps its case; only whitespace is trimmed.
    expect(account.username).toBe("User@Example.COM");
    expect(account.classifyEnabled).toBe(true);
    expect(account.identities).toEqual([{ address: "user@example.com", name: "Main User", isDefault: true }]);

    // The stored column holds an envelope, never the plaintext (SPEC section 9).
    const row = (await db.select().from(accountsTable).where(eq(accountsTable.id, account.id)))[0]!;
    expect(row.passwordEnc.startsWith("v1.")).toBe(true);
    expect(row.passwordEnc).not.toContain("mailbox-secret");

    const credentials = await service.resolveCredentials(account.id);
    expect(credentials).toEqual({
      accountId: account.id,
      imap: { host: "imap.purelymail.com", port: 993 },
      smtp: { host: "smtp.purelymail.com", port: 587, security: "starttls_required" },
      username: "User@Example.COM",
      password: "mailbox-secret",
    });
  });

  it("lists and reads accounts without password material", async () => {
    const listed = await service.listAccounts();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("passwordEnc");
    expect(listed[0]).not.toHaveProperty("password");

    const read = await service.readAccount(listed[0]!.id);
    expect(read.id).toBe(listed[0]!.id);
    await expect(rejection(service.readAccount(randomUUID()))).resolves.toMatchObject({ code: "not_found" });
  });

  it("rejects invalid account settings", async () => {
    const base = {
      label: "Second",
      color: "#111111",
      username: "second@example.com",
      password: "secret",
    };
    await expect(
      rejection(service.createAccount(readyContext, { ...base, label: "" })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.createAccount(readyContext, { ...base, color: "blue" })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.createAccount(readyContext, { ...base, imapHost: "bad host" })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.createAccount(readyContext, { ...base, smtpPort: 0 })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.createAccount(readyContext, { ...base, smtpSecurity: "plain" })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.createAccount(readyContext, { ...base, username: "  " })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.createAccount(readyContext, { ...base, password: "" })),
    ).resolves.toMatchObject({ code: "invalid_request" });
  });

  it("accepts custom hosts, ports, and implicit TLS for SMTP", async () => {
    const account = await service.createAccount(readyContext, {
      label: "Custom",
      color: "#001100",
      imapHost: "IMAP.Internal.example.",
      imapPort: 993,
      smtpHost: "10.0.0.4",
      smtpPort: 465,
      smtpSecurity: "implicit_tls",
      username: "custom@example.com",
      password: "secret",
    });
    expect(account.imapHost).toBe("imap.internal.example");
    expect(account.smtpHost).toBe("10.0.0.4");
    expect(account.smtpSecurity).toBe("implicit_tls");
  });

  it("edits labels, colors, hosts, and the classification toggle", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Main mailbox")!;
    const updated = await service.updateAccount(readyContext, account.id, {
      label: "Primary",
      color: "#7c3aed",
      imapPort: 993,
      classifyEnabled: false,
    });
    expect(updated.label).toBe("Primary");
    expect(updated.color).toBe("#7c3aed");
    expect(updated.classifyEnabled).toBe(false);
    expect(updated.username).toBe(account.username);

    await expect(
      rejection(service.updateAccount(readyContext, account.id, { color: "#12" })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.updateAccount(readyContext, randomUUID(), { label: "X" })),
    ).resolves.toMatchObject({ code: "not_found" });
  });

  it("replaces the password under a new envelope", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Primary")!;
    const before = (await db.select().from(accountsTable).where(eq(accountsTable.id, account.id)))[0]!.passwordEnc;
    await service.updatePassword(readyContext, account.id, "rotated-secret");
    const after = (await db.select().from(accountsTable).where(eq(accountsTable.id, account.id)))[0]!.passwordEnc;
    expect(after.startsWith("v1.")).toBe(true);
    expect(after).not.toBe(before);
    await expect(service.resolveCredentials(account.id)).resolves.toMatchObject({ password: "rotated-secret" });
  });

  it("validates identity lists", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Primary")!;
    const current = account.identities[0]!.address;

    await expect(
      rejection(service.setIdentities(readyContext, account.id, [{ address: "not-an-address", isDefault: true }])),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(
        service.setIdentities(readyContext, account.id, [
          { address: current, isDefault: true },
          { address: current, isDefault: false },
        ]),
      ),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(
        service.setIdentities(readyContext, account.id, [
          { address: "a@example.com", isDefault: true },
          { address: "b@example.com", isDefault: true },
        ]),
      ),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.setIdentities(readyContext, account.id, [{ address: "a@example.com", isDefault: false }])),
    ).resolves.toMatchObject({ code: "invalid_request" });

    // A non-empty list keeps exactly one default; an empty list clears all.
    const replaced = await service.setIdentities(readyContext, account.id, [
      { address: current, name: null, isDefault: false },
      { address: "alias@example.com", isDefault: true },
    ]);
    expect(replaced.identities.map((identity) => identity.address)).toEqual([current, "alias@example.com"]);
    expect(replaced.identities.filter((identity) => identity.isDefault)).toHaveLength(1);

    const cleared = await service.setIdentities(readyContext, account.id, []);
    expect(cleared.identities).toEqual([]);
  });

  it("imports discovery runs and maps roles from unambiguous hints", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Primary")!;
    const result = await service.importFolders(readyContext, account.id, [
      { name: "INBOX" },
      { name: "Sent", specialUse: ["\\Sent"] },
      { name: "Archive", specialUse: ["\\Archive"] },
      { name: "Bulk", specialUse: ["\\Junk"] },
      { name: "Personal", specialUse: [] },
    ]);

    expect(result.created.map((folder) => folder.name).sort()).toEqual(["Archive", "Bulk", "INBOX", "Personal", "Sent"]);
    expect(result.assignedRoles).toEqual({ archive: "Archive", inbox: "INBOX", junk: "Bulk", sent: "Sent" });
    expect(result.ambiguousRoles).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.pendingRoleChoices).toEqual([]);

    const roles = new Map(result.folders.map((folder) => [folder.name, folder.role]));
    expect(roles.get("INBOX")).toBe("inbox");
    expect(roles.get("Sent")).toBe("sent");
    expect(roles.get("Archive")).toBe("archive");
    expect(roles.get("Personal")).toBeNull();

    // A repeated run changes nothing and creates nothing.
    const again = await service.importFolders(readyContext, account.id, [
      { name: "INBOX" },
      { name: "Sent", specialUse: ["\\Sent"] },
      { name: "Archive", specialUse: ["\\Archive"] },
      { name: "Bulk", specialUse: ["\\Junk"] },
      { name: "Personal" },
    ]);
    expect(again.created).toEqual([]);
    expect(again.assignedRoles).toEqual({});
    expect(again.folders).toEqual(result.folders);
  });

  it("leaves ambiguous hints unset and reports conflicts with existing choices", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Primary")!;

    // Two folders claim the trash role: no automatic pick.
    const ambiguous = await service.importFolders(readyContext, account.id, [
      { name: "Trash", specialUse: ["\\Trash"] },
      { name: "Deleted", specialUse: ["\\Trash"] },
    ]);
    expect(ambiguous.ambiguousRoles).toEqual(["trash"]);
    expect(ambiguous.folders.find((folder) => folder.name === "Trash")!.role).toBeNull();
    expect(ambiguous.folders.find((folder) => folder.name === "Deleted")!.role).toBeNull();

    // A manual choice wins over a later disagreeing hint.
    const [chosen] = ambiguous.folders.filter((folder) => folder.name === "Trash");
    await service.assignFolderRole(readyContext, account.id, chosen!.id, "trash");
    const hinted = await service.importFolders(readyContext, account.id, [
      { name: "Deleted", specialUse: ["\\Trash"] },
    ]);
    expect(hinted.conflicts).toEqual([{ role: "trash", current: "Trash", hinted: "Deleted" }]);
    expect(hinted.folders.find((folder) => folder.name === "Trash")!.role).toBe("trash");
  });

  it("replaces a role holder when you assign the role manually", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Primary")!;
    const folders = (await service.listFolders(account.id)).folders;
    const sent = folders.find((folder) => folder.role === "sent")!;
    const personal = folders.find((folder) => folder.name === "Personal")!;

    const reassigned = await service.assignFolderRole(readyContext, account.id, personal.id, "sent");
    expect(reassigned).toMatchObject({ id: personal.id, role: "sent" });

    const after = await service.listFolders(account.id);
    expect(after.folders.find((folder) => folder.id === sent.id)!.role).toBeNull();
    expect(after.folders.find((folder) => folder.id === personal.id)!.role).toBe("sent");
    expect(after.pendingRoleChoices).toEqual([]);

    const cleared = await service.clearFolderRole(readyContext, account.id, personal.id);
    expect(cleared.role).toBeNull();
    const restored = await service.assignFolderRole(readyContext, account.id, sent.id, "sent");
    expect(restored.role).toBe("sent");
  });

  it("rejects folder operations that cross accounts or name unknown rows", async () => {
    const primary = (await service.listAccounts()).find((row) => row.label === "Primary")!;
    const other = (await service.listAccounts()).find((row) => row.label === "Custom")!;
    await service.importFolders(readyContext, other.id, [{ name: "INBOX" }]);
    const foreign = (await service.listFolders(other.id)).folders[0]!;

    await expect(
      rejection(service.assignFolderRole(readyContext, primary.id, foreign.id, "sent")),
    ).resolves.toMatchObject({ code: "not_found" });
    await expect(
      rejection(service.clearFolderRole(readyContext, primary.id, randomUUID())),
    ).resolves.toMatchObject({ code: "not_found" });
    await expect(
      rejection(service.importFolders(readyContext, randomUUID(), [])),
    ).resolves.toMatchObject({ code: "not_found" });
    await expect(
      rejection(service.importFolders(readyContext, primary.id, [
        { name: "Dup" },
        { name: "Dup" },
      ])),
    ).resolves.toMatchObject({ code: "invalid_request" });
  });

  it("keeps folder sync state when roles change", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Primary")!;
    const rows = await db
      .update(foldersTable)
      .set({ uidvalidity: 42, arrivalScannedUid: 42, backfillUpperUid: 42 })
      .where(eq(foldersTable.accountId, account.id))
      .returning();
    expect(rows.length).toBeGreaterThan(0);

    const folder = rows[0]!;
    await service.clearFolderRole(readyContext, account.id, folder.id);
    const kept = await db.select().from(foldersTable).where(eq(foldersTable.id, folder.id));
    expect(kept[0]).toMatchObject({
      uidvalidity: 42,
      arrivalScannedUid: 42,
      backfillUpperUid: 42,
    });
  });

  it("gates every mutation on the recovery generation", async () => {
    const account = (await service.listAccounts()).find((row) => row.label === "Primary")!;
    const input = { label: "Blocked", color: "#123456", username: "blocked@example.com", password: "secret" };

    // A missing or malformed generation never passes the gate.
    await expect(rejection(service.createAccount({ requestGeneration: undefined }, input))).resolves.toMatchObject({
      code: "invalid_recovery_generation",
    });
    // An old generation is rejected before anything is written.
    await expect(rejection(service.createAccount({ requestGeneration: OTHER_GENERATION }, input))).resolves.toMatchObject({
      code: "recovery_required",
    });
    await expect(
      rejection(service.updatePassword({ requestGeneration: OTHER_GENERATION }, account.id, "x")),
    ).resolves.toMatchObject({ code: "recovery_required" });
    await expect(
      rejection(service.setIdentities({ requestGeneration: OTHER_GENERATION }, account.id, [])),
    ).resolves.toMatchObject({ code: "recovery_required" });
    await expect(
      rejection(service.importFolders({ requestGeneration: OTHER_GENERATION }, account.id, [])),
    ).resolves.toMatchObject({ code: "recovery_required" });
    await expect(
      rejection(service.assignFolderRole({ requestGeneration: OTHER_GENERATION }, account.id, randomUUID(), "sent")),
    ).resolves.toMatchObject({ code: "recovery_required" });
    await expect((await service.listAccounts()).find((row) => row.label === "Blocked")).toBeUndefined();

    // While service is reconciling under a new generation, the mode blocks a
    // request that carries that same new generation (SPEC section 10).
    const recoveryControls = new RecoveryControls(db, { deploymentGeneration: OTHER_GENERATION });
    const began = await recoveryControls.beginRecovery();
    expect(began.result).toBe("started");
    const recoveryService = new AccountService(db, cipher, recoveryControls);
    await expect(
      rejection(recoveryService.createAccount({ requestGeneration: OTHER_GENERATION }, input)),
    ).resolves.toMatchObject({ code: "recovery_in_progress" });

    const completed = await recoveryControls.completeRecovery();
    expect(completed.result).toBe("completed");
    const created = await recoveryService.createAccount({ requestGeneration: OTHER_GENERATION }, input);
    expect(created.label).toBe("Blocked");
  });

  it("records audit events without secrets", async () => {
    const rows = await db.select().from(events).where(eq(events.entityType, "account")).orderBy(events.at);
    const types = rows.map((row) => row.type);
    expect(types).toContain("account.created");
    expect(types).toContain("account.updated");
    expect(types).toContain("account.password_changed");
    expect(types).toContain("account.identities_replaced");
    expect(types).toContain("account.folders_imported");
    expect(types).toContain("account.folder_role_assigned");
    expect(types).toContain("account.folder_role_cleared");
    for (const row of rows) {
      expect(JSON.stringify(row.payload)).not.toContain("mailbox-secret");
      expect(JSON.stringify(row.payload)).not.toContain("rotated-secret");
      expect(JSON.stringify(row.payload)).not.toContain("passwordEnc");
      expect(row.entityId).toBeDefined();
    }
  });
});
