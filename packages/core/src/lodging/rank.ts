import { haversineKm } from '../travel/estimate';
import { bookingComSearchUrl, propertyMapUrl } from './links';
import {
  LODGING_PROPERTY_TYPE_LABELS,
  propertyNameKey,
  websiteKey,
  type LodgingAmenity,
  type LodgingAmenityKind,
  type LodgingPropertyCandidate,
  type LodgingPropertyType,
} from './property';

/**
 * WHERE TO SLEEP, RANKED BY WHAT IT DOES FOR THIS TRIP.
 *
 * Not popularity: there is no rating here and none is wanted. A property earns
 * its place by what it changes about the days around it — a hot-spring inn on a
 * trip built around hot springs, parking on a road trip, a bed beside the trail
 * where tomorrow's walk starts. Every term below is a *fact the source records*
 * meeting a *reason the trip has*, and each one that moves a property also
 * writes the sentence that says why. No fact, no sentence: the ranker never
 * describes a property beyond its record.
 *
 * Unknown ≠ false. A property whose record says nothing about parking is not
 * marked down on a road trip; it is told, as a tradeoff, to ask. Only a record
 * that says `no` lowers a property, and only where it matters.
 *
 * Pure: candidates, the base and the trip's reading in, recommendations out.
 */

/* ------------------------------------------------------------------ reading */

export const LODGING_THEMES = ['wellness', 'road_trip', 'on_foot', 'transit', 'family', 'accessible', 'budget', 'comfort', 'rustic'] as const;
export type LodgingTheme = (typeof LODGING_THEMES)[number];

/** Where a theme came from, so the reason can say so. */
export type LodgingThemeSource = 'interest' | 'transport' | 'party' | 'profile' | 'itinerary' | 'concept';

export interface LodgingThemeReading {
  theme: LodgingTheme;
  /** A clause that completes "fits …": "the hot springs you put at the centre of this trip". */
  because: string;
  source: LodgingThemeSource;
}

export interface LodgingTripReading {
  themes: LodgingThemeReading[];
  /** How the traveller moves day to day; it prices distance. */
  mode: 'drive' | 'transit' | 'foot';
  adults: number;
  children: number;
  /** Kinds of place the traveller asked for, when they did. */
  preferredTypes: LodgingPropertyType[];
}

/**
 * What exists today to read a trip's character from. Every field is optional
 * except the party: a trip without a profile is read as neutral, never given a
 * preference it did not state.
 *
 * `concept` is the door for a later, explicit trip-concept reading: themes it
 * states are taken as they are, with their own reasons, and outrank nothing —
 * they are added beside the ones read here.
 */
export interface LodgingTripSignals {
  /** Interest levels by interest id (`hot_springs`, `hiking`, …). */
  interests?: Readonly<Record<string, string | undefined>>;
  /** The itinerary's primary transport mode (`drive`, `walk`, `rail`, …). */
  primaryMode?: string;
  /** The interview's transport choice (`rent_car`, `transit_walk`, …). */
  transportChoice?: string;
  budgetStyle?: string;
  /** The interview's lodging style (`hostel`, `boutique_hotel`, …). */
  lodgingStyle?: string;
  rusticLodgingOk?: boolean;
  mobilityLimited?: boolean;
  adults: number;
  children: number;
  /** Share of the trip's measured movement walked (0–1), when the itinerary knows it. */
  walkedShare?: number;
  concept?: readonly { theme: LodgingTheme; because: string }[];
}

const PREFERRED_BY_STYLE: Readonly<Record<string, readonly LodgingPropertyType[]>> = {
  hostel: ['hostel', 'guesthouse'],
  basic_hotel: ['hotel', 'motel', 'inn', 'guesthouse', 'minshuku'],
  boutique_hotel: ['hotel', 'inn', 'ryokan', 'bed_and_breakfast'],
  apartment: ['apartment', 'holiday_rental', 'cottage'],
  resort: ['resort'],
  luxury_hotel: ['hotel', 'resort'],
  nature_lodge: ['lodge', 'cottage', 'mountain_hut'],
};

export function readTripForLodging(signals: LodgingTripSignals): LodgingTripReading {
  const themes: LodgingThemeReading[] = [];
  const add = (theme: LodgingTheme, because: string, source: LodgingThemeSource) => {
    if (!themes.some((t) => t.theme === theme)) themes.push({ theme, because, source });
  };
  const hotSprings = signals.interests?.hot_springs;
  if (hotSprings === 'core') add('wellness', 'the hot springs you put at the centre of this trip', 'interest');
  else if (hotSprings === 'frequent') add('wellness', 'the hot springs you asked for', 'interest');

  const mode = signals.primaryMode ?? '';
  const choice = signals.transportChoice ?? '';
  let travel: LodgingTripReading['mode'] = 'transit';
  if (mode === 'drive' || choice === 'rent_car' || choice === 'self_drive') {
    travel = 'drive';
    add('road_trip', 'a trip you are driving', 'transport');
  } else if (mode === 'walk' || (signals.walkedShare ?? 0) >= 0.5) {
    travel = 'foot';
    add('on_foot', 'days that start on foot', 'itinerary');
  } else {
    add('transit', 'a trip without a car', 'transport');
  }

  if (signals.children > 0) add('family', `travelling with ${signals.children === 1 ? 'a child' : 'children'}`, 'party');
  if (signals.mobilityLimited) add('accessible', 'the step-free access you asked for', 'profile');
  if (signals.budgetStyle === 'budget' || signals.lodgingStyle === 'hostel') add('budget', 'the budget you set', 'profile');
  if (signals.budgetStyle === 'premium' || signals.budgetStyle === 'luxury' || signals.lodgingStyle === 'luxury_hotel' || signals.lodgingStyle === 'resort') add('comfort', 'the comfort you asked for', 'profile');
  if (signals.rusticLodgingOk) add('rustic', 'your yes to simple, rustic stays', 'profile');

  for (const stated of signals.concept ?? []) {
    if (stated.theme === 'on_foot' && travel === 'transit') travel = 'foot';
    if (stated.theme === 'road_trip') travel = 'drive';
    add(stated.theme, stated.because, 'concept');
  }

  return {
    themes,
    mode: travel,
    adults: Math.max(1, Math.round(signals.adults)),
    children: Math.max(0, Math.round(signals.children)),
    preferredTypes: [...(PREFERRED_BY_STYLE[signals.lodgingStyle ?? ''] ?? [])],
  };
}

/** How far to look around a base: what a traveller can reasonably come back to each evening. */
export function lodgingSearchRadiusKm(mode: LodgingTripReading['mode']): number {
  return mode === 'drive' ? 12 : mode === 'foot' ? 4 : 3;
}

/* ------------------------------------------------------------------- base */

export interface LodgingDayStart {
  dayNumber: number;
  /** The first stop of a day spent from this base. */
  name: string;
  coordinates: { lat: number; lng: number };
}

export interface LodgingBaseContext {
  baseId: string;
  name: string;
  coordinates: { lat: number; lng: number };
  nights: number;
  checkIn: string;
  checkOut: string;
  /** Where each day based here begins. Empty when no stop has a position. */
  dayStarts: readonly LodgingDayStart[];
}

/* ---------------------------------------------------------------- results */

export interface LodgingRecommendationLink {
  kind: 'booking_search' | 'website' | 'map';
  label: string;
  href: string;
}

export interface LodgingRecommendation {
  sourceId: string;
  source: LodgingPropertyCandidate['source'];
  name: string;
  altName?: string;
  type: LodgingPropertyType;
  typeLabel: string;
  coordinates: { lat: number; lng: number };
  locality?: string;
  /** One to three sentences, each built from a recorded fact meeting a reason the trip has. */
  why: string[];
  tradeoffs: string[];
  /** "1.2 km from the centre of Hongū, in a straight line." */
  distance: string;
  distanceKm: number;
  /** Amenities the record states, as words with how they are known ("Hot-spring bath — mapped"). */
  facts: string[];
  stars?: number;
  /** Party size the record supports, when it says (beds or rooms). */
  capacity?: string;
  /** "Mapped on OpenStreetMap (ODbL)" / "Listed in Overture Maps (CDLA-Permissive-2.0)". */
  sourceLabel: string;
  attribution: string;
  links: LodgingRecommendationLink[];
  score: number;
}

export interface LodgingRanking {
  recommendations: LodgingRecommendation[];
  /** Named candidates with a position inside the radius. */
  considered: number;
  radiusKm: number;
  /** Why the rest were left out, counted. */
  dropped: { reason: string; count: number }[];
}

/* ---------------------------------------------------------------- weights */

/**
 * Points, not minutes: these trade a fact's value to the trip against
 * distance. `perKm` prices a kilometre by how the traveller moves — on foot a
 * kilometre is a quarter of an hour each way, in a car it is a minute.
 */
export const LODGING_RANK_POINTS = {
  perKm: { foot: 1.2, transit: 0.9, drive: 0.2 },
  /** Wellness trip: a bath on site. */
  onsenOnSite: 4,
  /** Wellness trip: a ryokan whose record does not say "bath" — a ryokan is often, not always, a bathhouse. */
  ryokanForWellness: 1,
  /** Wellness trip: a public hot spring the same source lists within walking distance. */
  publicBathNearby: 2,
  /** Any trip: a bath on site is a pleasure, not a reason. */
  onsenOtherwise: 0.5,
  /** Road trip: parking the record states. */
  parking: 1.5,
  parkingNo: -2.5,
  motelOnRoadTrip: 0.5,
  /** On foot: a bed within half a kilometre of where a day starts. */
  besideDayStart: 1.5,
  /** Children: a whole place, or family rooms on record. */
  wholePlaceForFamily: 1,
  familyRooms: 1,
  hostelWithChildren: -1.5,
  wheelchairYes: 2,
  wheelchairLimited: 0.5,
  wheelchairNo: -3,
  budgetFit: 1,
  comfortStars: 1.5,
  comfortResort: 1,
  hostelForComfort: -2,
  preferredType: 1,
  /** Somewhere to book directly. */
  website: 0.4,
  sureListing: 0.3,
  thinListing: -0.3,
  /** Fewer beds than the party. */
  tooSmall: -3,
  /** Each pick of a type beyond the second. */
  repeatedType: 0.75,
} as const;

const WHOLE_PLACE: ReadonlySet<LodgingPropertyType> = new Set(['apartment', 'holiday_rental', 'cottage']);
const BUDGET_TYPES: ReadonlySet<LodgingPropertyType> = new Set(['hostel', 'guesthouse', 'minshuku', 'temple_lodging', 'mountain_hut', 'campsite']);
const RUSTIC_TYPES: ReadonlySet<LodgingPropertyType> = new Set(['mountain_hut', 'campsite']);

function amenity(candidate: LodgingPropertyCandidate, kind: LodgingAmenityKind): LodgingAmenity | undefined {
  return candidate.amenities.find((a) => a.kind === kind);
}

function basisWords(source: LodgingPropertyCandidate['source'], basis: LodgingAmenity['basis']): string {
  if (basis === 'name') return 'its name says so';
  if (basis === 'category') return source === 'osm' ? 'as mapped on OpenStreetMap' : 'as listed in Overture Maps';
  return 'mapped on OpenStreetMap';
}

function km(value: number): string {
  if (value < 1) return `${Math.max(50, Math.round((value * 1000) / 50) * 50)} m`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} km`;
}

const AMENITY_WORDS: Record<LodgingAmenityKind, { yes: string; no: string; limited: string }> = {
  onsen: { yes: 'Hot-spring bath', no: 'No hot-spring bath', limited: 'Hot-spring bath (limited)' },
  parking: { yes: 'Parking', no: 'No parking', limited: 'Limited parking' },
  wheelchair: { yes: 'Wheelchair accessible', no: 'Not wheelchair accessible', limited: 'Partly wheelchair accessible' },
  restaurant: { yes: 'Restaurant', no: 'No restaurant', limited: 'Restaurant (limited)' },
  breakfast: { yes: 'Breakfast', no: 'No breakfast', limited: 'Breakfast (limited)' },
  wifi: { yes: 'Wi-Fi', no: 'No Wi-Fi', limited: 'Wi-Fi (limited)' },
  family_rooms: { yes: 'Family rooms', no: 'No family rooms', limited: 'Some family rooms' },
};

/* ------------------------------------------------------------------ score */

interface Scored {
  candidate: LodgingPropertyCandidate;
  score: number;
  why: { weight: number; text: string }[];
  tradeoffs: string[];
  baseKm: number;
  nearestStart?: { start: LodgingDayStart; km: number };
}

function scoreCandidate(candidate: LodgingPropertyCandidate, base: LodgingBaseContext, reading: LodgingTripReading): Scored {
  const P = LODGING_RANK_POINTS;
  const has = (theme: LodgingTheme) => reading.themes.find((t) => t.theme === theme);
  const why: Scored['why'] = [];
  const tradeoffs: string[] = [];
  let score = 0;
  const baseKm = haversineKm(base.coordinates, candidate.coordinates);

  /* Distance: on foot, to where the days start; otherwise, to the base itself. */
  const starts = base.dayStarts.map((start) => ({ start, km: haversineKm(start.coordinates, candidate.coordinates) }));
  const nearestStart = starts.length > 0 ? starts.reduce((a, b) => (b.km < a.km ? b : a)) : undefined;
  const footFocus = reading.mode === 'foot' && starts.length > 0;
  const focusKm = footFocus ? starts.reduce((sum, s) => sum + s.km, 0) / starts.length : baseKm;
  score -= focusKm * P.perKm[reading.mode];
  if (footFocus && nearestStart && nearestStart.km <= 0.5) {
    score += P.besideDayStart;
    why.push({ weight: P.besideDayStart, text: `${km(nearestStart.km)} from where day ${nearestStart.start.dayNumber} starts (${nearestStart.start.name}) — no transfer before the walk.` });
  } else if (footFocus && nearestStart && nearestStart.km > 1.5) {
    tradeoffs.push(`${km(nearestStart.km)} from the nearest day's starting point (${nearestStart.start.name}) — a bus, taxi or extra walk each morning.`);
  }

  /* Hot springs. */
  const wellness = has('wellness');
  const onsen = amenity(candidate, 'onsen');
  if (onsen?.value === 'yes') {
    const w = wellness ? P.onsenOnSite : P.onsenOtherwise;
    score += w;
    why.push({
      weight: w,
      text: wellness
        ? `A hot-spring bath on site (${basisWords(candidate.source, onsen.basis)}) — fits ${wellness.because}.`
        : `A hot-spring bath on site (${basisWords(candidate.source, onsen.basis)}).`,
    });
  } else if (wellness && candidate.type === 'ryokan') {
    score += P.ryokanForWellness;
    why.push({ weight: P.ryokanForWellness, text: `A ryokan — a traditional inn, often with a communal bath; the record does not say whether it has its own hot spring.` });
  }
  if (wellness && candidate.nearbyHotSpring && candidate.nearbyHotSpring.metres <= 600 && onsen?.value !== 'yes') {
    score += P.publicBathNearby;
    why.push({ weight: P.publicBathNearby, text: `A public hot spring, ${candidate.nearbyHotSpring.name}, is ${km(candidate.nearbyHotSpring.metres / 1000)} away.` });
  }

  /* The car. */
  const road = has('road_trip');
  const parking = amenity(candidate, 'parking');
  if (road) {
    if (parking?.value === 'yes' || parking?.value === 'limited') {
      const w = parking.value === 'yes' ? P.parking : P.parking / 2;
      score += w;
      why.push({ weight: w, text: `${parking.value === 'yes' ? 'Parking' : 'Some parking'} on record (${basisWords(candidate.source, parking.basis)}) — fits ${road.because}.` });
    } else if (parking?.value === 'no') {
      score += P.parkingNo;
      tradeoffs.push(`Mapped as having no parking — awkward with a car.`);
    } else {
      tradeoffs.push('Parking is not recorded — ask before you book.');
    }
    if (candidate.type === 'motel') {
      score += P.motelOnRoadTrip;
      why.push({ weight: P.motelOnRoadTrip, text: 'A motel: park at the door, load and go.' });
    }
  }

  /* The party. */
  const family = has('family');
  if (family) {
    if (WHOLE_PLACE.has(candidate.type)) {
      score += P.wholePlaceForFamily;
      why.push({ weight: P.wholePlaceForFamily, text: `A whole ${LODGING_PROPERTY_TYPE_LABELS[candidate.type].toLowerCase()} — room to spread out when ${family.because}.` });
    }
    if (amenity(candidate, 'family_rooms')?.value === 'yes') {
      score += P.familyRooms;
      why.push({ weight: P.familyRooms, text: `Family rooms on record (${basisWords(candidate.source, 'mapped')}).` });
    }
    if (candidate.type === 'hostel') {
      score += P.hostelWithChildren;
      tradeoffs.push('A hostel — look for a private family room.');
    }
  } else if (candidate.type === 'hostel') {
    tradeoffs.push(`Hostels usually mean shared rooms — look for a private room for ${reading.adults}.`);
  }
  const party = reading.adults + reading.children;
  if (candidate.beds !== undefined && candidate.beds < party) {
    score += P.tooSmall;
    tradeoffs.push(`Mapped with ${candidate.beds} ${candidate.beds === 1 ? 'bed' : 'beds'} — fewer than your party of ${party}.`);
  }

  /* Access. */
  const accessible = has('accessible');
  const wheelchair = amenity(candidate, 'wheelchair');
  if (accessible) {
    if (wheelchair?.value === 'yes') {
      score += P.wheelchairYes;
      why.push({ weight: P.wheelchairYes, text: `Wheelchair accessible (${basisWords(candidate.source, wheelchair.basis)}) — fits ${accessible.because}.` });
    } else if (wheelchair?.value === 'limited') {
      score += P.wheelchairLimited;
      tradeoffs.push('Mapped as only partly wheelchair accessible — check the room and the bath.');
    } else if (wheelchair?.value === 'no') {
      score += P.wheelchairNo;
      tradeoffs.push('Mapped as not wheelchair accessible.');
    } else {
      tradeoffs.push('Step-free access is not recorded — ask before you book.');
    }
  }

  /* Money and style, from what the traveller said. */
  const budget = has('budget');
  if (budget && BUDGET_TYPES.has(candidate.type)) {
    score += P.budgetFit;
    why.push({ weight: P.budgetFit, text: `A ${LODGING_PROPERTY_TYPE_LABELS[candidate.type].toLowerCase().replace(/ \(.*\)$/, '')} — fits ${budget.because}.` });
  }
  const comfort = has('comfort');
  if (comfort) {
    if (candidate.stars !== undefined && candidate.stars >= 4) {
      score += P.comfortStars;
      why.push({ weight: P.comfortStars, text: `${candidate.stars} stars, as mapped — fits ${comfort.because}.` });
    }
    if (candidate.type === 'resort') {
      score += P.comfortResort;
      why.push({ weight: P.comfortResort, text: `A resort — fits ${comfort.because}.` });
    }
    if (candidate.type === 'hostel') score += P.hostelForComfort;
  }
  if (reading.preferredTypes.includes(candidate.type)) {
    score += P.preferredType;
    why.push({ weight: P.preferredType - 0.01, text: `The kind of place you asked for: ${LODGING_PROPERTY_TYPE_LABELS[candidate.type].toLowerCase()}.` });
  }

  /* The record itself. */
  if (candidate.website) score += P.website;
  else tradeoffs.push('No website on record — book through a search.');
  if (candidate.confidence !== undefined) {
    if (candidate.confidence >= 0.95) score += P.sureListing;
    else if (candidate.confidence < 0.8) {
      score += P.thinListing;
      tradeoffs.push('The listing is thinly sourced — check it is still taking guests.');
    }
  }

  return { candidate, score, why, tradeoffs, baseKm, ...(nearestStart ? { nearestStart } : {}) };
}

/* ---------------------------------------------------------------- output */

function factsOf(candidate: LodgingPropertyCandidate): string[] {
  return candidate.amenities.map((a) => `${AMENITY_WORDS[a.kind][a.value]} — ${a.basis === 'name' ? 'from its name' : candidate.source === 'osm' ? 'mapped' : 'listed'}`);
}

function capacityOf(candidate: LodgingPropertyCandidate): string | undefined {
  if (candidate.beds !== undefined) return `${candidate.beds} ${candidate.beds === 1 ? 'bed' : 'beds'} (mapped)`;
  if (candidate.rooms !== undefined) return `${candidate.rooms} ${candidate.rooms === 1 ? 'room' : 'rooms'} (mapped)`;
  return undefined;
}

function sourceLabel(candidate: LodgingPropertyCandidate): string {
  return candidate.source === 'osm' ? `Mapped on OpenStreetMap (${candidate.licence})` : `Listed in Overture Maps (${candidate.licence})`;
}

function linksFor(candidate: LodgingPropertyCandidate, base: LodgingBaseContext, reading: LodgingTripReading): LodgingRecommendationLink[] {
  /* A booking site indexes the Latin name more reliably than the local script, when the record carries one. */
  const searchName = candidate.altName && /[A-Za-z]/.test(candidate.altName) ? candidate.altName : candidate.name;
  const town = candidate.locality && !searchName.includes(candidate.locality) ? candidate.locality : base.name;
  const links: LodgingRecommendationLink[] = [
    {
      kind: 'booking_search',
      label: 'Search Booking.com',
      href: bookingComSearchUrl({ query: `${searchName}, ${town}`, checkIn: base.checkIn, checkOut: base.checkOut, adults: reading.adults, children: reading.children }),
    },
  ];
  if (candidate.website) links.push({ kind: 'website', label: 'Own website', href: candidate.website });
  const osmElement = candidate.source === 'osm' ? candidate.sourceId.replace(/^osm:/, '') : undefined;
  links.push({ kind: 'map', label: 'Map', href: propertyMapUrl(candidate.coordinates, osmElement) });
  return links;
}

/** Same property, two records (two languages, two sources): one name key, one website, or 80 m apart with overlapping names. */
function sameProperty(a: LodgingPropertyCandidate, b: LodgingPropertyCandidate): boolean {
  const ka = propertyNameKey(a.name);
  const kb = propertyNameKey(b.name);
  const close = haversineKm(a.coordinates, b.coordinates) <= 0.15;
  if (ka && ka === kb && haversineKm(a.coordinates, b.coordinates) <= 1) return true;
  const wa = websiteKey(a.website);
  if (wa && wa === websiteKey(b.website) && close) return true;
  const altA = a.altName ? propertyNameKey(a.altName) : '';
  const altB = b.altName ? propertyNameKey(b.altName) : '';
  if (close && ((altA && (altA === kb || altA === altB)) || (altB && altB === ka))) return true;
  return close && ka.length >= 3 && kb.length >= 3 && (ka.includes(kb) || kb.includes(ka));
}

export interface RankLodgingOptions {
  /** How many to show. Default 4; never more than 5. */
  limit?: number;
  /** Override the mode's search radius. */
  radiusKm?: number;
}

export function rankLodgingProperties(
  candidates: readonly LodgingPropertyCandidate[],
  base: LodgingBaseContext,
  reading: LodgingTripReading,
  options: RankLodgingOptions = {},
): LodgingRanking {
  const radiusKm = options.radiusKm ?? lodgingSearchRadiusKm(reading.mode);
  const limit = Math.min(5, Math.max(1, options.limit ?? 4));
  const dropped = new Map<string, number>();
  const drop = (reason: string) => dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
  const rustic = reading.themes.some((t) => t.theme === 'rustic') || reading.preferredTypes.some((t) => RUSTIC_TYPES.has(t));

  const eligible: LodgingPropertyCandidate[] = [];
  for (const candidate of candidates) {
    const named = candidate.name.trim().length >= 2;
    const placed = Number.isFinite(candidate.coordinates?.lat) && Number.isFinite(candidate.coordinates?.lng) && Math.abs(candidate.coordinates.lat) <= 90 && Math.abs(candidate.coordinates.lng) <= 180;
    if (!named || !placed) {
      drop('no name or no position');
      continue;
    }
    if (haversineKm(base.coordinates, candidate.coordinates) > radiusKm) {
      drop('outside the search radius');
      continue;
    }
    if (RUSTIC_TYPES.has(candidate.type) && !rustic && !(candidate.type === 'mountain_hut' && reading.mode === 'foot')) {
      drop('a campsite or hut on a trip that did not ask for one');
      continue;
    }
    eligible.push(candidate);
  }

  const scored = eligible.map((candidate) => scoreCandidate(candidate, base, reading)).sort((a, b) => b.score - a.score || a.baseKm - b.baseKm || a.candidate.sourceId.localeCompare(b.candidate.sourceId));
  /*
   * Greedy, with a small cost for a third pick of one type: four holiday lets
   * is a list, not a choice. The cost is smaller than any fact the trip asked
   * for, so a hot-spring trip still gets four hot-spring inns if that is what
   * the place has.
   */
  const chosen: Scored[] = [];
  const pool = [...scored];
  while (pool.length > 0) {
    const sameType = (entry: Scored) => chosen.filter((c) => c.candidate.type === entry.candidate.type).length;
    const adjusted = (entry: Scored) => entry.score - Math.max(0, sameType(entry) - 1) * LODGING_RANK_POINTS.repeatedType;
    let bestIndex = 0;
    for (let i = 1; i < pool.length; i++) if (adjusted(pool[i]!) > adjusted(pool[bestIndex]!)) bestIndex = i;
    const entry = pool.splice(bestIndex, 1)[0]!;
    if (chosen.some((c) => sameProperty(c.candidate, entry.candidate))) {
      drop('the same property listed twice');
      continue;
    }
    if (chosen.length >= limit) continue;
    chosen.push(entry);
  }
  /* "Further out" is relative to what is shown, so it is decided after the choice. */
  const nearestShown = Math.min(...chosen.map((c) => c.baseKm));
  for (const entry of chosen) {
    if (chosen.length > 1 && entry.baseKm >= 1 && entry.baseKm > nearestShown * 2 + 0.5) entry.tradeoffs.unshift(`Further from ${base.name} than the others here — ${km(entry.baseKm)}.`);
  }

  return {
    recommendations: chosen.map(({ candidate, score, why, tradeoffs, baseKm }) => ({
      sourceId: candidate.sourceId,
      source: candidate.source,
      name: candidate.name,
      ...(candidate.altName ? { altName: candidate.altName } : {}),
      type: candidate.type,
      typeLabel: LODGING_PROPERTY_TYPE_LABELS[candidate.type],
      coordinates: candidate.coordinates,
      ...(candidate.locality ? { locality: candidate.locality } : {}),
      why: why
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3)
        .map((w) => w.text),
      tradeoffs: tradeoffs.slice(0, 3),
      distance: baseKm < 0.15 ? `In the centre of ${base.name}.` : `${km(baseKm)} from the centre of ${base.name}, in a straight line.`,
      distanceKm: Math.round(baseKm * 10) / 10,
      facts: factsOf(candidate),
      ...(candidate.stars !== undefined ? { stars: candidate.stars } : {}),
      ...(capacityOf(candidate) ? { capacity: capacityOf(candidate)! } : {}),
      sourceLabel: sourceLabel(candidate),
      attribution: candidate.attribution,
      links: linksFor(candidate, base, reading),
      score: Math.round(score * 100) / 100,
    })),
    considered: eligible.length,
    radiusKm,
    dropped: [...dropped].map(([reason, count]) => ({ reason, count })),
  };
}
