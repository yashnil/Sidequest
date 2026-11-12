import { haversineKm, isNotAProperty, lodgingTypeFromName, nameSaysHotSpring, type LodgingAmenity, type LodgingPropertyCandidate, type LodgingPropertyType } from '@sidequest/core';

/**
 * OPENSTREETMAP LODGING — WHAT PEOPLE MAPPED, LABELLED AS MAPPED.
 *
 * ODbL. Every row built here is an OSM row and nothing else: it is never merged
 * with an Overture record (a collective database, not a derivative — see
 * `docs/experience-transformation/research.md` §2), and every amenity on it is
 * `basis: 'mapped'` (somebody tagged it) unless the property's own name says it.
 * A tag that is absent is an amenity that is unknown, never `no`.
 *
 * Pure: an Overpass element in, a candidate or null out. Public baths
 * (`amenity=public_bath`) come back as hot-spring points that are attached to
 * OSM rows only.
 */

export type OsmLodgingElement = { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

export const OSM_LODGING_TYPE: Readonly<Record<string, LodgingPropertyType>> = {
  hotel: 'hotel',
  guest_house: 'guesthouse',
  hostel: 'hostel',
  motel: 'motel',
  apartment: 'apartment',
  chalet: 'cottage',
  alpine_hut: 'mountain_hut',
  camp_site: 'campsite',
};

/** OSM sub-tags that name a type outright (`guest_house=minshuku`, `hotel=ryokan`). */
const SUBTYPE: Readonly<Record<string, LodgingPropertyType>> = {
  ryokan: 'ryokan',
  minshuku: 'minshuku',
  bed_and_breakfast: 'bed_and_breakfast',
  shukubo: 'temple_lodging',
  resort: 'resort',
  holiday_home: 'holiday_rental',
};

function point(element: OsmLodgingElement): { lat: number; lng: number } | null {
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  return typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function whole(value: string | undefined, max: number): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n > 0 && n <= max ? n : undefined;
}

export interface OsmHotSpring {
  name: string;
  coordinates: { lat: number; lng: number };
}

export function osmHotSpring(element: OsmLodgingElement): OsmHotSpring | null {
  const tags = element.tags ?? {};
  if (tags.amenity !== 'public_bath') return null;
  const name = tags.name?.trim() ?? '';
  const coordinates = point(element);
  if (name.length < 2 || !coordinates) return null;
  /* A bath the map says is a hot spring, or whose name says so; a plain swimming bath is not. */
  if (tags['bath:type'] !== 'onsen' && tags['bath:type'] !== 'hot_spring' && !nameSaysHotSpring(name)) return null;
  return { name, coordinates };
}

export function osmLodgingCandidate(element: OsmLodgingElement): LodgingPropertyCandidate | null {
  const tags = element.tags ?? {};
  const sourceType = tags.tourism ? OSM_LODGING_TYPE[tags.tourism] : undefined;
  if (!sourceType) return null;
  if (tags.disused === 'yes' || tags['disused:tourism'] || tags.abandoned === 'yes') return null;
  const name = tags.name?.trim().replace(/\s+/g, ' ') ?? '';
  if (name.length < 2 || name.length > 120 || isNotAProperty(name)) return null;
  const coordinates = point(element);
  if (!coordinates) return null;

  const english = (tags['name:en'] ?? tags['name:latin'] ?? '').trim();
  const sub = SUBTYPE[tags.hotel ?? ''] ?? SUBTYPE[tags.guest_house ?? ''];
  const fromName = ['hotel', 'guesthouse', 'hostel'].includes(sourceType) ? lodgingTypeFromName(name) ?? (english ? lodgingTypeFromName(english) : null) : null;
  const type = sub ?? fromName ?? sourceType;

  const amenities: LodgingAmenity[] = [];
  const bath = tags['bath:type'];
  if (bath === 'onsen' || bath === 'hot_spring' || tags.onsen === 'yes') amenities.push({ kind: 'onsen', value: 'yes', basis: 'mapped' });
  else if (nameSaysHotSpring(name) || (english && nameSaysHotSpring(english))) amenities.push({ kind: 'onsen', value: 'yes', basis: 'name' });
  const parking = tags.parking;
  if (parking) amenities.push({ kind: 'parking', value: parking === 'no' ? 'no' : 'yes', basis: 'mapped' });
  const wheelchair = tags.wheelchair;
  if (wheelchair === 'yes' || wheelchair === 'designated') amenities.push({ kind: 'wheelchair', value: 'yes', basis: 'mapped' });
  else if (wheelchair === 'limited') amenities.push({ kind: 'wheelchair', value: 'limited', basis: 'mapped' });
  else if (wheelchair === 'no') amenities.push({ kind: 'wheelchair', value: 'no', basis: 'mapped' });
  const internet = tags.internet_access;
  if (internet === 'wlan' || internet === 'yes') amenities.push({ kind: 'wifi', value: 'yes', basis: 'mapped' });
  else if (internet === 'no') amenities.push({ kind: 'wifi', value: 'no', basis: 'mapped' });
  if (tags.breakfast === 'yes' || tags.breakfast === 'no') amenities.push({ kind: 'breakfast', value: tags.breakfast, basis: 'mapped' });

  const starsRaw = tags.stars?.replace(/s$/i, '').trim();
  const stars = starsRaw && /^\d(\.5)?$/.test(starsRaw) && Number(starsRaw) >= 1 && Number(starsRaw) <= 7 ? Number(starsRaw) : undefined;
  const rooms = whole(tags.rooms, 5000);
  const beds = whole(tags.beds, 10000);
  const website = httpUrl(tags.website ?? tags['contact:website'] ?? tags.url);
  const locality = (tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'] ?? '').trim();

  return {
    source: 'osm',
    sourceId: `osm:${element.type}/${element.id}`,
    name,
    ...(english && english !== name ? { altName: english } : {}),
    coordinates,
    type,
    typeBasis: sub ? 'mapped' : fromName ? 'name' : 'category',
    amenities,
    ...(stars !== undefined ? { stars } : {}),
    ...(rooms !== undefined ? { rooms } : {}),
    ...(beds !== undefined ? { beds } : {}),
    ...(website ? { website } : {}),
    ...(locality ? { locality } : {}),
    licence: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors (ODbL)',
  };
}

/** Elements → OSM candidates, each with the nearest OSM-mapped hot-spring bath within 600 m. */
export function osmLodgingFromElements(elements: readonly OsmLodgingElement[]): LodgingPropertyCandidate[] {
  const springs = elements.map(osmHotSpring).filter((s): s is OsmHotSpring => s !== null);
  return elements
    .map(osmLodgingCandidate)
    .filter((c): c is LodgingPropertyCandidate => c !== null)
    .map((candidate) => {
      let best: { name: string; metres: number } | null = null;
      for (const spring of springs) {
        const metres = Math.round(haversineKm(candidate.coordinates, spring.coordinates) * 1000);
        if (metres <= 600 && spring.name !== candidate.name && (!best || metres < best.metres)) best = { name: spring.name, metres };
      }
      return best ? { ...candidate, nearbyHotSpring: best } : candidate;
    });
}
