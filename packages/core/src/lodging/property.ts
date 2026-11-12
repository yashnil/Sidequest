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
  [/\bhut\b|\bhütte\b|山小屋|refugio|rifugio/i, 'mountain_hut'],
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

export function isNotAProperty(name: string): boolean {
  return NOT_A_PROPERTY.test(name);
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
