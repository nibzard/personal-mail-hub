import { sql } from "drizzle-orm";
import {
  API_VERSION,
  type HealthzAccount,
  type HealthzClassification,
  type HealthzDatabase,
  type HealthzQueue,
  type HealthzRecovery,
  type HealthzResponse,
} from "@mail-hub/contracts";
import type { MailHubDatabase } from "@mail-hub/database";
import { type ControlStatus } from "@mail-hub/recovery";

/**
 * The health report service (SPEC sections 10 and 11).
 *
 * `GET /healthz` verifies one database round trip, then assembles the state
 * operators watch: recovery mode, sync lag and metrics per account, queue
 * age, and the classification circuit. Every number comes from durable
 * records — the audit trail, the message tables, and the queue — so a report
 * never writes and never invents state.
 */

/**
 * The audit event a classifier failure records. The classification service
 * writes one per failed Jev call; this report counts them (SPEC section 11).
 */
export const CLASS_ERROR_EVENT = "class.error";

/** The service surface the health service needs from recovery controls. */
export type RecoveryControlsForHealth = {
  readStatus(): Promise<ControlStatus>;
};

/**
 * The circuit verdict the classification service computes. `HealthService`
 * takes it as a structural interface, so observability needs no dependency
 * on the classifier itself (SPEC section 11).
 */
export type ClassificationCircuitForHealth = {
  readCircuit(): Promise<Pick<HealthzClassification, "circuit" | "description">>;
};

/** What one health read produced. */
export type HealthReport =
  | { available: true; report: HealthzResponse }
  | { available: false; database: HealthzDatabase; checkedAt: string };

/** Classification circuit state when no reader was wired in. */
const CLASSIFICATION_NOT_CONFIGURED: HealthzClassification = {
  circuit: "not_configured",
  calls: 0,
  errors: 0,
  description:
    "Jev classification is not configured. Calls and errors count the recorded decisions and failures; both stay zero until classification is enabled.",
};

export class HealthService {
  private readonly db: MailHubDatabase;
  private readonly controls: RecoveryControlsForHealth;
  private readonly classification: ClassificationCircuitForHealth | null;

  constructor(
    db: MailHubDatabase,
    controls: RecoveryControlsForHealth,
    classification?: ClassificationCircuitForHealth,
  ) {
    this.db = db;
    this.controls = controls;
    this.classification = classification ?? null;
  }

  /**
   * Assemble one report. A failed round trip short-circuits the read: the
   * caller learns the database is unreachable and nothing else is guessed.
   */
  async readHealth(): Promise<HealthReport> {
    const checkedAt = new Date();
    const database = await this.probeDatabase();
    if (database.state === "unavailable") {
      return { available: false, database, checkedAt: checkedAt.toISOString() };
    }

    const [controlStatus, accountRows, messageRows, decisionRows, errorRows, cycleRows, inventoryRows, queue, pendingWork, sends] =
      await Promise.all([
        this.controls.readStatus().catch(() => null),
        this.db.execute(sql`
          select id from accounts order by id
        `),
        this.db.execute(sql`
          select account_id,
                 count(*)::int as messages_synced,
                 count(*) filter (where fetched_body)::int as bodies_fetched,
                 count(*) filter (where not fetched_body)::int as pending_bodies
          from messages
          group by account_id
        `),
        this.db.execute(sql`
          select m.account_id, count(*)::int as calls
          from decisions d
          join messages m on m.id = d.message_id
          group by m.account_id
        `),
        this.db.execute(sql`
          select payload->>'accountId' as account_id, count(*)::int as errors
          from events
          where type = ${CLASS_ERROR_EVENT}
          group by payload->>'accountId'
        `),
        this.db.execute(sql`
          select distinct on (entity_id) entity_id, at, payload
          from events
          where type = 'sync.status' and entity_type = 'account'
          order by entity_id, at desc
        `),
        this.db.execute(sql`
          select distinct on (payload->>'accountId') payload->>'accountId' as account_id, at
          from events
          where type = 'sync.folder_inventory'
          order by payload->>'accountId', at desc
        `),
        this.readQueueAge(),
        this.db.execute(sql`
          select min(created_at) as oldest
          from actions
          where status in ('queued', 'executing')
        `),
        this.db.execute(sql`
          select
            count(*) filter (where status = 'queued')::int as queued,
            count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where status = 'outcome_unknown')::int as outcome_unknown,
            min(created_at) filter (where status = 'queued') as oldest_queued
          from outbound_messages
        `),
      ]);

    const messageStats = groupByAccount(messageRows.rows);
    const decisionStats = groupByAccount(decisionRows.rows);
    const errorStats = groupByAccount(errorRows.rows);
    const cycles = new Map(
      cycleRows.rows.flatMap((row) => {
        const accountId = textColumn(row, "entity_id");
        return accountId === null ? [] : [[accountId, row] as const];
      }),
    );
    const inventories = new Map(
      inventoryRows.rows.flatMap((row) => {
        const accountId = textColumn(row, "account_id");
        return accountId === null ? [] : [[accountId, row] as const];
      }),
    );

    const accounts: HealthzAccount[] = accountRows.rows.flatMap((row) => {
      const accountId = textColumn(row, "id");
      if (accountId === null) {
        return [];
      }
      const cycle = cycles.get(accountId);
      const lastCycleAt = cycle === undefined ? null : dateColumn(cycle, "at");
      const payload = payloadColumn(cycle);
      const backfillPending = payload === null ? null : wholeNumber(payload.backfillPendingFolders);
      return [
        {
          accountId,
          sync: {
            lastCycleAt: isoOrNull(lastCycleAt),
            cycleAgeSeconds: ageSeconds(lastCycleAt, checkedAt),
            backfillPendingFolders: backfillPending,
            pendingBodies: wholeNumber(messageStats.get(accountId)?.pending_bodies) ?? 0,
          },
          metrics: {
            messagesSynced: wholeNumber(messageStats.get(accountId)?.messages_synced) ?? 0,
            bodiesFetched: wholeNumber(messageStats.get(accountId)?.bodies_fetched) ?? 0,
            lastFullReconciliationAt: isoOrNull(
              dateColumn(inventories.get(accountId) ?? null, "at"),
            ),
            jevCalls: wholeNumber(decisionStats.get(accountId)?.calls) ?? 0,
            jevErrors: wholeNumber(errorStats.get(accountId)?.errors) ?? 0,
          },
        },
      ];
    });

    const recovery = recoverySection(controlStatus);
    const oldestPendingWork = oldestOf(
      dateColumn(pendingWork.rows[0] ?? null, "oldest"),
      dateColumn(sends.rows[0] ?? null, "oldest_queued"),
    );

    return {
      available: true,
      report: {
        service: "api",
        status: controlStatus?.state === "ready" ? "ok" : "degraded",
        version: API_VERSION,
        checkedAt: checkedAt.toISOString(),
        database,
        recovery,
        queue: {
          ...queue,
          oldestPendingWorkAt: isoOrNull(oldestPendingWork),
          oldestPendingWorkAgeSeconds: ageSeconds(oldestPendingWork, checkedAt),
        },
        classification: {
          ...CLASSIFICATION_NOT_CONFIGURED,
          ...(await this.classificationSection()),
          calls: sumAccounts(decisionStats, "calls"),
          errors: sumAccounts(errorStats, "errors"),
        },
        sends: {
          queued: wholeNumber(sends.rows[0]?.queued) ?? 0,
          failed: wholeNumber(sends.rows[0]?.failed) ?? 0,
          outcomeUnknown: wholeNumber(sends.rows[0]?.outcome_unknown) ?? 0,
        },
        accounts,
      },
    };
  }

  /**
   * The circuit verdict. The reader derives it from durable records; a read
   * that fails reports an unknown circuit rather than guessing a state the
   * records never supported, with a description that says so.
   */
  private async classificationSection(): Promise<Pick<HealthzClassification, "circuit" | "description">> {
    if (this.classification === null) {
      return { circuit: CLASSIFICATION_NOT_CONFIGURED.circuit, description: CLASSIFICATION_NOT_CONFIGURED.description };
    }
    try {
      return await this.classification.readCircuit();
    } catch {
      return {
        circuit: "unknown",
        description: "The classification circuit state could not be read.",
      };
    }
  }

  /** One timed round trip. Its failure is the only unavailable verdict. */
  private async probeDatabase(): Promise<HealthzDatabase> {
    const startedAt = Date.now();
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      return { state: "unavailable", roundTripMs: null };
    }
    return { state: "ok", roundTripMs: Date.now() - startedAt };
  }

  /**
   * The age of the job queue. Without the queue schema — the worker has not
   * run against this database yet — the state is `unknown`, never an error.
   */
  private async readQueueAge(): Promise<
    Pick<HealthzQueue, "state" | "depth" | "oldestJobAt" | "oldestJobAgeSeconds">
  > {
    let oldest: Date | null;
    let depth: number | null;
    try {
      const result = await this.db.execute(sql`
        select count(*)::int as depth, min(created_on) as oldest
        from pgboss.job
        where state in ('created', 'retry')
      `);
      depth = wholeNumber(result.rows[0]?.depth);
      oldest = dateColumn(result.rows[0] ?? null, "oldest");
    } catch {
      return { state: "unknown", depth: null, oldestJobAt: null, oldestJobAgeSeconds: null };
    }
    return {
      state: "ok",
      depth,
      oldestJobAt: isoOrNull(oldest),
      oldestJobAgeSeconds: ageSeconds(oldest, new Date()),
    };
  }
}

/** Map grouped rows onto their account, keeping raw column values. */
function groupByAccount(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const accountId = textColumn(row, "account_id");
    if (accountId !== null) {
      map.set(accountId, row);
    }
  }
  return map;
}

function sumAccounts(stats: Map<string, Record<string, unknown>>, column: string): number {
  let total = 0;
  for (const row of stats.values()) {
    total += wholeNumber(row[column]) ?? 0;
  }
  return total;
}

/**
 * Recovery state for the public report. The check answers without a
 * session, so it names states and modes but never the generation values
 * the control comparison holds; authenticated routes expose those.
 */
function recoverySection(status: ControlStatus | null): HealthzRecovery {
  if (status === null) {
    return {
      state: "unknown",
      mode: null,
      description: "The recovery control state could not be read.",
    };
  }
  switch (status.state) {
    case "ready":
      return {
        state: "ready",
        mode: "ready",
        description: "Deployment and database recovery state agree; mail mutations are allowed.",
      };
    case "reconciling":
      return {
        state: "reconciling",
        mode: "reconciling",
        description:
          "A restore is being reconciled. The API stays available for enrollment and operator recovery.",
      };
    case "generation_mismatch":
      return {
        state: "generation_mismatch",
        mode: status.mode,
        description:
          "Deployment and database recovery state disagree. Run 'npm run admin -- recovery begin' after a restore.",
      };
    case "uninitialized":
      return {
        state: "uninitialized",
        mode: null,
        description:
          "The recovery control state is not initialized. Run 'npm run admin -- recovery init' on a fresh installation.",
      };
    case "config_missing":
      return {
        state: "config_missing",
        mode: null,
        description: "The RECOVERY_GENERATION configuration is missing.",
      };
  }
}

function textColumn(row: Record<string, unknown> | null | undefined, column: string): string | null {
  const value = row?.[column];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function dateColumn(row: Record<string, unknown> | null | undefined, column: string): Date | null {
  const value = row?.[column];
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function payloadColumn(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const value = row?.payload;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function oldestOf(...dates: (Date | null)[]): Date | null {
  let oldest: Date | null = null;
  for (const date of dates) {
    if (date !== null && (oldest === null || date < oldest)) {
      oldest = date;
    }
  }
  return oldest;
}

function isoOrNull(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/** Whole seconds between two moments, never negative. */
function ageSeconds(at: Date | null, now: Date): number | null {
  if (at === null) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
}
