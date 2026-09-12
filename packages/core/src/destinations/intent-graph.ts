import { z } from 'zod';
import { coordinatesSchema, type Coordinates } from '../schemas/common';
import { geoBoundsSchema, type GeoBounds } from '../schemas/geography';
import { countriesInText, countryFromDemonym, foldedWordsOf, isDemonym } from '../reference/countries';

/**
 * THE DESTINATION INTENT GRAPH — A TRIP IS NOT A POINT.
 *
 * V7 §2. "Kenya and Tanzania" was refused with "name a town, a region or a
 * country" because the whole phrase was handed to a geocoder as one string,
 * the geocoder answered nothing, and nothing between the field and the
 * refusal could say "two countries". This module is that something.
 *
 * It reads the SHAPE of what was typed — conjunctions, separators, country
 * names from the bundled reference, generic landscape words, qualifiers like
 * "rural" or "northern" — and produces a composable graph: one node per
 * meaningful part, a relationship between the parts, the countries named,
 * and later (once a resolver has answered for the parts it can) an envelope
 * that is the union of the children. Nothing here knows a place name that is
 * not a country; "Okavango Delta" is a natural region because of the word
 * "delta", not because of the word "Okavango".
 *
 * Rules the rest of the product relies on:
 *
 * - The traveller's words are never rewritten. `travellerLabel` is the phrase
 *   they typed (a bare country name is shown in its reference spelling).
 * - Unresolved is not invalid. A graph with no resolved child is still a
 *   valid intent and the composition reads it as the traveller's phrase.
 * - Only ask when two plausible readings would produce materially different
 *   trips; that decision is not made here (it stays in `resolution.ts`).
 */

export const INTENT_GRAPH_VERSION = 1 as const;

export const INTENT_NODE_KINDS = [
  /** A town or city, one likely base. */
  'city',
  /** A city that is also a first-level division (a direct-administered municipality, a city-state). */
  'municipality',
  /** A state, province, prefecture or county. */
  'admin_region',
  'country',
  /** A landscape with a name: a delta, a valley, highlands, a desert. */
  'natural_region',
  'park',
  'island',
  'island_chain',
  'coast',
  'mountain_range',
  /** A road, rail line or from–to journey named as the trip. */
  'corridor',
  /** A country or region qualified by "rural", "northern", "coastal"… */
  'vague_region',
  /** A part the shape says nothing about; a resolver may still answer. */
  'named_place',
] as const;
export const intentNodeKindSchema = z.enum(INTENT_NODE_KINDS);
export type IntentNodeKind = z.infer<typeof intentNodeKindSchema>;

export const INTENT_NODE_KIND_LABELS: Record<IntentNodeKind, string> = {
  city: 'A city',
  municipality: 'A city and its region',
  admin_region: 'A region',
  country: 'A country',
  natural_region: 'A natural region',
  park: 'A park or protected area',
  island: 'An island',
  island_chain: 'A group of islands',
  coast: 'A coast',
  mountain_range: 'Mountain country',
  corridor: 'A route',
  vague_region: 'Part of a country',
  named_place: 'A named place',
};

export const INTENT_RELATIONSHIPS = [
  'single',
  /** Several regions or countries in one trip. */
  'multi_region_trip',
  /** A city plus the country or region around it. */
  'city_plus_region',
  /** From one place to another, or along a named road. */
  'corridor',
  /** A described part of one country ("rural Japan"). */
  'country_subset',
] as const;
export type IntentRelationship = (typeof INTENT_RELATIONSHIPS)[number];

export const intentNodeResolutionSchema = z.object({
  label: z.string().min(1),
  center: coordinatesSchema,
  bounds: geoBoundsSchema.optional(),
  /** `country`, `city`, `state_or_province`… as the answering source published it. */
  featureType: z.string().min(1).optional(),
  countryCode: z.string().length(2).optional(),
  /** Which tier answered: the index, the bundled country reference, or a geocoder. */
  source: z.enum(['index', 'reference', 'geocoder', 'composite', 'interpretation']),
  /** The resolver's candidate id, when a geocoder answered. */
  candidateId: z.string().min(1).optional(),
  /** The civil time zone the answering source published for the part, when it did. */
  timeZone: z.string().min(1).optional(),
});
export type IntentNodeResolution = z.infer<typeof intentNodeResolutionSchema>;

export const intentNodeSchema = z.object({
  id: z.string().min(1),
  kind: intentNodeKindSchema,
  /** This part of the phrase, in the traveller's own words. */
  label: z.string().min(1),
  /** The words that qualified it: "rural", "northern", "coastal". */
  qualifiers: z.array(z.string().min(1)).default([]),
  /** ISO 3166-1 alpha-2 when this part names or sits inside one country. */
  countryCode: z.string().length(2).optional(),
  /** The landscape word that classified a natural region: "delta", "highlands". */
  landscape: z.string().min(1).optional(),
  resolution: intentNodeResolutionSchema.optional(),
});
export type IntentNode = z.infer<typeof intentNodeSchema>;

export const destinationIntentGraphSchema = z.object({
  version: z.literal(INTENT_GRAPH_VERSION),
  rawText: z.string().min(1),
  travellerLabel: z.string().min(1),
  relationship: z.enum(INTENT_RELATIONSHIPS),
  children: z.array(intentNodeSchema).min(1),
  /** Every country the phrase names or sits in, deduplicated, in phrase order. */
  countries: z.array(z.string().length(2)).default([]),
  crossBorder: z.boolean(),
  envelope: z.object({ center: coordinatesSchema, bounds: geoBoundsSchema.optional() }).optional(),
  /** high: every child is a country or resolved; medium: some; low: none. */
  confidence: z.enum(['high', 'medium', 'low']),
  ambiguities: z.array(z.string().min(1)).default([]),
});
export type DestinationIntentGraph = z.infer<typeof destinationIntentGraphSchema>;

// ---------------------------------------------------------------------------
// Vocabulary — generic words only, never a place name
// ---------------------------------------------------------------------------

/** Words that qualify a place rather than name one; exported so the semantic gate can ignore them when comparing names. */
export function isQualifierWord(word: string): boolean {
  return QUALIFIERS.has(word.toLowerCase());
}

const QUALIFIERS = new Set(['rural', 'northern', 'southern', 'eastern', 'western', 'central', 'coastal', 'inland', 'remote', 'upper', 'lower', 'north', 'south', 'east', 'west', 'interior', 'countryside', 'outer', 'inner', 'greater', 'wild', 'highland', 'lowland', 'urban', 'tropical', 'alpine']);

/** Landscape words → node kind. Matched as whole words against the folded part. */
const LANDSCAPE: readonly [RegExp, IntentNodeKind][] = [
  [/\b(national park|national reserve|nature reserve|game reserve|conservancy|sanctuary|wilderness area|state park|regional park|reserve)\b/, 'park'],
  [/\b(islands|isles|archipelago|keys|atolls|cays|island chain|island group)\b/, 'island_chain'],
  [/\b(island|isle|atoll|key)\b/, 'island'],
  [/\b(coast|coastline|riviera|shore|seaboard|littoral|costa)\b/, 'coast'],
  [/\b(alps|mountains|range|highlands|massif|sierra|cordillera|hills|uplands|peaks|dolomites|pyrenees|rockies|himalaya|himalayas|andes)\b/, 'mountain_range'],
  [/\b(road|route|trail|way|loop|drive|corridor|railway|line|path|pass)\b/, 'corridor'],
  [/\b(delta|valley|valleys|desert|lakes|lake district|fjords|fjord|gorge|gorges|canyon|plateau|steppe|steppes|savanna|savannah|jungle|rainforest|outback|glacier|volcano|peninsula|bay|gulf|cape|basin|lake|river|wetlands|marsh|dunes|plains|prairie|tundra|forest|woods|caldera|karst|rift|highveld|bush|lagoon|reef|estuary)\b/, 'natural_region'],
];

/** Separators that split one phrase into several places. `&`, `+`, `/`, commas and the conjunctions. */
const SEPARATOR = /\s*(?:,|\/|&|\+|\band\b|\bthen\b|\bplus\b|\balso\b|\bwith\b|\bor\b)\s*/i;

/** "from X to Y", "X to Y", "X → Y" — a journey named as the destination. */
const CORRIDOR_PHRASE = /^(?:from\s+)?(.+?)\s+(?:to|→|->|via)\s+(.+)$/i;


function slug(text: string, index: number): string {
  const s = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return `n${index + 1}-${s || 'part'}`;
}

/** The label the traveller would recognise: their words, trimmed, articles kept. */
function cleanLabel(part: string): string {
  return part.replace(/\s+/g, ' ').trim();
}

function fold(text: string): string {
  return foldedWordsOf(text).join(' ');
}

interface Classified {
  kind: IntentNodeKind;
  qualifiers: string[];
  countryCode?: string;
  landscape?: string;
}

/**
 * What one part of the phrase is, from its shape.
 *
 * Order matters and is deliberate: a country name wins outright ("Kenya"); a
 * country inside a qualified phrase makes a vague region or a landscape inside
 * that country ("rural Japan", "the steppes of Kyrgyzstan"); a landscape word
 * alone makes a natural region ("Okavango Delta"); a settlement marker makes a
 * city ("New York City"); anything else is a named place a resolver may answer.
 */
export function classifyIntentPart(part: string): Classified {
  const folded = fold(part);
  const words = folded.split(' ').filter(Boolean);
  const hits = countriesInText(part);
  const qualifiers = words.filter((w) => QUALIFIERS.has(w));
  const landscape = LANDSCAPE.find(([re]) => re.test(folded));

  if (hits.length === 1) {
    const hit = hits[0]!;
    const span = hit.wordSpan[1] - hit.wordSpan[0];
    const rest = words.filter((_, i) => i < hit.wordSpan[0] || i >= hit.wordSpan[1]).filter((w) => w !== 'the' && w !== 'of' && w !== 'in');
    if (rest.length === 0 || (rest.length === 1 && rest[0] === 'the')) return { kind: 'country', qualifiers: [], countryCode: hit.facts.code };
    if (landscape && rest.some((w) => landscape[0].test(w) || landscape[0].test(rest.join(' ')))) {
      return { kind: landscape[1], qualifiers, countryCode: hit.facts.code, landscape: landscape[0].exec(folded)?.[1] };
    }
    if (rest.every((w) => QUALIFIERS.has(w))) return { kind: 'vague_region', qualifiers, countryCode: hit.facts.code };
    /* "Tokyo Japan", "Cusco, Peru" — a place with its country as a qualifier. */
    void span;
    return { kind: /\b(city|town)\b/.test(rest.join(' ')) ? 'city' : 'named_place', qualifiers, countryCode: hit.facts.code };
  }
  if (hits.length > 1) {
    /* Two countries inside one un-split part ("Chilean and Argentine" would have been split; this is a fallback). */
    return { kind: 'vague_region', qualifiers };
  }
  if (landscape) return { kind: landscape[1], qualifiers, landscape: landscape[0].exec(folded)?.[1] };
  if (/\b(city|town|metropolis|ville|stadt|ciudad)\b/.test(folded) || /^[A-Z]{2,4}$/.test(part.trim())) return { kind: 'city', qualifiers };
  return { kind: 'named_place', qualifiers };
}

function demonymCountry(part: string): string | undefined {
  return countryFromDemonym(part) ?? undefined;
}

/**
 * Split the phrase into its parts. A part that is only a qualifier or an
 * article ("and", "rural") is not a place and is merged into its neighbour;
 * a demonym-only part ("Chilean") is glued onto the next part.
 */
export function splitIntentPhrase(rawText: string): string[] {
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const corridor = CORRIDOR_PHRASE.exec(text);
  const pieces = (corridor ? [corridor[1]!, corridor[2]!] : text.split(SEPARATOR)).map(cleanLabel).filter(Boolean);
  const merged: string[] = [];
  let pendingPrefix: string | null = null;
  for (const [index, piece] of pieces.entries()) {
    const folded = fold(piece);
    const words = folded.split(' ').filter(Boolean);
    const onlyQualifiers = words.length > 0 && words.every((w) => QUALIFIERS.has(w) || w === 'the');
    const onlyDemonym = words.length === 1 && isDemonym(words[0]!);
    if (onlyDemonym) {
      /*
       * "Chilean and Argentine Patagonia": a nationality on its own shares the
       * noun of the part that follows it, so both halves name the landscape.
       */
      const next = pieces[index + 1];
      const nextWords = next ? fold(next).split(' ').filter(Boolean) : [];
      if (next && nextWords.length >= 2 && isDemonym(nextWords[0]!)) {
        merged.push(`${piece} ${next.split(' ').slice(1).join(' ')}`);
        continue;
      }
      pendingPrefix = pendingPrefix ? `${pendingPrefix} ${piece}` : piece;
      continue;
    }
    if (onlyQualifiers) {
      pendingPrefix = pendingPrefix ? `${pendingPrefix} ${piece}` : piece;
      continue;
    }
    merged.push(pendingPrefix ? `${pendingPrefix} ${piece}` : piece);
    pendingPrefix = null;
  }
  if (pendingPrefix && merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]} ${pendingPrefix}`;
  else if (pendingPrefix) merged.push(pendingPrefix);
  return merged.filter((p) => p.length >= 2);
}

/** Parse the phrase alone. Pure; no resolver, no network. */
export function parseDestinationIntent(rawText: string): DestinationIntentGraph {
  const text = rawText.replace(/\s+/g, ' ').trim();
  const corridor = CORRIDOR_PHRASE.test(text) && !/^(drive|fly|walk|hike|sail|travel|go)\b/i.test(text);
  let parts = splitIntentPhrase(text);
  if (parts.length === 0) parts = [text];

  const children: IntentNode[] = parts.map((part, index) => {
    const classified = classifyIntentPart(part);
    const countryCode = classified.countryCode ?? demonymCountry(part);
    const label = cleanLabel(part);
    return intentNodeSchema.parse({
      id: slug(label, index),
      kind: corridor && parts.length === 2 ? (classified.kind === 'country' ? 'country' : classified.kind) : classified.kind,
      label,
      qualifiers: classified.qualifiers,
      ...(countryCode ? { countryCode } : {}),
      ...(classified.landscape ? { landscape: classified.landscape } : {}),
    });
  });

  const countries = [...new Set(children.map((c) => c.countryCode).filter((c): c is string => Boolean(c)))];
  const crossBorder = countries.length > 1;
  const kinds = new Set(children.map((c) => c.kind));
  let relationship: IntentRelationship = 'single';
  if (corridor && children.length === 2) relationship = 'corridor';
  else if (children.length > 1) {
    const hasCity = kinds.has('city') || kinds.has('municipality') || kinds.has('named_place');
    const hasRegion = kinds.has('country') || kinds.has('admin_region') || kinds.has('vague_region') || kinds.has('natural_region') || kinds.has('coast') || kinds.has('mountain_range') || kinds.has('island_chain') || kinds.has('park');
    relationship = hasCity && hasRegion && !crossBorder ? 'city_plus_region' : 'multi_region_trip';
  } else if (children[0]!.kind === 'vague_region' || (children[0]!.countryCode && children[0]!.kind !== 'country' && children[0]!.kind !== 'named_place' && children[0]!.kind !== 'city')) {
    relationship = 'country_subset';
  }

  const single = children.length === 1 ? children[0]! : null;
  const travellerLabel = single && single.kind === 'country' && single.countryCode ? countryDisplayName(single.countryCode, single.label) : text;
  const allCountries = children.every((c) => c.kind === 'country');

  return destinationIntentGraphSchema.parse({
    version: INTENT_GRAPH_VERSION,
    rawText: text,
    travellerLabel,
    relationship,
    children,
    countries,
    crossBorder,
    confidence: allCountries ? 'high' : countries.length > 0 ? 'medium' : 'low',
    ambiguities: [],
  });
}

function countryDisplayName(code: string, fallback: string): string {
  const hit = countriesInText(fallback).find((h) => h.facts.code === code);
  return hit?.how === 'name' ? hit.facts.name : fallback;
}

/** Attach what a resolver established for some children and recompute the envelope and confidence. */
export function attachIntentResolutions(graph: DestinationIntentGraph, resolutions: ReadonlyMap<string, IntentNodeResolution>): DestinationIntentGraph {
  const children = graph.children.map((child) => {
    const resolution = resolutions.get(child.id);
    if (!resolution) return child;
    return { ...child, ...(resolution.countryCode && !child.countryCode ? { countryCode: resolution.countryCode } : {}), resolution };
  });
  const resolved = children.filter((c) => c.resolution);
  const envelope = envelopeOf(resolved.map((c) => c.resolution!));
  const countries = [...new Set(children.map((c) => c.countryCode).filter((c): c is string => Boolean(c)))];
  const settled = children.filter((c) => c.resolution || c.kind === 'country').length;
  return destinationIntentGraphSchema.parse({
    ...graph,
    children,
    countries,
    crossBorder: countries.length > 1,
    ...(envelope ? { envelope } : {}),
    confidence: settled === children.length ? 'high' : settled > 0 ? 'medium' : 'low',
  });
}

/** The union of resolved children: a centroid and the bounding box that holds every child's own box or point. */
export function envelopeOf(resolved: readonly { center: Coordinates; bounds?: GeoBounds | undefined }[]): { center: Coordinates; bounds?: GeoBounds } | null {
  if (resolved.length === 0) return null;
  const lat = resolved.reduce((s, r) => s + r.center.lat, 0) / resolved.length;
  const lng = resolved.reduce((s, r) => s + r.center.lng, 0) / resolved.length;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const r of resolved) {
    const sw = r.bounds?.southWest ?? r.center;
    const ne = r.bounds?.northEast ?? r.center;
    south = Math.min(south, sw.lat);
    west = Math.min(west, sw.lng);
    north = Math.max(north, ne.lat);
    east = Math.max(east, ne.lng);
  }
  const bounds = resolved.length > 1 || resolved[0]!.bounds ? { southWest: { lat: south, lng: west }, northEast: { lat: north, lng: east } } : undefined;
  return { center: { lat, lng }, ...(bounds ? { bounds } : {}) };
}

/** True when the graph is more than one resolvable thing, so the trip must be planned as a route across them. */
export function intentIsComposite(graph: DestinationIntentGraph): boolean {
  return graph.children.length > 1;
}

/** One sentence about the shape of the intent, for the composition task and the setup canvas. Never a place name the traveller did not type. */
export function describeIntentGraph(graph: DestinationIntentGraph, countryName: (code: string) => string | null = () => null): string {
  const names = graph.children.map((c) => c.label);
  const countryNames = graph.countries.map((c) => countryName(c) ?? c);
  switch (graph.relationship) {
    case 'multi_region_trip':
      return graph.crossBorder
        ? `Several countries in one trip (${countryNames.join(', ')}): plan one coherent route across them and treat each border crossing as real logistics (entry rules, currency, transport between them).`
        : `Several named areas in one trip (${names.join(', ')}): plan the route between them.`;
    case 'city_plus_region':
      return `A city and the region around it (${names.join(' + ')}): a base in the city and days or a leg out into the region.`;
    case 'corridor':
      return `A journey from ${names[0]} to ${names[1]}: plan the route along it, with bases in the order the ground runs.`;
    case 'country_subset': {
      const child = graph.children[0]!;
      const q = child.qualifiers.length > 0 ? child.qualifiers.join(' ') : child.landscape ?? 'part';
      return `${q} ${countryNames[0] ?? ''}: a described part of one country, so decide its extent from the traveller's word "${child.label}" and say how you read it.`.trim();
    }
    default: {
      const child = graph.children[0]!;
      return child.kind === 'natural_region' || child.kind === 'coast' || child.kind === 'mountain_range' || child.kind === 'island_chain' || child.kind === 'park'
        ? `${INTENT_NODE_KIND_LABELS[child.kind]}, so plan around access points and the landscape rather than one centre.`
        : child.kind === 'municipality'
          ? 'A city that is also a large administrative region: a dense urban core plus regional days reachable by rail, driver or transit.'
          : child.kind === 'country'
            ? 'A whole country: choose which part of it this trip covers and say why.'
            : 'One named place.';
    }
  }
}
