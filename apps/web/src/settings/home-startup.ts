/*
 * The startup view choice (SPEC F13): `homeEnabled` decides whether the app
 * opens on Home or Inbox. The server stores the setting, but the choice must
 * be known before the first render, so the shell never paints Inbox and then
 * switches to Home. This module keeps the last confirmed choice in local
 * storage: the settings context writes it after every confirmed read and
 * save, and the shell reads it synchronously while it mounts.
 */

/** The local storage key the confirmed choice lives under. */
export const STORAGE_KEY = "mail-hub.home-startup";

/**
 * The last confirmed startup choice, or `true` when none is stored or the
 * store cannot be read. The default matches the server's `homeEnabled`
 * default, so a fresh device opens on Home.
 */
export function readCachedHomeStartup(): boolean {
  return readConfirmedHomeStartup() ?? true;
}

/** No cache is distinct from an explicit Home choice after a failed read. */
export function readConfirmedHomeStartup(): boolean | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

/** Records the last confirmed choice for the next startup. */
export function writeCachedHomeStartup(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Without storage the choice just does not survive to the next start.
  }
}
