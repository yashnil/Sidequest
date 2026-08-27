import {
  buildInventory,
  buildTripScopeOverlay,
  assessRecordEligibility,
  supersededRecordIds,
} from '@sidequest/compiler';
import type { CandidateLink, GeographicScope, RegionPack, SourceRecord } from '@sidequest/core';
import { recallPriorityOf } from '@/lib/providers/overture/pack';
import type { CanonicalDestination, CanonicalSubject } from './fixtures/canonical-subjects';
import { matchSubject, type NearbyRecord, type SubjectMatch } from './match';

/**
 * ============================================================================
 * THE CANONICAL RECALL GATE — WHAT IT MEASURES AND WHY IT SITS WHERE IT SITS
 * ============================================================================
 *
 * ## The failure this exists for
 *
 * A live compilation of a dense metropolis produced a pack of 1,840 place
 * records, 100 anchors, food, and a spatially even-looking partition — and 1 of
 * 16 canonical attractions on the board. The instinctive reading is "the
 * ranking is wrong". It was not, or not only. Tokyo Tower is published by the
 * source, sits inside the resolved scope, and **was never decoded**: the scan
 * opened 30 of the ~1,920 row groups its bounding box overlapped, and the grid
 * cell containing the tower kept 45 seats free while holding fifteen records
 * that scored exactly 0.000 — a mortgage broker, a temp agency, a condominium.
 *
 * Ranking cannot rank what was never read.
 *
 * That distinction is invisible to every measurement taken at the board, which
 * is why the board is the wrong place to measure. A single number — "how many
 * famous places made it" — cannot separate the two states, and only one of them
 * is a defect.
 *
 * ## The six stages
 *
 * A canonical subject travels through six gates. This module reports, for each
 * subject, whether it passed each of them — and `lostAt` names the first it did
 * not. The stages are recorded *independently* rather than as a ladder position,
 * because two artifacts in the same database need not come from the same build:
 * a stored region really did carry a palace the stored pack does not, and a
 * ladder would have forced a choice between hiding that and misreporting it. A
 * funnel that is not monotonic is therefore a finding, not a bug.
 *
 * | # | stage         | the question                                            | measured from |
 * |---|---------------|---------------------------------------------------------|---------------|
 * | 1 | `published`   | does the source catalogue carry this at all?            | the fixture's `sourceEvidence` |
 * | 2 | `acquired`    | did a record for it end up in the region pack?          | `RegionPack.layers[*].records` |
 * | 3 | `normalised`  | did that record become a usable place identity?         | `assessRecordEligibility` — name, status, recognised category |
 * | 4 | `eligible`    | did it pass the admission gates for something to do?    | `ROLE_PERMISSIONS` via `assessRecordEligibility` |
 * | 5 | `shortlisted` | did the inventory keep it through quota and balance?    | `buildInventory().candidates` |
 * | 6 | `board`       | did the traveller ever see it?                          | the seats the discover page renders — by record identity for a same-build artifact, by the matcher across builds |
 *
 * Stages 5 and 6 follow the *entity*, not just the one record the matcher
 * chose. The linker collapses records it has proven are one thing, and the
 * inventory then seats the component's **survivor** — so a subject whose
 * matched record was superseded is on the shortlist precisely when its
 * survivor is. Booking such a subject "lost at shortlisted" while its survivor
 * sits on the board is the instrument under-crediting the product, and two
 * real losses were booked exactly that way. The survivor is read from the
 * product's own `supersededRecordIds` over the pack's own links — never
 * re-decided here — and the credit is reported as survivor credit, never as a
 * name-tier own-record hit. A subject whose survivor also lost its seat still
 * reads lost.
 *
 * Stages 3–5 run the product's **own** functions rather than re-implementations.
 * That is deliberate: an evaluation that carries a second opinion about what a
 * museum is drifts away from the thing it evaluates, and this repository has
 * already been bitten by a green suite protecting nothing.
 *
 * ## Where the gate is, and why it is not at the end
 *
 * The gate asserts on stages 1→4 and reports 5 and 6 as information.
 *
 * The reason is a product rule, not a convenience. A canonical place left off a
 * board **because it fits the traveller badly is correct behaviour** — §16 says
 * Times Square should score low for somebody who hates crowds, and a gate that
 * demanded famous names on every board would be a bug requesting a bug. A
 * canonical place absent because its row group was never opened is a different
 * thing entirely: nothing about the traveller was consulted, no judgement was
 * made, and no downstream layer could have recovered it.
 *
 * So the gate asks the question that has one right answer — *was it ever in the
 * room?* — and leaves the question that legitimately has many — *should it have
 * been chosen?* — as a reported number.
 *
 * ## Proving "never read" from a stored artifact
 *
 * `retainAcrossCells` distributes retention **per cell before any global
 * backfill**: each cell fills its own family shares first, and only leftovers
 * are redistributed. It follows that a cell which contributed *any* decoded
 * record retains at least one. Contrapositive: **a cell that contributed zero
 * records to a layer was never read for that layer.** That is a proof from the
 * artifact alone, needing no budget constant and no second copy of a production
 * threshold, and it is the assertion the gate is built on.
 *
 * There is a second, worse state the same evidence exposes: a subject inside the
 * pack's bounds that falls inside **no partition cell at all**. `partitionScope`
 * drops cells, and a stored country-breadth pack dropped 11 of 35 — including
 * the one holding the capital. That ground was not merely unread, it was never
 * scheduled to be read, and it is reported as `outside_partition` and gated
 * alongside `never_read` (`neverInTheRoom`).
 *
 * Where a subject's cell did contribute records, the artifact can still often
 * prove which of "unread" or "outranked" happened, because a pack carries its
 * own read plan's residue: every budget that stopped a layer's read is recorded
 * per layer in `diagnostics.budgetsExhausted` (`places:row_group_budget`,
 * `places:byte_budget`, …), a byte-allowance shortfall is written onto the
 * layer as a `note` ("Read N of M blocks … MB of it was beyond this build's
 * data allowance"), and a cell whose scan failed mid-file is named in the
 * layer's `failedCellIds`. `<layer>:retained` alone is the *retention* cap —
 * dropped after a complete read, by rank — so a layer whose only exhausted
 * budget is `retained`, with no shortfall note and no failed cells, was read in
 * full, and a subject absent from it was **outranked**: a retention defect, not
 * a read defect. Conversely a subject standing in a cell the layer names as
 * failed was **unread**. Only when the artifact genuinely cannot say — legacy
 * packs whose budget words carry no layer prefix — does the report keep
 * `unread_or_outranked` rather than guessing, alongside two numbers a reader
 * can weigh: how many records that cell kept, and how many of them score
 * exactly 0.000 under the product's own `recallPriorityOf`. A cell full of
 * zero-priority records with a landmark missing is not a ranking outcome.
 *
 * And one further honesty, from the matcher rather than the read plan: a
 * subject whose own record is absent while a *proxy* stands near it — a
 * station wearing its name, an on-grounds building whose archetype the
 * taxonomy guessed from a family — is `proxy_only`, which counts as **not
 * acquired**. Three real losses were being booked against eligibility on
 * exactly such proxies, which aimed the fix wave at the wrong stage.
 *
 * ## How to run it
 *
 *   npx vitest run apps/web/src/lib/iq/recall --reporter=verbose
 *
 * The flag is not decoration: Vitest's default reporter prints a test's console
 * output only when it fails, and the staged table is worth as much when the gate
 * passes — it is the "after" number somebody will compare against.
 *
 * The fixture arm always runs. The reality arm runs when
 * `apps/web/data/sidequest.db` holds a pack for one of the fixture destinations
 * — the database is gitignored, so CI sees the fixture arm and a developer with
 * real artifacts sees both.
 * ============================================================================
 */

export const RECALL_STAGES = [
  'published',
  'acquired',
  'normalised',
  'eligible',
  'shortlisted',
  'board',
] as const;

export type RecallStage = (typeof RECALL_STAGES)[number];

/**
 * Why a subject that never reached `acquired` is missing.
 *
 * `out_of_scope` is separated from every failure because a subject outside the
 * resolved bounding box is not a recall loss — it is a fixture whose coordinate
 * lies outside the ground this pack was paid for, and counting it would inflate
 * a failure the product did not commit.
 */
export type AcquisitionVerdict =
  | 'acquired'
  | 'out_of_scope'
  /**
   * Inside the pack's bounds and inside no partition cell.
   *
   * A distinct and worse failure than `never_read`: the ground was not merely
   * unread, it was never scheduled to be read. A stored country-breadth pack
   * dropped 11 of 35 grid cells, and the one holding the capital — its
   * cathedral, its concert hall, its museum — was among them.
   */
  | 'outside_partition'
  | 'never_read'
  /**
   * The subject's cell contributed records but the layer names that very cell
   * as failed or cut short — the ground under the subject was provably not
   * fully read. A read defect, never a ranking outcome.
   */
  | 'unread'
  /**
   * The subject's own record is absent and a *proxy* stands near it: a record
   * that is plainly a different entity — a station wearing the subject's name,
   * an on-grounds building whose archetype was guessed from a family — and
   * that the old matcher used to credit as the subject. Counts as NOT
   * acquired: a proxy on a board is not the subject on a board.
   *
   * Ordered after the read-defect verdicts on purpose. A proxy in a cell that
   * was never read, or cut short, does not prove the subject absent from the
   * source — only a completed read does — so read defects win the attribution.
   */
  | 'proxy_only'
  /**
   * The layer's read is proven complete — every exhausted budget for it is the
   * post-read retention cap, no shortfall note, no failed cells — so absence
   * is an eviction: the subject was decoded, ranked, and dropped. A retention
   * defect, and the one verdict that licenses aiming a fix at retention.
   */
  | 'outranked'
  /** The artifact genuinely cannot separate the two. Legacy packs mostly. */
  | 'unread_or_outranked';

export interface CellEvidence {
  /** Partition cells whose bounds contain the subject's point. */
  cellIds: string[];
  /** Records the places layer kept in those cells. */
  retainedInCell: number;
  /** The most any single cell kept in that layer, for scale. */
  densestCell: number;
  /** Of `retainedInCell`, how many score exactly 0 under `recallPriorityOf`. */
  zeroPriorityInCell: number;
}

/**
 * The surviving record of a linker collapse that superseded the matched record.
 *
 * Present on a subject whenever the record the matcher chose was collapsed
 * into another record by the product's own linker — whether or not that
 * survivor kept a seat. `creditedStages` names exactly which of the later
 * stages were passed *via* the survivor rather than by the matched record
 * itself, so a reader can never mistake survivor credit for a name-tier
 * own-record hit; it is empty when the survivor also lost its seat, which the
 * funnel still books as a loss.
 */
export interface SurvivorCredit {
  id: string;
  name: string;
  layerId: string;
  sourceCategory: string;
  /** Subset of `['shortlisted', 'board']`, in stage order. */
  creditedStages: RecallStage[];
}

export interface SubjectRecall {
  subject: CanonicalSubject;
  /**
   * Whether each stage was passed, **independently**.
   *
   * Not a single "furthest stage reached", and the difference is not pedantry.
   * A pack and a compiled region in the same database need not come from the
   * same build, and one really did contain the Imperial Palace while the other
   * did not. Collapsing that into one ladder position forces a choice between
   * reporting a board hit the pack cannot explain and hiding it. Independent
   * flags report both, and a funnel that is not monotonic is itself the finding.
   */
  passed: Readonly<Record<RecallStage, boolean>>;
  /** The first stage not passed, or `undefined` when every stage was. */
  lostAt?: RecallStage;
  verdict: AcquisitionVerdict;
  match: SubjectMatch;
  /** The candidate role the product's own eligibility assessment produced. */
  role?: string;
  /** Populated only when the subject failed to be acquired. */
  cell?: CellEvidence;
  /** Present when the matched record was superseded by a linker collapse. */
  survivor?: SurvivorCredit;
  /** What sat inside the radius instead. Reported, never counted. */
  insteadFound: NearbyRecord[];
}

const NOTHING_PASSED: Readonly<Record<RecallStage, boolean>> = Object.freeze({
  published: false,
  acquired: false,
  normalised: false,
  eligible: false,
  shortlisted: false,
  board: false,
});

export interface StageCount {
  stage: RecallStage;
  reached: number;
  of: number;
}

export interface CanonicalRecallReport {
  destinationId: string;
  shape: string;
  packId: string;
  packState: string;
  packContentHash: string;
  packCreatedAt: string;
  /** Present when the pack was read out of storage. See `RecallMeasurementInput`. */
  provenance?: { storedSchemaVersion: number; relabelled: boolean };
  /** Subjects whose point lies outside the pack's bounds; excluded from counts. */
  outOfScope: string[];
  subjects: SubjectRecall[];
  stages: StageCount[];
  /** How much of the partition the places layer actually came back from. */
  read: {
    cells: number;
    cellsWithPlaces: number;
    densestCellShare: number;
    placesRetained: number;
    rowGroupsInspected: number;
    rowGroupsRead: number;
    budgetsExhausted: string[];
    /** What the artifact proves about the places read. See `layerReadCompleteness`. */
    placesRead: LayerReadCompleteness;
  };
  /** True when the later stages were measured against a differently-built region. */
  laterStagesFromSameBuild: boolean;
  /** Absent when no compiled artifact was supplied; stages 5/6 are then unmeasured. */
  laterStagesMeasured: boolean;
  /** What stage 6 was measured over, when it was measured at all. */
  board?: { seats: number; renderedSeatList: boolean };
}

/**
 * A compiled artifact, reduced to what the later stages need.
 *
 * Kept as a narrow view rather than a whole `CompiledRegion` so that this module
 * can be driven from a fixture world, from a stored row, or from an in-memory
 * compile without three code paths.
 */
export interface CompiledView {
  /** Records the compiler kept as things to do, in matcher-readable form. */
  places: readonly SourceRecord[];
  /** The content hash of the pack this was compiled from, when it records one. */
  packContentHash?: string;
  /**
   * True when `places` is the admitted seat list the discover page renders —
   * the stored artifact's places passed through the product's own
   * `partitionBoardPlaces` role gate — rather than the raw compiled array,
   * which may hold gateways and utility stops no traveller is ever shown.
   * Membership in the rendered list is profile-independent (the profile moves
   * grouping and fit bands, never who is a card), so an instrument with no
   * traveller can still measure the seats every traveller gets. Absent or
   * false means stage 6 was measured over ungated places, and the report says
   * which.
   */
  renderedSeatList?: boolean;
}

export interface RecallMeasurementInput {
  destination: CanonicalDestination;
  pack: RegionPack;
  /**
   * The scope the inventory should be built against.
   *
   * The pack carries only a reduced identity — deliberately, since a pack is
   * shared between travellers — so a full scope has to come from somewhere. A
   * stored compiled region is the faithful source; `syntheticScopeFor` builds a
   * neutral one when there is none.
   */
  scope: GeographicScope;
  /** Stages 5 and 6. Omit to leave them unmeasured rather than reported as zero. */
  compiled?: CompiledView | null;
  /**
   * Where the pack came from, when it came from storage.
   *
   * Carried into the report so a number produced from a pack written by an
   * older compiler is never quoted as if it came from this one.
   */
  provenance?: { storedSchemaVersion: number; relabelled: boolean };
}

const PLACES_LAYER = 'places';

function inBounds(subject: CanonicalSubject, pack: RegionPack): boolean {
  const { southWest, northEast } = pack.scope.bounds;
  return (
    subject.point.lat >= southWest.lat &&
    subject.point.lat <= northEast.lat &&
    subject.point.lng >= southWest.lng &&
    subject.point.lng <= northEast.lng
  );
}

function cellsContaining(pack: RegionPack, point: { lat: number; lng: number }): string[] {
  return pack.partition.cells
    .filter(
      (cell) =>
        point.lat >= cell.bounds.southWest.lat &&
        point.lat <= cell.bounds.northEast.lat &&
        point.lng >= cell.bounds.southWest.lng &&
        point.lng <= cell.bounds.northEast.lng,
    )
    .map((cell) => cell.id);
}

/**
 * The read, per cell, for one layer.
 *
 * The whole diagnosis rests on this map: a cell absent from it produced nothing,
 * and by the per-cell retention argument in the header, produced nothing because
 * nothing was read there.
 */
function cellOccupancy(pack: RegionPack, layerId: string): Map<string, SourceRecord[]> {
  const layer = pack.layers.find((entry) => entry.id === layerId);
  const byCell = new Map<string, SourceRecord[]>();
  for (const record of layer?.records ?? []) {
    const bucket = byCell.get(record.cellId) ?? [];
    bucket.push(record);
    byCell.set(record.cellId, bucket);
  }
  return byCell;
}

/**
 * What the artifact proves about how completely one layer's ground was read.
 *
 * - `complete` — every budget word recorded for the layer is `retained` (the
 *   post-read retention cap), no shortfall note was written onto the layer, and
 *   no cell failed. By the scanner's own accounting that means every planned
 *   row group over the area was opened and decoded, so everything the source
 *   publishes there entered ranking.
 * - `truncated` — a read-bound budget for this layer was exhausted, or the
 *   layer carries the shortfall sentence, or cells failed: ground provably
 *   went unread somewhere in the layer.
 * - `indeterminate` — the pack's budget vocabulary predates layer prefixes
 *   (`retained_budget`, `feature_budget`, bare `provider_error`), so a stop
 *   cannot be attributed to a layer. Older artifacts; never guessed at.
 */
export type LayerReadCompleteness = 'complete' | 'truncated' | 'indeterminate';

export function layerReadCompleteness(pack: RegionPack, layerId: string): LayerReadCompleteness {
  const layer = pack.layers.find((entry) => entry.id === layerId);
  if (!layer) return 'indeterminate';
  let unattributedStop = false;
  for (const entry of pack.diagnostics.budgetsExhausted) {
    const colon = entry.indexOf(':');
    if (colon >= 0) {
      const [owner, reason] = [entry.slice(0, colon), entry.slice(colon + 1)];
      if (owner === layerId && reason !== 'retained') return 'truncated';
    } else if (entry !== 'retained') {
      /* Legacy vocabulary: a stop happened somewhere, attributable to nothing. */
      unattributedStop = true;
    }
  }
  /* The shortfall sentence is only ever written when bytes went unread. */
  if (layer.note !== undefined && layer.records.length > 0) return 'truncated';
  if (layer.failedCellIds.length > 0) return 'truncated';
  return unattributedStop ? 'indeterminate' : 'complete';
}

function cellEvidenceFor(
  subject: CanonicalSubject,
  pack: RegionPack,
  occupancy: Map<string, SourceRecord[]>,
): CellEvidence {
  const cellIds = cellsContaining(pack, subject.point);
  const records = cellIds.flatMap((id) => occupancy.get(id) ?? []);
  const densest = Math.max(0, ...[...occupancy.values()].map((bucket) => bucket.length));
  return {
    cellIds,
    retainedInCell: records.length,
    densestCell: densest,
    zeroPriorityInCell: records.filter((record) => recallPriorityOf(record) === 0).length,
  };
}

/**
 * For every record a linker collapse superseded, the record that survived it.
 *
 * WHO SURVIVES IS NEVER DECIDED HERE. The product's own `supersededRecordIds`
 * has already named the losers; this walk only recovers component membership —
 * the same membership rule the collapse itself uses: `same_entity` and
 * `probable_same_entity` links whose both ends are present — and reads the
 * survivor off as the one member the product did not supersede. A second
 * opinion about survivor strength written in an evaluation would drift from
 * the thing it measures, which is the failure mode this whole module refuses.
 *
 * Needed because the inventory seats the survivor, not the matched record: on
 * a live pack the subject's own record (matched by name) was collapsed into a
 * twin, the twin took the seat, and the funnel booked the subject "lost at
 * shortlisted" while the entity it stands for sat on the board.
 */
function collapseSurvivors(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
  superseded: ReadonlySet<string>,
): Map<string, SourceRecord> {
  const survivors = new Map<string, SourceRecord>();
  if (superseded.size === 0) return survivors;

  const byId = new Map(records.map((record) => [record.id, record]));

  /* Union-find with path compression, exactly as the product's collapse walks. */
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) ?? root;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  for (const link of links) {
    if (link.kind !== 'same_entity' && link.kind !== 'probable_same_entity') continue;
    const [first, second] = link.recordIds;
    if (!first || !second || !byId.has(first) || !byId.has(second)) continue;
    if (!parent.has(first)) parent.set(first, first);
    if (!parent.has(second)) parent.set(second, second);
    const rootA = find(first);
    const rootB = find(second);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  const members = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const bucket = members.get(root);
    if (bucket) bucket.push(id);
    else members.set(root, [id]);
  }

  for (const ids of members.values()) {
    /* The collapse keeps exactly one per component: the one not superseded. */
    const survivorId = ids.find((id) => !superseded.has(id));
    if (survivorId === undefined) continue;
    const survivor = byId.get(survivorId);
    if (!survivor) continue;
    for (const id of ids) {
      if (id !== survivorId) survivors.set(id, survivor);
    }
  }
  return survivors;
}

/**
 * Roles that mean the record never became a usable place at all.
 *
 * Named against `eligibility.ts`'s own vocabulary rather than re-derived: these
 * are the four refusals that are about *identity* — no name, another record
 * already carries it, the source says it shut, it is a boundary — as opposed to
 * the refusals that are about travel value, which belong to stage 4.
 */
const IDENTITY_REFUSALS = new Set([
  'insufficient_identity',
  'duplicate',
  'permanently_closed',
  'administrative_object',
]);

export function measureCanonicalRecall(input: RecallMeasurementInput): CanonicalRecallReport {
  const { destination, pack, scope } = input;
  const records = pack.layers.flatMap((layer) => layer.records);
  const occupancy = cellOccupancy(pack, PLACES_LAYER);
  const placesRead = layerReadCompleteness(pack, PLACES_LAYER);
  const failedPlaceCells = new Set(
    pack.layers.find((layer) => layer.id === PLACES_LAYER)?.failedCellIds ?? [],
  );

  /*
   * The inventory is run once, over the whole pack, exactly as a compilation
   * would run it — quotas, area balance, membership overlay and all. Reading
   * `candidates` per subject afterwards is what makes stage 5 a measurement of
   * the product rather than of a filter written here.
   *
   * The trip-scope overlay rides along because the product never calls the
   * inventory without one: an overlay-less run resolved membership differently
   * at the scope's edges, and an independent probe measured the drift — two
   * boundary-complex seats on one live metropolis, four on another, held by
   * the artifact and refused by the model. What the model still cannot follow
   * is the compile's deficit-directed widening pass (it is coverage-driven and
   * runs after this call); the same-build seat credit below is what keeps that
   * honest rather than a footnote.
   */
  const inventory = buildInventory({
    pack,
    scope,
    overlay: buildTripScopeOverlay({
      scope,
      records,
      /* The same coarse conjunction factor every production overlay carries. */
      roleEligible: (record) => assessRecordEligibility(record).eligibility.provisionalBoard,
    }),
  });
  const shortlisted = new Set(inventory.candidates.map((candidate) => candidate.place.id));
  const supporting = new Set(inventory.supporting.map((candidate) => candidate.place.id));

  /*
   * HOW STAGE 6 IS ASKED DEPENDS ON WHOSE BOARD IT IS.
   *
   * A compiled artifact that records the measured pack's own content hash was
   * built *from this pack*, and its places carry the pack's own record ids —
   * so for a subject whose record the matcher found, board membership is a
   * question of **identity**: is that record, or its collapse survivor, among
   * the seats? Re-running the matcher there is how a live funnel credited a
   * palace's seat to a war cemetery and a park's seat to the zoo inside it,
   * printing board numbers the served board did not contain. Across builds ids
   * do not correspond, so the independent matcher remains the only fair
   * instrument — reported as such by the provenance footnote — and a subject
   * with no matched record at all keeps the independent matcher everywhere,
   * because a name-bearing seat the pack cannot account for is a finding the
   * report owes the reader.
   */
  const sameBuild =
    input.compiled?.packContentHash !== undefined &&
    input.compiled.packContentHash === pack.contentHash;
  const seatIds = new Set(input.compiled?.places.map((place) => place.id) ?? []);

  /*
   * The collapse's own outcome, read with the product's own function, so that
   * stages 5 and 6 can follow the entity when the matched record's seat moved
   * to a collapse survivor. See `collapseSurvivors`.
   */
  const superseded = supersededRecordIds(records, pack.links);
  const survivorOfRecord = collapseSurvivors(records, pack.links, superseded);

  const outOfScope: string[] = [];
  const subjects: SubjectRecall[] = [];
  /*
   * Who is standing on which rendered seat, for the dedupe pass below.
   * `identity` outranks the matcher's tiers: the subject's own record holding
   * its own seat is a stronger claim than any nearby-record inference.
   */
  const boardCredits: {
    entry: SubjectRecall;
    seatId: string;
    claim: 'identity' | 'name' | 'site';
  }[] = [];

  for (const subject of destination.subjects) {
    if (!inBounds(subject, pack)) {
      outOfScope.push(subject.id);
      subjects.push({
        subject,
        passed: NOTHING_PASSED,
        verdict: 'out_of_scope',
        match: { tier: 'none', insteadFound: [] },
        insteadFound: [],
      });
      continue;
    }

    /*
     * The board is asked independently of the pack, and always. A compiled
     * region in the same database may have been built from a different pack —
     * one really was — and a board hit that the pack cannot account for is a
     * finding, not something to suppress.
     */
    const boardMatch = input.compiled ? matchSubject(subject, input.compiled.places) : undefined;
    const onBoard = boardMatch !== undefined && boardMatch.tier !== 'none';

    const match = matchSubject(subject, records);

    if (match.tier === 'none' || !match.record) {
      const cell = cellEvidenceFor(subject, pack, occupancy);
      /*
       * Attribution order is the whole point. Ground defects first — never
       * scheduled, never read, provably cut short — because none of them
       * proves the subject absent from the source; a proxy only earns its
       * verdict once the absence is real. Then, and only with a completed
       * read, absence becomes an eviction: `outranked`.
       */
      const verdict: AcquisitionVerdict =
        cell.cellIds.length === 0
          ? 'outside_partition'
          : cell.retainedInCell === 0
            ? 'never_read'
            : cell.cellIds.some((id) => failedPlaceCells.has(id))
              ? 'unread'
              : match.proxy
                ? 'proxy_only'
                : placesRead === 'complete'
                  ? 'outranked'
                  : 'unread_or_outranked';
      const entry: SubjectRecall = {
        subject,
        passed: { ...NOTHING_PASSED, published: true, board: onBoard },
        lostAt: 'acquired',
        verdict,
        match,
        cell,
        insteadFound: match.insteadFound,
      };
      subjects.push(entry);
      if (onBoard && boardMatch?.record) {
        boardCredits.push({ entry, seatId: boardMatch.record.id, claim: boardMatch.tier as 'name' | 'site' });
      }
      continue;
    }

    const record = match.record;
    /*
     * Stage 4 is the record-LOCAL eligibility floor, and that is a known
     * conservatism: the product's inventory also runs a cross-layer witness
     * transfer before refusing, so a record this stage prints as "lost at
     * eligible" can be pool-admitted in the product and merely unseated — a
     * live district was, rescued by its waterway's knowledge-base identity.
     * The same-build seat credit below repairs the divergence for anything
     * that reached a seat; for the unseated remainder this stage understates
     * the product, never overstates it, which is the safe direction for a
     * release floor.
     */
    const assessment = assessRecordEligibility(record);
    const normalised = !IDENTITY_REFUSALS.has(assessment.role);
    const eligible =
      normalised &&
      (assessment.eligibility.attractionPortfolio || assessment.eligibility.foodPortfolio);

    /*
     * SURVIVOR CREDIT. When the matched record was superseded by a linker
     * collapse, its seat — in the inventory and on the board — belongs to the
     * component's survivor, so stages 5 and 6 ask about the survivor too.
     * Strictly *too*: a subject whose survivor also lost its seat still reads
     * lost, and the credit is recorded on the entry so the report can say it
     * came via the survivor rather than via the record the matcher named.
     */
    const survivor = superseded.has(record.id) ? survivorOfRecord.get(record.id) : undefined;
    const keptSelf = shortlisted.has(record.id);
    const keptViaSurvivor = survivor !== undefined && shortlisted.has(survivor.id);
    const onBoardSelf = seatIds.has(record.id);
    const onBoardViaSurvivor = survivor !== undefined && seatIds.has(survivor.id);

    /*
     * A SAME-BUILD SEAT IS PROOF OF PASSAGE, AND THE FUNNEL IS MONOTONE.
     *
     * The artifact is the product's own output: a record holding a rendered
     * seat of the region built from this very pack necessarily passed every
     * product stage on the way there. When the model here disagrees — it
     * cannot follow the compile's coverage-driven widening pass, and for a
     * while it ran without the trip overlay — the disagreement is the model's
     * error, not the product's, and printing "lost at shortlist" above a seat
     * the traveller can see made the funnel non-monotone and the report carry
     * an asterisk in place of an answer. So identity-proven same-build seats
     * credit the earlier product stages too. Across builds ids do not
     * correspond and nothing is inferred.
     */
    const seatProvesPassage = sameBuild && (onBoardSelf || onBoardViaSurvivor);
    const kept = keptSelf || keptViaSurvivor || seatProvesPassage;

    const passed: Record<RecallStage, boolean> = {
      published: true,
      acquired: true,
      normalised: normalised || seatProvesPassage,
      eligible: eligible || seatProvesPassage,
      shortlisted: kept,
      /*
       * Identity where identity is checkable; the matcher only across builds.
       * See the `sameBuild` block above — a same-build neighbour that matches
       * is the site tier flattering the board, never the subject's seat.
       */
      board: onBoardSelf || onBoardViaSurvivor || (!sameBuild && onBoard),
    };
    const lostAt = RECALL_STAGES.find((stage) => !passed[stage]);

    const entry: SubjectRecall = {
      subject,
      passed,
      ...(lostAt ? { lostAt } : {}),
      verdict: 'acquired',
      match,
      role: assessment.role + (kept || !supporting.has(record.id) ? '' : ' (supporting only)'),
      ...(survivor
        ? {
            survivor: {
              id: survivor.id,
              name: survivor.name,
              layerId: survivor.layerId,
              sourceCategory: survivor.sourceCategory,
              creditedStages: [
                ...(keptViaSurvivor ? (['shortlisted'] as RecallStage[]) : []),
                ...(onBoardViaSurvivor ? (['board'] as RecallStage[]) : []),
              ],
            },
          }
        : {}),
      insteadFound: [],
    };
    subjects.push(entry);
    if (passed.board) {
      const seatId = onBoardSelf
        ? record.id
        : onBoardViaSurvivor && survivor
          ? survivor.id
          : boardMatch?.record?.id;
      if (seatId) {
        /*
         * The claim strength is the subject's own MATCH tier, not the path the
         * seat was found by: two subjects can hold the same record — one named
         * by it, one merely near it — and both arrive here "by identity". A
         * live funnel handed a tower's seat to the district beside it on a
         * lexicographic tie because both read as identity; the tower matched
         * by name and the district by site, and that is the difference that
         * decides.
         */
        boardCredits.push({
          entry,
          seatId,
          claim: match.tier === 'name' ? 'name' : match.tier === 'site' ? 'site' : 'identity',
        });
      }
    }
  }

  /*
   * ONE SEAT, ONE SUBJECT.
   *
   * A district and the landmark at its centre can both match the landmark's
   * single rendered card — a live funnel counted one observation-tower seat as
   * two canonical subjects, and the share it printed was a board the traveller
   * was not shown. When several subjects stand on one seat, the strongest
   * claim keeps it — identity over a name match over a site match, then the
   * stable subject order — and the rest lose at the board stage like any other
   * subject whose seat went to somebody else.
   */
  const claimRank = { identity: 0, name: 1, site: 2 } as const;
  const bySeat = new Map<string, typeof boardCredits>();
  for (const credit of boardCredits) {
    const list = bySeat.get(credit.seatId) ?? [];
    list.push(credit);
    bySeat.set(credit.seatId, list);
  }
  for (const credits of bySeat.values()) {
    if (credits.length < 2) continue;
    credits.sort(
      (a, b) =>
        claimRank[a.claim] - claimRank[b.claim] ||
        a.entry.subject.id.localeCompare(b.entry.subject.id),
    );
    for (const losing of credits.slice(1)) {
      const demoted: SubjectRecall = {
        ...losing.entry,
        passed: { ...losing.entry.passed, board: false },
        lostAt: losing.entry.lostAt ?? 'board',
      };
      subjects[subjects.indexOf(losing.entry)] = demoted;
    }
  }

  const considered = destination.subjects.length - outOfScope.length;
  const stages: StageCount[] = RECALL_STAGES.map((stage) => ({
    stage,
    of: considered,
    reached: subjects.filter((entry) => entry.verdict !== 'out_of_scope' && entry.passed[stage])
      .length,
  }));

  const placesLayer = pack.layers.find((layer) => layer.id === PLACES_LAYER);
  const placesRetained = placesLayer?.records.length ?? 0;
  const densest = Math.max(0, ...[...occupancy.values()].map((bucket) => bucket.length));

  return {
    destinationId: destination.id,
    shape: destination.shape,
    packId: pack.id,
    packState: pack.state,
    packContentHash: pack.contentHash,
    packCreatedAt: pack.createdAt,
    ...(input.provenance ? { provenance: input.provenance } : {}),
    outOfScope,
    subjects,
    stages,
    read: {
      cells: pack.partition.cells.length,
      cellsWithPlaces: occupancy.size,
      densestCellShare: placesRetained === 0 ? 0 : densest / placesRetained,
      placesRetained,
      rowGroupsInspected: pack.diagnostics.rowGroupsInspected,
      rowGroupsRead: pack.diagnostics.rowGroupsRead,
      budgetsExhausted: [...pack.diagnostics.budgetsExhausted],
      placesRead,
    },
    laterStagesMeasured: Boolean(input.compiled),
    laterStagesFromSameBuild: sameBuild,
    ...(input.compiled
      ? {
          board: {
            seats: input.compiled.places.length,
            renderedSeatList: input.compiled.renderedSeatList === true,
          },
        }
      : {}),
  };
}

/** How many in-scope subjects reached a stage, as a share. */
export function shareReaching(report: CanonicalRecallReport, stage: RecallStage): number {
  const entry = report.stages.find((count) => count.stage === stage);
  if (!entry || entry.of === 0) return 0;
  return entry.reached / entry.of;
}

/** Subjects the artifact proves were never decoded. */
export function neverRead(report: CanonicalRecallReport): SubjectRecall[] {
  return report.subjects.filter((entry) => entry.verdict === 'never_read');
}

/**
 * Subjects that were never in the room at all — the gate's subject.
 *
 * The union of "the cell was never read" and "the cell was never scheduled".
 * Both mean no judgement about the traveller was ever made, which is the one
 * kind of absence the contract calls a defect regardless of the board.
 *
 * `unread` — the cell contributed records *and* is named as cut short — is
 * deliberately not in this union: the gate's printed claim is "produced no
 * place records at all", and widening a blocker's membership is a contract
 * change, not an attribution fix. It is reported, counted as not acquired,
 * and available to a future gate that wants it.
 */
export function neverInTheRoom(report: CanonicalRecallReport): SubjectRecall[] {
  return report.subjects.filter(
    (entry) => entry.verdict === 'never_read' || entry.verdict === 'outside_partition',
  );
}
