import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_SET_VERSION,
  buildRegionPortfolio,
  chooseBaseStructure,
  deriveTimeZoneFromLongitude,
  resolveTimeZones,
  singleTimeZone,
  type ClarificationSet,
  type DestinationIndexEntry,
} from '@sidequest/core';
import {
  compileRegion,
  deriveAdaptiveQuestions,
  deriveScope,
  QUESTION_IDS,
} from '@sidequest/compiler';
import {
  SYNTHETIC_WORLDS,
  expectWorld,
  fakeProviders,
  syntheticCandidate,
} from '@sidequest/compiler/testing';

/**
 * THE TRAVEL IQ SUITE.
 *
 * Section 26 asks for an evaluation layer that measures **product
 * intelligence** rather than code correctness — and, critically, that "every
 * scenario must assert which fixture/world actually loaded so tests cannot pass
 * against the wrong world."
 *
 * That second requirement is not a formality. A verification audit found the
 * browser suite typing a ferry archipelago's name and asserting only that a
 * panel rendered, and the compiler suite pinning a world and asserting only
 * things true of all eight. Meanwhile the app's fixture resolver has three
 * silent `?? transit_city` fallbacks. So the first line of every scenario below
 * is `expectWorld`, which checks the scope's identity *and* that the places came
 * from the same world — because those are chosen separately and can disagree.
 *
 * It lives here, under `apps/web`, for a boring and load-bearing reason: it is
 * the only workspace that can see both the compiler and the planner. Putting it
 * in either package would have meant testing half the pipeline.
 *
 * Everything is offline. No provider, no network, no clock dependence, no money.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const MONTHS = [8];

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}


async function compile(
  key: keyof typeof SYNTHETIC_WORLDS,
  options: { nights?: number; answers?: ClarificationSet; composerTransport?: string } = {},
) {
  const spec = SYNTHETIC_WORLDS[key]!;
  const scope = deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: options.answers ?? emptyClarifications(),
    nights: options.nights ?? 4,
    revision: 1,
    ...(options.composerTransport ? { composerTransport: options.composerTransport } : {}),
  });
  return compileRegion({
    compilationId: `iq-${spec.id}`,
    scope,
    dates: DATES,
    months: MONTHS,
    providers: fakeProviders(spec),
    now: NOW,
  });
}

/**
 * Compile, and refuse to continue if the world is not the one asked for.
 *
 * A scenario whose compilation legitimately fails is a finding, not a skip —
 * so the failure is asserted rather than `return`ed past, which is the shape
 * that turns a scenario into a no-op.
 */
async function compileWorld(
  key: keyof typeof SYNTHETIC_WORLDS,
  options: Parameters<typeof compile>[1] = {},
) {
  const result = await compile(key, options);
  if (!result.ok) {
    throw new Error(
      `The ${String(key)} world did not compile: ${result.code} — ${result.message}. ` +
        `A Travel IQ scenario cannot assert anything about a region that does not exist.`,
    );
  }
  expectWorld(result.region, key);
  return result.region;
}

/**
 * Two preliminary scans, shaped rather than named.
 *
 * A suppression test can only demonstrate anything against a case that *would*
 * fire, and a "nothing to ask" test can only demonstrate anything against a
 * scan that exists — passing `preflight: null` returns `[]` from the generator's
 * first line, for any inputs, forever.
 */
function scanCluster(id: string, name: string, transferMinutes: number) {
  return {
    id,
    name,
    center: { lat: 0, lng: transferMinutes / 60 },
    memberCount: 3,
    memberNames: [],
    distanceFromGatewayKm: transferMinutes,
    transferMinutesFromGateway: transferMinutes,
  };
}

function scan(route: { id: string; name: string; transferMinutes: number }[]) {
  const clusters = route.map((entry) => scanCluster(entry.id, entry.name, entry.transferMinutes));
  return {
    schemaVersion: 1 as const,
    destinationKey: 'iq',
    portfolio: {
      gateway: { name: clusters[0]!.name, center: { lat: 0, lng: 0 } },
      route: clusters,
      baseReasons: clusters.map((entry, index) => ({
        clusterId: entry.id,
        reason: index === 0 ? 'the densest part of the region' : 'too far to day-trip',
        nights: 3,
        transferMinutes: index === 0 ? 0 : route[index]!.transferMinutes,
      })),
      satellites: [],
      excluded: [],
      basesProposed: clusters.length,
      transferDays: clusters.length > 1 ? 1 : 0,
      mode: 'drive' as const,
      reachRadiusKm: 70,
      rationale: 'iq',
      estimated: true as const,
    },
    strategies: [],
    dates: null,
    duration: null,
    supply: null,
    builtAt: '2026-08-10T00:00:00.000Z',
    elapsedMs: 1,
  };
}

/** One base, nothing excluded, no season evidence. Nothing left to decide. */
function compactScan() {
  return scan([{ id: 'a', name: 'Core', transferMinutes: 0 }]);
}

/** Two bases, far enough apart that moving hotel is a real decision. */
function spreadScan() {
  return scan([
    { id: 'a', name: 'Core', transferMinutes: 0 },
    { id: 'b', name: 'Second', transferMinutes: 200 },
  ]);
}

// ---------------------------------------------------------------------------
// 26.1 — Major transit metropolis
// ---------------------------------------------------------------------------

describe('IQ: a major transit metropolis', () => {
  it('keeps food and support apart from the things to do', async () => {
    const region = await compileWorld('transit_city');
    /*
     * The honest version of the category-diversity claim.
     *
     * The first form asserted `categories.size >= 3` and `food < 60%` on a
     * fixture whose generator assigns categories round-robin — both were
     * arithmetic facts about the generator, unfalsifiable by any change to the
     * compiler. What *is* a property of the pipeline is that food venues are
     * carried in their own collection rather than competing with attractions
     * for board slots, which is the failure a food-dominated metropolis has.
     */
    const categories = new Set(region.places.map((place) => place.category));
    expect(categories.size).toBeGreaterThanOrEqual(3);
    /* Food lives in `food`, not among the places. */
    const venues = region.food?.venues ?? [];
    expect(venues.length).toBeGreaterThan(0);
    for (const place of region.places) {
      expect(venues.some((venue) => venue.id === place.id)).toBe(false);
    }
  });

  it('resolves the destination time zone rather than defaulting to UTC', async () => {
    const region = await compileWorld('transit_city');
    /*
     * `['UTC']` was the fallback whenever a resolver published no zone, and it
     * is a claim rather than a default: every consumer formats opening hours
     * with `timeZones[0]`.
     */
    expect(region.scope.timeZones.length).toBeGreaterThan(0);
    expect(singleTimeZone(region.scope.timeZones)).toBe(SYNTHETIC_WORLDS.transit_city!.timeZone);
  });

  it('does not claim transit it cannot measure, and does not substitute walking', async () => {
    const region = await compileWorld('transit_city', { composerTransport: 'public_transport' });
    /*
     * The mode a matrix was measured on is a fact about the matrix, and the one
     * value it may never take is the one nothing can supply. `route_transit` is
     * registered by no provider, so a compiled region that claimed a transit
     * measurement would be claiming a capability the registry reports as
     * unsupported — which is the substitution section 32 forbids by name.
     */
    expect(region.travelTimes.mode).not.toBe('transit');
    expect(region.travelTimes.provenance.kind).toBe('measured');
    /* The note says which network, so a reader can tell what they are holding. */
    expect(region.travelTimes.provenance.note.length).toBeGreaterThan(10);
  });

  it('does not widen a car-free traveller’s ground while nothing can measure transit', async () => {
    /*
     * The first attempt at separating "no car" from "on foot" widened the reach
     * unconditionally, and that had a consequence worse than the narrowness it
     * fixed: above twelve kilometres the matrix switches to the road network,
     * so every leg a car-free traveller saw would have become a *driving*
     * duration presented as their travel time.
     *
     * The reach is gated on whether a transit journey can be measured. Nothing
     * configures a transit provider, so both answers reach the same ground —
     * and the artifact stays honest about which network measured it.
     */
    const carFree = await compileWorld('transit_city', { composerTransport: 'public_transport' });
    const onFoot = await compileWorld('transit_city', { composerTransport: 'walk' });
    expect(carFree.scope.reachRadiusKm).toBe(onFoot.scope.reachRadiusKm);
    /* Same ground, therefore the same network measured it. */
    expect(carFree.travelTimes.mode).toBe(onFoot.travelTimes.mode);
    /* And whichever it is, it is never presented as a transit measurement. */
    expect(carFree.travelTimes.mode).not.toBe('transit');
  });

  it('asks no adaptive question when nothing about the trip is unresolved', () => {
    /*
     * The unnecessary-question rate, as a test — and it has to run against a
     * real scan. Passing `preflight: null` returns `[]` from the first line of
     * the generator, for any inputs, against every past and future version of
     * the rules: a green tick for a branch nobody reached.
     *
     * So: a compact single-base region, a driver, a settled shape. Every rule
     * has evidence in front of it and none of them has a decision to resolve.
     */
    expect(deriveAdaptiveQuestions({ preflight: compactScan(), nights: 4, known: { transport: 'drive', shape: 'one_base' } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 26.1 — Weak-data island / archipelago
// ---------------------------------------------------------------------------

describe('IQ: a weak-data archipelago', () => {
  it('keeps separate components representable rather than clipping to one island', async () => {
    /*
     * The defect this guards: not driving selects the walking reach, the walking
     * reach caps at twelve kilometres, and twelve kilometres around the centroid
     * of an archipelago is one island. The destination was silently redefined to
     * the part the traveller could walk across.
     */
    const region = await compileWorld('ferry_island', { composerTransport: 'public_transport' });
    /*
     * The protection is that a **container breadth is never narrowed by how the
     * traveller gets around**. Clipping a city to what somebody can cross
     * leaves you inside the same place; doing it to an archipelago deletes
     * members of it, and "not driving" is not a fact that may decide which
     * islands count as the destination.
     *
     * Asserting a radius tested the wrong mechanism and would have passed for
     * the wrong reason — the radius is a fact about the traveller, and the one
     * that must not move is the breadth.
     */
    expect(region.scope.breadth).toBe(SYNTHETIC_WORLDS.ferry_island!.breadth);
    /*
     * And where no polygon was published, the scope says so rather than
     * presenting a circle as a border.
     */
    expect(region.scope.boundaryEvidence).toBe('reach_circle');
  });

  it('leaves what nobody published unknown rather than filling it in', async () => {
    const region = await compileWorld('weak_data');
    const unknownHours = region.operatingHours.calendars.filter(
      (calendar) => calendar.kind === 'unknown',
    );
    expect(unknownHours.length).toBeGreaterThan(0);
    /*
     * And never presents an unknown as "open all hours", which is the tempting
     * lie. Asserted as an absence rather than as a loop body, because no
     * synthetic calendar emits `always_open` — so the guarded form ran zero
     * times and reported coverage it did not have.
     */
    expect(
      region.operatingHours.calendars.filter(
        (calendar) => calendar.kind === 'always_open' && calendar.provenance.confidence === 0,
      ),
    ).toEqual([]);
  });

  it('says what it dropped and why, rather than dropping it silently', async () => {
    const region = await compileWorld('weak_data');
    expect(region.diagnostics.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 26.1 — Road + satellite region, and dense city
// ---------------------------------------------------------------------------

describe('IQ: a road and satellite region', () => {
  it('keeps a base and reaches satellites from it', async () => {
    const region = await compileWorld('remote_road');
    expect(region.bases.length).toBeGreaterThan(0);
    const satellites = region.places.filter((place) => place.relationship === 'satellite');
    expect(satellites.length).toBeGreaterThan(0);
  });

  it('measures the travel it reports', async () => {
    const region = await compileWorld('remote_road');
    expect(region.travelTimes.provenance.kind).toBe('measured');
    /* Every place carries a travel figure from the base it hangs off. */
    for (const place of region.places) {
      expect(Number.isFinite(place.travelFromBase.driveMinutes)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 26.1 — Broad country: multi-base reasoning without a day trip to everywhere
// ---------------------------------------------------------------------------

describe('IQ: a broad country', () => {
  it('compiles as a country rather than as a city with a bigger circle', async () => {
    const region = await compileWorld('broad_country', { nights: 12 });
    expect(region.places.length).toBeGreaterThan(0);
    /*
     * `places.length > 0` was the whole assertion, which is true of every world
     * at every breadth and says nothing about the claim in the title. The
     * property that distinguishes a country is that its extent is *not* clipped
     * to what a traveller can cross, and that it carries more than one area.
     */
    expect(region.scope.breadth).toBe('country');
    expect(region.subregions.length + region.bases.length).toBeGreaterThan(1);
  });

  it('does not turn every nearby place into a second base', () => {
    /*
     * The founder-test regression, as a property rather than as a destination.
     * A dense core plus a prominent settlement a hundred kilometres out, on a
     * trip the core already fills: the far one is a rejection with a reason,
     * never a hotel change nobody asked for.
     */
    const structure = chooseBaseStructure({
      clusters: [
        {
          id: 'core',
          name: 'Core',
          center: { lat: 35.68, lng: 139.76 },
          memberCount: 22,
          weight: 46,
          memberNames: [],
        },
        {
          id: 'far',
          name: 'Far',
          center: { lat: 36.56, lng: 139.88 },
          memberCount: 6,
          weight: 18,
          memberNames: [],
        },
      ],
      reach: 'transit',
      nights: 6,
      maxBaseChanges: null,
    });
    expect(structure.bases).toHaveLength(1);
    expect(structure.rejected[0]?.reason.length).toBeGreaterThan(20);
  });

  it('gives every base it does propose a traveller-facing reason', () => {
    const entries: DestinationIndexEntry[] = [
      {
        id: 'a',
        catalog: 'iq',
        sourceId: 'a',
        featureType: 'city',
        displayName: 'Capital',
        aliases: [],
        hierarchy: [],
        center: { lat: 42.87, lng: 74.6 },
        population: 1_000_000,
        prominence: 92,
      },
      {
        id: 'b',
        catalog: 'iq',
        sourceId: 'b',
        featureType: 'city',
        displayName: 'Lakeside',
        aliases: [],
        hierarchy: [],
        center: { lat: 42.49, lng: 78.39 },
        population: 200_000,
        prominence: 70,
      },
    ];
    const portfolio = buildRegionPortfolio({
      entries,
      mode: 'drive',
      nights: 14,
      destinationName: 'Testland',
    });
    expect(portfolio.baseReasons).toHaveLength(portfolio.route.length);
    for (const entry of portfolio.baseReasons) {
      expect(entry.reason.length).toBeGreaterThan(15);
    }
  });
});

// ---------------------------------------------------------------------------
// 26.1 — Novel destination: the architecture generalises without name logic
// ---------------------------------------------------------------------------

describe('IQ: a novel destination shape', () => {
  it('compiles a world that was never the original vertical slice', async () => {
    /*
     * `rail_corridor` is the multi-time-zone shape and was, until recently,
     * reachable from no browser test at all — a world only the unit tests saw.
     * If anything in the pipeline had acquired destination-name logic, this is
     * where it would show.
     */
    const region = await compileWorld('rail_corridor', { nights: 8 });
    expect(region.places.length).toBeGreaterThan(0);
    /*
     * The interesting property of this world, and the one a generic
     * `timeZones.length > 0` could not see: it spans **two** zones. A region
     * that collapsed them to one would apply one side's clock to both, which is
     * how a timetable moves by an hour.
     */
    expect(region.scope.timeZones.length).toBe(2);
    expect(singleTimeZone(region.scope.timeZones)).toBeNull();
  });

  it('derives a defensible zone from longitude when nobody published one', () => {
    /*
     * POSIX `Etc/GMT±N` is inverted relative to ISO 8601, and getting it
     * backwards is an eighteen-hour error — so the sign is asserted rather than
     * trusted to a comment.
     */
    expect(deriveTimeZoneFromLongitude(139.7)).toBe('Etc/GMT-9');
    expect(deriveTimeZoneFromLongitude(-74)).toBe('Etc/GMT+5');
    expect(deriveTimeZoneFromLongitude(0)).toBe('UTC');

    const resolved = resolveTimeZones({ published: [], center: { lat: 35.6, lng: 139.7 } });
    expect(resolved.basis).toBe('derived_from_longitude');
    expect(resolved.zones).toEqual(['Etc/GMT-9']);

    /* A published zone always wins, and says so. */
    const published = resolveTimeZones({
      published: ['Asia/Tokyo'],
      center: { lat: 35.6, lng: 139.7 },
    });
    expect(published.basis).toBe('published');
    expect(published.zones).toEqual(['Asia/Tokyo']);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: uncertainty honesty and question relevance
// ---------------------------------------------------------------------------

describe('IQ: uncertainty is honest across every world', () => {
  const keys = Object.keys(SYNTHETIC_WORLDS) as (keyof typeof SYNTHETIC_WORLDS)[];

  it('never reports a measured leg count that is impossible', async () => {
    /*
     * `if (!result.ok) continue` used to sit here, which is the shape that
     * turns a scenario into a no-op the moment a world stops compiling. A world
     * that legitimately refuses is a *finding*, so it is collected and asserted
     * rather than stepped over.
     */
    const refused: string[] = [];
    let finiteOffDiagonal = 0;
    for (const key of keys) {
      const result = await compile(key);
      if (!result.ok) {
        refused.push(`${key}: ${result.code}`);
        continue;
      }
      expectWorld(result.region, key);
      const { minutes } = result.region.travelTimes;
      minutes.forEach((row, rowIndex) => {
        row.forEach((cell, columnIndex) => {
          /* NaN is the honest unmeasured value; a negative number is not. */
          if (!Number.isFinite(cell)) return;
          expect(cell).toBeGreaterThanOrEqual(0);
          if (rowIndex !== columnIndex && cell > 0) finiteOffDiagonal += 1;
        });
      });
    }
    /*
     * An all-zero matrix satisfies "no negative cell" and is exactly the
     * impossible report this test is named for, so at least one real leg has
     * to have been measured somewhere.
     */
    expect(finiteOffDiagonal).toBeGreaterThan(0);
    /* Which worlds refuse is a fact worth pinning; a new refusal is a change. */
    expect(refused.map((entry) => entry.split(':')[0]).sort()).toEqual(
      ['unplannable_region', 'unreachable_region'].filter((world) =>
        refused.some((entry) => entry.startsWith(world)),
      ),
    );
  });

  it('scopes every world to a resolved zone rather than to UTC by default', async () => {
    let checked = 0;
    for (const key of keys) {
      const result = await compile(key);
      if (!result.ok) continue;
      checked += 1;
      expectWorld(result.region, key);
      expect(result.region.scope.timeZones.length).toBeGreaterThan(0);
      /*
       * A world whose spec declares a real zone must carry it. `UTC` is only
       * acceptable where the world genuinely sits on the meridian.
       */
      const spec = SYNTHETIC_WORLDS[key]!;
      if (spec.timeZone !== 'UTC') {
        expect(result.region.scope.timeZones).toContain(spec.timeZone);
      }
    }
    /* A loop that checked nothing would otherwise pass silently. */
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});

describe('IQ: the identity guard itself', () => {
  it('catches an artifact whose scope and places disagree', async () => {
    const region = await compileWorld('transit_city');
    /*
     * The guard has to be able to fail, and this is the pairing no
     * scope-only assertion catches: correct identity, another world's records.
     */
    const tampered = {
      ...region,
      places: region.places.map((place) => ({ ...place, regionId: 'compiled-somewhere-else' })),
    };
    expect(() => expectWorld(tampered, 'transit_city')).toThrow(/belong to another region/);
  });

  it('catches a test that named a world it did not get', async () => {
    const region = await compileWorld('transit_city');
    expect(() => expectWorld(region, 'ferry_island')).toThrow(/expected the ferry_island world/);
  });
});

describe('IQ: questions are asked only when they change something', () => {
  it('suppresses a question the traveller has already answered', () => {
    const spread = {
      schemaVersion: 1 as const,
      destinationKey: 'iq',
      portfolio: {
        gateway: { name: 'Core', center: { lat: 0, lng: 0 } },
        route: [
          {
            id: 'a',
            name: 'Core',
            center: { lat: 0, lng: 0 },
            memberCount: 3,
            memberNames: [],
            distanceFromGatewayKm: 0,
            transferMinutesFromGateway: 0,
          },
          {
            id: 'b',
            name: 'Second',
            center: { lat: 2, lng: 0 },
            memberCount: 3,
            memberNames: [],
            distanceFromGatewayKm: 200,
            transferMinutesFromGateway: 200,
          },
        ],
        baseReasons: [
          { clusterId: 'a', reason: 'densest', nights: 3, transferMinutes: 0 },
          { clusterId: 'b', reason: 'far', nights: 3, transferMinutes: 200 },
        ],
        satellites: [],
        excluded: [],
        basesProposed: 2,
        transferDays: 1,
        mode: 'drive' as const,
        reachRadiusKm: 200,
        rationale: 'iq',
        estimated: true as const,
      },
      strategies: [],
      dates: null,
      duration: null,
      supply: null,
      builtAt: '2026-08-10T00:00:00.000Z',
      elapsedMs: 1,
    };

    const asked = deriveAdaptiveQuestions({ preflight: spread, nights: 8 });
    expect(asked).toHaveLength(1);
    /* Every question can point at what made it ask. */
    expect(asked[0]!.evidenceThatTriggeredIt?.length).toBeGreaterThan(0);
    expect(asked[0]!.decisionAffected).toBeDefined();

    /* And the same trip, once the traveller has said, is asked nothing. */
    expect(
      deriveAdaptiveQuestions({ preflight: spread, nights: 8, known: { shape: 'two_bases' } }),
    ).toEqual([]);
  });

  it('stops asking once the traveller has answered, on a scan that would otherwise ask', () => {
    /*
     * Suppression can only be demonstrated against a case that *would* fire.
     * This asserted `[].every(...)` on a null scan — true by vacuity — and then
     * asserted a property of its own fixture builder.
     *
     * The spread scan below genuinely produces the hotel-move question. The
     * claim is that stating a shape removes it.
     */
    const scan = spreadScan();
    expect(deriveAdaptiveQuestions({ preflight: scan, nights: 8 })).toHaveLength(1);
    expect(
      deriveAdaptiveQuestions({ preflight: scan, nights: 8, known: { shape: 'two_bases' } }),
    ).toEqual([]);
    /* And the trait-gated bank's own ids never appear among the adaptive ones. */
    const asked = deriveAdaptiveQuestions({ preflight: scan, nights: 8 });
    expect(asked.every((question) => question.id !== QUESTION_IDS.carAvailable)).toBe(true);
  });
});
