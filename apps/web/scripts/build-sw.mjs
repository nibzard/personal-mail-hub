#!/usr/bin/env node
/*
 * Builds `dist/sw.js`, the offline shell worker (SPEC section 6 and F9).
 * Vite emits the hashed assets; this script then walks `dist`, lists every
 * file as the worker's precache set, and stamps the cache name with a hash
 * of the build. A deploy with new assets therefore cannot serve a stale
 * shell: the worker installs a fresh cache and deletes the old one.
 *
 * Chained after `vite build` in `package.json`. Usage: `node scripts/build-sw.mjs`.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));

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

const workerSource = await readFile(fileURLToPath(new URL("../sw.js", import.meta.url)), "utf8");
const relative = (await walk(distDir)).filter((file) => file !== "sw.js").sort();
const contents = await Promise.all(relative.map((file) => readFile(join(distDir, file))));

const hash = createHash("sha256");
relative.forEach((file, index) => {
  hash.update(file);
  hash.update(contents[index]);
});
const version = hash.digest("hex");

// The constants `sw.js` reads. They sit before the worker source, so the
// file stays plain JavaScript with no bundler step of its own.
const prelude = `self.__MAILHUB_PRECACHE = ${JSON.stringify(relative.map((file) => `/${file}`))};
self.__MAILHUB_VERSION = ${JSON.stringify(version)};
`;

await writeFile(join(distDir, "sw.js"), prelude + workerSource);
console.log(`sw: precached ${relative.length} files as ${version.slice(0, 12)}`);
