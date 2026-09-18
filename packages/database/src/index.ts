import { drizzle } from "drizzle-orm/node-postgres";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";

/** Create a PostgreSQL pool for application data. */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/** Create the Drizzle database client. Schema definitions arrive with T002. */
export function createDatabase(pool: Pool) {
  return drizzle({ client: pool });
}

/** Create the background queue that shares the PostgreSQL database. */
export function createJobQueue(connectionString: string): PgBoss {
  return new PgBoss({ connectionString });
}
