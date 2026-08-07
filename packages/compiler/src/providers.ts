import type {
  DisplayName,
  EvidenceClaimRecord,
  ResearchAttempt,
  ResolvedFact,
  AccessRule,
  DataLicence,
  ConfidenceSignal,
  DestinationResolution,
  FactPath,
  GeographicScope,
  OperatingCalendar,
  Place,
  ProviderRef,
  RegionPack,
  SourceAuthorityKind,
  SourceFact,
  TravelerProfile,
  TransportMode,
  TransportService,
  WeatherLocation,
  FoodVenue,
} from '@sidequest/core';
import type { TravelMode } from '@sidequest/geo';
import type { RegionPackProvider } from './backbone/pack';

/**
 * The seams the dynamic compiler talks to, and the only ones.
 *
 * Every one of these is destination-agnostic by construction: nothing in the
 * signatures names a country, a mode of transport or a kind of place. A live
 * Google adapter, a deterministic fake and a self-hosted Overpass all satisfy
 * the same shapes, which is what makes the pipeline testable without a network
 * and swappable without touching the pipeline.
 *
 * Two rules hold across all of them, and they are the difference between this
 * and a wrapper around somebody's API:
 *
 * 1. **A provider may not answer "I don't know" by omission.** Anything it could
 *    not establish comes back as an explicit gap with a reason, never as a
 *    missing key that a downstream `??` will turn into a default.
 * 2. **A provider does not get to assert confidence.** It reports observable
 *    signals; `assessConfidence` in core turns those into a level. A number a
 *    model made up is not evidence, and rendering one next to a place name is
 *    how a guess becomes a fact.
 */

/** Why a provider could not answer for something it was asked about. */
export const PROVIDER_GAP_REASONS = [
  'not_found',
  'no_official_source',
  'provider_error',
  'rate_limited',
  'budget_exhausted',
  'insufficient_evidence',
  'rejected_unsafe_source',
  /**
   * The site asks us not to read this.
   *
   * Its own reason rather than folded into "unsafe": a page we are declining to
   * fetch out of respect is a different thing from one we are declining to fetch
   * because it is dangerous, and a traveller reading a coverage report is owed
   * the difference.
   */
  'blocked_by_robots',
] as const;
export type ProviderGapReason = (typeof PROVIDER_GAP_REASONS)[number];

export interface ProviderGap {
  subjectId: string;
  reason: ProviderGapReason;
  detail: string;
}

/**
 * A place the compiler could actually use, with the evidence behind it.
 *
 * The `Place` is schema-valid or it does not exist. That is a deliberate and
 * slightly harsh contract: `Place` has a dozen required fields with no `unknown`
 * variant, so a provider that cannot establish a place's seasonal access or
 * physical intensity must **drop the candidate and report a gap** rather than
 * fill the field in with a plausible default. Fabricating one field to get a
 * record through is exactly how an itinerary acquires a fact nobody checked.
 */
export interface DiscoveredCandidate {
  place: Place;
  providerRefs: ProviderRef[];
  /** Evidence behind anything on the place that is not self-evident. */
  facts: SourceFact[];
  /** Observable signals only. The level is computed, never supplied. */
  confidenceSignals: ConfidenceSignal[];
}

export interface DiscoveryResult {
  candidates: DiscoveredCandidate[];
  gaps: ProviderGap[];
  /** Provider calls actually made, for the budget ledger. */
  calls: number;
  /**
   * What the traveller's screen now owes the source.
   *
   * Declared by the provider rather than assumed by the compiler, because only
   * the provider knows whose database it read. A compiled region unions these,
   * and the UI renders every attribution it ends up carrying.
   */
  licences?: DataLicence[];
  /**
   * WHAT THE SUPPLY LOOKED LIKE, ON ITS WAY TO A SCREEN.
   *
   * Six counts, and every one of them is a number a traveller can act on: how
   * many practical stops were kept apart from the board, how many places nobody
   * could confidently place, how many sat outside the chosen ground, how many
   * are ways in and out, and how many the regional expansion put there.
   *
   * It travels here because this is the only layer that has both halves. The
   * inventory knows what it separated; the containment overlay knows what it
   * excluded and why; and by the time the artifact is written both have been
   * collapsed into a candidate list. A board of six that can also say "and
   * eighteen more were transport, shops and services" is a different product
   * from a board of six, and the difference used to be lost exactly here.
   *
   * Optional, because a provider that has no inventory has nothing to report and
   * must not report a zero — a counted zero and an uncounted one are different
   * claims, and the reading layer renders only the first.
   */
  boardSupply?: {
    supportKeptSeparately: number;
    withheldUnplaceable: number;
    removedOutOfScope: number;
    gateways: number;
    expansionMembers: number;
    satellites: number;
  };
}

/** What to go looking for. Categories rather than one "things to do" sweep. */
export interface DiscoveryQuery {
  /** Stable, so a cache key and a diagnostic can both name it. */
  id: string;
  /** What kind of thing: `viewpoint`, `museum`, `market`, `trailhead`. */
  intent: string;
  /** Free text handed to a search provider. */
  text: string;
  /** Which area of the scope to look in. Absent means the whole scope. */
  areaId?: string;
  limit: number;
}

export interface DestinationResolver {
  readonly name: string;
  resolve(input: { query: string; now: Date }): Promise<DestinationResolution>;
}

/** What a region turns into once it is bigger than one point. */
export interface RegionExpansion {
  subregions: {
    id: string;
    name: string;
    summary: string;
    center: { lat: number; lng: number };
    radiusKm: number;
    suggestedNights: { min: number; max: number };
  }[];
  bases: {
    id: string;
    name: string;
    /**
     * The resolved, English-first name when the adapter could produce one.
     *
     * Optional: an adapter with no multilingual source still returns a base,
     * and the compiler falls back to `name` exactly as it always did.
     */
    names?: DisplayName;
    coordinates: { lat: number; lng: number };
    timeZone: string;
    subregionId?: string;
    suggestedNights: { min: number; max: number };
    transportModes: TransportMode[];
    rationale: string;
    tradeoffs: string[];
  }[];
  gaps: ProviderGap[];
  calls: number;
}

export interface RegionExpansionProvider {
  readonly name: string;
  expand(input: {
    scope: GeographicScope;
    profile?: TravelerProfile;
    nights: number;
    maxSubregions: number;
    maxBases: number;
  }): Promise<RegionExpansion>;
}

export interface PlaceDiscoveryProvider {
  readonly name: string;
  discover(input: {
    scope: GeographicScope;
    queries: readonly DiscoveryQuery[];
    profile?: TravelerProfile;
    /**
     * The region pack, when the backbone produced one.
     *
     * A provider that receives a pack should read it rather than issue queries:
     * the pack is a bounded, release-pinned, already-normalised inventory and
     * asking a live search service the same question again would be slower,
     * less complete and less reproducible. `queries` remains for the fallback
     * path, where no pack could be built.
     */
    pack?: RegionPack;
    /**
     * The areas the regional expansion asked for, once it has run.
     *
     * The plumbing CS-8 was missing. `optional_satellite` and
     * `regional_expansion_member` are the only relationships that legitimately
     * admit a record outside the destination's own boundary, and both require
     * that *something asked for the area*. The thing that asks is the expansion
     * — and `building_region_pack` runs before `expanding_region`, while
     * `includedAreas` is part of `scopeFingerprint`, which keys the pack cache.
     * So it cannot be on the scope at pack-build time without giving every
     * traveller their own pack, and it cannot be inferred from adjacency without
     * reintroducing the defect.
     *
     * It travels here instead: expansion runs first, discovery receives its
     * result, and the trip-scope overlay is built knowing both.
     */
    includedAreas?: readonly TripIncludedArea[];
  }): Promise<DiscoveryResult>;
}

/**
 * An area a trip deliberately includes, as the discovery seam sees it.
 *
 * Structurally identical to the compiler's `IncludedArea` and declared here so
 * the provider interface does not have to import from the backbone. `status`
 * carries the difference between "this is in the trip" and "this is offered":
 * an included area produces `regional_expansion_member`, an optional one
 * produces `optional_satellite`, and the second stays labelled and unplanned
 * until something takes it up.
 */
export interface TripIncludedArea {
  id: string;
  name: string;
  reason:
    | 'regional_expansion_requested'
    | 'expansion_base'
    | 'expansion_subregion'
    | 'traveller_requested_area';
  status: 'included' | 'optional';
  center?: { lat: number; lng: number };
  radiusKm?: number;
  divisionIds?: readonly string[];
}

/**
 * Hard planning facts: when a place is open, and whether you can get to it.
 *
 * Separate from discovery because they come from different places. A search
 * provider knows a viewpoint exists; only the agency that runs the road knows
 * whether it is shut in April.
 */
export interface ConstraintResearchResult {
  calendars: OperatingCalendar[];
  accessRules: AccessRule[];
  services: TransportService[];
  facts: SourceFact[];
  gaps: ProviderGap[];
  calls: number;
  /** Pages actually fetched, for the manifest. */
  pagesFetched: number;
}

export interface ConstraintResearchProvider {
  readonly name: string;
  research(input: {
    scope: GeographicScope;
    places: readonly Place[];
    dates: readonly string[];
    /** Hard ceiling on how many places may be researched deeply. */
    maxSubjects: number;
  }): Promise<ConstraintResearchResult>;
}

/**
 * ONE SUBJECT WORTH RESEARCHING, AND WHAT WE ALREADY KNOW ABOUT IT.
 *
 * Deliberately not a `Place`: food venues go through the same pipeline, and a
 * venue is not a place. What the three research providers need is an identity, a
 * name, somewhere to look and any official URL a structured source already gave
 * us — nothing else.
 */
export interface ResearchSubject {
  id: string;
  name: string;
  /** What kind of thing, in our vocabulary, for query wording only. */
  kind: string;
  locality: string;
  coordinates: { lat: number; lng: number };
  /**
   * An official URL an *open structured source* already supplied.
   *
   * When this is present the source-discovery provider should not search at all:
   * a `website` tag or a Wikidata P856 claim is a better answer than a search
   * result, and it is free. This is the mechanism that keeps the most expensive
   * counter in the compiler from being spent on subjects that did not need it.
   */
  knownOfficialUrl?: string;
  /** Which facts we still want. A subject with nothing wanted is not researched. */
  wantedPaths: readonly FactPath[];
}

/**
 * A place we might read. **Never** a fact, and never something a model wrote.
 *
 * `url` comes from a provider's structured output — a `website` tag, a Wikidata
 * claim, a search-result block — and goes through the SSRF-safe fetch layer
 * before anything reads it.
 */
export interface SourceReference {
  subjectId: string;
  url: string;
  title?: string;
  /** What the discovery layer thinks this is, before anyone reads it. */
  expectedAuthority: SourceAuthorityKind;
  /** Where the reference itself came from: `osm_tag`, `wikidata`, `search`. */
  discoveredVia: string;
  /** Provider-reported freshness, verbatim. Not parsed into a date here. */
  pageAge?: string;
  /**
   * What we want out of this page, carried so retrieval can judge freshness.
   *
   * A page nobody wants a closure from is worth rechecking far less often than
   * one we do, and the retrieval layer cannot ask the subject list. Carrying the
   * paths on the reference keeps that decision measured rather than guessed —
   * and guessing here means either re-reading everything or trusting a stale
   * safety notice.
   */
  wantedPaths?: readonly FactPath[];
  /**
   * Validators a previous read of this exact URL left behind.
   *
   * Present only when something upstream already holds a version of this page.
   * The provider sends them as `If-None-Match` / `If-Modified-Since`; a `304`
   * comes back on `unchanged` rather than as a document, and the caller reuses
   * what it already has. This is the whole mechanism by which a warm
   * compilation transfers no bytes.
   */
  conditional?: { etag?: string; lastModified?: string };
}

export interface SourceDiscoveryResult {
  references: SourceReference[];
  gaps: ProviderGap[];
  calls: number;
  /** Billable searches actually issued. The most expensive counter we hold. */
  searches: number;
}

/**
 * Where to look. Not what is true.
 *
 * The separation is the security design: a provider that could return facts
 * could return facts a hostile page told it to return. This one returns
 * candidate URLs, and every one of them is fetched by us, from our process,
 * under our limits.
 */
export interface SourceDiscoveryProvider {
  readonly name: string;
  /**
   * What this provider *is*, as a version string.
   *
   * Part of the discovery cache key: changing the query wording changes which
   * pages come back, so a remembered "nobody publishes this" from the old
   * wording must not survive the new one.
   */
  readonly version: string;
  discover(input: {
    scope: GeographicScope;
    subjects: readonly ResearchSubject[];
    maxSearches: number;
    maxReferencesPerSubject: number;
  }): Promise<SourceDiscoveryResult>;
}

/** A page we actually read, reduced to the parts a fact can come out of. */
export interface RetrievedDocument {
  subjectId: string;
  url: string;
  title?: string;
  /** Cleaned visible text, already capped. Never the whole page. */
  text: string;
  /** schema.org objects found in `application/ld+json`, depth- and size-limited. */
  structuredData: unknown[];
  /** SHA-256 of `text`, so a later run can notice the page changed. */
  contentHash: string;
  contentBytes: number;
  retrievedAt: string;
  /** The date the page states it was published or updated, where it states one. */
  publishedAt?: string;
  robotsAllowed: boolean;
  authority: SourceAuthorityKind;
  publisher: string;
  domain: string;
  /**
   * What the response said about change detection, so a later run can ask
   * rather than re-read. Absent when the provider does not track it.
   */
  validators?: {
    etag?: string;
    /** `W/"…"` means semantically equivalent, not byte-identical. */
    weakEtag?: boolean;
    lastModified?: string;
    cacheControl?: string;
    vary?: string;
  };
  /** True when a ceiling stopped the read. Not the same evidence as the page. */
  truncated?: boolean;
  /** Where the request actually went, hop by hop. */
  redirects?: string[];
}

/** A page the server said had not changed. Never a document — a confirmation. */
export interface UnchangedSource {
  url: string;
  subjectId: string;
  /** A 304 must carry representation metadata; this is the refreshed copy. */
  validators?: RetrievedDocument['validators'];
  /** Bytes a conditional request avoided, as measured rather than estimated. */
  bytesAvoided: number;
}

export interface SourceRetrievalResult {
  documents: RetrievedDocument[];
  /**
   * References the server answered with `304 Not Modified`.
   *
   * Separate from `documents` on purpose. A 304 is evidence that the publisher
   * says the representation is unchanged, and evidence about *nothing else* —
   * returning it as a document with an empty body would let an empty page look
   * like a page that says nothing.
   */
  unchanged?: UnchangedSource[];
  /** References we refused or could not read, with why. Never silent. */
  rejected: { url: string; subjectId: string; reason: ProviderGapReason; detail: string }[];
  gaps: ProviderGap[];
  bytes: number;
  /**
   * Pages actually requested from a server.
   *
   * Distinct from `documents.length` once evidence is shared: a warm build
   * returns documents it already held and asked nobody for, and charging those
   * to the page budget would report a cost that was never paid. Absent means
   * "the provider does not distinguish", and the caller falls back to counting
   * documents.
   */
  requested?: number;
}

export interface SourceRetrievalProvider {
  readonly name: string;
  retrieve(input: {
    references: readonly SourceReference[];
    maxPages: number;
    maxBytes: number;
    deadlineMs: number;
  }): Promise<SourceRetrievalResult>;
}

/**
 * A structured claim pulled out of a document.
 *
 * The extractor returns these; it does **not** return `SourceFact`s. Building a
 * `SourceFact` means stamping authority, provenance, freshness and an id, and
 * those are ours to decide — an extractor that could stamp its own authority
 * could promote itself.
 */
export interface ExtractedClaim {
  subjectId: string;
  /** Index into the documents supplied. Never a URL. */
  documentIndex: number;
  factPath: FactPath;
  statement: string;
  evidenceExcerpt?: string;
  /** Set when the claim came out of JSON-LD rather than prose. */
  evidenceField?: string;
  derivation: 'directly_stated' | 'inferred_from_source';
  /** Typed payload for the paths that have one. Validated by the caller. */
  payload?: unknown;
}

export interface FactExtractionResult {
  claims: ExtractedClaim[];
  /** Subjects the documents did not answer for. Never omitted. */
  unanswered: { subjectId: string; factPath: FactPath; reason: string }[];
  gaps: ProviderGap[];
  calls: number;
  /** The prompt and schema that produced this, for the manifest. */
  promptVersion: string;
  schemaVersion: string;
  modelId?: string;
  /** What the call actually cost, where the provider measures it. */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface FactExtractionProvider {
  readonly name: string;
  /**
   * The contract this extractor works under, knowable *before* it is called.
   *
   * A cache that only learns the prompt version from the answer can never look
   * anything up — it would build its key from a placeholder and store under the
   * real one, and miss every time. These are declared up front so the key is the
   * same on the way in and on the way out.
   */
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly modelId?: string;
  extract(input: {
    subjects: readonly ResearchSubject[];
    documents: readonly RetrievedDocument[];
    /** The traveller's dates, so a dated closure can be judged relevant. */
    dates: readonly string[];
    maxCalls: number;
  }): Promise<FactExtractionResult>;
}

export interface RoutingMatrixResult {
  /** The licence the durations and distances are stored under. */
  licences?: DataLicence[];
  ids: string[];
  minutes: number[][];
  km: number[][];
  provenance: { kind: 'measured' | 'modelled' | 'estimated'; note: string; source?: string };
  /** Pairs the provider could not answer for. Never silently zero. */
  failedPairs: { from: string; to: string; reason: ProviderGapReason }[];
  calls: number;
  elements: number;
}

export interface RoutingProvider {
  readonly name: string;
  /** Which modes this provider can actually answer for, in this region. */
  supportedModes(): readonly TravelMode[];
  matrix(input: {
    points: readonly { id: string; lat: number; lng: number }[];
    mode: TravelMode;
    /** Hard ceiling. A provider that would exceed it must truncate and say so. */
    maxElements: number;
  }): Promise<RoutingMatrixResult>;
}

export interface WeatherLocationResult {
  locations: WeatherLocation[];
  gaps: ProviderGap[];
  calls: number;
}

/**
 * Choosing forecast points is a judgement about terrain, not a lookup.
 *
 * One point for a region that spans four thousand feet of elevation is wrong by
 * sixteen degrees at the extremes; one point per place implies a resolution no
 * global forecast model has. This provider exists so that judgement is
 * pluggable rather than hard-coded to one region's seven points.
 */
export interface WeatherLocationProvider {
  readonly name: string;
  plan(input: {
    scope: GeographicScope;
    places: readonly Place[];
    maxLocations: number;
  }): Promise<WeatherLocationResult>;
}

export interface FoodDiscoveryResult {
  venues: FoodVenue[];
  gaps: ProviderGap[];
  calls: number;
}

export interface FoodDiscoveryProvider {
  readonly name: string;
  discover(input: {
    scope: GeographicScope;
    places: readonly Place[];
    bases: readonly { id: string; coordinates: { lat: number; lng: number } }[];
    maxVenues: number;
    /** The same pack the places came from, so food is one read rather than two. */
    pack?: RegionPack;
  }): Promise<FoodDiscoveryResult>;
}

/**
 * The full provider set the compiler needs.
 *
 * Every field is required. An absent provider is expressed by supplying one that
 * honestly returns nothing — which produces a compiled region with an
 * `unavailable` coverage row and a plan that says so, rather than an undefined
 * check scattered through the pipeline.
 */
/**
 * DURABLE EVIDENCE ABOUT PLACES, SHARED BY EVERY TRIP.
 *
 * The seam that turns "the pages were free" into "the facts were free". A claim
 * is a fact about a museum; a compilation is a fact about a traveller. This
 * interface only ever carries the first kind — there is no trip id, no profile
 * and no date on any of its signatures, and an architecture test fails the build
 * if one appears.
 *
 * Optional, because a provider set can legitimately have nowhere to put claims:
 * the synthetic worlds run without one, and a compilation with no store simply
 * researches everything as it always did. That is a visible state in the work
 * plan rather than a silent branch.
 */
export interface SharedClaimStore {
  /** Changing this invalidates every shared resolution. Never a fact's content. */
  readonly resolverVersion: string;
  /** Everything durable we hold about these subjects, keyed by subject key. */
  load(subjectKeys: readonly string[]): Map<string, EvidenceClaimRecord[]>;
  /**
   * Record what was observed, and mark what it replaced.
   *
   * Superseding marks rather than deletes: an artifact compiled last month
   * quotes a fact id, and that fact has to stay explicable afterwards.
   */
  save(input: {
    records: readonly EvidenceClaimRecord[];
    supersededIds: readonly string[];
    now: Date;
  }): void;
  /**
   * That we already asked, and what asking yielded.
   *
   * The piece without which shared claims save nothing: sources genuinely do not
   * publish everything, so "every question answered" is almost never true and a
   * warm run would re-buy the same fruitless search forever. What is true is
   * that we looked, recently, under this contract.
   */
  loadAttempts(subjectKeys: readonly string[]): Map<string, ResearchAttempt>;
  saveAttempts(input: { attempts: readonly ResearchAttempt[]; now: Date }): void;
  /** Shared answers for context-independent paths, keyed by their claim set. */
  loadFactSets(keys: readonly string[]): Map<string, ResolvedFact>;
  saveFactSets(input: {
    entries: readonly { key: string; subjectKey: string; resolved: ResolvedFact }[];
    now: Date;
  }): void;
}

export interface CompilerProviders {
  resolver: DestinationResolver;
  /** Durable claims, where this build has somewhere to keep them. */
  claims?: SharedClaimStore;
  /**
   * The place backbone, where this build has one.
   *
   * Optional because a provider set can legitimately supply candidates
   * directly — the synthetic worlds do, and so would a hosted extraction
   * service that returned finished candidates. When it is present the pipeline
   * builds a pack first and every later stage reads from it; when it is absent
   * the pack stages are recorded as skipped, which is a visible state rather
   * than a silent branch.
   */
  regionPack?: RegionPackProvider;
  expansion: RegionExpansionProvider;
  places: PlaceDiscoveryProvider;
  constraints: ConstraintResearchProvider;
  routing: RoutingProvider;
  weatherLocations: WeatherLocationProvider;
  food: FoodDiscoveryProvider;
  /**
   * The research funnel, in three parts.
   *
   * Three interfaces rather than one because they fail independently and cost
   * differently: search is billed per query, retrieval is billed in bytes and
   * seconds, extraction is billed in tokens. A compiler that could only report
   * "research failed" could not tell a traveller that we found the museum's site
   * and could not read it — which is a different sentence, and a truer one.
   */
  sourceDiscovery: SourceDiscoveryProvider;
  retrieval: SourceRetrievalProvider;
  extraction: FactExtractionProvider;
}
