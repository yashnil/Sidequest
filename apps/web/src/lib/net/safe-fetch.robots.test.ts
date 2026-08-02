import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROBOTS.TXT IS NOT THE PAGE.
 *
 * `fetchIfAllowed` makes two requests to two different resources, and the whole
 * value of the permission check depends on keeping them apart. These tests
 * intercept the transport itself — `node:https` — because that is the layer
 * `safeFetch` actually uses, so they observe the real request headers rather
 * than a re-implementation of them. Nothing here touches DNS or a network.
 */

interface Sent {
  url: string;
  headers: Record<string, string>;
}

const sent: Sent[] = [];
/** What robots.txt answers. Set per test. */
let robotsBody = 'User-agent: *\nAllow: /\n';

vi.mock('node:https', () => ({
  request: (options: Record<string, unknown>, callback: (res: Readable) => void) => {
    const path = String(options.path ?? '/');
    const url = `https://${String(options.hostname)}${path}`;
    sent.push({
      url,
      headers: Object.fromEntries(
        Object.entries((options.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
    });

    const isRobots = path === '/robots.txt';
    const response = Readable.from([
      Buffer.from(isRobots ? robotsBody : '<p>Open daily, 09:00 to 17:00.</p>'),
    ]) as Readable & { statusCode: number; headers: Record<string, string> };
    response.statusCode = 200;
    response.headers = { 'content-type': isRobots ? 'text/plain' : 'text/html' };

    const request = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: () => void;
      setTimeout: (ms: number, fn: () => void) => void;
    };
    request.end = () => {
      setImmediate(() => callback(response));
    };
    request.destroy = () => {};
    request.setTimeout = () => {};
    return request;
  },
}));

const { fetchIfAllowed } = await import('./safe-fetch');

async function run(options: Parameters<typeof fetchIfAllowed>[1] = {}): Promise<void> {
  await fetchIfAllowed('https://museum.example/visit', {
    resolve: async () => ['93.184.216.34'],
    ...options,
  }).catch(() => undefined);
}

beforeEach(() => {
  sent.length = 0;
  robotsBody = 'User-agent: *\nAllow: /\n';
});

describe('robots.txt is asked about separately from the page', () => {
  it('never sends the page’s validators to robots.txt', async () => {
    /**
     * Forwarding the page's ETag as a condition on robots.txt invites a strict
     * server to answer 304 — and an empty body reads as "no rules stated", which
     * is the *permissive* answer. A caching mistake would silently become a
     * permission mistake, which is the one class of bug here that is nobody
     * else's fault.
     */
    await run({ validators: { etag: '"page-v1"' } });

    const robots = sent.find((call) => call.url.endsWith('/robots.txt'));
    const page = sent.find((call) => !call.url.endsWith('/robots.txt'));
    expect(robots).toBeDefined();
    expect(robots?.headers['if-none-match']).toBeUndefined();
    expect(page?.headers['if-none-match']).toBe('"page-v1"');
  });

  it('never requests the page at all once robots has said no', async () => {
    robotsBody = 'User-agent: *\nDisallow: /visit\n';
    await run();
    expect(sent.map((call) => call.url)).toEqual(['https://museum.example/robots.txt']);
  });

  it('asks robots first, every time, before the page', async () => {
    await run();
    expect(sent[0]?.url).toBe('https://museum.example/robots.txt');
    expect(sent[1]?.url).toBe('https://museum.example/visit');
  });
});
