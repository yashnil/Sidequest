import { describe, expect, it, afterEach } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { BenchmarkTripRequest } from '@sidequest/bench';
import {
  SKELETON_EFFORT_ENV,
  SKELETON_GENERATE_INSTRUCTION,
  SKELETON_MAX_TOKENS,
  buildSkeletonTask,
  skeletonComposerEffort,
  skeletonUntrustedPayload,
  tripSkeletonSchema,
  type TripSkeleton,
} from './skeleton';
import { COMPOSER_EFFORT_ENV } from './generate';
import { compositionViewOfPacket, type SkeletonEvidencePacket, type SkeletonEvidencePlace } from './skeleton-packet';

/**
 * THE TOKEN-BUDGET REGRESSION THE 2026-09-01 LIVE FAILURE DEMANDS.
 *
 * That call — the one authorized production acceptance run — consumed its
 * entire 12,700-token output budget on reasoning and emitted zero visible
 * bytes, because (a) effort was inherited from the full-plan composer's
 * default (`high`) rather than scoped to what a composition call needs,
 * and (b) the ceiling had been sized against a synthetic maximal fixture,
 * never against measured visible need plus measured reasoning cost. This
 * file holds the corrected configuration in place structurally:
 *
 * - the composition payload is the projected view, never the full evidence
 *   packet (no coordinates, no source tags, no provenance indices on the
 *   wire);
 * - the composition context for a realistic, real-scale packet stays
 *   bounded;
 * - a realistic rich 13-day draft and an intentionally heavy but plausible
 *   one both fit comfortably under the visible-output budget;
 * - the effort setting is composition-specific — the full-plan composer's
 *   own env var cannot change it.
 *
 * Deliberately no exact-token assertions: everything is bounds with real
 * headroom, so ordinary prompt/schema evolution does not trip this file,
 * only a regression of the failure class it exists to prevent.
 */

const TOKENS_PER_BYTE = 1 / 4; // the same conservative JSON-bytes/4 ratio used across this codebase

function tokens(bytes: number): number {
  return Math.ceil(bytes * TOKENS_PER_BYTE);
}

/**
 * A destination-agnostic packet mirroring the REAL Iceland packet's shape
 * and scale (43 places, 12 clusters, 5 base candidates — the exact counts
 * of the preserved 2026-08-29 artifact), every place carrying the full
 * verification-grade field set the wire view must strip.
 */
function realScalePacket(): SkeletonEvidencePacket {
  const places: SkeletonEvidencePlace[] = Array.from({ length: 43 }, (_, i) => ({
    index: i,
    name: `Fixture Landmark ${String.fromCharCode(65 + (i % 26))}${i}`,
    kind: ['lake', 'day_hike', 'viewpoint', 'hot_spring', 'town_and_food'][i % 5]!,
    cluster: i % 12,
    lat: 60 + i * 0.11,
    lng: -20 + i * 0.07,
    duration: 60 + (i % 4) * 30,
    ...(i % 3 === 0 ? { significance: 0.4 + (i % 6) / 10 } : {}),
    ...(i % 7 === 0 ? { flags: ['unpaved_access'] } : {}),
    ...(i === 11 ? { closedInSeason: true as const } : {}),
    tags: [`places=fixture_${i % 5}`],
    source: i % 4,
    includedFor: ['significant'],
  }));
  return {
    destination: { name: 'Fixture Island', countryCode: 'FX', scale: 'country' },
    tripLength: { days: 13, startDate: '2026-07-05', endDate: '2026-07-17' },
    traveller: {
      nights: 12,
      arrival: 'unknown',
      departure: 'unknown',
      pace: 'balanced',
      activityIntensity: 'moderate',
      transportPreference: 'drive',
      carAvailable: true,
      maxDailyDriveMinutes: 240,
      maxDailyTravelMinutes: 300,
      desiredBaseCount: 5,
      maxBaseChanges: 5,
      strongInterests: ['hiking', 'scenic_viewpoints', 'hot_springs'],
      hardAvoidances: [],
      mustDo: [],
      budget: 'midrange',
    },
    places,
    totalPlacesInPacket: 43,
    clusters: Array.from({ length: 12 }, (_, i) => ({
      index: i,
      lat: 60 + i,
      lng: -20 + i,
      places: places.filter((p) => p.cluster === i).map((p) => p.index),
      totalPlacesInRegion: 4,
    })),
    baseCandidates: Array.from({ length: 5 }, (_, i) => ({
      placeIndex: null,
      name: `Fixture Town ${i}`,
      lat: 60 + i,
      lng: -20 + i,
      basis: 'A real regional hub with amenities, well placed for the surrounding cluster of experiences.',
    })),
    routeLegs: [],
  };
}

function fixtureRequest(): BenchmarkTripRequest {
  // Only the fields the composition prompt actually reads — enough for
  // buildSkeletonTask/skeletonUntrustedPayload, typed loosely on purpose so
  // this fixture does not have to chase unrelated schema fields.
  return {
    requestId: 'fixture',
    freeText: 'Plan what you think is right for us.',
    destination: { text: 'Fixture Island' },
    dates: { startDate: '2026-07-05', endDate: '2026-07-17', nights: 12 },
    arrival: { precision: 'unknown' },
    departure: { precision: 'unknown' },
    party: { adults: 2, children: 0, seniorsInGroup: false, mobility: [], mobilityNotes: '' },
    taste: { mustDo: ['Fixture Landmark A0'], dislikes: ['crowded tourist traps'] },
    practicalities: { budget: 'midrange' },
  } as unknown as BenchmarkTripRequest;
}

/** A realistic, rich 13-day draft — 5 bases, 2–3 anchors/day with natural-length prose, several beyond-packet anchors with names/localities/durations. */
function realisticThirteenDayDraft(): TripSkeleton {
  const days: TripSkeleton['days'] = Array.from({ length: 13 }, (_, i) => {
    const dayNumber = i + 1;
    const baseId = ['south', 'east', 'north', 'west', 'capital'][Math.floor(i / 3)] ?? 'capital';
    const anchors: TripSkeleton['days'][number]['anchors'] = [
      {
        placeIndex: i % 3 === 0 ? i : null,
        ...(i % 3 === 0 ? {} : { name: `A Real Sight Day ${dayNumber}`, locality: `near Fixture Town ${i % 5}` }),
        estimatedDurationMinutes: 90,
        role: 'primary',
        why: 'The signature experience of this stretch of the route, well matched to the pace they asked for.',
      },
      {
        placeIndex: null,
        name: `Lesser Known Stop ${dayNumber}`,
        estimatedDurationMinutes: 45,
        role: 'secondary',
        why: 'A quieter find worth the small detour on the way.',
      },
      ...(i % 2 === 0
        ? [
            {
              placeIndex: null,
              name: `Flexible Extra ${dayNumber}`,
              role: 'secondary' as const,
              why: 'Optional if the day runs ahead of schedule.',
            },
          ]
        : []),
    ];
    return { dayNumber, baseId, theme: `Day ${dayNumber}: a coherent regional theme in a phrase`, intensity: (['light', 'moderate'] as const)[i % 2]!, anchors };
  });
  return {
    archetype: 'loop',
    purpose: 'A full circuit of the island, pacing famous highlights against quieter finds, ending back where it began for departure.',
    bases: [
      { id: 'south', placeIndex: null, name: 'Fixture Town 0', nights: 3, why: 'The southern stretch has the densest run of sights.' },
      { id: 'east', placeIndex: null, name: 'Fixture Town 1', nights: 2, why: 'Breaks the longest drive and opens the east.' },
      { id: 'north', placeIndex: null, name: 'Fixture Town 2', nights: 3, why: 'The northern hub for the lake district.' },
      { id: 'west', placeIndex: null, name: 'Fixture Town 3', nights: 2, why: 'The peninsula deserves its own nights.' },
      { id: 'capital', placeIndex: null, name: 'Fixture Town 4', nights: 2, why: 'Close to departure, with the city to finish on.' },
    ],
    days,
    majorOmissions: [
      { placeIndex: 7, reason: 'Too far off the loop for the days available.' },
      { placeIndex: 19, reason: 'Duplicates a similar experience already on day 4.' },
    ],
    unresolved: ['Whether the highland road is open in early July.'],
  };
}

/** Intentionally heavy but plausible: 8 bases, 4 anchors every day, long (but not cap-maxed) prose, every optional field in regular use. */
function heavyThirteenDayDraft(): TripSkeleton {
  const longWhy = 'A longer, still-plausible sentence of reasoning about why this specific experience belongs on this specific day of the route.';
  const days: TripSkeleton['days'] = Array.from({ length: 13 }, (_, i) => ({
    dayNumber: i + 1,
    baseId: `base-${Math.min(7, Math.floor(i / 2))}`,
    theme: `Day ${i + 1}: a fuller descriptive theme sentence covering the whole day's arc and mood`,
    intensity: 'moderate' as const,
    anchors: Array.from({ length: 4 }, (_, a) => ({
      placeIndex: a === 0 ? (i * 2) % 43 : null,
      ...(a === 0 ? {} : { name: `A Somewhat Longer Real Place Name ${i + 1}-${a}`, locality: `near Fixture Town ${a}` }),
      estimatedDurationMinutes: 30 + a * 45,
      role: (a === 0 ? 'primary' : 'secondary') as 'primary' | 'secondary',
      why: longWhy,
    })),
  }));
  return {
    archetype: 'loop',
    purpose:
      'An intentionally full circuit that still reads like a real plan: every day carries several experiences, every base is justified, and the pacing alternates heavier and lighter days across the whole route.',
    bases: Array.from({ length: 8 }, (_, i) => ({
      id: `base-${i}`,
      placeIndex: null,
      name: `Fixture Town With A Longer Name ${i}`,
      nights: i < 4 ? 2 : 1,
      why: 'A justified stop: it breaks the drive, anchors its region, and has real amenities.',
    })),
    days,
    majorOmissions: Array.from({ length: 6 }, (_, i) => ({
      placeIndex: i * 5,
      reason: 'Seriously weighed and left out for a stated, plausible reason of fit or distance.',
    })),
    unresolved: [
      'Whether the mountain road opens by the trip dates.',
      'Whether the boat trip runs daily in this season.',
      'Whether the festival dates overlap the visit.',
    ],
  };
}

afterEach(() => {
  delete process.env[SKELETON_EFFORT_ENV];
  delete process.env[COMPOSER_EFFORT_ENV];
});

describe('the composition wire view — travel judgment fields only, never the full evidence packet', () => {
  it('strips coordinates, source tags, provenance and hours from every place, preserving indices', () => {
    const packet = realScalePacket();
    const view = compositionViewOfPacket(packet);
    expect(view.places.length).toBe(packet.places.length);
    for (const [i, place] of view.places.entries()) {
      expect(place.index).toBe(packet.places[i]!.index);
      expect(place).not.toHaveProperty('lat');
      expect(place).not.toHaveProperty('lng');
      expect(place).not.toHaveProperty('tags');
      expect(place).not.toHaveProperty('source');
      expect(place).not.toHaveProperty('hours');
      expect(place).not.toHaveProperty('meals');
      expect(place.name).toBe(packet.places[i]!.name);
      expect(place.kind).toBe(packet.places[i]!.kind);
      expect(place.includedFor).toEqual(packet.places[i]!.includedFor);
    }
    // The two rare, materially constraining facts survive.
    expect(view.places[11]).toHaveProperty('closedInSeason', true);
    expect(view.places[7]).toHaveProperty('flags');
  });

  it('the untrusted payload carries the view, not the full packet — no per-place coordinate, tag or provenance reaches the wire', () => {
    const payload = skeletonUntrustedPayload({ request: fixtureRequest(), packet: realScalePacket() });
    const packetOnWire = (payload as { retrievedContent: { packet: { places: Record<string, unknown>[] } } }).retrievedContent.packet;
    for (const place of packetOnWire.places) {
      expect(place).not.toHaveProperty('lat');
      expect(place).not.toHaveProperty('lng');
      expect(place).not.toHaveProperty('tags');
      expect(place).not.toHaveProperty('source');
      expect(place).not.toHaveProperty('hours');
    }
    // Cluster centres and base-candidate positions deliberately keep their
    // coordinates — that is the coarse regional geography a shape decision
    // does need, and it is a dozen-and-a-half records, not one per place.
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('"tags"');
    expect(wire).not.toContain('"source"');
  });

  it('the composition context for a real-scale packet stays bounded', () => {
    const packet = realScalePacket();
    const request = fixtureRequest();
    const untrustedBytes = JSON.stringify(skeletonUntrustedPayload({ request, packet })).length;
    const taskBytes = buildSkeletonTask({ request, packet }).length;
    const instructionBytes = SKELETON_GENERATE_INSTRUCTION.length;
    const schemaBytes = JSON.stringify(zodOutputFormat(tripSkeletonSchema).schema).length;

    // The pre-correction payload for the same-scale real packet measured
    // ~13.5KB (places alone ~10.6KB). The projected view must stay well
    // under that — a generous bound, not a brittle one.
    expect(untrustedBytes).toBeLessThan(10_000);
    // The whole composition-side context (everything but the provider
    // envelope) stays under ~24KB ≈ 6K tokens — roughly the measured
    // pre-correction level minus the evidence cut, with headroom for
    // ordinary prompt evolution.
    expect(instructionBytes + taskBytes + untrustedBytes + schemaBytes).toBeLessThan(24_000);
  });
});

describe('visible-output budget — sized from drafts a model would actually write', () => {
  it('a realistic rich 13-day draft validates and fits with a wide margin', () => {
    const draft = realisticThirteenDayDraft();
    expect(tripSkeletonSchema.safeParse(draft).success).toBe(true);
    const draftTokens = tokens(JSON.stringify(draft).length);
    // Comfortable: at least 3x headroom over the realistic draft, leaving
    // the bulk of the budget as the reasoning allowance the ceiling's own
    // header documents.
    expect(draftTokens * 3).toBeLessThanOrEqual(SKELETON_MAX_TOKENS);
  });

  it('an intentionally heavy but plausible 13-day draft validates and still fits comfortably', () => {
    const draft = heavyThirteenDayDraft();
    expect(tripSkeletonSchema.safeParse(draft).success).toBe(true);
    const draftTokens = tokens(JSON.stringify(draft).length);
    // 2x headroom even for the heavy case — the measured medium-effort
    // reasoning cost (~7,000 tokens on the 2026-08-29 call) plus this
    // draft must both fit, and this asserts exactly that relationship
    // without pinning either number exactly.
    expect(draftTokens + 7_000).toBeLessThanOrEqual(SKELETON_MAX_TOKENS);
    expect(draftTokens * 2).toBeLessThanOrEqual(SKELETON_MAX_TOKENS);
  });
});

describe('effort is composition-scoped', () => {
  it('defaults to low', () => {
    expect(skeletonComposerEffort()).toBe('low');
  });

  it("the full-plan composer's own env var cannot change it", () => {
    process.env[COMPOSER_EFFORT_ENV] = 'high';
    expect(skeletonComposerEffort()).toBe('low');
  });

  it('its own env var can, for a deliberate experiment', () => {
    process.env[SKELETON_EFFORT_ENV] = 'medium';
    expect(skeletonComposerEffort()).toBe('medium');
  });

  it('an invalid override falls back to low rather than passing garbage to the provider', () => {
    process.env[SKELETON_EFFORT_ENV] = 'maximum-overdrive';
    expect(skeletonComposerEffort()).toBe('low');
  });
});

describe('CompositionBudgetReport — the one place the whole budget is visible together', () => {
  it('every measured quantity relates to the configured ceiling the way the recovery pass established', () => {
    const packet = realScalePacket();
    const request = fixtureRequest();
    const report = {
      instructionBytes: SKELETON_GENERATE_INSTRUCTION.length,
      taskBytes: buildSkeletonTask({ request, packet }).length,
      evidenceContextBytes: JSON.stringify(skeletonUntrustedPayload({ request, packet })).length,
      schemaBytes: JSON.stringify(zodOutputFormat(tripSkeletonSchema).schema).length,
      realisticFixtureOutputBytes: JSON.stringify(realisticThirteenDayDraft()).length,
      heavyFixtureOutputBytes: JSON.stringify(heavyThirteenDayDraft()).length,
      configuredMaxOutputTokens: SKELETON_MAX_TOKENS,
      configuredEffort: skeletonComposerEffort(),
    };
    // Structural relationships, not exact figures:
    expect(report.configuredEffort).toBe('low');
    expect(tokens(report.realisticFixtureOutputBytes)).toBeLessThan(tokens(report.heavyFixtureOutputBytes));
    expect(tokens(report.heavyFixtureOutputBytes) + 7_000).toBeLessThanOrEqual(report.configuredMaxOutputTokens);
    const inputTokensEstimate = tokens(
      report.instructionBytes + report.taskBytes + report.evidenceContextBytes + report.schemaBytes,
    );
    expect(inputTokensEstimate).toBeLessThan(6_500);
  });
});
