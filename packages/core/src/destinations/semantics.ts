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

const REGION_TYPES: ReadonlySet<GeographicSemanticType> = new Set<GeographicSemanticType>(['admin_area', 'country', 'multi_country', 'mountain_region', 'natural_region', 'coast', 'island_group', 'protected_area', 'informal_region', 'city_region']);

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
      return REGION_TYPES.has(got) ? 'yes' : got === 'settlement' ? 'weak' : 'no';
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
  const regionWanted = REGION_TYPES.has(wanted) || isRegionKind(node.kind);

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
    if (expectation.type && REGION_TYPES.has(expectation.type) && semantics.type === 'settlement') return refuse('settlement_for_interpreted_region');
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
  const regionWanted = REGION_TYPES.has(expectation.type ?? semanticTypeOfKind(node.kind)) || isRegionKind(node.kind);
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
  if (isRegionKind(node.kind) || (REGION_TYPES.has(s.type) && s.type !== 'city_region')) return s.hasExtent && SCALE_RANK[s.scale] >= SCALE_RANK.district;
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

export const destinationConceptSchema = z.object({
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
  /** One line, traveller-readable. */
  note: z.string().max(240).default(''),
});
export type DestinationConcept = z.infer<typeof destinationConceptSchema>;

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
});
export type DestinationSemantics = z.infer<typeof destinationSemanticsSchema>;

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

/** Whether a semantic type is an area a trip moves around in rather than a place it stays put in. */
export function isAreaType(type: GeographicSemanticType): boolean {
  return REGION_TYPES.has(type) || type === 'island_group';
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
