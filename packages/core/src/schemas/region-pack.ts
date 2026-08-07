import { z } from 'zod';
import { coordinatesSchema, httpUrlSchema } from './common';
import { geoBoundsSchema } from './geography';
import { geographicEvidenceSchema } from './geographic-evidence';
import { dataLicenceSchema, licenceIdSchema } from './licence';

/**
 * THE REGION PACK — BOUNDED, RELEASE-VERSIONED SOURCE DATA FOR ONE SCOPE.
 *
 * A pack is **not** a compiled region. It is the layer underneath one: the raw,
 * normalised, provenance-preserving geographic inventory a compilation needs
 * before it decides anything. The separation exists because the two halves age
 * at completely different rates.
 *
 * Where a mountain is, what a museum is called and which borough contains it
 * change on the scale of years. When that museum opens, what it costs and
 * whether the road to the mountain is shut change on the scale of days. Phase 8
 * bought both together, per trip, from a service that could refuse — so a
 * destination could fail at the *first* question and never reach the second, and
 * two travellers going to the same city paid twice for the same coastline.
 *
 * A pack fixes the ordering. It is:
 *
 * - **immutable** — never updated in place, only superseded;
 * - **release-versioned** — pinned to one upstream data release for the whole
 *   build, so the same inputs reproduce the same bytes;
 * - **layered** — records stay in the layer they came from, under that layer's
 *   own licence, because merging a share-alike source into a permissive one
 *   creates an obligation nobody chose;
 * - **bounded** — every scan is capped in files, row groups, bytes, features and
 *   seconds, and what the caps cost is recorded rather than hidden.
 *
 * What a pack must never contain: an invented opening time, a guessed visit
 * duration, a model's opinion presented as a fact, an itinerary decision, an
 * unsupported safety claim, a credential, or a wholesale copy of a provider's
 * response when a bounded subset was what we needed.
 */

/**
 * Bumped to **3** when containment moved out of the pack, once for the whole
 * closure rather than once per fix.
 *
 * A pack no longer carries a verdict at all. It carries *typed geographic
 * evidence*, which is traveller-independent and therefore genuinely cacheable,
 * and the verdict is decided by a trip-scope overlay after the destination
 * identity, the scope strategy and the regional expansion are all known. A
 * version 2 pack has neither the evidence nor a verdict this codebase can still
 * read, so it stops matching and the next build re-reads the ground.
 *
 * What version 2 was for, kept because the reasoning still holds:
 *
 * ---
 *
 * Bumped to 2 when containment landed, and the bump was the whole fix.
 *
 * A pack is cached on `packScopeHash`, which is version + candidate id + bounds.
 * `scopeFingerprint` gained a `boundaryEvidence` segment, so a *compiled region*
 * correctly misses its cache and rebuilds — and the rebuild was then handed the
 * **pre-containment pack**, whose records carry no `scopeMembership`, which
 * `scopeRelationshipOf` reads as `membership_unknown`, which is admitted to
 * every portfolio slot.
 *
 * In other words: without this line the exact New York board that started this
 * work — twenty-three Berks County records — comes back from cache on the first
 * rebuild after deploy, while the new diagnostics report containment as active.
 * The two caches have to agree about what changed, and only this makes them.
 *
 * Old packs are not migrated or rewritten. They stop matching, and the next
 * build re-reads the ground under the new rules.
 */
export const REGION_PACK_VERSION = 3 as const;

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * What a layer is *for*, rather than who publishes it.
 *
 * Deliberately three kinds and not a list of catalogue names. The compiler cares
 * that a layer is the primary place inventory, or the geographic features a
 * commercial-style catalogue represents poorly, or the administrative geography
 * that answers "which borough is this in" — and it must keep caring about that
 * if the catalogue behind any of them is replaced.
 */
export const SOURCE_LAYER_KINDS = [
  /** The main place catalogue: businesses, attractions, named POIs. */
  'primary_places',
  /**
   * Terrain, water, park and infrastructure features. Separate because place
   * catalogues built from business listings systematically miss peaks,
   * waterfalls, trailheads, beaches and ferry terminals — and because in
   * practice this layer's licence differs from the primary one's.
   */
  'supplemental_geography',
  /** Country → region → locality → neighbourhood, for containment and labels. */
  'administrative_divisions',
] as const;
export const sourceLayerKindSchema = z.enum(SOURCE_LAYER_KINDS);
export type SourceLayerKind = z.infer<typeof sourceLayerKindSchema>;

/**
 * What a record is likely to be *used for* in a plan.
 *
 * Derived deterministically from the source's own category vocabulary — never
 * from a model, never from a destination name. It exists on the pack rather than
 * downstream because it is what makes density-aware retention possible: a scope
 * returning a hundred thousand records has to keep a representative spread of
 * attractions rather than the first row group's worth of dental practices.
 *
 * `support` is load-bearing and easy to mistake for noise. A grocery store, a
 * ferry terminal, a visitor centre and a trailhead are not attractions and are
 * exactly what an outdoor day needs; classifying them separately is what stops
 * them being ranked as attractions *and* stops them being thrown away.
 */
export const PLANNING_ROLES = [
  /** A reason to build a day around it: a museum, a fortress, a gallery. */
  'attraction',
  /**
   * Real, smaller, and worth stopping for on the way to something else.
   *
   * Its own role rather than a low-scoring attraction because the *decision* is
   * different. "Is this worth a morning" and "is this worth ten minutes of
   * detour" are separate questions, and collapsing them is what produced a board
   * where a monument plaque and a national museum competed on one ranking.
   */
  'side_quest',
  /**
   * Weather-bound, daylight-bound, season-bound: trails, peaks, lakes, beaches,
   * viewpoints, parks.
   *
   * Split out of `attraction` because a live measurement forced it. Overture's
   * *place* layer is built from commercial listings and is dense in cities; the
   * *base* layers carry the outdoors and are dense everywhere else. Counting them
   * as one number meant "how much is there to do here" was answered almost
   * entirely by how commercially mapped the largest city was — which is a fact
   * about the data and was being rendered as a fact about the country.
   */
  'outdoor',
  'food',
  /**
   * A market: somewhere to eat *and* a thing to do.
   *
   * The one category that routinely falls between `food` and `attraction`. Given
   * to `food` it never reaches the board; given to `attraction` it never reaches
   * a meal. It is both, so it is neither, so it is its own role.
   */
  'market',
  /** The grocery, the visitor centre, the trailhead car park. */
  'support',
  /**
   * How you arrive and where a base goes: airports, rail and ferry terminals.
   *
   * Distinguished from `support` because a gateway anchors a *region*, not a day.
   * The base portfolio reads these; a day plan never should.
   */
  'gateway',
  'lodging',
  'administrative',
  /**
   * Mapped, real, and never scheduled: pylons, culverts, service roads.
   *
   * Kept rather than dropped, for the same reason `support` is: it is real
   * geography that something later may want, and throwing it away at read time
   * means paying to read it again.
   */
  'infrastructure',
  /** Mapped, real, and not something a traveller plans around. */
  'excluded',
] as const;
export const planningRoleSchema = z.enum(PLANNING_ROLES);
export type PlanningRole = z.infer<typeof planningRoleSchema>;

export const PLANNING_ROLE_LABELS: Record<PlanningRole, string> = {
  attraction: 'Places worth a visit',
  side_quest: 'Side quests',
  outdoor: 'Outdoors and scenery',
  food: 'Food',
  market: 'Markets',
  support: 'Practical stops',
  gateway: 'Ways in and out',
  lodging: 'Somewhere to stay',
  administrative: 'Administrative geography',
  infrastructure: 'Mapped, not planned around',
  excluded: 'Not a trip',
};

/**
 * The roles a traveller chooses *between*.
 *
 * Exported rather than inlined because four separate layers need the same
 * answer — inventory bucketing, supply counting, board grouping and the
 * destination shortlist's diversity check — and four copies of this list is four
 * chances for a car park to be counted as a museum.
 */
export const VISITABLE_ROLES: readonly PlanningRole[] = [
  'attraction',
  'side_quest',
  'outdoor',
  'market',
];

/** Roles that make a day possible without being the reason for it. */
export const SUPPORTING_ROLES: readonly PlanningRole[] = ['food', 'support', 'gateway'];

export function isVisitableRole(role: PlanningRole): boolean {
  return VISITABLE_ROLES.includes(role);
}

/**
 * Whether a role is *eligible* to anchor a day.
 *
 * Eligibility, not a promise. Whether something can actually hold a morning
 * depends on its evidence and on this traveller's fit, both of which arrive
 * later and neither of which belongs in a shared, traveller-independent pack.
 * A side quest is deliberately not eligible: that is what makes it a side quest.
 */
export function roleCanAnchor(role: PlanningRole): boolean {
  return role === 'attraction' || role === 'outdoor' || role === 'market';
}

/**
 * One upstream contributor's claim that this record exists.
 *
 * Plural per record, and **not** treated as independent corroboration. A
 * conflated catalogue merges several providers into one row; we did not watch it
 * merge them, so we cannot say the providers independently agree. What this is
 * for is licence attachment, upstream traceability and freshness.
 */
export const sourceRecordProvenanceSchema = z.object({
  /** The contributing dataset's own name, verbatim: `meta`, `OpenStreetMap`. */
  dataset: z.string().min(1),
  licenceId: licenceIdSchema,
  /** The upstream record's identifier, where the source publishes one. */
  recordId: z.string().min(1).optional(),
  /** The upstream record's own last-changed time. Never ours. */
  updateTime: z.string().min(1).optional(),
  /**
   * The source's own existence confidence, kept verbatim and labelled.
   *
   * This is evidence that an entity *may exist*. It is not traveller fit, travel
   * importance, source corroboration, official verification, safety confidence,
   * opening-hours confidence or a ranking score, and nothing downstream may read
   * it as any of those.
   */
  existenceConfidence: z.number().min(0).max(1).optional(),
});
export type SourceRecordProvenance = z.infer<typeof sourceRecordProvenanceSchema>;

/**
 * Where a record sits in administrative geography.
 *
 * Every field optional, and the optionality is the design: divisions coverage is
 * not uniform worldwide, and a missing neighbourhood polygon must degrade a
 * label rather than invalidate a place whose coordinates and country are known.
 */
export const recordContainmentSchema = z.object({
  countryCode: z.string().length(2).optional(),
  regionName: z.string().min(1).optional(),
  localityName: z.string().min(1).optional(),
  neighbourhoodName: z.string().min(1).optional(),
  /** Division record ids, outermost first, for anything that wants the chain. */
  divisionIds: z.array(z.string().min(1)).default([]),
});
export type RecordContainment = z.infer<typeof recordContainmentSchema>;

/**
 * HOW A RECORD USED TO STAND TO THE GROUND THE TRAVELLER CHOSE.
 *
 * **Legacy, read-only, and never written again.** The authoritative containment
 * vocabulary now lives in `schemas/containment.ts` — one vocabulary, one
 * admission table, one eligibility rule — and the verdict itself is no longer a
 * property of a pack at all. A pack is traveller-independent ground; a verdict
 * about one traveller's destination has no business being cached inside it.
 *
 * This shape survives only so that packs written before that split still parse.
 * Records are read for their *evidence* and re-decided by the trip-scope
 * overlay; this field is ignored.
 */
const LEGACY_SCOPE_RELATIONSHIPS = [
  'inside_scope',
  'inside_selected_division',
  'adjacent_gateway',
  'optional_satellite',
  'outside_scope',
  'membership_unknown',
] as const;

const LEGACY_CONTAINMENT_EVIDENCE = [
  'selected_boundary_geometry',
  'selected_division_geometry',
  'source_administrative_containment',
  'source_division_hierarchy',
  'bounded_geographic_fallback',
  'no_evidence',
] as const;

export const legacyScopeMembershipSchema = z.object({
  relationship: z.enum(LEGACY_SCOPE_RELATIONSHIPS),
  evidence: z.enum(LEGACY_CONTAINMENT_EVIDENCE),
  rung: z.number().int().min(1).max(5),
  distanceKm: z.number().min(0),
  scopeIdentityKnown: z.boolean(),
  reason: z.string().min(1),
  conflict: z
    .object({
      level: z.enum(['country', 'region', 'locality']),
      expected: z.string().min(1),
      found: z.string().min(1),
    })
    .optional(),
  gateway: z
    .object({
      reason: z.enum([
        'traveller_named_gateway',
        'no_gateway_inside_scope',
        'water_or_air_crossing_required',
      ]),
    })
    .optional(),
  satellite: z.object({ areaId: z.string().min(1) }).optional(),
});
export type LegacyScopeMembership = z.infer<typeof legacyScopeMembershipSchema>;

/**
 * A normalised source record.
 *
 * The normalisation is deliberately minimal — the Phase-7 rule that a table
 * mirroring somebody's tag dictionary is a redistribution wearing our column
 * names has not been relaxed. What is kept is identity, position, name, the
 * classifying category in the source's own vocabulary, the handful of attributes
 * that change a plan, and enough provenance to attribute it and correct it
 * upstream.
 *
 * Contact details are deliberately absent. Phone numbers, e-mail addresses and
 * social handles are in the upstream catalogue and are not planning facts;
 * retaining them would be retention without a purpose.
 */
export const sourceRecordSchema = z.object({
  /** Unique inside the pack. `<layerId>:<sourceId>`. */
  id: z.string().min(1),
  layerId: z.string().min(1),
  /** The upstream identifier, verbatim: a GERS id, an OSM element reference. */
  sourceId: z.string().min(1),
  name: z.string().min(1),
  /** Other names the source publishes, for cross-source matching. */
  alternateNames: z.array(z.string().min(1)).default([]),
  coordinates: coordinatesSchema,
  bounds: geoBoundsSchema.optional(),
  /** The source's own primary category string. Never translated here. */
  sourceCategory: z.string().min(1),
  /** The source's category path, outermost first, where it publishes one. */
  sourceCategoryPath: z.array(z.string().min(1)).default([]),
  planningRole: planningRoleSchema,
  /** `open`, `closed`, or absent when the source says nothing. Never guessed. */
  operatingStatus: z.enum(['open', 'closed']).optional(),
  /**
   * URLs the source associates with this record.
   *
   * Candidates for the research funnel, **not** official sites. Each one goes
   * through source discovery and authority classification exactly as a search
   * result does. A listed website is a cheaper starting point, not a promotion.
   */
  websiteCandidates: z.array(httpUrlSchema).default([]),
  wikidataId: z.string().min(1).optional(),
  containment: recordContainmentSchema,
  /**
   * TYPED GEOGRAPHIC EVIDENCE — what a source published about where this is.
   *
   * Traveller-independent, which is why it belongs in a pack and why a
   * *verdict* does not. Country, region, county, locality, neighbourhood, alias
   * and display name are separate values here, so that a comparison happens
   * within a level and a country name can never satisfy a city's membership.
   *
   * Defaulted rather than optional: a pack written before typed evidence existed
   * parses to empty evidence and is re-derived from `containment` by the reader,
   * which is exactly what it would have had.
   */
  geography: geographicEvidenceSchema.optional().catch(undefined),
  /**
   * The containment verdict a pre-overlay build baked in. **Ignored.**
   *
   * `.catch(undefined)` is the load-bearing part: a region pack is immutable and
   * shared, and a strict schema over a *derived* judgement is a trap. The day the
   * containment vocabulary gains a member, every pack written under the old one
   * would fail `regionPackSchema.parse` and take a whole stored artifact down
   * with it. Degrading an unreadable verdict to absent costs a re-derivation —
   * which the reader does anyway — and costs nothing else. That vocabulary *has*
   * now gained members, which is what this field survived to absorb.
   */
  scopeMembership: legacyScopeMembershipSchema.optional().catch(undefined),
  /**
   * Planning-relevant attributes the source recorded, by name and value.
   *
   * Bounded by an allowlist in the normaliser. `opening_hours` is here because a
   * published schedule is a fact with a source; `operator` because it tells the
   * research funnel whose page to look for; `fee`, `access`, `wheelchair`,
   * `ele`, `seasonal` because they change a plan.
   */
  attributes: z.record(z.string().min(1), z.string().min(1)).default({}),
  sources: z.array(sourceRecordProvenanceSchema).min(1),
  /** A link back to the upstream record, where one exists to link to. */
  sourceUrl: httpUrlSchema.optional(),
  /** Which partition cell produced it, so a partial build can say what it missed. */
  cellId: z.string().min(1),
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export const packLayerSchema = z.object({
  id: z.string().min(1),
  kind: sourceLayerKindSchema,
  /** The catalogue and dataset this layer was read from. */
  catalog: z.string().min(1),
  datasetPath: z.string().min(1),
  licenceId: licenceIdSchema,
  records: z.array(sourceRecordSchema).default([]),
  /** Features read out of the source before any of ours were applied. */
  featuresRead: z.number().int().min(0),
  /** Features kept. The gap between this and `featuresRead` is the filtering. */
  featuresRetained: z.number().int().min(0),
  /** Cells whose scan failed or was cut short, so coverage can say so. */
  failedCellIds: z.array(z.string().min(1)).default([]),
  /** Set when this layer produced nothing and why, in one sentence. */
  note: z.string().min(1).optional(),
});
export type PackLayer = z.infer<typeof packLayerSchema>;

// ---------------------------------------------------------------------------
// Cross-source identity
// ---------------------------------------------------------------------------

/**
 * How two records from different layers relate.
 *
 * Six outcomes rather than a boolean, because the interesting cases are the ones
 * a boolean flattens: a park and its trailhead are not duplicates, two museums
 * in one complex are not one museum, and an attraction and its visitor centre
 * are neither the same thing nor unrelated.
 *
 * Anything weaker than `probable_same_entity` keeps **both** records. The
 * candidate-quality layer already knows how to stop a duplicate and its parent
 * both consuming itinerary time; guessing here would lose a real place.
 */
export const CANDIDATE_LINK_KINDS = [
  'same_entity',
  'probable_same_entity',
  'possible_duplicate',
  'parent_child',
  'colocated_distinct',
  'unresolved',
] as const;
export const candidateLinkKindSchema = z.enum(CANDIDATE_LINK_KINDS);
export type CandidateLinkKind = z.infer<typeof candidateLinkKindSchema>;

/** The observable reasons two records were linked. Never a model's say-so. */
export const LINK_EVIDENCE = [
  'shared_wikidata_id',
  'shared_canonical_website',
  'shared_upstream_record_id',
  'name_and_category_and_proximity',
  'geometric_containment',
  'name_only',
] as const;
export const linkEvidenceSchema = z.enum(LINK_EVIDENCE);
export type LinkEvidence = z.infer<typeof linkEvidenceSchema>;

export const candidateLinkSchema = z.object({
  /** Record ids, sorted, so a link has one identity regardless of discovery order. */
  recordIds: z.array(z.string().min(1)).min(2),
  kind: candidateLinkKindSchema,
  evidence: z.array(linkEvidenceSchema).min(1),
  /** Present only for `parent_child`: which record is the parent. */
  parentRecordId: z.string().min(1).optional(),
  /** Metres between the two positions, where proximity was part of the evidence. */
  separationMetres: z.number().min(0).optional(),
});
export type CandidateLink = z.infer<typeof candidateLinkSchema>;

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

export const packCellSchema = z.object({
  id: z.string().min(1),
  bounds: geoBoundsSchema,
  /** Higher runs first when the budget will not cover every cell. */
  priority: z.number().int().min(0),
});
export type PackCell = z.infer<typeof packCellSchema>;

export const partitionPlanSchema = z.object({
  /** Which shape the scope was, so a plan can be read back against its input. */
  strategy: z.enum(['single', 'grid', 'corridor', 'areas']),
  cells: z.array(packCellSchema).min(1),
  /** Degrees of overlap added to each cell so features on a seam are not lost. */
  overlapDegrees: z.number().min(0),
  /** Cells the plan wanted but the global cap would not allow. */
  droppedCells: z.number().int().min(0).default(0),
});
export type PartitionPlan = z.infer<typeof partitionPlanSchema>;

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

export const sourceReleaseSchema = z.object({
  /** Which catalogue: `overture`. */
  catalog: z.string().min(1),
  /** The release identifier, pinned for the whole build. */
  releaseId: z.string().min(1),
  /** The release's declared schema version, where it declares one. */
  schemaVersion: z.string().min(1).optional(),
  /** When we resolved it, so a stale pin is visible. */
  resolvedAt: z.string().min(1),
  /** Where the release list was read from. */
  catalogUrl: httpUrlSchema.optional(),
});
export type SourceRelease = z.infer<typeof sourceReleaseSchema>;

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

export const REGION_PACK_STATES = [
  'queued',
  'resolving_release',
  'partitioning',
  'extracting',
  'normalizing',
  'linking',
  'validating',
  /** Complete and usable. Written last, and atomically. */
  'ready',
  /** Usable and short of something. Never presented as complete. */
  'partial',
  'failed',
  'cancelled',
] as const;
export const regionPackStateSchema = z.enum(REGION_PACK_STATES);
export type RegionPackState = z.infer<typeof regionPackStateSchema>;

export function isPackUsable(state: RegionPackState): boolean {
  return state === 'ready' || state === 'partial';
}

export const packDiagnosticsSchema = z.object({
  filesInspected: z.number().int().min(0),
  rowGroupsInspected: z.number().int().min(0),
  rowGroupsRead: z.number().int().min(0),
  bytesTransferred: z.number().int().min(0),
  featuresRead: z.number().int().min(0),
  featuresRetained: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  /** Which caps were reached. An exhausted budget is normal and is reported. */
  budgetsExhausted: z.array(z.string().min(1)).default([]),
  /** Per-layer timings, so a slow layer can be named rather than guessed at. */
  layerTimings: z.array(z.object({ layerId: z.string().min(1), ms: z.number().int().min(0) })).default([]),
});
export type PackDiagnostics = z.infer<typeof packDiagnosticsSchema>;

/**
 * Just enough of a scope to identify what a pack covers, and no more.
 *
 * Deliberately not the whole `GeographicScope`: a pack is traveller-independent
 * geography and must be shareable between two trips to the same place with
 * different profiles, pace and transport. Anything traveller-specific in here
 * would be a cache key that never hits.
 */
export const packScopeIdentitySchema = z.object({
  destinationCandidateId: z.string().min(1),
  destinationName: z.string().min(1),
  center: coordinatesSchema,
  bounds: geoBoundsSchema,
  breadth: z.string().min(1),
});
export type PackScopeIdentity = z.infer<typeof packScopeIdentitySchema>;

export const regionPackSchema = z.object({
  schemaVersion: z.literal(REGION_PACK_VERSION),
  id: z.string().min(1),
  /**
   * The geography this pack covers, hashed.
   *
   * Traveller-independent by construction — see `packScopeHash`. Two trips to
   * the same ground share a pack; a trip whose scope the traveller widened does
   * not, because the ground changed.
   */
  scopeHash: z.string().min(1),
  scope: packScopeIdentitySchema,
  state: regionPackStateSchema,
  releases: z.array(sourceReleaseSchema).min(1),
  partition: partitionPlanSchema,
  layers: z.array(packLayerSchema).default([]),
  links: z.array(candidateLinkSchema).default([]),
  /** Unioned from the layers, so the UI renders exactly what is owed. */
  licences: z.array(dataLicenceSchema).default([]),
  diagnostics: packDiagnosticsSchema,
  /** Of the records and the pin. Two identical builds produce one hash. */
  contentHash: z.string().min(1),
  createdAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
  /**
   * When this pack should be rebuilt from a newer release.
   *
   * A recommendation, never an expiry: an old pack stays usable and stays
   * labelled, because the alternative when a catalogue is unreachable is telling
   * a traveller their destination is empty.
   */
  refreshRecommendedAfter: z.string().min(1).optional(),
  /** Safe to display. Never a stack trace, never a URL with a credential in it. */
  failure: z
    .object({ code: z.string().min(1), detail: z.string().min(1) })
    .optional(),
});
export type RegionPack = z.infer<typeof regionPackSchema>;

/**
 * The identity of the ground a pack covers.
 *
 * Rounded to four decimal places — about eleven metres — because a scope that
 * differs by a rounding error is the same ground, and a hash that says otherwise
 * is a cache that never hits. Deliberately excludes the release: a pack is
 * looked up by ground first and then checked for its pin, so an older release's
 * pack can be offered as an explicitly stale answer rather than being invisible.
 */
export function packScopeHash(input: {
  destinationCandidateId: string;
  bounds: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } };
}): string {
  const round = (value: number): string => value.toFixed(4);
  return [
    `v${REGION_PACK_VERSION}`,
    input.destinationCandidateId,
    round(input.bounds.southWest.lat),
    round(input.bounds.southWest.lng),
    round(input.bounds.northEast.lat),
    round(input.bounds.northEast.lng),
  ].join('/');
}

/** Every record in the pack, across every layer, in a stable order. */
export function packRecords(pack: RegionPack): SourceRecord[] {
  return pack.layers.flatMap((layer) => layer.records);
}

/**
 * Whether a pack was built from the release currently pinned.
 *
 * Used to decide between "use it" and "use it and say it is not current". Never
 * used to decide between "use it" and "fail".
 */
export function packMatchesRelease(pack: RegionPack, catalog: string, releaseId: string): boolean {
  return pack.releases.some(
    (release) => release.catalog === catalog && release.releaseId === releaseId,
  );
}
