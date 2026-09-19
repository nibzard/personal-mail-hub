import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  events,
  owner,
  ownerCredentials,
  ownerSessions,
  runMigrations,
  webauthnChallenges,
  type MailHubDatabase,
  dropTestDatabase,
} from "@mail-hub/database";
import { RecoveryControls } from "@mail-hub/recovery";
import {
  ConsoleAuthService,
  PasskeyAuthService,
  createRecoveryHooks,
  parseAuthConfig,
  AuthError,
} from "../src/index.ts";
import type { AuthConfig } from "../src/config.ts";
import {
  createFakePasskey,
  fakeAuthenticationResponse,
  fakeRegistrationResponse,
  type FakePasskey,
} from "./fake-authenticator.ts";

/**
 * Passkey authentication acceptance against a real PostgreSQL (SPEC sections
 * 9 and 12). Set `TEST_DATABASE_URL` to a connection string whose user may
 * create databases; a throwaway database is created per run. Without the
 * variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";
const GENERATION_C = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "http://localhost:5173";
const RP_ID = "localhost";

/** Convert a rejected promise into its `AuthError` code. */
async function authCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

suite("passkey owner authentication", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let config: AuthConfig;
  let service: PasskeyAuthService;
  let consoleAuth: ConsoleAuthService;

  // Registered by the first enrollment; the login flow reuses it.
  let heldPasskey = createFakePasskey();
  // The second enrolled passkey, kept for login after a removal.
  let sparePasskey: FakePasskey | null = null;

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

    const parsed = parseAuthConfig({ baseUrl: ORIGIN });
    if (parsed === null) {
      throw new Error("The test origin must parse.");
    }
    config = parsed;
    const controls = new RecoveryControls(db, { deploymentGeneration: GENERATION_A });
    service = new PasskeyAuthService(db, config, controls);
    consoleAuth = new ConsoleAuthService(db, controls);
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  async function login(input: { passkey?: FakePasskey; origin?: string; rpId?: string; userVerified?: boolean } = {}) {
    const options = await service.startLogin();
    const response = fakeAuthenticationResponse({
      passkey: input.passkey ?? heldPasskey,
      options,
      rpId: input.rpId ?? RP_ID,
      origin: input.origin ?? ORIGIN,
      userVerified: input.userVerified,
    });
    // Completion stays a thunk so a test can change state first.
    return { options, response, complete: () => service.completeLogin(response) };
  }

  async function registerWith(grantToken: string, passkey: FakePasskey) {
    const options = await service.startEnrollment(grantToken);
    return fakeRegistrationResponse({ passkey, options, rpId: RP_ID, origin: ORIGIN });
  }

  it("refuses bootstrap enrollment on a populated database without control state", async () => {
    const inserted = await db
      .insert(accounts)
      .values({ label: "main", color: "#2563eb", username: "user@example.com", passwordEnc: "v1:ct" })
      .returning();
    await expect(authCode(consoleAuth.issueBootstrapGrant())).resolves.toBe("auth_unavailable");
    await db.delete(accounts).where(eq(accounts.id, inserted[0]!.id));
  });

  it("shows no owner and blocked login before setup", async () => {
    const status = await service.readStatus();
    expect(status).toMatchObject({ ownerRegistered: false, login: "blocked", control: "uninitialized" });
  });

  it("rejects invalid and expired enrollment tokens", async () => {
    await expect(authCode(service.startEnrollment("not-a-real-token-value"))).resolves.toBe("grant_invalid");

    const expired = await consoleAuth.issueBootstrapGrant();
    expect(expired.token.length).toBeGreaterThanOrEqual(40);
    await pool.query(
      "update enrollment_grants set expires_at = now() - interval '1 second' where consumed_at is null and revoked_at is null",
    );
    await expect(authCode(service.startEnrollment(expired.token))).resolves.toBe("grant_invalid");
  });

  it("registers the first passkey, closes setup, and opens a session", async () => {
    // Issuing a new grant invalidates the earlier grant for the same purpose.
    const grant = await consoleAuth.issueBootstrapGrant();
    const options = await service.startEnrollment(grant.token);
    expect(options.rp.id).toBe(RP_ID);
    expect(options.user.name).toBe("owner");

    const opened = await service.completeEnrollment({
      grantToken: grant.token,
      label: "MacBook",
      response: fakeRegistrationResponse({ passkey: heldPasskey, options, rpId: RP_ID, origin: ORIGIN }),
    });
    expect(opened.session.kind).toBe("standard");
    await expect(service.verifySession(opened.token)).resolves.toMatchObject({ kind: "standard" });

    // Exactly one owner, one credential, and the grant is consumed.
    expect(await db.select().from(owner)).toHaveLength(1);
    expect(await db.select().from(ownerCredentials)).toHaveLength(1);
    await expect(authCode(service.startEnrollment(grant.token))).resolves.toBe("grant_invalid");
    await expect(authCode(consoleAuth.issueBootstrapGrant())).resolves.toBe("owner_exists");

    const status = await service.readStatus();
    expect(status).toMatchObject({ ownerRegistered: true, login: "available", control: "ready" });
  });

  it("lets exactly one of two concurrent first registrations through", async () => {
    // Reset to a fresh installation for this race.
    await db.delete(ownerSessions);
    await db.delete(webauthnChallenges);
    await db.delete(ownerCredentials);
    await db.delete(owner);
    const grant = await consoleAuth.issueBootstrapGrant();

    const racers = [createFakePasskey(), createFakePasskey()];
    // Both ceremonies start before either completion begins, so the two
    // completion transactions race on the same live grant.
    const firstResponse = await registerWith(grant.token, racers[0]!);
    const secondResponse = await registerWith(grant.token, racers[1]!);
    const results = await Promise.allSettled([
      service.completeEnrollment({ grantToken: grant.token, label: "Race A", response: firstResponse }),
      service.completeEnrollment({ grantToken: grant.token, label: "Race B", response: secondResponse }),
    ]);
    const codes = results.map((result) =>
      result.status === "fulfilled" ? "fulfilled" : ((result.reason as AuthError).code ?? String(result.reason)),
    );
    expect(codes.filter((code) => code === "fulfilled")).toHaveLength(1);
    expect(codes.filter((code) => code === "grant_invalid")).toHaveLength(1);

    expect(await db.select().from(owner)).toHaveLength(1);
    const credentials = await db.select().from(ownerCredentials);
    expect(credentials).toHaveLength(1);
    heldPasskey = credentials[0]!.label === "Race A" ? racers[0]! : racers[1]!;
  });

  it("signs in with the registered passkey and records the use", async () => {
    const attempt = await login();
    const opened = await attempt.complete();
    expect(opened.session.kind).toBe("standard");

    const credentials = await db.select().from(ownerCredentials);
    expect(credentials[0]!.lastUsedAt).not.toBeNull();
    expect(credentials[0]!.counter).toBeGreaterThan(0);

    // The challenge is single-use.
    await expect(authCode(service.completeLogin(attempt.response))).resolves.toBe("challenge_invalid");
  });

  it("rejects login ceremonies from the wrong origin or relying party", async () => {
    await expect(authCode((await login({ origin: "https://attacker.example" })).complete())).resolves.toBe(
      "webauthn_invalid",
    );
    await expect(authCode((await login({ rpId: "attacker.example" })).complete())).resolves.toBe(
      "webauthn_invalid",
    );
    await expect(authCode((await login({ userVerified: false })).complete())).resolves.toBe("webauthn_invalid");
  });

  it("expires unused challenges after five minutes", async () => {
    const attempt = await login();
    await db
      .update(webauthnChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(webauthnChallenges.challenge, attempt.options.challenge));
    await expect(authCode(attempt.complete())).resolves.toBe("challenge_invalid");
  });

  it("lists credentials and protects the last active passkey", async () => {
    const opened = await (await login()).complete();
    const credentials = await service.listCredentials(opened.token);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.label).toBeTypeOf("string");

    await expect(authCode(service.removeCredential(opened.token, credentials[0]!.id))).resolves.toBe(
      "last_credential",
    );
  });

  it("adds a second passkey while verification is recent", async () => {
    const opened = await (await login()).complete();

    const second = createFakePasskey();
    const options = await service.startCredentialEnrollment(opened.token);
    const added = await service.completeCredentialEnrollment(
      opened.token,
      "iPhone",
      fakeRegistrationResponse({ passkey: second, options, rpId: RP_ID, origin: ORIGIN }),
    );
    expect(added.label).toBe("iPhone");
    expect(await service.listCredentials(opened.token)).toHaveLength(2);
    sparePasskey = second;
  });

  it("requires recent verification for credential changes", async () => {
    const opened = await (await login()).complete();
    await db
      .update(ownerSessions)
      .set({ verifiedAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(ownerSessions.id, opened.session.id));

    await expect(authCode(service.startCredentialEnrollment(opened.token))).resolves.toBe(
      "verification_required",
    );

    // A fresh ceremony restores the recent-verification window.
    const verifyOptions = await service.startReverification(opened.token);
    const refreshed = await service.completeReverification(
      opened.token,
      fakeAuthenticationResponse({
        passkey: heldPasskey,
        options: verifyOptions,
        rpId: RP_ID,
        origin: ORIGIN,
      }),
    );
    expect(refreshed.verifiedAt.getTime()).toBeGreaterThan(Date.now() - 5000);
    await expect(service.startCredentialEnrollment(opened.token)).resolves.toBeDefined();
  });

  it("holds the last-credential rule under concurrent removals", async () => {
    const opened = await (await login()).complete();
    const credentials = await service.listCredentials(opened.token);
    expect(credentials).toHaveLength(2);

    const results = await Promise.allSettled([
      service.removeCredential(opened.token, credentials[0]!.id),
      service.removeCredential(opened.token, credentials[1]!.id),
    ]);
    const codes = results.map((result) =>
      result.status === "fulfilled" ? "fulfilled" : (result.reason as AuthError).code,
    );
    expect(codes.filter((code) => code === "fulfilled")).toHaveLength(1);
    expect(codes).toContain("last_credential");
    const remaining = (await service.listCredentials(opened.token))[0]!;
    expect(remaining).toBeDefined();
    // Keep signing in with whichever passkey survived the removals.
    if (remaining.label === "iPhone" && sparePasskey !== null) {
      heldPasskey = sparePasskey;
    }
  });

  it("revokes a session on logout", async () => {
    const opened = await (await login()).complete();
    await service.revokeSession(opened.token);
    await expect(authCode(service.verifySession(opened.token))).resolves.toBe("unauthorized");
  });

  it("rejects expired sessions", async () => {
    const opened = await (await login()).complete();
    await db
      .update(ownerSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(ownerSessions.id, opened.session.id));
    await expect(authCode(service.verifySession(opened.token))).resolves.toBe("unauthorized");
  });

  it("blocks login while the recovery state differs from deployment", async () => {
    const mismatched = new PasskeyAuthService(
      db,
      config,
      new RecoveryControls(db, { deploymentGeneration: GENERATION_C }),
    );
    expect((await mismatched.readStatus()).login).toBe("blocked");
    await expect(authCode(mismatched.startLogin())).resolves.toBe("login_blocked");
  });

  it("recovers access after all passkeys are lost", async () => {
    // An open session and credential exist before recovery begins.
    const oldSession = await (await login()).complete();

    const controls = new RecoveryControls(db, {
      deploymentGeneration: GENERATION_B,
      hooks: createRecoveryHooks(),
    });
    const recovering = new PasskeyAuthService(db, config, controls);
    const recoveringConsole = new ConsoleAuthService(db, controls);
    await expect(controls.beginRecovery()).resolves.toMatchObject({ result: "started" });

    // The restore revokes the old session and credential; login has nothing
    // left to verify, so the owner must use a recovery grant.
    await expect(authCode(service.verifySession(oldSession.token))).resolves.toBe("unauthorized");
    await expect(authCode(recovering.startLogin())).resolves.toBe("owner_missing");

    expect((await recovering.readStatus()).login).toBe("inspection_only");

    const grant = await recoveringConsole.issueRecoveryGrant();
    const replacement = createFakePasskey();
    const options = await recovering.startEnrollment(grant.token);
    expect(options.user.id).toBeTypeOf("string");
    const opened = await recovering.completeEnrollment({
      grantToken: grant.token,
      label: "Replacement key",
      response: fakeRegistrationResponse({ passkey: replacement, options, rpId: RP_ID, origin: ORIGIN }),
    });
    expect(opened.session.kind).toBe("inspection");

    heldPasskey = replacement;
    const relinked = await recovering.startLogin().then((loginOptions) =>
      recovering.completeLogin(
        fakeAuthenticationResponse({ passkey: replacement, options: loginOptions, rpId: RP_ID, origin: ORIGIN }),
      ),
    );
    expect(relinked.session.kind).toBe("inspection");

    // The owner identifier survived recovery.
    expect(await db.select().from(owner)).toHaveLength(1);

    // Recovery completes only with a registered owner credential.
    await expect(controls.completeRecovery()).resolves.toMatchObject({ result: "completed" });
    const after = await recovering.startLogin().then((loginOptions) =>
      recovering.completeLogin(
        fakeAuthenticationResponse({ passkey: replacement, options: loginOptions, rpId: RP_ID, origin: ORIGIN }),
      ),
    );
    expect(after.session.kind).toBe("standard");

    // The operator moves the deployment to the new generation from here on.
    service = recovering;
    consoleAuth = recoveringConsole;
  });

  it("keeps only one live recovery grant at a time", async () => {
    const first = await consoleAuth.issueRecoveryGrant();
    const second = await consoleAuth.issueRecoveryGrant();
    expect(second.token).not.toBe(first.token);
    await expect(authCode(service.startEnrollment(first.token))).resolves.toBe("grant_invalid");

    // The live grant still authorizes replacement registration.
    const spare = createFakePasskey();
    const options = await service.startEnrollment(second.token);
    const opened = await service.completeEnrollment({
      grantToken: second.token,
      label: "Spare key",
      response: fakeRegistrationResponse({ passkey: spare, options, rpId: RP_ID, origin: ORIGIN }),
    });
    expect(opened.session.kind).toBe("standard");
    heldPasskey = spare;
  });

  it("records authentication events without secrets", async () => {
    const rows = await db.select().from(events).where(like(events.type, "auth.%"));
    const types = rows.map((row) => row.type);
    expect(types).toContain("auth.bootstrap_grant");
    expect(types).toContain("auth.enrollment.completed");
    expect(types).toContain("auth.login");
    expect(types).toContain("auth.credential.added");
    expect(types).toContain("auth.credential.removed");
    expect(types).toContain("auth.recovery_grant");
    expect(types).toContain("auth.revoked_on_recovery");

    const serialized = JSON.stringify(rows);
    const credentials = await db.select().from(ownerCredentials);
    for (const credential of credentials) {
      expect(serialized).not.toContain(credential.credentialId);
      expect(serialized).not.toContain(credential.publicKey);
    }
  });
});
