import { createDatabase, createPool, createStorage } from "@mail-hub/database";
import { RecoveryControls, describeControlStatus } from "@mail-hub/recovery";
import { ActionService, TwoWayActionExecutor } from "@mail-hub/actions";
import { PasskeyAuthService, parseAuthConfig } from "@mail-hub/auth";
import { AccountService, createCredentialCipher, parseCredentialsKey } from "@mail-hub/accounts";
import { ClassificationService, CorrectionService, jevAdapterFromEnv } from "@mail-hub/classification";
import { ComposeService } from "@mail-hub/compose";
import { OutboundService } from "@mail-hub/send";
import { SearchService } from "@mail-hub/search";
import { IngestionService } from "@mail-hub/ingestion";
import { ReadingService } from "@mail-hub/reading";
import { runConnectionTest } from "@mail-hub/transport";
import { HealthService } from "@mail-hub/observability";
import { SettingsService } from "@mail-hub/settings";
import { registerAccountRoutes } from "./account-routes.ts";
import { registerActionRoutes } from "./action-routes.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { registerClassificationRoutes } from "./classification-routes.ts";
import { registerComposeRoutes } from "./compose-routes.ts";
import { registerConnectionTestRoutes } from "./connection-test-routes.ts";
import { registerHealthRoutes } from "./health-routes.ts";
import { registerMessageRoutes } from "./message-routes.ts";
import { registerSearchRoutes } from "./search-routes.ts";
import { registerSendRoutes } from "./send-routes.ts";
import { registerSettingsRoutes } from "./settings-routes.ts";
import { buildApp } from "./app.ts";

const connectionString = process.env.DATABASE_URL;

if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required to start the API.");
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";

// Durable uploads live under this root, beside the originals and outbound
// bytes the worker stores (SPEC section 8).
const DEFAULT_STORAGE_ROOT = "data/storage";

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

// The deployment health check (SPEC sections 10 and 11) runs without a
// session and reports state honestly, blocked or not, so the platform and
// the operator can watch recovery, sync lag, and queue age. The
// classification circuit comes from the same durable records the worker's
// classify cycle reads; without TYPE_SAFE_API_KEY it reports not configured.
const settingsService = new SettingsService(db, controls);
const classificationService = new ClassificationService(db, {
  settings: settingsService,
  adapter: jevAdapterFromEnv(process.env),
});
const healthService = new HealthService(db, controls, classificationService);
await registerHealthRoutes(app, { service: healthService });
app.log.info("Health check ready: GET /healthz.");

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

  // Settings read and write through the same session and recovery gate as
  // every durable client mutation (SPEC F10 and section 7). The sync status
  // the settings screen shows reads the durable records behind /healthz.
  await registerSettingsRoutes(app, {
    service: settingsService,
    health: healthService,
    origin: authConfig.origin,
    verifySession: (token) => authService.verifySession(token),
  });
  app.log.info("Settings ready: preferences and per-account sync status.");

  // Draft editing and uploads share the session and recovery gate; their
  // files persist in durable storage before the database acknowledges them
  // (SPEC F6). No mailbox credentials are involved, so they open without
  // CREDENTIALS_KEY. Send snapshots persist in the same durable volume.
  const storage = createStorage(process.env.STORAGE_ROOT ?? DEFAULT_STORAGE_ROOT);
  const composeService = new ComposeService(db, storage, controls);
  await registerComposeRoutes(app, {
    service: composeService,
    origin: authConfig.origin,
    verifySession: (token) => authService.verifySession(token),
  });
  app.log.info("Compose ready: draft editing and durable uploads.");

  // Queueing sends freezes a draft into immutable MIME bytes and locks the
  // draft (SPEC F7). The API never submits mail: the worker claims queued
  // rows, so this process needs no SMTP submitter or credentials here.
  const outboundService = new OutboundService(db, storage, controls);
  await registerSendRoutes(app, {
    service: outboundService,
    origin: authConfig.origin,
    verifySession: (token) => authService.verifySession(token),
  });
  app.log.info("Send ready: queueing outbound snapshots.");

  // Mail management actions freeze their occurrence targets here and answer
  // with per-item receipts (SPEC F4 and section 7). The recovery gate runs
  // before the idempotency lookup, like every durable client mutation. The
  // API only queues; the worker drives the writes over its mailbox session.
  const actionService = new ActionService(db, controls, new TwoWayActionExecutor());
  await registerActionRoutes(app, {
    service: actionService,
    origin: authConfig.origin,
    verifySession: (token) => authService.verifySession(token),
  });
  app.log.info("Actions ready: mail management with per-item receipts.");

  // Search reads every account from the shared index (SPEC F5); saved
  // searches pass the recovery gate like every durable client write.
  const searchService = new SearchService(db, controls);
  await registerSearchRoutes(app, {
    service: searchService,
    origin: authConfig.origin,
    verifySession: (token) => authService.verifySession(token),
  });
  app.log.info("Search ready: cross-account queries and saved searches.");

  // The reader serves sanitized derivatives only; a download regenerates its
  // disposable copy from the verified original when the cache misses (SPEC
  // F3 and section 8). Reads carry no recovery gate.
  const readingService = new ReadingService(
    db,
    storage,
    (attachmentId) => new IngestionService(db, storage).regenerateAttachment(attachmentId),
  );
  await registerMessageRoutes(app, {
    service: readingService,
    verifySession: (token) => authService.verifySession(token),
  });
  app.log.info("Reading ready: message detail and attachment downloads.");

  // Corrections choose their own scope — one message, one sender, or the
  // deterministic rule that answered — and record one event each (SPEC F8).
  // The recovery gate runs before any write, like every client mutation.
  const correctionService = new CorrectionService(db, controls);
  await registerClassificationRoutes(app, {
    service: correctionService,
    origin: authConfig.origin,
    verifySession: (token) => authService.verifySession(token),
  });
  app.log.info("Classification corrections ready: scoped correction events.");

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
      controls,
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
