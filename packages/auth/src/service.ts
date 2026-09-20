import { and, eq, isNull } from "drizzle-orm";
import {
  owner,
  ownerCredentials,
  ownerSessions,
  type OwnerCredential,
  type OwnerSessionKind,
} from "@mail-hub/database";
import type { MailHubDatabase } from "@mail-hub/database";
import type { MailHubTransaction } from "@mail-hub/recovery";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { AuthError } from "./errors.ts";
import {
  activeCredentials,
  consumeChallenge,
  consumeGrant,
  findLiveChallenge,
  findLiveGrant,
  isUuid,
  issueChallenge,
  lockOwner,
  readOwner,
  readSessionByToken,
  recordAuthEvent,
} from "./state.ts";
import { generateToken, hashToken } from "./tokens.ts";
import type { AuthConfig } from "./config.ts";
import type { AuthLoginAvailability } from "@mail-hub/contracts";
import type { ControlStatus } from "@mail-hub/recovery";

/**
 * Passkey authentication for the single owner (SPEC section 9).
 *
 * Enrollment runs through operator-issued grants. Login, verification
 * refresh, and credential management run on WebAuthn ceremonies whose
 * challenges are single-use and bound to one purpose, owner, and recovery
 * generation. Sessions are cookie tokens; only their hashes are stored.
 */

export interface SessionInfo {
  id: string;
  kind: OwnerSessionKind;
  verifiedAt: Date;
  expiresAt: Date;
}

export interface OpenedSession {
  token: string;
  session: SessionInfo;
}

export interface CredentialSummary {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface AuthPublicStatus {
  ownerRegistered: boolean;
  login: AuthLoginAvailability;
  control: ControlStatus["state"];
}

/** Anything that can read the recovery control state. */
export interface ControlStatusReader {
  readStatus(): Promise<ControlStatus>;
}

const CREDENTIAL_ID_CONSTRAINT = "owner_credentials_credential_id_unique";

export class PasskeyAuthService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly config: AuthConfig,
    private readonly controls: ControlStatusReader,
  ) {}

  /** Public status for the sign-in screen. Never includes secrets. */
  async readStatus(): Promise<AuthPublicStatus> {
    const ownerRow = await readOwner(this.db);
    const status = await this.controls.readStatus();
    const registered = ownerRow !== null;
    let login: AuthLoginAvailability = "blocked";
    if (registered && status.state === "ready") {
      login = "available";
    } else if (registered && status.state === "reconciling") {
      login = "inspection_only";
    }
    return { ownerRegistered: registered, login, control: status.state };
  }

  /**
   * Begin first-passkey or recovery enrollment. The grant decides which
   * ceremony this is; it is consumed only when registration completes.
   */
  async startEnrollment(grantToken: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const now = new Date();
    const grant = await findLiveGrant(this.db, hashToken(grantToken), now);
    const { purpose, ownerId, generation } = await this.enrollmentContext(grant.purpose);

    const existing = ownerId === null ? [] : await activeCredentials(this.db, ownerId);
    const options = await generateRegistrationOptions({
      rpName: "Personal mail hub",
      rpID: this.config.rpId,
      userName: "owner",
      userID: ownerId === null ? undefined : uuidToBytes(ownerId),
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports ?? undefined,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    await issueChallenge(this.db, {
      purpose,
      ownerId,
      challenge: options.challenge,
      recoveryGeneration: generation,
      ttlMs: this.config.challengeTtlMs,
      now,
    });
    return options;
  }

  /**
   * Complete enrollment: verify the WebAuthn response, then consume the
   * grant, create the owner when needed, store the credential, consume the
   * challenge, and open a session in one transaction. Concurrent attempts
   * cannot create a second owner or reuse the grant.
   */
  async completeEnrollment(input: {
    grantToken: string;
    label: string;
    response: RegistrationResponseJSON;
  }): Promise<OpenedSession> {
    const label = normalizeLabel(input.label);
    const now = new Date();
    const grant = await findLiveGrant(this.db, hashToken(input.grantToken), now);
    const { purpose, ownerId, generation, kind } = await this.enrollmentContext(grant.purpose);
    const challengeRow = await this.challengeForResponse(input.response, purpose, now);
    if (challengeRow.recoveryGeneration.toLowerCase() !== generation) {
      throw new AuthError(
        "challenge_invalid",
        "This sign-in request belongs to an earlier recovery history. Start again.",
      );
    }
    if (ownerId !== null && challengeRow.ownerId !== ownerId) {
      throw new AuthError("challenge_invalid", "This sign-in request belongs to another owner.");
    }

    const verification = await verifyWebauthn(() =>
      verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      }),
    );
    const info = verification.registrationInfo;
    if (info === undefined) {
      throw new AuthError("webauthn_invalid", "The passkey registration could not be verified.");
    }

    return this.db.transaction(async (tx) => {
      if (!(await consumeGrant(tx, grant.id))) {
        throw new AuthError(
          "grant_invalid",
          "This enrollment token was already used. Ask the operator for a new one.",
        );
      }

      let currentOwnerId = ownerId;
      if (currentOwnerId === null) {
        await tx.insert(owner).values({ singleton: true }).onConflictDoNothing();
        currentOwnerId = (await readOwner(tx))!.id;
      }

      let credentialRow: OwnerCredential;
      try {
        const inserted = await tx
          .insert(ownerCredentials)
          .values({
            ownerId: currentOwnerId,
            credentialId: info.credential.id,
            label,
            publicKey: bytesToBase64Url(info.credential.publicKey),
            counter: info.credential.counter,
            transports: info.credential.transports ?? null,
            deviceType: info.credentialDeviceType,
            backedUp: info.credentialBackedUp,
            lastUsedAt: now,
          })
          .returning();
        credentialRow = inserted[0]!;
      } catch (error) {
        if (constraintOf(error) === CREDENTIAL_ID_CONSTRAINT) {
          throw new AuthError("webauthn_invalid", "This passkey is already registered.");
        }
        throw error;
      }

      if (!(await consumeChallenge(tx, challengeRow.id))) {
        throw new AuthError(
          "challenge_invalid",
          "This sign-in request was already used. Start the operation again.",
        );
      }

      const opened = await insertSession(tx, currentOwnerId, generation, kind, now, this.config.sessionTtlMs);
      await recordAuthEvent(tx, "auth.enrollment.completed", {
        purpose: grant.purpose,
        credentialId: credentialRow.id,
        label,
        ownerId: currentOwnerId,
        sessionKind: kind,
      });
      return opened;
    });
  }

  /** Begin a login ceremony. Blocked while control state differs from deployment. */
  async startLogin(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { ownerId, generation } = await this.loginContext();
    const existing = await activeCredentials(this.db, ownerId);
    if (existing.length === 0) {
      throw new AuthError(
        "owner_missing",
        "No passkey is registered. Ask the operator to run 'auth recover'.",
      );
    }
    return this.startAssertionCeremony("login", ownerId, generation, new Date());
  }

  /**
   * Complete login: verify the assertion, consume the challenge, update the
   * credential, and open a session. A session opened while service is
   * reconciling is an inspection session (SPEC section 10).
   */
  async completeLogin(response: AuthenticationResponseJSON): Promise<OpenedSession> {
    const now = new Date();
    const { ownerId, generation, kind } = await this.loginContext();
    const { credential, challengeRow, authenticationInfo } = await this.verifyAssertion(
      response,
      "login",
      ownerId,
      now,
    );
    if (challengeRow.recoveryGeneration.toLowerCase() !== generation) {
      throw new AuthError("challenge_invalid", "This sign-in request is no longer valid. Start again.");
    }

    return this.db.transaction(async (tx) => {
      if (!(await consumeChallenge(tx, challengeRow.id))) {
        throw new AuthError(
          "challenge_invalid",
          "This sign-in request was already used. Start again.",
        );
      }
      await requireLiveCredential(tx, credential.id, authenticationInfo.newCounter);
      await updateCredentialAfterUse(tx, credential.id, authenticationInfo.newCounter, now);
      const opened = await insertSession(tx, ownerId, generation, kind, now, this.config.sessionTtlMs);
      await recordAuthEvent(tx, "auth.login", {
        credentialId: credential.id,
        sessionKind: kind,
      });
      return opened;
    });
  }

  /** Revoke one session (logout). */
  async revokeSession(token: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(ownerSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(ownerSessions.tokenHash, hashToken(token)), isNull(ownerSessions.revokedAt)))
        .returning({ id: ownerSessions.id });
      if (rows.length > 0) {
        await recordAuthEvent(tx, "auth.logout", { sessionId: rows[0]!.id });
      }
    });
  }

  /**
   * Resolve a session token. A session is valid only while it is unrevoked,
   * unexpired, bound to the control-status generation, and allowed by the
   * control mode: a service that is not reconciling or ready grants nothing,
   * and while it reconciles only inspection sessions stay open (SPEC section
   * 10). A restored database therefore fails every restored cookie, even
   * before `recovery begin` revokes it.
   */
  async verifySession(token: string): Promise<SessionInfo> {
    const row = await readSessionByToken(this.db, hashToken(token));
    if (row === null || row.revokedAt !== null || row.expiresAt.getTime() <= Date.now()) {
      throw new AuthError("unauthorized", "Sign in to continue.");
    }
    const status = await this.controls.readStatus();
    if (status.state !== "ready" && status.state !== "reconciling") {
      throw new AuthError(
        "unauthorized",
        "This service is recovering from a restore. Sign in again after recovery completes.",
      );
    }
    if (row.recoveryGeneration.toLowerCase() !== status.generation) {
      throw new AuthError("unauthorized", "This session belongs to an earlier recovery history.");
    }
    if (status.state === "reconciling" && row.kind !== "inspection") {
      throw new AuthError(
        "unauthorized",
        "This session predates the current recovery. Sign in again after recovery completes.",
      );
    }
    return {
      id: row.id,
      kind: row.kind,
      verifiedAt: row.verifiedAt,
      expiresAt: row.expiresAt,
    };
  }

  /** Begin a verification-refresh ceremony for an open session. */
  async startReverification(token: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const session = await this.verifySession(token);
    const now = new Date();
    const ownerId = await requireOwnerId(this.db, session);
    const generation = await this.controlGeneration();
    return this.startAssertionCeremony("reverify", ownerId, generation, now);
  }

  /**
   * Complete a verification refresh: the challenge must still belong to the
   * control-status generation, exactly like login. Updates the session's
   * verification time.
   */
  async completeReverification(token: string, response: AuthenticationResponseJSON): Promise<SessionInfo> {
    const session = await this.verifySession(token);
    const now = new Date();
    const ownerId = await requireOwnerId(this.db, session);
    const generation = await this.controlGeneration();
    const { credential, challengeRow, authenticationInfo } = await this.verifyAssertion(
      response,
      "reverify",
      ownerId,
      now,
    );
    if (challengeRow.recoveryGeneration.toLowerCase() !== generation) {
      throw new AuthError("challenge_invalid", "This verification request is no longer valid. Start again.");
    }
    return this.db.transaction(async (tx) => {
      if (!(await consumeChallenge(tx, challengeRow.id))) {
        throw new AuthError(
          "challenge_invalid",
          "This verification request was already used. Start again.",
        );
      }
      await requireLiveCredential(tx, credential.id, authenticationInfo.newCounter);
      await updateCredentialAfterUse(tx, credential.id, authenticationInfo.newCounter, now);
      const rows = await tx
        .update(ownerSessions)
        .set({ verifiedAt: now })
        .where(eq(ownerSessions.id, session.id))
        .returning();
      const updated = rows[0]!;
      await recordAuthEvent(tx, "auth.reverified", { credentialId: credential.id });
      return {
        id: updated.id,
        kind: updated.kind,
        verifiedAt: updated.verifiedAt,
        expiresAt: updated.expiresAt,
      };
    });
  }

  /** List passkeys with labels and last-use times (SPEC section 9). */
  async listCredentials(token: string): Promise<CredentialSummary[]> {
    const session = await this.verifySession(token);
    const ownerId = await requireOwnerId(this.db, session);
    return (await activeCredentials(this.db, ownerId)).map((credential) => ({
      id: credential.id,
      label: credential.label,
      createdAt: credential.createdAt,
      lastUsedAt: credential.lastUsedAt,
    }));
  }

  /** Begin adding a passkey. Requires verification within the last five minutes. */
  async startCredentialEnrollment(token: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const session = await this.verifySession(token);
    const ownerId = await requireOwnerId(this.db, session);
    await this.requireRecentVerification(session);
    const existing = await activeCredentials(this.db, ownerId);
    const options = await generateRegistrationOptions({
      rpName: "Personal mail hub",
      rpID: this.config.rpId,
      userName: "owner",
      userID: uuidToBytes(ownerId),
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports ?? undefined,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    const generation = await this.controlGeneration();
    await issueChallenge(this.db, {
      purpose: "add_credential",
      ownerId,
      challenge: options.challenge,
      recoveryGeneration: generation,
      ttlMs: this.config.challengeTtlMs,
      now: new Date(),
    });
    return options;
  }

  /**
   * Complete adding a passkey. Credential changes serialize on the owner
   * row lock, so concurrent changes cannot interleave.
   */
  async completeCredentialEnrollment(
    token: string,
    label: string,
    response: RegistrationResponseJSON,
  ): Promise<CredentialSummary> {
    const session = await this.verifySession(token);
    const normalized = normalizeLabel(label);
    const ownerId = await requireOwnerId(this.db, session);
    await this.requireRecentVerification(session);
    const now = new Date();
    const generation = await this.controlGeneration();
    const challengeRow = await this.challengeForResponse(response, "add_credential", now);
    if (challengeRow.ownerId !== ownerId) {
      throw new AuthError("challenge_invalid", "This request belongs to another owner.");
    }
    if (challengeRow.recoveryGeneration.toLowerCase() !== generation) {
      throw new AuthError("challenge_invalid", "This request is no longer valid. Start again.");
    }
    const verification = await verifyWebauthn(() =>
      verifyRegistrationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
      }),
    );
    const info = verification.registrationInfo;
    if (info === undefined) {
      throw new AuthError("webauthn_invalid", "The passkey registration could not be verified.");
    }

    return this.db.transaction(async (tx) => {
      await lockOwner(tx);
      if (!(await consumeChallenge(tx, challengeRow.id))) {
        throw new AuthError(
          "challenge_invalid",
          "This request was already used. Start again.",
        );
      }
      let credentialRow: OwnerCredential;
      try {
        const inserted = await tx
          .insert(ownerCredentials)
          .values({
            ownerId,
            credentialId: info.credential.id,
            label: normalized,
            publicKey: bytesToBase64Url(info.credential.publicKey),
            counter: info.credential.counter,
            transports: info.credential.transports ?? null,
            deviceType: info.credentialDeviceType,
            backedUp: info.credentialBackedUp,
            lastUsedAt: now,
          })
          .returning();
        credentialRow = inserted[0]!;
      } catch (error) {
        if (constraintOf(error) === CREDENTIAL_ID_CONSTRAINT) {
          throw new AuthError("webauthn_invalid", "This passkey is already registered.");
        }
        throw error;
      }
      await recordAuthEvent(tx, "auth.credential.added", {
        credentialId: credentialRow.id,
        label: normalized,
      });
      return {
        id: credentialRow.id,
        label: credentialRow.label,
        createdAt: credentialRow.createdAt,
        lastUsedAt: credentialRow.lastUsedAt,
      };
    });
  }

  /**
   * Remove a passkey. Requires recent verification and refuses to remove
   * the last active passkey. Concurrent removals serialize on the owner
   * row lock, so the last-credential rule holds inside the transaction.
   */
  async removeCredential(token: string, credentialId: string): Promise<void> {
    const session = await this.verifySession(token);
    const ownerId = await requireOwnerId(this.db, session);
    await this.requireRecentVerification(session);
    if (!isUuid(credentialId)) {
      throw new AuthError("invalid_request", "The passkey identifier is malformed.");
    }

    await this.db.transaction(async (tx) => {
      await lockOwner(tx);
      const rows = await tx
        .select()
        .from(ownerCredentials)
        .where(
          and(
            eq(ownerCredentials.id, credentialId),
            eq(ownerCredentials.ownerId, ownerId),
            isNull(ownerCredentials.revokedAt),
          ),
        )
        .for("update");
      const credential = rows[0];
      if (credential === undefined) {
        throw new AuthError("invalid_request", "This passkey is not registered.");
      }
      const remaining = await activeCredentials(tx, ownerId);
      if (remaining.length <= 1) {
        throw new AuthError(
          "last_credential",
          "At least one active passkey must remain. Add another passkey before removing this one.",
        );
      }
      await tx
        .update(ownerCredentials)
        .set({ revokedAt: new Date() })
        .where(eq(ownerCredentials.id, credential.id));
      await recordAuthEvent(tx, "auth.credential.removed", {
        credentialId: credential.id,
        label: credential.label,
        remaining: remaining.length - 1,
      });
    });
  }

  /**
   * Enrollment context for one grant purpose: the ceremony purpose, the
   * owner (null before the first passkey exists), the current generation,
   * and the session kind a completed enrollment opens.
   */
  private async enrollmentContext(grantPurpose: "bootstrap" | "recovery"): Promise<{
    purpose: "first_enrollment" | "recovery_enrollment";
    ownerId: string | null;
    generation: string;
    kind: OwnerSessionKind;
  }> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready" && status.state !== "reconciling") {
      throw new AuthError(
        "auth_unavailable",
        `Enrollment is unavailable while the recovery state is ${status.state}. Run 'recovery begin' after a restore.`,
      );
    }
    const ownerRow = await readOwner(this.db);
    if (grantPurpose === "bootstrap") {
      if (ownerRow !== null) {
        throw new AuthError(
          "grant_invalid",
          "This token only authorizes first-passkey registration, and an owner already exists.",
        );
      }
      return { purpose: "first_enrollment", ownerId: null, generation: status.generation, kind: sessionKindFor(status.state) };
    }
    if (ownerRow === null) {
      throw new AuthError(
        "grant_invalid",
        "This recovery token requires an existing owner. Use a bootstrap token on a fresh installation.",
      );
    }
    return { purpose: "recovery_enrollment", ownerId: ownerRow.id, generation: status.generation, kind: sessionKindFor(status.state) };
  }

  /** Login context: login is blocked unless deployment and database agree. */
  private async loginContext(): Promise<{
    ownerId: string;
    generation: string;
    kind: OwnerSessionKind;
  }> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready" && status.state !== "reconciling") {
      throw new AuthError(
        "login_blocked",
        "Sign-in is blocked while the recovery state is being repaired. Enrollment stays available.",
      );
    }
    const ownerRow = await readOwner(this.db);
    if (ownerRow === null) {
      throw new AuthError("owner_missing", "No owner is registered. Complete setup first.");
    }
    return { ownerId: ownerRow.id, generation: status.generation, kind: sessionKindFor(status.state) };
  }

  /**
   * The generation ceremonies bind their challenges to: the control-status
   * generation, which follows deployment configuration rather than the raw
   * database row (SPEC sections 9 and 10).
   */
  private async controlGeneration(): Promise<string> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready" && status.state !== "reconciling") {
      throw new AuthError(
        "auth_unavailable",
        `This operation is unavailable while the recovery state is ${status.state}. Run 'recovery begin' after a restore.`,
      );
    }
    return status.generation;
  }

  private async startAssertionCeremony(
    purpose: "login" | "reverify",
    ownerId: string,
    generation: string,
    now: Date,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const existing = await activeCredentials(this.db, ownerId);
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      allowCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports ?? undefined,
      })),
      userVerification: "required",
    });
    await issueChallenge(this.db, {
      purpose,
      ownerId,
      challenge: options.challenge,
      recoveryGeneration: generation,
      ttlMs: this.config.challengeTtlMs,
      now,
    });
    return options;
  }

  /** Shared assertion verification for login and reverification ceremonies. */
  private async verifyAssertion(
    response: AuthenticationResponseJSON,
    purpose: "login" | "reverify",
    ownerId: string,
    now: Date,
  ): Promise<{
    credential: OwnerCredential;
    challengeRow: { id: string; challenge: string; ownerId: string | null; recoveryGeneration: string };
    authenticationInfo: { newCounter: number };
  }> {
    const challengeRow = await this.challengeForResponse(response, purpose, now);
    if (challengeRow.ownerId !== ownerId) {
      throw new AuthError("challenge_invalid", "This request belongs to another owner.");
    }
    const credential = (
      await this.db
        .select()
        .from(ownerCredentials)
        .where(and(eq(ownerCredentials.credentialId, response.id), isNull(ownerCredentials.revokedAt)))
        .limit(1)
    )[0];
    if (credential === undefined || credential.ownerId !== ownerId) {
      throw new AuthError("webauthn_invalid", "This passkey is not registered.");
    }
    const verification = await verifyWebauthn(() =>
      verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: base64UrlToBytes(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports ?? undefined,
        },
      }),
    );
    return {
      credential,
      challengeRow,
      authenticationInfo: verification.authenticationInfo,
    };
  }

  /** Locate the live challenge a ceremony response answers. */
  private async challengeForResponse(
    response: { response: { clientDataJSON: string } },
    purpose: "first_enrollment" | "recovery_enrollment" | "add_credential" | "login" | "reverify",
    now: Date,
  ) {
    const clientData = parseClientData(response.response.clientDataJSON);
    return findLiveChallenge(this.db, { challenge: clientData.challenge, purpose, now });
  }

  /** Credential changes require a verification within the recent window. */
  private async requireRecentVerification(session: SessionInfo): Promise<void> {
    const age = Date.now() - session.verifiedAt.getTime();
    if (age < 0 || age > this.config.recentVerificationMs) {
      throw new AuthError(
        "verification_required",
        "Verify with a passkey before changing passkeys. The verification is valid for five minutes.",
      );
    }
  }
}

function sessionKindFor(state: ControlStatus["state"]): OwnerSessionKind {
  return state === "reconciling" ? "inspection" : "standard";
}

async function requireOwnerId(db: MailHubDatabase, session: SessionInfo): Promise<string> {
  const rows = await db
    .select({ ownerId: ownerSessions.ownerId })
    .from(ownerSessions)
    .where(eq(ownerSessions.id, session.id))
    .limit(1);
  const ownerId = rows[0]?.ownerId;
  if (ownerId === undefined) {
    throw new AuthError("unauthorized", "Sign in to continue.");
  }
  return ownerId;
}

async function insertSession(
  tx: MailHubTransaction,
  ownerId: string,
  generation: string,
  kind: OwnerSessionKind,
  now: Date,
  ttlMs: number,
): Promise<OpenedSession> {
  const token = generateToken();
  const rows = await tx
    .insert(ownerSessions)
    .values({
      ownerId,
      tokenHash: hashToken(token),
      recoveryGeneration: generation,
      kind,
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    })
    .returning();
  const row = rows[0]!;
  return {
    token,
    session: { id: row.id, kind: row.kind, verifiedAt: row.verifiedAt, expiresAt: row.expiresAt },
  };
}

async function updateCredentialAfterUse(
  tx: MailHubTransaction,
  credentialId: string,
  counter: number,
  now: Date,
): Promise<void> {
  await tx
    .update(ownerCredentials)
    .set({ counter, lastUsedAt: now })
    .where(eq(ownerCredentials.id, credentialId));
}

/**
 * Re-read the credential under the transaction lock before the ceremony
 * commits. The assertion was verified against a read taken before the
 * transaction opened, so a credential revoked in that window — a single
 * removal, or an emergency that revoked everything — must not open a
 * session afterward. The locked row also re-checks the assertion counter:
 * two ceremonies from a cloned passkey both pass clone detection against
 * the stale pre-transaction counter, so only the ceremony whose counter
 * advances past the locked row commits, and the stored counter never
 * regresses. Counterless authenticators report zero on both sides.
 */
async function requireLiveCredential(
  tx: MailHubTransaction,
  credentialId: string,
  newCounter: number,
): Promise<void> {
  const rows = await tx
    .select({
      id: ownerCredentials.id,
      revokedAt: ownerCredentials.revokedAt,
      counter: ownerCredentials.counter,
    })
    .from(ownerCredentials)
    .where(eq(ownerCredentials.id, credentialId))
    .for("update");
  const row = rows[0];
  if (row === undefined || row.revokedAt !== null) {
    throw new AuthError("webauthn_invalid", "This passkey is no longer registered. Start again.");
  }
  if ((newCounter > 0 || row.counter > 0) && newCounter <= row.counter) {
    throw new AuthError(
      "webauthn_invalid",
      "This passkey did not advance its counter and may be cloned. Start again with the original device.",
    );
  }
}

function parseClientData(clientDataJSON: string): { challenge: string } {
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    if (typeof parsed.challenge !== "string" || parsed.challenge === "") {
      throw new Error("missing challenge");
    }
    return { challenge: parsed.challenge };
  } catch {
    throw new AuthError(
      "challenge_invalid",
      "The passkey response is unreadable. Start the operation again.",
    );
  }
}

async function verifyWebauthn<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError(
      "webauthn_invalid",
      "The passkey response failed verification. Check the origin and try again.",
    );
  }
}

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new AuthError("invalid_request", "Give the passkey a label of up to 64 characters.");
  }
  return trimmed;
}

function constraintOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint?: string } }).cause;
  return cause?.constraint;
}

function uuidToBytes(value: string): Uint8Array<ArrayBuffer> {
  const hex = value.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, "base64url");
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}
