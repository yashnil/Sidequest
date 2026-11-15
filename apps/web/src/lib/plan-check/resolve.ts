import { centreIsStandIn, countriesInText, countryFacts, foldForMatch, type DestinationIndexEntry, type GeographicSemanticType, type IntentNodeKind, type ParsedPlanStop } from '@sidequest/core';
import type { DestinationResolver } from '@sidequest/compiler';
import { resolveDestinationPhrase, type ConceptCache } from '../destinations/intent-resolution';

/**
 * "I ALREADY HAVE A PLAN" — EVERY STOP PUT ON THE MAP, THROUGH THE SAME GATE.
 *
 * Each place the traveller named is placed exactly as the setup door places a
 * destination: the local index when this deployment has one (an exact, unique
 * name only), then the intent graph resolved through the semantic gate with
 * the configured geocoder (`resolveDestinationPhrase`). A business, a road or
 * the wrong country never stands for a stop; a centre that is only the
 * country's point standing in is "not placed", never a guess.
 *
 * **No model.** The interpreter is passed as `null`: a rough plan is a list of
 * towns and regions a gazetteer answers, and spending a bounded model call per
 * stop would put several on one button. A stop the deterministic tiers cannot
 * place stays unplaced and the critique says "not checked" (unknown ≠ false).
 *
 * **Country context.** A country named beside the list ("…, Japan"), or the
 * one most stops already resolved into, qualifies the lookup of every stop
 * that does not name its own — "Kyoto, Japan" rather than whichever Kyoto the
 * geocoder ranks first. That is a reading of the plan's own words and
 * results, never a place known by name.
 */

export interface PlacedPlanStop {
  label: string;
  placedName: string | null;
  point: { lat: number; lng: number } | null;
  countryCode: string | null;
  kind: IntentNodeKind;
  source: 'index' | 'geocoder' | 'reference' | 'composite' | 'interpretation' | null;
}

export interface PlacePlanStopsInput {
  stops: readonly ParsedPlanStop[];
  contextCountries: readonly string[];
  resolver: DestinationResolver | null;
  now: Date;
  cache?: ConceptCache;
  /** The local index, when this deployment has one. Injected so tests never need a database. */
  indexLookup?: ((folded: string) => DestinationIndexEntry | null) | null;
  /** Geocoder calls one stop may spend; the default keeps a twelve-stop plan within a couple of dozen. */
  maxGeocoderCallsPerStop?: number;
}

/** A semantic type that tells us more about the stop's shape than its words did. */
const KIND_FROM_TYPE: Partial<Record<GeographicSemanticType, IntentNodeKind>> = {
  admin_area: 'admin_region',
  island: 'island',
  island_group: 'island_chain',
  mountain_region: 'mountain_range',
  natural_region: 'natural_region',
  coast: 'coast',
  protected_area: 'park',
  informal_region: 'vague_region',
  country: 'country',
  city_region: 'municipality',
  settlement: 'city',
};

function countryName(code: string): string | null {
  return countryFacts(code)?.name ?? null;
}

async function placeOne(stop: ParsedPlanStop, qualifier: string | null, input: PlacePlanStopsInput): Promise<PlacedPlanStop> {
  const unplaced: PlacedPlanStop = { label: stop.label, placedName: null, point: null, countryCode: stop.countryCode ?? null, kind: stop.kind, source: null };

  if (input.indexLookup) {
    try {
      const entry = input.indexLookup(foldForMatch(stop.label));
      if (entry) return { label: stop.label, placedName: entry.displayName, point: entry.center, countryCode: entry.countryCode ?? stop.countryCode ?? null, kind: stop.kind, source: 'index' };
    } catch {
      /* an index that cannot be read is an index that is not there */
    }
  }

  const ownCountry = countriesInText(stop.label).length > 0;
  const text = qualifier && !ownCountry && stop.kind !== 'country' ? `${stop.label}, ${qualifier}` : stop.label;
  try {
    const { outcome, semantics } = await resolveDestinationPhrase({
      text,
      resolver: input.resolver,
      now: input.now,
      interpreter: null,
      maxGeocoderCalls: input.maxGeocoderCallsPerStop ?? 2,
      ...(input.cache ? { cache: input.cache } : {}),
    });
    const centre = semantics.center ?? outcome.graph.envelope?.center ?? null;
    const only = outcome.graph.children.length === 1 ? outcome.graph.children[0]! : null;
    /*
     * The containing country's point is not where a town is: a stand-in centre,
     * or a part only the bundled country reference answered, leaves a stop that
     * is not itself a country unplaced.
     */
    const countryOnly = stop.kind !== 'country' && (semantics.type === 'country' || only?.resolution?.source === 'reference');
    if (!centre || countryOnly || (centreIsStandIn(semantics.centerBasis) && semantics.type !== 'country')) return unplaced;
    return {
      label: stop.label,
      placedName: semantics.label,
      point: { lat: centre.lat, lng: centre.lng },
      countryCode: semantics.countries[0] ?? stop.countryCode ?? null,
      kind: stop.kind === 'named_place' ? (KIND_FROM_TYPE[semantics.type] ?? stop.kind) : stop.kind,
      source: only?.resolution?.source ?? 'composite',
    };
  } catch {
    /* A provider that failed is not a place that does not exist. */
    return unplaced;
  }
}

export async function placePlanStops(input: PlacePlanStopsInput): Promise<PlacedPlanStop[]> {
  const context = input.contextCountries.length === 1 ? input.contextCountries[0]! : null;
  const qualifierFor = (stop: ParsedPlanStop): string | null => {
    const code = stop.countryCode ?? context;
    return code ? countryName(code) : null;
  };

  /* Sequential on purpose: the public geocoder's policy is one request a second, and the resolver honours it. */
  const placed: PlacedPlanStop[] = [];
  for (const stop of input.stops) {
    const qualifier = qualifierFor(stop);
    let result = await placeOne(stop, qualifier, input);
    /*
     * The qualified name found nothing: ask for the bare name once, and keep
     * the answer only when it lands in the country the plan named.
     */
    const wanted = stop.countryCode ?? context;
    if (!result.point && qualifier) {
      const bare = await placeOne(stop, null, input);
      if (bare.point && (!wanted || bare.countryCode === wanted)) result = bare;
    }
    placed.push(result);
  }

  /*
   * With no country named, the plan's own results suggest one: when most
   * placed stops agree, a stop that landed elsewhere (and does not name its
   * own country) is asked once more inside the majority's country, and the
   * answer is kept only if it lands there.
   */
  if (!context) {
    const counts = new Map<string, number>();
    for (const p of placed) if (p.countryCode && p.point) counts.set(p.countryCode, (counts.get(p.countryCode) ?? 0) + 1);
    const [majority, votes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const placedCount = placed.filter((p) => p.point).length;
    if (majority && votes >= 2 && votes > placedCount / 2) {
      const name = countryName(majority);
      for (const [i, p] of placed.entries()) {
        const stop = input.stops[i]!;
        if (p.countryCode === majority || stop.countryCode || countriesInText(stop.label).length > 0 || stop.kind === 'country' || !name) continue;
        const retry = await placeOne({ ...stop, countryCode: majority }, name, input);
        if (retry.point && retry.countryCode === majority) placed[i] = retry;
      }
    }
  }
  return placed;
}
