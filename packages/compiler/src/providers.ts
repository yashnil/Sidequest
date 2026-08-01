import type {
  AccessRule,
  DataLicence,
  ConfidenceSignal,
  DestinationResolution,
  GeographicScope,
  OperatingCalendar,
  Place,
  ProviderRef,
  SourceFact,
  TravelerProfile,
  TransportMode,
  TransportService,
  WeatherLocation,
  FoodVenue,
} from '@sidequest/core';
import type { TravelMode } from '@sidequest/geo';

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
  }): Promise<DiscoveryResult>;
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
export interface CompilerProviders {
  resolver: DestinationResolver;
  expansion: RegionExpansionProvider;
  places: PlaceDiscoveryProvider;
  constraints: ConstraintResearchProvider;
  routing: RoutingProvider;
  weatherLocations: WeatherLocationProvider;
  food: FoodDiscoveryProvider;
}
