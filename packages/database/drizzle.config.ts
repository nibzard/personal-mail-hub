import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Migration configuration for the mail hub database.
 *
 * Generate migrations with `npm run db:generate` in this package after
 * changing `src/schema.ts`. Applying migrations with `npm run db:migrate`
 * reads `DATABASE_URL` from the environment; the deployment entrypoint runs
 * the same command (SPEC section 10). Set `DATABASE_URL` to generate only if
 * the configuration must be validated as well.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: databaseUrl === undefined || databaseUrl.length === 0 ? undefined : { url: databaseUrl },
  strict: true,
  verbose: true,
});
