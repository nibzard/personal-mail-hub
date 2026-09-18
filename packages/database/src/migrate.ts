import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

/** Absolute path of the folder that holds the generated migrations. */
export function migrationsFolder(): string {
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

/**
 * Apply all pending migrations to the pool's database.
 *
 * The deployment entrypoint runs `npm run db:migrate` (drizzle-kit) instead;
 * both paths apply the same files from the same folder. `pg_trgm` is installed
 * when absent so a freshly created database can apply the first migration,
 * which indexes sender and subject text with trigram operators.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const db = drizzle({ client: pool });
  const installed = await db.execute<{ installed: boolean }>(
    sql`select exists(select 1 from pg_extension where extname = 'pg_trgm') as installed`,
  );
  if (installed.rows[0]?.installed !== true) {
    await db.execute(sql`create extension pg_trgm`);
  }
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
