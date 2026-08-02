import 'server-only';
import {
  assemblePack,
  failedPack,
  partitionScope,
  scopeBounds,
  type ExtractionBudget,
  type RegionPackOutcome,
  type RegionPackProvider,
} from '@sidequest/compiler';
import {
  type GeoBounds,
  type GeographicScope,
  type PackCell,
  type PackLayer,
  type RecordContainment,
  type SourceRecord,
  type SourceRelease,
} from '@sidequest/core';
import { CatalogError, fileIntersects, latestRelease, themeFiles, type FetchOptions } from './catalog';
import { LAYERS, type LayerDefinition, type NormalizeContext } from './normalize';
import { ScanError, rowInBox, scanFile, type BoundingBox, type ScanBudget, type ScanCounters } from './scan';

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
 */

export interface PackProviderOptions {
  budget?: Partial<ExtractionBudget>;
  fetchOptions?: FetchOptions;
  /** Injected so a test can build a pack without a clock or a network. */
  now?: () => Date;
  idFor?: (scope: GeographicScope, release: SourceRelease) => string;
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
          ...(input.signal ? { signal: input.signal } : {}),
        });

        filesInspected += result.filesInspected;
        for (const reason of result.budgetsExhausted) budgetsExhausted.add(reason);
        layers.push(result.layer);
        layerTimings.push({ layerId: definition.id, ms: Date.now() - layerStart });

        if (definition.id === 'divisions') containment.load(result.layer.records);
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

  const kept = new Map<string, SourceRecord[]>();
  const overflow: SourceRecord[] = [];
  const seen = new Set<string>();
  let featuresRead = 0;
  let filesInspected = 0;

  const scanBudget: ScanBudget = {
    maxRowGroups: budget.maxRowGroups,
    maxBytes: budget.maxBytes,
    maxFeaturesRead: budget.maxFeaturesRead,
    /**
     * Read somewhat past the layer's own cap, and not far past it.
     *
     * Overshoot is what gives the per-cell distribution and the overflow pass
     * something to choose from, so a dense corner does not simply arrive first
     * and win. It is also the dominant cost: decoding a row group is about two
     * seconds, and a six-fold overshoot had a live New York build reading
     * twenty-seven row groups and taking fifty-five seconds to keep four
     * thousand records. Two and a half is enough to have a choice.
     */
    maxFeaturesRetained: Math.ceil(retentionCap * 2.5),
    deadlineMs: input.deadlineMs,
  };

  for (const file of matching) {
    if (input.signal?.aborted) {
      budgetsExhausted.push('cancelled');
      break;
    }
    if (counters.rowGroupsRead >= budget.maxRowGroups) {
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
      const result = await scanFile<SourceRecord>({
        url: file.url,
        box,
        columns: definition.columns,
        requiredColumns: definition.requiredColumns,
        budget: scanBudget,
        counters,
        ...(input.signal ? { signal: input.signal } : {}),
        accept: (row) => {
          if (!rowInBox(row, box)) return null;
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
          seen.add(record.id);
          return record;
        },
      });

      for (const record of result.rows) {
        const bucket = kept.get(record.cellId) ?? [];
        if (bucket.length < perCellCap) {
          bucket.push(record);
          kept.set(record.cellId, bucket);
        } else {
          overflow.push(record);
        }
      }

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
      budgetsExhausted.push(error instanceof ScanError ? error.code : 'provider_error');
    }
  }

  /**
   * Per-cell shares first, then whatever is left over by rank.
   *
   * The first pass is what stops a dense corner eating a region's allowance; the
   * second is what stops a sparse region being held to an even share of nothing.
   * Sorted at the end so the layer's record order — and therefore the pack's
   * content hash — does not depend on which file answered first.
   */
  const records = [...kept.values()].flat();
  const remaining = Math.max(0, retentionCap - records.length);
  records.push(...overflow.slice(0, remaining));
  if (overflow.length > remaining) budgetsExhausted.push('retained');
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

function cellFor(cells: readonly PackCell[], row: Record<string, unknown>): PackCell | null {
  const bbox = row.bbox as { xmin?: number; ymin?: number } | undefined;
  const lat = bbox?.ymin;
  const lng = bbox?.xmin;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  for (const cell of cells) {
    if (
      lat >= cell.bounds.southWest.lat &&
      lat <= cell.bounds.northEast.lat &&
      lng >= cell.bounds.southWest.lng &&
      lng <= cell.bounds.northEast.lng
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
       * The two innermost parents, and no more.
       *
       * A full chain is six identifiers of about forty characters each, copied
       * onto every record in the pack — nearly a megabyte of a dense city's
       * pack, for a chain whose readable half is already carried as names. Two
       * is enough to group satellites by their parent area, which is what
       * anything downstream actually reads them for.
       */
      if (found.divisionIds.length === 0 && entry.containment.divisionIds.length > 0) {
        found.divisionIds = entry.containment.divisionIds.slice(-2);
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
