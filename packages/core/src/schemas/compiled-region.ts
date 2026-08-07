import { z } from 'zod';
import { accessDatasetSchema, transportModeSchema } from './access';
import { coordinatesSchema, isoDateSchema } from './common';
import { displayNameSchema } from '../naming/display-name';
import { foodDatasetSchema } from './food';
import { regionEvidenceSchema } from './evidence';
import { destinationEntityTypeSchema, scopeBreadthSchema } from './geography';
import { operatingHoursDatasetSchema } from './hours';
import { placeSchema } from './place';
import { regionSchema } from './region';
import { dataLicenceSchema } from './licence';
import { geographicScopeSchema } from './scope';
import { retrievedPageSchema, sourceManifestSchema } from './source-fact';
import { weatherLocationSchema } from './weather';

/**
 * THE ARTIFACT.
 *
 * Everything a region contributes to planning, frozen at a moment, with the
 * evidence it was built from and an honest account of what it does not contain.
 *
 * The shape is not an invention: it is `RegionContext` — the thing the web app
 * already assembles by hand for the Eastern Sierra — plus the four things a
 * *compiled* region needs and an authored one does not: where each fact came
 * from, which bases and subregions were considered, what the coverage actually
 * is, and what it cost to find out.
 *
 * One deliberate omission. Weather is **not** in here; weather *locations* are.
 * A forecast is trip-dated and hours-fresh, and baking one into a snapshot that
 * is cached and reused across trips is how a September traveller is shown an
 * August forecast. The compiled region says where to ask; the trip asks.
 *
 * A second deliberate omission, and this one is a licensing constraint rather
 * than a design preference. Nothing here may be a copy of a structured
 * provider's display content — names, addresses, hours and ratings from a
 * commercial places API are not ours to keep. What is stored is our own
 * extracted facts with their own citations, open-licensed geodata with its
 * attribution, and provider *identifiers*. See `.claude-private/research`.
 *
 * ---
 *
 * THE BOUNDARY. SEMANTIC HERE; OPERATIONAL ON THE RUN.
 *
 * The rule, stated so it can be checked rather than remembered:
 *
 * > **A semantic artifact must not change because one run had a cache hit and
 * > another had a cache miss, because one worker made fewer calls, because a
 * > provider retried, because a compile happened later, or because one machine
 * > was slower.**
 *
 * Two builds of the same ground, from the same sources, with the same injected
 * clock, must produce the same bytes. `determinism.test.ts` compiles twice
 * against **one** shared evidence store — cold, then warm — and asserts exactly
 * that. It is the arbiter; this comment is only its explanation.
 *
 * | Stays here | Why |
 * | --- | --- |
 * | `region`, `scope`, `bases`, `places`, `access`, `operatingHours`, `weatherLocations`, `food`, `travelTimes`, `basePortfolio`, `evidence`, `coverage` | the frozen trip |
 * | `sourceManifest.facts`, `.attributions` | source provenance, including source-observation timestamps — a fact's `retrievedAt` is when the *content* was seen, not when this run ran |
 * | `sourceManifest.pages` | the pages the retained facts rest on, derived from them, so a warm build lists the same pages as a cold one |
 * | `sourceManifest.providers[].name`, `.version` | which sources this rests on, and under which contract |
 * | `licences`, `regionPack`, `scopeFingerprint` | what it was built from, and under what terms |
 * | `diagnostics.compilerVersion`, `.promptVersions` | what produced it |
 * | `diagnostics.startedAt`, `.finishedAt`, `createdAt` | the **injected** clock, advanced one step per stage — reproducible by construction, and never presented as a duration |
 * | `diagnostics.warnings` | statements about what this artifact does and does not contain |
 * | `routingDiagnostics` | derived from the routing *plan* — which pairs this artifact needed and which of them could not be measured. Not what the transport cost: a cached leg is still a requested leg |
 *
 * | Moved to the run | Why it could not stay |
 * | --- | --- |
 * | `diagnostics.budget.consumed` | a warm store spends fewer searches, pages, model calls and bytes for identical content |
 * | `diagnostics.budget.limits` | a ceiling is a property of the run's configuration, and it travels with the spend it bounds |
 * | `diagnostics.budget.exhausted` | derived from `consumed` against `limits`, so it inherits the warmth |
 * | `claimsHeld`, `claimsObserved`, `claimsSuperseded`, `subjectsAnsweredFromClaims`, `sharedResolutionsReused` | reuse counters — literally a measure of how warm the store was |
 * | `diagnostics.stageCount`, `.stageTimings` | which stages ran depends on which providers were configured, which is an operational fact |
 * | `sourceManifest.providers[].calls`, `.failures` | provider call counts. `calls` was `ledger.spent(...)`, which is the same warmth again |
 * | the retrieval log — bytes read, titles as fetched, pages that were refused | what this run downloaded. A warm build downloads almost nothing and rests on exactly the same pages |
 *
 * All of it is kept — on `CompileResult.operational`, persisted as the job's
 * operational diagnostics. Nothing is lost; it is filed where it is true.
 *
 * Every moved field stays **optional and permissive on read**. Artifacts
 * compiled before the split carry theirs and must keep parsing and rendering
 * exactly as they did: a migration that rewrote them would be editing somebody's
 * stored trip to make a schema tidier.
 */

/**
 * A base the traveller sleeps in, with the dates it covers.
 *
 * Dates rather than an index, because the planner's question is always "which
 * base is this day" and an index answers it only if every consumer agrees about
 * how nights map onto days — which is exactly the kind of shared assumption
 * that drifts.
 */
export const baseAssignmentSchema = z.object({
  clusterId: z.string().min(1),
  baseId: z.string().min(1),
  baseName: z.string().min(1),
  order: z.number().int().nonnegative(),
  nights: z.number().int().nonnegative(),
  fromDate: isoDateSchema,
  toDate: isoDateSchema,
  /** Measured minutes from the previous base. Zero for the first. */
  transferMinutesFromPrevious: z.number().nonnegative(),
  transferIsWholeDay: z.boolean(),
});
export type StoredBaseAssignment = z.infer<typeof baseAssignmentSchema>;

export const basePortfolioSchema = z.object({
  bases: z.array(baseAssignmentSchema).default([]),
  excluded: z
    .array(
      z.object({
        clusterId: z.string().min(1),
        name: z.string().min(1),
        reason: z.string().min(1),
        /** True when routing could not connect it, rather than it not fitting. */
        unreachable: z.boolean(),
      }),
    )
    .default([]),
  transferDays: z.number().nonnegative(),
  rationale: z.string().min(1),
});
export type StoredBasePortfolio = z.infer<typeof basePortfolioSchema>;

export const routingDiagnosticsSchema = z.object({
  /** Ordered pairs the plan intended to buy. */
  plannedPairs: z.number().int().nonnegative(),
  /** What one flat all-pairs matrix would have cost, for comparison. */
  flatPairs: z.number().int().nonnegative(),
  requestedPairs: z.number().int().nonnegative(),
  /** Cross-area cells composed through the bases from measured legs. */
  composedPairs: z.number().int().nonnegative(),
  providerCalls: z.number().int().nonnegative(),
  clusters: z.number().int().nonnegative(),
  reductions: z.array(z.string().min(1)).default([]),
  failedClusters: z
    .array(z.object({ clusterId: z.string().min(1), name: z.string().min(1), reason: z.string().min(1) }))
    .default([]),
});
export type RoutingDiagnostics = z.infer<typeof routingDiagnosticsSchema>;

export const COMPILED_REGION_VERSION = 1 as const;

/** What a base is for. A trip has one primary base; the rest hang off it. */
export const BASE_ROLES = [
  'primary_base',
  'secondary_base',
  'arrival_gateway',
  'departure_gateway',
  'satellite',
] as const;
export const baseRoleSchema = z.enum(BASE_ROLES);
export type BaseRole = z.infer<typeof baseRoleSchema>;

export const BASE_ROLE_LABELS: Record<BaseRole, string> = {
  primary_base: 'Where you sleep',
  secondary_base: 'A second base',
  arrival_gateway: 'Where you arrive',
  departure_gateway: 'Where you leave from',
  satellite: 'Somewhere you go from a base',
};

/**
 * Somewhere the traveller could sleep, and what sleeping there buys them.
 *
 * Never chosen by popularity. A base earns its place by how much of the region
 * it puts within reach, what it costs to get to, and whether the transport the
 * traveller actually has can serve it — which is why `placesWithinReach` and
 * `medianMinutesToReach` are computed from the travel-time evidence rather than
 * asserted.
 */
export const baseCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  coordinates: coordinatesSchema,
  role: baseRoleSchema,
  /** Matrix id. Days start and end here. */
  routingId: z.string().min(1),
  /**
   * The resolved name, English-first, with the native form beside it.
   *
   * Optional, and that is the whole compatibility story: every artifact
   * compiled before this existed has a bare `name` and renders through
   * `displayNameOf`, which falls back to it. Nothing re-derives a name for an
   * old artifact — changing how a stored plan reads is not a presentation fix,
   * it is rewriting somebody's trip.
   */
  names: displayNameSchema.optional(),
  /** IANA zone for this base, not for the region. */
  timeZone: z.string().min(1),
  subregionId: z.string().min(1).optional(),
  /** Nights this base is worth on its own. */
  suggestedNights: z.object({
    min: z.number().int().min(1).max(30),
    max: z.number().int().min(1).max(30),
  }),
  /** Place ids reachable from here inside the traveller's detour tolerance. */
  placesWithinReach: z.array(z.string().min(1)).default([]),
  /** Computed from the matrix, not authored. */
  medianMinutesToReach: z.number().min(0).optional(),
  /** How you get around once you are here. */
  transportModes: z.array(transportModeSchema).min(1),
  /**
   * Whether anyone has actually established that you can stay here.
   *
   * `unknown` is the honest default and the common one: we do not hold lodging
   * inventory, and a base is a *geographic* recommendation. Claiming a town has
   * hotels because it is a town is exactly the kind of unsourced confidence this
   * schema exists to prevent.
   */
  lodgingEvidence: z.enum(['sourced', 'unknown']).default('unknown'),
  /** Minutes to get here from the previous base or gateway. */
  transferMinutes: z.number().min(0).optional(),
  /** Why this base and not another. */
  rationale: z.string().min(1),
  tradeoffs: z.array(z.string().min(1)).default([]),
  /** `SourceFact` ids backing any claim above. */
  evidenceFactIds: z.array(z.string().min(1)).default([]),
});
export type BaseCandidate = z.infer<typeof baseCandidateSchema>;

export const subregionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Resolved name. Optional for the same compatibility reason as on a base. */
  names: displayNameSchema.optional(),
  summary: z.string().min(1),
  center: coordinatesSchema,
  /** How far this subregion reaches from its centre. */
  radiusKm: z.number().positive().max(1000),
  entityType: destinationEntityTypeSchema,
  breadth: scopeBreadthSchema,
  baseIds: z.array(z.string().min(1)).default([]),
  placeIds: z.array(z.string().min(1)).default([]),
  suggestedNights: z.object({
    min: z.number().int().min(0).max(30),
    max: z.number().int().min(0).max(30),
  }),
  /** Months this is worth visiting, where anything is known. Empty = unknown. */
  bestMonths: z.array(z.number().int().min(1).max(12)).default([]),
  evidenceFactIds: z.array(z.string().min(1)).default([]),
});
export type Subregion = z.infer<typeof subregionSchema>;

/** Somewhere reachable from a base, with an honest verdict on the detour. */
export const satelliteCandidateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentBaseId: z.string().min(1),
  subregionId: z.string().min(1).optional(),
  placeIds: z.array(z.string().min(1)).default([]),
  /** One-way, from the parent base. From the matrix. */
  minutesFromBase: z.number().min(0),
  /** How long a visit is worth, where that is known. */
  suggestedMinutes: z.number().int().min(0).optional(),
  requiredModes: z.array(transportModeSchema).default([]),
  seasonalMonths: z.array(z.number().int().min(1).max(12)).default([]),
  evidenceFactIds: z.array(z.string().min(1)).default([]),
});
export type SatelliteCandidate = z.infer<typeof satelliteCandidateSchema>;

/**
 * A travel-time matrix, as data rather than as a live object.
 *
 * Structurally identical to `TravelTimeMatrix` in `@sidequest/geo`, which is a
 * plain interface with no schema — fine while a matrix was a constant in a
 * module, not fine once one is written to a database and read back. The two are
 * kept in step by a test rather than by a shared definition, because `geo` is
 * deliberately dependency-free and importing Zod into it to validate a thing it
 * only computes would be the tail wagging the dog.
 */
export const travelTimeMatrixSchema = z.object({
  mode: z.enum(['car', 'foot', 'transit']),
  ids: z.array(z.string().min(1)).min(1),
  minutes: z.array(z.array(z.number().min(0))),
  km: z.array(z.array(z.number().min(0))),
  provenance: z.object({
    kind: z.enum(['measured', 'modelled', 'estimated']),
    note: z.string().min(1),
    source: z.string().min(1).optional(),
  }),
});
export type TravelTimeMatrixData = z.infer<typeof travelTimeMatrixSchema>;

/**
 * WHAT WE KNOW, PER LAYER.
 *
 * Sixteen dimensions rather than one score, because "92% confident" is not a
 * thing anyone can act on and the layers fail independently. A region can have
 * excellent geography and no opening hours at all; that is a usable trip with a
 * caution, and it is a completely different situation from one with good hours
 * and no route data, which cannot be planned at all.
 */
export const COVERAGE_DIMENSIONS = [
  'geographic_resolution',
  'places',
  'candidate_quality',
  'mainstream_attractions',
  'hidden_gems',
  'natural_features',
  'operating_hours',
  'access_evidence',
  'booking',
  'cost',
  'transportation',
  'road_routing',
  'walking_routing',
  'transit_routing',
  'ferry_or_rail',
  'weather',
  'food',
  'dietary_evidence',
  'safety',
  'temporary_access',
  'official_sources',
  'source_freshness',
  'planner_readiness',
] as const;
export const coverageDimensionSchema = z.enum(COVERAGE_DIMENSIONS);
export type CoverageDimension = z.infer<typeof coverageDimensionSchema>;

export const COVERAGE_DIMENSION_LABELS: Record<CoverageDimension, string> = {
  geographic_resolution: 'Where this is',
  places: 'Places',
  candidate_quality: 'How much we know about them',
  mainstream_attractions: 'The well-known ones',
  hidden_gems: 'The quiet ones',
  natural_features: 'Landscape',
  operating_hours: 'Opening hours',
  access_evidence: 'Getting in',
  booking: 'Booking and permits',
  cost: 'Prices',
  transportation: 'Getting around',
  road_routing: 'Driving times',
  walking_routing: 'Walking times',
  transit_routing: 'Public transport',
  ferry_or_rail: 'Ferries and trains',
  weather: 'Weather',
  food: 'Food',
  dietary_evidence: 'Dietary information',
  safety: 'Cautions and preparation',
  temporary_access: 'Closures and permits',
  official_sources: 'Official sources',
  source_freshness: 'How recently we checked',
  planner_readiness: 'Enough to build a plan',
};

/**
 * Five levels, and `not_applicable` is load-bearing.
 *
 * A landlocked region has no ferry coverage and that is not a gap. Reporting it
 * as `unavailable` would put an amber row on a report that is otherwise clean,
 * and a report where every region has warnings is a report nobody reads.
 */
export const COVERAGE_LEVELS = [
  'high',
  'usable_with_cautions',
  'weak',
  'unavailable',
  'not_applicable',
] as const;
export const coverageLevelSchema = z.enum(COVERAGE_LEVELS);
export type CoverageLevel = z.infer<typeof coverageLevelSchema>;

export const COVERAGE_LEVEL_LABELS: Record<CoverageLevel, string> = {
  high: 'Good',
  usable_with_cautions: 'Usable, with cautions',
  weak: 'Thin',
  unavailable: 'Nothing',
  not_applicable: 'Not relevant here',
};

/** Machine-readable, so the UI and the validator branch on the same values. */
export const COVERAGE_REASONS = [
  'no_provider_configured',
  'provider_unavailable',
  'provider_rate_limited',
  'budget_exhausted',
  'no_results_returned',
  'partial_results_returned',
  'no_official_source_found',
  'sources_conflict',
  'evidence_stale',
  'inferred_not_sourced',
  'not_relevant_to_region',
  'fully_covered',
] as const;
export const coverageReasonSchema = z.enum(COVERAGE_REASONS);
export type CoverageReason = z.infer<typeof coverageReasonSchema>;

export const COVERAGE_REASON_COPY: Record<CoverageReason, string> = {
  no_provider_configured: 'No source is configured for this yet.',
  provider_unavailable: 'The source did not answer.',
  provider_rate_limited: 'The source asked us to slow down.',
  budget_exhausted: 'We ran out of lookups for this trip before finishing.',
  no_results_returned: 'We looked and found nothing.',
  partial_results_returned: 'We found some of it.',
  no_official_source_found: 'Nobody official publishes this.',
  sources_conflict: 'Sources disagree and we kept both.',
  evidence_stale: 'What we have was read a while ago.',
  inferred_not_sourced: 'Worked out rather than looked up.',
  not_relevant_to_region: 'Does not apply here.',
  fully_covered: 'Covered.',
};

/**
 * The six words a coverage row is allowed to be described with.
 *
 * Derived rather than stored, because a level and a reason already carry it and
 * a third field would be a third thing to keep in step. `conflicted` and `stale`
 * outrank the level: a row that is 90% covered and disagrees with itself is not
 * "good", and a row read eighteen months ago is not "sufficient" today.
 */
export const EVIDENCE_GRADES = [
  'sufficient',
  'partial',
  'weak',
  'conflicted',
  'stale',
  'none',
] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export const EVIDENCE_GRADE_LABELS: Record<EvidenceGrade, string> = {
  sufficient: 'Verified',
  partial: 'Partly verified',
  weak: 'Weakly supported',
  conflicted: 'Sources disagree',
  stale: 'Checked a while ago',
  none: 'Nothing found',
};

export function evidenceGrade(report: {
  level: CoverageLevel;
  reasons: readonly CoverageReason[];
}): EvidenceGrade {
  if (report.reasons.includes('sources_conflict')) return 'conflicted';
  if (report.reasons.includes('evidence_stale')) return 'stale';
  switch (report.level) {
    case 'high':
      return 'sufficient';
    case 'usable_with_cautions':
      return 'partial';
    case 'weak':
      return 'weak';
    case 'unavailable':
      return 'none';
    default:
      return 'sufficient';
  }
}

export const coverageDimensionReportSchema = z.object({
  dimension: coverageDimensionSchema,
  level: coverageLevelSchema,
  reasons: z.array(coverageReasonSchema).min(1),
  /** One sentence, in the product's voice, naming the actual numbers. */
  detail: z.string().min(1),
  /** How many subjects needed this, and how many got it. Absent where it is not a count. */
  expected: z.number().int().min(0).optional(),
  covered: z.number().int().min(0).optional(),
});
export type CoverageDimensionReport = z.infer<typeof coverageDimensionReportSchema>;

export const coverageReportSchema = z.object({
  dimensions: z.array(coverageDimensionReportSchema).min(1),
  /**
   * Whether a deterministic itinerary can be built at all.
   *
   * Not a judgement call: it is true exactly when a dimension the planner cannot
   * proceed without came back `unavailable`. Everything else is a caution.
   */
  blocksItinerary: z.boolean(),
  blockingDimensions: z.array(coverageDimensionSchema).default([]),
  /** Facts whose shelf life has run out and that a traveller should recheck. */
  recheckFactIds: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1),
});
export type CoverageReport = z.infer<typeof coverageReportSchema>;

/**
 * What produced this artifact, and what it does not contain.
 *
 * No longer what it cost. See the boundary table in the file header: the spend,
 * the ceilings and the stage sequence are properties of a *run* and live on the
 * job's operational diagnostics, because two builds of one region produce the
 * same region and wildly different numbers.
 */
export const compilationDiagnosticsSchema = z.object({
  compilerVersion: z.string().min(1),
  /**
   * The injected clock, not a wall clock.
   *
   * `startedAt` is the `now` the compilation was given and `finishedAt` is that
   * plus one step per stage, so two runs of one input stamp the same pair. It
   * is deliberately **not** a duration and nothing may read it as one — the
   * artifact used to carry a per-stage `ms: 1` (the step size, hard-coded,
   * presented as a measurement) and the progress screen multiplied that median
   * out and told somebody their four-minute build had "roughly 0s–0s to go".
   * Real durations are measured on a real clock in `stage_observations`.
   */
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  /**
   * How many stages ran. **Operational, and no longer written.**
   *
   * Which stages a build runs depends on which providers it was configured
   * with — a build with no backbone provider records four fewer than one with
   * — so the count is a fact about the run rather than about the region. It
   * lives on `CompileResult.operational.stages` now.
   *
   * Optional rather than removed, and read permissively: an artifact compiled
   * before the split carries one and must keep parsing untouched.
   */
  stageCount: z.number().int().min(0).optional(),
  /**
   * Which stages ran, in the order they ran. **Operational, and no longer
   * written** — same reason as `stageCount`, and kept for the same artifacts.
   */
  stageTimings: z.array(z.object({ stage: z.string().min(1) })).optional(),
  /**
   * What this build spent against its ceilings. **Operational, and no longer
   * written.**
   *
   * This is the field the determinism test was written for. `consumed` counts
   * searches, pages, bytes, model calls and extraction calls — every one of
   * which a warm shared store reduces to zero for *identical* content — and
   * `exhausted` is derived from `consumed` against `limits`, so it inherits the
   * same dependency. Two compilations of one region against a store that was
   * empty the first time and full the second therefore persisted different
   * bytes for the same trip.
   *
   * `consumed` and `limits` stay a permissive `Record<string, number>` so that
   * an artifact carrying the old folded-in reuse counters — `claimsHeld`,
   * `sharedResolutionsReused` and the rest — still parses and still renders.
   * Nothing rewrites them.
   */
  budget: z
    .object({
      /** Every counter that has a ceiling, and where it got to. */
      consumed: z.record(z.string(), z.number().int().min(0)),
      limits: z.record(z.string(), z.number().int().min(0)),
      exhausted: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  /** Prompt versions, so a compiled artifact can be traced to what produced it. */
  promptVersions: z.record(z.string(), z.string()).default({}),
  warnings: z.array(z.string().min(1)).default([]),
});
export type CompilationDiagnostics = z.infer<typeof compilationDiagnosticsSchema>;

/**
 * The source manifest, as an *artifact* carries it.
 *
 * Identical to `sourceManifestSchema` but for the two counters on each provider
 * entry. `calls` was `ledger.spent('maxSourceSearches')` and its friends —
 * warmth-dependent by construction — and `failures` counted this run's refusals.
 * Which providers were consulted, and under which version, is provenance and
 * stays; how many times each was reached is a fact about the run.
 *
 * Optional rather than removed so every artifact compiled before the split
 * parses unchanged, including the authored Eastern Sierra fixture.
 */
export const artifactSourceManifestSchema = sourceManifestSchema.extend({
  /**
   * The pages this artifact's facts rest on — not the pages this run fetched.
   *
   * The distinction is the whole of the defect. `pages` used to be the
   * *retrieval log*: whatever this compilation happened to download. A warm
   * build answers most of its subjects from durable claims and never calls
   * retrieval for them, so the same region compiled twice listed thirty-three
   * pages the first time and nine the second — and the nine were not a smaller
   * region, they were a smaller *bill*. Worse, the warm artifact then
   * understated what it rests on, which is the opposite of what a provenance
   * list is for.
   *
   * It is now derived from the retained facts, so it names every page behind
   * every fact whether this run read it or held it, and two builds of one
   * region list the same pages.
   *
   * `contentBytes` is optional for the same reason and is no longer written: a
   * page held as a claim has a URL, a content hash and a content-observation
   * timestamp, and nobody measured how many bytes it was *this* time. Byte
   * counts, page titles as fetched, and pages that were refused are the
   * retrieval log, and the retrieval log is on the run.
   */
  pages: z
    .array(
      z.object({
        url: retrievedPageSchema.shape.url,
        title: z.string().min(1).optional(),
        /** When the *content* was observed. A source clock, never a run clock. */
        retrievedAt: z.string().min(1),
        /** Operational. Present on older artifacts, never written now. */
        contentBytes: z.number().int().min(0).optional(),
        contentHash: z.string().min(1).optional(),
        robotsAllowed: z.boolean(),
      }),
    )
    .default([]),
  providers: z
    .array(
      z.object({
        name: z.string().min(1),
        /** e.g. `places:v1`, `routes:v2`, `claude-opus-5`. */
        version: z.string().min(1),
        /** Operational. Present on older artifacts, never written now. */
        calls: z.number().int().min(0).optional(),
        failures: z.number().int().min(0).optional(),
      }),
    )
    .default([]),
});
export type ArtifactSourceManifest = z.infer<typeof artifactSourceManifestSchema>;

export const compiledRegionSchema = z.object({
  schemaVersion: z.literal(COMPILED_REGION_VERSION),
  /** Stable id for this artifact. A recompile produces a new one. */
  id: z.string().min(1),
  compilerVersion: z.string().min(1),

  /**
   * The region in the shape the existing engine already consumes. Keeping this
   * rather than inventing a parallel type is what lets a compiled region and the
   * authored Eastern Sierra fixture reach the planner through one door.
   */
  region: regionSchema,
  scope: geographicScopeSchema,
  /** Ties the artifact to the exact scope revision that produced it. */
  scopeFingerprint: z.string().min(1),
  /**
   * WHAT THE SUPPLY LOOKED LIKE WHEN THIS BOARD WAS BUILT.
   *
   * Persisted **with the artifact**, and that is the requirement rather than an
   * optimisation: the board's own integrity has to render the same after a
   * refresh and with every provider switched off, and a number recomputed at
   * render time from whatever happens to be reachable is a different number.
   *
   * Optional, so an artifact compiled before this existed still parses and its
   * board simply omits these facts rather than inventing zeros for them. A
   * counted zero and an uncounted one are different claims — "we set aside no
   * practical stops" and "nobody counted" — and only the first is worth saying.
   */
  boardSupply: z
    .object({
      /** Practical stops the inventory kept apart from the board. */
      supportKeptSeparately: z.number().int().nonnegative(),
      /** Admitted, and withheld from final slots because nobody could place them. */
      withheldUnplaceable: z.number().int().nonnegative(),
      /** Removed before ranking for sitting outside the chosen ground. */
      removedOutOfScope: z.number().int().nonnegative(),
      /** Kept as ways in and out, never as things to do. */
      gateways: z.number().int().nonnegative(),
      /** Deliberately included by a regional expansion. */
      expansionMembers: z.number().int().nonnegative(),
      /** Offered as optional side trips, still labelled as such. */
      satellites: z.number().int().nonnegative(),
    })
    .optional(),

  bases: z.array(baseCandidateSchema).min(1),
  primaryBaseId: z.string().min(1),
  subregions: z.array(subregionSchema).default([]),
  satellites: z.array(satelliteCandidateSchema).default([]),

  places: z.array(placeSchema),
  access: accessDatasetSchema,
  operatingHours: operatingHoursDatasetSchema,
  /** Where to ask about weather. Not the weather itself — see the file header. */
  weatherLocations: z.array(weatherLocationSchema),
  /** Absent and empty are different answers, and the planner reads them differently. */
  food: foodDatasetSchema.optional(),
  travelTimes: travelTimeMatrixSchema,

  /**
   * The multi-base structure this region was routed and planned as.
   *
   * Optional, and that is the migration story: every artifact compiled before
   * hierarchical routing existed has no portfolio, which reads correctly as
   * "one base, no transfers" — the shape those regions actually had. Nothing
   * re-derives it, so an old plan is never reinterpreted.
   *
   * When present it is the *contract* the planner is held to rather than
   * display metadata: it says which base each date belongs to, which dates are
   * transfers, and which areas were left out with the reason. The previous
   * slice's four proposed bases were a list on a screen nothing read.
   */
  basePortfolio: basePortfolioSchema.optional(),

  /**
   * What routing this artifact needed, so the saving is auditable rather than
   * claimed.
   *
   * An operator's numbers, not a traveller's, and kept out of coverage on
   * purpose: how many pairs were bought says nothing about how good the region
   * is, and mixing the two is how a cheap build starts looking like a confident
   * one.
   *
   * It stays on the artifact where the budget counters left, and the reason is
   * the boundary rather than an exception to it: every field here is derived
   * from the routing **plan** — which pairs this artifact's own point set
   * required, which of them one flat matrix would have cost, which were composed
   * rather than measured, and which clusters could not be connected. A leg
   * served from a cache is still a leg this artifact needed. Nothing in here
   * moves when the store is warm, which is what the determinism test checks.
   */
  routingDiagnostics: routingDiagnosticsSchema.optional(),

  /**
   * What official sources said, resolved into typed facts.
   *
   * Optional because every artifact compiled before this layer existed is still
   * a valid artifact — it simply has nothing here, which is the honest reading
   * of a compilation that never researched anything. Absent and empty are again
   * different: absent means the stage did not run, empty means it ran and found
   * nothing.
   */
  evidence: regionEvidenceSchema.optional(),

  /**
   * Which region pack, from which data release, this artifact was built on.
   *
   * A summary rather than the pack itself: the pack is megabytes of source
   * records and lives in its own row, while what an artifact has to be able to
   * answer for is *which* pack and *which* release — so a plan compiled in July
   * can still say what it was built from after the catalogue has moved on twice.
   *
   * Optional, because artifacts compiled before the backbone existed are still
   * valid artifacts and did not come from a pack.
   */
  regionPack: z
    .object({
      packId: z.string().min(1),
      scopeHash: z.string().min(1),
      contentHash: z.string().min(1),
      state: z.string().min(1),
      catalog: z.string().min(1),
      releaseId: z.string().min(1),
      /** Records the pack held, not records that reached the plan. */
      recordCount: z.number().int().min(0),
      builtAt: z.string().min(1),
      /** True when the pack was reused rather than built for this compilation. */
      reused: z.boolean(),
    })
    .optional(),

  sourceManifest: artifactSourceManifestSchema,
  /**
   * Every licence the contents came under.
   *
   * On the artifact rather than only on each fact, because the obligations are
   * about the artifact: what must be shown beside it, and whether publishing a
   * database derived from it triggers share-alike. A compiled region with an
   * empty list is one nothing durable was stored in.
   */
  licences: z.array(dataLicenceSchema).default([]),
  coverage: coverageReportSchema,
  diagnostics: compilationDiagnosticsSchema,

  createdAt: z.string().min(1),
  /** When the artifact should be rebuilt. Absent for authored fixtures. */
  expiresAt: z.string().min(1).optional(),
});
export type CompiledRegion = z.infer<typeof compiledRegionSchema>;

/**
 * Dimensions a deterministic plan genuinely cannot be built without.
 *
 * Deliberately short. Weather, food, hidden gems and official sources all
 * degrade to a caution — the product already knows how to plan without them and
 * how to say so. Geography, places and road routing do not degrade: without
 * them there is nothing to order and no way to order it.
 */
export const ITINERARY_BLOCKING_DIMENSIONS: readonly CoverageDimension[] = [
  'geographic_resolution',
  'places',
  'road_routing',
];

/**
 * Coverage is computed, never authored — including whether it blocks.
 *
 * `road_routing` is only blocking when the traveller is actually driving; a
 * car-free city trip that has walking and transit times is perfectly plannable
 * with no road data at all, and marking it blocked would be the single most
 * Mammoth-shaped mistake this file could make.
 */
export function computeBlocking(
  dimensions: readonly CoverageDimensionReport[],
  options: { drivingPlanned: boolean },
): { blocksItinerary: boolean; blockingDimensions: CoverageDimension[] } {
  const blocking = dimensions
    .filter((report) => {
      if (!ITINERARY_BLOCKING_DIMENSIONS.includes(report.dimension)) return false;
      if (report.dimension === 'road_routing' && !options.drivingPlanned) return false;
      return report.level === 'unavailable';
    })
    .map((report) => report.dimension);

  // A car-free trip still needs *some* way to measure a leg. When driving is
  // not planned, walking or transit routing takes road routing's place as the
  // thing that cannot be missing.
  if (!options.drivingPlanned) {
    const walking = dimensions.find((report) => report.dimension === 'walking_routing');
    const transit = dimensions.find((report) => report.dimension === 'transit_routing');
    const neitherUsable =
      (!walking || walking.level === 'unavailable') && (!transit || transit.level === 'unavailable');
    if (neitherUsable) blocking.push('walking_routing');
  }

  return { blocksItinerary: blocking.length > 0, blockingDimensions: blocking };
}

export function coverageFor(
  report: CoverageReport,
  dimension: CoverageDimension,
): CoverageDimensionReport | undefined {
  return report.dimensions.find((entry) => entry.dimension === dimension);
}

export function baseById(region: CompiledRegion, baseId: string): BaseCandidate | undefined {
  return region.bases.find((base) => base.id === baseId);
}
