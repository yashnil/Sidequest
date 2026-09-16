import { haversineKm } from '../travel/estimate';

/**
 * V12.3 §2–§6 §13 §14 — A NAME IS NOT ENOUGH, AND THE CONTEXT WAS ALREADY THERE.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * The V12.1 Greek trip put a stop called **"Halki"** at `36.2296, 27.5672` —
 * Chalki in the Dodecanese — on a day based on **Naxos**, whose other stops sit
 * at 0 km and 13 km from the base. The village actually meant is 11 km away at
 * `37.0639, 25.4839`. The result was a 218 km leg, priced by V12.2's own
 * estimator at sixty hours on foot.
 *
 * Nothing in the resolver was broken in isolation. `assessGeographicScope`
 * accepted the island at its **first tier**: the destination is Greece, the
 * candidate is in Greece, so it is inside the destination. `pickAnchorGeocoderWinner`
 * then chose by the geocoder's own `importance`, and an island outranks a
 * village of four hundred people.
 *
 * **Resolution was destination-scoped; the evidence that settles it is
 * day-scoped.** The day already knew it was on one island. Nobody asked it.
 *
 * ── THE SECOND DEFECT, WHICH IS THE MIRROR ─────────────────────────────────
 *
 * Asked for "Old Harbour, Reykjavik", the geocoder returns the right answer —
 * `Gamla höfnin` — with `importance: 0.0`, as it does for most named venues
 * rather than settlements. Three candidates all scoring zero have no "clear
 * leader", so the importance rule returns nothing and a perfectly locatable
 * harbour goes unplaced.
 *
 * One mechanism fixes both: score candidates **against the context the
 * itinerary already carries**, and let importance be one term among several
 * rather than the only one.
 *
 * ── THE RULE THAT GOVERNS THE WHOLE MODULE (§4) ────────────────────────────
 *
 * **Unknown is preferable to confidently wrong.** A guard here may refuse a
 * candidate; it may never invent one, and where the field is genuinely split
 * the answer is `ambiguous`, which the caller treats as unresolved. Placement
 * rate is not the thing being optimised — §16 says so in as many words, and a
 * resolver that places more by guessing more is worse than one that places less.
 *
 * Pure: no provider, no clock, no model.
 */

/** How well grounded a resolved identity is. Persisted, so no downstream layer has to infer it (§14). */
export const RESOLUTION_CONFIDENCES = [
  /** Cited evidence: a board place, a compiled place, a persisted identity. The name was not merely matched. */
  'confirmed_identity',
  /** A provider row that also fits the trip's own geography and expectations. */
  'contextual_match',
  /** Candidates exist and the evidence does not choose between them. Treated as unresolved, kept for the audit. */
  'ambiguous',
  /** Nothing usable came back. */
  'unresolved',
] as const;
export type ResolutionConfidence = (typeof RESOLUTION_CONFIDENCES)[number];

export interface Point {
  lat: number;
  lng: number;
}

/** One provider row, reduced to what a contextual judgement may legitimately read. */
export interface PlaceCandidate {
  id: string;
  name: string;
  point: Point;
  /** The provider's own popularity ranking, where it publishes one. One signal, never the only one. */
  importance?: number | undefined;
  /** The provider's type word: `village`, `island`, `dock`, `peak`, `museum`… */
  kind?: string | undefined;
  countryCode?: string | undefined;
  /** Administrative names the provider attached, for region agreement. */
  adminNames?: readonly string[] | undefined;
}

/**
 * Everything the itinerary already knows when it asks for a place.
 *
 * Every field is optional and every one of them is evidence the plan produced
 * for its own reasons. A context with nothing in it degrades to the old
 * behaviour rather than to a guess.
 */
export interface ResolutionContext {
  /** ISO 3166-1 alpha-2 of the destination, where the destination has one. */
  countryCode?: string | undefined;
  /** Where the traveller sleeps on the day this stop belongs to. */
  base?: Point | undefined;
  /**
   * Stops already placed on the same day, in either direction.
   *
   * The strongest signal there is, and the cheapest: a day whose other stops are
   * all within a few kilometres of each other is a local day, and a candidate
   * two hundred kilometres outside that cluster is not the place that was meant.
   */
  neighbours?: readonly Point[] | undefined;
  /** The destination's own extent, where one is published. */
  extentKm?: number | undefined;
  /** The category the plan authored for this stop, where it authored one. */
  expectedKind?: string | undefined;
  /** Whether the shape of the trip rests on this place (§10). */
  routeCritical?: boolean | undefined;
  /** Region or island names the day is already associated with, for agreement scoring. */
  regionNames?: readonly string[] | undefined;
}

export interface CandidateScore {
  candidate: PlaceCandidate;
  /** Higher is better. Unbounded above; only the ordering and the margin are used. */
  score: number;
  /** Set when a hard guard refused it outright. A refused candidate can never win. */
  rejected: string | null;
  /** What moved the score, for the audit and for the placement record. */
  reasons: string[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE DAY'S OWN GEOGRAPHY
 * ──────────────────────────────────────────────────────────────────────────── */

export interface LocalityCluster {
  centre: Point;
  /** How spread out the day already is. A tight day judges a candidate harshly; a touring day cannot. */
  radiusKm: number;
  /** How many placed points the cluster was built from. One point is a weak cluster and is treated as such. */
  points: number;
}

/**
 * Where the day already is, from the points it has already placed.
 *
 * **A footprint needs at least one stop besides the bed.** The base counts once
 * there is one — a day is anchored to where it sleeps — but a base on its own is
 * not a footprint, and treating it as one is how this module first refused Song-Köl:
 * a lake 270 km from Karakol is exactly the kind of thing a Kyrgyz trip is *for*,
 * and the day had placed nothing else that said otherwise. Where the only
 * evidence is a base, the gentler base rule below applies instead.
 */
export function localityCluster(context: ResolutionContext): LocalityCluster | null {
  if (!context.neighbours || context.neighbours.length === 0) return null;
  const points = [...(context.base ? [context.base] : []), ...context.neighbours];
  if (points.length === 0) return null;
  const centre = {
    lat: points.reduce((total, point) => total + point.lat, 0) / points.length,
    lng: points.reduce((total, point) => total + point.lng, 0) / points.length,
  };
  const radiusKm = points.reduce((worst, point) => Math.max(worst, haversineKm(centre, point)), 0);
  return { centre, radiusKm, points: points.length };
}

/**
 * How far outside the day's own footprint a candidate may sit before it stops
 * being a plausible reading of the name.
 *
 * Generous by construction, and deliberately so. A famous attraction can be an
 * hour beyond everything else on the day (§3 says so), and a touring day has no
 * tight footprint to be outside of. What this refuses is the absurd: a stop two
 * hundred kilometres from a day that has not left one island.
 *
 * The floor matters as much as the multiplier. Without it a day whose stops all
 * sit in one town would have a radius near zero and would refuse the museum in
 * the next town.
 */
const LOCALITY_FLOOR_KM = 60;
const LOCALITY_MULTIPLE = 6;

/**
 * How far from the bed a stop may sit when the bed is the *only* thing placed.
 *
 * Far — deliberately. This is a full day's drive each way, and a day that has
 * placed nothing else has produced no evidence that it is a local day. What it
 * still refuses is the other continent, which is the class of error a country
 * guard misses when the country is large.
 */
const BASE_ONLY_REACH_KM = 300;

/**
 * The floor for judging a coordinate that has already won, after the fact.
 *
 * Same figure as `BASE_ONLY_REACH_KM` and for the same reason: beyond a day's
 * reach out and back, by any mode, on any trip. See `sanityCheckResolved`.
 */
const POST_HOC_FLOOR_KM = 300;

export function localityAllowanceKm(cluster: LocalityCluster): number {
  return Math.max(LOCALITY_FLOOR_KM, cluster.radiusKm * LOCALITY_MULTIPLE);
}

/* ────────────────────────────────────────────────────────────────────────────
 * TYPE COMPATIBILITY (§9)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What kinds of provider row can reasonably answer an authored category.
 *
 * Only the categories where the type genuinely constrains the answer are listed.
 * A broad area concept the model authored ("wildlife area", "old town") must not
 * be forced onto a precise type — §9 is explicit — so an unlisted category
 * scores neutrally rather than penalising everything.
 */
const KIND_EXPECTATIONS: Record<string, readonly string[]> = {
  /* `administrative` belongs here: a Tokyo ward and an Icelandic village are both filed under it. */
  village: ['village', 'hamlet', 'town', 'suburb', 'locality', 'neighbourhood', 'quarter', 'borough', 'city_district', 'administrative'],
  town: ['town', 'village', 'city', 'suburb', 'locality', 'administrative'],
  city: ['city', 'town', 'municipality', 'administrative'],
  lake: ['lake', 'water', 'reservoir', 'bay'],
  museum: ['museum', 'attraction', 'amenity', 'tourism', 'building'],
  market: ['marketplace', 'market', 'amenity', 'shop', 'retail'],
  station: ['station', 'railway', 'halt', 'public_transport', 'stop'],
  /*
   * No `amenity` here, unlike the rows above. Nominatim reports a dockside
   * restaurant, a gift shop and the ferry terminal itself all as `amenity`, so
   * admitting it would make the three indistinguishable — which is exactly the
   * Old Harbour case. The specific value is what separates them.
   */
  port: ['harbour', 'harbor', 'dock', 'ferry_terminal', 'port', 'quay'],
  airport: ['aerodrome', 'airport', 'terminal'],
  viewpoint: ['viewpoint', 'peak', 'attraction', 'tourism'],
  trailhead: ['trailhead', 'path', 'car_park', 'parking', 'attraction'],
  restaurant: ['restaurant', 'cafe', 'amenity', 'fast_food', 'bar'],
  hotel: ['hotel', 'guest_house', 'hostel', 'tourism', 'amenity'],
  national_park: ['national_park', 'protected_area', 'park', 'boundary'],
  beach: ['beach', 'bay', 'coastline', 'strand', 'shoal', 'water'],
  /* A walk resolves to its start, its summit or the path itself — all three are right. */
  hike: ['path', 'track', 'footway', 'trail', 'trailhead', 'peak', 'ridge', 'valley', 'natural', 'attraction', 'car_park', 'parking'],
};

/** Kinds that are never a settlement, so a settlement-shaped ask should not take one. */
const AREA_KINDS = new Set(['island', 'archipelago', 'county', 'state', 'region', 'country', 'continent']);

/**
 * Vehicle roads, which are how you reach a place rather than the place.
 *
 * Asked for "Skaftafell", the geocoder returns the locality and, 4.3 km away, a
 * service road of the same name inside it. Those are not two readings of the
 * name: one is the destination and the other is its access track. Left equal,
 * the pair scored within the margin and a real, unambiguous Icelandic stop was
 * reported as too ambiguous to place.
 *
 * A penalty and not a guard, deliberately. A trip whose stop genuinely *is* a
 * road — a named pass, a scenic drive — still places, because where the road is
 * the only candidate there is nothing for the penalty to lose to. Footpaths and
 * tracks are absent: those are how a walk is recorded, not how a car gets there.
 */
const CORRIDOR_KINDS = new Set(['road', 'street', 'service', 'residential', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'living_street', 'route_or_corridor']);

export function kindAgrees(expected: string | undefined, actual: string | undefined): 'agrees' | 'conflicts' | 'unknown' {
  /*
   * `'unknown'` is a provider saying it could not classify the row, not a type
   * called "unknown". Reading it as a conflict penalised every waterfall and
   * lake in the Rockies corpus, whose rows this codebase's own classifier files
   * exactly that way. Missing ≠ contradicted, here as everywhere.
   */
  if (!expected || !actual || actual.toLowerCase() === 'unknown') return 'unknown';
  const allowed = KIND_EXPECTATIONS[expected.toLowerCase()];
  if (!allowed) return 'unknown';
  const lowered = actual.toLowerCase();
  if (allowed.some((option) => lowered.includes(option))) return 'agrees';
  return 'conflicts';
}

/* ────────────────────────────────────────────────────────────────────────────
 * SCORING
 * ──────────────────────────────────────────────────────────────────────────── */

/** Weights. Stated together so the balance between them can be read in one place. */
const W = {
  /** The day's own footprint. The dominant term, because it is the strongest evidence. */
  locality: 4,
  /** Distance from the base, for a context that has a base but no other placed stop. */
  base: 2,
  /** The provider's popularity. Real but weak: it is what chose the wrong island. */
  importance: 1,
  /** Type agreement with what the plan authored. */
  kind: 1.5,
  /** An administrative name the day already carries turning up in the candidate's address. */
  region: 2,
  /** How much a vehicle road loses to a real place of the same name. Larger than `MARGIN`, so the place wins outright. */
  corridor: 2,
} as const;

/**
 * Score one candidate against the trip's own context.
 *
 * A rejected candidate is scored anyway, so the audit can say what it scored and
 * why it was refused — an explanation a traveller-facing note can be built from
 * without re-deriving anything.
 */
export function scoreCandidate(candidate: PlaceCandidate, context: ResolutionContext): CandidateScore {
  const reasons: string[] = [];
  let score = 0;
  let rejected: string | null = null;

  /* ── Hard guard: the wrong country is never the right place (§4). ── */
  if (context.countryCode && candidate.countryCode && candidate.countryCode.toLowerCase() !== context.countryCode.toLowerCase()) {
    rejected = `It is in ${candidate.countryCode.toUpperCase()}, and this trip is in ${context.countryCode.toUpperCase()}.`;
  }

  /* ── Hard guard: outside the day's own footprint by an absurd margin (§4 §5). ── */
  const cluster = localityCluster(context);
  if (cluster) {
    const distance = haversineKm(cluster.centre, candidate.point);
    const allowance = localityAllowanceKm(cluster);
    if (!rejected && distance > allowance) {
      rejected = `It is ${Math.round(distance)} km from everything else on this day, which reaches about ${Math.round(allowance)} km.`;
    }
    /*
     * Within the allowance, nearer is better — but gently, and never to the
     * point of preferring a car park over the landmark it serves. A famous stop
     * may legitimately be the farthest thing on the day (§3).
     */
    score += W.locality * (1 - Math.min(1, distance / Math.max(allowance, 1)));
    reasons.push(`${Math.round(distance)} km from the day's other stops`);
  } else if (context.base) {
    const distance = haversineKm(context.base, candidate.point);
    const allowance = Math.max(BASE_ONLY_REACH_KM, context.extentKm ?? 0);
    if (!rejected && distance > allowance) {
      rejected = `It is ${Math.round(distance)} km from where this day is based.`;
    }
    score += W.base * (1 - Math.min(1, distance / Math.max(allowance, 1)));
    reasons.push(`${Math.round(distance)} km from the base`);
  }

  /* ── Type agreement (§9). A conflict is heavy but not fatal on its own. ── */
  const agreement = kindAgrees(context.expectedKind, candidate.kind);
  if (agreement === 'agrees') {
    score += W.kind;
    reasons.push(`a ${candidate.kind}, which is what was asked for`);
  } else if (agreement === 'conflicts') {
    score -= W.kind;
    reasons.push(`a ${candidate.kind}, where a ${context.expectedKind} was asked for`);
    /*
     * One conflict is fatal: an *area* answering a request for a settlement is
     * the Halki shape exactly — an island standing in for a village inside it.
     */
    if (!rejected && candidate.kind && AREA_KINDS.has(candidate.kind.toLowerCase())) {
      rejected = `It is an ${candidate.kind}, and the plan asked for a ${context.expectedKind}.`;
    }
  }

  /* ── Region agreement: an administrative name the day already carries. ── */
  const regions = (context.regionNames ?? []).map((name) => name.toLowerCase());
  if (regions.length > 0 && (candidate.adminNames ?? []).some((name) => regions.some((region) => name.toLowerCase().includes(region) || region.includes(name.toLowerCase())))) {
    score += W.region;
    reasons.push('its address names the region this day is in');
  }

  /* ── A road named after the place it serves is not the place. ── */
  if (candidate.kind && CORRIDOR_KINDS.has(candidate.kind.toLowerCase())) {
    score -= W.corridor;
    reasons.push(`a ${candidate.kind} road rather than a place`);
  }

  /* ── The provider's own ranking. Last, and lightest. ── */
  score += W.importance * Math.min(1, candidate.importance ?? 0);

  return { candidate, score: Math.round(score * 1000) / 1000, rejected, reasons };
}

export interface ResolutionOutcome {
  winner: PlaceCandidate | null;
  confidence: ResolutionConfidence;
  scores: CandidateScore[];
  /** One sentence a placement record or a traveller note can be built from. */
  note: string;
}

/**
 * How much clearer the leader has to be than the runner-up.
 *
 * Small, because the terms above are already the discriminating ones: two
 * candidates that survive every guard and score within a hair of each other are
 * genuinely ambiguous, and saying so is the right answer.
 */
const MARGIN = 0.75;

/**
 * V12.3 §6 — TWO ROWS FOR ONE PLACE ARE NOT TWO CANDIDATES.
 *
 * Ambiguity is a question about *which place was meant*. A geocoder answering
 * "Johnston Canyon" returns the gorge, its car park, its tourism node and two
 * information boards — five rows inside 1.2 km, every one of them the same
 * answer to the traveller's question and to every measurement downstream.
 * Refusing to choose between them is not caution; it is failing to notice that
 * the field agrees, and it took two real Rockies stops off the map.
 *
 * So the margin is applied against the best candidate that is somewhere *else*.
 * Where every close rival is the same place, the best row wins outright.
 */
const SAME_PLACE_KM = 2;

/**
 * Pick a candidate, or decline to.
 *
 * Four outcomes and three of them are honest failures. `ambiguous` exists
 * separately from `unresolved` because they are different facts — "several
 * places carry this name and nothing here chooses" is worth recording, and a
 * later pass with better context can resolve it.
 */
export function pickContextualWinner(candidates: readonly PlaceCandidate[], context: ResolutionContext): ResolutionOutcome {
  if (candidates.length === 0) return { winner: null, confidence: 'unresolved', scores: [], note: 'Nothing came back for this name.' };

  const scores = candidates.map((candidate) => scoreCandidate(candidate, context)).sort((a, b) => b.score - a.score);
  const survivors = scores.filter((entry) => entry.rejected === null);

  if (survivors.length === 0) {
    const first = scores[0]!;
    return { winner: null, confidence: 'unresolved', scores, note: `No candidate fits this trip: ${first.rejected}` };
  }
  if (survivors.length === 1) {
    return { winner: survivors[0]!.candidate, confidence: 'contextual_match', scores, note: `One candidate fits this trip — ${survivors[0]!.reasons.join(', ')}.` };
  }

  const top = survivors[0]!;
  /*
   * The runner-up that actually competes: the highest-scoring survivor that is
   * not simply another record of the winner (see `SAME_PLACE_KM`).
   */
  const rival = survivors.slice(1).find((entry) => haversineKm(top.candidate.point, entry.candidate.point) > SAME_PLACE_KM);
  if (!rival) {
    return { winner: top.candidate, confidence: 'contextual_match', scores, note: `Chosen because it is ${top.reasons.join(', ')}.` };
  }
  if (top.score - rival.score < MARGIN) {
    return {
      winner: null,
      confidence: 'ambiguous',
      scores,
      note: `${survivors.length} places carry this name and nothing here separates them; it is left unplaced rather than guessed.`,
    };
  }
  return { winner: top.candidate, confidence: 'contextual_match', scores, note: `Chosen because it is ${top.reasons.join(', ')}.` };
}

/**
 * V12.3 §13 — THE LAST CHECK, AFTER A CANDIDATE HAS ALREADY WON.
 *
 * Defence in depth, and the cheapest kind: a winner from any tier — a places
 * provider, a geocoder, a compiled row — is asked once more whether it sits
 * where this trip is. A tier that never consulted the day's geography can still
 * hand back a plausible-looking coordinate, and every layer downstream treats a
 * coordinate as a fact.
 *
 * Returns the confidence the identity should be *persisted* with, so a suspicious
 * winner is downgraded rather than deleted: the name and the coordinate survive
 * for the audit, and nothing routes on them.
 *
 * ── WHY THIS IS MUCH LOOSER THAN THE RESOLUTION GUARD (`POST_HOC_FLOOR_KM`) ──
 *
 * The first time this ran on real trips it took Skaftafell off the founder's
 * Iceland itinerary. Day 7 is based near Selfoss with one other stop 12 km away,
 * so the day's measured footprint was 7 km and Skaftafell, 193 km east, was far
 * outside it — which is true, and which describes an ordinary day on the Ring
 * Road. Structurally that day is *identical* to the Naxos day this module was
 * built for: a base, one near stop, one far one. Distance alone cannot tell a
 * 193 km drive from a 218 km sea crossing, and the layer that can — a stop on
 * another island, with no road between — is §7's work, not this function's.
 *
 * So this check refuses only what no day of any kind reaches and returns from.
 * The discrimination belongs upstream, in `pickContextualWinner`, which has the
 * candidates to compare and does not have to judge one coordinate alone. This is
 * a backstop for the tiers that never consult geography at all, and a backstop
 * that fires on correct answers is worse than none.
 */
export function sanityCheckResolved(point: Point, context: ResolutionContext, proposed: ResolutionConfidence): { confidence: ResolutionConfidence; note: string | null } {
  const cluster = localityCluster(context);
  if (!cluster) return { confidence: proposed, note: null };
  const distance = haversineKm(cluster.centre, point);
  const allowance = Math.max(POST_HOC_FLOOR_KM, localityAllowanceKm(cluster));
  if (distance <= allowance) return { confidence: proposed, note: null };
  return {
    confidence: 'ambiguous',
    note: `This sits ${Math.round(distance)} km from the rest of the day, which reaches about ${Math.round(allowance)} km, so it is held as unconfirmed rather than used to plan travel.`,
  };
}

/** Whether an identity is grounded enough for routing and readiness to treat it as a fact (§14). */
export function isAuthoritative(confidence: ResolutionConfidence): boolean {
  return confidence === 'confirmed_identity' || confidence === 'contextual_match';
}
