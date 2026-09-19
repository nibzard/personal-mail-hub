import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  dropTestDatabase,
  events,
  runMigrations,
  settings as settingsTable,
  type MailHubDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";
import {
  DEFAULT_SETTINGS,
  SettingsError,
  SettingsService,
  type MutationContext,
} from "../src/index.ts";

/**
 * Settings storage acceptance against a real PostgreSQL (SPEC F10 and
 * section 7). Set `TEST_DATABASE_URL` to a connection string whose user may
 * create databases; a throwaway database is created per run. Without the
 * variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";

const readyContext: MutationContext = { requestGeneration: GENERATION };

/** Convert a rejected promise into its typed code or message fragment. */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; name: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SettingsError || error instanceof RecoveryBlockedError) {
      return { code: error.code, name: error.name };
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

suite("settings service", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let service: SettingsService;
  let controls: RecoveryControls;

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
    service = new SettingsService(db, controls);
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  it("answers the defaults without seeding anything", async () => {
    expect(await service.readSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await db.select().from(settingsTable)).toHaveLength(0);
  });

  it("stores only the keys a change touches, and records one event", async () => {
    const next = await service.updateSettings(readyContext, {
      density: "comfortable",
      classificationMonthlyCostCapUsd: 5.001,
    });

    expect(next.density).toBe("comfortable");
    expect(next.classificationMonthlyCostCapUsd).toBe(5);
    expect(next.theme).toBe(DEFAULT_SETTINGS.theme);

    // Only the two changed keys exist in the table.
    const rows = await db.select().from(settingsTable);
    expect(new Set(rows.map((row) => row.key))).toEqual(
      new Set(["reading.density", "classification.monthly_cost_cap_usd"]),
    );

    // The audit event names the keys; it carries no values (SPEC section 11).
    const event = (
      await db.select().from(events).where(eq(events.type, "settings.updated")).orderBy(desc(events.at))
    )[0]!;
    expect(event.actor).toBe("user");
    expect(Object.keys(event.payload).sort()).toEqual(["keys"]);
    expect([...(event.payload.keys as string[])].sort()).toEqual(
      ["classification.monthly_cost_cap_usd", "reading.density"].sort(),
    );
  });

  it("keeps stored values across later reads and further changes", async () => {
    const stored = await service.readSettings();
    expect(stored.density).toBe("comfortable");

    const next = await service.updateSettings(readyContext, {
      theme: "dark",
      singleKeyShortcuts: false,
      cleanViewDefault: true,
      classificationEnabled: true,
      backfillClassification: true,
    });
    expect(next).toMatchObject({
      density: "comfortable",
      theme: "dark",
      singleKeyShortcuts: false,
      cleanViewDefault: true,
      classificationEnabled: true,
      backfillClassification: true,
    });
    expect(await service.readSettings()).toEqual(next);
  });

  it("clears the cost cap with null and skips no-op writes", async () => {
    const eventsBefore = (await db.select().from(events)).length;

    const cleared = await service.updateSettings(readyContext, {
      classificationMonthlyCostCapUsd: null,
    });
    expect(cleared.classificationMonthlyCostCapUsd).toBeNull();
    expect((await db.select().from(events)).length).toBe(eventsBefore + 1);

    // A patch whose values already hold writes nothing and records nothing.
    const unchanged = await service.updateSettings(readyContext, { theme: "dark" });
    expect(unchanged.theme).toBe("dark");
    expect((await db.select().from(events)).length).toBe(eventsBefore + 1);
  });

  it("rejects values outside the documented ranges", async () => {
    await expect(
      rejection(service.updateSettings(readyContext, { theme: "blue" as never })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.updateSettings(readyContext, { density: "cozy" as never })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.updateSettings(readyContext, { singleKeyShortcuts: "off" as never })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.updateSettings(readyContext, { classificationMonthlyCostCapUsd: -1 })),
    ).resolves.toMatchObject({ code: "invalid_request" });
    await expect(
      rejection(service.updateSettings(readyContext, { classificationMonthlyCostCapUsd: Number.NaN })),
    ).resolves.toMatchObject({ code: "invalid_request" });
  });

  it("gates every change on the recovery generation (SPEC section 7)", async () => {
    await expect(
      rejection(service.updateSettings({ requestGeneration: OTHER_GENERATION }, { theme: "light" })),
    ).resolves.toMatchObject({ code: "recovery_required" });
    await expect(
      rejection(service.updateSettings({ requestGeneration: undefined }, { theme: "light" })),
    ).resolves.toMatchObject({ code: "invalid_recovery_generation" });

    // The rejected change stored nothing.
    expect((await service.readSettings()).theme).toBe("dark");
  });

  it("falls back to the default when a stored value is unusable", async () => {
    await db
      .insert(settingsTable)
      .values({ key: "theme", value: "neon" })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: "neon" } });
    expect((await service.readSettings()).theme).toBe(DEFAULT_SETTINGS.theme);
  });
});
