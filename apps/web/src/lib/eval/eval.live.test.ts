import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as ScanRepository from '../db/scan-repository';
import type * as Food from '../discovery-scan/food';

/**
 * THE LIVE EVALUATION SUITE — REAL GEOGRAPHY, ZERO MODEL SPEND.
 *
 * Excluded from `npm run test` (see `vitest.config.ts`); runs only with
 * `SIDEQUEST_EVAL=1`:
 *
 *   SIDEQUEST_EVAL=1 npx vitest run apps/web/src/lib/eval/eval.live.test.ts
 *
 * Optional: `SIDEQUEST_EVAL_ONLY=id1,id2` to run a subset (results are merged
 * into the existing results.json by id), `SIDEQUEST_EVAL_TIMEOUT_S` (per trip,
 * default 420), `SIDEQUEST_EVAL_COUNTRY=0` to skip the reverse-geocode check.
 *
 * Network: public Nominatim, Overpass, Wikidata and (unless switched off) the
 * keyless climate/timezone lookups — sequential, through the product's own rate
 * gates. ANTHROPIC_API_KEY and every paid key are removed before anything loads,
 * so no model call is possible; the scan takes the open-data proposal and the
 * build takes the planner path.
 */

const ENABLED = process.env.SIDEQUEST_EVAL === '1';
const ROOT = new URL('../../../../../', import.meta.url).pathname;
const OUT_DIR = join(ROOT, 'docs/production-pass/eval');

/* --- the environment, before any product module is imported ------------------------- */
if (ENABLED) {
  for (const key of ['ANTHROPIC_API_KEY', 'GOOGLE_MAPS_API_KEY', 'OPENROUTESERVICE_API_KEY', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_COMPILER_PROVIDER', 'SIDEQUEST_FIXTURES', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_ROUTES_URL', 'SIDEQUEST_ROUTES_GLOBAL_PROVIDER', 'SIDEQUEST_RESEARCH_PROVIDER', 'SIDEQUEST_PLACE_BACKBONE', 'SIDEQUEST_TRAFFIC_PROVIDER', 'SIDEQUEST_TRANSIT_PROVIDER', 'SIDEQUEST_DESTINATION_INTERPRETER', 'SIDEQUEST_FIXTURE_NOW']) delete process.env[key];
  process.env.SIDEQUEST_GEOCODER_PROVIDER = 'nominatim';
  process.env.SIDEQUEST_POI_PROVIDER = 'overpass';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
  process.env.SIDEQUEST_FETCH_USER_AGENT ??= 'Sidequest-eval/1.0 (sequential evaluation run; contact via repository owner)';
  const stamp = process.env.SIDEQUEST_EVAL_DB ?? `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  mkdirSync(join(ROOT, 'apps/web/data'), { recursive: true });
  process.env.SIDEQUEST_DB_PATH = join(ROOT, 'apps/web/data', stamp);
}

/* --- request scope stand-ins: the server actions read cookies and revalidate ---------- */
const jar = new Map<string, string>();
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock('next/server', async (original) => ({ ...(await original<object>()), after: () => { throw new Error('no request scope'); } }));

/* --- stage clocks, by wrapping (never editing) the scan's own boundaries -------------- */
function mark(name: string): void {
  const holder = globalThis as unknown as { __evalMarks?: { name: string; at: number }[] };
  (holder.__evalMarks ??= []).push({ name, at: Date.now() });
}
vi.mock('../db/scan-repository', async (original) => {
  const actual = await original<typeof ScanRepository>();
  return {
    ...actual,
    markScanStage: (...args: Parameters<typeof actual.markScanStage>) => {
      mark(`scan:${args[2]}`);
      return actual.markScanStage(...args);
    },
    completeScan: (...args: Parameters<typeof actual.completeScan>) => {
      mark('scan:complete');
      return actual.completeScan(...args);
    },
  };
});
vi.mock('../discovery-scan/food', async (original) => {
  const actual = await original<typeof Food>();
  return {
    ...actual,
    groundScanFood: async (...args: Parameters<typeof actual.groundScanFood>) => {
      mark('food:start');
      try {
        return await actual.groundScanFood(...args);
      } finally {
        mark('food:end');
      }
    },
  };
});

describe.skipIf(!ENABLED)('Sidequest live evaluation (open data, planner path, no model)', () => {
  it('runs every profile end to end and writes results.json', async () => {
    const { EVAL_PROFILES } = await import('./profiles');
    const { runProfile } = await import('./run-eval');
    const only = (process.env.SIDEQUEST_EVAL_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const profiles = only.length > 0 ? EVAL_PROFILES.filter((p) => only.includes(p.id)) : EVAL_PROFILES;
    const timeoutMs = Number(process.env.SIDEQUEST_EVAL_TIMEOUT_S ?? 420) * 1000;
    const countryCheck = process.env.SIDEQUEST_EVAL_COUNTRY !== '0';
    mkdirSync(OUT_DIR, { recursive: true });
    const resultsPath = join(OUT_DIR, 'results.json');
    const prior = existsSync(resultsPath) && only.length > 0 ? (JSON.parse(readFileSync(resultsPath, 'utf8')) as { runs: { id: string }[] }) : null;
    const runs: unknown[] = [];
    const progressPath = join(OUT_DIR, 'progress.log');
    if (only.length === 0) rmSync(progressPath, { force: true });

    for (const profile of profiles) {
      jar.clear();
      const record = await runProfile(profile, { tripTimeoutMs: timeoutMs, countryCheck });
      runs.push(record);
      writeFileSync(progressPath, `${new Date().toISOString()} ${record.id} ${record.outcome} ${record.failedStage ?? ''} ${Math.round((record.stages.total_ms ?? 0) / 1000)}s ${record.failureDetail?.split('\n')[0] ?? ''}\n`, { flag: 'a' });
      const merged = prior ? [...prior.runs.filter((r) => !runs.some((n) => (n as { id: string }).id === r.id)), ...runs] : runs;
      writeFileSync(resultsPath, JSON.stringify({ generatedAt: new Date().toISOString(), db: process.env.SIDEQUEST_DB_PATH, environment: { model: 'none (ANTHROPIC_API_KEY removed)', geocoder: 'nominatim (public)', poi: `overpass (public${process.env.SIDEQUEST_POI_URL ? `: ${process.env.SIDEQUEST_POI_URL}` : ', default endpoint rotation'}) + wikidata`, routing: process.env.OPENROUTESERVICE_API_KEY ? 'openrouteservice' : 'labelled estimates (no router configured)' }, runs: merged }, null, 2));
    }
    expect(runs.length).toBe(profiles.length);
  }, 4 * 60 * 60 * 1000);
});
