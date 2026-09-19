#!/usr/bin/env node
// Deployment environment checks (SPEC.md section 10, step 7). Run before the
// container starts serving: node deploy/preflight.mjs. The checks mirror the
// parsers the services use, so a passing preflight means the API opens its
// routes instead of starting closed.
//
// DATABASE_URL, RECOVERY_GENERATION, CREDENTIALS_KEY, and BASE_URL are
// required. Set PREFLIGHT_ALLOW_HTTP=1 to accept an http BASE_URL for local
// compose trials; production origins must be https.

import { mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import process from "node:process";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const problems = [];
const notes = [];

function requireValue(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    problems.push(`${name} is required.`);
    return null;
  }
  return raw.trim();
}

/** Same acceptance as parseCredentialsKey in @mail-hub/accounts. */
function parseCredentialsKey(raw) {
  for (const decode of [decodeBase64, decodeHex]) {
    const bytes = decode(raw);
    if (bytes !== null && bytes.byteLength === 32) {
      return bytes;
    }
  }
  return null;
}

function decodeBase64(value) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    return null;
  }
  const buffer = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  return buffer.byteLength === 0 ? null : buffer;
}

function decodeHex(value) {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    return null;
  }
  return Buffer.from(value, "hex");
}

/** Same acceptance as parseAuthConfig in @mail-hub/auth. */
function checkBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`BASE_URL must be a URL (got: ${raw}).`);
    return;
  }
  const host = url.hostname.toLowerCase();
  const localHost =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    if (process.env.PREFLIGHT_ALLOW_HTTP === "1") {
      notes.push("PREFLIGHT_ALLOW_HTTP=1: accepting a non-https BASE_URL. Never do this in production.");
    } else {
      problems.push(`BASE_URL must use https (got: ${url.protocol}//). Set PREFLIGHT_ALLOW_HTTP=1 only for local trials.`);
    }
  }
  if (url.username !== "" || url.password !== "") {
    problems.push("BASE_URL must not carry credentials.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    problems.push(`BASE_URL must be an origin without a path (got: ${url.pathname}).`);
  }
}

// DATABASE_URL: a PostgreSQL connection string.
const databaseUrl = requireValue("DATABASE_URL");
if (databaseUrl !== null) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    problems.push(`DATABASE_URL must be a URL (got: ${databaseUrl}).`);
  }
  if (parsed !== undefined && parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    problems.push(`DATABASE_URL must use postgres:// or postgresql:// (got: ${parsed.protocol}).`);
  }
}

// RECOVERY_GENERATION: a UUID from deployment configuration. Never recover
// it from the database or a backup bundle.
const generation = requireValue("RECOVERY_GENERATION");
if (generation !== null && !UUID_PATTERN.test(generation)) {
  problems.push(`RECOVERY_GENERATION must be a UUID (got: ${generation}). Generate one with uuidgen.`);
}

// CREDENTIALS_KEY: 32 bytes, base64 or hex. Back it up separately from the
// database; losing it loses every stored mailbox credential.
const credentialsKey = requireValue("CREDENTIALS_KEY");
if (credentialsKey !== null && parseCredentialsKey(credentialsKey) === null) {
  problems.push(
    "CREDENTIALS_KEY must hold 32 bytes as base64 or hex. Generate one with: openssl rand -base64 32",
  );
}

// BASE_URL: the deployed HTTPS origin of the application.
const baseUrl = requireValue("BASE_URL");
if (baseUrl !== null) {
  checkBaseUrl(baseUrl);
}

// PORT: optional, but it must be a valid port number when set.
const port = process.env.PORT;
if (port !== undefined && port !== "" && !/^[0-9]+$/.test(port)) {
  problems.push(`PORT must be an integer (got: ${port}).`);
}

// STORAGE_ROOT: default /app/data/storage; it must be writable.
const storageRoot = process.env.STORAGE_ROOT ?? "/app/data/storage";
try {
  await mkdir(storageRoot, { recursive: true });
  await access(storageRoot, constants.W_OK);
} catch (cause) {
  problems.push(`STORAGE_ROOT must be writable at ${storageRoot}: ${String(cause?.message ?? cause)}`);
}

// TYPE_SAFE_API_KEY is optional: core mail never waits on the model.
if ((process.env.TYPE_SAFE_API_KEY ?? "").trim() === "") {
  notes.push("TYPE_SAFE_API_KEY is not set: Jev classification stays off. Core mail is unaffected.");
}

for (const note of notes) {
  process.stdout.write(`note: ${note}\n`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`preflight: ${problem}\n`);
  }
  process.exitCode = 1;
  process.stdout.write("Environment checks FAILED.\n");
} else {
  process.stdout.write("Environment checks passed.\n");
}
