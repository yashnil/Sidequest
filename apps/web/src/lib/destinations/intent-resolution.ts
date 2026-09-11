import 'server-only';
import {
  DESTINATION_RESOLUTION_VERSION,
  assessConfidence,
  attachIntentResolutions,
  countryFacts,
  countryPointFor,
  describeIntentGraph,
  intentIsComposite,
  normalizeDestinationQuery,
  parseDestinationIntent,
  type ConfidenceSignal,
  type DestinationCandidate,
  type DestinationIntentGraph,
  type DestinationResolution,
  type IntentNode,
  type IntentNodeResolution,
} from '@sidequest/core';
import type { DestinationResolver } from '@sidequest/compiler';

/**
 * RESOLVING A DESTINATION-INTENT GRAPH — PART BY PART, NEVER THE PHRASE.
 *
 * V7 §2. The two callers that used to hand a whole phrase to one geocoder
 * (`placeDestinationAction` at setup, `resolveDestinationAction` on the trip)
 * both come through here now. Each child of the graph is answered by the
 * cheapest tier that can: a country by the bundled reference (instantly), a
 * named part by the resolver, one call each, capped. What comes back is the
 * graph with resolutions attached and — where more than one part resolved,
 * or a described part of a country — one synthetic *composite* candidate
 * whose centre and box are the union of the parts. Every existing consumer
 * (screening, the timing card, the composition envelope) reads a candidate,
 * so the composite travels in the shape they already speak.
 *
 * Unresolved ≠ invalid: a graph with nothing resolved returns no candidate
 * and no ambiguity reason that could refuse a trip; the caller lets the
 * interview start from the traveller's own words.
 */

export interface GraphResolutionOutcome {
  graph: DestinationIntentGraph;
  /** The resolver's own answers for the parts it was asked about, by child id. */
  partResolutions: Map<string, DestinationResolution>;
  geocoderCalls: number;
}

const MAX_GEOCODER_CALLS = 3;

function resolutionFromCandidate(candidate: DestinationCandidate): IntentNodeResolution {
  return {
    label: candidate.displayName,
    center: candidate.center,
    ...(candidate.bounds ? { bounds: candidate.bounds } : {}),
    featureType: candidate.entityType,
    ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
    source: 'geocoder',
    candidateId: candidate.id,
    ...(candidate.timeZones[0] ? { timeZone: candidate.timeZones[0] } : {}),
  };
}

/** The reference answer for a country child: its published point, no box. */
function referenceResolution(node: IntentNode): IntentNodeResolution | null {
  if (!node.countryCode) return null;
  const facts = countryFacts(node.countryCode);
  const point = countryPointFor(node.countryCode);
  if (!facts || !point) return null;
  return { label: facts.name, center: { lat: point.lat, lng: point.lng }, featureType: 'country', countryCode: node.countryCode, source: 'reference', timeZone: facts.timeZone };
}

/** What to ask the resolver for one part: the part, qualified by its country when the phrase gave one. */
export function resolverQueryFor(node: IntentNode): string {
  if (node.kind === 'country' && node.countryCode) return countryFacts(node.countryCode)?.name ?? node.label;
  const country = node.countryCode ? countryFacts(node.countryCode)?.name : null;
  const label = node.label.replace(/^(the)\s+/i, '');
  return country && !new RegExp(`\\b${country}\\b`, 'i').test(label) ? `${label}, ${country}` : label;
}

/**
 * Resolve every child that can be resolved. A country child is answered from
 * the reference at once and, while calls remain, asked of the resolver too so
 * its box reaches the envelope; a named or landscape child is asked once. A
 * part the resolver cannot place keeps its reference point or stays open.
 */
export async function resolveIntentGraph(input: {
  graph: DestinationIntentGraph;
  resolver: DestinationResolver | null;
  now: Date;
  maxGeocoderCalls?: number;
}): Promise<GraphResolutionOutcome> {
  const resolutions = new Map<string, IntentNodeResolution>();
  const partResolutions = new Map<string, DestinationResolution>();
  let calls = 0;
  const budget = input.maxGeocoderCalls ?? MAX_GEOCODER_CALLS;

  for (const child of input.graph.children) {
    const reference = referenceResolution(child);
    if (reference && child.kind === 'country') resolutions.set(child.id, reference);
  }
  /* Named parts first: they are the ones only a resolver can answer. Countries take what budget is left. */
  const order = [...input.graph.children].sort((a, b) => Number(a.kind === 'country') - Number(b.kind === 'country'));
  for (const child of order) {
    if (!input.resolver || calls >= budget) break;
    if (child.kind === 'vague_region') continue; // "rural Japan" has no row anywhere; the country point is the honest anchor.
    calls += 1;
    try {
      const answer = await input.resolver.resolve({ query: resolverQueryFor(child), now: input.now });
      partResolutions.set(child.id, answer);
      const leading = answer.candidates.find((c) => c.id === answer.unambiguousCandidateId) ?? answer.candidates[0];
      if (!leading) continue;
      /* A country asked of the resolver must come back as one; a town sharing the name is not the country. */
      if (child.kind === 'country' && leading.entityType !== 'country') continue;
      if (child.countryCode && leading.countryCode && leading.countryCode !== child.countryCode) continue;
      resolutions.set(child.id, resolutionFromCandidate(leading));
    } catch {
      /* A provider that failed is not a place that does not exist; the part stays as it was. */
    }
  }
  for (const child of input.graph.children) {
    if (resolutions.has(child.id)) continue;
    const reference = referenceResolution(child);
    if (reference) resolutions.set(child.id, reference);
  }
  return { graph: attachIntentResolutions(input.graph, resolutions), partResolutions, geocoderCalls: calls };
}

/** Whether this graph is answered by one composite candidate rather than the resolver's own leading row. */
export function graphNeedsComposite(graph: DestinationIntentGraph): boolean {
  if (intentIsComposite(graph)) return true;
  const only = graph.children[0]!;
  return only.kind === 'vague_region';
}

function slugOf(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * The one candidate a composite intent becomes. Its identity is the phrase;
 * its geometry is the union of the parts; its confidence is honest about how
 * many parts were actually placed.
 */
export function compositeCandidateFor(graph: DestinationIntentGraph): DestinationCandidate | null {
  const resolved = graph.children.filter((c) => c.resolution);
  if (!graph.envelope || resolved.length === 0) return null;
  const countries = graph.countries;
  const single = countries.length === 1 ? countries[0]! : undefined;
  const signals: ConfidenceSignal[] = [];
  signals.push(resolved.length === graph.children.length ? 'exact_name_match' : 'name_match_partial');
  if (countries.length > 0) signals.push('administrative_hierarchy_match');
  signals.push(graph.envelope.bounds ? 'boundary_available' : 'no_boundary_available');
  signals.push('single_provider_only');
  const kinds = new Set(graph.children.map((c) => c.kind));
  const entityType: DestinationCandidate['entityType'] = graph.crossBorder
    ? 'multi_country'
    : kinds.has('country') && graph.children.length === 1
      ? 'country'
      : graph.children[0]!.kind === 'vague_region'
        ? 'state_or_province'
        : 'subregion';
  const breadth: DestinationCandidate['breadth'] = graph.crossBorder ? 'multi_country' : kinds.has('country') ? 'country' : 'region';
  const countryNames = countries.map((code) => countryFacts(code)?.name ?? code);
  return {
    id: `composite:${slugOf(graph.rawText)}`,
    displayName: graph.travellerLabel,
    qualifiedName: resolved.map((c) => c.resolution!.label).join(' · ') || graph.travellerLabel,
    entityType,
    breadth,
    center: graph.envelope.center,
    ...(graph.envelope.bounds ? { bounds: graph.envelope.bounds } : {}),
    ...(single ? { countryCode: single, countryName: countryFacts(single)?.name ?? single } : {}),
    aliases: [],
    administrativeAreas: countryNames,
    /* The parts' own zones, so sunsets and day windows are computed in local time rather than UTC. */
    timeZones: [...new Set(resolved.flatMap((c) => (c.resolution!.timeZone ? [c.resolution!.timeZone] : [])))],
    providerRefs: resolved.flatMap((c) => (c.resolution!.candidateId ? [{ provider: 'openstreetmap', externalId: c.resolution!.candidateId }] : [])),
    confidence: assessConfidence(signals),
    note: describeIntentGraph(graph, (code) => countryFacts(code)?.name ?? null),
  };
}

/**
 * One `DestinationResolution` for the whole phrase, from the graph. A composite
 * candidate leads when the graph earned one; a graph whose only part the
 * resolver placed passes that answer through untouched; a graph nothing could
 * place returns an honest empty list with no reason that could refuse the trip.
 */
export function resolutionForGraph(outcome: GraphResolutionOutcome, query: string, now: Date, providersConsulted: readonly string[]): DestinationResolution {
  const { graph } = outcome;
  if (!graphNeedsComposite(graph)) {
    const only = graph.children[0]!;
    const own = outcome.partResolutions.get(only.id);
    if (own && own.candidates.length > 0) return own;
    /* The resolver drew a blank for a single part; a country in the phrase still places it. */
    const composite = compositeCandidateFor(graph);
    return {
      schemaVersion: DESTINATION_RESOLUTION_VERSION,
      query,
      normalizedQuery: normalizeDestinationQuery(query),
      candidates: composite ? [composite] : [],
      ambiguityReasons: composite ? (composite.bounds ? [] : ['no_boundary_available']) : [],
      ...(composite ? { unambiguousCandidateId: composite.id } : {}),
      providersConsulted: [...providersConsulted],
      resolvedAt: now.toISOString(),
    };
  }
  const composite = compositeCandidateFor(graph);
  return {
    schemaVersion: DESTINATION_RESOLUTION_VERSION,
    query,
    normalizedQuery: normalizeDestinationQuery(query),
    candidates: composite ? [composite] : [],
    ambiguityReasons: composite ? [...(composite.bounds ? [] : ['no_boundary_available' as const]), ...(composite.breadth === 'country' || composite.breadth === 'multi_country' ? ['administrative_area_needs_subset' as const] : [])] : [],
    ...(composite ? { unambiguousCandidateId: composite.id } : {}),
    providersConsulted: [...providersConsulted],
    resolvedAt: now.toISOString(),
  };
}

/** Parse and resolve in one call — what both doors need. */
export async function resolveDestinationPhrase(input: { text: string; resolver: DestinationResolver | null; now: Date; maxGeocoderCalls?: number }): Promise<{ outcome: GraphResolutionOutcome; resolution: DestinationResolution }> {
  const graph = parseDestinationIntent(input.text);
  const outcome = await resolveIntentGraph({ graph, resolver: input.resolver, now: input.now, ...(input.maxGeocoderCalls !== undefined ? { maxGeocoderCalls: input.maxGeocoderCalls } : {}) });
  const consulted = [...new Set([...(outcome.geocoderCalls > 0 && input.resolver ? [input.resolver.name] : []), ...(outcome.graph.countries.length > 0 ? ['country-reference'] : [])])];
  return { outcome, resolution: resolutionForGraph(outcome, input.text, input.now, consulted) };
}
