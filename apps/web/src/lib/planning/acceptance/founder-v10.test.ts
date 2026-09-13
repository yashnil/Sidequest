import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LADDER_LIMITS, placementQueries, routeCriticalRate, tripDates, unavailableWeatherDataset, type Trip, type TripBasics } from '@sidequest/core';
import { reconcileTripDraft, type ReconcileContext } from '../reconcile';
import { normalizeName } from '../skeleton-adapter';
import { defaultProfileFor } from '../production-plan';
import { compileQuality } from '../quality-compiler';
import { accessConstraintsFor } from '@/lib/providers/access-constraints';
import { tripDraftSchema, type TripDraft } from '../trip-draft';
import { recordedGeocoder, recordedQueries, recordedRows } from './fixtures/founder-v10/recorded-geocoder';

/**
 * The 21 anchor identities the production build itself resolved, replayed through
 * the same `persistedIdentities` seam a second build of the same trip uses. Real
 * provider coordinates, so the day-order check has real geography to judge — on
 * the production trip the anchors placed and only the *bases* did not, which is
 * precisely the shape this benchmark has to reproduce.
 */
const IDENTITIES = JSON.parse(readFileSync(new URL('./fixtures/founder-v10/anchor-identities.json', import.meta.url), 'utf8')) as {
  name: string;
  placeId: string;
  provider: string;
  providerRef: string;
  method: string;
  coordinates: { lat: number; lng: number };
  placeClass?: string;
  confidence?: string;
}[];
const persistedIdentities = new Map(
  IDENTITIES.map((row) => [normalizeName(row.name), { method: 'persisted' as const, provider: row.provider, providerRef: row.providerRef, coordinates: row.coordinates, name: row.name, placeId: row.placeId, resolvedAt: '2026-09-12T02:07:31.132Z' }]),
);

/**
 * V10 §17 — THE FOUNDER BENCHMARK, FROM THE PRODUCTION TRIP'S OWN DRAFT.
 *
 * `iceland-draft.json` is the exact draft that produced the trip in
 * `.claude-private/V10-FOUNDER-AUDIT.md`: ten days, five stays, twenty-two
 * anchors, the real prose. Replayed here against the public geocoder's real
 * recorded answers for its own base names and a straight-line router, with no
 * model call and no network.
 *
 * What it pins, one assertion per audit finding:
 *
 *  P0-1  three ordinary town names that failed to place, now placed
 *  P0-2  the base transfers that were never measured, now measured
 *  P0-3  the day-3 reversal, now corrected — and its real cause, which was not
 *        the model: the draft composed the day correctly and Sidequest's own
 *        stated-hour sort moved a "morning" waterfall 30 km past the one that
 *        was on the way to it
 *  P1-5  the gateway that did not exist, now placed and timed
 *  P1-6  the daily-travel precision that outran its measurements
 *  P1-7  the "no backtracking" claim nothing checked
 */

const draft: TripDraft = tripDraftSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/founder-v10/iceland-draft.json', import.meta.url), 'utf8')));

/** The trip as the founder created it: 2026-09-21 → 09-30, 15:00 in, 11:00 out, neither booked. */
const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'Iceland',
  regionId: 'dynamic',
  startDate: '2026-09-21',
  endDate: '2026-09-30',
  arrivalTime: '15:00',
  departureTime: '11:00',
  arrivalPrecision: 'not_booked',
  departurePrecision: 'not_booked',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};
const TRIP: Trip = { id: 'founder-v10-iceland', basics: BASICS, status: 'draft', createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' };
const NOW = new Date('2026-09-12T12:00:00Z');
const REYKJAVIK = { lat: 64.145981, lng: -21.9422367 };

const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

/**
 * A router that answers every pair from geometry at Icelandic ring-road speed.
 *
 * Deliberately not a recording: what the benchmark is measuring is whether the
 * legs are *asked about at all*, and on the production trip they were not —
 * every one of the four base transfers came back `provider_unavailable` because
 * the endpoints had no coordinates. A router that always answers makes any
 * remaining unmeasured leg unambiguously a placement failure.
 */
function geometryRouter(calls: { matrix: number; confirm: number }) {
  const leg = (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    const km = Math.round(haversineKm(from, to) * 1.3 * 10) / 10;
    return { minutes: Math.max(1, Math.round((km / 72) * 60)), km };
  };
  return {
    routeMatrix: async (points: readonly { id: string; lat: number; lng: number }[]) => {
      calls.matrix += 1;
      const ids = points.map((p) => p.id);
      const minutes = points.map((a) => points.map((b) => leg(a, b).minutes));
      const km = points.map((a) => points.map((b) => leg(a, b).km));
      return { ids, minutes, km, failedPairs: [] as { fromId: string; toId: string; reason: string }[] };
    },
    confirmRoute: async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
      calls.confirm += 1;
      const { minutes, km } = leg(from, to);
      return { found: true as const, minutes, km, basis: 'static' as const, provider: 'fixture-geometry' };
    },
  };
}

function contextFor(options: { withLadder: boolean; log: string[]; calls: { matrix: number; confirm: number } }): ReconcileContext {
  const profile = { ...defaultProfileFor(TRIP, null) };
  const regionId = `draft-region:${TRIP.id}`;
  const dates = tripDates(BASICS.startDate, BASICS.endDate);
  const router = geometryRouter(options.calls);
  return {
    tripId: TRIP.id,
    basics: BASICS,
    profile,
    region: {
      id: regionId,
      name: 'Iceland',
      baseName: 'Iceland',
      baseCoordinates: REYKJAVIK,
      summary: 'Iceland, planned from a composed draft.',
      maxRadiusKm: 800,
      aliases: [],
      transportSummary: 'Self-drive.',
      noVehicleSummary: 'Not applicable.',
    },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode: 'car', ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'No compiled matrix.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({ regionId, locations: [{ id: `${regionId}:centre`, label: 'Iceland', coordinates: REYKJAVIK, elevationMetres: 0, timeZone: 'Atlantic/Reykjavik', placeIds: [`${regionId}:centre`], limitation: 'One point.' }], dates, now: NOW, reason: 'not_configured', message: 'No weather was fetched.' }),
    now: NOW,
    baseId: `${regionId}:centre`,
    compiledBases: [],
    geocodeLocality: recordedGeocoder(options.log),
    persistedIdentities: persistedIdentities as unknown as ReconcileContext['persistedIdentities'],
    routeMatrix: router.routeMatrix,
    confirmRoute: router.confirmRoute,
    destinationScope: { countryCode: 'is', center: REYKJAVIK, radiusKm: 800, boundaryEvidence: 'reach_circle' },
    subregionGeometries: [],
    deadlineReached: () => false,
    mustIncludeNames: [],
    /* V10 §5 — the ladder's context. Omitted for the "before" run. */
    ...(options.withLadder ? { destinationCountryName: 'Iceland' } : {}),
    ...(options.withLadder ? { destinationGateways: [{ label: 'Keflavík Airport' }] } : {}),
  } as ReconcileContext;
}

const run = async (withLadder: boolean) => {
  const log: string[] = [];
  const calls = { matrix: 0, confirm: 0 };
  const result = await reconcileTripDraft({ draft, context: contextFor({ withLadder, log, calls }) });
  return { result, log, calls };
};

function legCounts(itinerary: Awaited<ReturnType<typeof reconcileTripDraft>>['itinerary']) {
  let measured = 0;
  let unmeasured = 0;
  let transfersUnmeasured = 0;
  let transfers = 0;
  for (const day of itinerary.days) {
    for (const item of day.items) {
      const travel = item.travel;
      if (!travel || travel.fromId === travel.toId) continue;
      if (travel.role === 'transfer') transfers += 1;
      if (travel.provenance === 'measured') measured += 1;
      else {
        unmeasured += 1;
        if (travel.role === 'transfer') transfersUnmeasured += 1;
      }
    }
  }
  return { measured, unmeasured, transfers, transfersUnmeasured };
}

describe("the founder's Iceland trip, replayed", () => {
  it('places the three bases that failed on the production trip, and says what it asked', async () => {
    const { result, log } = await run(true);
    const bases = result.itinerary.package!.bases;
    expect(bases.map((b) => normalizeName(b.name))).toEqual(['reykjavik', 'vik', 'hofn area', 'selfoss', 'reykjavik']);
    for (const base of bases) expect(base.coordinates, `${base.name} has no coordinate`).toBeDefined();

    /* The ladder asked with the country first, and asked "Höfn" without the hedge word that returns nothing. */
    expect(log).toContain('Vík, Iceland');
    expect(log).toContain('Höfn, Iceland');
    expect(log.some((q) => q === 'Höfn area, Iceland' || q === 'Höfn area')).toBe(true);

    const placement = result.placement;
    expect(routeCriticalRate(placement)).toBeGreaterThanOrEqual(0.9);
    const unplacedBases = placement.placements.filter((p) => p.kind === 'base' && p.outcome !== 'placed');
    expect(unplacedBases).toEqual([]);
  });

  it('puts the bases in Iceland rather than in Scotland, Norway or a waterfall', async () => {
    const { result } = await run(true);
    const byName = new Map(result.itinerary.package!.bases.map((b) => [normalizeName(b.name), b.coordinates!]));
    /* Vík í Mýrdal, not Wick in Caithness (58.4 N) or Vik in Norway (59.3 N). */
    expect(byName.get('vik')!.lat).toBeGreaterThan(63);
    expect(byName.get('vik')!.lat).toBeLessThan(64);
    /* Höfn the town on the south-east coast. */
    expect(haversineKm(byName.get('hofn area')!, { lat: 64.2539, lng: -15.2082 })).toBeLessThan(10);
    /* Selfoss the town, not either of the two waterfalls of that name. */
    expect(haversineKm(byName.get('selfoss')!, { lat: 63.933, lng: -21.0 })).toBeLessThan(15);
  });

  it('measures every base transfer, where the production trip measured none', async () => {
    const { result } = await run(true);
    const counts = legCounts(result.itinerary);
    expect(counts.transfers).toBeGreaterThanOrEqual(4);
    expect(counts.transfersUnmeasured).toBe(0);
    expect(counts.measured / (counts.measured + counts.unmeasured)).toBeGreaterThan(0.9);
  });

  it('corrects day 3 and names the cause, which was not the model', async () => {
    const { result } = await run(true);
    /* The draft composed the day correctly, west to east along one road. */
    expect(draft.days[2]!.anchors.map((a) => a.name)).toEqual(['Seljalandsfoss', 'Skógafoss', 'Sólheimajökull']);
    /* And it is a "morning" hint on the second stop that used to move it in front of the first. */
    expect(draft.days[2]!.anchors[1]!.timeOfDay).toBe('morning');

    const day3 = result.itinerary.days[2]!;
    const order = day3.items.filter((i) => i.kind === 'activity').map((i) => i.title);
    expect(order).toEqual(['Seljalandsfoss', 'Skógafoss', 'Sólheimajökull']);

    /*
     * The verdict describes what was *found*, and the correction is recorded
     * beside it rather than hidden by it: a day that needed reordering is not the
     * same thing as a day that was composed right, and the plan says which.
     */
    const verdict = result.dayOrders.find((o) => o.dayNumber === 3)!;
    expect(verdict.report.verdict).toBe('violation');
    expect(verdict.corrected).toBe(true);
    expect(Math.round(verdict.report.plannedKm - verdict.report.bestKm)).toBeGreaterThan(40);
    expect(result.deviations.some((d) => d.kind === 'day_order_corrected' && d.skeletonDayNumber === 3 && d.detail.includes('Skógafoss'))).toBe(true);

    /* Nothing is left doubling back. */
    expect(result.dayOrders.filter((o) => o.report.verdict === 'violation' && !o.corrected)).toEqual([]);
    /*
     * One day still cannot be judged, and it says which name is missing: "Old
     * Harbour" is the one anchor of twenty-two the production build could not
     * place either, and a day with an unplaced stop is unjudgeable rather than
     * silently clean — which is the whole point of the `unplaceable` verdict.
     */
    const unjudged = result.dayOrders.filter((o) => o.report.verdict === 'unplaceable');
    expect(unjudged.map((o) => o.dayNumber)).toEqual([1]);
    expect(unjudged[0]!.report.unplaced).toEqual(['Old Harbour']);
  });

  it('places and times the arrival gateway the production trip did not have', async () => {
    const { result } = await run(true);
    const gateway = result.gateway!;
    expect(gateway.arrival?.name).toBe('Keflavík Airport');
    expect(gateway.arrival?.kind).toBe('airport');
    expect(gateway.arrivalTransfer?.basis).toBe('measured');
    /* 15:00 landing + 60 processing + 45 rental + the measured run is after 17:00. */
    expect(gateway.usableFromMinute).toBeGreaterThan(17 * 60);
    /* Neither edge is booked, so both are held as conservative windows rather than asserted. */
    expect(['conservative_window', 'tight', 'infeasible']).toContain(gateway.arrivalFeasibility);
    expect(gateway.notes.length).toBeGreaterThan(0);
  });

  it('the quality compiler passes the corrected trip and states what it checked', async () => {
    const { result } = await run(true);
    const { report, corrections } = compileQuality({
      itinerary: result.itinerary,
      draft,
      trip: TRIP,
      profile: defaultProfileFor(TRIP, null),
      placement: result.placement,
      dayOrders: result.dayOrders,
      gateway: result.gateway,
      accessConstraints: accessConstraintsFor(['is']),
    });
    expect(report.clean).toContain('route_critical_placed');
    expect(report.clean).toContain('route_completeness');
    /* The corrected day is a caution, not a blocker and not silence. */
    const orderIssues = report.issues.filter((i) => i.check === 'route_order_coherent');
    expect(orderIssues.map((i) => `${i.dayNumber}/${i.severity}/${i.corrected}`)).toEqual(['1/issue/false', '3/caution/true']);
    /* No stated daily precision to strip, because the legs are measured. */
    expect(corrections.transportDisclosure).toBeUndefined();
    const blockers = report.issues.filter((i) => i.severity === 'blocker');
    expect(blockers.map((b) => `${b.check}: ${b.detail}`)).toEqual([]);
    expect(report.passed).toBe(true);
    /* Every check either ran or says why it did not. An unrun check is never a pass. */
    for (const skip of report.skipped) expect(skip.reason.length).toBeGreaterThan(0);
  });

  it('the one query V9 asked returns nothing, and the ladder is what finds the town', async () => {
    /*
     * The control that makes everything above mean something, stated against the
     * recordings themselves rather than against a flag.
     *
     * V9 asked exactly one query per base: the draft's name with the
     * destination's own label appended. For this draft that is "Höfn area,
     * Iceland", and the public geocoder returns **zero rows** for it — the
     * traveller-facing hedge word in the model's own base name defeats the match
     * completely. V10 asks that, gets nothing, strips the hedge and asks "Höfn,
     * Iceland", which returns the town.
     */
    expect(recordedRows('Höfn area, Iceland')).toEqual([]);
    expect(recordedRows('Höfn area')).toEqual([]);
    expect((recordedRows('Höfn, Iceland') ?? []).length).toBeGreaterThan(0);

    /* And the escalation is recorded on the placement report, query by query. */
    const { result } = await run(true);
    const hofn = result.placement.placements.find((p) => normalizeName(p.name) === 'hofn area')!;
    expect(hofn.outcome).toBe('placed');
    expect(hofn.attempts.map((a) => a.query)).toEqual(['Höfn area, Iceland', 'Höfn, Iceland']);
    expect(hofn.attempts[0]!.outcome).toBe('no_acceptable_candidate');
    expect(hofn.attempts[1]!.outcome).toBe('placed');
  });

  it('the two ambiguous town names would have gone to the wrong country or a waterfall', () => {
    /*
     * The other half of the control: the bare names V9's fallback would have
     * reached for are genuinely ambiguous in the recordings, so placing them
     * correctly is the ladder's context doing work rather than luck.
     */
    const vik = recordedRows('Vík') ?? [];
    expect(vik.map((r) => r.address?.['country_code'])).toEqual(expect.arrayContaining(['is', 'gb']));
    const selfoss = recordedRows('Selfoss') ?? [];
    expect(selfoss.filter((r) => r.type === 'waterfall').length).toBeGreaterThan(0);
  });

  it('attaches each backup to the day the model named for it, not to every day sharing a word', async () => {
    const { result } = await run(true);
    const backups = result.itinerary.package!.backups;
    /* The draft names a day on every one of its three backups. */
    expect(draft.package.backups.map((b) => b.day)).toEqual([4, 5, 8]);
    expect(backups.map((b) => ({ days: b.dayNumbers, match: b.match }))).toEqual([
      { days: [4], match: 'authored' },
      { days: [5], match: 'authored' },
      { days: [8], match: 'authored' },
    ]);
    /* And nothing lands on more than one day, which is what spread a peninsula fallback across a capital. */
    for (const backup of backups) expect(backup.dayNumbers!.length).toBeLessThanOrEqual(3);
  });

  it('states an alternative route the traveller can weigh, without composing a second trip', async () => {
    /*
     * §11 asks for the decision, not a second itinerary. The production draft
     * predates the field, so what is pinned here is that the shape survives a
     * round trip: a draft without it parses, and one with it keeps one sentence.
     */
    expect(draft.routeAlternative).toBeUndefined();
    const withAlternative = tripDraftSchema.parse({ ...draft, routeAlternative: 'The full Ring Road is the other option; it trades the depth of the south coast for two long transfer days.' });
    expect(withAlternative.routeAlternative).toContain('Ring Road');
  });

  it('reports the metrics the founder benchmark is judged on', async () => {
    /*
     * V10 §17 — the after-state figures, printed rather than asserted at, so the
     * report and the code cannot drift. The before-state is in
     * `V10-FOUNDER-AUDIT.md` §3, reproduced from the production trip itself.
     */
    const { result } = await run(true);
    const counts = legCounts(result.itinerary);
    const bases = result.itinerary.package!.bases;
    const metrics = {
      trip: 'Iceland (the founder draft, replayed)',
      basesPlaced: `${bases.filter((b) => b.coordinates).length}/${bases.length}`,
      routeCriticalRate: routeCriticalRate(result.placement),
      transfersMeasured: `${counts.transfers - counts.transfersUnmeasured}/${counts.transfers}`,
      legsMeasured: `${counts.measured}/${counts.measured + counts.unmeasured}`,
      orderViolationsUncorrected: result.dayOrders.filter((o) => o.report.verdict === 'violation' && !o.corrected).length,
      orderViolationsCorrected: result.dayOrders.filter((o) => o.corrected).length,
      daysUnjudgeable: result.dayOrders.filter((o) => o.report.verdict === 'unplaceable').map((o) => o.dayNumber),
      gatewayArrival: result.gateway?.arrivalFeasibility ?? 'none',
      gatewayDeparture: result.gateway?.departureFeasibility ?? 'none',
      placementProviderCalls: result.placement.providerCalls,
    };
    console.warn('V10-METRICS', JSON.stringify(metrics));
    expect(metrics.basesPlaced).toBe('5/5');
  });

  it('places the three names the live build could not, from the ladder alone', async () => {
    /*
     * V10 §17 §5 — the names a **real** composition wrote on 2026-09-13 and that
     * placed nothing, with the geocoder's own answers recorded the same day. Every
     * one is a real place plus something a traveller finds useful and no gazetteer
     * carries: a choice of two towns, and a descriptor of what you do there.
     *
     *   "Hof / Jokulsarlon area, Iceland"       → 0 rows
     *   "Hof, Iceland"                          → the hamlet
     *   "Jokulsarlon, Iceland"                  → the lagoon
     *   "Skaftafell hiking trails, Iceland"     → 0 rows
     *   "Skaftafell, Iceland"                   → the locality
     *   "Fjadrargljufur canyon, Iceland"        → 0 rows
     *   "Fjadrargljufur, Iceland"               → the attraction
     *   "Solheimajokull glacier walk, Iceland"  → 0 rows
     *   "Solheimajokull, Iceland"               → the glacier
     */
    for (const written of ['Hof / Jokulsarlon area', 'Skaftafell hiking trails', 'Fjadrargljufur canyon', 'Solheimajokull glacier walk']) {
      expect(recordedRows(`${written}, Iceland`), `${written} placed as written`).toEqual([]);
    }

    const ladderFinds = async (name: string) => {
      const log: string[] = [];
      const geocode = recordedGeocoder(log);
      for (const query of placementQueries({ name, regionName: 'Iceland', countryName: 'Iceland' }).slice(0, LADDER_LIMITS.base)) {
        const rows = await geocode(query);
        if (rows.length > 0) return { query, name: rows[0]!.name };
      }
      return null;
    };
    expect(await ladderFinds('Hof / Jokulsarlon area')).toMatchObject({ query: 'Hof, Iceland' });
    expect(await ladderFinds('Skaftafell hiking trails')).toMatchObject({ query: 'Skaftafell, Iceland' });
    expect(await ladderFinds('Fjadrargljufur canyon')).toMatchObject({ query: 'Fjadrargljufur, Iceland' });
    expect(await ladderFinds('Solheimajokull glacier walk')).toMatchObject({ query: 'Solheimajokull, Iceland' });
  });

  it('reads the geocoder recordings it thinks it reads', () => {
    const queries = recordedQueries();
    for (const query of ['vík', 'vík, iceland', 'höfn area', 'höfn, iceland', 'selfoss, iceland', 'keflavík airport, iceland']) {
      expect(queries, `missing recording: ${query}`).toContain(query);
    }
  });
});
