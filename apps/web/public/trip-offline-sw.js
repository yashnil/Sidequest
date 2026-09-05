/*
 * SIDEQUEST — OFFLINE TRIP SNAPSHOT (LIVE WORLD V1)
 *
 * Caches the itinerary pages a traveller has opened, so the plan they saved
 * opens on a mountain with no signal. Network first, cache fallback: a live
 * render always wins, and the cached copy is exactly the last one the server
 * produced — never a stale-but-edited hybrid. Only same-origin itinerary,
 * share, calendar and static asset requests are cached; nothing else.
 */
const CACHE = 'sidequest-trip-v1';
const CACHEABLE = /^\/(trips\/[^/]+\/itinerary(\/calendar)?|share\/[^/]+)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'snapshot' && typeof data.url === 'string') {
    event.waitUntil(
      caches.open(CACHE).then((cache) =>
        fetch(data.url, { credentials: 'same-origin' })
          .then((response) => (response.ok ? cache.put(data.url, response.clone()) : null))
          .catch(() => null),
      ),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isPage = CACHEABLE.test(url.pathname);
  const isAsset = url.pathname.startsWith('/_next/static/');
  if (!isPage && !isAsset) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => null);
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || new Response('This page is not saved for offline use yet. Open it once while online.', { status: 503, headers: { 'Content-Type': 'text/plain' } }))),
  );
});
