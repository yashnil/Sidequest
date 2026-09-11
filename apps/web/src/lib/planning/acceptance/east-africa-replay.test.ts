import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFeasibilityReport, buildTravelReality, type Itinerary } from '@sidequest/core';
import { auditItinerary } from '../quality-audit';
import { reconcileTripDraft } from '../reconcile';
import { episodesOf, type TripDraft } from '../trip-draft';
import { TRIP_DRAFT_JSON_TAG, normalizeTripDraftWire } from '../trip-draft-wire';
import { extractJsonObject } from '@/lib/providers/json-extract';
import { fictionalWorld } from './harness';

/**
 * V7 LIVE CALL 2 — "KENYA AND TANZANIA", REPLAYED WITH ZERO CALLS.
 *
 * The phrase production refused as "not a place" became a composite intent
 * (KE + TZ), a reality that says guided transfers, flights and a driver and not
 * a hire car, and — through the ordinary browser flow — a ten-night Kenya
 * safari circuit the model chose on purpose, saying in its omissions why
 * Tanzania was left for another trip. What the first compile of that answer
 * got wrong is pinned here against the raw text: four Mara days drawn as walks
 * from a hotel and flagged as a repeated stop, a flight and two lodge transfers
 * called dependencies nobody could time, an arrival evening with no dinner.
 */

const PLACES = [
  { name: 'Nairobi', lat: -1.2921, lng: 36.8219, entityType: 'city' as const },
  { name: 'Karen Blixen Museum', lat: -1.3536, lng: 36.7092 },
  { name: 'Giraffe Centre', lat: -1.3752, lng: 36.7443 },
  { name: 'Maasai Mara', lat: -1.4061, lng: 35.0078, entityType: 'unknown' as const },
  { name: 'Maasai Mara National Reserve', lat: -1.5, lng: 35.15 },
  { name: 'Mara River', lat: -1.42, lng: 35.05 },
  { name: 'Lake Naivasha', lat: -0.7667, lng: 36.35 },
  { name: 'Crescent Island', lat: -0.78, lng: 36.39 },
  { name: "Hell's Gate National Park", lat: -0.9, lng: 36.32 },
  { name: 'Nairobi National Museum', lat: -1.2741, lng: 36.8146 },
  { name: 'Nairobi National Park', lat: -1.3733, lng: 36.8587 },
];

function fixture(): TripDraft {
  const text = readFileSync(resolve(process.cwd(), 'apps/web/src/lib/planning/acceptance/fixtures/east-africa/live-2026-09-11.txt'), 'utf8');
  const extracted = extractJsonObject(text, { wrapperTag: TRIP_DRAFT_JSON_TAG });
  if (!extracted.ok) throw new Error('the recorded answer did not extract');
  const normalized = normalizeTripDraftWire(extracted.json, { days: 11 });
  if (!normalized.ok) throw new Error(`the recorded answer did not normalise: ${JSON.stringify(normalized.issues)}`);
  return normalized.draft;
}

const legsOf = (itinerary: Itinerary, dayNumber: number) => itinerary.days.find((d) => d.dayNumber === dayNumber)!.items.filter((i) => i.kind === 'travel' && i.travel);

describe('the live Kenya and Tanzania answer of 2026-09-11, replayed', () => {
  it('the Mara is a safari episode, its drives are drives, the operator transfers are cautions, and the arrival evening eats', async () => {
    const draft = fixture();
    const episodes = episodesOf(draft);
    expect(episodes).toEqual([expect.objectContaining({ kind: 'safari', mode: 'four_wheel_drive', fromDay: 2, toDay: 5, timing: 'operator' })]);

    const world = fictionalWorld({
      name: 'Kenya and Tanzania',
      countryCode: 'KE',
      center: { lat: -1.2921, lng: 36.8219 },
      places: PLACES,
      basics: { startDate: '2027-06-11', endDate: '2027-06-21', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0 },
      profile: { willDrive: false },
    });
    const { context, trip } = world;
    const result = await reconcileTripDraft({ draft, context });
    const reality = buildTravelReality({ label: 'Kenya and Tanzania', countries: ['KE', 'TZ'], crossBorder: true, entityType: 'multi_country', traits: ['broad_geography', 'cross_border', 'multi_area', 'guide_transfer_likely'], tripDays: 11, party: { size: 2, drivers: null }, capabilities: { roadRouting: false, transit: false } });
    expect(reality.recommendation?.regional).toEqual(expect.arrayContaining(['guided_transfer', 'flight']));
    const itinerary: Itinerary = { ...result.itinerary, package: result.itinerary.package ? { ...result.itinerary.package, reality } : undefined };
    const audit = auditItinerary({ draft, itinerary, profile: context.profile, trip, reality });
    const feasibility = buildFeasibilityReport({ itinerary, audit });

    /* Game drives, not walks: every in-reserve leg on the safari days moves by the lodge's vehicle. */
    for (const dayNumber of [3, 4, 5]) {
      const approaches = legsOf(itinerary, dayNumber).filter((l) => l.travel!.role === 'approach');
      expect(approaches.length, `day ${dayNumber} reaches its stops`).toBeGreaterThan(0);
      for (const leg of approaches) expect(leg.travel!.hint, `${leg.title} on day ${dayNumber}`).toBe('four_wheel_drive');
    }
    expect(audit.checks.find((c) => c.id === 'no_duplicate_anchors')!.ok).toBe(true);
    /* The flight into the Mara and the lodge transfers out of it are the operator's hours to confirm, never a gap Sidequest could have closed. */
    expect(legsOf(itinerary, 2).find((l) => l.travel!.role === 'transfer')?.travel!.hint).toBe('flight');
    expect(feasibility.items.filter((i) => i.severity === 'dependency').map((i) => i.detail)).toEqual([]);
    expect(feasibility.verdict).toBe('feasible_with_cautions');
    /* The arrival evening has its nyama choma. */
    expect(itinerary.days[0]!.items.some((i) => i.kind === 'meal' && /nyama choma/i.test(i.title))).toBe(true);
    expect(audit.checks.find((c) => c.id === 'meals_present')!.ok).toBe(true);
    expect(itinerary.package!.episodes[0]).toMatchObject({ kind: 'safari', dayNumbers: [2, 3, 4, 5] });
  });
});
