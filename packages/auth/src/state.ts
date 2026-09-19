import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  enrollmentGrants,
  events,
  owner,
  ownerCredentials,
  ownerSessions,
  webauthnChallenges,
  type ChallengePurpose,
  type EnrollmentGrant,
  type Owner,
  type OwnerCredential,
  type OwnerSession,
  type WebauthnChallenge,
} from "@mail-hub/database";
import type { MailHubTransaction } from "@mail-hub/recovery";
import type { MailHubDatabase } from "@mail-hub/database";
import { AuthError } from "./errors.ts";

/**
 * Database operations shared by the console commands and the passkey
 * service. Every query here works inside an open transaction so grant
 * consumption, credential changes, and events commit atomically.
 */

/** A database or transaction handle. */
export type DbHandle = MailHubDatabase | MailHubTransaction;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read the single owner row, if one exists. */
export async function readOwner(db: DbHandle): Promise<Owner | null> {
  const rows = await db.select().from(owner).limit(1);
  return rows[0] ?? null;
}

/**
 * Lock the owner row for update. Credential changes serialize on this lock,
 * so concurrent additions and removals cannot interleave (SPEC section 9).
 */
export async function lockOwner(tx: MailHubTransaction): Promise<Owner> {
  const rows = await tx.select().from(owner).where(eq(owner.singleton, true)).for("update");
  const row = rows[0];
  if (row === undefined) {
    throw new AuthError("owner_missing", "No owner is registered.");
  }
  return row;
}

/** Active credentials of the owner, newest first. */
export async function activeCredentials(db: DbHandle, ownerId: string): Promise<OwnerCredential[]> {
  return db
    .select()
    .from(ownerCredentials)
    .where(and(eq(ownerCredentials.ownerId, ownerId), isNull(ownerCredentials.revokedAt)))
    .orderBy(ownerCredentials.createdAt);
}

/**
 * Live challenges one purpose and owner may hold at once. A script that
 * hammers a start endpoint stops here instead of growing the table; a
 * person starting ceremonies one at a time never approaches the cap.
 */
export const CHALLENGE_LIVE_CAP = 32;

/**
 * Issue one WebAuthn challenge bound to its purpose, owner, and generation.
 * Expired rows are deleted first, so cleanup runs as often as issuance and
 * the table stays bounded; a purpose at its live cap refuses to grow.
 */
export async function issueChallenge(
  db: DbHandle,
  input: { purpose: ChallengePurpose; ownerId: string | null; challenge: string; recoveryGeneration: string; ttlMs: number; now: Date },
): Promise<WebauthnChallenge> {
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, input.now));

  const ownerFilter =
    input.ownerId === null
      ? isNull(webauthnChallenges.ownerId)
      : eq(webauthnChallenges.ownerId, input.ownerId);
  const live = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.purpose, input.purpose),
        ownerFilter,
        isNull(webauthnChallenges.consumedAt),
        isNull(webauthnChallenges.revokedAt),
        gt(webauthnChallenges.expiresAt, input.now),
      ),
    );
  if ((live[0]?.value ?? 0) >= CHALLENGE_LIVE_CAP) {
    throw new AuthError(
      "challenge_rate_limited",
      "Too many sign-in requests are waiting. Wait a moment, then start again.",
    );
  }

  const rows = await db
    .insert(webauthnChallenges)
    .values({
      purpose: input.purpose,
      ownerId: input.ownerId,
      challenge: input.challenge,
      recoveryGeneration: input.recoveryGeneration,
      expiresAt: new Date(input.now.getTime() + input.ttlMs),
    })
    .returning();
  return rows[0]!;
}

/**
 * Load the live challenge a ceremony response answers. The challenge comes
 * from the response's client data, so this lookup also proves the response
 * belongs to a challenge this server issued. Consumption happens later, in
 * the transaction that commits the ceremony result.
 */
export async function findLiveChallenge(
  db: DbHandle,
  input: { challenge: string; purpose: ChallengePurpose; now: Date },
): Promise<WebauthnChallenge> {
  const rows = await db
    .select()
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.challenge, input.challenge),
        eq(webauthnChallenges.purpose, input.purpose),
        isNull(webauthnChallenges.consumedAt),
        isNull(webauthnChallenges.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new AuthError(
      "challenge_invalid",
      "This sign-in request is no longer valid. Start the operation again.",
    );
  }
  if (row.expiresAt.getTime() <= input.now.getTime()) {
    throw new AuthError(
      "challenge_invalid",
      "This sign-in request expired. Challenges are valid for five minutes.",
    );
  }
  return row;
}

/**
 * Consume a challenge exactly once. Returns false when another request
 * already consumed it.
 */
export async function consumeChallenge(
  tx: MailHubTransaction,
  challengeId: string,
): Promise<boolean> {
  const rows = await tx
    .update(webauthnChallenges)
    .set({ consumedAt: new Date() })
    .where(and(eq(webauthnChallenges.id, challengeId), isNull(webauthnChallenges.consumedAt)))
    .returning({ id: webauthnChallenges.id });
  return rows.length > 0;
}

/** Load the live grant for a token hash, if one exists. */
export async function findLiveGrant(db: DbHandle, tokenHash: string, now: Date): Promise<EnrollmentGrant> {
  const rows = await db
    .select()
    .from(enrollmentGrants)
    .where(
      and(
        eq(enrollmentGrants.tokenHash, tokenHash),
        isNull(enrollmentGrants.consumedAt),
        isNull(enrollmentGrants.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new AuthError(
      "grant_invalid",
      "This enrollment token is not valid. Ask the operator for a new one.",
    );
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new AuthError(
      "grant_invalid",
      "This enrollment token expired. Ask the operator for a new one.",
    );
  }
  return row;
}

/**
 * Consume a grant exactly once. The conditional update serializes
 * concurrent first-passkey registrations: one request wins.
 */
export async function consumeGrant(tx: MailHubTransaction, grantId: string): Promise<boolean> {
  const rows = await tx
    .update(enrollmentGrants)
    .set({ consumedAt: new Date() })
    .where(and(eq(enrollmentGrants.id, grantId), isNull(enrollmentGrants.consumedAt)))
    .returning({ id: enrollmentGrants.id });
  return rows.length > 0;
}

/** Revoke every live grant for one purpose. A new grant invalidates earlier ones. */
export async function revokeGrantsForPurpose(
  tx: MailHubTransaction,
  purpose: "bootstrap" | "recovery",
): Promise<number> {
  const rows = await tx
    .update(enrollmentGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(enrollmentGrants.purpose, purpose), isNull(enrollmentGrants.revokedAt), isNull(enrollmentGrants.consumedAt)))
    .returning({ id: enrollmentGrants.id });
  return rows.length;
}

/**
 * Revoke all authentication state: credentials, sessions, challenges, and
 * grants. Operator recovery and restore recovery both use this (SPEC
 * sections 9 and 10). Mail and the owner identifier stay untouched.
 */
export async function revokeAllAuthState(tx: MailHubTransaction): Promise<{
  credentials: number;
  sessions: number;
  challenges: number;
  grants: number;
}> {
  const credentials = await tx
    .update(ownerCredentials)
    .set({ revokedAt: new Date() })
    .where(isNull(ownerCredentials.revokedAt))
    .returning({ id: ownerCredentials.id });
  const sessions = await tx
    .update(ownerSessions)
    .set({ revokedAt: new Date() })
    .where(isNull(ownerSessions.revokedAt))
    .returning({ id: ownerSessions.id });
  const challenges = await tx
    .update(webauthnChallenges)
    .set({ revokedAt: new Date() })
    .where(and(isNull(webauthnChallenges.revokedAt), isNull(webauthnChallenges.consumedAt)))
    .returning({ id: webauthnChallenges.id });
  const grants = await tx
    .update(enrollmentGrants)
    .set({ revokedAt: new Date() })
    .where(and(isNull(enrollmentGrants.revokedAt), isNull(enrollmentGrants.consumedAt)))
    .returning({ id: enrollmentGrants.id });
  return {
    credentials: credentials.length,
    sessions: sessions.length,
    challenges: challenges.length,
    grants: grants.length,
  };
}

/** True when the owner exists and holds at least one active credential. */
export async function hasRegisteredOwner(tx: MailHubTransaction): Promise<boolean> {
  const ownerRow = await readOwner(tx);
  if (ownerRow === null) {
    return false;
  }
  const rows = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(ownerCredentials)
    .where(and(eq(ownerCredentials.ownerId, ownerRow.id), isNull(ownerCredentials.revokedAt)));
  return (rows[0]?.value ?? 0) > 0;
}

/** Load a session by token hash without validity checks. */
export async function readSessionByToken(db: DbHandle, tokenHash: string): Promise<OwnerSession | null> {
  const rows = await db
    .select()
    .from(ownerSessions)
    .where(eq(ownerSessions.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Is the generation a UUID in the canonical lowercase form? */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Record one authentication audit event. Payloads never contain secrets. */
export async function recordAuthEvent(
  tx: MailHubTransaction,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(events).values({ actor: "user", type, entityType: "auth", payload });
}
