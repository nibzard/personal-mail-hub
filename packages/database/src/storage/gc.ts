import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isNotNull } from "drizzle-orm";
import type { MailHubDatabase } from "../index.ts";
import { messages, outboundMessages, uploads } from "../schema.ts";
import { createStorage } from "./fs-object-store.ts";
import { StorageError } from "./object-store.ts";

/*
 * Garbage collection for durable objects (SPEC section 8): removes only
 * objects no table references, only after a grace period longer than the
 * backup window, and never while the backup's collection pause marker
 * (deploy/backup.sh) exists.
 */

/**
 * How long an unreferenced object must have sat before collection may
 * remove it. The bound exceeds the nightly backup window by days, so a
 * transaction that drops a reference can never race the sweep, and an
 * operator who restores a same-week backup still finds the objects that
 * backup's snapshot referenced.
 */
export const DURABLE_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Marker directory the backup script claims and releases. */
export const GC_PAUSE_DIR = "gc-pause";

/** What one collection pass found and did. */
export interface CollectionSummary {
  /** Durable objects the pass examined. */
  considered: number;
  /** Objects removed; none was referenced by any table. */
  removed: number;
  /** Bytes the removed objects held. */
  bytesFreed: number;
  /** Unreferenced objects kept, because the grace period had not passed. */
  retainedByGrace: number;
  /** True when the backup's pause marker stopped the pass. */
  paused: boolean;
}

/**
 * Collect durable objects nothing references. The pass lists the durable
 * tree, queries every table that holds a durable key, and removes only the
 * unreferenced objects past the grace period. Sidecar `.meta.json` files and
 * `.tmp-` debris are not objects; the temp sweep owns the debris.
 */
export async function collectUnreferencedDurableObjects(input: {
  root: string;
  db: MailHubDatabase;
  graceMs?: number;
  now?: () => number;
  remove?: (key: string) => Promise<boolean>;
}): Promise<CollectionSummary> {
  const graceMs = input.graceMs ?? DURABLE_GC_GRACE_MS;
  const now = input.now ?? Date.now;
  const durableRoot = join(input.root, "durable");
  const remove =
    input.remove ??
    (() => {
      // Removal rides the real durable store, so the sidecar goes with the
      // object and the directory entry is synced.
      const store = createStorage(input.root).durable;
      return (key: string) =>
        store.remove(key).catch((cause: unknown) => {
          if (cause instanceof StorageError) {
            return false;
          }
          throw cause;
        });
    })();

  const summary: CollectionSummary = {
    considered: 0,
    removed: 0,
    bytesFreed: 0,
    retainedByGrace: 0,
    paused: false,
  };

  // The backup claims the marker before its snapshot and releases it when
  // the whole bundle ends. While it exists, no durable object may go.
  if (existsSync(join(input.root, GC_PAUSE_DIR))) {
    summary.paused = true;
    return summary;
  }

  const referenced = await referencedDurableKeys(input.db);
  for (const key of await listObjectKeys(durableRoot)) {
    summary.considered += 1;
    if (referenced.has(key)) {
      continue;
    }
    const objectStat = await stat(join(durableRoot, ...key.split("/"))).catch(() => null);
    if (objectStat === null) {
      // The object raced a writer or another pass; the next pass retries it.
      continue;
    }
    if (now() - objectStat.mtimeMs < graceMs) {
      summary.retainedByGrace += 1;
      continue;
    }
    if (await remove(key)) {
      summary.removed += 1;
      summary.bytesFreed += objectStat.size;
    }
  }
  return summary;
}

/** Every durable key some table still references, as one set. */
async function referencedDurableKeys(db: MailHubDatabase): Promise<Set<string>> {
  const [originalRows, uploadRows, outboundRows] = await Promise.all([
    db
      .select({ key: messages.originalStorageKey })
      .from(messages)
      .where(isNotNull(messages.originalStorageKey)),
    db.select({ key: uploads.storageKey }).from(uploads),
    db.select({ key: outboundMessages.mimeStorageKey }).from(outboundMessages),
  ]);
  const keys = new Set<string>();
  for (const row of [...originalRows, ...uploadRows, ...outboundRows]) {
    if (typeof row.key === "string" && row.key.length > 0) {
      keys.add(row.key);
    }
  }
  return keys;
}

/**
 * Relative object keys in the durable tree, skipping `.meta.json` sidecars
 * and `.tmp-` debris. A name the key validator would reject cannot be
 * removed through the store, so removal refuses it instead of guessing at
 * the path.
 */
async function listObjectKeys(durableRoot: string): Promise<string[]> {
  const keys: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp-") || entry.name.endsWith(".meta.json")) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (entry.isFile()) {
        keys.push(`${prefix}${entry.name}`);
      }
    }
  }
  await walk(durableRoot, "");
  return keys.sort();
}
