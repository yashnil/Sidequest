'use server';

import { GEOGRAPHIC_SEMANTIC_TYPE_LABELS, countryFromText, foldForMatch, framingIsUnsafe, parseDestinationIntent, sanitizePlaceText, type DestinationIndexEntry, type IntentNodeKind } from '@sidequest/core';
import { entriesByPrefix } from '@/lib/db/destination-index-repository';
import { verificationProviders } from '@/lib/planning/verification-providers';
import { guardAction } from '@/lib/net/caller';
import { resolveDestinationPhrase, type GraphResolutionOutcome } from '@/lib/destinations/intent-resolution';
import { destinationConceptCache } from '@/lib/destinations/concept-cache';

/**
 * WHERE THE TYPED WORDS ARE, BEFORE ANY TRIP EXISTS.
 *
 * STAGING PARITY §1, §4. The defect this closes, stated as a class: the setup
 * flow's map and its "tell me when it is best" both needed a *coordinate*, and
 * the only thing that could produce one was the traveller picking a row out of
 * the local destination index. A deployment whose database has no index — which
 * is every fresh deployment, because the index is built by an offline scan —
 * therefore had no coordinate for anything anybody typed. "Japan" became the
 * empty-world map captioned ANYWHERE, and the seasons screen said the
 * destination could not be placed. Neither statement was true, and neither had
 * asked anybody.
 *
 * It was invisible in development for the obvious reason: the development
 * database has an index, so a pick was always available.
 *
 * The hierarchy below is the fix, and its order is the point:
 *
 * 1. **The local index**, when this deployment has one. It carries a published
 *    centre *and* extent, which is the best answer available and costs nothing.
 * 2. **The bundled country reference.** Offline, instant, and enough to place any
 *    country the app already ships facts for — including inside a phrase, so
 *    "rural Japan" places without "Japan" being a case in the code.
 * 3. **The configured geocoder.** For everything a country name cannot answer: a
 *    city, a region, a national park, a delta. One round trip, behind the fence
 *    that already exists for exactly this call, and never while somebody is
 *    typing — the geocoder's own policy forbids autocomplete and so does
 *    `api/destinations/suggest`.
 * 4. **Unresolved**, said plainly, blocking nothing.
 *
 * What this deliberately does not do is decide anything. It answers "where is
 * this", and every consequence — what the map frames, what the climate lookup
 * reads, what the traveller is told — belongs to the caller.
 */

export interface PlacedDestination {
  /** What the traveller typed, kept as their words. */
  query: string;
  /** The name of the thing that was found, which may be more specific than the query. */
  name: string;
  center: { lat: number; lng: number };
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | null;
  /** `country`, `city`, `region`… as the source published it. Drives how wide the map frames. */
  featureType?: string;
  countryCode?: string;
  /** Which tier answered. Never rendered as-is; the UI decides what to say about certainty. */
  source: 'index' | 'reference' | 'geocoder' | 'composite' | 'interpretation';
  /** The populated place a country-scale coordinate names, so a climate answer can say where it was read. */
  referencePoint?: string;
  /**
   * V7 §2 — the parts of a phrase that names more than one thing, each with
   * whether it was placed. The canvas captions "Kenya and Tanzania · two
   * countries" from this rather than the empty world.
   */
  parts?: { label: string; kind: IntentNodeKind; placed: boolean }[];
  crossBorder?: boolean;
  /**
   * V8.1 — the semantic reading: what kind of thing, at what scale, how the
   * extent was arrived at, and the gateways (context, never the destination).
   * The canvas frames and captions from these rather than from a row's class.
   */
  semanticType?: string;
  scale?: string;
  extentSource?: string;
  gateways?: string[];
}

export type PlaceResult =
  | { ok: true; placed: PlacedDestination }
  | {
      ok: true;
      placed: null;
      reason: 'too_short' | 'unresolved' | 'no_resolver' | 'provider_failed' | 'rate_limited' | 'locating';
      /**
       * V10 §15 — WHAT TO SAY INSTEAD OF DRAWING THE WRONG MAP.
       *
       * The founder's setup screen rendered eastern Canada for "the Canadian
       * Rockies" because the only thing that had placed the phrase was the
       * country's published point, and a point plus a scale is enough to frame a
       * box. It was the wrong box around the wrong place, at high confidence.
       *
       * When the centre is only a stand-in and nothing published an extent, the
       * honest screen says what kind of thing it is looking for and that it has
       * not found it yet. Present only with `reason: 'locating'`.
       */
      locating?: { label: string; kindLabel: string };
    };

/** Long enough to be a name rather than a keystroke, short enough not to be a paragraph. */
const MAX_QUERY = 120;

export async function placeDestinationAction(raw: { text: string }): Promise<PlaceResult> {
  const query = sanitizePlaceText(String(raw?.text ?? '')).slice(0, MAX_QUERY).trim();
  const folded = foldForMatch(query);
  if (folded.length < 2) return { ok: true, placed: null, reason: 'too_short' };

  /* 1 — the local index, when this deployment built one. Free, offline, and carries an extent. */
  const indexed = confidentIndexHit(folded);
  if (indexed) {
    return {
      ok: true,
      placed: {
        query,
        name: indexed.displayName,
        center: indexed.center,
        bounds: indexed.bounds ?? null,
        ...(indexed.featureType ? { featureType: indexed.featureType } : {}),
        ...(indexed.countryCode ? { countryCode: indexed.countryCode } : {}),
        source: 'index',
        extentSource: indexed.bounds ? 'published' : 'none',
        gateways: [],
      },
    };
  }

  /* 2 — the bundled country reference. No network, no database, no failure mode. */
  const graph = parseDestinationIntent(query);
  const bare = graph.children.length === 1 && graph.children[0]!.kind === 'country' ? countryFromText(query) : null;
  if (bare) {
    return {
      ok: true,
      placed: {
        query,
        name: bare.how === 'name' ? bare.facts.name : query,
        center: { lat: bare.point.lat, lng: bare.point.lng },
        bounds: null,
        featureType: 'country',
        countryCode: bare.facts.code,
        source: 'reference',
        referencePoint: bare.point.place,
        semanticType: 'country',
        scale: 'country',
        extentSource: 'none',
        gateways: [],
      },
    };
  }

  /*
   * 3 — the intent graph, resolved part by part through the semantic gate
   * (`lib/destinations/intent-resolution.ts`). V7 placed a phrase that names
   * more than one thing as their union; V8.1 sends *every* phrase through the
   * same path, because the door that handed a single part's raw text to the
   * geocoder and adopted its first row is how "the Canadian Rockies" became a
   * shop in Calgary. A country child costs nothing; a named part costs one
   * geocoder call behind the fence that exists for it; a region the evidence
   * cannot settle may cost the interpreter one bounded reading.
   */
  const { resolver } = verificationProviders();
  const needsResolver = graph.children.some((c) => c.kind !== 'country' && c.kind !== 'vague_region');
  if (needsResolver && !resolver) {
    /* No geocoder: a country in the phrase still places it; anything else stays honestly unplaced. */
    const offline = await resolveDestinationPhrase({ text: query, resolver: null, now: new Date(), interpreter: null });
    return placedFrom(query, offline.outcome, 'no_resolver');
  }
  const limited = needsResolver ? await guardAction('destination_resolve') : null;
  if (limited) {
    const offline = await resolveDestinationPhrase({ text: query, resolver: null, now: new Date(), interpreter: null });
    return placedFrom(query, offline.outcome, 'rate_limited');
  }
  try {
    const started = Date.now();
    const { outcome } = await resolveDestinationPhrase({ text: query, resolver, now: new Date(), cache: destinationConceptCache() });
    /*
     * V10 §15 — where the setup screen's wait went, recorded on every resolution
     * rather than guessed at afterwards. A cache hit is the interesting case:
     * nothing was asked and nothing was waited for.
     */
    console.warn('destination placement timings', { ms: Date.now() - started, cacheHit: outcome.timings.cacheHit, geocoderMs: outcome.timings.geocoderMs, geocoderCalls: outcome.timings.geocoderCalls, interpreterMs: outcome.timings.interpreterMs, type: outcome.semantics.type, scale: outcome.semantics.scale, centerBasis: outcome.semantics.centerBasis });
    return placedFrom(query, outcome, 'unresolved');
  } catch (error) {
    /*
     * A provider that failed is not a place that does not exist (§5). The caller
     * gets "not placed", never "not there", and the traveller's answer stands.
     */
    console.warn('A typed destination could not be placed', { reason: error instanceof Error ? error.name : 'unknown' });
    return { ok: true, placed: null, reason: 'provider_failed' };
  }
}

/** The placed shape from a resolved graph, or the reason it stayed unplaced. */
function placedFrom(query: string, outcome: GraphResolutionOutcome, reason: 'unresolved' | 'no_resolver' | 'rate_limited'): PlaceResult {
  const { graph, semantics } = outcome;
  const only = graph.children.length === 1 ? graph.children[0]! : null;
  /*
   * The concept's own centre and the graph's envelope are two different claims,
   * and only the first is what `centerBasis` describes. A composite phrase places
   * its parts and gets an envelope centre while the concept itself has none —
   * which is a real location, arrived at honestly, and must be framed.
   */
  const conceptCentre = semantics.center ?? null;
  const centre = conceptCentre ?? graph.envelope?.center ?? null;
  if (!centre) return { ok: true, placed: null, reason };
  /*
   * V10 §15 — a stand-in centre with no published extent is not a location, and
   * drawing it is worse than drawing nothing. The screen gets a "still locating
   * this mountain region" state instead of a country-wide box around a capital.
   * Only ever asked of the concept's own centre: an envelope centre is evidence
   * from the parts that placed, and `centerBasis` says nothing about it.
   */
  if (conceptCentre && framingIsUnsafe(semantics)) {
    return { ok: true, placed: null, reason: 'locating', locating: { label: semantics.label, kindLabel: GEOGRAPHIC_SEMANTIC_TYPE_LABELS[semantics.type].toLowerCase() } };
  }
  const parts = graph.children.map((c) => ({ label: c.label, kind: c.kind, placed: Boolean(c.resolution) }));
  const featureType = only?.resolution?.featureType ?? (graph.crossBorder ? 'multi_country' : 'composite');
  return {
    ok: true,
    placed: {
      query,
      name: semantics.label,
      center: centre,
      bounds: semantics.travelExtent?.bounds ?? semantics.extent?.bounds ?? graph.envelope?.bounds ?? null,
      featureType: semantics.type === 'mountain_region' || semantics.type === 'natural_region' || semantics.type === 'coast' ? 'natural_region' : featureType,
      ...(semantics.countries.length === 1 ? { countryCode: semantics.countries[0]! } : {}),
      source: only?.resolution?.source ?? 'composite',
      ...(only?.resolution?.source === 'reference' ? { referencePoint: only.resolution.label } : {}),
      ...(graph.children.length > 1 ? { parts, crossBorder: graph.crossBorder } : {}),
      semanticType: semantics.type,
      scale: semantics.scale,
      extentSource: semantics.extent?.source ?? 'none',
      gateways: semantics.gateways.map((g) => g.label),
    },
  };
}

/**
 * The index row this text is unambiguously about, or nothing.
 *
 * Deliberately stricter than the dropdown. The dropdown offers a ranked list for
 * a person to choose from; this has to choose *for* them, so it accepts only an
 * exact folded name match, and only when one row has it. Anything less certain
 * falls through to a tier that cannot be wrong about identity.
 */
function confidentIndexHit(folded: string): DestinationIndexEntry | null {
  let rows: DestinationIndexEntry[];
  try {
    rows = entriesByPrefix(folded, 40);
  } catch {
    return null;
  }
  const exact = rows.filter((row) => foldForMatch(row.displayName) === folded || row.aliases.some((alias) => foldForMatch(alias) === folded));
  if (exact.length === 0) return null;
  /* Ties are broken by prominence, which is what the dropdown would have shown first. */
  const best = [...exact].sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0));
  const leader = best[0]!;
  if (best.length > 1 && (best[1]!.prominence ?? 0) === (leader.prominence ?? 0)) return null;
  return leader;
}
