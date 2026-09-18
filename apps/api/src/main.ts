import { createDatabase, createPool } from "@mail-hub/database";
import { RecoveryControls, describeControlStatus } from "@mail-hub/recovery";
import { PasskeyAuthService, parseAuthConfig } from "@mail-hub/auth";
import { registerAuthRoutes } from "./auth-routes.ts";
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
const db = createDatabase(pool);
const app = buildApp();

// Startup control check (SPEC section 10): a mismatch blocks mail mutations
// and workers, but the API stays up for enrollment and operator recovery.
const controls = new RecoveryControls(db, {
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

// Passkey authentication closes until BASE_URL names the deployed origin
// (SPEC section 9). Enrollment cannot verify WebAuthn origins without it.
const authConfig = parseAuthConfig({ baseUrl: process.env.BASE_URL });
if (authConfig === null) {
  app.log.warn(
    "BASE_URL must be the deployed HTTPS origin. Passkey authentication stays closed until it is set.",
  );
} else {
  const authService = new PasskeyAuthService(db, authConfig, controls);
  await registerAuthRoutes(app, { service: authService, origin: authConfig.origin });
  app.log.info(`Passkey authentication ready for origin ${authConfig.origin}.`);
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
