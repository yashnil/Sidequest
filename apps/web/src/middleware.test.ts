import { describe, expect, it, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

/**
 * The spending control, asserted rather than assumed.
 *
 * `/labs` had no authentication of any kind and could start billed model work.
 * The posture below is the one the fix takes: closed when a deployment has
 * configured live spending, open otherwise so local development and the browser
 * suite are unaffected.
 */

const KEYS = ['SIDEQUEST_BENCHMARK_MODE', 'SIDEQUEST_BENCHMARK_BUDGET_USD', 'SIDEQUEST_LABS_TOKEN'];
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:4200/labs/benchmark', { headers });
}

function liveMode(): void {
  process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
  process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '5.00';
}

describe('the labs gate', () => {
  it('lets everything through when no live spending is configured', () => {
    delete process.env.SIDEQUEST_BENCHMARK_MODE;
    delete process.env.SIDEQUEST_BENCHMARK_BUDGET_USD;
    expect(middleware(request()).status).toBe(200);
  });

  it('stays open in fixture mode even with a budget set', () => {
    /** Both keys are required, exactly as the budget layer requires both. */
    process.env.SIDEQUEST_BENCHMARK_MODE = 'fixture';
    process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '5.00';
    expect(middleware(request()).status).toBe(200);
  });

  it('refuses an unauthenticated request once live spending is configured', () => {
    liveMode();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-secret';
    expect(middleware(request()).status).toBe(401);
  });

  it('accepts the configured token', () => {
    liveMode();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-secret';
    expect(middleware(request({ 'x-sidequest-labs': 'a-secret' })).status).toBe(200);
  });

  it('refuses a wrong token, and one of a different length', () => {
    liveMode();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-secret';
    expect(middleware(request({ 'x-sidequest-labs': 'b-secret' })).status).toBe(401);
    expect(middleware(request({ 'x-sidequest-labs': 'a-secret-longer' })).status).toBe(401);
  });

  it('closes the door when live spending is on and nobody set a token', () => {
    /**
     * The direction this fails matters. A deployment that turns on spending and
     * forgets the secret must get a locked surface, not an open one.
     */
    liveMode();
    delete process.env.SIDEQUEST_LABS_TOKEN;
    expect(middleware(request()).status).toBe(404);
  });
});
