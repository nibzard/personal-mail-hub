#!/usr/bin/env node
/*
 * Content fingerprint of one build output directory (T112). The service
 * worker stamps its cache with this hash, and the fixture launcher serves
 * it as the run's build identity, so a browser check can prove the server
 * it tests still holds the exact build the run produced.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Every file below one directory, as POSIX paths relative to it. */
async function walk(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await walk(join(directory, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.isFile()) {
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files;
}

/**
 * One sha256 over every file's relative path and bytes, sorted by path, so
 * equal trees hash equal and any changed byte changes the result. Throws
 * when the directory is missing: a build that produced nothing has no
 * identity to serve.
 */
export async function fingerprintDir(directory) {
  const relative = (await walk(directory)).sort();
  if (relative.length === 0) {
    throw new Error(`${directory} holds no files to fingerprint`);
  }
  const hash = createHash("sha256");
  for (const file of relative) {
    hash.update(file);
    hash.update(await readFile(join(directory, file)));
  }
  return hash.digest("hex");
}
