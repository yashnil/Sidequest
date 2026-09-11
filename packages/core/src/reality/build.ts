import type { DestinationEntityType } from '../schemas/geography';
import type { DestinationTrait } from '../interview/traits';
import { countryFacts } from '../reference/countries';
import { jurisdictionFor, type Jurisdiction, type JurisdictionSetup } from './jurisdictions';
import {
  MODE_CONCEPT_LABELS,
  travelRealitySchema,
  type BookingLead,
  type CrowdPeriod,
  type ModeAssessment,
  type ModeConcept,
  type ModeScope,
  type ModeStatus,
  type RealityFact,
  type SetupItem,
  type TravelReality,
} from './schema';

/**
 * BUILDING THE TRAVEL REALITY — A PURE FUNCTION OF WHAT IS ALREADY KNOWN.
 *
 * Inputs: the intent (countries, whether a border is crossed, the kinds of
 * place named), the screening traits, the trip length, who can drive, and
 * what this deployment can measure. Output: mode assessments that say
 * whether a mode is a good idea here (never merely whether a router exists
 * for it), a recommendation only where the evidence supports one, the
 * things worth setting up before landing, the crowd periods and the booking
 * lead times — each with provenance.
 *
 * Nothing here is a branch on a destination name. Every country-specific
 * sentence is a row in `jurisdictions.ts`.
 */
export interface TravelRealityInput {
  label: string;
  countries: readonly string[];
  crossBorder: boolean;
  entityType?: DestinationEntityType | undefined;
  traits: readonly DestinationTrait[];
  /** The intent graph's child kinds, when a graph exists. */
  intentKinds?: readonly string[];
  tripDays: number;
  party?: { size: number; drivers: number | null } | undefined;
  /** What this deployment can time — separate from what it should recommend. */
  capabilities?: { roadRouting: boolean; transit: boolean } | undefined;
  /** The traveller's stated willingness to drive, when the interview has it. */
  willDrive?: boolean | undefined;
}

const STATUS_CAUTION_RANK: Record<ModeStatus, number> = { recommended: 0, viable: 1, unknown: 2, friction: 3, discouraged: 4, unavailable: 5 };

/** Modes a road router can time; transit modes need a transit provider; the rest are timetables nobody publishes to Sidequest. */
const ROAD_MODES: ReadonlySet<ModeConcept> = new Set(['self_drive', 'rental_car', 'private_driver', 'taxi', 'rideshare', 'walking', 'bus', 'shuttle', 'cycling']);
const TRANSIT_MODES: ReadonlySet<ModeConcept> = new Set(['metro', 'intercity_train', 'high_speed_rail']);

const URBAN_ORDER: readonly ModeConcept[] = ['walking', 'metro', 'rideshare', 'taxi', 'bus'];
const REGIONAL_ORDER: readonly ModeConcept[] = ['high_speed_rail', 'intercity_train', 'guided_transfer', 'flight', 'private_driver', 'rental_car', 'self_drive', 'ferry', 'bus'];

function urbanityOf(input: TravelRealityInput, rows: readonly Jurisdiction[]): TravelReality['destination']['urbanity'] {
  const t = new Set(input.traits);
  const kinds = new Set(input.intentKinds ?? []);
  /* A city-state named as a country is a city trip: Hong Kong, Singapore. */
  if (rows.length > 0 && rows.every((r) => r.cityState) && !t.has('multi_area') && !t.has('cross_border')) return 'dense_urban';
  if (t.has('city_region') || input.entityType === 'municipality') return 'urban_plus_region';
  if (t.has('dense_urban') && (t.has('multi_area') || t.has('broad_geography') || kinds.has('country') || kinds.has('admin_region'))) return 'urban_plus_region';
  if (t.has('dense_urban')) return 'dense_urban';
  if (t.has('wilderness') || t.has('remote') || t.has('guide_transfer_likely')) return 'remote';
  if (t.has('road_trip_region') || t.has('mountain') || t.has('car_dependent') || t.has('compact_country') || t.has('broad_geography') || t.has('island') || t.has('archipelago') || t.has('multi_base_likely')) return 'regional';
  if (t.has('multi_area') || t.has('cross_border')) return 'mixed';
  /* The entity type alone, when the screening had no population or bounds to read: a city is a city, a country is regional. */
  if (input.entityType === 'city') return 'dense_urban';
  if (input.entityType === 'country' || input.entityType === 'state_or_province' || input.entityType === 'protected_area' || input.entityType === 'subregion' || input.entityType === 'multi_country') return 'regional';
  if (kinds.has('city') && kinds.size === 1) return 'dense_urban';
  if (kinds.has('country') || kinds.has('admin_region') || kinds.has('natural_region') || kinds.has('park')) return 'regional';
  return 'unknown';
}

function measurable(mode: ModeConcept, caps: TravelRealityInput['capabilities']): boolean {
  if (!caps) return false;
  if (ROAD_MODES.has(mode)) return caps.roadRouting;
  if (TRANSIT_MODES.has(mode)) return caps.transit;
  return false;
}

export function buildTravelReality(input: TravelRealityInput): TravelReality {
  const rows: Jurisdiction[] = input.countries.map((code) => jurisdictionFor(code)).filter((row): row is Jurisdiction => row !== null);
  const covered = new Set(rows.map((r) => r.code));
  const missing = input.countries.filter((c) => !covered.has(c));
  const coverage: TravelReality['destination']['coverage'] = input.countries.length === 0 || rows.length === 0 ? 'none' : missing.length === 0 ? 'full' : 'partial';
  const urbanity = urbanityOf(input, rows);
  const traits = new Set(input.traits);

  // --- facts, tagged with the country they came from -------------------------------------------
  const facts: RealityFact[] = [];
  for (const row of rows) {
    for (const fact of row.facts) facts.push({ ...fact, asOf: fact.asOf ?? row.asOf, countries: [row.code] });
  }

  // --- modes: the most cautious reading across the countries named ---------------------------
  const byMode = new Map<ModeConcept, ModeAssessment>();
  for (const row of rows) {
    for (const rule of row.modes) {
      const reason = rows.length > 1 ? `${countryFacts(row.code)?.name ?? row.code}: ${rule.reason}` : rule.reason;
      const current = byMode.get(rule.mode);
      const next: ModeAssessment = {
        mode: rule.mode,
        status: rule.status,
        scope: rule.scope ?? 'all',
        reason,
        factIds: rule.facts ?? [],
        measurable: measurable(rule.mode, input.capabilities),
      };
      if (!current) {
        byMode.set(rule.mode, next);
        continue;
      }
      const moreCautious = STATUS_CAUTION_RANK[next.status] > STATUS_CAUTION_RANK[current.status];
      byMode.set(rule.mode, {
        ...(moreCautious ? next : current),
        reason: `${current.reason} ${next.reason}`.trim(),
        factIds: [...new Set([...current.factIds, ...next.factIds])],
      });
    }
  }
  /*
   * A border makes a hire car harder than either country alone says: most
   * rental contracts forbid or price cross-border use. Derived, medium
   * confidence, and it never makes self-drive worse than "friction" on its own.
   */
  if (input.crossBorder) {
    const border: RealityFact = {
      id: 'derived-cross-border-hire',
      topic: 'border',
      statement: 'This trip crosses a border: most hire contracts forbid or surcharge taking a car across, so a self-drive plan usually means two hires or a driver who changes at the crossing.',
      authority: 'sidequest_derived',
      freshness: 'stable',
      confidence: 'medium',
      countries: [...input.countries],
      scope: 'regional',
    };
    facts.push(border);
    for (const mode of ['self_drive', 'rental_car'] as const) {
      const current = byMode.get(mode);
      if (current && STATUS_CAUTION_RANK[current.status] < STATUS_CAUTION_RANK.friction) {
        byMode.set(mode, { ...current, status: 'friction', reason: `${current.reason} ${border.statement}`, factIds: [...current.factIds, border.id] });
      }
    }
  }
  /* Where no country row exists, the traits say something weak, and it is labelled as weak. */
  if (rows.length === 0) {
    const derived = (mode: ModeConcept, status: ModeStatus, reason: string, scope: ModeScope = 'all') => {
      const id = `derived-${mode}`;
      facts.push({ id, topic: 'transit', statement: reason, authority: 'sidequest_derived', freshness: 'stable', confidence: 'low', countries: [], scope });
      byMode.set(mode, { mode, status, scope, reason, factIds: [id], measurable: measurable(mode, input.capabilities) });
    };
    if (traits.has('archipelago') || traits.has('water_transfer')) derived('ferry', 'viable', 'Islands and water crossings read as boat country from the shape of the destination alone.');
    if (traits.has('guide_transfer_likely') || traits.has('wilderness')) derived('guided_transfer', 'viable', 'Remote and protected ground is usually reached with a guide or an arranged transfer.');
    if (traits.has('transit_rich')) derived('metro', 'viable', 'A city this size usually runs usable public transport (a prior, not a fact about this city).', 'urban');
  }
  const modes = [...byMode.values()].sort((a, b) => STATUS_CAUTION_RANK[a.status] - STATUS_CAUTION_RANK[b.status] || a.mode.localeCompare(b.mode));

  // --- recommendation: only with country knowledge and a known ground shape -----------------------
  const nobodyDrives = input.party?.drivers === 0 || input.willDrive === false;
  const status = (mode: ModeConcept): ModeStatus => byMode.get(mode)?.status ?? 'unknown';
  const usable = (mode: ModeConcept, scope: ModeScope) => {
    const m = byMode.get(mode);
    return m !== undefined && (m.scope === scope || m.scope === 'all');
  };
  let recommendation: TravelReality['recommendation'] = null;
  /*
   * An unread shape still gets the country's regional answer: knowing nothing
   * about how urban a place is does not make the compiled driving and rail
   * facts disappear. Only the in-city modes wait for evidence of a city.
   */
  if (coverage !== 'none') {
    const urbanWanted = urbanity === 'dense_urban' || urbanity === 'urban_plus_region' || urbanity === 'mixed';
    const regionalWanted = urbanity !== 'dense_urban';
    const pick = (order: readonly ModeConcept[], scope: ModeScope, level: ModeStatus) => order.filter((mode) => usable(mode, scope) && status(mode) === level && !(nobodyDrives && (mode === 'self_drive' || mode === 'rental_car')));
    let urban = urbanWanted ? pick(URBAN_ORDER, 'urban', 'recommended') : [];
    if (urbanWanted && urban.length === 0) urban = pick(URBAN_ORDER, 'urban', 'viable').slice(0, 2);
    let regional = regionalWanted ? pick(REGIONAL_ORDER, 'regional', 'recommended') : [];
    if (regionalWanted && regional.length === 0) regional = pick(REGIONAL_ORDER, 'regional', 'viable');
    /* A road-trip shape with a viable hire car prefers it over a slower viable train — the shape earns that, not the name. */
    if (regionalWanted && (traits.has('road_trip_region') || traits.has('car_dependent')) && !nobodyDrives && (status('rental_car') === 'recommended' || status('rental_car') === 'viable')) {
      regional = ['rental_car', ...regional.filter((m) => m !== 'rental_car' && m !== 'self_drive')];
    }
    regional = regional.slice(0, 3);
    urban = urban.slice(0, 3);
    if (urban.length > 0 || regional.length > 0) {
      const label = (mode: ModeConcept) => MODE_CONCEPT_LABELS[mode].toLowerCase();
      const parts: string[] = [];
      if (urban.length > 0) parts.push(`In the city: ${urban.map(label).join(', ')}.`);
      if (regional.length > 0) parts.push(`${urbanWanted ? 'Between regions' : 'Getting around'}: ${regional.map(label).join(', ')}.`);
      const selfDrive = status('self_drive');
      if ((selfDrive === 'friction' || selfDrive === 'discouraged' || selfDrive === 'unavailable') && !nobodyDrives) {
        const why = byMode.get('self_drive')?.reason ?? '';
        parts.push(`Not a hire car${why ? `: ${why.split('. ')[0]!.replace(/\.$/, '')}.` : '.'}`);
      }
      const sources = rows.map((r) => `${countryFacts(r.code)?.name ?? r.code} (${r.asOf})`).join(', ');
      recommendation = {
        urban,
        regional,
        sentence: parts.join(' '),
        confidence: coverage === 'full' ? 'high' : 'medium',
        basis: `Compiled reference facts for ${sources}; the route itself is decided when the trip is built.`,
      };
    }
  }

  // --- setup: only what this trip's shape makes relevant --------------------------------------------
  const railLikely = (recommendation?.regional ?? []).some((m) => m === 'high_speed_rail' || m === 'intercity_train') || (urbanity !== 'dense_urban' && (status('high_speed_rail') === 'recommended' || status('intercity_train') === 'recommended') && input.tripDays >= 3);
  const selfDriveLikely = input.willDrive === true || (recommendation?.regional ?? []).some((m) => m === 'rental_car' || m === 'self_drive');
  const ferryLikely = traits.has('archipelago') || traits.has('island') || traits.has('water_transfer') || status('ferry') === 'recommended';
  const safariLikely = status('guided_transfer') === 'recommended' || traits.has('guide_transfer_likely');
  const remoteLikely = traits.has('wilderness') || traits.has('remote') || (input.intentKinds ?? []).includes('park') || urbanity === 'remote';
  const urbanLikely = urbanity === 'dense_urban' || urbanity === 'urban_plus_region' || urbanity === 'mixed';
  const include = (item: JurisdictionSetup): boolean => {
    switch (item.onlyWhen) {
      case undefined:
        return true;
      case 'rail':
        return railLikely;
      case 'self_drive':
        return selfDriveLikely;
      case 'ferry':
        return ferryLikely;
      case 'safari':
        return safariLikely;
      case 'remote':
        return remoteLikely;
      case 'urban':
        return urbanLikely;
      case 'regional':
        return urbanity !== 'dense_urban';
    }
  };
  const setup: SetupItem[] = [];
  for (const row of rows) {
    for (const item of row.setup) {
      if (!include(item)) continue;
      setup.push({ id: item.id, title: item.title, why: item.why, when: item.when, relevance: item.relevance, topic: item.topic, factIds: item.facts ?? [], authority: 'reference' });
    }
  }
  setup.sort((a, b) => Number(a.relevance === 'useful') - Number(b.relevance === 'useful') || Number(a.when === 'on_arrival') - Number(b.when === 'on_arrival'));

  const crowdPeriods: CrowdPeriod[] = rows.flatMap((row) => (row.crowdPeriods ?? []).map((p) => ({ ...p, movable: p.movable ?? false, countries: [row.code] })));
  const bookingLeads: BookingLead[] = rows.flatMap((row) => row.bookingLeads ?? []);

  const unknowns: string[] = [];
  if (coverage === 'none') unknowns.push(`How to get around, pay and book in ${input.label} has not been compiled; the plan will say what it assumes rather than recommend a way around.`);
  for (const code of missing) unknowns.push(`No operational knowledge is compiled for ${countryFacts(code)?.name ?? code}; its part of the trip is planned on the shape of the ground alone.`);
  if (crowdPeriods.length === 0) unknowns.push('Holiday and crowd periods are not known for this destination.');

  return travelRealitySchema.parse({
    version: 1,
    destination: { label: input.label, countries: [...input.countries], crossBorder: input.crossBorder, urbanity, coverage },
    modes,
    recommendation,
    setup,
    facts,
    crowdPeriods,
    bookingLeads,
    unknowns,
  });
}

/** The crowd periods a date window touches, for the timing scorer and the Overview. */
export function crowdPeriodsTouching(reality: TravelReality | null | undefined, startDate: string, endDate: string): CrowdPeriod[] {
  if (!reality) return [];
  const start = startDate.slice(5);
  const end = endDate.slice(5);
  const overlaps = (from: string, to: string): boolean => {
    /* Month-day strings compare lexically. A trip or a period crossing the year end is split into two spans. */
    const spans = (a: string, b: string): [string, string][] => (a <= b ? [[a, b]] : [[a, '12-31'], ['01-01', b]]);
    return spans(start, end).some(([s0, s1]) => spans(from, to).some(([p0, p1]) => s0 <= p1 && p0 <= s1));
  };
  return reality.crowdPeriods.filter((p) => p.ranges.some((r) => overlaps(r.from, r.to)));
}
