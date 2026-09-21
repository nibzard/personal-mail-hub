import type { Pool } from "pg";

/** Errors that a retry can clear: another session still holds the database. */
const RETRYABLE_DROP_CODES = new Set(["42501", "55006"]);
const DROP_ATTEMPTS = 20;
const DROP_RETRY_DELAY_MS = 250;

/**
 * Grace for client sockets to finish closing. A pool's `end()` can resolve
 * while a socket close is still in flight; the force drop below then
 * terminates that backend, and the client emits a late `57P01` error event
 * after every test already passed. Vitest records it as an unhandled error
 * and fails the whole run. The settle keeps the drop behind the close.
 */
const DROP_SETTLE_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Drop a throwaway test database, retrying while another backend holds it.
 *
 * `DROP DATABASE ... WITH (FORCE)` fails with `42501` ("permission denied to
 * terminate process") when a backend of another role holds the database — an
 * autovacuum worker visiting a freshly churned database is the usual one. A
 * non-superuser cannot terminate it, but the holder is transient, so the drop
 * succeeds once it leaves. `55006` ("being accessed by other users") gets the
 * same treatment for a closing connection of our own. Both surface again after
 * the retries run out, so a real leak still fails the suite.
 */
export async function dropTestDatabase(admin: Pool, name: string): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to drop a database with an unsafe name: ${name}`);
  }
  let lastError: unknown;
  await delay(DROP_SETTLE_MS);
  for (let attempt = 1; attempt <= DROP_ATTEMPTS; attempt += 1) {
    try {
      await admin.query(`drop database if exists ${name} with (force)`);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      if (code === undefined || !RETRYABLE_DROP_CODES.has(code)) {
        throw error;
      }
      await delay(DROP_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}
