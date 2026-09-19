#!/usr/bin/env node
// Backup hash verification (SPEC.md section 10, step 6). One tool, two modes:
//
//   node verify-backup.mjs --write <backup-dir>
//     Hash every file in the directory and write manifest.sha256.
//
//   node verify-backup.mjs --check <backup-dir>
//     Re-hash every file against manifest.sha256, then cross-check every
//     durable storage sidecar: the sidecar's recorded sha256 and size must
//     match the copied bytes, and its key must equal the object's path under
//     storage-durable/, which is the layout the object store writes.
//
// The sidecar cross-check is what ties a copied object to the database rows
// that reference it: the database stores these exact keys and hashes.

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const MANIFEST_NAME = "manifest.sha256";
const SIDECAR_SUFFIX = ".meta.json";
const STORAGE_SUBDIR = "storage-durable";

const mode = process.argv[2];
const directory = process.argv[3];

if (
  (mode !== "--write" && mode !== "--check") ||
  directory === undefined ||
  process.argv.length !== 4
) {
  process.stderr.write("Usage: node verify-backup.mjs (--write | --check) <backup-dir>\n");
  process.exit(64);
}

/** List every file below the directory, relative, sorted, manifest excluded. */
async function listFiles(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile() && !(prefix === "" && entry.name === MANIFEST_NAME)) {
      files.push(relative);
    }
  }
  return files;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return { hex: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

function removeTrailingNewline(text) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

if (mode === "--write") {
  const files = await listFiles(directory);
  const lines = [];
  for (const file of files) {
    const { hex } = await sha256(join(directory, file));
    lines.push(`${hex}  ${file}`);
  }
  const manifest = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  await writeFile(join(directory, MANIFEST_NAME), manifest, "utf8");
  process.stdout.write(`Wrote ${MANIFEST_NAME}: ${lines.length} file(s) hashed.\n`);
  process.exit(0);
}

// --check mode.
const problems = [];
const warnings = [];
let verifiedFiles = 0;
let crossCheckedObjects = 0;

let manifestRaw;
try {
  manifestRaw = await readFile(join(directory, MANIFEST_NAME), "utf8");
} catch {
  process.stderr.write(`preflight of backup failed: ${MANIFEST_NAME} is missing.\n`);
  process.exit(1);
}

const recorded = new Map();
for (const line of removeTrailingNewline(manifestRaw).split("\n")) {
  if (line === "") {
    continue;
  }
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  if (match === null) {
    problems.push(`manifest line is malformed: ${line}`);
    continue;
  }
  recorded.set(match[2], match[1]);
}

const present = await listFiles(directory);
const presentSet = new Set(present);

for (const file of present) {
  if (!recorded.has(file)) {
    problems.push(`file is not in the manifest: ${file}`);
  }
}
for (const file of recorded.keys()) {
  if (!presentSet.has(file)) {
    problems.push(`manifest entry is missing from the backup: ${file}`);
  }
}

for (const file of present) {
  const expected = recorded.get(file);
  if (expected === undefined) {
    continue;
  }
  const { hex } = await sha256(join(directory, file));
  if (hex !== expected) {
    problems.push(`hash mismatch for ${file}: manifest ${expected}, actual ${hex}`);
  } else {
    verifiedFiles += 1;
  }
  if (file.startsWith(".tmp-") || file.includes("/.tmp-")) {
    warnings.push(`partial write captured in the backup (object store leftover): ${file}`);
  }
}

// Sidecar cross-check over the durable object tree.
for (const file of present) {
  if (!file.startsWith(`${STORAGE_SUBDIR}/`) || !file.endsWith(SIDECAR_SUFFIX)) {
    continue;
  }
  const object = file.slice(0, -SIDECAR_SUFFIX.length);
  const key = object.slice(`${STORAGE_SUBDIR}/`.length);
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(join(directory, file), "utf8"));
  } catch {
    problems.push(`sidecar is not readable JSON: ${file}`);
    continue;
  }
  if (sidecar.key !== key) {
    problems.push(
      `sidecar key does not match its path: ${file} records key ${String(sidecar.key)}`,
    );
    continue;
  }
  if (sidecar.storageClass !== undefined && sidecar.storageClass !== "durable") {
    problems.push(`sidecar is not a durable object: ${file}`);
    continue;
  }
  const recordedHash = recorded.get(object);
  if (recordedHash === undefined) {
    problems.push(`durable object is missing from the backup: ${object}`);
    continue;
  }
  if (String(sidecar.sha256).toLowerCase() !== recordedHash) {
    problems.push(
      `sidecar hash does not match the copied bytes: ${object} records ${String(sidecar.sha256)}`,
    );
    continue;
  }
  const { size } = await stat(join(directory, object));
  if (size !== sidecar.sizeBytes) {
    problems.push(
      `sidecar size does not match the copied bytes: ${object} records ${String(sidecar.sizeBytes)}, actual ${size}`,
    );
    continue;
  }
  crossCheckedObjects += 1;
}

for (const warning of warnings) {
  process.stdout.write(`warning: ${warning}\n`);
}

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`verify: ${problem}\n`);
  }
  process.exitCode = 1;
  process.stdout.write(`Backup verification FAILED: ${problems.length} problem(s).\n`);
} else {
  process.stdout.write(
    `Backup verified: ${verifiedFiles} file(s) hashed, ${crossCheckedObjects} durable object(s) cross-checked against sidecars.\n`,
  );
}
