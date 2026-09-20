import { sql } from "drizzle-orm";
import type { AppSettings, SettingsDensity, SettingsTheme } from "@mail-hub/contracts";
import { events, settings as settingsTable } from "@mail-hub/database";
import type { MailHubDatabase } from "@mail-hub/database";
import type { MutationGate } from "@mail-hub/recovery";
import { SettingsError } from "./errors.ts";

/**
 * Application settings (SPEC F10).
 *
 * The `settings` table holds key-value pairs; this service is its only
 * reader and writer. Reads merge stored rows over the defaults, so a fresh
 * installation answers without seeding. Every mutation passes the
 * recovery-generation gate before it writes, and records one audit event
 * naming the keys that changed — values never carry secrets, but the trail
 * stays minimal anyway (SPEC sections 7 and 11).
 */

/** The storage key of every setting the screen manages (SPEC F10, F13). */
const STORAGE_KEYS = {
  theme: "theme",
  density: "reading.density",
  singleKeyShortcuts: "shortcuts.single_key",
  cleanViewDefault: "reading.clean_view_default",
  classificationEnabled: "classification.enabled",
  classificationMonthlyCostCapUsd: "classification.monthly_cost_cap_usd",
  backfillClassification: "classification.backfill",
  homeEnabled: "home.enabled",
} as const;

/** The audit event one settings change records. */
const SETTINGS_EVENT = "settings.updated";

/** The settings a fresh installation starts with (SPEC F10, F13). */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  density: "compact",
  singleKeyShortcuts: true,
  cleanViewDefault: false,
  classificationEnabled: false,
  classificationMonthlyCostCapUsd: null,
  backfillClassification: false,
  homeEnabled: true,
};

/** Context for one durable mutation: the generation the client captured. */
export interface MutationContext {
  requestGeneration?: string | null;
}

const THEMES: readonly SettingsTheme[] = ["system", "light", "dark"];
const DENSITIES: readonly SettingsDensity[] = ["compact", "comfortable"];

/** The highest monthly cost cap a settings change may set, in US dollars. */
const MAX_COST_CAP_USD = 1_000_000;

export class SettingsService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly gate: MutationGate,
  ) {}

  /** Read every setting, with defaults filling unset keys. */
  async readSettings(): Promise<AppSettings> {
    const rows = await this.db.select().from(settingsTable);
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    return {
      theme: themeValue(stored.get(STORAGE_KEYS.theme)) ?? DEFAULT_SETTINGS.theme,
      density: densityValue(stored.get(STORAGE_KEYS.density)) ?? DEFAULT_SETTINGS.density,
      singleKeyShortcuts:
        booleanValue(stored.get(STORAGE_KEYS.singleKeyShortcuts)) ??
        DEFAULT_SETTINGS.singleKeyShortcuts,
      cleanViewDefault:
        booleanValue(stored.get(STORAGE_KEYS.cleanViewDefault)) ??
        DEFAULT_SETTINGS.cleanViewDefault,
      classificationEnabled:
        booleanValue(stored.get(STORAGE_KEYS.classificationEnabled)) ??
        DEFAULT_SETTINGS.classificationEnabled,
      classificationMonthlyCostCapUsd:
        costCapValue(stored.get(STORAGE_KEYS.classificationMonthlyCostCapUsd)) ??
        DEFAULT_SETTINGS.classificationMonthlyCostCapUsd,
      backfillClassification:
        booleanValue(stored.get(STORAGE_KEYS.backfillClassification)) ??
        DEFAULT_SETTINGS.backfillClassification,
      homeEnabled:
        booleanValue(stored.get(STORAGE_KEYS.homeEnabled)) ?? DEFAULT_SETTINGS.homeEnabled,
    };
  }

  /**
   * Change the given settings keys. The gate runs before anything is
   * written (SPEC section 7, step 1); only keys whose value actually
   * changes are stored, and one audit event names those keys.
   */
  async updateSettings(context: MutationContext, patch: Partial<AppSettings>): Promise<AppSettings> {
    await this.gate.gateMutation(context.requestGeneration);

    const current = await this.readSettings();
    const next = mergePatch(current, patch);
    const changed = changedEntries(current, next);
    if (changed.length === 0) {
      return current;
    }

    const updatedAt = new Date();
    await this.db.transaction(async (tx) => {
      for (const [key, value] of changed) {
        // The column is not-null jsonb, so a cleared value stores the JSON
        // literal null rather than SQL NULL.
        const stored = value === null ? sql`'null'::jsonb` : value;
        await tx
          .insert(settingsTable)
          .values({ key, value: stored })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { value: stored, updatedAt },
          });
      }
      await tx.insert(events).values({
        actor: "user",
        type: SETTINGS_EVENT,
        payload: { keys: changed.map(([key]) => key) },
      });
    });
    return next;
  }
}

/** Validate and apply one patch onto the current settings. */
function mergePatch(current: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...current };
  if (patch.theme !== undefined) {
    if (!THEMES.includes(patch.theme)) {
      throw new SettingsError("invalid_request", "Theme must be system, light, or dark.");
    }
    next.theme = patch.theme;
  }
  if (patch.density !== undefined) {
    if (!DENSITIES.includes(patch.density)) {
      throw new SettingsError("invalid_request", "Density must be compact or comfortable.");
    }
    next.density = patch.density;
  }
  for (const key of ["singleKeyShortcuts", "cleanViewDefault", "classificationEnabled", "backfillClassification", "homeEnabled"] as const) {
    const value = patch[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") {
        throw new SettingsError("invalid_request", `${key} must be true or false.`);
      }
      next[key] = value;
    }
  }
  if (patch.classificationMonthlyCostCapUsd !== undefined) {
    next.classificationMonthlyCostCapUsd = normalizeCostCap(patch.classificationMonthlyCostCapUsd);
  }
  return next;
}

/** The stored entries whose value a patch actually changes. */
function changedEntries(current: AppSettings, next: AppSettings): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(STORAGE_KEYS) as (keyof typeof STORAGE_KEYS)[]) {
    if (current[key] !== next[key]) {
      entries.push([STORAGE_KEYS[key], next[key]]);
    }
  }
  return entries;
}

/** One monthly cost ceiling in US dollars, rounded to whole cents. */
function normalizeCostCap(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COST_CAP_USD) {
    throw new SettingsError(
      "invalid_request",
      `The monthly cost cap must be null or a number between 0 and ${MAX_COST_CAP_USD} US dollars.`,
    );
  }
  return Math.round(value * 100) / 100;
}

function themeValue(value: unknown): SettingsTheme | null {
  return typeof value === "string" && THEMES.includes(value as SettingsTheme)
    ? (value as SettingsTheme)
    : null;
}

function densityValue(value: unknown): SettingsDensity | null {
  return typeof value === "string" && DENSITIES.includes(value as SettingsDensity)
    ? (value as SettingsDensity)
    : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function costCapValue(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
