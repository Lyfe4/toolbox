/**
 * PATCHBAY SERVICE WORKER
 *
 * One job: make the app work with the network switched off. Measured before
 * writing it - without a service worker, an offline reload renders nothing and
 * an offline navigation to a route whose chunk was never fetched fails. That
 * is the whole reason this file exists; it is not here to be a PWA.
 *
 * It is deliberately small, and deliberately biased towards being WRONG in the
 * safe direction: if anything here misbehaves, the worst case must be a
 * network request that did not need to happen, never a visitor pinned to a
 * build from six months ago.
 *
 * WHAT KEEPS IT FROM GOING STALE
 *
 *   1. The cache name contains a build id derived from the asset hashes. A new
 *      build is a new cache, not an update to the old one.
 *   2. Activate deletes every cache that is not the current one, so there is
 *      never more than one build's worth of files on disk.
 *   3. Navigations are NETWORK-FIRST. Online, the document always comes from
 *      the server, so a new deployment is picked up on the next navigation -
 *      even while an old worker is still the one in control.
 *   4. skipWaiting is NOT called. A new worker waits until the last tab using
 *      the old one has gone, so a live page never has its chunks deleted from
 *      underneath it mid-session.
 *
 * (1) and (2) bound how much can be stale; (3) bounds how long.
 *
 * ON CONTENT-SECURITY-POLICY
 *
 * A worker is governed by the CSP served with its own script, and the site's
 * is `connect-src 'none'`. Under that, `cache.addAll` and every `fetch` in
 * here are refused - verified, not assumed. `public/_headers` therefore serves
 * /sw.js with `connect-src 'self'`: this worker may talk to Patchbay's own
 * origin, which is where its cache comes from, and to nowhere else. The page
 * keeps `connect-src 'none'`, so application code still cannot make a request
 * at all. See SECURITY.md, where this exception is written down rather than
 * left to be discovered.
 */

/**
 * Replaced at build time by vite/plugins/service-worker.ts with the real file
 * list and a build id. The values here are what the file says on disk; a build
 * that somehow skipped the plugin precaches nothing and falls through to the
 * network, which is the safe direction to fail in.
 */
const BUILD = '__BUILD_ID__';
const PRECACHE = /** @type {string[]} */ (JSON.parse('__PRECACHE__'));

const CACHE = `patchbay:${BUILD}`;
const DOCUMENT = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      /*
       * addAll is all-or-nothing: one 404 and the whole install fails, which
       * is what we want. A half-populated cache is worse than none, because it
       * looks like it works right up until the missing file is needed.
       */
      cache.addAll(PRECACHE),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('patchbay:') && name !== CACHE)
          .map((name) => caches.delete(name)),
      );
      // Take over open pages now that the old cache is gone, so they are not
      // left being served by a worker whose files no longer exist.
      await self.clients.claim();
    })(),
  );
});

/** Puts a response in the cache without letting a cache failure break the response. */
async function remember(request, response) {
  if (!response.ok || response.type === 'opaque') return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch {
    // Quota, private mode, a racing delete: none of these are worth failing
    // the navigation the visitor is actually waiting on.
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET, only our own origin. Everything else is left entirely alone -
  // not intercepted, not proxied - so it behaves exactly as it would with no
  // worker installed.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    /*
     * Network-first, and this is the anti-staleness rule.
     *
     * The document names the current asset hashes, so serving it from cache is
     * serving the whole build from cache. Online, it always comes fresh; the
     * cached copy is only ever the offline fallback.
     */
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          await remember(new Request(DOCUMENT), response);
          return response;
        } catch {
          const cached = await caches.match(DOCUMENT);
          if (cached) return cached;
          throw new Error('offline and no cached document');
        }
      })(),
    );
    return;
  }

  /*
   * Everything else is cache-first.
   *
   * Safe because these URLs are content-addressed: Vite writes a hash into
   * every filename under /assets/, so the same URL always means the same
   * bytes. The unhashed files - the fonts, the icons - are re-fetched anyway
   * whenever a new build creates a new cache.
   */
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      await remember(request, response);
      return response;
    })(),
  );
});
