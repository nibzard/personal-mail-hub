import { sql } from "drizzle-orm";
import { enrollmentGrants, type GrantPurpose } from "@mail-hub/database";
import type { MailHubDatabase } from "@mail-hub/database";
import type { MailHubTransaction, RecoveryControls, RecoveryHooks } from "@mail-hub/recovery";
import { AuthError } from "./errors.ts";
import {
  hasRegisteredOwner,
  readOwner,
  recordAuthEvent,
  revokeAllAuthState,
  revokeGrantsForPurpose,
} from "./state.ts";
import { generateToken, hashToken } from "./tokens.ts";
import { GRANT_TTL_MS } from "./config.ts";

/**
 * Operator authentication commands, run inside the app container (SPEC
 * section 9): `auth bootstrap` on a fresh installation and `auth recover`
 * when all passkeys are lost. Both print an enrollment token once, and
 * store only its hash.
 */

export interface IssuedGrant {
  id: string;
  purpose: GrantPurpose;
  token: string;
  expiresAt: Date;
}

export interface ConsoleAuthOptions {
  /** Overridden in tests; production uses the ten-minute default. */
  grantTtlMs?: number;
}

export class ConsoleAuthService {
  private readonly grantTtlMs: number;

  constructor(
    private readonly db: MailHubDatabase,
    private readonly controls: RecoveryControls,
    options: ConsoleAuthOptions = {},
  ) {
    this.grantTtlMs = options.grantTtlMs ?? GRANT_TTL_MS;
  }

  /**
   * Issue the first-passkey enrollment token. Requires that no owner exists
   * yet. On a fresh installation this also initializes `service_state`; a
   * populated database without control state must use restore recovery
   * instead (SPEC section 9).
   */
  async issueBootstrapGrant(): Promise<IssuedGrant> {
    if ((await readOwner(this.db)) !== null) {
      throw new AuthError(
        "owner_exists",
        "An owner is already registered. Use 'auth recover' when all passkeys are lost.",
      );
    }

    let status = await this.controls.readStatus();
    if (status.state === "uninitialized") {
      const outcome = await this.controls.initialize();
      if (outcome.result === "rejected") {
        if (outcome.reason === "database_not_empty") {
          throw new AuthError(
            "auth_unavailable",
            "The database holds mail or queued work but lacks control state. Set a new RECOVERY_GENERATION and run 'recovery begin'.",
          );
        }
        throw new AuthError(
          "auth_unavailable",
          "Control state could not be initialized. Check RECOVERY_GENERATION and retry.",
        );
      }
      status = await this.controls.readStatus();
    }
    if (status.state !== "ready" && status.state !== "reconciling") {
      throw new AuthError(
        "auth_unavailable",
        `Enrollment is unavailable while the recovery state is ${status.state}. Run 'recovery begin' after a restore.`,
      );
    }

    return this.insertGrant("bootstrap", status.generation);
  }

  /**
   * Revoke every credential, session, challenge, and grant, then issue one
   * replacement enrollment grant (SPEC section 9). The owner identifier and
   * all mail stay untouched. An expired grant can be replaced by running
   * this command again.
   */
  async issueRecoveryGrant(): Promise<IssuedGrant> {
    const ownerRow = await readOwner(this.db);
    if (ownerRow === null) {
      throw new AuthError(
        "owner_missing",
        "No owner is registered. Use 'auth bootstrap' on a fresh installation.",
      );
    }
    const deployment = this.controls.deploymentGeneration;
    if (deployment === null) {
      throw new AuthError(
        "auth_unavailable",
        "RECOVERY_GENERATION must be set to a UUID before issuing an enrollment token.",
      );
    }

    return this.db.transaction(async (tx) => {
      // The same per-purpose lock as bootstrap: two concurrent recover
      // commands must not both leave a live grant behind.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`auth.grant_issue.recovery`})::bigint)`,
      );
      const revoked = await revokeAllAuthState(tx);
      const grant = await insertGrantRow(tx, "recovery", deployment, this.grantTtlMs);
      await recordAuthEvent(tx, "auth.recovery_grant", {
        purpose: "recovery",
        grantId: grant.id,
        expiresAt: grant.expiresAt.toISOString(),
        revokedCredentials: revoked.credentials,
        revokedSessions: revoked.sessions,
        ownerId: ownerRow.id,
      });
      return grant;
    });
  }

  private async insertGrant(purpose: GrantPurpose, generation: string): Promise<IssuedGrant> {
    return this.db.transaction(async (tx) => {
      // Serialize grant issues per purpose: without the lock, two concurrent
      // bootstraps each revoke nothing (the other's grant is uncommitted)
      // and each insert a grant, leaving two live at once. Under the lock the
      // second run's revoke sees the first run's committed grant instead.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`auth.grant_issue.${purpose}`})::bigint)`,
      );
      // Re-check under the lock: an enrollment that completed meanwhile
      // closes setup, and a second bootstrap grant must not open it again.
      if ((await readOwner(tx)) !== null) {
        throw new AuthError(
          "owner_exists",
          "An owner is already registered. Use 'auth recover' when all passkeys are lost.",
        );
      }
      // A new grant invalidates any earlier grant for the same purpose.
      await revokeGrantsForPurpose(tx, purpose);
      const grant = await insertGrantRow(tx, purpose, generation, this.grantTtlMs);
      await recordAuthEvent(tx, "auth.bootstrap_grant", {
        purpose,
        grantId: grant.id,
        expiresAt: grant.expiresAt.toISOString(),
        recoveryGeneration: generation,
      });
      return grant;
    });
  }
}

async function insertGrantRow(
  tx: MailHubTransaction,
  purpose: GrantPurpose,
  generation: string,
  ttlMs: number,
): Promise<IssuedGrant> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  const rows = await tx
    .insert(enrollmentGrants)
    .values({ purpose, tokenHash: hashToken(token), recoveryGeneration: generation, expiresAt })
    .returning();
  const row = rows[0]!;
  return { id: row.id, purpose, token, expiresAt: row.expiresAt };
}

/**
 * Recovery hooks that revoke authentication state when a restore begins and
 * verify a registered owner before recovery completes (SPEC section 10).
 */
export function createRecoveryHooks(): RecoveryHooks {
  return {
    revokeRestoredAuth: async (tx: MailHubTransaction) => {
      const revoked = await revokeAllAuthState(tx);
      await recordAuthEvent(tx, "auth.revoked_on_recovery", { ...revoked });
    },
    hasRegisteredOwner: (tx: MailHubTransaction) => hasRegisteredOwner(tx),
  };
}
