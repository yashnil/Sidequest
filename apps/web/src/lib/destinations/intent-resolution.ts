import 'server-only';
import {
  DESTINATION_RESOLUTION_VERSION,
  DESTINATION_SEMANTICS_VERSION,
  assessConfidence,
  attachIntentResolutions,
  envelopeOf,
  countryFacts,
  countryPointFor,
  describeIntentGraph,
  centreIsStandIn,
  destinationConceptSchema,
  diagonalKm,
  evidenceSufficient,
  extentOfParts,
  intentIsComposite,
  isDemonym,
  isRegionKind,
  normalizeDestinationQuery,
  parseDestinationIntent,
  rankCandidates,
  scaleOfDiagonalKm,
  travelExtentFor,
  coherentScale,
  type TravelExtent,
  semanticTypeOfKind,
  type ConfidenceSignal,
  type DestinationCandidate,
  type CenterBasis,
  type DestinationConcept,
  type InterpretedConcept,
  type JurisdictionRef,
  type DestinationIntentGraph,
  type DestinationResolution,
  type DestinationSemantics,
  type GeographicScale,
  type GeographicSemanticType,
  type IntentNode,
  type IntentNodeResolution,
  type RankedCandidate,
  type SemanticGateway,
  type SemanticPart,
} from '@sidequest/core';
import type { DestinationResolver } from '@sidequest/compiler';
import { interpretDestinationConcept, type DestinationInterpreter } from './interpretation';

/**
 * RESOLVING A DESTINATION-INTENT GRAPH — PART BY PART, THROUGH A GATE.
 *
 * V7 §2 read the phrase as a graph and asked a geocoder about each part.
 * V8.1 adds the thing that was missing between the geocoder's answer and
 * the product: **a provider row is evidence, and it has to agree with what
 * the phrase means before it may locate anything.** "the Canadian Rockies"
 * reached production as a shop on 17 Avenue SW, Calgary, because the
 * leading row was adopted unread (`.claude-private/V8.1-DESTINATION-FAILURE.md`).
 *
 * The hierarchy, in order, for each part:
 *
 * 1. the bundled country reference (a country, instantly);
 * 2. the geocoder, its rows ranked through the semantic gate
 *    (`@sidequest/core` `semantics.ts`) — a business, road or neighbourhood
 *    never stands for a region, a same-named town stands for one only weakly,
 *    the wrong country never stands for anything;
 * 3. one fallback geocoder query for a landscape part (the name without its
 *    nationality, with the landscape word in its map form: "Rocky Mountains,
 *    Canada" for "the Canadian Rockies");
 * 4. when the evidence is still insufficient for a region-like part, the
 *    world-model interpreter (`interpretation.ts`): it classifies the concept
 *    and names areas inside it and gateways into it; each name is geocoded
 *    and gated; the extent is the box around the areas that placed, marked as
 *    exactly that. The interpreter never produces a coordinate.
 *
 * What comes back is the graph with resolutions attached, one
 * `DestinationSemantics` record (type, scale, countries, evidence-qualified
 * centre and extent, parts, gateways kept separate from identity, and the
 * rows the gate refused), and a `DestinationResolution` in the shape every
 * existing consumer already speaks: the gate-approved rows, or one synthetic
 * candidate for a composite or an interpreted concept, or an honest empty
 * list with no reason that could refuse a trip.
 */

export interface GraphResolutionOutcome {
  graph: DestinationIntentGraph;
  /** The resolver's own answers for the parts it was asked about, by child id. */
  partResolutions: Map<string, DestinationResolution>;
  geocoderCalls: number;
  /** V8.1 — the gate's reading of the whole phrase. */
  semantics: DestinationSemantics;
  /** V8.1 — the gate-approved rows per part, best first (empty when nothing was compatible). */
  approved: Map<string, RankedCandidate[]>;
  interpretation: { concept: InterpretedConcept | null; source: string; modelCalls: number } | null;
  /**
   * V10 §15 — WHERE THE SETUP SCREEN'S WAIT WENT.
   *
   * The founder's Canadian Rockies setup rendered eastern Canada while it
   * waited, and nothing anywhere recorded how long it waited or on what. These
   * are wall-clock milliseconds, attributed to the two things that can take
   * time: geocoder round trips and the one bounded interpreter call. Overlapping
   * awaits count their own wall time, so `geocoderMs` is the time the *slowest*
   * parallel wave took rather than the sum — which is the figure a screen budget
   * is actually set against.
   */
  timings: { totalMs: number; geocoderMs: number; interpreterMs: number; geocoderCalls: number; cacheHit: boolean };
}

const MAX_GEOCODER_CALLS = 3;
const REGION_TYPE_SET = new Set<GeographicSemanticType>(['admin_area', 'country', 'multi_country', 'mountain_region', 'natural_region', 'coast', 'island_group', 'protected_area', 'informal_region', 'city_region']);
/** Extra geocoder calls the interpreter's names may spend: four areas, two gateways. */
const MAX_INTERPRETATION_CALLS = 6;

function resolutionFromCandidate(candidate: DestinationCandidate, source: IntentNodeResolution['source'] = 'geocoder'): IntentNodeResolution {
  return {
    label: candidate.displayName,
    center: candidate.center,
    ...(candidate.bounds ? { bounds: candidate.bounds } : {}),
    featureType: candidate.entityType,
    ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
    source,
    candidateId: candidate.id,
    ...(candidate.timeZones[0] ? { timeZone: candidate.timeZones[0] } : {}),
  };
}

/**
 * Did the traveller write the country's own name, rather than a demonym
 * Sidequest inferred one from? Generic: it compares the phrase with the
 * country's published name and its aliases, and knows no place specifically.
 */
function countryNamedInPhrase(rawText: string, countryCode: string | undefined): boolean {
  if (!countryCode) return false;
  const facts = countryFacts(countryCode);
  if (!facts) return false;
  const names = [facts.name, ...((facts as { aliases?: readonly string[] }).aliases ?? [])];
  return names.some((name) => name.length > 2 && new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(rawText));
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
  const within = node.within && !new RegExp(`\\b${node.within.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(label) ? `, ${node.within}` : '';
  return country && !new RegExp(`\\b${country}\\b`, 'i').test(label) ? `${label}${within}, ${country}` : `${label}${within}`;
}

/**
 * Landscape words in the form a map carries them. Generic words, never a
 * place name: "the Canadian Rockies" is asked again as "Rocky Mountains,
 * Canada" because the nationality is a qualifier and "Rockies" is the
 * colloquial form of a landscape word.
 */
const LANDSCAPE_MAP_FORMS: Record<string, string> = {
  rockies: 'Rocky Mountains',
  dolomites: 'Dolomiti',
  pyrenees: 'Pyrénées',
  himalaya: 'Himalayas',
  alps: 'Alps',
  highlands: 'Highlands',
};

/** A second way to ask for a landscape part, or null when the first way was the only way. */
export function fallbackQueryFor(node: IntentNode): { query: string; label: string } | null {
  if (!isRegionKind(node.kind) || node.kind === 'country' || node.kind === 'vague_region') return null;
  const words = node.label.replace(/^(the)\s+/i, '').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !isDemonym(w.toLowerCase()));
  const mapped = kept.map((w) => LANDSCAPE_MAP_FORMS[w.toLowerCase()] ?? w);
  const label = mapped.join(' ').trim();
  const primary = node.label.replace(/^(the)\s+/i, '');
  if (!label || label.toLowerCase() === primary.toLowerCase()) return null;
  const country = node.countryCode ? countryFacts(node.countryCode)?.name : null;
  return { query: country && !new RegExp(`\\b${country}\\b`, 'i').test(label) ? `${label}, ${country}` : label, label };
}

/** The interpreter is worth asking for a part that is an area, or a bare name a geocoder read as several settlements in several countries. */
function interpretationWorthwhile(node: IntentNode, own: DestinationResolution | undefined, chosen: RankedCandidate | null): boolean {
  if (node.kind === 'country' || node.kind === 'vague_region' || node.kind === 'city' || node.kind === 'municipality' || node.kind === 'corridor') return false;
  if (isRegionKind(node.kind)) return !evidenceSufficient(node, chosen);
  /* A named place: the article says "a concept" ("the Sahara"); a spread of same-named places across countries says "ambiguous". */
  if (/^the\s+/i.test(node.label.trim()) && !evidenceSufficient(node, chosen)) return true;
  const countries = new Set((own?.candidates ?? []).map((c) => c.countryCode).filter(Boolean));
  if (countries.size > 1 && (!chosen || chosen.assessment.verdict !== 'compatible' || (own?.ambiguityReasons ?? []).includes('multiple_matching_places'))) return true;
  return false;
}

/**
 * Resolve every child that can be resolved. A country child is answered from
 * the reference at once and, while calls remain, asked of the resolver too so
 * its box reaches the envelope; a named or landscape child is asked once and
 * its rows are gated; a landscape part the gate could not settle is asked
 * once more in its map form; and a single region-like part still unsettled is
 * handed to the interpreter.
 */
export async function resolveIntentGraph(input: {
  graph: DestinationIntentGraph;
  resolver: DestinationResolver | null;
  now: Date;
  maxGeocoderCalls?: number;
  /** `undefined` uses the configured interpreter; `null` runs deterministic-only. */
  interpreter?: DestinationInterpreter | null;
}): Promise<GraphResolutionOutcome> {
  const resolutions = new Map<string, IntentNodeResolution>();
  const partResolutions = new Map<string, DestinationResolution>();
  const approved = new Map<string, RankedCandidate[]>();
  const refused: DestinationSemantics['refused'] = [];
  /** V10 §2 — first-level divisions a provider published for something that placed, by ISO 3166-2 code. */
  const subnational = new Map<string, { name: string; countryCode: string }>();
  const noteDivision = (candidate: DestinationCandidate): void => {
    if (!candidate.regionCode || !candidate.regionName || !candidate.countryCode) return;
    if (!subnational.has(candidate.regionCode)) subnational.set(candidate.regionCode, { name: candidate.regionName, countryCode: candidate.countryCode });
  };
  let calls = 0;
  const budget = input.maxGeocoderCalls ?? MAX_GEOCODER_CALLS;

  for (const child of input.graph.children) {
    const reference = referenceResolution(child);
    if (reference && child.kind === 'country') resolutions.set(child.id, reference);
  }

  /** V10 §15 — the wall time the slowest outstanding geocoder wave took, and the interpreter's own. */
  const clock = { geocoderMs: 0, interpreterMs: 0 };
  const startedMs = Date.now();
  const ask = async (query: string): Promise<DestinationResolution | null> => {
    if (!input.resolver) return null;
    calls += 1;
    const from = Date.now();
    try {
      return await input.resolver.resolve({ query, now: input.now });
    } catch {
      /* A provider that failed is not a place that does not exist; the part stays as it was. */
      return null;
    } finally {
      clock.geocoderMs = Math.max(clock.geocoderMs, Date.now() - from);
    }
  };

  /* Named parts first: they are the ones only a resolver can answer. Countries take what budget is left. */
  const order = [...input.graph.children].sort((a, b) => Number(a.kind === 'country') - Number(b.kind === 'country'));
  const leads = new Map<string, RankedCandidate | null>();
  for (const child of order) {
    if (!input.resolver || calls >= budget) break;
    if (child.kind === 'vague_region') continue; // "rural Japan" has no row anywhere; the country point is the honest anchor.
    let answer = await ask(resolverQueryFor(child));
    /* Asked inside the container the phrase named and found nothing there: ask for the part on its own, once. */
    if (child.within && (!answer || answer.candidates.length === 0) && calls < budget) answer = await ask(resolverQueryFor({ ...child, within: undefined }));
    if (!answer) continue;
    partResolutions.set(child.id, answer);
    if (child.kind === 'country') {
      /* A country asked of the resolver must come back as one; a town sharing the name is not the country. */
      const leading = answer.candidates.find((c) => c.id === answer.unambiguousCandidateId) ?? answer.candidates[0];
      if (leading && leading.entityType === 'country' && (!child.countryCode || !leading.countryCode || leading.countryCode === child.countryCode)) resolutions.set(child.id, resolutionFromCandidate(leading));
      continue;
    }
    let ranked = rankCandidates(child, answer.candidates);
    for (const r of ranked) if (r.assessment.verdict === 'incompatible') refused.push({ label: r.candidate.displayName, reason: r.assessment.reasons[r.assessment.reasons.length - 1] ?? 'incompatible' });
    let chosen = ranked.find((r) => r.assessment.verdict !== 'incompatible') ?? null;
    /* One more way to ask for a landscape: its map form, without the nationality. */
    if (!evidenceSufficient(child, chosen) && calls < budget) {
      const fallback = fallbackQueryFor(child);
      if (fallback) {
        const again = await ask(fallback.query);
        if (again) {
          const rankedAgain = rankCandidates({ ...child, label: fallback.label }, again.candidates);
          for (const r of rankedAgain) if (r.assessment.verdict === 'incompatible') refused.push({ label: r.candidate.displayName, reason: r.assessment.reasons[r.assessment.reasons.length - 1] ?? 'incompatible' });
          const better = rankedAgain.find((r) => r.assessment.verdict !== 'incompatible') ?? null;
          if (better && (!chosen || better.score > chosen.score)) {
            chosen = better;
            ranked = [...rankedAgain.filter((r) => r.assessment.verdict !== 'incompatible'), ...ranked.filter((r) => r.assessment.verdict !== 'incompatible')];
            partResolutions.set(child.id, { ...again, candidates: [...again.candidates, ...answer.candidates] });
          }
        }
      }
    }
    approved.set(
      child.id,
      ranked.filter((r) => r.assessment.verdict !== 'incompatible'),
    );
    leads.set(child.id, chosen);
    if (chosen && (evidenceSufficient(child, chosen) || chosen.assessment.verdict === 'compatible')) {
      resolutions.set(child.id, resolutionFromCandidate(chosen.candidate));
      noteDivision(chosen.candidate);
    }
  }

  /*
   * V1 — "A, B" WHERE B IS ONLY WHERE A IS.
   *
   * "Moab, Utah", "Brooklyn, New York": two comma parts are a list only when
   * they are two places. When the first placed inside the second's published
   * extent and the second is plainly the larger area, the second is the
   * address, not a second destination — and the union of the two made a town
   * trip a state-wide region. Decided by placement, never by the names: "Tokyo,
   * Kyoto" stays two cities because neither sits inside the other.
   */
  let working = input.graph;
  const containment = containedPart(input.graph, resolutions);
  if (containment) {
    const { place, container } = containment;
    working = { ...input.graph, children: [{ ...place, within: container.label }], relationship: 'single' };
    resolutions.delete(container.id);
    leads.delete(container.id);
  }

  /* --- the world-model tier, for one region-like part the evidence could not settle --------------- */
  let interpretation: GraphResolutionOutcome['interpretation'] = null;
  const conceptParts: SemanticPart[] = [];
  const conceptGateways: SemanticGateway[] = [];
  let concept: InterpretedConcept | null = null;
  const only = working.children.length === 1 ? working.children[0]! : null;
  if (only && input.interpreter !== null && interpretationWorthwhile(only, partResolutions.get(only.id), leads.get(only.id) ?? null)) {
    const evidence = (partResolutions.get(only.id)?.candidates ?? []).slice(0, 5).map((c) => `${c.displayName} (${c.providerClass?.category ?? c.entityType}${c.countryCode ? `, ${c.countryCode}` : ''})`);
    const interpreterStartedMs = Date.now();
    const outcome = await interpretDestinationConcept({ text: working.rawText, graph: working, evidence, ...(input.interpreter !== undefined ? { interpreter: input.interpreter } : {}) });
    clock.interpreterMs = Date.now() - interpreterStartedMs;
    interpretation = { concept: outcome.concept, source: outcome.source, modelCalls: outcome.modelCalls };
    concept = outcome.concept && outcome.concept.isPlace ? outcome.concept : null;
    if (concept) {
      const expectation = { type: concept.type, countries: concept.countries };
      /* The rows already in hand, re-read with the concept's expectation: a same-named town in the wrong country is now refused for a reason. */
      const own = partResolutions.get(only.id);
      const reRanked = own ? rankCandidates(only, own.candidates, expectation) : [];
      const settled = reRanked.find((r) => r.assessment.verdict === 'compatible' && evidenceSufficient(only, r)) ?? null;
      if (settled) {
        resolutions.set(only.id, resolutionFromCandidate(settled.candidate));
        noteDivision(settled.candidate);
      }
      approved.set(only.id, reRanked.filter((r) => r.assessment.verdict !== 'incompatible'));

      /*
       * Names → evidence: each area and gateway is geocoded and gated.
       *
       * V10 §15 — IN PARALLEL. These are six independent questions about six
       * different names, and asking them one `await` at a time made the setup
       * screen wait for the sum of six round trips before it could frame a map.
       * Nothing here depends on anything else here; the only shared state is the
       * call budget, which is allocated before the requests rather than counted
       * during them.
       */
      const single = concept.countries.length === 1 ? countryFacts(concept.countries[0]!) : null;
      const qualify = (name: string) => (single && !new RegExp(`\\b${single.name}\\b`, 'i').test(name) ? `${name}, ${single.name}` : name);
      const areaNames = input.resolver ? concept.representativeAreas.slice(0, MAX_INTERPRETATION_CALLS - 2) : [];
      const gatewayNames = input.resolver ? concept.gateways.slice(0, 2) : [];
      const [areaAnswers, gatewayAnswers] = await Promise.all([
        Promise.all(areaNames.map((area) => ask(qualify(area)))),
        Promise.all(gatewayNames.map((gateway) => ask(gateway))),
      ]);
      for (const [index, area] of areaNames.entries()) {
        const answer = areaAnswers[index];
        if (!answer) continue;
        const ranked = rankCandidates({ kind: 'named_place', label: area, ...(single ? { countryCode: single.code } : {}) }, answer.candidates, { countries: concept.countries });
        const hit = ranked.find((r) => r.assessment.verdict !== 'incompatible' && !r.assessment.semantics.pointLike);
        if (!hit) continue;
        noteDivision(hit.candidate);
        conceptParts.push({ label: hit.candidate.displayName, center: hit.candidate.center, ...(hit.candidate.bounds && hit.assessment.semantics.hasExtent ? { bounds: hit.candidate.bounds } : {}), source: 'geocoder', featureType: hit.candidate.entityType, ...(hit.candidate.countryCode ? { countryCode: hit.candidate.countryCode } : {}) });
      }
      for (const [index, gateway] of gatewayNames.entries()) {
        const answer = gatewayAnswers[index];
        const ranked = answer ? rankCandidates({ kind: 'city', label: gateway }, answer.candidates, { countries: concept.countries.length > 0 ? concept.countries : undefined }) : [];
        const hit = ranked.find((r) => r.assessment.verdict === 'compatible' && r.assessment.semantics.type === 'settlement');
        conceptGateways.push(hit ? { label: hit.candidate.displayName, center: hit.candidate.center, ...(hit.candidate.countryCode ? { countryCode: hit.candidate.countryCode } : {}), source: 'geocoder' } : { label: gateway, source: 'interpretation' });
      }
      for (const gateway of concept.gateways.slice(2)) conceptGateways.push({ label: gateway, source: 'interpretation' });

      /*
       * The concept outranks an unsettled lead: a same-named village, or a
       * range node with no extent, was only ever a lead. When the concept's
       * own expectation settled one of the rows (`settled`), that row stands;
       * otherwise the areas the interpreter named and the geocoder placed are
       * the destination's evidence, and a lead is kept only as a centre of
       * last resort.
       */
      if (!settled) {
        const extent = conceptParts.length > 0 ? extentOfParts(conceptParts) : null;
        const lead = leads.get(only.id)?.candidate ?? null;
        const centre = extent?.center ?? (lead && !REGION_TYPE_SET.has(concept.type) ? lead.center : null) ?? (lead && lead.entityType === 'natural_region' ? lead.center : null);
        if (centre) {
          resolutions.set(only.id, {
            label: working.travellerLabel,
            center: centre,
            ...(extent && conceptParts.length >= 2 ? { bounds: extent.bounds } : {}),
            featureType: entityTypeOfSemantic(concept.type, concept.countries.length),
            ...(single ? { countryCode: single.code } : {}),
            source: 'interpretation',
          });
        }
      }
    }
  }

  /*
   * V10 §2 — THE COUNTRY REFERENCE IS A STAND-IN, NOT AN IDENTITY.
   *
   * Filling an unresolved part from its containing country is right for a
   * *country* part and catastrophic for a *region* part: "the Canadian
   * Rockies" came out of here as Canada, typed `country` at `country` scale
   * with `high` confidence, centred on Canada's published point in the east.
   * The point may still stand in — something has to anchor a weather lookup —
   * but which parts are standing in is recorded, so the concept keeps the
   * phrase's own meaning and every consumer can read the centre for what it is.
   */
  const standIns = new Set<string>();
  for (const child of working.children) {
    if (resolutions.has(child.id)) continue;
    const reference = referenceResolution(child);
    if (!reference) continue;
    resolutions.set(child.id, reference);
    /*
     * V10 §2 — WHOSE COUNTRY IS IT?
     *
     * Filling a part from its containing country is honest exactly when the
     * traveller *named* that country. "rural Japan", "northern Italy" and "the
     * steppes of Kyrgyzstan" all put the country in the phrase: nobody publishes
     * an extent for any of them, the country is the frame the traveller asked
     * for, and the country's point is its own anchor.
     *
     * "the Canadian Rockies" and "the Scottish Highlands" do not. Their country
     * came from a demonym Sidequest read, and adopting its point produced a
     * country-wide map centred on a city a thousand miles from the destination.
     * That is a stand-in, and it is recorded as one.
     */
    if (child.kind === 'country' || countryNamedInPhrase(working.rawText, child.countryCode)) continue;
    standIns.add(child.id);
  }
  let graph = attachIntentResolutions(working, resolutions);
  if (concept && concept.countries.length > 0 && only) {
    /* The concept's countries are the phrase's countries: "the Alps" spans six, whatever the one row said. */
    const countries = [...new Set([...graph.countries, ...concept.countries])];
    graph = { ...graph, countries, crossBorder: countries.length > 1 };
  }
  const semantics = semanticsFor({ graph, leads, concept, parts: conceptParts, gateways: conceptGateways, refused, interpretationSource: interpretation?.source ?? null, standIns, subnational });
  return {
    graph,
    partResolutions,
    geocoderCalls: calls,
    semantics,
    approved,
    interpretation,
    timings: { totalMs: Date.now() - startedMs, geocoderMs: clock.geocoderMs, interpreterMs: clock.interpreterMs, geocoderCalls: calls, cacheHit: false },
  };
}


/** The place and its container, when a two-part comma phrase names a place and the area it sits in. */
function containedPart(graph: DestinationIntentGraph, resolutions: ReadonlyMap<string, IntentNodeResolution>): { place: IntentNode; container: IntentNode } | null {
  if (graph.children.length !== 2 || graph.relationship === 'corridor' || !/^[^,]+,\s*[^,]+$/.test(graph.rawText) || /\band\b/i.test(graph.rawText)) return null;
  const [place, container] = graph.children as [IntentNode, IntentNode];
  const a = resolutions.get(place.id);
  const b = resolutions.get(container.id);
  if (!a || !b?.bounds || a.source === 'reference') return null;
  /* A city container is judged by its travel area, not its administrative box: a metropolis whose boundary reaches distant islands does not contain every town under that box. */
  const urbanType = b.featureType === 'municipality' ? 'city_region' : b.featureType && ['city', 'town', 'village', 'settlement', 'hamlet'].includes(b.featureType) ? 'settlement' : null;
  const containerBox = urbanType ? travelExtentFor({ type: urbanType, center: b.center, bounds: b.bounds }).bounds : b.bounds;
  const { southWest: sw, northEast: ne } = containerBox;
  const inside = a.center.lat >= sw.lat && a.center.lat <= ne.lat && a.center.lng >= sw.lng && a.center.lng <= ne.lng;
  if (!inside) return null;
  const area = (box: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } }) => Math.max(1e-9, (box.northEast.lat - box.southWest.lat) * (box.northEast.lng - box.southWest.lng));
  /* The container must be plainly the larger area; two overlapping neighbours of similar size are a list. */
  if (a.bounds && area(containerBox) < 4 * area(a.bounds)) return null;
  return { place, container };
}

// ---------------------------------------------------------------------------
// The semantic record
// ---------------------------------------------------------------------------

function entityTypeOfSemantic(type: GeographicSemanticType, countries: number): DestinationCandidate['entityType'] {
  switch (type) {
    case 'mountain_region':
    case 'natural_region':
    case 'coast':
      return 'natural_region';
    case 'island_group':
      return 'archipelago';
    case 'island':
      return 'island';
    case 'protected_area':
      return 'protected_area';
    case 'admin_area':
    case 'informal_region':
      return countries > 1 ? 'multi_country' : 'subregion';
    case 'country':
      return 'country';
    case 'multi_country':
      return 'multi_country';
    case 'settlement':
      return 'city';
    case 'city_region':
      return 'municipality';
    case 'corridor':
      return 'route_or_corridor';
    case 'landmark':
      return 'point_of_interest';
    default:
      return 'unknown';
  }
}

function breadthOfScale(scale: GeographicScale, countries: number): DestinationCandidate['breadth'] {
  if (countries > 1 && (scale === 'country' || scale === 'continental' || scale === 'region')) return 'multi_country';
  switch (scale) {
    case 'point':
    case 'neighbourhood':
      return 'local';
    case 'settlement':
      return 'city';
    case 'district':
      return 'subregion';
    case 'subregion':
    case 'region':
      return 'region';
    default:
      return 'country';
  }
}

function semanticsFor(input: {
  graph: DestinationIntentGraph;
  leads: Map<string, RankedCandidate | null>;
  concept: InterpretedConcept | null;
  parts: SemanticPart[];
  gateways: SemanticGateway[];
  refused: DestinationSemantics['refused'];
  interpretationSource: string | null;
  /** V10 §2 — child ids whose only resolution is the containing country's point, standing in. */
  standIns: ReadonlySet<string>;
  /** V10 §2 — first-level divisions a provider named, by ISO 3166-2 code. */
  subnational: Map<string, { name: string; countryCode: string }>;
}): DestinationSemantics {
  const { graph, concept } = input;
  const only = graph.children.length === 1 ? graph.children[0]! : null;
  const evidence: DestinationSemantics['evidence'] = [{ source: 'traveller', note: `You wrote "${graph.rawText}".` }];
  const resolvedParts: SemanticPart[] = graph.children
    .filter((c) => c.resolution && c.resolution.source !== 'interpretation')
    .map((c) => ({ label: c.resolution!.label, center: c.resolution!.center, ...(c.resolution!.bounds ? { bounds: c.resolution!.bounds } : {}), source: c.resolution!.source === 'reference' ? 'reference' : c.resolution!.source === 'index' ? 'index' : 'geocoder', ...(c.resolution!.featureType ? { featureType: c.resolution!.featureType } : {}), ...(c.resolution!.countryCode ? { countryCode: c.resolution!.countryCode } : {}) }));

  let type: GeographicSemanticType;
  let scale: GeographicScale;
  let center: DestinationSemantics['center'];
  let centerBasis: CenterBasis = 'none';
  let extent: DestinationSemantics['extent'];
  let confidence: DestinationSemantics['confidence'];
  let parts: SemanticPart[] = [];
  let travelExtent: TravelExtent | undefined;

  if (!only) {
    /* A composite: several parts, the union of what placed. */
    type = graph.crossBorder ? 'multi_country' : graph.children.every((c) => c.kind === 'country') ? 'country' : 'informal_region';
    parts = resolvedParts;
    /*
     * V1 — the union of the parts' travel areas, not their administrative boxes:
     * "Tokyo, Kyoto" is two cities, and Tokyo's boundary out to its remote
     * islands made the pair a 2,500 km "country-scale" region.
     */
    const urbanTypeOf = (featureType: string | undefined) => (featureType === 'municipality' ? 'city_region' : featureType && ['city', 'town', 'village', 'settlement', 'hamlet'].includes(featureType) ? 'settlement' : null);
    const travelParts = graph.children
      .filter((c) => c.resolution && c.resolution.source !== 'interpretation')
      .map((c) => {
        const r = c.resolution!;
        const urban = urbanTypeOf(r.featureType);
        const population = input.leads.get(c.id)?.candidate.providerClass?.population;
        return { center: r.center, ...(r.bounds ? { bounds: urban ? travelExtentFor({ type: urban, center: r.center, bounds: r.bounds, ...(population ? { population } : {}) }).bounds : r.bounds } : {}) };
      });
    const box = travelParts.length > 0 ? envelopeOf(travelParts) : graph.envelope;
    center = box?.center;
    centerBasis = center ? 'union_of_parts' : 'none';
    extent = box?.bounds ? { bounds: box.bounds, source: 'union_of_parts' } : undefined;
    scale = extent ? scaleOfDiagonalKm(diagonalKm(extent.bounds)) : graph.crossBorder ? 'country' : 'region';
    confidence = graph.confidence;
    evidence.push({ source: 'composite', note: `${parts.length} of ${graph.children.length} parts placed.` });
  } else if (only.resolution?.source === 'interpretation' && concept) {
    type = concept.type;
    scale = concept.scale;
    center = only.resolution.center;
    centerBasis = 'interpreted_parts';
    extent = only.resolution.bounds ? { bounds: only.resolution.bounds, source: 'interpreted_parts' } : undefined;
    parts = input.parts;
    confidence = parts.length >= 2 ? 'medium' : 'low';
    evidence.push({ source: 'interpretation', note: concept.note || `Read as ${concept.type.replace(/_/g, ' ')} at ${concept.scale} scale.` });
    if (parts.length > 0) evidence.push({ source: 'geocoder', note: `${parts.length} named ${parts.length === 1 ? 'area' : 'areas'} inside it placed by the map source.` });
  } else if (only.resolution) {
    const lead = input.leads.get(only.id) ?? null;
    const sem = lead?.assessment.semantics;
    /*
     * V10 §2 — A COUNTRY STAND-IN IS NOT A COUNTRY DESTINATION.
     *
     * `standIn` means nothing placed this part and the loop above filled it
     * from the containing country's published point. Before V10 that made the
     * concept a country at country scale with `high` confidence, so "the
     * Canadian Rockies" became Canada centred in Ontario and the canvas framed
     * 800 km around it. The point may still anchor a climate lookup, but the
     * *identity* stays the phrase's own — and the confidence and the centre's
     * basis both say plainly that nobody has placed this yet.
     */
    const standIn = input.standIns.has(only.id);
    const phraseType = only.kind === 'vague_region' ? 'informal_region' : semanticTypeOfKind(only.kind);
    /*
     * A part answered only by the country reference keeps the phrase's own
     * meaning unless the phrase *is* a country. "the steppes of Kyrgyzstan" is
     * steppe, anchored at Kyrgyzstan; it is not Kyrgyzstan. Whether the country
     * was named or inferred changes the confidence and the centre's basis — not
     * what kind of thing the traveller asked for.
     */
    const referenceOnly = only.resolution.source === 'reference' && only.kind !== 'country';
    type = concept?.type ?? (standIn || referenceOnly ? phraseType : only.resolution.source === 'reference' ? 'country' : sem?.type ?? semanticTypeOfKind(only.kind));
    /* The phrase's own shape wins over a row's class for the kind of thing: a mountain range answered by a region row is still mountain country. */
    if (isRegionKind(only.kind) && only.kind !== 'admin_region' && only.kind !== 'country' && (type === 'admin_area' || type === 'protected_area' || type === 'natural_region') && semanticTypeOfKind(only.kind) !== 'informal_region') type = semanticTypeOfKind(only.kind);
    /*
     * V1 — the canonical extent stays the published one; the travel extent is
     * the area planning treats as the destination (a metropolis whose boundary
     * reaches remote islands is planned around the city). Scale reads the
     * travel extent, so a city never reports itself at country scale.
     */
    if (!standIn && only.resolution.bounds && (sem?.hasExtent ?? true) && only.resolution.source !== 'reference') {
      const population = lead?.candidate.providerClass?.population;
      travelExtent = travelExtentFor({ type, center: only.resolution.center, bounds: only.resolution.bounds, ...(population ? { population } : {}) });
    }
    const km = travelExtent ? diagonalKm(travelExtent.bounds) : only.resolution.bounds ? diagonalKm(only.resolution.bounds) : null;
    scale =
      standIn || referenceOnly
        ? scaleOfPhrase(only.kind, concept?.scale)
        : only.resolution.source === 'reference'
          ? 'country'
          : sem?.hasExtent && km !== null
            ? scaleOfDiagonalKm(km)
            : concept?.scale ?? (sem?.scale ?? 'settlement');
    center = only.resolution.center;
    centerBasis = standIn
      ? 'country_reference'
      : only.resolution.source === 'reference'
        ? 'country_qualified'
        : only.resolution.bounds && (sem?.hasExtent ?? true)
          ? 'published'
          : 'lead_row';
    extent = !standIn && only.resolution.bounds && (sem?.hasExtent ?? true) ? { bounds: only.resolution.bounds, source: 'published' } : undefined;
    parts = standIn ? [] : resolvedParts;
    confidence = standIn ? 'low' : only.resolution.source === 'reference' ? 'high' : lead?.assessment.verdict === 'compatible' ? (lead.candidate.confidence.level === 'high' ? 'high' : 'medium') : 'low';
    if (standIn) {
      const countryName = only.countryCode ? countryFacts(only.countryCode)?.name ?? null : null;
      evidence.push({ source: 'traveller', note: `Nothing has placed ${graph.travellerLabel} yet${countryName ? `; the plan is anchored loosely in ${countryName} until something does` : ''}.` });
    } else {
      evidence.push({ source: only.resolution.source === 'reference' ? 'reference' : 'geocoder', note: `${only.resolution.label}${only.resolution.featureType ? ` (${only.resolution.featureType.replace(/_/g, ' ')})` : ''}${extent ? ', with a published extent' : ''}.` });
    }
    if (concept) evidence.push({ source: 'interpretation', note: concept.note || `Read as ${concept.type.replace(/_/g, ' ')}.` });
  } else {
    type = concept?.type ?? semanticTypeOfKind(only.kind);
    scale = concept?.scale ?? (isRegionKind(only.kind) ? 'region' : 'settlement');
    /* `centerBasis` is already `none`: nothing placed this, so there is no centre to describe. */
    confidence = 'low';
    if (concept) evidence.push({ source: 'interpretation', note: concept.note || `Read as ${concept.type.replace(/_/g, ' ')}; nothing placed it yet.` });
    else evidence.push({ source: 'traveller', note: 'Nothing has placed this yet; the plan starts from your words.' });
  }

  scale = coherentScale(type, scale);
  if (travelExtent?.basis === 'urban_core' && travelExtent.reason) evidence.push({ source: 'geocoder', note: travelExtent.reason });
  const countries = concept && concept.countries.length > 0 ? [...new Set([...graph.countries, ...concept.countries])] : graph.countries;
  const label = only?.resolution && only.resolution.source !== 'interpretation' && only.resolution.source !== 'reference' && !isRegionKind(only.kind) ? only.resolution.label : graph.travellerLabel;
  return destinationConceptSchema.parse({
    version: DESTINATION_SEMANTICS_VERSION,
    rawText: graph.rawText,
    label,
    type,
    scale,
    countries,
    regions: concept?.regions ?? [],
    ...(only?.landscape || concept?.landscape ? { landscape: only?.landscape ?? concept?.landscape } : {}),
    ...(travelExtent && travelExtent.basis === 'urban_core' ? { travelExtent } : {}),
    ...(center ? { center } : {}),
    centerBasis,
    ...(extent ? { extent } : {}),
    confidence,
    evidence,
    ambiguities: [...graph.ambiguities, ...(concept?.ambiguity && concept.ambiguity !== 'none' ? [concept.ambiguity] : [])],
    parts,
    gateways: input.gateways,
    refused: input.refused.slice(0, 8),
    jurisdictions: jurisdictionsFor(countries, input.subnational),
  });
}

/**
 * The scale a phrase implies when nothing has placed it. Deliberately never
 * `country` for a part that is not a country: a mountain region nobody located
 * is still a region, and `country` here is what framed a whole nation.
 */
function scaleOfPhrase(kind: IntentNode['kind'], interpreted: GeographicScale | undefined): GeographicScale {
  if (interpreted && interpreted !== 'country' && interpreted !== 'continental') return interpreted;
  if (kind === 'city' || kind === 'named_place') return 'settlement';
  if (kind === 'municipality') return 'district';
  return 'region';
}

/**
 * V10 §2 — the jurisdictions, assembled independently of the destination.
 *
 * Country rows come from the countries the phrase resolved to; subnational rows
 * only from ISO 3166-2 codes a provider actually published for something that
 * placed. Nothing is inferred: a region with no provider row contributes no
 * province, and the product then says nothing about provinces rather than
 * guessing at one.
 */
function jurisdictionsFor(countries: readonly string[], subnational: Map<string, { name: string; countryCode: string }>): JurisdictionRef[] {
  const rows: JurisdictionRef[] = [];
  for (const code of countries) {
    const facts = countryFacts(code);
    rows.push({ level: 'country', code, name: facts?.name ?? code, countryCode: code });
  }
  const seen = new Set(rows.map((r) => r.code));
  for (const [code, row] of subnational) {
    if (seen.has(code)) continue;
    if (countries.length > 0 && !countries.includes(row.countryCode)) continue;
    seen.add(code);
    rows.push({ level: 'subnational', code, name: row.name, countryCode: row.countryCode });
  }
  return rows.slice(0, 12);
}

// ---------------------------------------------------------------------------
// The resolution every consumer reads
// ---------------------------------------------------------------------------

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
 * V8.1 — the one candidate an interpreted concept becomes. Its identity is the
 * traveller's phrase; its centre and box are the evidence the interpreter's
 * names produced; its type is the concept's; its confidence says how many
 * areas actually placed.
 */
export function conceptCandidateFor(outcome: GraphResolutionOutcome): DestinationCandidate | null {
  const only = outcome.graph.children.length === 1 ? outcome.graph.children[0]! : null;
  const concept = outcome.interpretation?.concept;
  if (!only || !only.resolution || only.resolution.source !== 'interpretation' || !concept) return null;
  const semantics = outcome.semantics;
  const single = semantics.countries.length === 1 ? semantics.countries[0]! : undefined;
  const signals: ConfidenceSignal[] = ['model_inference_only'];
  if (semantics.parts.length >= 2) signals.push('name_match_partial', 'administrative_hierarchy_match');
  signals.push(semantics.extent ? 'boundary_available' : 'no_boundary_available');
  const level = semantics.parts.length >= 2 ? 'medium' : 'low';
  return {
    id: `concept:${slugOf(outcome.graph.rawText)}`,
    displayName: outcome.graph.travellerLabel,
    qualifiedName: [outcome.graph.travellerLabel, ...semantics.countries.map((code) => countryFacts(code)?.name ?? code)].join(', '),
    entityType: entityTypeOfSemantic(concept.type, semantics.countries.length),
    breadth: breadthOfScale(semantics.scale, semantics.countries.length),
    center: only.resolution.center,
    ...(only.resolution.bounds ? { bounds: only.resolution.bounds } : {}),
    ...(single ? { countryCode: single, countryName: countryFacts(single)?.name ?? single } : {}),
    aliases: [],
    administrativeAreas: [...semantics.regions, ...semantics.countries.map((code) => countryFacts(code)?.name ?? code)],
    timeZones: [],
    providerRefs: [],
    confidence: { level, signals, note: level === 'medium' ? `Read as ${concept.type.replace(/_/g, ' ')}; ${semantics.parts.length} areas inside it were placed by the map source.` : `Read as ${concept.type.replace(/_/g, ' ')}; the map source placed little inside it yet.` },
    note: concept.note || describeIntentGraph(outcome.graph, (code) => countryFacts(code)?.name ?? null),
  };
}

/**
 * One `DestinationResolution` for the whole phrase, from the graph. A composite
 * candidate leads when the graph earned one; a single part the gate settled
 * passes the *approved* rows through (never the refused ones, so no screen
 * lists a shop as a reading of a mountain range); an interpreted concept is
 * one synthetic candidate; a graph nothing could place returns an honest
 * empty list with no reason that could refuse the trip.
 */
export function resolutionForGraph(outcome: GraphResolutionOutcome, query: string, now: Date, providersConsulted: readonly string[]): DestinationResolution {
  const { graph } = outcome;
  const base: Omit<DestinationResolution, 'candidates' | 'ambiguityReasons'> = { schemaVersion: DESTINATION_RESOLUTION_VERSION, query, normalizedQuery: normalizeDestinationQuery(query), providersConsulted: [...providersConsulted], resolvedAt: now.toISOString() };
  if (!graphNeedsComposite(graph)) {
    const only = graph.children[0]!;
    const concept = conceptCandidateFor(outcome);
    if (concept) {
      const ambiguityReasons: DestinationResolution['ambiguityReasons'] = concept.bounds ? [] : ['no_boundary_available'];
      return { ...base, candidates: [concept], ambiguityReasons, unambiguousCandidateId: concept.id };
    }
    const own = outcome.partResolutions.get(only.id);
    /* A resolver that says the words are not a place at all (the research path's explicit reading) is passed through: the gate has nothing to weigh. */
    if (own && own.ambiguityReasons.includes('query_is_not_a_place')) return own;
    const approved = outcome.approved.get(only.id) ?? [];
    if (own && approved.length > 0) {
      const candidates = approved.map((r) => r.candidate);
      const leading = candidates[0]!;
      const identityDoubt = candidates.length > 1 && (own.ambiguityReasons.includes('multiple_matching_places') || own.ambiguityReasons.includes('providers_disagree'));
      const ambiguityReasons: DestinationResolution['ambiguityReasons'] = [];
      if (identityDoubt) ambiguityReasons.push('multiple_matching_places');
      if (leading.breadth === 'country' || leading.breadth === 'multi_country') ambiguityReasons.push('administrative_area_needs_subset');
      if (!leading.bounds) ambiguityReasons.push('no_boundary_available');
      const unambiguous = candidates.length === 1 || approved[0]!.assessment.verdict === 'compatible' && approved.slice(1).every((r) => r.assessment.verdict === 'weak');
      return { ...base, candidates, ambiguityReasons, ...(unambiguous ? { unambiguousCandidateId: leading.id } : {}) };
    }
    /* The resolver drew a blank, or every row was refused; a country in the phrase still places it. */
    const composite = compositeCandidateFor(graph);
    const ambiguityReasons: DestinationResolution['ambiguityReasons'] = composite && !composite.bounds ? ['no_boundary_available'] : [];
    return { ...base, candidates: composite ? [composite] : [], ambiguityReasons, ...(composite ? { unambiguousCandidateId: composite.id } : {}) };
  }
  const composite = compositeCandidateFor(graph);
  const ambiguityReasons: DestinationResolution['ambiguityReasons'] = [];
  if (composite && !composite.bounds) ambiguityReasons.push('no_boundary_available');
  if (composite && (composite.breadth === 'country' || composite.breadth === 'multi_country')) ambiguityReasons.push('administrative_area_needs_subset');
  return { ...base, candidates: composite ? [composite] : [], ambiguityReasons, ...(composite ? { unambiguousCandidateId: composite.id } : {}) };
}

/** Parse and resolve in one call — what both doors need. */
/**
 * V10 §15 — THE CANONICAL CONCEPT, CACHED.
 *
 * Resolving a phrase costs up to nine geocoder round trips and, for a
 * region-like phrase, one bounded interpreter call. The *answer* is a fact about
 * a phrase and does not change week to week, so it is cached for the coordinate
 * TTL and a second traveller typing the same words gets it for nothing.
 *
 * Injected as a seam rather than reached for, so this module stays free of the
 * database and the corpus can run without one. A cache miss is silent; a cached
 * concept that no longer parses is ignored rather than trusted.
 */
export interface CachedConcept {
  concept: DestinationConcept;
  /**
   * The `DestinationResolution` the same pass produced.
   *
   * Cached *with* the concept rather than rebuilt from it, and that is the whole
   * point: the two doors do different things with the resolution — the plan door
   * reads `unambiguousCandidateId` to record the traveller's selected destination
   * — and a resolution reconstructed from the concept alone has no candidates, so
   * a cache hit silently stopped a destination from being selected and the flow
   * stalled on the screen before the interview. Restoring both is the only
   * faithful hit.
   */
  resolution: DestinationResolution;
}

export interface ConceptCache {
  read(key: string): CachedConcept | null;
  write(key: string, value: CachedConcept): void;
}

/**
 * Bumped whenever the *reading* changes without the stored shape changing, so a
 * thirty-day concept cached under the old reading is not served. 2: "Place,
 * Country" is one place (no longer the place plus the whole country), and a
 * state whose settlement answer is itself stays a state (V1, 2026-10-06).
 * 3: a city's travel extent and a type-coherent scale (V1 correctness wave).
 */
const CONCEPT_CACHE_EPOCH = 3;

/** The cache key: the phrase, normalised, plus the resolution and semantics versions so a shape change invalidates everything. */
export function conceptCacheKeyFor(text: string): string {
  return `destination-concept|v${DESTINATION_SEMANTICS_VERSION}.${DESTINATION_RESOLUTION_VERSION}.e${CONCEPT_CACHE_EPOCH}|${normalizeDestinationQuery(text)}`;
}

export async function resolveDestinationPhrase(input: { text: string; resolver: DestinationResolver | null; now: Date; maxGeocoderCalls?: number; interpreter?: DestinationInterpreter | null; cache?: ConceptCache }): Promise<{ outcome: GraphResolutionOutcome; resolution: DestinationResolution; semantics: DestinationSemantics }> {
  const graph = parseDestinationIntent(input.text);
  const cacheKey = conceptCacheKeyFor(input.text);
  const cached = input.cache?.read(cacheKey) ?? null;
  if (cached) {
    /*
     * A hit restores the concept *and* the resolution the same pass produced. The
     * graph is re-parsed (pure and instant) so every consumer still gets the same
     * shape; nothing is asked of a provider.
     */
    const concept = cached.concept;
    const outcome: GraphResolutionOutcome = {
      graph: { ...graph, countries: concept.countries.length > 0 ? concept.countries : graph.countries, crossBorder: concept.countries.length > 1 },
      partResolutions: new Map(),
      geocoderCalls: 0,
      semantics: concept,
      approved: new Map(),
      interpretation: null,
      timings: { totalMs: 0, geocoderMs: 0, interpreterMs: 0, geocoderCalls: 0, cacheHit: true },
    };
    return { outcome, resolution: cached.resolution, semantics: concept };
  }
  const outcome = await resolveIntentGraph({ graph, resolver: input.resolver, now: input.now, ...(input.maxGeocoderCalls !== undefined ? { maxGeocoderCalls: input.maxGeocoderCalls } : {}), ...(input.interpreter !== undefined ? { interpreter: input.interpreter } : {}) });
  /*
   * Only a concept worth keeping is kept. A `low` confidence answer, or one whose
   * centre is only the containing country's point standing in, is exactly the
   * answer a retry might improve — caching it for thirty days would freeze the
   * failure the V10 audit found.
   */
  const consulted = [...new Set([...(outcome.geocoderCalls > 0 && input.resolver ? [input.resolver.name] : []), ...(outcome.graph.countries.length > 0 ? ['country-reference'] : []), ...(outcome.interpretation && (outcome.interpretation.source === 'anthropic' || outcome.interpretation.source === 'cache' || outcome.interpretation.source === 'fixture') ? ['destination-interpreter'] : [])])];
  const resolution = resolutionForGraph(outcome, input.text, input.now, consulted);
  if (input.cache && outcome.semantics.confidence !== 'low' && !centreIsStandIn(outcome.semantics.centerBasis)) input.cache.write(cacheKey, { concept: outcome.semantics, resolution });
  return { outcome, resolution, semantics: outcome.semantics };
}
