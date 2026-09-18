import { createDatabase, createPool } from "@mail-hub/database";
import { RecoveryControls, describeControlStatus } from "@mail-hub/recovery";
import { buildApp } from "./app.ts";

const connectionString = process.env.DATABASE_URL;

if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required to start the API.");
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const pool = createPool(connectionString);
const app = buildApp();

// Startup control check (SPEC section 10): a mismatch blocks mail mutations
// and workers, but the API stays up for enrollment and operator recovery.
const controls = new RecoveryControls(createDatabase(pool), {
  deploymentGeneration: process.env.RECOVERY_GENERATION,
});
const status = await controls.readStatus();
if (status.state === "ready") {
  app.log.info(`Recovery control state: ${describeControlStatus(status)}.`);
} else {
  app.log.warn(
    `Mail mutations blocked: ${describeControlStatus(status)}. Run 'npm run admin -- recovery begin' after a restore.`,
  );
}

await app.listen({ host, port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .then(() => {
        process.exitCode = 0;
      });
  });
}
