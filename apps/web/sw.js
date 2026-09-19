/*
 * The offline shell service worker (SPEC section 6 and F9). The build script
 * `scripts/build-sw.mjs` prepends this file with the build's precache list
 * and version stamp before writing it to `dist/sw.js`, so the two constants
 * below exist by the time this code runs.
 *
 * Contract:
 *
 * - Install precaches the shell under one per-build cache; activate deletes
 *   every older cache before the new build takes over.
 * - Navigations try the network first and fall back to the cached shell, so
 *   an offline reload or an installed launch still opens the app.
 * - Every other same-origin GET reads the cache first.
 * - `/api` requests are never handled: authenticated responses must not sit
 *   in a cache, and the app's own offline store covers mail data (SPEC F9).
 */

const CACHE = `mailhub-shell-${self.__MAILHUB_VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(self.__MAILHUB_PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // The API carries authenticated responses; it never passes through here.
  if (url.pathname.startsWith("/api/")) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(shellNavigation(request));
    return;
  }
  event.respondWith(cachedAsset(request));
});

/** Network first, then the cached shell: an offline reload still opens. */
async function shellNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE);
    return (await cache.match("/index.html")) ?? Response.error();
  }
}

/** Cache first: this build's assets are immutable under their hashed names. */
async function cachedAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) {
    return cached;
  }
  return fetch(request);
}
