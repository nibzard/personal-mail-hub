/*
 * The Home visit identity (SPEC F13): visit tracking is per device, so one
 * device opening Home never clears another device's overview. The identifier
 * lives in local storage, survives reloads, and stays within the 8 to 100
 * characters the service accepts.
 */

const STORAGE_KEY = "mail-hub.home-device";

/** A constant fallback for windows without storage, for example tests. */
const FALLBACK_DEVICE_ID = "web-device-without-storage";

/**
 * This device's Home identifier, created on first use. The identifier is
 * arbitrary; it names a browser profile, not a person.
 */
export function homeDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing !== null && existing.length >= 8 && existing.length <= 100) {
      return existing;
    }
    const created =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `web-device-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    return FALLBACK_DEVICE_ID;
  }
}
