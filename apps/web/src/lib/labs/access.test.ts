import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE GATE ON THE PATH A SPENDING REQUEST ACTUALLY TAKES.
 *
 * `proxy.test.ts` proves the gate for navigations. It cannot prove it for
 * server actions, and that gap is the defect this file exists for: Next
 * dispatches an action by its `Next-Action` id against a global manifest, so the
 * URL a POST names is irrelevant and `matcher: ['/labs/:path*']` never sees it.
 * A reviewer POSTed a labs-only action id to `/` against the running production
 * build and it ran.
 *
 * These tests call the actions with **no request scope at all**, which is the
 * strongest available statement of the property: not "refused when POSTed to
 * `/`" but "refused however it was reached". `next/headers` throws here, the
 * guard treats that as no credential offered, and a billable deployment
 * refuses.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

const ENV_KEYS = [
  'SIDEQUEST_BENCHMARK_MODE',
  'SIDEQUEST_BENCHMARK_BUDGET_USD',
  'SIDEQUEST_LABS_TOKEN',
  'SIDEQUEST_COMPILER_PROVIDER',
  'SIDEQUEST_GEOCODER_PROVIDER',
  'SIDEQUEST_PLACE_BACKBONE',
  'SIDEQUEST_POI_PROVIDER',
  'SIDEQUEST_ROUTES_PROVIDER',
  'SIDEQUEST_RESEARCH_PROVIDER',
  'ANTHROPIC_API_KEY',
  'RAILWAY_ENVIRONMENT',
  'SIDEQUEST_REQUIRE_CONFIG',
];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sidequest-labs-access-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

/** A deployment whose compiler spends: the condition the gate exists for. */
function billable(): void {
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'open';
}

describe('the labs gate, inside the action', () => {
  it('lets everything through when nothing on this deployment can spend', async () => {
    const { labsAccessDecision } = await import('./access');
    expect((await labsAccessDecision()).allowed).toBe(true);
  });

  it('refuses a caller with no credential once the compiler is open', async () => {
    billable();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-real-secret';
    const { labsAccessDecision } = await import('./access');
    const decision = await labsAccessDecision();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.status).toBe(401);
  });

  it('closes a hosted deployment even when nothing can spend (private alpha)', async () => {
    process.env.RAILWAY_ENVIRONMENT = 'production';
    const { labsAccessDecision } = await import('./access');
    const decision = await labsAccessDecision();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.status).toBe(404);
  });

  it('closes the door when spending is on and nobody set a token', async () => {
    billable();
    const { labsAccessDecision } = await import('./access');
    const decision = await labsAccessDecision();
    expect(decision.allowed).toBe(false);
    // 404 rather than 401: a deployment that forgot the secret gets a locked
    // door, not a prompt that says a harness is here.
    if (!decision.allowed) expect(decision.status).toBe(404);
  });

  it('gates on live benchmark spending too, not only on the open compiler', async () => {
    process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
    process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '5.00';
    process.env.SIDEQUEST_LABS_TOKEN = 'a-real-secret';
    const { labsAccessDecision } = await import('./access');
    expect((await labsAccessDecision()).allowed).toBe(false);
  });
});

/**
 * The behavioural half: an action, called directly, refusing to do its work.
 *
 * `seedFixtureComparisonAction` is the one labs action whose success is visible
 * without a seeded session — it writes a whole comparison and hands back its id
 * — so it is the one that can distinguish "gated" from "ran anyway". The other
 * five are gated by the same call, asserted structurally in
 * `app/labs/actions.architecture.test.ts`, because their refusals and their
 * ordinary "that session does not exist" answers are the same value.
 */
describe('a labs action reached from outside the labs URL', () => {
  it('writes nothing when the deployment can spend and no token was presented', async () => {
    billable();
    process.env.SIDEQUEST_LABS_TOKEN = 'a-real-secret';
    const { seedFixtureComparisonAction } = await import(
      '@/app/labs/benchmark/new/actions'
    );
    const result = await seedFixtureComparisonAction({
      caseId: CASE_ID,
      seed: 'gate-check',
      shape: 'both_complete',
    });
    expect(result.ok).toBe(false);
    expect(result.sessionId).toBeNull();
  });

  it('still works on a deployment that cannot spend, which is every default one', async () => {
    const { seedFixtureComparisonAction } = await import(
      '@/app/labs/benchmark/new/actions'
    );
    const result = await seedFixtureComparisonAction({
      caseId: CASE_ID,
      seed: 'gate-check',
      shape: 'both_complete',
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).not.toBeNull();
  });
});

/** Read from the library rather than typed, so a renamed case fails loudly. */
const { BENCHMARK_CASES } = await import('@sidequest/bench/cases');
const CASE_ID = BENCHMARK_CASES[0]!.caseId;
