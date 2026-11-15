import { haversineKm } from '../travel/estimate';
import { hasSleepWord, isNotAProperty, propertyNameKey, type LodgingPropertyCandidate, type LodgingPropertyType } from './property';

/**
 * IS THIS ROW A PLACE TO SLEEP, HERE? — EVIDENCE, NOT A NAME LIST.
 *
 * Live staging offered "Arusha Website Design" as a place to stay, a bare town
 * row ("Les Houches") as a property, and a Japanese Alps mountain hut whose
 * source row put it in central Tokyo. Each was patched by a name; this replaces
 * the patches with checks any row anywhere goes through. A source row is a claim,
 * never truth, and a claim we cannot stand behind is left out — the panel shows
 * fewer and says so rather than guess.
 *
 * Every rule reads only what the records themselves carry, and the reference it
 * compares against is the other rows around it — never a place, a property or a
 * destination by name:
 *
 * 1. **Positive lodging evidence.** The adapters admit only rows whose primary
 *    category (Overture) or `tourism=*` tag (OSM) is lodging. Here, a record that
 *    also files itself under a non-lodging trade (`web_designer`,
 *    `insurance_agency`) is a business that sleeps nobody → out.
 * 2. **Identity.** A name that says what else the business is, a listing word
 *    (bus stop, car park), or a name that is only the locality, region or base
 *    name is not a property (`isNotAProperty`).
 * 3. **Reach.** Inside the radius that fits how the traveller moves.
 * 4. **The record's own address agrees with its neighbours.** A row whose stated
 *    region or country is one no row around it states, while those rows agree
 *    among themselves, has coordinates or an address that is wrong.
 * 5. **Type fits the setting** (`LODGING_TYPE_SETTING`, data). A mountain hut
 *    with a crowd of hotels around it is not on a mountain.
 * 6. **Thin and alone.** A barely-sourced listing with no website is ambiguous.
 *
 * Rules 4–6 are *ambiguity*: the other source holding the same property at the
 * same spot (cross-source agreement) settles them. Rules 1–3 are not settled by
 * agreement: two sources repeating a trade name do not make it a hotel.
 *
 * Pure: candidates and the base in; kept rows and counted reasons out.
 */

/* ------------------------------------------------------------- data tables */

/**
 * Category tokens that name another trade. Matched as whole `_`-separated tokens
 * of a source's own category id (`web_designer` → `web`, `designer`), so
 * `hotel_bar` or `ski_resort` never trips it. A hotel's ordinary companions
 * (restaurant, bar, spa, event venue, tour operator) are deliberately absent.
 */
export const NON_LODGING_CATEGORY_TOKENS: ReadonlySet<string> = new Set([
  'designer', 'design', 'software', 'marketing', 'advertising', 'consultant', 'consulting', 'consultancy',
  'lawyer', 'lawyers', 'attorney', 'legal', 'accountant', 'accounting', 'insurance', 'bank', 'banks', 'atm',
  'estate', 'realtor', 'broker', 'brokers', 'it', 'computer', 'printing', 'printer', 'school', 'college',
  'university', 'education', 'hospital', 'clinic', 'dentist', 'dental', 'doctor', 'pharmacy', 'church',
  'mosque', 'government', 'engineering', 'construction', 'contractor', 'contractors', 'plumber', 'electrician',
  'repair', 'automotive', 'dealer', 'dealership', 'logistics', 'freight', 'courier', 'manufacturing',
  'manufacturer', 'wholesale', 'factory', 'telecommunications', 'newspaper', 'recruitment', 'employment',
  'staffing', 'parking', 'gas', 'fuel', 'supermarket', 'grocery', 'hardware', 'bus', 'station',
]);

/** Companion tokens that keep a category ambiguous-free even with a trade token in it (`bus_tour` is not a bus depot). */
const HOSPITALITY_TOKENS: ReadonlySet<string> = new Set(['hotel', 'hostel', 'inn', 'lodge', 'lodging', 'resort', 'motel', 'guest', 'camp', 'campground', 'tour', 'tours']);

/** True when a source category names a trade that is not hospitality. */
export function isNonLodgingCategory(category: string): boolean {
  const tokens = category.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t) => HOSPITALITY_TOKENS.has(t))) return false;
  return tokens.some((t) => NON_LODGING_CATEGORY_TOKENS.has(t));
}

/**
 * Where a type of property cannot stand: a setting measured from the records
 * themselves — how many other lodging rows lie within `metres` of it. A real
 * mountain hut stands nearly alone; a "hut" with a dozen hotels inside 500 m is
 * in a town, which means its position is wrong (or it is not a hut).
 */
export const LODGING_TYPE_SETTING: Readonly<Partial<Record<LodgingPropertyType, { metres: number; maxNeighbours: number; words: string }>>> = {
  mountain_hut: { metres: 500, maxNeighbours: 6, words: 'a mountain hut placed among a town’s hotels' },
  campsite: { metres: 300, maxNeighbours: 15, words: 'a campsite placed in a dense hotel district' },
};

/** Below this Overture existence confidence, with no website and no second source, a listing is too thin to show. */
export const THIN_LISTING_CONFIDENCE = 0.8;

/** How far around a row its neighbours are read for the address-agreement rule. */
const ADDRESS_NEIGHBOUR_KM = 2.5;
const ADDRESS_MIN_NEIGHBOURS = 3;
const ADDRESS_AGREEMENT = 0.8;

/* ------------------------------------------------------------------- types */

export type LodgingRejection =
  | 'no name or no position'
  | 'not somewhere to sleep'
  | 'filed under another trade too'
  | 'outside the search radius'
  | 'its own address names somewhere else'
  | 'its type does not fit where it is placed'
  | 'too thinly listed to stand behind';

export interface LodgingValidationBase {
  name: string;
  coordinates: { lat: number; lng: number };
  /**
   * The place names the base answers to (its locality, its region). A listing
   * named only one of these is the place, not a property. When absent, the
   * base's own name stands in; pass `[]` for a base that is itself a property.
   */
  aliases?: readonly string[];
}

export interface LodgingValidation {
  kept: LodgingPropertyCandidate[];
  rejected: { candidate: LodgingPropertyCandidate; reason: LodgingRejection }[];
}

/* ----------------------------------------------------------------- helpers */

function placed(c: LodgingPropertyCandidate): boolean {
  const p = c.coordinates;
  return Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/** A spelling-insensitive key for an admin name: "Nagano Prefecture" / "nagano-ken" / "長野県" → stable per script. */
export function adminKey(value: string | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\b(prefecture|province|provincia|state|region|county|district|oblast|ken|to|fu|do)\b/g, ' ')
    .replace(/(県|都|府|道|省|州|市|区)$/u, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const latin = (s: string) => /^[a-z0-9]+$/.test(s);

/**
 * The address-agreement verdict for one field: does the candidate state a value
 * that no neighbour states, while the neighbours agree among themselves? Only
 * compared within one script — "Tokyo" and "東京都" are one place spelled two
 * ways, and a spelling is never evidence of a wrong position.
 */
function addressDisagrees(value: string, neighbourValues: readonly string[]): boolean {
  if (!value || neighbourValues.length < ADDRESS_MIN_NEIGHBOURS) return false;
  const sameScript = neighbourValues.filter((v) => latin(v) === latin(value));
  if (sameScript.length < ADDRESS_MIN_NEIGHBOURS) return false;
  if (sameScript.includes(value)) return false;
  const counts = new Map<string, number>();
  for (const v of sameScript) counts.set(v, (counts.get(v) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / sameScript.length >= ADDRESS_AGREEMENT;
}

/** Same property, held by the other source within 150 m with a matching name or website. */
function corroborated(candidate: LodgingPropertyCandidate, pool: readonly LodgingPropertyCandidate[]): boolean {
  const key = propertyNameKey(candidate.name);
  const alt = candidate.altName ? propertyNameKey(candidate.altName) : '';
  return pool.some((other) => {
    if (other.source === candidate.source) return false;
    if (haversineKm(other.coordinates, candidate.coordinates) > 0.15) return false;
    const ok = propertyNameKey(other.name);
    const oalt = other.altName ? propertyNameKey(other.altName) : '';
    const keys = [key, alt].filter((k) => k.length >= 3);
    const others = [ok, oalt].filter((k) => k.length >= 3);
    return keys.some((k) => others.some((o) => o === k || o.includes(k) || k.includes(o)));
  });
}

/* --------------------------------------------------------------- validator */

export function validateLodgingCandidates(candidates: readonly LodgingPropertyCandidate[], base: LodgingValidationBase, options: { radiusKm: number }): LodgingValidation {
  const kept: LodgingPropertyCandidate[] = [];
  const rejected: LodgingValidation['rejected'] = [];
  const reject = (candidate: LodgingPropertyCandidate, reason: LodgingRejection) => rejected.push({ candidate, reason });

  /* The neighbourhood every rule compares against: every named, placed row from either source. */
  const pool = candidates.filter((c) => c.name.trim().length >= 2 && placed(c));
  const placeNames = (base.aliases ?? [base.name]).filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.name.trim().length < 2 || !placed(candidate)) {
      reject(candidate, 'no name or no position');
      continue;
    }

    /* 1 — a record filed under another trade as well as lodging. */
    if ((candidate.evidence?.categories ?? []).some(isNonLodgingCategory)) {
      reject(candidate, 'filed under another trade too');
      continue;
    }

    /* 2 — identity: a listing word, another trade in the name, or only a place's name. */
    const ownPlaces = [candidate.locality, candidate.evidence?.region, ...placeNames].filter((v): v is string => Boolean(v));
    if (isNotAProperty(candidate.name, { locality: candidate.locality }) || ownPlaces.some((place) => isNotAProperty(candidate.name, { locality: place }))) {
      reject(candidate, 'not somewhere to sleep');
      continue;
    }

    /* 3 — reach. */
    if (haversineKm(base.coordinates, candidate.coordinates) > options.radiusKm) {
      reject(candidate, 'outside the search radius');
      continue;
    }

    /* 4–6 — ambiguity, which the other source can settle. */
    const ambiguity = ambiguityOf(candidate, pool);
    if (ambiguity && !corroborated(candidate, pool)) {
      reject(candidate, ambiguity);
      continue;
    }
    kept.push(candidate);
  }
  return { kept, rejected };
}

function ambiguityOf(candidate: LodgingPropertyCandidate, pool: readonly LodgingPropertyCandidate[]): LodgingRejection | null {
  const others = pool.filter((o) => o !== candidate && o.sourceId !== candidate.sourceId);

  /* 4 — the record's own address against the rows around it. */
  const near = others.filter((o) => haversineKm(o.coordinates, candidate.coordinates) <= ADDRESS_NEIGHBOUR_KM);
  const region = adminKey(candidate.evidence?.region);
  if (region && addressDisagrees(region, near.map((o) => adminKey(o.evidence?.region)).filter(Boolean))) return 'its own address names somewhere else';
  const country = (candidate.evidence?.country ?? '').toUpperCase();
  if (country && addressDisagrees(country.toLowerCase(), near.map((o) => (o.evidence?.country ?? '').toLowerCase()).filter(Boolean))) return 'its own address names somewhere else';

  /* 5 — type against setting. */
  const setting = LODGING_TYPE_SETTING[candidate.type];
  if (setting) {
    const crowd = others.filter((o) => haversineKm(o.coordinates, candidate.coordinates) * 1000 <= setting.metres).length;
    if (crowd > setting.maxNeighbours) return 'its type does not fit where it is placed';
  }

  /* 6 — thin and alone. */
  /* A name that itself says lodge, hotel, hut… is evidence enough; only a thin record with no such word is held back. */
  if (candidate.confidence !== undefined && candidate.confidence < THIN_LISTING_CONFIDENCE && !candidate.website && !hasSleepWord(candidate.name)) return 'too thinly listed to stand behind';
  return null;
}
