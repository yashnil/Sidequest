import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * V1 CONVERGENCE — THE BUILD PREFLIGHT AND THE PRODUCTION FIXTURE GUARD.
 *
 * A deployment that cannot build must say so before a run starts, and a
 * production server must not compose from test data unless it explicitly is
 * a test server.
 */

const jar = new Map<string, string>();
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
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
/* The generation must never be reached from a refused press: it throws if it is. */
const generate = vi.fn(async () => {
  throw new Error('a refused build must never reach the generation');
});
vi.mock('./production-plan', () => ({ generateSidequestPlanForTrip: generate }));

/* A trip belongs to the browser cookie that made it (`net/trip-access`); the test plays that browser. */
const OWNER = 'owner-token-preflight-0000000000000000';

const ENV_KEYS = ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPOSER_PROVIDER', 'ANTHROPIC_API_KEY', 'SIDEQUEST_FIXTURES', 'SIDEQUEST_DAILY_MODEL_CALLS', 'SIDEQUEST_ACTION_FENCES', 'SIDEQUEST_ROUTES_FIXTURE'] as const;

describe('build preflight', () => {
  let dir: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  function releaseDatabase(): void {
    const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
    holder.sidequestDb?.close();
    delete holder.sidequestDb;
  }
  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    releaseDatabase();
    dir = mkdtempSync(join(tmpdir(), 'sq-preflight-'));
    process.env.SIDEQUEST_DB_PATH = join(dir, 'preflight.db');
    process.env.SIDEQUEST_ACTION_FENCES = 'off';
    jar.clear();
    generate.mockClear();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    releaseDatabase();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function preflight() {
    return (await import('./build-preflight')).buildPreflight;
  }

  it('refuses with composer_not_configured when nothing can compose', async () => {
    const buildPreflight = await preflight();
    const verdict = buildPreflight(null);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.cause).toBe('composer_not_configured');
    expect(verdict.failure.retryable).toBe(false);
    /* The operator reason names the switch; the traveller copy never does. */
    expect(verdict.operatorReason).toMatch(/ANTHROPIC_API_KEY/);
    expect(verdict.failure.message).not.toMatch(/ANTHROPIC_|SIDEQUEST_/);
  });

  it('passes the fixture composer and a configured model', async () => {
    const buildPreflight = await preflight();
    process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
    expect(buildPreflight(null)).toEqual({ ok: true, path: 'fixture_composer' });
    delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    expect(buildPreflight(null)).toEqual({ ok: true, path: 'model_composer' });
  });

  it('refuses a spent daily allowance as a quota the traveller cannot retry today', async () => {
    const buildPreflight = await preflight();
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    process.env.SIDEQUEST_DAILY_MODEL_CALLS = '0';
    const verdict = buildPreflight(null, { caller: 'someone' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.cause).toBe('provider_quota_or_limit');
    expect(verdict.failure.variant).toBe('daily_allowance');
    expect(verdict.failure.retryable).toBe(false);
  });

  it('a fixture switch in production without the opt-in is refused; with it, allowed', async () => {
    const buildPreflight = await preflight();
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
    const refused = buildPreflight(null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure.cause).toBe('composer_not_configured');
      expect(refused.failure.variant).toBe('fixtures_refused');
      expect(refused.operatorReason).toMatch(/SIDEQUEST_COMPOSER_PROVIDER=fixture/);
    }
    /* Any fixture switch, not only the composer's: a real model with recorded routes is still test data. */
    delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    process.env.SIDEQUEST_ROUTES_FIXTURE = 'fixtures/routes.json';
    expect(buildPreflight(null).ok).toBe(false);
    process.env.SIDEQUEST_FIXTURES = 'allow';
    expect(buildPreflight(null)).toEqual({ ok: true, path: 'model_composer' });
    delete process.env.SIDEQUEST_ROUTES_FIXTURE;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
    expect(buildPreflight(null)).toEqual({ ok: true, path: 'fixture_composer' });
  });

  it('outside production the fixture composer needs no opt-in', async () => {
    const buildPreflight = await preflight();
    vi.stubEnv('NODE_ENV', 'test');
    process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
    expect(buildPreflight(null).ok).toBe(true);
  });

  it('the capability registry reports fixture-in-production as a hard problem', async () => {
    const { capabilityRegistry, productionFixtureRefusal } = await import('../providers/capabilities.mjs');
    const env = { NODE_ENV: 'production', SIDEQUEST_COMPOSER_PROVIDER: 'fixture', SIDEQUEST_DB_PATH: '/data/sq.db' };
    expect(productionFixtureRefusal(env).refused).toBe(true);
    const registry = capabilityRegistry(env);
    expect(registry.composition).toBe('off');
    expect(registry.byId['composition.model']?.configured).toBe(false);
    expect(registry.problems.join(' ')).toMatch(/Fixture data is switched on in production/);
    const allowed = capabilityRegistry({ ...env, SIDEQUEST_FIXTURES: 'allow' });
    expect(allowed.composition).toBe('fixture');
    expect(allowed.fixtureGuard.refused).toBe(false);
  });

  it('startBuildAction refuses before a run exists, keeps the answers, and returns the typed failure', async () => {
    const repo = await import('../db/repository');
    const core = await import('@sidequest/core');
    const progress = await import('../db/generation-progress-repository');
    const trip = repo.createTrip({ mode: 'known_destination', destinationInput: 'Kenya and Tanzania', regionId: 'dynamic', startDate: '2027-06-13', endDate: '2027-06-19', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [] }, OWNER);
    jar.set('sidequest_session', OWNER);
    const base = core.defaultAnswers({ travelerNeeds: [], tripDays: 7, offeredInterests: [] });
    const answers = { ...base, interests: { ...base.interests, [core.INTERESTS[0]]: 'core' } } as typeof base;
    const actions = await import('@/app/(product)/trips/[id]/questionnaire/actions');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await actions.startBuildAction(trip.id, answers, 'press-preflight-aaaa');
    warn.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure?.cause).toBe('composer_not_configured');
    expect(result.error).toBe(result.failure?.message);
    expect(result.error).not.toMatch(/SIDEQUEST_|ANTHROPIC_/);
    /* No doomed run was recorded, and nothing was composed. */
    expect(progress.getGenerationProgress(trip.id)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    /* The answers were saved all the same: nothing was lost. */
    expect(repo.getAnswers(trip.id)).not.toBeNull();
  });

  it('retryBuildAction refuses the same way', async () => {
    const repo = await import('../db/repository');
    const progress = await import('../db/generation-progress-repository');
    const trip = repo.createTrip({ mode: 'known_destination', destinationInput: 'Kenya and Tanzania', regionId: 'dynamic', startDate: '2027-06-13', endDate: '2027-06-19', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [] }, OWNER);
    jar.set('sidequest_session', OWNER);
    const actions = await import('@/app/(product)/trips/[id]/questionnaire/actions');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await actions.retryBuildAction(trip.id, 'press-preflight-bbbb');
    warn.mockRestore();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure?.cause).toBe('composer_not_configured');
    expect(progress.getGenerationProgress(trip.id)).toBeNull();
  });
});
