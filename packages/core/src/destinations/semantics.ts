import { z } from 'zod';
import { coordinatesSchema, type Coordinates } from '../schemas/common';
import { geoBoundsSchema, type GeoBounds } from '../schemas/geography';
import type { DestinationCandidate } from '../schemas/resolution';
import { isQualifierWord, type IntentNode, type IntentNodeKind } from './intent-graph';
import { isDemonym } from '../reference/countries';

/**
 * V8.1 — A PROVIDER CANDIDATE IS EVIDENCE, NOT TRUTH.
 *
 * "the Canadian Rockies" reached production as a point at 17 Avenue SW,
 * Calgary, because the geocoder's leading row — a business *named after* the
 * region — was adopted without anybody comparing what the phrase meant with
 * what the row was (`.claude-private/V8.1-DESTINATION-FAILURE.md`). This
 * module is that comparison, and the vocabulary it needs.
 *
 * Three things live here, all pure:
 *
 * - **Geographic semantics**: what kind of thing a destination is (a mountain
 *   region, a coast, a settlement…) and at what scale (a point, a district, a
 *   region, a continent-sized area). Types, never names.
 * - **The compatibility gate**: whether one provider row may *locate* one part
 *   of an intent graph. A neighbourhood, road, business or single building can
 *   never stand for a region; a settlement may stand for a region only weakly;
 *   a row in the wrong country never stands for anything.
 * - **The interpreter contract**: the strict shape a world-model reading of a
 *   phrase may take — a classification and *names* (sub-areas, gateways) and
 *   nothing that looks like a coordinate. Every coordinate in the product is
 *   produced by a deterministic source and passes this same gate.
 */

export const DESTINATION_SEMANTICS_VERSION = 1 as const;

export const GEOGRAPHIC_SEMANTIC_TYPES = [
  /** A town or city: one likely base. */
  'settlement',
  /** A city that is also a large administrative region. */
  'city_region',
  /** A state, province, county or similar division. */
  'admin_area',
  'country',
  'multi_country',
  /** A named range or mountainous region. */
  'mountain_region',
  /** A named landscape that is not primarily mountains: a delta, a desert, a lake region, a valley, a plateau. */
  'natural_region',
  'coast',
  'island',
  'island_group',
  'protected_area',
  /** A road, rail line or journey named as the trip. */
  'corridor',
  /** A cultural or travel region no gazetteer bounds: "the Pacific Northwest", "rural Japan". */
  'informal_region',
  /** A single site: a building, a monument, a viewpoint. */
  'landmark',
  'unknown',
] as const;
export const geographicSemanticTypeSchema = z.enum(GEOGRAPHIC_SEMANTIC_TYPES);
export type GeographicSemanticType = z.infer<typeof geographicSemanticTypeSchema>;

export const GEOGRAPHIC_SEMANTIC_TYPE_LABELS: Record<GeographicSemanticType, string> = {
  settlement: 'A city or town',
  city_region: 'A city and its region',
  admin_area: 'A region',
  country: 'A whole country',
  multi_country: 'Several countries',
  mountain_region: 'A mountain region',
  natural_region: 'A natural region',
  coast: 'A coast',
  island: 'An island',
  island_group: 'A group of islands',
  protected_area: 'A park or protected area',
  corridor: 'A route',
  informal_region: 'A travel region',
  landmark: 'A specific place',
  unknown: 'A named place',
};

export const GEOGRAPHIC_SCALES = ['point', 'neighbourhood', 'settlement', 'district', 'subregion', 'region', 'country', 'continental'] as const;
export const geographicScaleSchema = z.enum(GEOGRAPHIC_SCALES);
export type GeographicScale = z.infer<typeof geographicScaleSchema>;

const SCALE_RANK: Record<GeographicScale, number> = { point: 0, neighbourhood: 1, settlement: 2, district: 3, subregion: 4, region: 5, country: 6, continental: 7 };

export function scaleRank(scale: GeographicScale): number {
  return SCALE_RANK[scale];
}

/** How the map should think about the extent when nobody published one, in kilometres from the centre. */
export const SCALE_FRAME_KM: Record<GeographicScale, number> = {
  point: 3,
  neighbourhood: 6,
  settlement: 14,
  district: 45,
  subregion: 120,
  region: 260,
  country: 800,
  continental: 1600,
};

export function diagonalKm(bounds: GeoBounds): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bounds.northEast.lat - bounds.southWest.lat);
  const dLng = toRad(bounds.northEast.lng - bounds.southWest.lng);
  const midLat = toRad((bounds.northEast.lat + bounds.southWest.lat) / 2);
  const x = dLng * Math.cos(midLat);
  return R * Math.sqrt(dLat * dLat + x * x);
}

/** The scale a published extent implies. Thresholds are corner-to-corner kilometres. */
export function scaleOfDiagonalKm(km: number): GeographicScale {
  if (km < 2) return 'point';
  if (km < 10) return 'neighbourhood';
  if (km < 45) return 'settlement';
  if (km < 140) return 'district';
  if (km < 450) return 'subregion';
  if (km < 1600) return 'region';
  if (km < 4500) return 'country';
  return 'continental';
}

/** Which kinds of intent part describe an area rather than a place to stand. */
export const REGION_KINDS: ReadonlySet<IntentNodeKind> = new Set<IntentNodeKind>(['admin_region', 'natural_region', 'park', 'island_chain', 'coast', 'mountain_range', 'vague_region', 'country']);

export function isRegionKind(kind: IntentNodeKind): boolean {
  return REGION_KINDS.has(kind);
}

/** The semantic type an intent part's shape implies, before any evidence. */
export function semanticTypeOfKind(kind: IntentNodeKind): GeographicSemanticType {
  switch (kind) {
    case 'city':
      return 'settlement';
    case 'municipality':
      return 'city_region';
    case 'admin_region':
      return 'admin_area';
    case 'country':
      return 'country';
    case 'natural_region':
      return 'natural_region';
    case 'park':
      return 'protected_area';
    case 'island':
      return 'island';
    case 'island_chain':
      return 'island_group';
    case 'coast':
      return 'coast';
    case 'mountain_range':
      return 'mountain_region';
    case 'corridor':
      return 'corridor';
    case 'vague_region':
      return 'informal_region';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// What a provider row is
// ---------------------------------------------------------------------------

export interface CandidateSemantics {
  type: GeographicSemanticType;
  scale: GeographicScale;
  /** True when the row's extent is a real published boundary rather than a point or a building footprint. */
  hasExtent: boolean;
  /** True when the row is a business, facility, road or building: a thing *in* a place, not a place. */
  pointLike: boolean;
}

const POINT_ENTITY_TYPES = new Set<DestinationCandidate['entityType']>(['point_of_interest', 'route_or_corridor']);

/** Read a candidate for what it is: its published type first, its extent second. */
export function candidateSemantics(candidate: DestinationCandidate): CandidateSemantics {
  const km = candidate.bounds ? diagonalKm(candidate.bounds) : null;
  const extentScale = km !== null ? scaleOfDiagonalKm(km) : null;
  const providerClass = candidate.providerClass;
  const pointLike = POINT_ENTITY_TYPES.has(candidate.entityType) || (providerClass?.rank !== undefined && providerClass.rank >= 30);
  let type: GeographicSemanticType;
  let floor: GeographicScale;
  switch (candidate.entityType) {
    case 'country':
      type = 'country';
      floor = 'country';
      break;
    case 'multi_country':
      type = 'multi_country';
      floor = 'country';
      break;
    case 'state_or_province':
      type = 'admin_area';
      floor = 'subregion';
      break;
    case 'municipality':
      type = 'city_region';
      floor = 'district';
      break;
    case 'subregion':
      type = 'admin_area';
      floor = 'district';
      break;
    case 'natural_region':
      type = providerClass?.type === 'mountain_range' || providerClass?.type === 'ridge' || providerClass?.type === 'massif' ? 'mountain_region' : 'natural_region';
      floor = 'district';
      break;
    case 'protected_area':
      type = 'protected_area';
      floor = 'district';
      break;
    case 'island':
      type = 'island';
      floor = 'settlement';
      break;
    case 'archipelago':
      type = 'island_group';
      floor = 'subregion';
      break;
    case 'city':
    case 'metro_area':
      type = 'settlement';
      floor = 'settlement';
      break;
    case 'neighbourhood':
      type = 'settlement';
      floor = 'neighbourhood';
      break;
    case 'route_or_corridor':
      type = 'corridor';
      floor = 'point';
      break;
    case 'point_of_interest':
      type = 'landmark';
      floor = 'point';
      break;
    default:
      type = 'unknown';
      floor = 'point';
  }
  /*
   * A node's bbox from a geocoder is a synthetic box around the point, not an
   * extent; a way or relation's box is a footprint. A footprint the size of a
   * building is a building.
   */
  const extentIsReal = km !== null && km >= 2 && providerClass?.osmType !== 'node';
  const scale: GeographicScale = extentIsReal && extentScale ? (SCALE_RANK[extentScale] > SCALE_RANK[floor] ? extentScale : floor) : pointLike ? 'point' : floor;
  return { type, scale, hasExtent: extentIsReal && SCALE_RANK[scale] >= SCALE_RANK.settlement, pointLike };
}

// ---------------------------------------------------------------------------
// Name agreement — structural, never a lookup
// ---------------------------------------------------------------------------

/** Case-folded, accent-stripped, article-free, lightly stemmed ("highlands" and "highland" are one word). */
export function foldName(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(the|le|la|les|el|los|las|il|der|die|das)\s+/i, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/** Words a row adds to a name without naming something else: "Lake District *National Park*", "Highland *Council*". */
const GENERIC_NAME_WORDS = new Set(['national', 'park', 'nature', 'reserve', 'regional', 'district', 'council', 'area', 'region', 'provincial', 'state', 'county', 'municipality', 'of', 'de', 'the', 'and', 'le', 'la', 'del', 'di', 'range', 'mountain', 'coast', 'valley', 'island', 'peninsula']);

/** "City", "town": a marker of what the thing is, not part of its name ("New York City" is New York). */
const SETTLEMENT_MARKERS = new Set(['city', 'town', 'municipality', 'metropoli', 'ville', 'stadt', 'ciudad']);

/** The words that name the thing, once nationalities and qualifiers ("Scottish", "northern") are set aside. */
export function coreWords(words: readonly string[]): string[] {
  /* Nationalities first, then qualifiers — but never the last word standing: "Highlands" is a qualifier word and the whole name at once. */
  const noDemonym = words.filter((w) => !isDemonym(w) && w !== 'of');
  const base = noDemonym.length > 0 ? noDemonym : [...words];
  const noQualifier = base.filter((w) => !isQualifierWord(w) && !SETTLEMENT_MARKERS.has(w));
  return noQualifier.length > 0 ? noQualifier : base;
}

function containsWords(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return haystack.some((_, i) => needle.every((w, j) => haystack[i + j] === w));
}

export type NameRelation = 'exact' | 'contains' | 'part' | 'other';

/** How the row's name relates to the words the traveller typed for this part. */
export function nameRelation(label: string, candidate: Pick<DestinationCandidate, 'displayName' | 'aliases' | 'qualifiedName'>): NameRelation {
  const wanted = foldName(label);
  const wantedCore = coreWords(wanted);
  const names = [candidate.displayName, ...candidate.aliases, candidate.qualifiedName.split(',')[0] ?? ''];
  let best: NameRelation = 'other';
  for (const name of names) {
    const got = foldName(name);
    if (got.length === 0) continue;
    if (got.join(' ') === wanted.join(' ') || coreWords(got).join(' ') === wantedCore.join(' ')) return 'exact';
    if (containsWords(got, wanted)) {
      /* "Lake District National Park" contains the Lake District; "Auvergne-Rhône-Alpes" is not the Alps. */
      const extras = got.filter((w) => !wanted.includes(w) && !GENERIC_NAME_WORDS.has(w) && !isDemonym(w) && !isQualifierWord(w));
      if (extras.length <= 1) best = best === 'other' || best === 'part' ? 'contains' : best;
    } else if (containsWords(wanted, got) && best === 'other') best = 'part';
  }
  return best;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type CompatibilityVerdict = 'compatible' | 'weak' | 'incompatible';

export interface CompatibilityAssessment {
  verdict: CompatibilityVerdict;
  reasons: string[];
  name: NameRelation;
  semantics: CandidateSemantics;
}

/** What a reading of the phrase expects the evidence to agree with. From the graph, or from an interpreter. */
export interface SemanticExpectation {
  type?: GeographicSemanticType;
  countries?: readonly string[];
}

export const REGION_SEMANTIC_TYPES: ReadonlySet<GeographicSemanticType> = new Set<GeographicSemanticType>(['admin_area', 'country', 'multi_country', 'mountain_region', 'natural_region', 'coast', 'island_group', 'protected_area', 'informal_region', 'city_region']);

/** Whether a provider row of one semantic type may stand for an intent of another. */
function typesAgree(wanted: GeographicSemanticType, got: GeographicSemanticType): 'yes' | 'weak' | 'no' {
  if (wanted === got) return 'yes';
  switch (wanted) {
    case 'mountain_region':
    case 'natural_region':
      return got === 'natural_region' || got === 'mountain_region' || got === 'protected_area' || got === 'admin_area' || got === 'informal_region' ? 'yes' : got === 'settlement' || got === 'island' || got === 'coast' ? 'weak' : 'no';
    case 'coast':
      return got === 'natural_region' || got === 'admin_area' || got === 'protected_area' ? 'yes' : got === 'settlement' || got === 'island' ? 'weak' : 'no';
    case 'protected_area':
      return got === 'natural_region' || got === 'mountain_region' || got === 'admin_area' ? 'yes' : got === 'settlement' || got === 'island' ? 'weak' : 'no';
    case 'island_group':
      return got === 'island' || got === 'admin_area' || got === 'country' || got === 'natural_region' ? 'yes' : got === 'settlement' ? 'weak' : 'no';
    case 'island':
      return got === 'island_group' || got === 'admin_area' || got === 'natural_region' || got === 'protected_area' ? 'yes' : got === 'settlement' || got === 'country' ? 'weak' : 'no';
    case 'admin_area':
      return got === 'city_region' || got === 'natural_region' || got === 'mountain_region' || got === 'informal_region' ? 'yes' : got === 'settlement' || got === 'country' ? 'weak' : 'no';
    case 'informal_region':
      return REGION_SEMANTIC_TYPES.has(got) ? 'yes' : got === 'settlement' ? 'weak' : 'no';
    case 'settlement':
      return got === 'city_region' || got === 'admin_area' ? 'yes' : got === 'island' || got === 'landmark' || got === 'protected_area' ? 'weak' : 'no';
    case 'city_region':
      return got === 'settlement' || got === 'admin_area' ? 'yes' : 'no';
    case 'country':
      return 'no';
    case 'corridor':
      return got === 'settlement' || got === 'admin_area' || got === 'natural_region' ? 'weak' : 'no';
    case 'landmark':
      return got === 'settlement' || got === 'protected_area' ? 'weak' : 'no';
    default:
      return 'yes';
  }
}

/**
 * May this row locate this part of the phrase?
 *
 * Order matters: a wrong country or a business named after the place is
 * refused before anything else is weighed, because those are the two ways a
 * region became a shop. A reading from an interpreter (when there is one)
 * tightens the expectation: a settlement that could weakly stand for a bare
 * name cannot stand for a name the interpreter has read as a region.
 */
export function assessCompatibility(node: Pick<IntentNode, 'kind' | 'label' | 'countryCode'>, candidate: DestinationCandidate, expectation: SemanticExpectation = {}): CompatibilityAssessment {
  const semantics = candidateSemantics(candidate);
  const name = nameRelation(node.label, candidate);
  const reasons: string[] = [];
  const refuse = (reason: string): CompatibilityAssessment => ({ verdict: 'incompatible', reasons: [...reasons, reason], name, semantics });

  const countryCode = candidate.countryCode?.toUpperCase();
  if (node.countryCode && countryCode && countryCode !== node.countryCode.toUpperCase()) return refuse('country_mismatch');
  if (expectation.countries && expectation.countries.length > 0 && countryCode && !expectation.countries.map((c) => c.toUpperCase()).includes(countryCode)) return refuse('country_mismatch');

  const wanted = expectation.type ?? semanticTypeOfKind(node.kind);
  const regionWanted = REGION_SEMANTIC_TYPES.has(wanted) || isRegionKind(node.kind);

  /* A thing in a place is not the place. */
  if (semantics.pointLike) {
    if (regionWanted) return refuse('point_for_region');
    if (name !== 'exact') return refuse('named_after');
    reasons.push('landmark_exact_name');
    return { verdict: wanted === 'landmark' || wanted === 'unknown' ? 'compatible' : 'weak', reasons, name, semantics };
  }
  /* A row whose name merely contains the words, at less than regional scale, is named after the place. */
  /* "Lake District National Park" at district scale is the district; "Canadian Rockies Chalets" at building scale is a chalet. */
  if (name === 'contains' && SCALE_RANK[semantics.scale] <= SCALE_RANK.settlement && regionWanted) return refuse('named_after');
  if (name === 'other' && wanted !== 'country' && wanted !== 'informal_region') return refuse('name_unrelated');

  /* Scale: a region is never a neighbourhood. */
  if (regionWanted && SCALE_RANK[semantics.scale] <= SCALE_RANK.neighbourhood) return refuse('too_small_for_region');

  const agreement = typesAgree(wanted, semantics.type);
  if (agreement === 'no') return refuse(`type_disagrees:${semantics.type}`);
  /* A bare name answered by a village or a suburb is a lead, not a settlement of the question. */
  if (wanted === 'unknown' && SCALE_RANK[semantics.scale] <= SCALE_RANK.neighbourhood) {
    reasons.push('tiny_for_bare_name');
    return { verdict: 'weak', reasons, name, semantics };
  }
  if (agreement === 'weak') {
    /* An interpreter that read the phrase as a region has ruled out a same-named town. */
    if (expectation.type && REGION_SEMANTIC_TYPES.has(expectation.type) && semantics.type === 'settlement') return refuse('settlement_for_interpreted_region');
    reasons.push(`type_weak:${semantics.type}`);
  }
  if (name === 'part') reasons.push('name_part');
  if (name === 'contains') reasons.push('name_contains');
  const verdict: CompatibilityVerdict = agreement === 'weak' || name === 'part' ? 'weak' : 'compatible';
  return { verdict, reasons, name, semantics };
}

export interface RankedCandidate {
  candidate: DestinationCandidate;
  assessment: CompatibilityAssessment;
  score: number;
}

/** Every candidate through the gate, best first; the incompatible ones are returned too, so a caller can explain a refusal. */
export function rankCandidates(node: Pick<IntentNode, 'kind' | 'label' | 'countryCode'>, candidates: readonly DestinationCandidate[], expectation: SemanticExpectation = {}): RankedCandidate[] {
  const regionWanted = REGION_SEMANTIC_TYPES.has(expectation.type ?? semanticTypeOfKind(node.kind)) || isRegionKind(node.kind);
  const ranked = candidates.map((candidate) => {
    const assessment = assessCompatibility(node, candidate, expectation);
    const s = assessment.semantics;
    let score = assessment.verdict === 'compatible' ? 200 : assessment.verdict === 'weak' ? 100 : 0;
    if (assessment.verdict !== 'incompatible') {
      /* For a bare name, a city outranks a district; a city that is also its region outranks the city node inside it. */
      score += regionWanted ? SCALE_RANK[s.scale] * 6 : s.type === 'city_region' ? 14 : s.type === 'settlement' ? 12 : 0;
      if (assessment.name === 'exact') score += 15;
      if (s.hasExtent) score += 10;
      score += candidate.confidence.level === 'high' ? 6 : candidate.confidence.level === 'medium' ? 3 : 0;
    }
    return { candidate, assessment, score };
  });
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Does the chosen row settle this part well enough that nothing else needs
 * asking? A region needs a compatible row with a real extent; a place needs a
 * compatible row. A weak match is a lead, never a settlement.
 */
export function evidenceSufficient(node: Pick<IntentNode, 'kind' | 'label' | 'countryCode'>, chosen: RankedCandidate | null | undefined): boolean {
  if (!chosen || chosen.assessment.verdict !== 'compatible') return false;
  const s = chosen.assessment.semantics;
  /* An area — by the phrase's shape or by the row's own class — needs a real extent; a point on a map is not a region. */
  if (isRegionKind(node.kind) || (REGION_SEMANTIC_TYPES.has(s.type) && s.type !== 'city_region')) return s.hasExtent && SCALE_RANK[s.scale] >= SCALE_RANK.district;
  return true;
}

// ---------------------------------------------------------------------------
// The interpreter contract — a classification and names, never a coordinate
// ---------------------------------------------------------------------------

/** A place name: a few words in letters, never a sentence and never a coordinate. The gate, not this regex, is the real guard. */
const placeName = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(/^[\p{L}][\p{L}\p{N}'’.\-()/]*(\s[\p{L}\p{N}'’.\-()/]+){0,5}$/u, 'a place name, not a sentence');

export const INTERPRETATION_AMBIGUITIES = ['none', 'shared_name', 'vague'] as const;

/** The landscape a natural region is, as one generic word the interview can read (a desert is remote; a lake region is not). Never a name. */
export const LANDSCAPE_WORDS = ['mountains', 'desert', 'delta', 'valley', 'lake_region', 'plateau', 'jungle', 'savanna', 'wetland', 'glacier', 'fjords', 'coast', 'islands', 'steppe', 'tundra', 'outback', 'forest', 'volcano', 'canyon', 'peninsula', 'bush'] as const;
export const landscapeWordSchema = z.enum(LANDSCAPE_WORDS);

export const interpretedConceptSchema = z.object({
  /** False when the words describe a kind of trip rather than anywhere. */
  isPlace: z.boolean(),
  type: geographicSemanticTypeSchema,
  scale: geographicScaleSchema,
  /** ISO 3166-1 alpha-2, as many as the concept genuinely spans. */
  countries: z.array(z.string().length(2).toUpperCase()).max(8).default([]),
  /** First-level divisions the concept sits in, by name. Context, never geometry. */
  regions: z.array(placeName).max(6).default([]),
  /** Named towns, parks or areas a traveller would actually use inside the concept. Each is looked up and gated; none is a coordinate. */
  representativeAreas: z.array(placeName).max(6).default([]),
  /** Cities travellers arrive through. Separate from the destination on purpose. */
  gateways: z.array(placeName).max(4).default([]),
  ambiguity: z.enum(INTERPRETATION_AMBIGUITIES).default('none'),
  /** For a natural region: which kind of landscape, as a generic word. */
  landscape: landscapeWordSchema.optional(),
  /**
   * V10 §3 — experiences a traveller would plan the trip around, by name.
   * Names only, each geocoded and gated like a representative area; never a
   * coordinate, never a claim that the experience is open or bookable.
   */
  signatureExperiences: z.array(placeName).max(8).default([]),
  /** One line, traveller-readable. */
  note: z.string().max(240).default(''),
});
export type InterpretedConcept = z.infer<typeof interpretedConceptSchema>;

// ---------------------------------------------------------------------------
// The record every consumer reads
// ---------------------------------------------------------------------------

export const SEMANTIC_EVIDENCE_SOURCES = ['traveller', 'reference', 'index', 'geocoder', 'interpretation', 'composite'] as const;
export const semanticEvidenceSourceSchema = z.enum(SEMANTIC_EVIDENCE_SOURCES);

export const EXTENT_SOURCES = [
  /** A boundary somebody published for the thing itself. */
  'published',
  /** The box around several resolved parts of the phrase. */
  'union_of_parts',
  /** The box around representative areas an interpreter named and a geocoder placed. */
  'interpreted_parts',
  /** No extent; the scale says how wide to think. */
  'none',
] as const;
export const extentSourceSchema = z.enum(EXTENT_SOURCES);
export type ExtentSource = z.infer<typeof extentSourceSchema>;

export const semanticPartSchema = z.object({
  label: z.string().min(1),
  center: coordinatesSchema,
  bounds: geoBoundsSchema.optional(),
  source: semanticEvidenceSourceSchema,
  /** The provider's own type for the part, when it published one. */
  featureType: z.string().min(1).optional(),
  countryCode: z.string().length(2).optional(),
});
export type SemanticPart = z.infer<typeof semanticPartSchema>;

export const semanticGatewaySchema = z.object({
  label: z.string().min(1),
  center: coordinatesSchema.optional(),
  countryCode: z.string().length(2).optional(),
  source: semanticEvidenceSourceSchema,
});
export type SemanticGateway = z.infer<typeof semanticGatewaySchema>;

/**
 * V10 §2 — HOW THE REPRESENTATIVE CENTRE WAS ARRIVED AT.
 *
 * A coordinate is not a claim on its own. The difference between "the centroid
 * of four placed areas inside the Canadian Rockies" and "Canada's published
 * point, because nothing else answered" is the difference between framing a
 * map and lying about where the traveller is going — and the second is what
 * put eastern Canada on the setup screen. So the basis travels with the point,
 * and `country_reference` is a stand-in every consumer is required to read as
 * one.
 */
export const CENTER_BASES = [
  /** The centroid of a boundary published for the thing itself. */
  'published',
  /** The centroid of several resolved parts of the phrase. */
  'union_of_parts',
  /** The centroid of representative areas an interpreter named and a geocoder placed. */
  'interpreted_parts',
  /** One geocoder row that was a lead but not enough to settle the part. */
  'lead_row',
  /**
   * The containing country's published point, because nothing placed the
   * destination itself. Never a location for the destination: a stand-in, to be
   * rendered as "still locating" and never framed at country scale.
   */
  'country_reference',
  /**
   * The containing country's published point, and that is the honest answer:
   * the phrase *qualifies* a country ("rural Japan", "northern Italy") rather
   * than naming something inside it that a gazetteer could bound. Nobody
   * publishes an extent for "rural Japan" and nobody should; the country is the
   * right frame and the scale says how wide to think inside it.
   *
   * Distinct from `country_reference` precisely so a screen can tell "this is
   * anchored at the country on purpose" from "nothing has placed this yet".
   */
  'country_qualified',
  'none',
] as const;
export const centerBasisSchema = z.enum(CENTER_BASES);
export type CenterBasis = z.infer<typeof centerBasisSchema>;

/** True when the centre is only the containing country's point standing in for a destination nobody placed. */
export function centreIsStandIn(basis: CenterBasis): boolean {
  return basis === 'country_reference' || basis === 'none';
}

/**
 * V10 §2 — JURISDICTION IS NOT THE DESTINATION.
 *
 * "Canadian Rockies uses CAD" is invalid product language: the currency
 * belongs to **Canada**, and the destination merely sits inside it. A
 * jurisdiction reference is therefore a separate, explicitly-levelled thing,
 * and every sentence about money, driving, entry or health is phrased about
 * the jurisdiction it actually belongs to. Subnational rows exist so that
 * Alberta and British Columbia can be named where they matter (park passes,
 * provincial rules) without either of them standing for the destination.
 */
export const JURISDICTION_LEVELS = ['country', 'subnational'] as const;
export const jurisdictionLevelSchema = z.enum(JURISDICTION_LEVELS);
export type JurisdictionLevel = z.infer<typeof jurisdictionLevelSchema>;

export const jurisdictionRefSchema = z.object({
  level: jurisdictionLevelSchema,
  /** ISO 3166-1 alpha-2 for a country; ISO 3166-2 ("CA-AB") for a subnational row when the provider gave one. */
  code: z.string().min(2).max(6),
  name: z.string().min(1).max(80),
  /** The country a subnational row belongs to. Equal to `code` for a country row. */
  countryCode: z.string().length(2),
});
export type JurisdictionRef = z.infer<typeof jurisdictionRefSchema>;

/**
 * The sentence a jurisdiction fact is introduced with. Reads the jurisdiction,
 * never the destination label, so a region can never be said to have a
 * currency, a visa policy or a driving rule of its own.
 */
export function jurisdictionPhrase(jurisdictions: readonly JurisdictionRef[]): string {
  const countries = jurisdictions.filter((j) => j.level === 'country');
  if (countries.length === 0) return 'this country';
  if (countries.length === 1) return countryInProse(countries[0]!.name);
  return `${countries.slice(0, -1).map((c) => countryInProse(c.name)).join(', ')} and ${countryInProse(countries[countries.length - 1]!.name)}`;
}

/**
 * V11 §N — A COUNTRY NAME IS NOT ALWAYS A SENTENCE-READY NOUN.
 *
 * Read at four widths, the Prepare screen said "English and Spanish are spoken
 * in United States", "United States uses the USD" and "United States uses type
 * A/B sockets" — three sentences, one missing article, on the screen whose
 * entire job is to sound like somebody who knows what they are talking about.
 *
 * This is grammar, not a place patch: a country name takes a definite article
 * when its head is a common noun (a republic, a kingdom, a union of states or
 * emirates, a group of islands) or when the name is itself a plural. Those two
 * rules cover almost everything; the short list beside them is the set of
 * established plural-form names English does not spell as plurals of anything,
 * and it is a list of *words*, not of destinations — nothing here decides
 * anything about a trip, a route or a measurement.
 */
const ARTICLE_HEAD = /\b(Republic|Kingdom|States|Emirates|Federation|Islands|Isles|Union)\b/;
const ARTICLE_NAMES = new Set(['Netherlands', 'Philippines', 'Bahamas', 'Maldives', 'Gambia', 'Comoros', 'Seychelles']);

/** Whether English puts "the" in front of this country name. */
export function countryTakesArticle(name: string): boolean {
  return ARTICLE_HEAD.test(name) || ARTICLE_NAMES.has(name.trim());
}

/** The country name as it is used inside a sentence: "the United States", "Japan". */
export function countryInProse(name: string): string {
  return countryTakesArticle(name) ? `the ${name}` : name;
}

/**
 * The possessive form: "the United States’", "Japan’s".
 *
 * A plural name ending in s takes the bare apostrophe, which is why this is not
 * simply `countryInProse(name) + '’s'`.
 */
export function countryPossessive(name: string): string {
  const inProse = countryInProse(name);
  return inProse.endsWith('s') ? `${inProse}’` : `${inProse}’s`;
}

// ---------------------------------------------------------------------------
// V10 §3 — Regional decomposition: the coverage graph
// ---------------------------------------------------------------------------

/**
 * A broad region has to be broken into places a trip can actually be built
 * from *before* composition, or the model is asked to invent both the
 * geography and the plan. This is that decomposition, and it is generic: a
 * zone is a named area that a geocoder placed, its role is derived from where
 * it sits relative to the destination's own extent, and drive relationships
 * are measured or honestly absent. Nothing here is keyed to a destination
 * name.
 */
export const COVERAGE_ROLES = [
  /** Inside the destination and central to it: a trip that skips every core zone is not this trip. */
  'core',
  /** Inside the destination but reachable only at a cost the route may decline to pay. */
  'optional',
  /** Outside the destination; travellers arrive and leave through it. Context, never the destination. */
  'gateway',
] as const;
export const coverageRoleSchema = z.enum(COVERAGE_ROLES);
export type CoverageRole = z.infer<typeof coverageRoleSchema>;

export const coverageZoneSchema = z.object({
  /** Stable within one decomposition; derived from the label, never a provider id. */
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  role: coverageRoleSchema,
  center: coordinatesSchema,
  bounds: geoBoundsSchema.optional(),
  countryCode: z.string().length(2).optional(),
  source: semanticEvidenceSourceSchema,
  /** The provider's own class for the zone, when it published one. */
  featureType: z.string().min(1).optional(),
  /** Kilometres from the destination's representative centre. Derived. */
  kmFromCentre: z.number().nonnegative(),
  /** Experiences named for this zone. Names only; each is placed and gated separately. */
  signatureExperiences: z.array(z.string().min(1).max(120)).max(8).default([]),
});
export type CoverageZone = z.infer<typeof coverageZoneSchema>;

export const zoneRelationSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  /** Straight-line kilometres: always available, never presented as a road distance. */
  km: z.number().nonnegative(),
  /** Measured road minutes, when a router answered for this pair. */
  minutes: z.number().nonnegative().optional(),
  basis: z.enum(['measured', 'unmeasured']),
});
export type ZoneRelation = z.infer<typeof zoneRelationSchema>;

export const DESTINATION_DECOMPOSITION_VERSION = 1 as const;

export const destinationDecompositionSchema = z.object({
  version: z.literal(DESTINATION_DECOMPOSITION_VERSION),
  zones: z.array(coverageZoneSchema).max(16).default([]),
  relations: z.array(zoneRelationSchema).max(120).default([]),
  /**
   * Why the decomposition is as thin as it is, when it is thin. An honest
   * "nobody named areas inside this and nothing placed" beats a fabricated
   * zone list.
   */
  note: z.string().max(240).default(''),
});
export type DestinationDecomposition = z.infer<typeof destinationDecompositionSchema>;

export const destinationSemanticsSchema = z.object({
  version: z.literal(DESTINATION_SEMANTICS_VERSION),
  /** Exactly what was typed. */
  rawText: z.string().min(1),
  /** What Sidequest calls it: the traveller's words unless a resolution earned better. */
  label: z.string().min(1),
  type: geographicSemanticTypeSchema,
  scale: geographicScaleSchema,
  countries: z.array(z.string().length(2)).default([]),
  regions: z.array(z.string().min(1)).default([]),
  /** The landscape word, from the phrase or the interpreter: "desert", "delta", "rockies". Read by the interview, never shown as a name. */
  landscape: z.string().min(1).optional(),
  /** A representative centre for calculations. Never a claim that the destination is a point. */
  center: coordinatesSchema.optional(),
  /** V10 §2 — how that centre was arrived at. `country_reference` is a stand-in, not a location. */
  centerBasis: centerBasisSchema.default('none'),
  extent: z.object({ bounds: geoBoundsSchema, source: extentSourceSchema }).optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.array(z.object({ source: semanticEvidenceSourceSchema, note: z.string().min(1) })).default([]),
  ambiguities: z.array(z.string().min(1)).default([]),
  /** Areas inside the destination that located it. */
  parts: z.array(semanticPartSchema).default([]),
  /** Cities travellers arrive through: context for the plan, never the destination. */
  gateways: z.array(semanticGatewaySchema).default([]),
  /** Rows the gate refused, by name and why, so a screen can say what was not accepted. */
  refused: z.array(z.object({ label: z.string().min(1), reason: z.string().min(1) })).max(8).default([]),
  /**
   * V10 §2 — the jurisdictions the destination sits inside, separate from the
   * destination itself. Country rows first; subnational rows only where a
   * provider actually named one.
   */
  jurisdictions: z.array(jurisdictionRefSchema).max(12).default([]),
  /** V10 §3 — the coverage graph, when one could be derived. */
  decomposition: destinationDecompositionSchema.optional(),
});
export type DestinationSemantics = z.infer<typeof destinationSemanticsSchema>;

/**
 * V10 §2 — THE ONE CANONICAL DESTINATION OBJECT.
 *
 * `DestinationConcept` is the name the product uses for this record from setup
 * through the questionnaire, composition and the itinerary: the raw phrase, the
 * semantic identity, the type and scale, the evidence-qualified centre and
 * extent, the countries and provinces, the gateways, the resolved parts, the
 * candidate subregions (`decomposition`) and the jurisdictions — one object, one
 * name, one source of truth. `DestinationSemantics` remains as the V8.1 alias
 * so persisted rows and existing consumers keep reading the same thing.
 */
export const destinationConceptSchema = destinationSemanticsSchema;
export type DestinationConcept = DestinationSemantics;

/** The box that holds every part's own box or point, and its centroid. */
export function extentOfParts(parts: readonly { center: Coordinates; bounds?: GeoBounds | undefined }[]): { center: Coordinates; bounds: GeoBounds } | null {
  if (parts.length === 0) return null;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    const sw = part.bounds?.southWest ?? part.center;
    const ne = part.bounds?.northEast ?? part.center;
    south = Math.min(south, sw.lat);
    west = Math.min(west, sw.lng);
    north = Math.max(north, ne.lat);
    east = Math.max(east, ne.lng);
  }
  const lat = parts.reduce((s, p) => s + p.center.lat, 0) / parts.length;
  const lng = parts.reduce((s, p) => s + p.center.lng, 0) / parts.length;
  return { center: { lat, lng }, bounds: { southWest: { lat: south, lng: west }, northEast: { lat: north, lng: east } } };
}

/**
 * V10 §2 — WHAT THE PHRASE ITSELF MEANS, BEFORE ANY EVIDENCE.
 *
 * The one derivation every consumer shares, so the degradation check and the
 * quality compiler cannot disagree about what was asked for. A composite of
 * country parts is several countries; a composite of anything else is a travel
 * region; one part is whatever its own shape says.
 */
export function phraseSemanticType(children: readonly Pick<IntentNode, 'kind'>[]): GeographicSemanticType {
  if (children.length === 0) return 'unknown';
  if (children.length === 1) return semanticTypeOfKind(children[0]!.kind);
  return children.every((child) => child.kind === 'country') ? 'multi_country' : 'informal_region';
}

/**
 * V10 §22 — A DESTINATION REGION MAY NOT BECOME ITS CONTAINING COUNTRY.
 *
 * True when the phrase means an area smaller than a country and the concept
 * nevertheless came out as the country. The check is on the *phrase's* meaning,
 * not on any provider row, because the failure it catches is precisely a
 * provider having nothing to say: "the Canadian Rockies" fell through to
 * Canada's published point and was then typed `country` at `country` scale with
 * `high` confidence. A caller that sees this is holding a defect, never a
 * fallback.
 */
export function degradedToCountry(input: {
  phraseType: GeographicSemanticType;
  type: GeographicSemanticType;
  scale: GeographicScale;
  /** When given, a country-or-wider *scale* only counts as degradation on a stand-in centre. */
  centerBasis?: CenterBasis;
}): boolean {
  if (input.phraseType === 'country' || input.phraseType === 'multi_country') return false;
  /* The type collapsing is always the defect: a mountain region is not a country. */
  if (input.type === 'country' || input.type === 'multi_country') return true;
  /*
   * A country-or-wider *scale* is not automatically wrong — the Alps and the
   * Sahara genuinely are that big, and saying otherwise would be a second, more
   * subtle lie. It is wrong in exactly one case: the destination's only anchor is
   * its containing country's published point, so the width is the country's and
   * not the destination's. A concept with no centre at all is mis-framing nothing,
   * because there is nothing to frame.
   */
  if (input.centerBasis !== undefined && input.centerBasis !== 'country_reference') return false;
  return input.scale === 'country' || input.scale === 'continental';
}

/**
 * V10 §15 — should a map refuse to frame this yet?
 *
 * A stand-in centre with no extent is not a location. Framing it draws a box
 * around a country's reference point, which is how a mountain-region trip
 * rendered eastern Canada. The honest answer is a "still locating" state.
 */
export function framingIsUnsafe(concept: Pick<DestinationConcept, 'type' | 'centerBasis' | 'extent'>): boolean {
  if (concept.extent) return false;
  return centreIsStandIn(concept.centerBasis) && isAreaType(concept.type);
}

/** Whether a semantic type is an area a trip moves around in rather than a place it stays put in. */
export function isAreaType(type: GeographicSemanticType): boolean {
  return REGION_SEMANTIC_TYPES.has(type) || type === 'island_group';
}

/** One sentence for a canvas caption: what kind of thing, at what scale, and how the extent was arrived at. */
export function describeSemantics(semantics: Pick<DestinationSemantics, 'type' | 'scale' | 'extent' | 'parts' | 'gateways' | 'countries'>, countryName: (code: string) => string | null = () => null): string {
  const kind = GEOGRAPHIC_SEMANTIC_TYPE_LABELS[semantics.type];
  const where = semantics.countries.length === 1 ? countryName(semantics.countries[0]!) : semantics.countries.length > 1 ? `${semantics.countries.length} countries` : null;
  const extent =
    semantics.extent?.source === 'published'
      ? 'framed at its published extent'
      : semantics.extent?.source === 'interpreted_parts'
        ? `framed around ${semantics.parts.length} ${semantics.parts.length === 1 ? 'area' : 'areas'} inside it`
        : semantics.extent?.source === 'union_of_parts'
          ? 'framed around its parts'
          : `framed at ${semantics.scale === 'continental' ? 'continental' : semantics.scale === 'country' ? 'country' : semantics.scale === 'region' || semantics.scale === 'subregion' ? 'regional' : 'local'} scale; nobody publishes its edges`;
  const gateways = semantics.gateways.length > 0 ? ` Gateways: ${semantics.gateways.map((g) => g.label).join(', ')}.` : '';
  return `${kind}${where ? ` in ${where}` : ''}, ${extent}.${gateways}`;
}
