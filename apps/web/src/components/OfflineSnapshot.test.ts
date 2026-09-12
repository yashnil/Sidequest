import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * V9.1 §8 — THE "SAVED FOR OFFLINE" INDICATOR AND ITS SIGN-OUT COUNTERPART.
 *
 * `clearOfflineSnapshots` is the one function that forgets what the service
 * worker kept: every `sidequest-trip-*` cache, every `sidequest-offline:`
 * marker, and a `clear` message to the worker in control. It must do all
 * three, touch nothing else, and never throw — a browser with no worker, no
 * cache access or no storage still ends the call cleanly, because sign-out
 * runs it first and must always finish.
 */
vi.mock('@/app/(product)/trips/[id]/itinerary/actions', () => ({ setCheckAction: vi.fn(async () => ({ ok: true })) }));

function fakeLocalStorage(): { storage: Storage; keys: () => string[] } {
  const data: Record<string, string> = {};
  const storage = Object.create(null) as Record<string, unknown>;
  const define = (name: string, fn: unknown) => Object.defineProperty(storage, name, { value: fn, enumerable: false });
  define('getItem', (key: string) => (key in data ? data[key] : null));
  define('setItem', (key: string, value: string) => {
    data[key] = value;
    storage[key] = value;
  });
  define('removeItem', (key: string) => {
    delete data[key];
    delete storage[key];
  });
  return { storage: storage as unknown as Storage, keys: () => Object.keys(data) };
}

function fakeCaches(names: string[]): { caches: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> }; remaining: () => string[] } {
  const set = new Set(names);
  return {
    caches: {
      keys: async () => [...set],
      delete: async (name: string) => set.delete(name),
    },
    remaining: () => [...set],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clearOfflineSnapshots', () => {
  it('deletes every sidequest-trip-* cache and every saved marker, leaves the rest, and posts clear to the worker', async () => {
    const { storage, keys } = fakeLocalStorage();
    storage.setItem('sidequest-offline:/trips/t1/itinerary', '1757600000000');
    storage.setItem('sidequest-offline:/trips/t1/today', '1757600000000');
    storage.setItem('sidequest-offline:/trips/t2/pack', '1757600000000');
    storage.setItem('sidequest_theme', 'atlas');
    const { caches, remaining } = fakeCaches(['sidequest-trip-v1', 'sidequest-trip-v2', 'next-pwa-images', 'sidequest-trip-v9']);
    const postMessage = vi.fn();
    vi.stubGlobal('window', { localStorage: storage, caches });
    vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });

    const { clearOfflineSnapshots } = await import('./OfflineSnapshot');
    await clearOfflineSnapshots();

    expect(keys()).toEqual(['sidequest_theme']);
    expect(remaining()).toEqual(['next-pwa-images']);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'clear' });
  });

  it('ends cleanly with no worker, no cache access, a storage that throws, or no window at all', async () => {
    const throwingStorage = new Proxy({} as Storage, {
      get() {
        throw new Error('storage disabled');
      },
      ownKeys() {
        throw new Error('storage disabled');
      },
    });
    const caches = {
      keys: async () => {
        throw new Error('caches disabled');
      },
      delete: async () => false,
    };
    vi.stubGlobal('window', { localStorage: throwingStorage, caches });
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
    const { clearOfflineSnapshots } = await import('./OfflineSnapshot');
    await expect(clearOfflineSnapshots()).resolves.toBeUndefined();

    vi.stubGlobal('window', { localStorage: fakeLocalStorage().storage });
    vi.stubGlobal('navigator', {});
    await expect(clearOfflineSnapshots()).resolves.toBeUndefined();

    vi.unstubAllGlobals();
    vi.stubGlobal('window', undefined);
    await expect(clearOfflineSnapshots()).resolves.toBeUndefined();
  });
});

describe('the OfflineSnapshot indicator, rendered on the server', () => {
  it('says it is saving, names its test id and state, and never claims a copy it has not made', async () => {
    const { OfflineSnapshot } = await import('./OfflineSnapshot');
    const html = renderToStaticMarkup(createElement(OfflineSnapshot, { path: '/trips/t1/today', tripId: 't1', testId: 'today-offline-state' }));
    expect(html).toContain('data-testid="today-offline-state"');
    expect(html).toContain('data-state="saving"');
    expect(html).toContain('Saving for offline use…');
    expect(html).not.toContain('Saved ·');
    expect(html).toContain('print:hidden');
  });
});
