import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V9.1 §8 — THE OFFLINE COPY IS THE OWNER'S, AND ONLY WHILE THEY ARE SIGNED IN.
 *
 * The service worker is executed here, not grepped: the file is loaded into a
 * VM with a fake `caches`, a fake `fetch` and a fake `self`, and driven with
 * the same events a browser sends — install, activate, fetch, message. What
 * is proven is what it does, not what its comments say.
 *
 * "User A cannot read user B's offline packet" is proven by construction,
 * from the two facts the code guarantees:
 *
 *   1. The cache key is the URL, and the page under that URL is owner-gated
 *      when it is fetched: the worker only ever stores what the server just
 *      answered for this browser's cookie, and only serves it back for the
 *      same URL. It never derives one page from another, never synthesises
 *      trip content, and never touches `/api`, `/auth`, `/signin`, a non-GET
 *      or a response that set a cookie — so nothing in the cache was ever
 *      readable by a browser that could not read it live.
 *   2. Signing out clears every `sidequest-trip-*` cache and every "saved"
 *      marker *before* the session ends (`signOutAfterClearing`), and
 *      registering the worker at sign-in caches nothing (the registrar only
 *      registers; install and activate store no page). So the next person on
 *      the same device starts from an empty cache and fills it only with
 *      pages the server answers for *their* cookie.
 *
 * Together: the only way a page reaches the cache is a fetch the server
 * allowed for the signed-in owner, and the cache does not outlive their
 * session on a shared device.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(HERE, '../../../public/trip-offline-sw.js');
const REGISTRAR_PATH = resolve(HERE, '../../components/ServiceWorkerRegistrar.tsx');
const SIGN_OUT_PATH = resolve(HERE, '../../components/SignOutButton.tsx');
const ORIGIN = 'https://sidequest.test';

vi.mock('@/app/(product)/trips/[id]/itinerary/actions', () => ({ setCheckAction: vi.fn(async () => ({ ok: true })) }));
const signOutLog: string[] = [];
vi.mock('@/app/(product)/signin/actions', () => ({
  signOutAction: vi.fn(async () => {
    signOutLog.push('signOut');
  }),
}));

type ResponseLike = { ok: boolean; status: number; type: string; headers: Headers; body: string; clone(): ResponseLike };

function fakeResponse(body: string, init: { status?: number; type?: string; headers?: Record<string, string> } = {}): ResponseLike {
  const status = init.status ?? 200;
  const response: ResponseLike = {
    ok: status >= 200 && status < 300,
    status,
    type: init.type ?? 'basic',
    headers: new Headers(init.headers ?? {}),
    body,
    clone() {
      return { ...response, headers: new Headers(response.headers) };
    },
  };
  return response;
}

function urlOf(request: unknown): string {
  return typeof request === 'string' ? request : (request as { url: string }).url;
}

class FakeCache {
  store = new Map<string, unknown>();
  async put(request: unknown, response: unknown): Promise<void> {
    this.store.set(urlOf(request), response);
  }
  async match(request: unknown, options?: { ignoreSearch?: boolean }): Promise<unknown> {
    const wanted = new URL(urlOf(request));
    for (const [key, value] of this.store) {
      const stored = new URL(key);
      if (options?.ignoreSearch ? stored.origin + stored.pathname === wanted.origin + wanted.pathname : key === wanted.toString()) return value;
    }
    return undefined;
  }
  async keys(): Promise<{ url: string }[]> {
    return [...this.store.keys()].map((url) => ({ url }));
  }
}

class FakeCaches {
  caches = new Map<string, FakeCache>();
  deleted: string[] = [];
  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.caches.delete(name);
  }
  async match(request: unknown, options?: { ignoreSearch?: boolean }): Promise<unknown> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request, options);
      if (hit) return hit;
    }
    return undefined;
  }
  stored(): Record<string, string[]> {
    return Object.fromEntries([...this.caches].map(([name, cache]) => [name, [...cache.store.keys()].sort()]));
  }
}

interface Worker {
  caches: FakeCaches;
  fetch: ReturnType<typeof vi.fn>;
  fetchEvent(request: Request): Promise<{ intercepted: boolean; response?: ResponseLike | Response }>;
  message(data: unknown): Promise<void>;
  lifecycle(kind: 'install' | 'activate'): Promise<void>;
}

/** Load the worker file into a fresh scope and hand back a driver for its events. */
function loadWorker(caches = new FakeCaches()): Worker {
  const listeners = new Map<string, ((event: unknown) => unknown)[]>();
  const self = {
    location: new URL(`${ORIGIN}/`),
    addEventListener(type: string, fn: (event: unknown) => unknown) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const fetch = vi.fn(async (_input: unknown, _init?: unknown): Promise<ResponseLike> => fakeResponse('<html>live</html>'));
  const context = vm.createContext({ self, caches, fetch, Response, Headers, URL, Promise, console });
  vm.runInContext(readFileSync(SW_PATH, 'utf8'), context, { filename: 'trip-offline-sw.js' });
  const dispatch = (type: string, event: Record<string, unknown>) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    caches,
    fetch,
    async fetchEvent(request) {
      let promised: Promise<ResponseLike | Response> | undefined;
      dispatch('fetch', {
        request,
        respondWith: (p: Promise<ResponseLike | Response>) => {
          promised = p;
        },
      });
      if (!promised) return { intercepted: false };
      const response = await promised;
      /* Let the fire-and-forget cache write settle. */
      await new Promise((r) => setTimeout(r, 0));
      return { intercepted: true, response };
    },
    async message(data) {
      const waits: Promise<unknown>[] = [];
      dispatch('message', { data, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
    async lifecycle(kind) {
      const waits: Promise<unknown>[] = [];
      dispatch(kind, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    },
  };
}

const get = (path: string, origin = ORIGIN) => new Request(`${origin}${path}`);

describe('the trip service worker, executed', () => {
  it('registers, installs and activates without caching a single page, and drops earlier sidequest-trip-* caches only', async () => {
    const caches = new FakeCaches();
    await caches.open('sidequest-trip-v1');
    await caches.open('workbox-precache-somebody-else');
    const worker = loadWorker(caches);
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(caches.stored()).toEqual({ 'workbox-precache-somebody-else': [] });
    expect(caches.deleted).toEqual(['sidequest-trip-v1']);
  });

  it('intercepts only the itinerary, Today, the Pack, a share page and the static assets', async () => {
    const worker = loadWorker();
    const allowed = ['/trips/abc/itinerary', '/trips/abc/itinerary/', '/trips/abc/today', '/trips/abc/pack', '/share/tok-123', '/_next/static/chunks/app.js'];
    const refused = ['/api/calendar/AAAA', '/api/place-photo', '/auth/callback', '/signin', '/signin/', '/trips', '/trips/abc', '/trips/abc/itinerary/calendar', '/trips/abc/questionnaire', '/trips/abc/itinerary/print', '/profile', '/', '/manifest.webmanifest'];
    for (const path of allowed) {
      const result = await worker.fetchEvent(get(path));
      expect(result.intercepted, `${path} should be handled by the worker`).toBe(true);
    }
    for (const path of refused) {
      const result = await worker.fetchEvent(get(path));
      expect(result.intercepted, `${path} must never be handled by the worker`).toBe(false);
    }
    expect(Object.values(worker.caches.stored()).flat().sort()).toEqual(allowed.map((p) => `${ORIGIN}${p}`).sort());
  });

  it('leaves a non-GET and a foreign origin alone', async () => {
    const worker = loadWorker();
    expect((await worker.fetchEvent(new Request(`${ORIGIN}/trips/abc/itinerary`, { method: 'POST' }))).intercepted).toBe(false);
    expect((await worker.fetchEvent(get('/trips/abc/itinerary', 'https://evil.example'))).intercepted).toBe(false);
    expect(worker.caches.stored()).toEqual({});
  });

  it('never stores a response that set a cookie, was not OK, or was not a plain same-origin answer', async () => {
    const worker = loadWorker();
    worker.fetch.mockImplementationOnce(async () => fakeResponse('with cookie', { headers: { 'set-cookie': 'sidequest_session=abc' } }));
    await worker.fetchEvent(get('/trips/a/itinerary'));
    worker.fetch.mockImplementationOnce(async () => fakeResponse('gone', { status: 404 }));
    await worker.fetchEvent(get('/trips/b/itinerary'));
    worker.fetch.mockImplementationOnce(async () => fakeResponse('redirected', { status: 302 }));
    await worker.fetchEvent(get('/trips/c/itinerary'));
    worker.fetch.mockImplementationOnce(async () => fakeResponse('opaque', { type: 'opaque' }));
    await worker.fetchEvent(get('/trips/d/itinerary'));
    expect(worker.caches.stored()).toEqual({});
    /* The live answer still reaches the page: the worker passes it through untouched. */
    worker.fetch.mockImplementationOnce(async () => fakeResponse('signed-out-redirect', { status: 303 }));
    const passthrough = await worker.fetchEvent(get('/trips/e/itinerary'));
    expect((passthrough.response as ResponseLike).status).toBe(303);
  });

  it('offline: serves the exact copy the server last gave this browser, and a 503 that is never cached for a page it never had', async () => {
    const worker = loadWorker();
    worker.fetch.mockImplementationOnce(async () => fakeResponse('<html>B itinerary as rendered for B</html>'));
    await worker.fetchEvent(get('/trips/B/itinerary'));
    worker.fetch.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const hit = await worker.fetchEvent(get('/trips/B/itinerary?view=days'));
    expect((hit.response as ResponseLike).body).toBe('<html>B itinerary as rendered for B</html>');
    const miss = await worker.fetchEvent(get('/trips/A/itinerary'));
    const fallback = miss.response as Response;
    expect(fallback.status).toBe(503);
    expect(fallback.headers.get('cache-control')).toBe('no-store');
    const html = await fallback.text();
    expect(html).toContain('not saved for offline use');
    expect(html).not.toContain('B itinerary as rendered for B');
    /* A static asset that was never cached answers an empty 503, never another URL's bytes. */
    const asset = await worker.fetchEvent(get('/_next/static/chunks/missing.js'));
    expect((asset.response as Response).status).toBe(503);
    expect(await (asset.response as Response).text()).toBe('');
  });

  it('the snapshot message fetches with this browser’s own cookie and stores only an offline surface', async () => {
    const worker = loadWorker();
    await worker.message({ type: 'snapshot', url: '/trips/abc/today' });
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    expect(worker.fetch.mock.calls[0]![0]).toBe(`${ORIGIN}/trips/abc/today`);
    expect(worker.fetch.mock.calls[0]![1]).toEqual({ credentials: 'same-origin' });
    await worker.message({ type: 'snapshot', url: '/api/calendar/AAAA' });
    await worker.message({ type: 'snapshot', url: '/signin' });
    await worker.message({ type: 'snapshot', url: 'https://evil.example/trips/abc/today' });
    await worker.message({ type: 'snapshot', url: 42 });
    await worker.message({ type: 'snapshot' });
    await worker.message(null);
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    expect(worker.caches.stored()).toEqual({ 'sidequest-trip-v2': [`${ORIGIN}/trips/abc/today`] });
  });

  it('the clear message deletes every sidequest-trip-* cache and nothing else', async () => {
    const caches = new FakeCaches();
    await caches.open('sidequest-trip-v1');
    await caches.open('sidequest-trip-v2');
    await caches.open('sidequest-trip-v3-future');
    await caches.open('workbox-precache-somebody-else');
    const worker = loadWorker(caches);
    await worker.fetchEvent(get('/trips/abc/itinerary'));
    await worker.message({ type: 'clear' });
    expect(caches.stored()).toEqual({ 'workbox-precache-somebody-else': [] });
  });

  it('holds no trip content of its own — every byte it can serve came from a fetch the server answered for this browser', () => {
    const source = readFileSync(SW_PATH, 'utf8');
    expect(source).not.toMatch(/localStorage|indexedDB|importScripts|eval\(/);
    expect(source).toMatch(/credentials: 'same-origin'/);
    expect(source).toMatch(/request\.method !== 'GET'/);
    expect(source).toMatch(/set-cookie/);
    expect(source).toMatch(/url\.origin !== self\.location\.origin/);
  });
});

describe('the browser side of the guarantee', () => {
  const clearLog: string[] = [];

  function fakeWindow(): { window: Record<string, unknown>; caches: FakeCaches; storage: Record<string, string> } {
    const storage: Record<string, string> = {};
    const localStorage = Object.create(null) as Record<string, unknown>;
    const define = (name: string, fn: unknown) => Object.defineProperty(localStorage, name, { value: fn, enumerable: false });
    define('getItem', (key: string) => (key in storage ? storage[key] : null));
    define('setItem', (key: string, value: string) => {
      storage[key] = value;
      localStorage[key] = value;
    });
    define('removeItem', (key: string) => {
      delete storage[key];
      delete localStorage[key];
    });
    const caches = new FakeCaches();
    const originalDelete = caches.delete.bind(caches);
    caches.delete = async (name: string) => {
      clearLog.push(`delete:${name}`);
      return originalDelete(name);
    };
    const window = { localStorage, caches };
    return { window, caches, storage };
  }

  beforeEach(() => {
    clearLog.length = 0;
    signOutLog.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clearOfflineSnapshots deletes every sidequest-trip-* cache and every saved marker, and tells the worker to do the same', async () => {
    const { window, caches, storage } = fakeWindow();
    (window.localStorage as Storage).setItem('sidequest-offline:/trips/abc/itinerary', '1757600000000');
    (window.localStorage as Storage).setItem('sidequest-offline:/trips/abc/today', '1757600000000');
    (window.localStorage as Storage).setItem('sidequest-something-else', 'keep');
    await caches.open('sidequest-trip-v2');
    await caches.open('sidequest-trip-v1');
    await caches.open('other-app');
    const postMessage = vi.fn();
    vi.stubGlobal('window', window);
    vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });

    const { clearOfflineSnapshots } = await import('@/components/OfflineSnapshot');
    await clearOfflineSnapshots();
    expect(Object.keys(storage)).toEqual(['sidequest-something-else']);
    expect(await caches.keys()).toEqual(['other-app']);
    expect(postMessage).toHaveBeenCalledWith({ type: 'clear' });
  });

  it('sign-out forgets the offline copies before the session ends, and still signs out when forgetting fails', async () => {
    const { window, caches } = fakeWindow();
    await caches.open('sidequest-trip-v2');
    vi.stubGlobal('window', window);
    vi.stubGlobal('navigator', { serviceWorker: undefined });
    const { signOutAfterClearing } = await import('@/components/SignOutButton');
    const { signOutAction } = await import('@/app/(product)/signin/actions');

    await signOutAfterClearing();
    expect(clearLog).toEqual(['delete:sidequest-trip-v2']);
    expect(signOutLog).toEqual(['signOut']);
    expect(signOutAction).toHaveBeenCalledTimes(1);
    expect(await caches.keys()).toEqual([]);

    /* The explicit order, with spies: clear resolves before signOut is even called. */
    const order: string[] = [];
    await signOutAfterClearing({
      clear: async () => {
        order.push('clear');
      },
      signOut: async () => {
        order.push('signOut');
      },
    });
    expect(order).toEqual(['clear', 'signOut']);
    await signOutAfterClearing({
      clear: async () => {
        throw new Error('no cache access');
      },
      signOut: async () => {
        order.push('signOut-after-failure');
      },
    });
    expect(order).toContain('signOut-after-failure');
  });

  it('the button is wired to that sequence, and the registrar only registers — it never asks the worker to keep a page', () => {
    const button = readFileSync(SIGN_OUT_PATH, 'utf8');
    expect(button).toMatch(/startTransition\(\(\) => signOutAfterClearing\(\)\)/);
    const registrar = readFileSync(REGISTRAR_PATH, 'utf8');
    expect(registrar).toMatch(/serviceWorker\.register\(/);
    expect(registrar).not.toMatch(/postMessage|snapshot|caches\.|fetch\(/);
    expect(registrar).toMatch(/updateViaCache: 'none'/);
  });
});
