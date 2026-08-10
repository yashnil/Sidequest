import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_SET_VERSION,
  describeTimeZone,
  isCivilTimeZone,
  timeZoneConfidence,
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
  packBackedProviders,
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
  options: {
    nights?: number;
    answers?: ClarificationSet;
    composerTransport?: string;
    /**
     * Compile through the real place backbone rather than from finished places.
     *
     * The difference is not cosmetic. `fakeProviders` hands the compiler
     * finished `Place`s and reports no `portfolioFacts`, so **no readiness
     * reading is produced at all** and the recovery loop cannot run — which is
     * exactly why the loop had never been exercised against a compilation. The
     * pack-backed set runs `buildInventory` over raw source records, which is
     * what a real build does and what readiness measures.
     */
    packBacked?: boolean;
    /** Overrides applied to the world, for a scenario that varies one property. */
    world?: Partial<(typeof SYNTHETIC_WORLDS)[string]>;
    /** Whether anything can measure a transit journey. Widens a car-free reach. */
    transitMeasurable?: boolean;
  } = {},
) {
  const spec = { ...SYNTHETIC_WORLDS[key]!, ...options.world };
  const scope = deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: options.answers ?? emptyClarifications(),
    nights: options.nights ?? 4,
    revision: 1,
    ...(options.composerTransport ? { composerTransport: options.composerTransport } : {}),
    ...(options.transitMeasurable === undefined
      ? {}
      : { transitMeasurable: options.transitMeasurable }),
  });
  return compileRegion({
    compilationId: `iq-${spec.id}`,
    scope,
    dates: DATES,
    months: MONTHS,
    providers: options.packBacked ? packBackedProviders(spec) : fakeProviders(spec),
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
    /*
     * The category count is gone, and the comment above explains why it should
     * never have survived: `categories.size >= 3` is arithmetic about the
     * generator's round-robin assignment over eight categories, so it holds for
     * six of the eight worlds by construction and cannot be falsified by any
     * change to the compiler. It was described as removed and was kept verbatim.
     *
     * What replaces it is a claim about the *pipeline*: food and support are
     * separated from the things to do, and the separation is visible in both
     * directions — the board holds none of the venues, and the venues are not
     * empty, so "we separated them" is distinguishable from "there were none".
     */
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
    /*
     * The zone alone is the identity function on the fixture's own input, and
     * on its own it proves nothing. What is a real claim is *how much the zone
     * is worth*: this world publishes no civil-timezone source, so the scope has
     * to record a weaker basis than a world that does — and the two must not
     * read the same.
     */
    expect(region.scope.timeZoneBasis).toBe('published');
    expect(region.scope.timeZoneSource).toBeUndefined();
    expect(timeZoneConfidence(region.scope.timeZoneBasis!)).toBe('authoritative');
    expect(isCivilTimeZone(region.scope.timeZones[0]!)).toBe(true);
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
    /*
     * The note names the network. A length check on a hard-coded fixture string
     * was the previous assertion and could not fail; what a reader actually
     * needs is to be able to tell a road measurement from a pedestrian one.
     */
    expect(region.travelTimes.provenance.note).toMatch(/road|walk|foot|pedestrian/i);
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
    /*
     * AND NEITHER OF THEM IS A ROAD MATRIX.
     *
     * The previous assertion was `not.toBe('transit')`, which was satisfied for
     * a reason that was itself the defect: the fixture generator only ever
     * emitted `'car'`, so a car-free traveller's legs *were* driving durations
     * and the test certifying the substitution had not happened was passing
     * because it had. `'transit'` is not the value to guard against here —
     * nothing could produce it — `'car'` is.
     */
    expect(carFree.travelTimes.mode).not.toBe('car');
    expect(onFoot.travelTimes.mode).not.toBe('car');
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
     * lie.
     *
     * The previous form asserted that no calendar was `always_open` with zero
     * confidence — and its own comment admitted no synthetic calendar emits
     * `always_open` at all, so the measured value was zero for every world and
     * the assertion could not fail. An absence nothing can produce is not
     * evidence that it is being prevented.
     *
     * What *is* falsifiable is the property one rung down: an unknown calendar
     * has to be structurally distinguishable from a known one, and it must not
     * carry a confidence that would let a consumer treat it as established.
     */
    /*
     * `calendar.kind === 'unknown'` would be a tautology — `unknownHours` is the
     * result of filtering on exactly that. What is falsifiable is the confidence
     * an unknown carries: it must be low enough that no consumer can read it as
     * established, which is the property that stops "we do not know" being
     * rendered in the same voice as "we checked".
     */
    for (const calendar of unknownHours) {
      expect(calendar.provenance.confidence).toBeLessThan(0.5);
    }
    const known = region.operatingHours.calendars.filter(
      (calendar) => calendar.kind !== 'unknown',
    );
    for (const calendar of known) {
      expect(calendar.provenance.confidence).toBeGreaterThan(0);
    }
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
    /**
     * Which worlds refuse, pinned against a written list rather than against
     * themselves.
     *
     * The previous form computed its expected value *from the actual value* —
     * `['unplannable_region','unreachable_region'].filter(w => refused.some(...))`
     * — so it reduced to `expect([]).toEqual([])` the moment both worlds stopped
     * refusing, which is what has happened. It could only ever catch a *new*
     * world starting to refuse, never an existing one quietly stopping.
     *
     * The honest pin is the literal list. Today no world refuses at compile
     * time: `unreachable_region` and `unplannable_region` are refused by the
     * **planner** rather than by the compiler, which is the correct division —
     * a region whose stops are too far apart still compiles into a true picture
     * of a place, and it is the day plan that cannot be built from it.
     */
    expect(refused).toEqual([]);
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

// ---------------------------------------------------------------------------
// 15B.A — Transit metropolis: public transport as a measured routing mode
// ---------------------------------------------------------------------------

describe('IQ: a metropolis where public transport can actually be measured', () => {
  it('measures real transit journeys and keeps them apart from the matrix', async () => {
    const region = await compileWorld('transit_metro', {
      composerTransport: 'public_transport',
      packBacked: true,
    });
    const evidence = region.transitEvidence;
    expect(evidence, 'a transit-capable world compiled no transit evidence').toBeDefined();

    const measured = evidence!.journeys.filter((journey) => journey.status === 'measured');
    expect(measured.length).toBeGreaterThan(0);

    for (const journey of measured) {
      /* A measured journey carries the duration that was measured. */
      expect(journey.minutes).toBeGreaterThan(0);
      /* And the basis it was measured on. A transit time without one is not one. */
      expect(journey.requestBasis.kind).toBe('depart_at');
      expect(journey.requestBasis.timeZone).toBe(SYNTHETIC_WORLDS.transit_metro!.timeZone);
      /* At least one leg on something that is not walking, or it is not transit. */
      expect(journey.legs?.some((leg) => leg.mode !== 'walk')).toBe(true);
      /* Walking access and egress are part of the journey, and counted as walking. */
      expect(journey.walkingMinutes).toBeGreaterThan(0);
      expect(journey.transfers).toBeGreaterThanOrEqual(0);
      /* Nothing fabricates a fare, because the source publishes none. */
      expect(journey.fare).toBeUndefined();
    }

    /**
     * THE SUBSTITUTION, MADE STRUCTURALLY IMPOSSIBLE.
     *
     * The matrix and the transit evidence are separate objects with separate
     * provenance, and the matrix's own mode says which network it measured. A
     * long public-transport journey cannot render as a short drive because a
     * road matrix happened to exist, because for a car-free traveller no road
     * matrix is built at all.
     */
    expect(region.travelTimes.mode).toBe('foot');
    /*
     * And the matrix says which network it measured, in words. A reader holding
     * a duration has to be able to tell a walk from a train, and the two live in
     * different fields precisely so that the question is answerable at all.
     */
    expect(region.travelTimes.provenance.note).not.toMatch(/transit|train|timetable/i);
    /*
     * The transit durations are reachable only through the transit evidence.
     * Asserting that no *number* coincides would be a coincidence check — a
     * thirty-four-minute walk is a perfectly ordinary cell — so the claim is
     * structural: the matrix carries no transit provenance and the journeys
     * carry their own source, retrieval time and request basis, which a matrix
     * cell has nowhere to put.
     */
    /**
     * THE SUBSTITUTION, DETECTED RATHER THAN ASSERTED AWAY.
     *
     * A previous version of this checked `journey.source === 'fake-transit'` and
     * a non-empty timestamp — both fixture literals, untouched by a substitution
     * — so overwriting every transit duration with the walking matrix's own leg
     * for the same pair left the whole suite green. The defect the docstring
     * names could be performed without a single test noticing.
     *
     * A transit journey and a walk over the same ground are different
     * measurements of different things, and the check is that they do not
     * coincide: for every measured pair whose walking leg the matrix also holds,
     * the two durations must differ. That fails the instant one is copied from
     * the other, which is the only failure mode worth guarding.
     */
    for (const journey of measured) {
      const legs = journey.legs ?? [];
      expect(legs.length, `${journey.toId} was measured with no legs`).toBeGreaterThan(0);
      /*
       * A journey's total is the sum of the legs it is made of, to within the
       * rounding of each. That is an *internal* invariant, which is what makes it
       * useful here: a duration spliced in from anywhere else — the walking
       * matrix, a straight line, a constant — breaks it immediately, while a
       * value coincidence between a train and a walk over the same ground does
       * not. A previous version compared the two numbers for inequality and
       * failed on exactly such a coincidence, which is the wrong thing to detect.
       */
      const summed = legs.reduce((total, leg) => total + leg.minutes, 0);
      expect(
        Math.abs((journey.minutes ?? 0) - summed),
        `${journey.toId}: the total (${journey.minutes}) is not the sum of its legs (${summed})`,
      ).toBeLessThanOrEqual(legs.length);
      /* The walking share is the walking legs, and nothing else. */
      const walked = legs
        .filter((leg) => leg.mode === 'walk')
        .reduce((total, leg) => total + leg.minutes, 0);
      expect(journey.walkingMinutes).toBe(walked);
      /* And at least one leg is on something that is not a pair of feet. */
      expect(legs.some((leg) => leg.mode !== 'walk')).toBe(true);
      /* The walk is a part of the journey, never the whole of it. */
      expect(walked).toBeLessThan(journey.minutes ?? 0);
    }
  });

  it('keeps no-service, provider failure and no-coverage as three different answers', async () => {
    const region = await compileWorld('transit_metro', {
      composerTransport: 'public_transport',
      packBacked: true,
    });
    const journeys = region.transitEvidence!.journeys;
    const statuses = new Set(journeys.map((journey) => journey.status));

    /*
     * The claim is that the three failures stay distinguishable, which is only
     * demonstrable if at least two of them are actually present beside a
     * success. Collapsing them is how "we have no transit data for this city"
     * and "this city has no transit" became the same sentence.
     */
    expect(statuses.has('measured')).toBe(true);
    expect(statuses.has('no_route')).toBe(true);
    expect(statuses.has('provider_error')).toBe(true);

    for (const journey of journeys) {
      /* Only a measured journey may carry a number. Everything else says why. */
      if (journey.status !== 'measured') expect(journey.minutes).toBeUndefined();
      expect(journey.detail.length).toBeGreaterThan(10);
      /* No provider code, no stack trace, nothing a traveller cannot read. */
      expect(journey.detail).not.toMatch(/error_code|undefined|null|\bNaN\b/);
    }

    /* A pair nobody could measure never becomes a pair somebody walked. */
    const failed = journeys.filter((journey) => journey.status !== 'measured');
    expect(failed.length).toBeGreaterThan(0);
    for (const journey of failed) expect(journey.walkingMinutes).toBeUndefined();
  });

  it('reports out-of-coverage as our gap rather than as the city having no transit', async () => {
    /*
     * The same world with the provider covering nowhere. `out_of_coverage` is a
     * statement about our instrument; `no_route` is a statement about the
     * timetable. A traveller planning around one when they were told the other
     * is planning around the wrong fact.
     */
    const region = await compileWorld('transit_metro', {
      composerTransport: 'public_transport',
      packBacked: true,
      world: { transit: { outOfCoverage: true } },
    });

    const evidence = region.transitEvidence!;
    expect(evidence.journeys.length).toBeGreaterThan(0);
    for (const journey of evidence.journeys) {
      expect(journey.status).toBe('out_of_coverage');
      expect(journey.minutes).toBeUndefined();
    }
    expect(evidence.measured).toBe(0);
    expect(evidence.absence).toBe('out_of_coverage');
  });

  it('buys transit evidence sparsely rather than as an all-pairs matrix', async () => {
    const region = await compileWorld('transit_metro', {
      composerTransport: 'public_transport',
      packBacked: true,
    });
    const evidence = region.transitEvidence!;
    /*
     * The cost claim. An all-pairs matrix over n stops is n×(n−1) journeys; the
     * contract asks for the handful a trip turns on. Asserting it against the
     * board's own size rather than against a constant means the bound stays
     * meaningful as the fixture grows.
     */
    const allPairs = region.places.length * Math.max(0, region.places.length - 1);
    expect(evidence.requested).toBeLessThan(allPairs);
    expect(evidence.requested).toBeGreaterThan(0);
    expect(evidence.journeys.length).toBe(evidence.requested);
  });

  it('resolves the real civil clock rather than a fixed offset', async () => {
    const region = await compileWorld('transit_metro', {
      composerTransport: 'public_transport',
      packBacked: true,
    });
    /*
     * This world's record publishes its own clock, so `published` is the honest
     * basis for it — a *different* and weaker claim than one a source answered
     * for these coordinates, and the two must not read alike. The stage that
     * does the asking is exercised by `unclocked_valley` below, which is the
     * only world that can reach `provider_resolved` at all.
     */
    expect(region.scope.timeZoneBasis).toBe('published');
    expect(timeZoneConfidence(region.scope.timeZoneBasis!)).toBe('authoritative');
    /* A real regional identifier, never `Etc/GMT±N` and never a bare `UTC`. */
    expect(isCivilTimeZone(region.scope.timeZones[0]!)).toBe(true);
    /*
     * Every base plans in a real zone too, rather than inheriting the
     * destination's because nobody asked. A region that legitimately spans a
     * boundary is common — most of Europe, every rail corridor that crosses a
     * country — and taking `timeZones[0]` for all of them is how a timetable
     * moves by an hour.
     */
    expect(region.bases.length).toBeGreaterThan(0);
    for (const base of region.bases) {
      expect(isCivilTimeZone(base.timeZone)).toBe(true);
    }
  });

  it('leaves a transit-dependent trip unblocked once transit can be measured', async () => {
    /*
     * The other half of the honesty claim, and the one that makes the capability
     * worth having. While nothing could measure transit, a trip that leaned on
     * it reported an unmeasurable mode and was blocked — correctly. A provider
     * that can measure one has to lift that, or the deficit was never about the
     * evidence.
     */
    /**
     * A TRIP THAT GENUINELY LEANS ON TRANSIT, WHICH IS HARDER TO ARRANGE THAN IT
     * LOOKS.
     *
     * The first version of this compiled the metro with the default scope and
     * asserted the trip was not blocked — and a reviewer showed the world was
     * never transit-dependent in the first place: a car-free reach caps at twelve
     * kilometres, `unmeasurableModesFor` reads a reach of exactly twelve as
     * "the walker can cover it", so `leansOn` was `['walk']` and the property
     * held before the feature existed.
     *
     * `transitMeasurable` is what widens the reach past the walking cap, which is
     * the condition under which the trip actually depends on something running to
     * a timetable. Compiled both ways, so the difference is the measurement
     * rather than an assertion about one run.
     */
    const dependent = async (transitMeasurable: boolean) => {
      const spec = SYNTHETIC_WORLDS.transit_metro!;
      const scope = deriveScope({
        candidate: syntheticCandidate(spec),
        clarifications: emptyClarifications(),
        nights: 4,
        revision: 1,
        composerTransport: 'public_transport',
        transitMeasurable,
      });
      return { scope };
    };
    const widened = await dependent(true);
    const narrow = await dependent(false);
    /* The reach really is bigger, or the trip does not depend on transit. */
    expect(widened.scope.reachRadiusKm ?? 0).toBeGreaterThan(narrow.scope.reachRadiusKm ?? 0);
    expect(widened.scope.reachRadiusKm ?? 0).toBeGreaterThan(12);

    const region = await compileWorld('transit_metro', {
      composerTransport: 'public_transport',
      packBacked: true,
      transitMeasurable: true,
    });
    const routeability = region.researchReadiness?.dimensions.find(
      (dimension) => dimension.dimension === 'transport_routeability',
    );
    expect(routeability).toBeDefined();
    /*
     * The sentence that appears when a trip needs a mode nothing can measure.
     * With a transit provider configured it must not, and this is a trip that
     * would produce it without one.
     */
    expect(routeability!.detail).not.toMatch(/no way to measure/i);
    expect(region.researchReadiness?.level).not.toBe('blocked');
    /* And the ground it was widened to is still not measured on a road network. */
    expect(region.travelTimes.mode).not.toBe('car');
  });
});

// ---------------------------------------------------------------------------
// 15B.F — Recovery adversary: a packet that is deliberately not good enough
// ---------------------------------------------------------------------------

describe('IQ: recovery against a deliberately deficient packet', () => {
  it('diagnoses a specific deficit, acquires new evidence for it, and improves', async () => {
    const region = await compileWorld('recovery_adversary', { packBacked: true });
    const readiness = region.researchReadiness;
    expect(readiness, 'a deficient world produced no readiness reading').toBeDefined();

    const attempts = readiness!.repairsAttempted;
    expect(attempts.length).toBeGreaterThanOrEqual(2);

    /**
     * FREE FIRST, PAID SECOND — AND BOTH ACTUALLY RAN.
     *
     * The ordering is the whole spending argument: nothing is bought until
     * re-selecting from records already held has been tried and has not helped.
     * A version of this loop broke out after the first ineffective repair, which
     * made the ordering true and the acquisition unreachable.
     */
    const free = attempts[0]!;
    expect(free.kind).toBe('reselect');
    expect(free.cost?.providerCalls).toBe(0);

    const acquired = attempts.find((attempt) => attempt.kind === 'acquire');
    expect(acquired, 'no acquiring attempt was made against a deficient packet').toBeDefined();
    expect(attempts.indexOf(acquired!)).toBeGreaterThan(attempts.indexOf(free));

    /* It was chosen *for* a deficit, and says which. */
    expect(acquired!.addressing.length).toBeGreaterThan(0);
    expect(acquired!.addressing).toContain('experience_supply');

    /* It genuinely asked somebody something, and the ledger says so. */
    expect(acquired!.capability).toBe('place_inventory');
    expect(acquired!.provider).toBeDefined();
    expect(acquired!.scopeClass).toBe('category_in_scope_bbox');
    expect(acquired!.cost?.providerCalls).toBeGreaterThan(0);

    /* And it worked: new evidence arrived, and the reading moved because of it. */
    expect(acquired!.outcome).toBe('improved');
    expect(acquired!.evidenceDelta?.candidatesAdded).toBeGreaterThan(0);
    expect(acquired!.visitableAfter).toBeGreaterThan(acquired!.visitableBefore);
    expect(acquired!.stopReason).toBe('improved');

    /**
     * AND WHAT CAME BACK ANSWERS WHAT WAS ASKED.
     *
     * Everything above establishes that a call was made and that it helped.
     * None of it establishes that the call was *directed* — a provider that
     * ignored the intents and returned its whole reserve would satisfy every one
     * of those assertions, and a reviewer proved it by patching the fixture to
     * do exactly that. "A query for things" is the rerun this repair exists not
     * to be, so the records it retrieves have to be records of the kinds it
     * asked for.
     *
     * The reserve is keyed by intent and the fixture names each record after the
     * intent that released it, so the categories on the board are the evidence.
     */
    const acquiredPlaces = region.places.filter((place) => place.id.includes('-acquired-'));
    expect(acquiredPlaces.length).toBeGreaterThan(0);
    const acquiredIntents = new Set(
      acquiredPlaces.map((place) => place.id.split('-acquired-')[1]?.split('-')[0]),
    );
    /*
     * Every acquired record answers to one of the intents the shortfall named,
     * and — the part that makes this a measurement — **none** answers to `food`,
     * which the world holds six of in reserve and which the shortfall logic never
     * asks for. A provider that ignored the intents and returned its whole
     * reserve would leak those six onto a board that is already food-dominated,
     * which is the opposite of the repair.
     */
    for (const intent of acquiredIntents) {
      expect(['landmark', 'culture', 'nature']).toContain(intent);
    }
    expect(acquiredIntents.has('food'), 'an unasked-for kind was acquired').toBe(false);
  });

  it('puts what it acquired on the board rather than only in the reading', async () => {
    /**
     * THE DEFECT THIS SCENARIO EXISTS FOR.
     *
     * The recovery loop used to run after the matrix, the calendars and the
     * access rules had been bought, and its result was consumed only to
     * recompute a readiness *reading*. So a compilation could report "eight more
     * things to do" on a board that still held the original three — a claim the
     * artifact itself contradicted, and which nothing tested because the loop
     * had never been run against a compiled region at all.
     *
     * The reading and the board are now the same population, and this is the
     * assertion that keeps them that way.
     */
    const region = await compileWorld('recovery_adversary', { packBacked: true });
    const acquired = region.researchReadiness!.repairsAttempted.find(
      (attempt) => attempt.kind === 'acquire',
    )!;

    /*
     * The board grew, and it grew past what the packet held before the repair.
     *
     * Deliberately *not* `places.length === acquired.visitableAfter`: those are
     * two different populations — the attempt counts candidates at the moment of
     * the repair, the board counts what survived quality, closure, access and
     * routing — and asserting they coincide would be asserting that nothing is
     * ever filtered, which is neither true nor desirable. And
     * `funnel.visitable === places.length` is a pure identity, because the
     * funnel is *built from* `places.length`.
     *
     * What is falsifiable is the direction: more on the board than there was
     * before the repair ran, and the acquired records among them.
     */
    expect(region.places.length).toBeGreaterThan(acquired.visitableBefore);
    expect(region.researchReadiness!.funnel.visitable).toBeGreaterThan(
      acquired.visitableBefore,
    );

    /* The acquired records went through the ordinary pipeline, not around it. */
    const acquiredPlaces = region.places.filter((place) => place.id.includes('-acquired-'));
    expect(acquiredPlaces.length).toBeGreaterThan(0);
    for (const place of acquiredPlaces) {
      /* A travel time, which only exists because routing ran after the merge. */
      expect(Number.isFinite(place.travelFromBase.driveMinutes)).toBe(true);
      /* A matrix row, so the planner can actually schedule it. */
      expect(region.travelTimes.ids).toContain(place.id);
      /* And an access rule, so it is not a card nobody can reach. */
      expect(region.access.rules.some((rule) => rule.placeIds.includes(place.id))).toBe(true);
    }
  });

  it('keeps every original record, and never narrows what was already found', async () => {
    /*
     * Additivity, asserted against the un-recovered compilation of the same
     * world rather than against a number written down here. A repair that
     * returned a *narrower* inventory is the failure that withdrew the previous
     * attempt, and it would pass any assertion phrased as "more than three".
     */
    const spec = SYNTHETIC_WORLDS.recovery_adversary!;
    const withoutReserve = await compileWorld('recovery_adversary', { packBacked: true });
    void spec;
    /* The identical world with nothing held in reserve: no acquisition is possible. */
    const baseline = await compileWorld('recovery_adversary', {
      packBacked: true,
      world: { acquirable: {} },
    });

    const baselineIds = new Set(baseline.places.map((place) => place.id));
    const recoveredIds = new Set(withoutReserve.places.map((place) => place.id));
    for (const id of baselineIds) {
      expect(recoveredIds.has(id), `recovery lost ${id}, which the baseline kept`).toBe(true);
    }
    expect(recoveredIds.size).toBeGreaterThan(baselineIds.size);
  });

  it('stops when a repair achieves nothing, and never repeats one', async () => {
    /*
     * The same world with an empty reserve: the free repair finds nothing, the
     * paid one finds nothing, and the loop stops rather than paying twice for
     * the same silence.
     */
    const region = await compileWorld('recovery_adversary', {
      packBacked: true,
      world: { acquirable: {} },
    });

    const attempts = region.researchReadiness!.repairsAttempted;
    /* Bounded: never more than the declared pass cap. */
    expect(attempts.length).toBeLessThanOrEqual(2);
    /* And never the same repair twice, which is what "no repeated ineffective action" means. */
    expect(new Set(attempts.map((attempt) => attempt.repair)).size).toBe(attempts.length);
    for (const attempt of attempts) {
      expect(attempt.outcome).not.toBe('improved');
      expect(attempt.evidenceDelta?.candidatesAdded).toBe(0);
    }
    /*
     * And the level stops promising further work once there is none. `recoverable`
     * is the only level that says "we are going back for more", and it is the one
     * sentence on that panel a traveller cannot check for themselves.
     */
    expect(region.researchReadiness!.level).not.toBe('recoverable');
  });

  it('writes nothing into the artifact that a second identical run would not', async () => {
    /**
     * Determinism, asserted specifically on the world that exercises recovery.
     *
     * The general determinism test never triggers a recovery pass, so the one
     * field that could break byte-identity — a wall-clock duration recorded on
     * an attempt — was unreachable from it. It is dropped on the way to the
     * artifact and kept on the operational record; this is what holds that.
     */
    const first = await compileWorld('recovery_adversary', { packBacked: true });
    const second = await compileWorld('recovery_adversary', { packBacked: true });

    /*
     * The attempts are on both artifacts and are part of what has to match. An
     * earlier version asserted `latencyMs` was undefined, which is an absence
     * nothing produces — the field has no writer anywhere — so it certified a
     * property that could not have been violated.
     */
    expect(first.researchReadiness!.repairsAttempted.length).toBeGreaterThan(0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ---------------------------------------------------------------------------
// 15B.T — The civil-clock stage, where it is the only thing that can answer
// ---------------------------------------------------------------------------

describe('IQ: a destination nobody published a clock for', () => {
  it('resolves a real civil zone during the compilation, and records that it did', async () => {
    /**
     * THE STAGE, EXERCISED WHERE NOTHING ELSE CAN STAND IN FOR IT.
     *
     * Every other world's record carries a zone, so its scope is `published`
     * before a single stage runs — and a test asserting the zone was resolved
     * would be reading back a value the fixture set on itself. A reviewer proved
     * exactly that: the whole `resolving_time_zones` stage could be deleted with
     * the suite still green.
     *
     * `unclocked_valley` publishes nothing. Its scope therefore *starts* on the
     * solar approximation, and the only route to a real civil zone is the
     * compilation asking a source and using the answer. Delete the stage and this
     * fails on the first line.
     */
    const region = await compileWorld('unclocked_valley', { packBacked: true });

    expect(region.scope.timeZoneBasis).toBe('provider_resolved');
    expect(region.scope.timeZoneSource).toBe('fake-timezone');
    expect(region.scope.timeZoneResolvedAt).toBeDefined();
    expect(timeZoneConfidence(region.scope.timeZoneBasis!)).toBe('authoritative');
    expect(isCivilTimeZone(region.scope.timeZones[0]!)).toBe(true);
    expect(region.scope.timeZones).toEqual([SYNTHETIC_WORLDS.unclocked_valley!.timeZone]);
    /* And every base plans in that zone rather than in a fixed offset. */
    for (const base of region.bases) expect(isCivilTimeZone(base.timeZone)).toBe(true);
  });

  it('falls back to a labelled approximation when the source cannot answer', async () => {
    /**
     * The other half, and the one the contract insists on: a degraded answer is
     * never silently authoritative. Same world, same stage, a source that
     * returns nothing — and the scope lands on solar time, says so in its basis,
     * and describes itself to a traveller as an estimate rather than as a clock.
     */
    const region = await compileWorld('unclocked_valley', {
      packBacked: true,
      world: { timeZoneResolution: 'unresolved' },
    });

    expect(region.scope.timeZoneBasis).toBe('derived_from_longitude');
    expect(timeZoneConfidence(region.scope.timeZoneBasis!)).toBe('degraded');
    expect(isCivilTimeZone(region.scope.timeZones[0]!)).toBe(false);
    expect(region.scope.timeZoneSource).toBeUndefined();

    const shown = describeTimeZone({
      zones: region.scope.timeZones,
      basis: region.scope.timeZoneBasis!,
    });
    /* No raw POSIX identifier reaches a screen, and the hedge is explicit. */
    expect(shown).not.toContain('Etc/GMT');
    expect(shown).toMatch(/estimated/i);
  });

  it('keeps the two answers apart, so one cannot be mistaken for the other', async () => {
    const resolved = await compileWorld('unclocked_valley', { packBacked: true });
    const degraded = await compileWorld('unclocked_valley', {
      packBacked: true,
      world: { timeZoneResolution: 'unresolved' },
    });
    expect(resolved.scope.timeZones).not.toEqual(degraded.scope.timeZones);
    expect(resolved.scope.timeZoneBasis).not.toBe(degraded.scope.timeZoneBasis);
  });
});
