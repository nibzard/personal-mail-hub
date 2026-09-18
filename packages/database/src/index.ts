import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export * from "./storage/index.ts";
export { migrationsFolder, runMigrations } from "./migrate.ts";

export { schema };

/** The database client type bound to the mail hub schema. */
export type MailHubDatabase = NodePgDatabase<typeof schema>;

/** Create a PostgreSQL pool for application data. */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/** Create the Drizzle database client bound to the mail hub schema. */
export function createDatabase(pool: Pool): MailHubDatabase {
  return drizzle({ client: pool, schema });
}

/** Create the background queue that shares the PostgreSQL database. */
export function createJobQueue(connectionString: string): PgBoss {
  return new PgBoss({ connectionString });
}
