import { createDatabase, createPool } from "@mail-hub/database";
import { RecoveryControls, describeControlStatus } from "@mail-hub/recovery";
import { PasskeyAuthService, parseAuthConfig } from "@mail-hub/auth";
import { AccountService, createCredentialCipher, parseCredentialsKey } from "@mail-hub/accounts";
import { runConnectionTest } from "@mail-hub/transport";
import { registerAccountRoutes } from "./account-routes.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { registerConnectionTestRoutes } from "./connection-test-routes.ts";
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

  // Account management seals mailbox passwords with CREDENTIALS_KEY (SPEC
  // section 9). Without a usable key the routes stay closed: storing plaintext
  // or guessing a key would silently corrupt every stored credential.
  const credentialsKey = parseCredentialsKey(process.env.CREDENTIALS_KEY);
  if (credentialsKey === null) {
    app.log.warn(
      "CREDENTIALS_KEY must hold 32 bytes as base64 or hex. Account management stays closed until it is set.",
    );
  } else {
    const accountService = new AccountService(db, createCredentialCipher(credentialsKey), controls);
    await registerAccountRoutes(app, {
      service: accountService,
      origin: authConfig.origin,
      verifySession: (token) => authService.verifySession(token),
    });
    await registerConnectionTestRoutes(app, {
      service: accountService,
      tester: runConnectionTest,
      origin: authConfig.origin,
      verifySession: (token) => authService.verifySession(token),
    });
    app.log.info("Account and identity management ready.");
  }
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
