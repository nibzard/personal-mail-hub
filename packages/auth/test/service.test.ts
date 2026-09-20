import { randomUUID } from "node:crypto";
import { and, eq, isNull, like } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  enrollmentGrants,
  events,
  owner,
  ownerCredentials,
  ownerSessions,
  runMigrations,
  serviceState,
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
import { CHALLENGE_LIVE_CAP } from "../src/state.ts";
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

/**
 * A database proxy that replays one mid-ceremony race deterministically: the
 * moment the Nth awaited read of one table resolves, the interleave runs
 * before the rows reach the ceremony. The service under test sees the
 * pre-interleave rows outside its transaction and the post-interleave state
 * inside it, exactly like a revocation committing between the two.
 */
function raceAfterTableRead(
  db: MailHubDatabase,
  table: object,
  interleave: () => Promise<void>,
  onRead = 1,
): MailHubDatabase {
  let reads = 0;
  const wrapBuilder = (builder: object, watched: boolean): object =>
    new Proxy(builder, {
      get(target, prop) {
        if (prop === "then") {
          const original = (target as { then: PromiseLike<unknown>["then"] }).then.bind(target);
          if (!watched || reads >= onRead) {
            return original;
          }
          return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            original(async (rows: unknown) => {
              reads += 1;
              if (reads === onRead) {
                await interleave();
              }
              return rows;
            }).then(onFulfilled, onRejected);
        }
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) =>
          wrapBuilder(
            (value as (...a: unknown[]) => object).apply(target, args),
            watched || (prop === "from" && args[0] === table),
          );
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      const bound = (value as (...a: unknown[]) => unknown).bind(target);
      if (prop === "select") {
        return (...args: unknown[]) => wrapBuilder(bound(...args) as object, false);
      }
      return bound;
    },
  }) as MailHubDatabase;
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

  it("answers every concurrent bootstrap cleanly and leaves one live grant", async () => {
    // Reset to a fresh installation for this race; the next test re-registers
    // its own owner anyway.
    await db.delete(ownerSessions);
    await db.delete(webauthnChallenges);
    await db.delete(ownerCredentials);
    await db.delete(owner);

    // Without serialization, the racers revoke past each other and the
    // later inserts hit the one-live-grant index as raw database errors.
    // The issue lock serializes them: every command answers with a token,
    // and only the last grant stays live.
    const issued = await Promise.all([
      consoleAuth.issueBootstrapGrant(),
      consoleAuth.issueBootstrapGrant(),
      consoleAuth.issueBootstrapGrant(),
      consoleAuth.issueBootstrapGrant(),
    ]);
    const live = await pool.query(
      "select id from enrollment_grants where purpose = 'bootstrap' and revoked_at is null and consumed_at is null and expires_at > now()",
    );
    expect(live.rows).toHaveLength(1);
    expect(issued.map((grant) => grant.id)).toContain(live.rows[0].id);
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

  it("caps scripted challenge issuance and deletes expired challenges", async () => {
    // A known slate: earlier ceremonies leave live rows behind.
    await db.delete(webauthnChallenges);

    // One expired row: the next issuance must delete it, not keep it.
    const ownerId = (await db.select().from(owner).limit(1))[0]!.id;
    await db.insert(webauthnChallenges).values({
      purpose: "login",
      ownerId,
      challenge: "expired-challenge",
      recoveryGeneration: GENERATION_A,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      expiresAt: new Date(Date.now() - 1000),
    });

    let issued = 0;
    let rateLimited = false;
    for (let attempt = 0; attempt < CHALLENGE_LIVE_CAP + 1 && rateLimited === false; attempt += 1) {
      try {
        await service.startLogin();
        issued += 1;
      } catch (error) {
        // A script hammering the start endpoint stops at the cap instead
        // of growing the table without bound.
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).code).toBe("challenge_rate_limited");
        expect((error as AuthError).httpStatus).toBe(429);
        rateLimited = true;
      }
    }
    expect(rateLimited).toBe(true);
    expect(issued).toBe(CHALLENGE_LIVE_CAP);

    // The table holds the live rows only; the expired one is gone.
    const rows = await db.select().from(webauthnChallenges);
    expect(rows).toHaveLength(CHALLENGE_LIVE_CAP);
    expect(rows.filter((row) => row.challenge === "expired-challenge")).toHaveLength(0);

    // Later ceremonies issue again.
    await db.delete(webauthnChallenges);
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

  it("rejects a reverification challenge from another recovery history", async () => {
    const opened = await (await login()).complete();
    const options = await service.startReverification(opened.token);
    // The challenge left the current generation behind, exactly as a restore
    // would leave one behind.
    await db
      .update(webauthnChallenges)
      .set({ recoveryGeneration: GENERATION_C })
      .where(eq(webauthnChallenges.challenge, options.challenge));
    const stale = fakeAuthenticationResponse({
      passkey: heldPasskey,
      options,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    await expect(authCode(service.completeReverification(opened.token, stale))).resolves.toBe(
      "challenge_invalid",
    );
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
    const opened = await (await login()).complete();
    const mismatched = new PasskeyAuthService(
      db,
      config,
      new RecoveryControls(db, { deploymentGeneration: GENERATION_C }),
    );
    expect((await mismatched.readStatus()).login).toBe("blocked");
    await expect(authCode(mismatched.startLogin())).resolves.toBe("login_blocked");
    // A restored session grants nothing while deployment and database
    // disagree, even before `recovery begin` revokes it (SPEC section 10).
    await expect(authCode(mismatched.verifySession(opened.token))).resolves.toBe("unauthorized");

    // While the service reconciles, only inspection sessions stay open: the
    // standard session fails even though its generation matches.
    await db.update(serviceState).set({ recoveryMode: "reconciling" });
    await expect(authCode(service.verifySession(opened.token))).resolves.toBe("unauthorized");
    await db.update(serviceState).set({ recoveryMode: "ready" });
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

  /** Controls that match whatever generation the suite currently holds. */
  async function controlsForCurrentGeneration() {
    const state = (await db.select().from(serviceState).limit(1))[0]!;
    return new RecoveryControls(db, { deploymentGeneration: state.recoveryGeneration });
  }

  /** Count the sessions nothing has revoked. */
  async function liveSessionCount(): Promise<number> {
    const rows = await db.select().from(ownerSessions).where(isNull(ownerSessions.revokedAt));
    return rows.length;
  }

  it("rejects a login whose challenge was revoked mid-ceremony", async () => {
    const before = await liveSessionCount();
    const attempt = await login();

    const raced = raceAfterTableRead(db, webauthnChallenges, async () => {
      await db
        .update(webauthnChallenges)
        .set({ revokedAt: new Date() })
        .where(and(isNull(webauthnChallenges.revokedAt), isNull(webauthnChallenges.consumedAt)));
    });
    const racing = new PasskeyAuthService(raced, config, await controlsForCurrentGeneration());
    await expect(authCode(racing.completeLogin(attempt.response))).resolves.toBe("challenge_invalid");
    expect(await liveSessionCount()).toBe(before);
  });

  it("rejects a login whose credential was revoked mid-ceremony", async () => {
    // A second passkey must remain, so one credential can be revoked alone.
    const opened = await (await login()).complete();
    const spare = createFakePasskey();
    const options = await service.startCredentialEnrollment(opened.token);
    await service.completeCredentialEnrollment(
      opened.token,
      "Race spare",
      fakeRegistrationResponse({ passkey: spare, options, rpId: RP_ID, origin: ORIGIN }),
    );

    const before = await liveSessionCount();
    const attempt = await login();
    const raced = raceAfterTableRead(db, ownerCredentials, async () => {
      await db
        .update(ownerCredentials)
        .set({ revokedAt: new Date() })
        .where(eq(ownerCredentials.credentialId, heldPasskey.credentialId));
    });
    const racing = new PasskeyAuthService(raced, config, await controlsForCurrentGeneration());
    await expect(authCode(racing.completeLogin(attempt.response))).resolves.toBe("webauthn_invalid");
    expect(await liveSessionCount()).toBe(before);
  });

  it("rejects an enrollment whose grant was revoked mid-ceremony", async () => {
    const grant = await consoleAuth.issueRecoveryGrant();
    const replacement = createFakePasskey();
    const options = await service.startEnrollment(grant.token);

    const raced = raceAfterTableRead(db, enrollmentGrants, async () => {
      await db
        .update(enrollmentGrants)
        .set({ revokedAt: new Date() })
        .where(and(isNull(enrollmentGrants.revokedAt), isNull(enrollmentGrants.consumedAt)));
    });
    const racing = new PasskeyAuthService(raced, config, await controlsForCurrentGeneration());
    await expect(
      authCode(
        racing.completeEnrollment({
          grantToken: grant.token,
          label: "Race key",
          response: fakeRegistrationResponse({
            passkey: replacement,
            options,
            rpId: RP_ID,
            origin: ORIGIN,
          }),
        }),
      ),
    ).resolves.toBe("grant_invalid");

    const active = await db.select().from(ownerCredentials).where(isNull(ownerCredentials.revokedAt));
    expect(active.every((row) => row.label !== "Race key")).toBe(true);
  });
});
