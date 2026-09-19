import { OfflineStore, type LocalUpload } from "@mail-hub/offline";

/*
 * The device's offline store (SPEC F9), opened lazily so import alone never
 * touches IndexedDB. Reads cache downloaded mail here; the sync controller
 * replays drafts, uploads, and queued actions from here.
 */

let store: OfflineStore | null = null;

/**
 * The shared offline store, or `null` where IndexedDB is absent, for example
 * in a test window. Callers treat `null` as "no offline data".
 */
export function offlineStore(): OfflineStore | null {
  if (store === null) {
    if (typeof indexedDB === "undefined") {
      return null;
    }
    store = new OfflineStore();
  }
  return store;
}

/** Forget the shared store. Tests use this between windows. */
export function resetOfflineStore(): void {
  store?.close();
  store = null;
}

/** The upload limit the compose service enforces, mirrored for preflight. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** True when the file fits the upload limit (SPEC F6). */
export function uploadFits(upload: { sizeBytes: number }): boolean {
  return upload.sizeBytes <= UPLOAD_MAX_BYTES;
}

/** One local upload record for the queue, ready to persist. */
export type { LocalUpload };
