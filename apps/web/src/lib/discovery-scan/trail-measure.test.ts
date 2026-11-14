import { describe, expect, it, vi } from 'vitest';
import { normalizeScanProposal } from '@sidequest/core';
import { measureTrailStages, trailCacheKey } from './trail-measure';
import { buildScanTask, SCAN_INSTRUCTION, SCAN_PROMPT_VERSION } from './prompt';

vi.mock('server-only', () => ({}));
/* The brief's own rendering is tested with the brief; here only the task's trail words matter. */
vi.mock('@sidequest/core', async (original) => ({ ...(await original<Record<string, unknown>>()), renderTravelerBriefXml: () => '<traveler_brief/>' }));

/** Two one-way stages on a fictional trail, with their ends placed. */
function stages() {
  const read = normalizeScanProposal({
    bases: [{ name: 'Alder Gate', locality: 'Alder Gate', nightsHint: 1, why: 'x' }],
    candidates: [
      { name: 'Alder Gate to Brackenford', locality: 'Alder Gate', kind: 'day_hike', walk: { shape: 'point_to_point', endName: 'Brackenford', km: 12, ascentM: 500, stage: 1 } },
      { name: 'Brackenford to Corrie Mill', locality: 'Brackenford', kind: 'day_hike', walk: { shape: 'point_to_point', endName: 'Corrie Mill', stage: 2 } },
      { name: 'A loop', locality: 'Alder Gate', kind: 'day_hike', walk: { shape: 'loop' } },
    ],
  });
  if (!read.ok) throw new Error(read.reason);
  const at: Record<string, { lat: number; lng: number }> = { c1: { lat: 34, lng: 135.5 }, 'c1#end': { lat: 34.01, lng: 135.58 }, c2: { lat: 34.01, lng: 135.58 }, 'c2#end': { lat: 34.02, lng: 135.66 }, c3: { lat: 34, lng: 135.51 } };
  return { proposal: read.proposal, positionOf: (key: string) => at[key] ?? null };
}

const feature = (metres: number, seconds: number, ascent?: number) => ({ features: [{ properties: { summary: { distance: metres, duration: seconds }, ...(ascent !== undefined ? { ascent } : {}) } }] });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('a trail stage’s distance and climb, measured where possible', () => {
  it('asks the hiking profile with elevation for each placed stage only, and caches the answer under a directional key', async () => {
    const { proposal, positionOf } = stages();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return json(200, calls.length === 1 ? feature(12_900, 13_000, 612) : feature(14_100, 15_000, 703));
    }) as unknown as typeof fetch;
    const written = new Map<string, { km: number; ascentM: number }>();
    const result = await measureTrailStages(proposal, positionOf, { http: { fetchImpl, apiKey: 'test' }, cache: { read: (k) => written.get(k) ?? null, write: (k, v) => written.set(k, v) } });
    expect(calls.map((c) => c.url)).toEqual(['https://api.heigit.org/openrouteservice/v2/directions/foot-hiking/geojson', 'https://api.heigit.org/openrouteservice/v2/directions/foot-hiking/geojson']);
    expect(calls[0]!.body).toMatchObject({ elevation: true, coordinates: [[135.5, 34], [135.58, 34.01]] });
    expect(result.measured.get('c1')).toEqual({ km: 12.9, ascentM: 612 });
    expect(result.measured.get('c2')).toEqual({ km: 14.1, ascentM: 703 });
    expect(result.measured.has('c3')).toBe(false);
    expect(written.get(trailCacheKey({ lat: 34, lng: 135.5 }, { lat: 34.01, lng: 135.58 }))).toEqual({ km: 12.9, ascentM: 612 });
    /* The second run costs nothing. */
    const again = await measureTrailStages(proposal, positionOf, { http: { fetchImpl, apiKey: 'test' }, cache: { read: (k) => written.get(k) ?? null, write: (k, v) => written.set(k, v) } });
    expect(again.calls).toBe(0);
    expect(again.measured.size).toBe(2);
  });

  it('a failure leaves the estimate; a rate limit stops the batch; an implausible answer is refused', async () => {
    const { proposal, positionOf } = stages();
    const limited = vi.fn(async () => json(429, {})) as unknown as typeof fetch;
    const r1 = await measureTrailStages(proposal, positionOf, { http: { fetchImpl: limited, apiKey: 'test' } });
    expect(r1).toMatchObject({ calls: 1, failures: 1 });
    expect(r1.measured.size).toBe(0);
    const broken = vi.fn(async () => json(500, { error: { code: 2099 } })) as unknown as typeof fetch;
    const r2 = await measureTrailStages(proposal, positionOf, { http: { fetchImpl: broken, apiKey: 'test' } });
    expect(r2).toMatchObject({ calls: 2, failures: 2 });
    /* 12.9 km in two minutes on foot is not a measurement. */
    const absurd = vi.fn(async () => json(200, feature(12_900, 120, 600))) as unknown as typeof fetch;
    const r3 = await measureTrailStages(proposal, positionOf, { http: { fetchImpl: absurd, apiKey: 'test' } });
    expect(r3.measured.size).toBe(0);
    /* No key: nothing is asked. */
    const r4 = await measureTrailStages(proposal, positionOf, { http: { fetchImpl: absurd, apiKey: '' } });
    expect(r4.measured.size).toBe(0);
  });
});

describe('the scan asks a trail trip for its stages', () => {
  it('bumps the prompt version and spells out stages, stage-end bases, unsuitable sections and their alternatives', () => {
    expect(SCAN_PROMPT_VERSION).toBe('discovery-scan/2026-11-15.2');
    expect(SCAN_INSTRUCTION).toMatch(/Trails walked in stages/);
    expect(SCAN_INSTRUCTION).toMatch(/"walk\.stage"/);
    /* One string on the wire, "mode: note" (the nested object made the provider's compiled grammar too large). */
    expect(SCAN_INSTRUCTION).toMatch(/"walk\.alternative": "mode: note"/);
    expect(SCAN_INSTRUCTION).toMatch(/walk\.alternative mode \(before the colon\): bus, train, taxi, boat, skip/);
  });

  it('a trail trip’s task asks for the stages in order and a base at every stage end', () => {
    const input = {
      envelope: { name: 'The Valley Trail', center: { lat: 34, lng: 135.6 } },
      brief: { sections: [] },
      startDate: '2026-10-10',
      endDate: '2026-10-16',
      days: 7,
      namedMustDos: [],
    } as unknown as Parameters<typeof buildScanTask>[0];
    const task = buildScanTask({ ...input, trail: true });
    expect(buildScanTask(input)).not.toMatch(/<trail>/);
    expect(task).toMatch(/<trail>This trip is for walking the trail in stages/);
    expect(task).toMatch(/a base at the start of the first stage and at the end of every stage \(up to 9 bases/);
  });
});
