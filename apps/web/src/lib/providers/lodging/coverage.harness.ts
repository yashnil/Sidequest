import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { haversineKm, isNotAProperty } from '@sidequest/core';
import { LODGING_SELECTORS, fetchLodgingPois } from '../overpass';
import { USER_AGENT } from '../nominatim';
import { liveReadLodgingBox } from './overture-lodging';
import { osmLodgingFromElements } from './osm-lodging';
import { boxAround } from './discover';

/**
 * LODGING COVERAGE — HOW MANY NAMED CANDIDATES EACH SOURCE HOLDS AROUND A REAL BASE.
 *
 * A script, not a test: it reaches the network (Overture place files, one
 * Overpass query per base, sequential, with the shared client's pacing and
 * cooldown), writes `docs/experience-transformation/lodging-coverage.json`, and
 * re-records the unit fixtures under `fixtures/`. Run once, by hand:
 *
 *   SIDEQUEST_LODGING_COVERAGE=1 npx vitest run --config vitest.lodging.config.ts
 */
const BASES = [
  { slug: 'hongu', label: 'Hongū (Kumano), Japan', near: { lat: 33.8395, lng: 135.7737 }, radiusKm: 4, mode: 'foot' },
  { slug: 'vik', label: 'Vík, Iceland', near: { lat: 63.4186, lng: -19.006 }, radiusKm: 12, mode: 'drive' },
  { slug: 'karatu', label: 'Karatu, Tanzania', near: { lat: -3.341, lng: 35.672 }, radiusKm: 12, mode: 'drive' },
  { slug: 'portree', label: 'Portree, Scotland', near: { lat: 57.4125, lng: -6.196 }, radiusKm: 12, mode: 'drive' },
  { slug: 'mammoth', label: 'Mammoth Lakes, USA', near: { lat: 37.6485, lng: -118.9721 }, radiusKm: 12, mode: 'drive' },
] as const;

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');

it.runIf(process.env.SIDEQUEST_LODGING_COVERAGE === '1')('lodging coverage around five real bases', async () => {
  const report: unknown[] = [];
  for (const base of BASES) {
    const box = boxAround(base.near, base.radiusKm);
    const within = <T extends { coordinates: { lat: number; lng: number } }>(rows: T[], r: number = base.radiusKm) => rows.filter((row) => haversineKm(base.near, row.coordinates) <= r);
    const started = Date.now();
    let overture: Awaited<ReturnType<typeof liveReadLodgingBox>> | null = null;
    let overtureError: string | null = null;
    try {
      overture = await liveReadLodgingBox(box, { deadlineMs: Date.now() + 60_000, catalog: {} });
    } catch (error) {
      overtureError = error instanceof Error ? error.message : String(error);
    }
    const overtureMs = Date.now() - started;
    const osmStarted = Date.now();
    let elements: unknown[] = [];
    let osmError: string | null = null;
    try {
      const result = await fetchLodgingPois(box, { limit: 400, retries: 0, requestTimeoutMs: 55_000, deadlineMs: Date.now() + 150_000 });
      elements = result.elements;
      if (result.failedGroups.length > 0) osmError = `refused groups: ${result.failedGroups.join(', ')}`;
    } catch (error) {
      osmError = error instanceof Error ? error.message : String(error);
    }
    if (elements.length === 0) {
      /*
       * The shared client splits the question into small groups and cools an
       * endpoint down on its first refusal, which on a busy public instance ends
       * the run. A script asking once may wait: one union request, one minute.
       */
      try {
        elements = await directOverpass(box);
        osmError = osmError ? `${osmError} (client); answered by one direct request` : null;
      } catch (error) {
        osmError = `${osmError ?? ''}; direct request failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const osmMs = Date.now() - osmStarted;
    const osm = osmLodgingFromElements(elements as never);
    const ov = overture ? within(overture.candidates) : [];
    const os = within(osm);
    report.push({
      base: base.label,
      radiusKm: base.radiusKm,
      overture: overture ? { named: ov.length, withWebsite: ov.filter((c) => c.website).length, onsenByName: ov.filter((c) => c.amenities.some((a) => a.kind === 'onsen')).length, within3km: within(overture.candidates, 3).length, hotSprings: overture.hotSprings.length, bytes: overture.bytes, ms: overtureMs } : { error: overtureError, ms: overtureMs },
      osm: { named: os.length, withWebsite: os.filter((c) => c.website).length, onsenMapped: os.filter((c) => c.amenities.some((a) => a.kind === 'onsen' && a.basis === 'mapped')).length, parkingMapped: os.filter((c) => c.amenities.some((a) => a.kind === 'parking')).length, stars: os.filter((c) => c.stars !== undefined).length, within3km: within(osm, 3).length, ms: osmMs, ...(osmError ? { error: osmError } : {}) },
      sampleNames: { overture: ov.slice(0, 6).map((c) => c.name), osm: os.slice(0, 6).map((c) => c.name) },
    });
    /* The unit fixtures: normalised Overture rows (persistable licences) and raw OSM elements, kept in separate keys. */
    writeFileSync(
      join(__dirname, 'fixtures', `${base.slug}.json`),
      `${JSON.stringify({ recordedAt: new Date().toISOString().slice(0, 10), base: { label: base.label, near: base.near, radiusKm: base.radiusKm }, overture: overture ? { candidates: overture.candidates, hotSprings: overture.hotSprings } : null, osm: { elements: (elements as { tags?: Record<string, string> }[]).filter((e) => e.tags?.name && !isNotAProperty(e.tags.name)) } }, null, 1)}\n`,
    );
  }
  writeFileSync(join(ROOT, 'docs', 'experience-transformation', 'lodging-coverage.json'), `${JSON.stringify({ measuredAt: new Date().toISOString(), report }, null, 2)}\n`);
});

async function directOverpass(box: { south: number; west: number; north: number; east: number }): Promise<unknown[]> {
  const bbox = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(4)).join(',');
  const clauses = LODGING_SELECTORS.flatMap((sel) => sel.values.flatMap((v) => ['node', 'way'].map((el) => `${el}["${sel.key}"="${v}"]["name"](${bbox});`))).join('');
  const query = `[out:json][timeout:60];(${clauses});out center tags 600;`;
  const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { elements?: unknown[] };
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return body.elements ?? [];
}
