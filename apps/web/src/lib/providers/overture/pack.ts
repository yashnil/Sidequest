import 'server-only';
import {
  assemblePack,
  classifySourceCategory,
  failedPack,
  partitionScope,
  scopeBounds,
  type ExtractionBudget,
  type RegionPackOutcome,
  type RegionPackProvider,
} from '@sidequest/compiler';
import {
  assessPlaceStanding,
  experienceSignificanceOf,
  type GeoBounds,
  type GeographicScope,
  type PackCell,
  type PackLayer,
  type PlanningRole,
  type RecordContainment,
  type SourceRecord,
  type SourceRelease,
} from '@sidequest/core';
import { CatalogError, fileIntersects, latestRelease, themeFiles, type FetchOptions } from './catalog';
import { LAYERS, type LayerDefinition, type NormalizeContext } from './normalize';
import {
  ScanError,
  pointOf,
  rowPointInBox,
  scanFile,
  type BoundingBox,
  type ScanBudget,
  type ScanCounters,
} from './scan';

/**
 * BUILDING A REGION PACK.
 *
 * The orchestration is deliberately dull, because the interesting decisions were
 * all made elsewhere: the catalogue prunes files, the format prunes row groups,
 * the taxonomy table classifies, the linker relates. What is left here is
 * ordering, budgeting and honesty.
 *
 * **Ordering.** Divisions first, so every later record can be told which
 * neighbourhood it is in. Places second, because it is the inventory. The
 * geographic layers last, because when a budget runs out it should cost the
 * supplement rather than the primary source.
 *
 * **Budgeting.** One budget for the whole build, spent by whichever layer runs
 * next. Retention is distributed *per cell* before it is distributed by rank,
 * so a dense corner cannot consume a whole region's allowance and leave the
 * quiet half of a national park unread — and unspent quota is redistributed
 * afterwards, so a sparse region reads more of itself rather than stopping at an
 * even share of nothing.
 *
 * **Honesty.** Every layer records the cells it could not read. A pack with a
 * failed layer is `partial`, is labelled, and is still usable — which is the
 * whole difference between this and the previous discovery path, where one
 * refusal produced a region that read as though the destination were empty.
 *
 * **Membership.** The box a scan is paid for over is not the destination. It is
 * the union of partition cells drawn around whatever shape the scope has, and
 * for every city, town, county and district in the index that shape is a reach
 * circle rather than a boundary. So a record that comes back is asked, once, on
 * the evidence it now carries, whether it belongs — and one that does not is
 * left out here rather than being handed on as though somebody had checked.
 * Administrative geography is exempt, because it is the evidence the question is
 * answered *from*: a division from the next area along is how a record near the
 * edge gets a locality at all.
 */

export interface PackProviderOptions {
  budget?: Partial<ExtractionBudget>;
  fetchOptions?: FetchOptions;
  /** Injected so a test can build a pack without a clock or a network. */
  now?: () => Date;
  idFor?: (scope: GeographicScope, release: SourceRelease) => string;
  /**
   * The columnar reader, injected.
   *
   * The catalogue side of this provider has always been drivable offline
   * through `fetchOptions.fetchImpl`, and the *acquisition* side never was — so
   * the budgeting and retention decisions that turned a metropolis into one
   * corner of itself had no test that could see them, and the unit tests around
   * the pure helpers stayed green while the wiring between them was the defect.
   * A seam here costs one parameter and makes the whole path assertable with no
   * network and no parquet.
   */
  scanImpl?: typeof scanFile;
}

const DEFAULT_BUDGET: ExtractionBudget = {
  maxFiles: 14,
  maxRowGroups: 40,
  maxBytes: 260_000_000,
  maxFeaturesRead: 500_000,
  maxFeaturesRetained: 4_000,
  maxMs: 100_000,
};

/**
 * How much of the retention budget each layer may claim.
 *
 * Places is the inventory and gets the largest share; the geographic layers
 * together get nearly as much, because a national park's whole inventory lives
 * in them; divisions gets a small fixed share because a few hundred polygons
 * answer every containment question a region has.
 */
const LAYER_SHARE: Record<string, number> = {
  divisions: 0.08,
  places: 0.46,
  land: 0.14,
  water: 0.12,
  land_use: 0.12,
  infrastructure: 0.08,
};

/**
 * WHAT A CELL'S RETENTION IS SPENT ON, BY WHAT THE RECORD IS FOR.
 *
 * A cell's share used to be spent first-come: whichever records the reader
 * happened to decode first filled it, in parquet row order. On a dense city
 * that is a lottery weighted by commercial mapping density, and the live
 * result was a metropolitan pack of 1,840 places holding 726 records the
 * planner can never use — cash machines, dental clinics, package lockers — and
 * 103 attractions, none of which was one of the city's landmarks.
 *
 * §12.2 says the raw search may be broad and the kept set must be *deliberately
 * bounded*, so the boundary is drawn here, by purpose. Every family is
 * represented because a pack is ground rather than a board — a day still needs
 * a meal, a station and a shop — and unspent share flows to whoever can use it,
 * so a coast with no restaurants reads more coast rather than holding empty
 * seats for restaurants that do not exist.
 *
 * The residual family is the one that matters most and is easiest to miss.
 * A record whose role is `excluded` can never become a candidate — the
 * inventory's `roleOfRecord` honours a stored refusal permanently — so every
 * seat it takes is a seat no traveller will ever see. It keeps a small share
 * rather than none because the linker reads across layers and a pack is
 * evidence as well as inventory.
 */
const RECALL_FAMILY_SHARE: Record<RecallFamily, number> = {
  visitable: 0.5,
  food: 0.2,
  practical: 0.2,
  residual: 0.1,
};

type RecallFamily = 'visitable' | 'food' | 'practical' | 'residual';

function recallFamilyOf(role: PlanningRole): RecallFamily {
  switch (role) {
    case 'attraction':
    case 'outdoor':
    case 'side_quest':
    case 'market':
      return 'visitable';
    case 'food':
      return 'food';
    case 'support':
    case 'gateway':
    case 'lodging':
      return 'practical';
    default:
      return 'residual';
  }
}

/**
 * HOW MUCH A RECORD WOULD COST US TO LOSE, FROM WHAT THE ROW ITSELF CARRIES.
 *
 * The ordering the retention pass never had. Records were kept first-N-per-cell
 * in parquet row order, and the overflow backfill was `overflow.slice(0, n)`
 * under a comment claiming "whatever is left over by rank" while doing no
 * ranking at all — so a condominium that happened to sit in an earlier row
 * group evicted whatever came later, which in a dense city is most of the city.
 *
 * This is deliberately the *same* model the compiler ranks candidates with —
 * `experienceSignificanceOf` over `assessPlaceStanding` — restricted to the
 * channels a single normalised row can answer for itself: what kind of thing
 * the source says it is, and whether a knowledge base or a public authority has
 * taken note of it. The pack-wide channels (cross-layer corroboration, the
 * region's own namesakes) genuinely cannot be known here, and an absent channel
 * is absent rather than guessed.
 *
 * Sharing the model matters more than the numbers. A separate hand-rolled score
 * here would be a second opinion about significance that nothing holds to the
 * first, which is precisely how "significance" became a count of alternate
 * names one layer down. Note in particular what is *not* read: the number of
 * attributes, websites or translated names a mapper filled in. §8.3 names
 * metadata completeness as the thing significance must never be, and a
 * retention pass that ranked on it would re-import the whole defect at the one
 * layer no downstream fix can reach.
 */
export function recallPriorityOf(record: SourceRecord): number {
  const taxonomy = classifySourceCategory({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
  });
  const standing = assessPlaceStanding({
    inKnowledgeBase: record.wikidataId !== undefined || record.attributes.wikipedia !== undefined,
    publishedSites: record.websiteCandidates,
    classifyingValues: [record.sourceCategory, ...record.sourceCategoryPath],
  });
  return experienceSignificanceOf({ standing, categoryWeight: taxonomy.significanceWeight });
}

/**
 * The records a layer keeps: every cell served, every family represented, and
 * significance first inside each of them.
 *
 * Three passes, and each one repairs a distinct half of the live failure:
 *
 * 1. **Per family, per cell, by priority.** A cell's seats are divided by what
 *    the records are *for* and then filled best-first, so a landmark cannot be
 *    evicted by a cash machine that decoded earlier.
 * 2. **Unspent share redistributed inside the cell**, so a family with nothing
 *    to offer does not hold seats empty while another queue is full.
 * 3. **Backfill round-robin across cells, by priority.** This is the pass that
 *    produced the corner: it was a flat `slice`, and because the row-group
 *    budget only ever reached one part of the box, 1,430 of 1,840 records —
 *    78% of a metropolis — were backfilled from a single grid cell while seven
 *    others, including the one containing the traveller's own base, held none.
 *    Taking one cell at a time means a backfill can never do that again, even
 *    when the read *was* lopsided.
 *
 * Exported so the property can be measured against real pack records rather
 * than only inferred from a live build nobody can afford to run in a test.
 */
export function retainAcrossCells(input: {
  records: readonly SourceRecord[];
  retentionCap: number;
  perCellCap: number;
  priorityOf?: (record: SourceRecord) => number;
  /**
   * Record ids that are kept before any budget applies.
   *
   * Not a priority boost — an exemption. Everything else in this function is
   * about which of many comparable records deserve a scarce seat, and the
   * destination's own administrative record is not one of many: it is the thing
   * the pack is *about*, and it is the only evidence from which "does this
   * record belong to the traveller's destination" can be answered at all. A
   * stored Tokyo build proved what ranking it costs — the scan read the division
   * record sitting at the exact scope centre, retention ranked it against 800
   * neighbourhood polygons on the same significance model every place is ranked
   * on, and dropped it. Nothing downstream could recover it, and 3,767 of 3,787
   * records came back with no membership verdict.
   *
   * Kept outside the cap rather than inside it, so admitting the destination
   * cannot silently evict a record somebody would have seen.
   */
  pinned?: ReadonlySet<string>;
}): { kept: SourceRecord[]; dropped: number } {
  const priorityOf = input.priorityOf ?? recallPriorityOf;
  const cap = Math.max(0, Math.trunc(input.retentionCap));
  const perCellCap = Math.max(1, Math.trunc(input.perCellCap));

  const pinnedIds = input.pinned ?? new Set<string>();
  const pinnedRecords =
    pinnedIds.size === 0 ? [] : input.records.filter((record) => pinnedIds.has(record.id));
  const contested =
    pinnedIds.size === 0 ? input.records : input.records.filter((record) => !pinnedIds.has(record.id));

  /* Ranked once. Ties broken by id so a pack's bytes do not depend on I/O order. */
  const ranked = new Map<string, number>();
  for (const record of contested) ranked.set(record.id, priorityOf(record));
  const byRank = (a: SourceRecord, b: SourceRecord): number =>
    (ranked.get(b.id) ?? 0) - (ranked.get(a.id) ?? 0) || a.id.localeCompare(b.id);

  const cells = new Map<string, Map<RecallFamily, SourceRecord[]>>();
  for (const record of contested) {
    const families = cells.get(record.cellId) ?? new Map<RecallFamily, SourceRecord[]>();
    const family = recallFamilyOf(record.planningRole);
    const queue = families.get(family) ?? [];
    queue.push(record);
    families.set(family, queue);
    cells.set(record.cellId, families);
  }

  const kept: SourceRecord[] = [];
  const spare: SourceRecord[] = [];
  const cellIds = [...cells.keys()].sort();
  for (const cellId of cellIds) {
    const families = cells.get(cellId)!;
    for (const queue of families.values()) queue.sort(byRank);

    let takenInCell = 0;
    /* Fixed family order, so two runs over the same records agree exactly. */
    const order: RecallFamily[] = ['visitable', 'food', 'practical', 'residual'];
    for (const family of order) {
      const queue = families.get(family) ?? [];
      const share = Math.max(1, Math.round(perCellCap * RECALL_FAMILY_SHARE[family]));
      const take = Math.min(queue.length, share, Math.max(0, perCellCap - takenInCell));
      kept.push(...queue.slice(0, take));
      takenInCell += take;
      families.set(family, queue.slice(take));
    }
    /* Whatever the shares left unspent, to whoever is still queued, best first. */
    const leftover = [...families.values()].flat().sort(byRank);
    const remaining = Math.max(0, perCellCap - takenInCell);
    kept.push(...leftover.slice(0, remaining));
    spare.push(...leftover.slice(remaining).map((record) => record));
  }

  /*
   * The backfill, one cell at a time. `spare` is grouped again rather than
   * sorted globally: a global sort by priority would hand the whole backfill to
   * whichever cell the reader happened to cover, which is the corner bias in a
   * more respectable coat.
   */
  const spareByCell = new Map<string, SourceRecord[]>();
  for (const record of spare) {
    const queue = spareByCell.get(record.cellId) ?? [];
    queue.push(record);
    spareByCell.set(record.cellId, queue);
  }
  for (const queue of spareByCell.values()) queue.sort(byRank);
  const rotation = [...spareByCell.keys()].sort();
  let backfilled = 0;
  for (let round = 0; kept.length < cap; round += 1) {
    let progressed = false;
    for (const cellId of rotation) {
      if (kept.length >= cap) break;
      const next = spareByCell.get(cellId)![round];
      if (!next) continue;
      kept.push(next);
      backfilled += 1;
      progressed = true;
    }
    if (!progressed) break;
  }

  return {
    kept: [...pinnedRecords, ...kept.slice(0, cap)],
    dropped: Math.max(0, spare.length - backfilled),
  };
}

/**
 * THE DESTINATION'S OWN ADMINISTRATIVE RECORDS, AND THE ANCESTRY THEY NEED.
 *
 * Two kinds of record, and the second is the one that is easy to miss.
 *
 * The first is the destination itself: a record whose catalogue identifier is
 * one the scope declares. That is a division which *is* the destination rather
 * than one competing to describe it.
 *
 * The second is its published ancestry. A division is recognised through the
 * chain it publishes — the directory keys an entry by the last identifier in its
 * own chain — so a ward, a county or a first-level division named in the
 * destination's chain is the evidence by which a record near the edge is placed
 * inside it at all. Those are read from the destination's own published chain
 * rather than assumed from position, and only records the scan already returned
 * are pinned: nothing here manufactures a division the source did not hand us.
 */
export function destinationDivisionRecordIds(
  records: readonly SourceRecord[],
  identifiers: ReadonlySet<string>,
): Set<string> {
  if (identifiers.size === 0) return new Set();
  const own = records.filter(
    (record) => record.planningRole === 'administrative' && identifiers.has(record.sourceId),
  );
  if (own.length === 0) return new Set();

  const ancestry = new Set(own.flatMap((record) => record.containment.divisionIds));
  return new Set(
    records
      .filter(
        (record) =>
          record.planningRole === 'administrative' &&
          (identifiers.has(record.sourceId) || ancestry.has(record.sourceId)),
      )
      .map((record) => record.id),
  );
}

export function createOverturePackProvider(
  options: PackProviderOptions = {},
): RegionPackProvider {
  const budget: ExtractionBudget = { ...DEFAULT_BUDGET, ...options.budget };
  const now = options.now ?? ((): Date => new Date());

  return {
    name: 'overture-pack',
    async getPack(input): Promise<RegionPackOutcome> {
      const startedAt = Date.now();
      const deadlineMs = startedAt + budget.maxMs;
      const clock = input.now ?? now();

      let release: SourceRelease;
      try {
        release = await latestRelease(options.fetchOptions ?? {});
      } catch (error) {
        const message =
          error instanceof CatalogError
            ? error.message
            : 'We could not reach the place data catalogue.';
        return { kind: 'unavailable', code: 'provider_unavailable', message };
      }

      const partition = partitionScope(input.scope);
      input.onProgress?.({
        state: 'partitioning',
        detail: `${partition.cells.length} ${partition.cells.length === 1 ? 'area' : 'areas'} to read`,
      });

      const packId =
        options.idFor?.(input.scope, release) ??
        `pack-${input.scope.destinationCandidateId}-${release.releaseId}`;

      const counters: ScanCounters = {
        bytesTransferred: 0,
        rowGroupsInspected: 0,
        rowGroupsRead: 0,
        featuresRead: 0,
      };

      const layers: PackLayer[] = [];
      const layerTimings: { layerId: string; ms: number }[] = [];
      const budgetsExhausted = new Set<string>();
      let filesInspected = 0;
      const containment = new ContainmentIndex();

      /*
       * THE DESTINATION'S OWN IDENTITY IS NOT RESOLVED HERE ANY MORE.
       *
       * It used to be, mid-build, from the divisions layer, on a small share of
       * the extraction budget — and that made a *membership* answer depend on a
       * *budget*. Starve the divisions share and the destination's identity was
       * unresolvable, every candidate fell to the conservative rung, and the
       * consumer's escape hatch admitted the lot. One budget-starved build
       * reproduced the whole defect.
       *
       * The divisions the extraction *does* keep are stored in the pack like any
       * other layer, and the trip-scope overlay resolves both sides of the
       * comparison against them, per trip, with whatever coverage there is — and
       * reports the coverage rather than degrading into a promotion.
       */
      for (const definition of LAYERS) {
        if (input.signal?.aborted) {
          budgetsExhausted.add('cancelled');
          break;
        }
        const layerStart = Date.now();
        input.onProgress?.({ state: 'extracting', detail: labelFor(definition.id) });

        const result = await extractLayer({
          definition,
          release,
          cells: partition.cells,
          counters,
          budget,
          deadlineMs,
          fetchOptions: options.fetchOptions ?? {},
          containment,
          scan: options.scanImpl ?? scanFile,
          /*
           * What the traveller's own destination is, in catalogue identifiers.
           *
           * Carried into the extraction so retention can tell "the thing this
           * pack is about" from "another candidate for a seat". Empty for a
           * geocoded destination, which retains exactly as it did before.
           */
          destinationDivisionIds: new Set(input.scope.administrative?.divisionIds ?? []),
          ...(input.signal ? { signal: input.signal } : {}),
        });

        filesInspected += result.filesInspected;
        for (const reason of result.budgetsExhausted) budgetsExhausted.add(reason);
        layers.push(result.layer);
        layerTimings.push({ layerId: definition.id, ms: Date.now() - layerStart });

        if (definition.id === 'divisions') {
          /*
           * Loaded so the *labels* on later layers' records are real: a place
           * inside a published neighbourhood box gets that neighbourhood's name
           * as evidence. That is a fact about the ground and belongs in a pack.
           * What does not belong is a verdict about a traveller's destination.
           */
          containment.load(result.layer.records);
        }
      }

      const totalRecords = layers.reduce((sum, layer) => sum + layer.records.length, 0);
      if (totalRecords === 0) {
        return {
          kind: 'unavailable',
          code: 'coverage_insufficient',
          message:
            'The place data catalogue returned nothing for this area. That is usually a data gap rather than an empty place.',
        };
      }

      input.onProgress?.({ state: 'linking', detail: `${totalRecords} records` });

      const pack = assemblePack({
        id: packId,
        scope: input.scope,
        releases: [release],
        partition,
        layers,
        diagnostics: {
          filesInspected,
          rowGroupsInspected: counters.rowGroupsInspected,
          rowGroupsRead: counters.rowGroupsRead,
          bytesTransferred: counters.bytesTransferred,
          durationMs: Date.now() - startedAt,
          budgetsExhausted: [...budgetsExhausted].sort(),
          layerTimings,
        },
        now: clock,
      });

      if (pack.state === 'partial') {
        return {
          kind: 'partial',
          pack,
          reason: pack.failure?.detail ?? 'Some areas or layers could not be read in full.',
        };
      }
      return { kind: 'ready', pack, source: 'built' };
    },
  };
}

// ---------------------------------------------------------------------------
// One layer
// ---------------------------------------------------------------------------

interface LayerExtraction {
  layer: PackLayer;
  filesInspected: number;
  budgetsExhausted: string[];
}

async function extractLayer(input: {
  definition: LayerDefinition;
  release: SourceRelease;
  cells: readonly PackCell[];
  counters: ScanCounters;
  budget: ExtractionBudget;
  deadlineMs: number;
  fetchOptions: FetchOptions;
  containment: ContainmentIndex;
  scan: typeof scanFile;
  /** Catalogue identifiers of the division(s) the destination is. See the pin below. */
  destinationDivisionIds: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<LayerExtraction> {
  const { definition, cells, counters, budget } = input;
  const failedCellIds: string[] = [];
  const budgetsExhausted: string[] = [];

  const retentionCap = Math.max(
    20,
    Math.floor(budget.maxFeaturesRetained * (LAYER_SHARE[definition.id] ?? 0.1)),
  );
  const perCellCap = Math.max(4, Math.ceil(retentionCap / Math.max(1, cells.length)));

  let files;
  try {
    files = await themeFiles({
      release: input.release,
      theme: definition.theme,
      type: definition.type,
      options: input.fetchOptions,
    });
  } catch {
    return {
      layer: emptyLayer(definition, cells, 'The catalogue did not list this layer for this release.'),
      filesInspected: 0,
      budgetsExhausted: ['catalog'],
    };
  }

  const box = unionBox(cells);
  const matching = files.filter((file) => fileIntersects(file, box)).slice(0, budget.maxFiles);
  if (matching.length === 0) {
    return {
      layer: emptyLayer(definition, cells, 'This layer publishes nothing that covers that area.'),
      filesInspected: 0,
      budgetsExhausted: [],
    };
  }

  const collected: SourceRecord[] = [];
  const seen = new Set<string>();
  let featuresRead = 0;
  let filesInspected = 0;

  /**
   * HOW FAR TO READ, WHICH IS NOT THE SAME QUESTION AS HOW MUCH TO KEEP.
   *
   * These were the same number — the scan stopped at `retentionCap * 2.5` rows
   * — and on a dense destination that single line is the acquisition failure.
   * A metropolis's places layer has about two thousand in-box rows per row
   * group, so 1,840 × 2.5 = 4,600 rows is **two row groups**: the reader
   * stopped inside the first corner the stratified order reached, having
   * inspected 1,920 groups and read 20 of them across all six layers, with a
   * budget for 40 and a hundred-second clock it finished in eleven seconds.
   * Every landmark outside that corner was never in the room, so no amount of
   * ranking, significance or balancing downstream could have found it.
   *
   * So the read is bounded by what reading actually costs — row groups, bytes,
   * time — and the retention cap is spent afterwards, on ranked records
   * (`retainAcrossCells`). §12.2 in one sentence: the raw search may be broad,
   * and the kept set is deliberately bounded.
   *
   * `maxFeaturesRetained` survives as a *memory* ceiling rather than a policy:
   * a layer holding a hundred thousand normalised rows before ranking them is
   * a heap problem, and the ceiling is the point at which we would rather stop
   * than swap. It is far above any cap a real destination reaches through the
   * row-group budget.
   */
  const rowGroupAllowance = rowGroupAllowanceFor(definition.id, budget);
  const scanBudget: ScanBudget = {
    maxRowGroups: rowGroupAllowance,
    maxBytes: budget.maxBytes,
    maxFeaturesRead: budget.maxFeaturesRead,
    maxFeaturesRetained: RECALL_MEMORY_CEILING,
    deadlineMs: input.deadlineMs,
  };

  for (const file of matching) {
    if (input.signal?.aborted) {
      budgetsExhausted.push('cancelled');
      break;
    }
    if (counters.rowGroupsRead >= rowGroupAllowance) {
      budgetsExhausted.push('row_groups');
      break;
    }
    if (counters.bytesTransferred >= budget.maxBytes) {
      budgetsExhausted.push('bytes');
      break;
    }
    if (Date.now() > input.deadlineMs) {
      budgetsExhausted.push('time');
      break;
    }

    filesInspected += 1;
    try {
      const result = await input.scan<SourceRecord>({
        url: file.url,
        box,
        columns: definition.columns,
        requiredColumns: definition.requiredColumns,
        budget: scanBudget,
        counters,
        ...(input.signal ? { signal: input.signal } : {}),
        accept: (row) => {
          /**
           * The record's own position, not its bounding box's overlap.
           *
           * An administrative record covering a whole first-level division
           * overlaps a metropolitan box by one corner while sitting hundreds of
           * kilometres from it. On overlap it was admitted and then filed under
           * whichever cell its south-west corner landed in — two compounding
           * approximations, neither of which anybody had asked for.
           */
          if (!rowPointInBox(row, box)) return null;
          featuresRead += 1;
          const cell = cellFor(cells, row);
          if (!cell) return null;
          const context: NormalizeContext = {
            layerId: definition.id,
            cellId: cell.id,
            defaultLicenceId: definition.defaultLicenceId,
            containmentFor: (point) => input.containment.lookup(point),
          };
          const record = definition.normalize(row, context);
          if (!record) return null;
          if (seen.has(record.id)) return null;
          /*
           * NOTHING IS REFUSED HERE FOR NOT BELONGING.
           *
           * This used to be the one place a record was dropped on a containment
           * verdict, and the reasoning was that normalisation is the first moment
           * the record's own address exists. True, and beside the point: a pack
           * is traveller-independent ground, cached on the destination and the
           * bounds and shared between everybody going there, while a verdict
           * needs the traveller's scope, their regional expansion and their base
           * strategy — none of which exist yet, and one of which
           * (`includedAreas`) is in the pack's own cache key, so writing it here
           * would give every traveller their own pack.
           *
           * Worse, a record dropped at pack build is a record nothing downstream
           * can recover. The trip-scope overlay decides, per trip, after
           * expansion, from the typed evidence the normaliser attached.
           */
          seen.add(record.id);
          return record;
        },
      });

      /*
       * A LOOP, NOT A SPREAD, AND THE DIFFERENCE IS THE WHOLE LAYER.
       *
       * `collected.push(...result.rows)` passes every row as a separate
       * *argument*, and V8 refuses past ~109,832 of them with a RangeError —
       * measured on this runtime by bisection: 109,831 pushes, 109,832 throws.
       * `RECALL_MEMORY_CEILING` is 120,000, so the scan is allowed to return a
       * quantity the very next statement cannot accept, and the denser the
       * destination the more certainly it does.
       *
       * The failure was invisible offline because it needs a real metropolis to
       * reach the ceiling: the first live compilation of one read 122,627 place
       * features and retained **zero**, because the RangeError landed in the
       * catch below, which had no branch for it and filed every cell under the
       * generic `provider_error`. A board with no places, reported as a
       * provider being unreachable.
       *
       * There is no budget question here and nothing to tune — the rows are
       * already bounded by the ceiling. It is only ever how they are appended.
       */
      for (const row of result.rows) collected.push(row);

      if (result.stoppedBecause !== 'complete') {
        budgetsExhausted.push(result.stoppedBecause);
      }
    } catch (error) {
      if (error instanceof ScanError && error.code === 'schema_incompatible') {
        return {
          layer: emptyLayer(definition, cells, error.message),
          filesInspected,
          budgetsExhausted: ['schema'],
        };
      }
      /**
       * One file's failure is one file's failure.
       *
       * The cells it covered are recorded as unread and the next file is tried,
       * because a layer that gives up on the first refusal is the single-point
       * failure this whole phase exists to remove.
       */
      for (const cell of cells) {
        if (!failedCellIds.includes(cell.id)) failedCellIds.push(cell.id);
      }
      /*
       * `provider_error` is a claim about somebody else's service, and it was
       * being made about our own arithmetic. The first live compilation of a
       * metropolis reported exactly that while the provider had answered
       * perfectly and handed us 122,627 features we then failed to append.
       *
       * A fault on this side is named as one, so the next person reading a
       * diagnostic is not sent to check a volunteer endpoint that was never
       * the problem.
       */
      const code =
        error instanceof ScanError
          ? error.code
          : error instanceof RangeError
            ? 'internal_limit'
            : 'provider_error';
      budgetsExhausted.push(code);
    }
  }

  /**
   * Per-cell shares first, then the backfill by rank across cells.
   *
   * The first pass is what stops a dense corner eating a region's allowance;
   * the second is what stops a sparse region being held to an even share of
   * nothing — and, unlike the flat `slice` it replaces, it cannot hand the
   * whole backfill back to that same dense corner. Sorted at the end so the
   * layer's record order — and therefore the pack's content hash — does not
   * depend on which file answered first.
   */
  /*
   * And before any of it, the destination itself.
   *
   * A division that *is* the destination is not competing for a seat: it is the
   * only record from which membership can be decided, so it is kept outside the
   * budget rather than ranked against the ground it defines.
   */
  const retention = retainAcrossCells({
    records: collected,
    retentionCap,
    perCellCap,
    pinned: destinationDivisionRecordIds(collected, input.destinationDivisionIds),
  });
  const records = retention.kept;
  if (retention.dropped > 0) budgetsExhausted.push('retained');
  records.sort((a, b) => a.id.localeCompare(b.id));

  const failed = records.length === 0 ? cells.map((cell) => cell.id) : failedCellIds;

  return {
    layer: {
      id: definition.id,
      kind: definition.kind,
      catalog: input.release.catalog,
      datasetPath: `${definition.theme}/${definition.type}`,
      licenceId: definition.defaultLicenceId,
      records,
      featuresRead,
      featuresRetained: records.length,
      failedCellIds: [...new Set(failed)],
      ...(records.length === 0
        ? { note: 'Nothing in this layer covered that area, or it could not be read.' }
        : {}),
    },
    filesInspected,
    budgetsExhausted,
  };
}

/**
 * A ceiling on how many normalised rows one layer holds before it ranks them.
 *
 * A memory guard, not a policy. The row-group, byte and time budgets are what
 * bound the read; this is the point at which holding the result in a Node heap
 * stops being reasonable, and it sits an order of magnitude above what a dense
 * metropolis reaches through those budgets. It exists so a pathological file —
 * one row group of a million rows, all in the box — degrades into a truncated
 * read that says so, rather than into an out-of-memory crash.
 */
const RECALL_MEMORY_CEILING = 120_000;

/**
 * HOW MANY ROW GROUPS THIS LAYER MAY READ, GIVEN THE LAYERS STILL TO COME.
 *
 * The budget's `maxRowGroups` is a *global* figure shared by every layer, and
 * it used to be consumed first-come. Two things follow from that, and both were
 * observed: a layer that stops early leaves the allowance unspent and no later
 * layer can use it (a live metropolitan build read 20 of 40), and a layer that
 * could read forever would take all 40 and leave the geographic layers — which
 * are where a national park's entire inventory lives — with none.
 *
 * So each layer may spend everything still unspent, *minus* what the layers
 * after it are owed by their share. That is a floor for them and a ceiling for
 * this one, it lets a quiet layer's leftovers flow forward, and it keeps the
 * global figure the only cost anybody has to reason about.
 */
export function rowGroupAllowanceFor(
  layerId: string,
  budget: Pick<ExtractionBudget, 'maxRowGroups'>,
): number {
  const order = LAYERS.map((layer) => layer.id);
  const index = order.indexOf(layerId);
  const laterShare = order
    .slice(index + 1)
    .reduce((sum, id) => sum + (LAYER_SHARE[id] ?? 0.1), 0);
  const reservedForLater = Math.floor(budget.maxRowGroups * laterShare);
  /*
   * The answer is a ceiling on the *shared* running count, not a fresh
   * per-layer allowance — a layer arriving with the budget partly spent gets
   * what is left of its ceiling. Nothing is added as a floor: the reservation
   * is itself the guarantee that a later layer has something to spend, and a
   * floor expressed against the running count would let six layers between them
   * exceed the global figure, which is the one number the cost of a build can
   * be reasoned about from.
   */
  return Math.max(0, Math.min(budget.maxRowGroups, budget.maxRowGroups - reservedForLater));
}

function emptyLayer(
  definition: LayerDefinition,
  cells: readonly PackCell[],
  note: string,
): PackLayer {
  return {
    id: definition.id,
    kind: definition.kind,
    catalog: 'overture',
    datasetPath: `${definition.theme}/${definition.type}`,
    licenceId: definition.defaultLicenceId,
    records: [],
    featuresRead: 0,
    featuresRetained: 0,
    failedCellIds: cells.map((cell) => cell.id),
    note,
  };
}

function unionBox(cells: readonly PackCell[]): BoundingBox {
  const first = cells[0]!;
  let box: BoundingBox = {
    west: first.bounds.southWest.lng,
    south: first.bounds.southWest.lat,
    east: first.bounds.northEast.lng,
    north: first.bounds.northEast.lat,
  };
  for (const cell of cells.slice(1)) {
    box = {
      west: Math.min(box.west, cell.bounds.southWest.lng),
      south: Math.min(box.south, cell.bounds.southWest.lat),
      east: Math.max(box.east, cell.bounds.northEast.lng),
      north: Math.max(box.north, cell.bounds.northEast.lat),
    };
  }
  return box;
}

/**
 * Which cell a record is counted against, from the record's own position.
 *
 * The south-west corner of a bounding box was used here, and for a point feature
 * that is exact and for anything with real extent it is not: a park spanning two
 * cells was filed under the cell its lowest, westernmost corner fell in, which
 * for a large feature is a different place from where it is. Retention is
 * distributed per cell, so mis-filing skews the distribution that exists to stop
 * one dense corner eating a region's allowance.
 */
function cellFor(cells: readonly PackCell[], row: Record<string, unknown>): PackCell | null {
  const point = pointOf(row);
  if (!point) return null;
  for (const cell of cells) {
    if (
      point.lat >= cell.bounds.southWest.lat &&
      point.lat <= cell.bounds.northEast.lat &&
      point.lng >= cell.bounds.southWest.lng &&
      point.lng <= cell.bounds.northEast.lng
    ) {
      return cell;
    }
  }
  return null;
}

function labelFor(layerId: string): string {
  switch (layerId) {
    case 'divisions':
      return 'working out the neighbourhoods';
    case 'places':
      return 'reading the place catalogue';
    case 'land':
      return 'reading the terrain';
    case 'water':
      return 'reading the lakes and coast';
    case 'land_use':
      return 'reading the parks';
    default:
      return 'reading the local infrastructure';
  }
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/**
 * Which administrative area a point falls in, from published boundaries only.
 *
 * Smallest containing area wins, which is why the index is sorted by area: a
 * point inside a neighbourhood is also inside its city and its country, and the
 * useful answer is the innermost one.
 *
 * Coverage is not uniform worldwide and the API says so by returning an empty
 * containment rather than a guess. A missing neighbourhood degrades a label; it
 * never invalidates a place whose coordinates are known.
 */
class ContainmentIndex {
  private entries: { bounds: GeoBounds; area: number; containment: RecordContainment }[] = [];

  load(records: readonly SourceRecord[]): void {
    this.entries = records
      .filter((record): record is SourceRecord & { bounds: GeoBounds } => record.bounds !== undefined)
      .map((record) => ({
        bounds: record.bounds,
        area:
          Math.abs(record.bounds.northEast.lat - record.bounds.southWest.lat) *
          Math.abs(record.bounds.northEast.lng - record.bounds.southWest.lng),
        containment: {
          ...record.containment,
          ...(record.attributes.subtype === 'locality' ? { localityName: record.name } : {}),
          ...(record.attributes.subtype === 'neighborhood' ||
          record.attributes.subtype === 'neighbourhood'
            ? { neighbourhoodName: record.name }
            : {}),
        },
      }))
      .sort((a, b) => a.area - b.area);
  }

  lookup(point: { lat: number; lng: number }): RecordContainment {
    const found: RecordContainment = { divisionIds: [] };
    for (const entry of this.entries) {
      if (
        point.lat < entry.bounds.southWest.lat ||
        point.lat > entry.bounds.northEast.lat ||
        point.lng < entry.bounds.southWest.lng ||
        point.lng > entry.bounds.northEast.lng
      ) {
        continue;
      }
      // Innermost first, and each field is filled only once, so a larger area
      // never overwrites a smaller one's answer.
      if (!found.neighbourhoodName && entry.containment.neighbourhoodName) {
        found.neighbourhoodName = entry.containment.neighbourhoodName;
      }
      if (!found.localityName && entry.containment.localityName) {
        found.localityName = entry.containment.localityName;
      }
      if (!found.regionName && entry.containment.regionName) {
        found.regionName = entry.containment.regionName;
      }
      if (!found.countryCode && entry.containment.countryCode) {
        found.countryCode = entry.containment.countryCode;
      }
      /**
       * The **whole** parent chain, and the truncation that used to be here was
       * a real defect.
       *
       * It kept the two innermost identifiers, on a size argument — six ids of
       * about forty characters on every record is nearly a megabyte for a dense
       * city — and a claim that "two is enough to group satellites by their
       * parent area, which is what anything downstream actually reads them for".
       * That consumer no longer exists. This field is now the input to the
       * strongest membership test there is: a candidate's chain against the
       * identity of the division the destination *is*. A record inside a
       * neighbourhood inside a borough inside the selected city carried
       * `[borough, neighbourhood]`, the city's id was gone, and the rung
       * silently returned false. For a region- or country-breadth destination it
       * could essentially never fire.
       */
      if (found.divisionIds.length === 0 && entry.containment.divisionIds.length > 0) {
        found.divisionIds = [...entry.containment.divisionIds];
      }
      if (found.neighbourhoodName && found.localityName && found.countryCode) break;
    }
    return found;
  }
}

/** The ground a scope covers, as the scanner's box. Exported for diagnostics. */
export function scanBoxFor(scope: GeographicScope): BoundingBox {
  const bounds = scopeBounds(scope);
  return {
    west: bounds.southWest.lng,
    south: bounds.southWest.lat,
    east: bounds.northEast.lng,
    north: bounds.northEast.lat,
  };
}

export { failedPack };
