import 'server-only';
import { straightLineKm } from '@sidequest/core';

/**
 * ENTITY AGREEMENT: IS THIS PAGE ABOUT THE THING WE ASKED ABOUT?
 *
 * The defect this exists to close, from a live artifact: the card for **Borgir**
 * — a protected nature-reserve headland, `land_use=nature_reserve`, a wildlife
 * area — carried the opening hours, the weekday schedule, the weekend closures
 * and the lunch-ordering rules of the **Borgir community and cultural centre**,
 * a municipal seniors' facility across the city, read off the city's official
 * site and labelled "Stated by reykjavik.is, which runs it. (Verified)". The
 * planner then refused to schedule an outdoor headland on weekends.
 *
 * The mechanism was a name-only join. The research funnel finds pages by
 * subject *name* — a search result whose title or URL contains a distinctive
 * word of the name is matched, an OSM `website` tag or Wikidata claim is
 * trusted outright — and nothing afterwards ever asked whether the page
 * describes the same *kind* of thing as the record, or the same ground. A
 * namesake indoor venue passes every one of those checks.
 *
 * So facts may attach only with entity agreement, judged here from what the
 * page itself offers:
 *
 * 1. **Kind compatibility.** An hours/booking/facility page can never attach
 *    to an outdoor/nature/landform record unless the page itself evidences
 *    that ground — the visitor centre of the reserve talks about the reserve;
 *    a seniors' centre talks about lunch orders and winter programs. A page
 *    that declares itself an indoor civic or commercial facility and never
 *    mentions the outdoors is about a namesake, not the headland.
 * 2. **Coordinate agreement, where the page offers any.** A JSON-LD `geo`
 *    that places the page's subject well away from the record's coordinates
 *    is a positive statement that these are two different things — whatever
 *    the names say.
 *
 * A failed agreement is a **namesake conflict**: the join is dropped and the
 * gap recorded honestly, because "we could not confirm its hours" is true and
 * a community centre's timetable on a nature reserve is false.
 *
 * Everything here is deliberately a *refusal net*, the same contract as the
 * naming module's language nets: high precision over completeness. A page this
 * cannot classify attaches exactly as before; what can no longer happen is a
 * page that says, in its own words, "I am an indoor facility" attaching its
 * schedule to a landform.
 */

/**
 * The record kinds that are ground, not premises.
 *
 * Drawn from the place vocabulary (`PLACE_CATEGORIES`) — these are the
 * categories whose real-world referent is outdoors: terrain, water, viewpoints
 * and protected land. A record of one of these has no lobby for a page's
 * weekday hours to describe, so a facility page needs to evidence the ground
 * before its facts may attach. `museum`, `historic_site`, `gondola_or_tram`
 * and the food service types are deliberately absent: those are operated
 * premises, and operator-page hours are exactly what we want for them.
 */
const OUTDOOR_KINDS = new Set([
  'viewpoint',
  'day_hike',
  'easy_walk',
  'lake',
  'scenic_drive',
  'geothermal',
  'hot_spring',
  'wildlife_area',
]);

/**
 * schema.org types a page uses to say "I am an indoor facility or business".
 *
 * Compared case-insensitively against every `@type` in the page's JSON-LD.
 * `LocalBusiness` and its common subtypes are here; `Park`, `NationalPark`,
 * `TouristAttraction`, `LandmarksOrHistoricalBuildings` and the landform types
 * are deliberately not — a page typed as one of those is compatible ground.
 */
const FACILITY_SCHEMA_TYPES = new Set(
  [
    'LocalBusiness',
    'Restaurant',
    'FoodEstablishment',
    'CafeOrCoffeeShop',
    'BarOrPub',
    'Store',
    'ShoppingCenter',
    'Library',
    'School',
    'Preschool',
    'EducationalOrganization',
    'GovernmentOffice',
    'GovernmentBuilding',
    'CivicStructure',
    'CommunityHealth',
    'Hospital',
    'MedicalClinic',
    'MedicalOrganization',
    'Hotel',
    'LodgingBusiness',
    'EventVenue',
    'MovieTheater',
    'PerformingArtsTheater',
    'HealthClub',
    'SportsActivityLocation',
    'ExerciseGym',
    'Church',
    'PlaceOfWorship',
  ].map((entry) => entry.toLowerCase()),
);

/**
 * Phrases with which a page's own head declares it is an indoor facility.
 *
 * Matched against the first stretch of the cleaned text and the title, folded,
 * because that is where a page says what it is — the Borgir page's second line
 * is literally "Community and cultural center". Every entry names a *class of
 * premises*; none is a word an outdoor page uses about itself.
 */
const FACILITY_PHRASES = [
  'community center',
  'community centre',
  'community and cultural center',
  'community and cultural centre',
  'cultural center',
  'cultural centre',
  'service center',
  'service centre',
  'senior center',
  'senior centre',
  'retirement home',
  'nursing home',
  'care home',
  'sports hall',
  'sports center',
  'sports centre',
  'leisure center',
  'leisure centre',
  'swimming pool',
  'public library',
  'primary school',
  'secondary school',
  'elementary school',
  'kindergarten',
  'health clinic',
  'medical center',
  'medical centre',
  'town hall',
  'city hall',
  'municipal office',
  'conference center',
  'conference centre',
  'shopping center',
  'shopping centre',
  'shopping mall',
] as const;

/**
 * Words with which a page evidences the outdoor ground itself.
 *
 * This is the exception the rule needs to stay honest: a national park's
 * visitor centre publishes hours *for the park*, declares itself a centre, and
 * talks about trails, the reserve and the wildlife the whole way down. A page
 * that carries any of these is talking about the ground and may keep its
 * facts. The seniors' centre page carries none.
 */
const GROUND_WORDS = [
  'nature reserve',
  'national park',
  'protected area',
  'conservation area',
  'wildlife',
  'birdwatching',
  'bird life',
  'trail',
  'hiking',
  'hike',
  'footpath',
  'wetland',
  'headland',
  'geothermal',
  'hot spring',
  'waterfall',
  'lakeside',
  'lakeshore',
  'shoreline',
  'viewpoint',
  'lookout',
  'scenic',
  'outdoor recreation',
  'visitor center',
  'visitor centre',
] as const;

/**
 * Whole-word matching, because substrings lie in both directions: "the
 * reservation desk" must not read as "the reserve", and "trailer" must not
 * read as "trail". Multi-word phrases tolerate any whitespace between words.
 */
function phraseMatchers(phrases: readonly string[]): RegExp[] {
  return phrases.map(
    (phrase) => new RegExp(`\\b${phrase.split(/\s+/).join('\\s+')}\\b`, 'u'),
  );
}

const FACILITY_MATCHERS = phraseMatchers(FACILITY_PHRASES);
const GROUND_MATCHERS = phraseMatchers(GROUND_WORDS);

/** How far a page's own coordinates may sit from the record before they are a different place. */
const NAMESAKE_DISTANCE_KM = 5;

/** How much of the page head counts as "what this page says it is". */
const DECLARATION_WINDOW_CHARS = 800;

const MAX_WALK_DEPTH = 12;

export interface EntityAgreementSubject {
  name: string;
  /** The record's kind in our vocabulary — a place category or food service type. */
  kind: string;
  coordinates: { lat: number; lng: number };
}

export interface EntityAgreementDocument {
  title?: string | undefined;
  text: string;
  structuredData: readonly unknown[];
}

export type EntityAgreement =
  | { agreement: 'compatible' }
  | { agreement: 'namesake_conflict'; reason: 'facility_page_for_outdoor_record' | 'page_locates_elsewhere'; detail: string };

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function walkObjects(value: unknown, visit: (node: Record<string, unknown>) => void, depth = 0): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    for (const entry of value) walkObjects(entry, visit, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    visit(value as Record<string, unknown>);
    for (const entry of Object.values(value as Record<string, unknown>)) {
      walkObjects(entry, visit, depth + 1);
    }
  }
}

/** Every `@type` string the page's JSON-LD declares, folded. */
function jsonLdTypes(blocks: readonly unknown[]): string[] {
  const types: string[] = [];
  walkObjects(blocks, (node) => {
    const declared = node['@type'];
    const values = Array.isArray(declared) ? declared : [declared];
    for (const value of values) {
      if (typeof value === 'string' && value.length > 0) {
        // Types arrive both bare ("Park") and as schema.org URLs.
        types.push(value.split('/').pop()!.toLowerCase());
      }
    }
  });
  return types;
}

/**
 * Node types whose `geo` describes the *publisher*, not the page's subject.
 *
 * A travel guide embeds its own agency's office block beside the attraction it
 * writes about; reading that office's coordinates as "where the page says the
 * subject is" would flag every rural page a city publisher writes. Only a
 * place-shaped node's `geo` counts.
 */
const PUBLISHER_TYPES = new Set(
  ['Organization', 'Corporation', 'TravelAgency', 'NewsMediaOrganization', 'WebSite', 'WebPage'].map(
    (entry) => entry.toLowerCase(),
  ),
);

function typesOfNode(node: Record<string, unknown>): string[] {
  const declared = node['@type'];
  const values = Array.isArray(declared) ? declared : [declared];
  return values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.split('/').pop()!.toLowerCase());
}

/** Every location the page's JSON-LD states for a subject of its own. */
function jsonLdCoordinates(blocks: readonly unknown[]): { lat: number; lng: number }[] {
  const found: { lat: number; lng: number }[] = [];
  walkObjects(blocks, (node) => {
    const geo = node.geo;
    if (!geo || typeof geo !== 'object' || Array.isArray(geo)) return;
    const parentTypes = typesOfNode(node);
    if (parentTypes.some((type) => PUBLISHER_TYPES.has(type))) return;
    const record = geo as Record<string, unknown>;
    const lat = Number(record.latitude);
    const lng = Number(record.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      found.push({ lat, lng });
    }
  });
  return found;
}

/**
 * Whether a page and a research subject agree about what the subject *is*.
 *
 * Pure and deterministic. Reads only what the caller already fetched — no
 * network, no model — which is what lets it sit in front of every claim the
 * extraction path produces without costing anything.
 */
export function assessEntityAgreement(input: {
  subject: EntityAgreementSubject;
  document: EntityAgreementDocument;
}): EntityAgreement {
  const { subject, document } = input;

  /*
   * Coordinates first, for every kind of subject: a page that states where its
   * subject is has made the strongest identity claim a page can make, and a
   * disagreement there is decisive regardless of category. Conflict only when
   * *no* stated location agrees — a page describing several places is about
   * ours as long as one of them is.
   */
  const stated = jsonLdCoordinates(document.structuredData);
  if (stated.length > 0) {
    const nearestKm = Math.min(
      ...stated.map((point) => straightLineKm(point, subject.coordinates)),
    );
    if (nearestKm > NAMESAKE_DISTANCE_KM) {
      return {
        agreement: 'namesake_conflict',
        reason: 'page_locates_elsewhere',
        detail: `The page places its subject ${nearestKm.toFixed(1)} km from ${subject.name}, so it describes a different place with the same name — a namesake, and nothing from it was kept.`,
      };
    }
  }

  /* The kind gate applies only to ground: operated premises keep operator pages. */
  if (!OUTDOOR_KINDS.has(subject.kind)) return { agreement: 'compatible' };

  const types = jsonLdTypes(document.structuredData);
  const declaresFacilityType = types.some((type) => FACILITY_SCHEMA_TYPES.has(type));

  const head = fold(`${document.title ?? ''}\n${document.text.slice(0, DECLARATION_WINDOW_CHARS)}`);
  const declaresFacilityPhrase = FACILITY_MATCHERS.some((matcher) => matcher.test(head));

  if (!declaresFacilityType && !declaresFacilityPhrase) return { agreement: 'compatible' };

  /* The visitor-centre exception: a facility page that evidences the ground. */
  const whole = fold(`${document.title ?? ''}\n${document.text}`);
  if (GROUND_MATCHERS.some((matcher) => matcher.test(whole))) return { agreement: 'compatible' };

  return {
    agreement: 'namesake_conflict',
    reason: 'facility_page_for_outdoor_record',
    detail: `The page describes an indoor facility under the same name, and ${subject.name} is outdoor ground — a namesake, so nothing from it was kept.`,
  };
}
