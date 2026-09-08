import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { itinerarySchema } from '@sidequest/core';
import { COMPOSITION_MAX_TOKENS } from '../composition';
import { reconcileTripDraft } from '../reconcile';
import { fictionalWorld } from './harness';
import {
  compactTripDraftWireSchema,
  normalizeTripDraftWire,
  tripDraftWireSchema,
  wireSchemaProfile,
} from '../trip-draft-wire';

/**
 * THE COMPACT WIRE, MEASURED AND PROVED — THE LATENCY CLOSURE'S OFFLINE HALF.
 *
 * Two live ten-day Kyrgyzstan builds were cancelled at the hundred-second
 * deadline having written 1,285 and 8,534 bytes. The stream diagnostics say the
 * model was not slow at planning: after the thinking it wrote at ~252 visible
 * bytes a second, and a complete answer on the old wire is ~15,000 bytes. The
 * arithmetic never worked.
 *
 * So this file holds the two things that have to be true before a live call is
 * worth making:
 *
 * 1. **The representation is smaller** — measured against the recorded answers,
 *    not asserted.
 * 2. **The trip survives it** — a ten-day Kyrgyzstan draft as rich as the
 *    founder's direct-model baseline still normalises into every day, every
 *    base, the route order, the transport strategy, the lodging character, the
 *    season reasoning and the omissions.
 *
 * The Kyrgyzstan fixture is a *representation* test. It is not production
 * content, nothing reads it at runtime, and no destination is special-cased
 * anywhere in the code it exercises.
 */

const COMPACT_DIR = join(__dirname, 'fixtures', 'compact');
const COMPOSITION_DIR = join(__dirname, 'fixtures', 'composition');

/** What the model actually writes: one line, no pretty-printing. */
const wireBytes = (value: unknown) => JSON.stringify(value).length;

function recorded(file: string): Record<string, unknown> {
  const raw = readFileSync(join(COMPOSITION_DIR, file), 'utf8');
  const body = raw.slice(raw.indexOf('<trip_draft_json>') + 17, raw.lastIndexOf('</trip_draft_json>')).trim();
  return JSON.parse(body) as Record<string, unknown>;
}

/**
 * The same authored content, re-expressed on the compact wire.
 *
 * Only the representation changes — every name, reason, duration and meal is
 * carried across verbatim — so the byte delta below is purely the schema's.
 */
function toCompact(long: Record<string, unknown>): Record<string, unknown> {
  const days = (long.days as Record<string, unknown>[]).map((day) => {
    const meals: Record<string, string> = {};
    if (day.breakfast) meals.b = day.breakfast as string;
    if (day.lunch) meals.l = day.lunch as string;
    if (day.dinner) meals.d = day.dinner as string;
    return {
      stay: day.stay,
      theme: day.theme,
      acts: (day.activities as Record<string, unknown>[]).map((a) => ({
        name: a.name,
        ...(a.locality ? { near: a.locality } : {}),
        kind: a.category,
        ...(a.minutes !== null && a.minutes !== undefined ? { mins: a.minutes } : {}),
        ...(a.transport ? { how: a.transport } : {}),
        why: a.why,
      })),
      ...(Object.keys(meals).length > 0 ? { meals } : {}),
      ...(day.whyItFits || day.note ? { why: day.whyItFits ?? day.note } : {}),
    };
  });
  return {
    archetype: long.archetype,
    purpose: long.purpose,
    routeRationale: long.routeRationale,
    ...(long.timingRationale ? { timingRationale: long.timingRationale } : {}),
    transportSummary: long.transportSummary,
    stays: (long.stays as Record<string, unknown>[]).map((s) => ({
      name: s.name,
      nights: s.nights,
      why: s.why,
      ...(s.lodgingStyle ?? s.lodgingArea ? { lodging: s.lodgingStyle ?? s.lodgingArea } : {}),
    })),
    days,
    omissions: long.omissions,
    tradeoffs: long.tradeoffs,
    backups: long.backups,
  };
}

describe('the compact wire is smaller, measured on real answers', () => {
  it('the schema itself is small enough for a grammar, where the long one was refused', () => {
    const long = wireSchemaProfile((zodOutputFormat(tripDraftWireSchema) as unknown as { schema: unknown }).schema);
    const compact = wireSchemaProfile((zodOutputFormat(compactTripDraftWireSchema) as unknown as { schema: unknown }).schema);
    // The provider refused the long one live at 3,726 bytes.
    expect(long.bytes).toBeGreaterThan(3_000);
    expect(compact.bytes).toBeLessThan(3_000);
    expect(compact.properties).toBeLessThan(long.properties);
  });

  it.each(['ireland-attempt-1.txt', 'ireland-attempt-2.txt'])(
    '%s is at least a quarter smaller with nothing removed but representation',
    (file) => {
      const long = recorded(file);
      const compact = toCompact(long);
      const before = wireBytes(long);
      const after = wireBytes(compact);
      expect(after).toBeLessThan(before * 0.75);
      // And it is still the same trip.
      expect((compact.days as unknown[]).length).toBe((long.days as unknown[]).length);
      expect((compact.stays as unknown[]).length).toBe((long.stays as unknown[]).length);
      const acts = (compact.days as { acts: unknown[] }[]).reduce((n, d) => n + d.acts.length, 0);
      const activities = (long.days as { activities: unknown[] }[]).reduce((n, d) => n + d.activities.length, 0);
      expect(acts).toBe(activities);
    },
  );

  it('a recorded answer re-expressed compactly still normalises into the same trip', () => {
    const long = recorded('ireland-attempt-1.txt');
    const fromLong = normalizeTripDraftWire(long, { days: 10 });
    const fromCompact = normalizeTripDraftWire(toCompact(long), { days: 10 });
    expect(fromLong.ok && fromCompact.ok).toBe(true);
    if (!fromLong.ok || !fromCompact.ok) return;
    expect(fromCompact.draft.days.map((d) => d.baseId)).toEqual(fromLong.draft.days.map((d) => d.baseId));
    expect(fromCompact.draft.days.map((d) => d.anchors.map((a) => a.name))).toEqual(
      fromLong.draft.days.map((d) => d.anchors.map((a) => a.name)),
    );
    expect(fromCompact.draft.bases.map((b) => b.name)).toEqual(fromLong.draft.bases.map((b) => b.name));
    expect(fromCompact.draft.archetype).toBe(fromLong.draft.archetype);
  });
});

describe('a ten-day Kyrgyzstan trip fits the compact wire without losing the trip', () => {
  const draftJson = JSON.parse(readFileSync(join(COMPACT_DIR, 'kyrgyzstan-10-day.json'), 'utf8')) as Record<string, unknown>;

  it('is a valid compact draft, well inside the output target', () => {
    expect(compactTripDraftWireSchema.safeParse(draftJson).success).toBe(true);
    // The strong upper target for a long adventure trip.
    expect(wireBytes(draftJson)).toBeLessThan(10_000);
  });

  it('normalises with every day, base and experience intact', () => {
    const result = normalizeTripDraftWire(draftJson, { days: 10 });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues.slice(0, 3))).toBe(true);
    if (!result.ok) return;
    const draft = result.draft;

    expect(draft.days).toHaveLength(10);
    expect(draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(9);
    // The route, in the order it was authored.
    expect(draft.bases.map((b) => b.name)).toEqual(['Bishkek', 'Ala-Archa', 'Song-Kul', 'Kochkor', 'Bokonbayevo', 'Karakol']);
    // Every day has something on it, and the trek days are not thinned.
    expect(draft.days.every((d) => d.anchors.length > 0)).toBe(true);
    const names = draft.days.flatMap((d) => d.anchors.map((a) => a.name));
    for (const defining of ['Ala-Kul pass and lake', 'Altyn-Arashan hot springs', 'Skazka canyon', 'Jeti-Oguz red rocks', 'Osh Bazaar']) {
      expect(names, `${defining} must survive normalisation`).toContain(defining);
    }
  });

  it('keeps the transport strategy the trip depends on', () => {
    const result = normalizeTripDraftWire(draftJson, { days: 10 });
    if (!result.ok) throw new Error('did not normalise');
    const modes = new Set(result.draft.days.flatMap((d) => d.anchors.map((a) => a.transport).filter(Boolean)));
    // Not reduced to drive/walk/transit: this trip is a driver, a horse and a 4x4.
    // `private_driver` is the word the model writes; the canonical name is `private_transfer`.
    expect(modes.has('private_transfer')).toBe(true);
    expect(modes.has('horse')).toBe(true);
    expect(modes.has('four_wheel_drive')).toBe(true);
    expect(result.draft.package.transport.summary).toMatch(/private driver/i);
  });

  it('keeps the lodging character, the season reasoning and the omissions', () => {
    const result = normalizeTripDraftWire(draftJson, { days: 10 });
    if (!result.ok) throw new Error('did not normalise');
    const lodging = result.draft.bases.map((b) => b.lodgingStyle);
    expect(lodging).toContain('yurt camp');
    expect(lodging).toContain('mountain hut');
    expect(lodging).toContain('family homestay');
    expect(result.draft.timingRationale).toMatch(/late July|early August/i);
    expect(result.draft.omissions.map((o) => o.name)).toContain('Osh and the south');
  });

  it('derives what the model no longer writes: day numbers, relocation, role and intensity', () => {
    const result = normalizeTripDraftWire(draftJson, { days: 10 });
    if (!result.ok) throw new Error('did not normalise');
    const draft = result.draft;
    expect(draft.days.map((d) => d.dayNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Day 2 moves to Ala-Archa, day 4 stays at Song-Kul.
    expect(draft.days[1]!.relocation).toBe(true);
    expect(draft.days[3]!.relocation).toBeUndefined();
    // The day opens with what it is for.
    expect(draft.days[7]!.anchors[0]!.role).toBe('core');
    // The trek days read as intense from their own contents.
    expect(draft.days[8]!.intensity).toBe('intense');
    expect(draft.days[0]!.intensity).not.toBe('intense');
  });
});

/**
 * THE COMPACT WIRE MUST NOT PRIVILEGE ROAD TRIPS.
 *
 * The fields that went away — `role`, `intensity`, `relocation`, the day
 * number — are the ones a road trip uses most, so the risk of removing them is
 * that a dense city, a lodge circuit or a remote camp comes out worse. Each
 * shape below is written compactly and checked for the thing that shape is
 * about: a city keeps one base and its neighbourhoods, a safari keeps its
 * flights and lodge transfers, a remote trip keeps movement the router cannot
 * measure.
 */
describe('every trip shape survives the compact wire', () => {
  const base = { archetype: 'mixed', purpose: 'p', routeRationale: 'r', transportSummary: 't', omissions: [], tradeoffs: [], backups: [] } as const;

  it('a dense city keeps one base, its neighbourhoods and no invented driving', () => {
    const wire = {
      ...base,
      archetype: 'single_base_urban',
      stays: [{ name: 'Hong Kong', nights: 4, why: 'Central for the transit network.', lodging: 'boutique hotel' }],
      days: [
        { stay: 'Hong Kong', theme: 'Island north shore', acts: [{ name: 'Sheung Wan lanes', kind: 'neighbourhood', why: 'The old shophouse blocks, on foot.' }, { name: 'Victoria Peak', kind: 'viewpoint', how: 'rail', why: 'The tram is the point.' }] },
        { stay: 'Hong Kong', theme: 'Kowloon and the harbour', acts: [{ name: 'Temple Street', kind: 'market', how: 'metro', why: 'Evening market at its own hour.' }] },
        { stay: 'Hong Kong', theme: 'Outlying island', acts: [{ name: 'Lamma Island walk', kind: 'hike', how: 'ferry', why: 'An hour of coastline the city never sees.' }] },
        { stay: 'Hong Kong', theme: 'Last morning', acts: [{ name: 'Tea at a cha chaan teng', kind: 'food', why: 'Near base before an afternoon flight.' }] },
      ],
    };
    const result = normalizeTripDraftWire(wire, { days: 4 });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues.slice(0, 2))).toBe(true);
    if (!result.ok) return;
    expect(result.draft.bases).toHaveLength(1);
    expect(result.draft.days.every((d) => d.relocation === undefined)).toBe(true);
    const modes = result.draft.days.flatMap((d) => d.anchors.map((a) => a.transport).filter(Boolean));
    expect(modes).not.toContain('car');
    expect(modes).toEqual(expect.arrayContaining(['rail', 'metro', 'ferry']));
  });

  it('a lodge circuit keeps its flights and transfers, and never becomes a drive', () => {
    const wire = {
      ...base,
      archetype: 'lodge_circuit',
      stays: [
        { name: 'Tarangire area', nights: 2, why: 'Elephants and the baobabs.', lodging: 'tented camp' },
        { name: 'Serengeti', nights: 3, why: 'The migration is here in these weeks.', lodging: 'mobile camp' },
      ],
      days: [
        { stay: 'Tarangire area', theme: 'Arrive and an afternoon drive', acts: [{ name: 'Tarangire afternoon game drive', kind: 'wildlife', how: 'four_wheel_drive', mins: 180, why: 'The river draws the herds at dusk.' }] },
        { stay: 'Tarangire area', theme: 'Full day in the park', acts: [{ name: 'Full-day Tarangire circuit', kind: 'wildlife', how: 'four_wheel_drive', mins: 480, why: 'A whole day is what the park deserves.' }] },
        { stay: 'Serengeti', theme: 'Fly north', acts: [{ name: 'Light aircraft to the Serengeti', kind: 'activity', how: 'flight', mins: 90, why: 'The road would cost a day each way.' }] },
        { stay: 'Serengeti', theme: 'The migration', acts: [{ name: 'Dawn game drive on the plains', kind: 'wildlife', how: 'guide_or_lodge_transfer', mins: 240, why: 'First light is when the plains move.' }] },
        { stay: 'Serengeti', theme: 'Last morning', acts: [{ name: 'Balloon over the plains', kind: 'activity', how: 'guide_or_lodge_transfer', mins: 180, why: 'The one splurge the brief allowed.' }] },
      ],
    };
    const result = normalizeTripDraftWire(wire, { days: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const modes = new Set(result.draft.days.flatMap((d) => d.anchors.map((a) => a.transport)));
    expect(modes.has('flight')).toBe(true);
    expect(modes.has('four_wheel_drive')).toBe(true);
    expect(modes.has('guide_or_lodge_transfer')).toBe(true);
    expect(modes.has('car')).toBe(false);
    // The move to the Serengeti is inferred from the stay changing.
    expect(result.draft.days[2]!.relocation).toBe(true);
  });

  it('a remote trip keeps boat and horse movement nothing can route', () => {
    const wire = {
      ...base,
      archetype: 'guided_remote',
      stays: [
        { name: 'Delta Gateway', nights: 1, why: 'The airstrip and the outfitter.', lodging: 'guesthouse' },
        { name: 'Reed Channel Camp', nights: 3, why: 'Inside the delta, reachable only by water.', lodging: 'tented camp' },
      ],
      days: [
        { stay: 'Delta Gateway', theme: 'Arrive at the gateway', acts: [{ name: 'Outfitter briefing and supplies', kind: 'town', why: 'Everything past here is carried in.' }] },
        { stay: 'Reed Channel Camp', theme: 'Into the delta', acts: [{ name: 'Mokoro crossing to camp', kind: 'water', how: 'boat', mins: 180, why: 'Poled through the reeds; there is no road.' }] },
        { stay: 'Reed Channel Camp', theme: 'Islands on horseback', acts: [{ name: 'Ride the floodplain islands', kind: 'wildlife', how: 'horse', mins: 300, why: 'Game comes closer to a horse than a vehicle.' }] },
        { stay: 'Reed Channel Camp', theme: 'Out the way you came', acts: [{ name: 'Dawn channel paddle', kind: 'water', how: 'boat', mins: 120, why: 'The birds are on the water before the heat.' }] },
      ],
    };
    const result = normalizeTripDraftWire(wire, { days: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const modes = new Set(result.draft.days.flatMap((d) => d.anchors.map((a) => a.transport)));
    expect(modes.has('boat')).toBe(true);
    expect(modes.has('horse')).toBe(true);
    // A camp is a place to sleep under its own name, not a nearby town.
    expect(result.draft.bases.map((b) => b.name)).toContain('Reed Channel Camp');
  });

  it('a road trip still reads as one, with the moves inferred rather than declared', () => {
    const wire = {
      ...base,
      archetype: 'road_trip',
      stays: [
        { name: 'Hobart', nights: 2, why: 'The south, and the airport.', lodging: 'guesthouse' },
        { name: 'Freycinet', nights: 2, why: 'The east coast beaches.', lodging: 'lodge' },
      ],
      days: [
        { stay: 'Hobart', theme: 'The waterfront', acts: [{ name: 'Salamanca Market', kind: 'market', why: 'Saturday only, and worth the timing.' }] },
        { stay: 'Hobart', theme: 'Mount Wellington', acts: [{ name: 'kunanyi summit road', kind: 'scenic_drive', how: 'car', mins: 150, why: 'The whole estuary from the top.' }] },
        { stay: 'Freycinet', theme: 'North up the coast', acts: [{ name: 'Wineglass Bay lookout', kind: 'hike', how: 'car', mins: 180, why: 'Arrive late enough that the tour buses have gone.' }] },
        { stay: 'Freycinet', theme: 'The peninsula', acts: [{ name: 'Hazards Beach circuit', kind: 'hike', mins: 300, why: 'The long way round, on the day with no driving.' }] },
      ],
    };
    const result = normalizeTripDraftWire(wire, { days: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.archetype).toBe('road_trip');
    expect(result.draft.days[2]!.relocation).toBe(true);
    expect(result.draft.days[1]!.relocation).toBeUndefined();
    expect(result.draft.days[3]!.intensity).toBe('intense');
  });
});

/**
 * THE OUTPUT CEILING IS NOT WHAT TRUNCATES A LONG TRIP.
 *
 * Both cancelled live runs ended on the wall clock, not on `max_tokens` — the
 * stop reason was Sidequest's own abort and 16,000 tokens were never
 * approached. This holds that true as trips get longer: the measured
 * Kyrgyzstan draft is scaled by day count and checked against the ceiling with
 * a reasoning allowance, so a future change that inflates the wire fails here
 * rather than in production.
 */
describe('the output ceiling has headroom at every trip length', () => {
  const TOKENS_PER_BYTE = 1 / 3.6;
  /** Measured on the recorded live calls; held high for margin. */
  const REASONING_ALLOWANCE_TOKENS = 7_000;
  const draftJson = JSON.parse(readFileSync(join(COMPACT_DIR, 'kyrgyzstan-10-day.json'), 'utf8')) as { days: unknown[] };
  const tenDayBytes = wireBytes(draftJson);
  const perDay = tenDayBytes / draftJson.days.length;

  it.each([3, 7, 10, 14, 21])('a %i-day trip fits the ceiling with the reasoning allowance', (days) => {
    // Trip-level prose is roughly a fifth of the ten-day draft and does not grow with days.
    const fixed = tenDayBytes * 0.2;
    const projected = fixed + perDay * 0.8 * days;
    const tokens = projected * TOKENS_PER_BYTE;
    expect(tokens + REASONING_ALLOWANCE_TOKENS).toBeLessThanOrEqual(COMPOSITION_MAX_TOKENS);
  });

  it('a ten-day draft leaves the ceiling several times over, so nothing is encouraged to pad', () => {
    expect(tenDayBytes * TOKENS_PER_BYTE * 4).toBeLessThanOrEqual(COMPOSITION_MAX_TOKENS);
  });
});

/**
 * THE RECOVERED LIVE DRAFT, ALL THE WAY TO A PLAN.
 *
 * The live call produced a complete draft and Sidequest refused it over a
 * display cap. `composition-replay.test.ts` proves the draft now normalises;
 * this proves the rest of the path — reconciliation with no provider reachable
 * at all, which is the worst case — turns it into an itinerary with every day
 * on it. Between the two, everything after the model call is covered offline,
 * and the only step not re-run live is the browser navigation itself.
 */
describe('the recovered live draft becomes a plan', () => {
  it('reconciles into a ten-day itinerary with nothing silently lost', async () => {
    const raw = readFileSync(join(COMPOSITION_DIR, 'kyrgyzstan-compact-1.txt'), 'utf8');
    const body = raw.slice(raw.indexOf('<trip_draft_json>') + 17, raw.lastIndexOf('</trip_draft_json>')).trim();
    const normalized = normalizeTripDraftWire(JSON.parse(body), { days: 10 });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const world = fictionalWorld({
      name: 'Kyrgyzstan',
      center: { lat: 42.3, lng: 77.0 },
      // Nothing resolves: no geocoder, no router, no places. The floor.
      places: [],
      basics: { startDate: '2026-07-04', endDate: '2026-07-13' },
      profile: { maxDailyDriveMinutes: 360, maxDailyTransportMinutes: 480 },
    });
    const result = await reconcileTripDraft({ draft: normalized.draft, context: world.context });

    expect(result.ok).toBe(true);
    expect(result.itinerary.days).toHaveLength(10);
    // Silent loss is zero: every anchor the model wrote ends in one disposition.
    const anchors = normalized.draft.days.reduce((n, d) => n + d.anchors.length, 0);
    expect(result.dispositions).toHaveLength(anchors);
    for (const disposition of result.dispositions.filter((d) => d.disposition.startsWith('rejected') || d.disposition === 'unscheduled_capacity')) {
      expect(result.itinerary.unscheduled.some((u) => u.name === disposition.name)).toBe(true);
    }
    // And it is a trip: the bases keep their nights and the days keep their content.
    expect(result.itinerary.package!.bases.map((b) => b.name)).toEqual(['Bishkek', 'Karakol']);
    expect(result.itinerary.days.filter((d) => d.items.some((i) => i.kind === 'activity')).length).toBeGreaterThanOrEqual(9);
    expect(itinerarySchema.safeParse(result.itinerary).success).toBe(true);
  });
});
