/**
 * A NAMED PLACE TO SLEEP, AS AN OPEN SOURCE RECORDS IT — AND NO MORE.
 *
 * Two sources feed this shape, and they are kept apart on purpose:
 *
 * - **Overture Maps** place rows (CDLA-Permissive-2.0, Apache-2.0 with a NOTICE,
 *   or CC0): a name, a position, a category, sometimes a website. Persistable.
 * - **OpenStreetMap** elements (ODbL): a name, a position, `tourism=*`, and
 *   tags people mapped (`bath:type=onsen`, `parking`, `wheelchair`, `stars`).
 *
 * A candidate comes from exactly one source and carries that source's licence.
 * Nothing here merges an OSM attribute onto an Overture record (that would make
 * the result an ODbL derivative); when both sources hold the same property the
 * ranker shows one record, whole, and drops the other.
 *
 * Unknown stays unknown: an amenity a source does not mention is absent, never
 * `no`. An amenity read from OSM is *mapped* (somebody tagged it), never
 * verified; one read from a property's own name says so.
 */

export const LODGING_PROPERTY_TYPES = [
  'hotel',
  'ryokan',
  'minshuku',
  'temple_lodging',
  'guesthouse',
  'bed_and_breakfast',
  'inn',
  'hostel',
  'motel',
  'resort',
  'apartment',
  'holiday_rental',
  'cottage',
  'lodge',
  'mountain_hut',
  'campsite',
  'other',
] as const;
export type LodgingPropertyType = (typeof LODGING_PROPERTY_TYPES)[number];

export const LODGING_PROPERTY_TYPE_LABELS: Record<LodgingPropertyType, string> = {
  hotel: 'Hotel',
  ryokan: 'Ryokan (traditional inn)',
  minshuku: 'Minshuku (family-run guesthouse)',
  temple_lodging: 'Temple lodging',
  guesthouse: 'Guesthouse',
  bed_and_breakfast: 'Bed and breakfast',
  inn: 'Inn',
  hostel: 'Hostel',
  motel: 'Motel',
  resort: 'Resort',
  apartment: 'Apartment',
  holiday_rental: 'Holiday rental',
  cottage: 'Cottage',
  lodge: 'Lodge',
  mountain_hut: 'Mountain hut',
  campsite: 'Campsite',
  other: 'Place to stay',
};

export type LodgingSourceId = 'overture' | 'osm';
export type LodgingLicence = 'CDLA-Permissive-2.0' | 'Apache-2.0' | 'CC0-1.0' | 'ODbL-1.0';

/** How a fact about a property is known. */
export type LodgingFactBasis =
  /** Somebody tagged it on OpenStreetMap. Mapped, never verified. */
  | 'mapped'
  /** The source files the property under a category that implies it. */
  | 'category'
  /** The property's own name says it (温泉, "Onsen", "Hot Spring"). */
  | 'name';

export const LODGING_AMENITIES = ['onsen', 'parking', 'wheelchair', 'restaurant', 'breakfast', 'wifi', 'family_rooms'] as const;
export type LodgingAmenityKind = (typeof LODGING_AMENITIES)[number];

export interface LodgingAmenity {
  kind: LodgingAmenityKind;
  value: 'yes' | 'no' | 'limited';
  basis: LodgingFactBasis;
}

export interface LodgingPropertyCandidate {
  source: LodgingSourceId;
  /** `overture:<id>` or `osm:node/123`. */
  sourceId: string;
  /** As the source writes it, in its own script (湯の峯荘 stays 湯の峯荘). */
  name: string;
  /** A second name the same record carries (OSM `name:en`, Overture's English common name), when it differs. */
  altName?: string;
  coordinates: { lat: number; lng: number };
  type: LodgingPropertyType;
  typeBasis: LodgingFactBasis;
  amenities: LodgingAmenity[];
  /** OSM `stars`, as mapped. */
  stars?: number;
  /** OSM `rooms` / `beds`, as mapped. */
  rooms?: number;
  beds?: number;
  website?: string;
  locality?: string;
  /** Overture's existence confidence (0–1). Absent for OSM. */
  confidence?: number;
  /**
   * A public hot spring the *same source* lists nearby: its name and distance.
   * Same-source only, so an OSM bath is never attached to an Overture inn.
   */
  nearbyHotSpring?: { name: string; metres: number };
  licence: LodgingLicence;
  attribution: string;
  /**
   * What the record itself states, kept only so the row can be checked against
   * its neighbours (`validate.ts`). Never shown, never ranked on.
   */
  evidence?: LodgingRecordEvidence;
}

export interface LodgingRecordEvidence {
  /** The source's own categories or tags, as recorded (Overture primary + alternates; OSM `tourism=*`). */
  categories: string[];
  /** The admin-1 area the record's own address states (Overture `region`, OSM `addr:state`/`addr:province`). */
  region?: string;
  /** ISO 3166-1 alpha-2, when the record's address states one. */
  country?: string;
}

/**
 * Words in a property's name that say what kind of place it is.
 *
 * Language data, not destination logic: a 旅館 is a ryokan wherever it is, and
 * the table is consulted only to refine a source category that is generic
 * ("inn", "hotel", "lodging"). Ordered most specific first.
 */
const TYPE_WORDS: readonly [RegExp, LodgingPropertyType][] = [
  [/宿坊|shukubo/i, 'temple_lodging'],
  [/民宿|minshuku/i, 'minshuku'],
  [/旅館|ryokan/i, 'ryokan'],
  [/ホステル|\bhostel\b|backpackers/i, 'hostel'],
  [/ゲストハウス|guest ?house|gästehaus|pension\b/i, 'guesthouse'],
  [/\bmotel\b|モーテル/i, 'motel'],
  [/\bb ?& ?b\b|bed and breakfast/i, 'bed_and_breakfast'],
  [/\bresort\b|リゾート/i, 'resort'],
  [/\blodge\b|ロッジ/i, 'lodge'],
  [/\bhut\b|h(ü|ue)tte\b|ヒュッテ|山小屋|refugio|rifugio|\brefuge\b|\bcabane\b|\bkoča\b|bivacco|bivouac/i, 'mountain_hut'],
];

/** A type the name states, when the source's own category is generic. */
export function lodgingTypeFromName(name: string): LodgingPropertyType | null {
  for (const [pattern, type] of TYPE_WORDS) if (pattern.test(name)) return type;
  return null;
}

/** Hot-spring words, in the languages whose names carry them. A name is a claim by the property itself. */
const ONSEN_WORDS = /温泉|onsen|hot ?springs?|thermal ?(bath|spa)|termas|terme\b|therme\b|jjimjilbang|찜질방|温泉旅館/i;

export function nameSaysHotSpring(name: string): boolean {
  return ONSEN_WORDS.test(name);
}

/**
 * A listing that is not somewhere to sleep, filed under lodging anyway: a bus
 * stop named for the inn quarter, a shop. Words about the *listing*, never a
 * property's name.
 */
const NOT_A_PROPERTY = /バス停|停留所|bus ?stop|\bstation\b|駅$|parking lot|駐車場$|商店$|car park|vacanc(y|ies)|求人/i;

/**
 * Final pass — A BUSINESS FILED UNDER LODGING. Live Tanzania showed "Arusha
 * Website Design" among the places to stay: a source category is a claim,
 * and a name that says what else the business is outranks it — unless the
 * name also says it is somewhere to sleep ("Design Hotel", "Agency Lodge").
 * Language data about trades, never a place or a property.
 */
const OTHER_TRADE = /\b(web ?site|web design|design studio|graphic design|software|digital marketing|marketing|advertising|consult(ancy|ants?|ing)|solutions|IT services|computer|printing|insurance|accountants?|law (firm|office)|solicitors?|attorneys?|real estate|estate agents?|bank|pharmacy|clinic|dental|hospital|school|academy|college|university|church|mosque|supermarket|hardware|garage|car (hire|rental)|logistics|freight|construction|engineering)\b/i;
const SLEEP_WORD = /hotel|hostel|lodge|inn\b|motel|guest ?house|b ?& ?b|bed and breakfast|camp|resort|suites?|apartments?|villa|chalet|cottage|cabin|hut|refug|rifugio|gîte|gite|pension|hostal|posada|ryokan|minshuku|旅館|民宿|ホテル|宿/i;

/** Whether a name itself says it is somewhere to sleep. */
export function hasSleepWord(name: string): boolean {
  return SLEEP_WORD.test(name);
}

export function isNotAProperty(name: string, context: { locality?: string | undefined } = {}): boolean {
  if (NOT_A_PROPERTY.test(name)) return true;
  if (OTHER_TRADE.test(name) && !SLEEP_WORD.test(name)) return true;
  /* A listing named only for its own town ("Les Houches") is the town, not a property we can stand behind. */
  if (context.locality && propertyNameKey(name) === propertyNameKey(context.locality) && !SLEEP_WORD.test(name)) return true;
  return false;
}

/** A key that stays the same across spellings of one property's name. */
export function propertyNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[(（][^)）]*[)）]/g, ' ')
    .replace(/\b(the|hotel|ryokan|inn|guest ?house|hostel)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A website's host and first path segment, so two listings of one property's site agree. */
export function websiteKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\d?\./, '').toLowerCase();
    const shared = /(wixsite|geocities|jimdo|wordpress|blogspot|hp\.gogo|facebook|instagram|booking|airbnb|tripadvisor|google)\./.test(host);
    const first = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return shared ? `${host}/${first}` : host;
  } catch {
    return null;
  }
}
