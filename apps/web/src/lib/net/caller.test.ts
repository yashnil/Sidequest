import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT THE LIMITER IS ENTITLED TO BELIEVE ABOUT WHO IS ASKING.
 *
 * `rate-limit.test.ts` proves the bucket arithmetic. It says nothing about
 * identity, and identity is where the limiter was actually defeated: the old
 * derivation took the **leftmost** `x-forwarded-for` element, which is by
 * definition what the client sent, so one header line bought a virgin bucket
 * and every fence in front of the paid actions was decorative.
 *
 * These tests state the two properties that replaced it. Rotating a spoofable
 * value must not buy a new bucket, and a deployment that cannot attribute a
 * request must still bound it.
 */

const jar = new Map<string, string>();
const sent = new Map<string, string>();

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string) => sent.get(name.toLowerCase()) ?? null,
  }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  sent.clear();
  delete process.env.SIDEQUEST_TRUSTED_PROXY_HOPS;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-caller-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_TRUSTED_PROXY_HOPS;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('deriving an address from x-forwarded-for', () => {
  it('derives none at all when no proxy hop count is configured', async () => {
    // The header is present and well-formed. It is still worthless: with
    // nothing in front of the app, every element of it is client-written.
    sent.set('x-forwarded-for', '203.0.113.9');
    const { callerAddress } = await import('./caller');
    expect(await callerAddress()).toBeNull();
  });

  it('counts from the right, past exactly the configured trusted hops', async () => {
    process.env.SIDEQUEST_TRUSTED_PROXY_HOPS = '1';
    sent.set('x-forwarded-for', '198.51.100.7, 203.0.113.9');
    const { callerAddress } = await import('./caller');
    // The last element is what our own edge observed; the first is whatever the
    // client chose to prepend.
    expect(await callerAddress()).toBe('203.0.113.9');
  });

  it('treats a garbage hop count as no trusted proxy, never as trust the client', async () => {
    process.env.SIDEQUEST_TRUSTED_PROXY_HOPS = 'yes please';
    sent.set('x-forwarded-for', '203.0.113.9');
    const { callerAddress } = await import('./caller');
    expect(await callerAddress()).toBeNull();
  });

  it('invents no peer when the trusted proxy sent no header', async () => {
    /*
     * The old derivation ended `|| 'local'`, so a request with no forwarding
     * header at all was attributed to a single literal bucket shared by every
     * such request. Absent is absent now: there is no address, and the
     * deployment fence is what bounds the request.
     */
    process.env.SIDEQUEST_TRUSTED_PROXY_HOPS = '1';
    const { callerAddress, requestIdentities } = await import('./caller');
    expect(await callerAddress()).toBeNull();
    expect((await requestIdentities()).some((identity) => identity.startsWith('ip:'))).toBe(false);
  });
});

describe('the fence a rotating header cannot escape', () => {
  it('keeps a spoofed leftmost element in the same bucket behind a trusted proxy', async () => {
    process.env.SIDEQUEST_TRUSTED_PROXY_HOPS = '1';
    const { guardAction } = await import('./caller');
    const { ACTION_RATE_RULES } = await import('./rate-limit');

    /*
     * The attack, exactly: a fresh claimed address on every request, with the
     * cookie discarded each time. Only the rightmost element — the one our own
     * proxy wrote — is stable, and it is the one that must decide the bucket.
     */
    const results: (string | null)[] = [];
    for (let attempt = 0; attempt < ACTION_RATE_RULES.destination_resolve.capacity + 1; attempt += 1) {
      jar.clear();
      sent.set('x-forwarded-for', `10.0.0.${attempt}, 203.0.113.9`);
      results.push(await guardAction('destination_resolve'));
    }

    expect(results.slice(0, -1).every((result) => result === null)).toBe(true);
    expect(results[results.length - 1]).toMatch(/lot of requests from this connection/);
  });

  it('bounds a caller it cannot identify at all, which is the default deployment', async () => {
    /*
     * No trusted proxy, no cookie kept: nothing about these requests can be
     * attributed, so every per-identity bucket is empty by construction. What
     * has to hold is the deployment-wide fence, which takes no identity and so
     * has nothing to rotate.
     */
    const { guardAction } = await import('./caller');
    const { ACTION_RATE_RULES, deploymentRule } = await import('./rate-limit');
    const ceiling = deploymentRule('compile_start').capacity;
    expect(ceiling).toBeGreaterThan(ACTION_RATE_RULES.compile_start.capacity);

    const results: (string | null)[] = [];
    for (let attempt = 0; attempt < ceiling + 1; attempt += 1) {
      jar.clear();
      sent.set('x-forwarded-for', `10.0.0.${attempt}`);
      results.push(await guardAction('compile_start'));
    }

    expect(results.slice(0, ceiling).every((result) => result === null)).toBe(true);
    // And it says the deployment is busy rather than blaming a connection that
    // has done nothing unusual.
    expect(results[ceiling]).toMatch(/Sidequest is busy/);
  });
});

describe('the caller key the daily ledger charges', () => {
  it('is the browser session once the browser has kept one, and nothing before', async () => {
    const { callerKey, sessionToken } = await import('./caller');
    /*
     * The first request carries no cookie, and a cookie the server would mint
     * for it is not an identity: a caller that discards every `Set-Cookie`
     * would otherwise be handed a fresh signed identity — and a fresh personal
     * allowance — on every request, which is the per-caller fence opening for
     * the one caller it exists to close on.
     */
    expect(await callerKey()).toBeNull();

    const minted = await sessionToken({ mint: true });
    expect(minted).not.toBeNull();
    const first = await callerKey();
    expect(first).toBe(`session:${minted}`);
    // Stable across requests from the same browser, which is what makes a
    // per-caller daily share mean anything.
    expect(await callerKey()).toBe(first);
  });

  it('prefers the address the infrastructure vouched for', async () => {
    process.env.SIDEQUEST_TRUSTED_PROXY_HOPS = '1';
    sent.set('x-forwarded-for', '198.51.100.7, 203.0.113.9');
    const { callerKey } = await import('./caller');
    expect(await callerKey()).toBe('ip:203.0.113.9');
  });
});
