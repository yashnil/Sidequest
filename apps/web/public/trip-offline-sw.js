/*
 * SIDEQUEST — OFFLINE TRIP SNAPSHOT, v2 (V9 §11)
 *
 * Keeps the pages a traveller has opened — a trip's itinerary, its Today
 * page, its Trip Pack, a shared plan — so they open on a mountain with no
 * signal. Network first, cache fallback: a live render always wins, and the
 * cached copy is exactly the last one the server produced, never a
 * stale-but-edited hybrid.
 *
 * What is never cached: anything under /api (the calendar feed included),
 * /auth, /signin, any non-GET, any response that is not a plain OK, and any
 * response that sets a cookie. A {type:'clear'} message deletes every cache —
 * the sign-out counterpart of saving. The offline fallback page lists which
 * pages are saved, so "not saved yet" is a sentence with a remedy.
 */
const CACHE = 'sidequest-trip-v2';
const PAGE = /^\/(trips\/[^/]+\/(itinerary|today|pack)|share\/[^/]+)\/?$/;
const NEVER = /^\/(api|auth|signin)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE && name.startsWith('sidequest-trip-')).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (NEVER.test(url.pathname)) return false;
  return PAGE.test(url.pathname) || url.pathname.startsWith('/_next/static/');
}

function storable(response) {
  if (!response || !response.ok || response.type !== 'basic') return false;
  if (response.headers.has('set-cookie')) return false;
  return true;
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'snapshot' && typeof data.url === 'string') {
    let url;
    try {
      url = new URL(data.url, self.location.origin);
    } catch {
      return;
    }
    if (!cacheable(url)) return;
    event.waitUntil(
      caches.open(CACHE).then((cache) =>
        fetch(url.toString(), { credentials: 'same-origin' })
          .then((response) => (storable(response) ? cache.put(url.toString(), response.clone()) : null))
          .catch(() => null),
      ),
    );
  }
  if (data.type === 'clear') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith('sidequest-trip-')).map((name) => caches.delete(name)))));
  }
});

function offlinePage(url) {
  return caches.open(CACHE).then(async (cache) => {
    const keys = await cache.keys();
    const pages = keys
      .map((request) => new URL(request.url).pathname)
      .filter((pathname) => PAGE.test(pathname))
      .sort();
    const list = pages.length > 0 ? `<ul>${pages.map((p) => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>` : '<p>No pages are saved yet.</p>';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not saved for offline use — Sidequest</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:32px 20px;background:#f6f3ed;color:#17181a;line-height:1.5}main{max-width:36rem;margin:0 auto}h1{font-size:1.4rem}a{color:#a94f27}ul{padding-left:1.2rem}code{background:#efe9de;padding:0 .3em;border-radius:4px}</style></head><body><main><h1>This page is not saved for offline use yet</h1><p>You are offline and <code>${url.pathname}</code> has not been opened while online, so there is no saved copy of it. Open it once with a connection and it will be kept.</p><h2>Pages saved on this device</h2>${list}</main></body></html>`;
    return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!cacheable(url)) return;
  const isPage = PAGE.test(url.pathname);
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (storable(response)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => null);
        }
        return response;
      })
      .catch(() =>
        caches.match(request, { ignoreSearch: isPage }).then((hit) => {
          if (hit) return hit;
          if (isPage) return offlinePage(url);
          return new Response('', { status: 503 });
        }),
      ),
  );
});
