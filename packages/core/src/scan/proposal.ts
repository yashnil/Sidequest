import { normalizeCandidateIdentity, type CandidateIdentity } from './candidate-identity';
import { INTERESTS, type CostLevel, type CrowdLevel, type Interest, type PhysicalIntensity, type PlaceCategory, type TimeOfDay } from '../schemas/common';

/**
 * V1 CONVERGENCE — THE DISCOVERY SCAN'S VOCABULARY AND THE MODEL'S PROPOSAL.
 *
 * The scan is Sidequest's preliminary look at a destination (master prompt §9).
 * Its one model call is a *proposal of candidates*: what is worth considering
 * here, for this traveller, with the soft attributes only travel knowledge can
 * supply (how long, how hard, how exposed to weather, classic or quiet). It is
 * never a plan. Everything after the proposal — where each thing is, how long
 * it takes to reach, whether it fits, which day it lands on, in what order — is
 * Sidequest's deterministic work, and the model never sees a coordinate.
 *
 * Nothing in a model wire is enforced by the provider (CLAUDE.md, V9.1): every
 * closed vocabulary here is stated in the prompt and checked again by
 * `normalizeScanProposal`, which coerces what is safely coercible and drops a
 * candidate that cannot be read rather than guessing it into shape.
 */

/** What a candidate is, at the grain a traveller recognises. Mapped deterministically to the board's category. */
export const SCAN_KINDS = [
  'landmark',
  'viewpoint',
  'observation_deck',
  'day_hike',
  'easy_walk',
  'scenic_drive',
  'lake_or_river',
  'waterfall',
  'beach',
  'hot_spring',
  'geothermal',
  'wildlife',
  'national_park',
  'park_or_garden',
  'museum',
  'gallery',
  'temple_or_shrine',
  'religious_site',
  'historic_site',
  'castle_or_palace',
  'neighbourhood',
  'market',
  'street_food',
  'cultural_experience',
  'boat_trip',
  'guided_activity',
  'small_town',
  'island',
  'stargazing',
  'nightlife',
  'theme_park',
] as const;
export type ScanKind = (typeof SCAN_KINDS)[number];

export const SCAN_TIERS = ['classic', 'hidden_gem', 'side_quest'] as const;
export type ScanTier = (typeof SCAN_TIERS)[number];

export const SCAN_EXPOSURES = ['indoor', 'mixed', 'outdoor'] as const;
export type ScanExposure = (typeof SCAN_EXPOSURES)[number];

export const SCAN_BOOKING = ['none', 'recommended', 'required'] as const;
export type ScanBooking = (typeof SCAN_BOOKING)[number];

interface KindProfile {
  category: PlaceCategory;
  label: string;
  interests: readonly Interest[];
  /** `gated` means a staffed site with opening hours worth checking; `open_ground` means there is no gate to be wrong about. */
  hours: 'gated' | 'open_ground';
  /** Weather that genuinely changes the experience, not merely the comfort. */
  visibilityDependent: boolean;
}

/**
 * The one mapping from a traveller-facing kind to the board's category and its
 * default interests. The board's category list was written for the Eastern
 * Sierra; this is how a shrine, a market or a neighbourhood reaches it without
 * widening a schema every downstream reader switches on. `displayKind` keeps
 * the precise word for the card.
 */
export const SCAN_KIND_PROFILES: Record<ScanKind, KindProfile> = {
  landmark: { category: 'historic_site', label: 'Landmark', interests: ['architecture_and_landmarks'], hours: 'gated', visibilityDependent: false },
  viewpoint: { category: 'viewpoint', label: 'Viewpoint', interests: ['scenic_viewpoints', 'photography_golden_hour'], hours: 'open_ground', visibilityDependent: true },
  observation_deck: { category: 'gondola_or_tram', label: 'Observation deck', interests: ['scenic_viewpoints', 'architecture_and_landmarks'], hours: 'gated', visibilityDependent: true },
  day_hike: { category: 'day_hike', label: 'Day hike', interests: ['hiking'], hours: 'open_ground', visibilityDependent: true },
  easy_walk: { category: 'easy_walk', label: 'Easy walk', interests: ['easy_nature_walks'], hours: 'open_ground', visibilityDependent: false },
  scenic_drive: { category: 'scenic_drive', label: 'Scenic drive', interests: ['scenic_drives', 'scenic_viewpoints'], hours: 'open_ground', visibilityDependent: true },
  lake_or_river: { category: 'lake', label: 'Lake or river', interests: ['lakes_and_rivers'], hours: 'open_ground', visibilityDependent: false },
  waterfall: { category: 'viewpoint', label: 'Waterfall', interests: ['lakes_and_rivers', 'scenic_viewpoints'], hours: 'open_ground', visibilityDependent: false },
  beach: { category: 'lake', label: 'Beach', interests: ['beaches_and_swimming'], hours: 'open_ground', visibilityDependent: false },
  hot_spring: { category: 'hot_spring', label: 'Hot spring', interests: ['hot_springs'], hours: 'gated', visibilityDependent: false },
  geothermal: { category: 'geothermal', label: 'Geothermal area', interests: ['geology_and_geothermal'], hours: 'open_ground', visibilityDependent: false },
  wildlife: { category: 'wildlife_area', label: 'Wildlife', interests: ['wildlife'], hours: 'open_ground', visibilityDependent: false },
  national_park: { category: 'national_monument', label: 'National park', interests: ['hiking', 'scenic_viewpoints'], hours: 'gated', visibilityDependent: true },
  park_or_garden: { category: 'easy_walk', label: 'Park or garden', interests: ['easy_nature_walks'], hours: 'gated', visibilityDependent: false },
  museum: { category: 'museum', label: 'Museum', interests: ['museums_and_galleries'], hours: 'gated', visibilityDependent: false },
  gallery: { category: 'museum', label: 'Gallery', interests: ['museums_and_galleries'], hours: 'gated', visibilityDependent: false },
  temple_or_shrine: { category: 'historic_site', label: 'Temple or shrine', interests: ['history_and_culture', 'architecture_and_landmarks'], hours: 'gated', visibilityDependent: false },
  religious_site: { category: 'historic_site', label: 'Religious site', interests: ['history_and_culture', 'architecture_and_landmarks'], hours: 'gated', visibilityDependent: false },
  historic_site: { category: 'historic_site', label: 'Historic site', interests: ['history_and_culture'], hours: 'gated', visibilityDependent: false },
  castle_or_palace: { category: 'historic_site', label: 'Castle or palace', interests: ['history_and_culture', 'architecture_and_landmarks'], hours: 'gated', visibilityDependent: false },
  neighbourhood: { category: 'town_and_food', label: 'Neighbourhood', interests: ['neighbourhoods_and_local_life'], hours: 'open_ground', visibilityDependent: false },
  market: { category: 'town_and_food', label: 'Market', interests: ['markets_and_street_food', 'food_and_towns'], hours: 'gated', visibilityDependent: false },
  street_food: { category: 'town_and_food', label: 'Street food', interests: ['markets_and_street_food'], hours: 'gated', visibilityDependent: false },
  cultural_experience: { category: 'historic_site', label: 'Cultural experience', interests: ['history_and_culture'], hours: 'gated', visibilityDependent: false },
  boat_trip: { category: 'lake', label: 'Boat trip', interests: ['lakes_and_rivers', 'scenic_viewpoints'], hours: 'gated', visibilityDependent: true },
  guided_activity: { category: 'wildlife_area', label: 'Guided activity', interests: ['scenic_viewpoints'], hours: 'gated', visibilityDependent: false },
  small_town: { category: 'town_and_food', label: 'Small town', interests: ['food_and_towns', 'history_and_culture'], hours: 'open_ground', visibilityDependent: false },
  island: { category: 'lake', label: 'Island', interests: ['beaches_and_swimming', 'scenic_viewpoints'], hours: 'open_ground', visibilityDependent: false },
  stargazing: { category: 'viewpoint', label: 'Stargazing', interests: ['stargazing'], hours: 'open_ground', visibilityDependent: true },
  nightlife: { category: 'town_and_food', label: 'Nightlife', interests: ['neighbourhoods_and_local_life'], hours: 'gated', visibilityDependent: false },
  theme_park: { category: 'historic_site', label: 'Theme park', interests: ['architecture_and_landmarks'], hours: 'gated', visibilityDependent: false },
};

export interface ScanCandidateProposal {
  /** Stable within one proposal; the model's own index, never trusted as an identity. */
  key: string;
  name: string;
  /** The place's own name in the local language or script, when the model knows it differs: the open geocoder often knows only that one. */
  localName?: string;
  /**
   * Private alpha — what placement looks up, read deterministically from the
   * name (`candidate-identity.ts`). `name` stays exactly what the model wrote
   * and is what the traveller sees.
   */
  identity?: CandidateIdentity;
  /** Town, district or area that disambiguates the name for a geocoder. */
  locality: string;
  kind: ScanKind;
  tier: ScanTier;
  /** The area or sub-region it belongs to, as the model groups the destination. Display and clustering hint only. */
  zone?: string;
  durationMinutes: number;
  intensity: PhysicalIntensity;
  costLevel: CostLevel;
  exposure: ScanExposure;
  bestTime: TimeOfDay;
  crowd: CrowdLevel;
  /** Present only when the place is seasonal; absent means all year. */
  openMonths?: number[];
  seasonalNote?: string;
  booking: ScanBooking;
  rainyDayOk: boolean;
  interests: Interest[];
  why: string;
  caution?: string;
}

export interface ScanBaseProposal {
  key: string;
  name: string;
  locality: string;
  /** The model's sense of how many nights this base deserves. Sidequest re-allocates; this is an input, not a decision. */
  nightsHint: number;
  why: string;
  lodgingArea?: string;
}

export interface ScanFoodArea {
  name: string;
  locality: string;
  specialty: string;
  why: string;
}

export interface ScanPackageProse {
  transportSummary: string;
  transportNotes: string[];
  beforeYouGo: string[];
  packing: string[];
  foodStrategy: string[];
  bookingPriorities: string[];
}

export interface ScanProposal {
  bases: ScanBaseProposal[];
  candidates: ScanCandidateProposal[];
  foodAreas: ScanFoodArea[];
  /** Well-known things the model judged a poor fit for this traveller, with the reason. Shown, never planned. */
  skipped: { name: string; reason: string }[];
  package: ScanPackageProse;
}

export interface ScanProposalDrop {
  index: number;
  name: string;
  reason: string;
}

export type ScanProposalNormalization =
  | { ok: true; proposal: ScanProposal; dropped: ScanProposalDrop[]; coerced: string[] }
  | { ok: false; reason: string };

const MAX_CANDIDATES = 60;
const MAX_BASES = 6;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function texts(value: unknown, max: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => text(entry, max)).filter((entry): entry is string => entry !== null).slice(0, limit);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T, coerced: string[], path: string): T {
  if (typeof value === 'string') {
    const normal = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((allowed as readonly string[]).includes(normal)) return normal as T;
  }
  coerced.push(path);
  return fallback;
}

function int(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * The proposal, read. Pure and total: it never throws, it reports.
 *
 * A candidate without a usable name or locality cannot be placed and is dropped
 * with its reason. Anything else is coerced to a conservative default and the
 * path is recorded, so a proposal that quietly drifted off-vocabulary is
 * visible in the scan's diagnostics rather than in a strange card.
 */
export function normalizeScanProposal(raw: unknown): ScanProposalNormalization {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'The proposal was not an object.' };
  const record = raw as Record<string, unknown>;
  const coerced: string[] = [];
  const dropped: ScanProposalDrop[] = [];

  const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
  const candidates: ScanCandidateProposal[] = [];
  const seen = new Set<string>();
  rawCandidates.slice(0, MAX_CANDIDATES).forEach((entry, index) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    const name = text(c.name, 80);
    const locality = text(c.locality, 60);
    if (!name || !locality) {
      dropped.push({ index, name: name ?? '(unnamed)', reason: 'missing name or locality' });
      return;
    }
    const dedupeKey = `${name.toLowerCase()}|${locality.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      dropped.push({ index, name, reason: 'duplicate' });
      return;
    }
    seen.add(dedupeKey);
    const path = `candidates[${index}]`;
    const kind = pick(c.kind, SCAN_KINDS, 'landmark', coerced, `${path}.kind`);
    const interests = Array.isArray(c.interests)
      ? [...new Set(c.interests.filter((i): i is Interest => typeof i === 'string' && (INTERESTS as readonly string[]).includes(i)))]
      : [];
    const openMonths = Array.isArray(c.openMonths)
      ? [...new Set(c.openMonths.map((m) => int(m, 1, 12)).filter((m): m is number => m !== null))].sort((a, b) => a - b)
      : [];
    const why = text(c.why, 240);
    const caution = text(c.caution, 200);
    const seasonalNote = text(c.seasonalNote, 200);
    const zone = text(c.zone, 60);
    const localName = text(c.localName, 80);
    candidates.push({
      key: `c${candidates.length + 1}`,
      name,
      ...(localName && localName.toLowerCase() !== name.toLowerCase() ? { localName } : {}),
      identity: normalizeCandidateIdentity(name),
      locality,
      kind,
      tier: pick(c.tier, SCAN_TIERS, 'classic', coerced, `${path}.tier`),
      ...(zone ? { zone } : {}),
      durationMinutes: int(c.durationMinutes, 15, 600) ?? 90,
      intensity: pick(c.intensity, ['none', 'easy', 'moderate', 'strenuous'] as const, 'easy', coerced, `${path}.intensity`),
      costLevel: (int(c.costLevel, 0, 3) ?? 1) as CostLevel,
      exposure: pick(c.exposure, SCAN_EXPOSURES, 'mixed', coerced, `${path}.exposure`),
      bestTime: pick(c.bestTime, ['sunrise', 'morning', 'afternoon', 'sunset', 'night', 'any'] as const, 'any', coerced, `${path}.bestTime`),
      crowd: pick(c.crowd, ['quiet', 'moderate', 'busy', 'very_busy'] as const, 'moderate', coerced, `${path}.crowd`),
      ...(openMonths.length > 0 && openMonths.length < 12 ? { openMonths } : {}),
      ...(seasonalNote ? { seasonalNote } : {}),
      booking: pick(c.booking, SCAN_BOOKING, 'none', coerced, `${path}.booking`),
      rainyDayOk: typeof c.rainyDayOk === 'boolean' ? c.rainyDayOk : SCAN_KIND_PROFILES[kind].hours === 'gated' && c.exposure === 'indoor',
      interests: interests.length > 0 ? interests : [...SCAN_KIND_PROFILES[kind].interests],
      why: why ?? `${SCAN_KIND_PROFILES[kind].label} in ${locality}.`,
      ...(caution ? { caution } : {}),
    });
  });

  const rawBases = Array.isArray(record.bases) ? record.bases : [];
  const bases: ScanBaseProposal[] = [];
  rawBases.slice(0, MAX_BASES).forEach((entry, index) => {
    const b = (entry ?? {}) as Record<string, unknown>;
    /*
     * A base is a place to sleep, named as a place: the model's own aside in a
     * trailing bracket ("Hanoi Old Quarter (return)") is a note about the route,
     * not part of the name, and reached the traveller as one.
     */
    const rawName = text(b.name, 80);
    const name = rawName ? rawName.replace(/\s*\([^)]*\)\s*$/, '').trim() || rawName : rawName;
    if (rawName && name !== rawName) coerced.push(`bases[${index}].name`);
    if (!name) {
      coerced.push(`bases[${index}].name`);
      return;
    }
    const lodgingArea = text(b.lodgingArea, 120);
    bases.push({
      key: `b${bases.length + 1}`,
      name,
      locality: text(b.locality, 60) ?? name,
      nightsHint: int(b.nightsHint, 0, 30) ?? 1,
      why: text(b.why, 240) ?? `A practical place to sleep for this part of the trip.`,
      ...(lodgingArea ? { lodgingArea } : {}),
    });
  });

  if (candidates.length === 0) return { ok: false, reason: 'The proposal held no usable candidates.' };
  if (bases.length === 0) return { ok: false, reason: 'The proposal held no base to sleep at.' };

  const rawFood = Array.isArray(record.foodAreas) ? record.foodAreas : [];
  const foodAreas: ScanFoodArea[] = rawFood
    .slice(0, 10)
    .map((entry) => {
      const f = (entry ?? {}) as Record<string, unknown>;
      const name = text(f.name, 80);
      const locality = text(f.locality, 60);
      if (!name || !locality) return null;
      return { name, locality, specialty: text(f.specialty, 120) ?? '', why: text(f.why, 200) ?? '' };
    })
    .filter((f): f is ScanFoodArea => f !== null);

  const rawSkipped = Array.isArray(record.skipped) ? record.skipped : [];
  const skipped = rawSkipped
    .slice(0, 8)
    .map((entry) => {
      const s = (entry ?? {}) as Record<string, unknown>;
      const name = text(s.name, 80);
      const reason = text(s.reason, 200);
      return name && reason ? { name, reason } : null;
    })
    .filter((s): s is { name: string; reason: string } => s !== null);

  const pkg = (record.package ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    coerced,
    dropped,
    proposal: {
      bases,
      candidates,
      foodAreas,
      skipped,
      package: {
        transportSummary: text(pkg.transportSummary, 400) ?? '',
        transportNotes: texts(pkg.transportNotes, 240, 6),
        beforeYouGo: texts(pkg.beforeYouGo, 240, 10),
        packing: texts(pkg.packing, 120, 15),
        foodStrategy: texts(pkg.foodStrategy, 240, 8),
        bookingPriorities: texts(pkg.bookingPriorities, 240, 8),
      },
    },
  };
}
