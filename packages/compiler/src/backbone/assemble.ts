import {
  packScopeHash,
  regionPackSchema,
  REGION_PACK_VERSION,
  scopeCenter,
  type GeographicScope,
  type PackDiagnostics,
  type PackLayer,
  type PackLayerCoverage,
  type PartitionPlan,
  type RegionPack,
  type RegionPackState,
  type SourceRelease,
} from '@sidequest/core';
import { linkRecords } from './link';
import { packLicences } from './inventory';
import { scopeBounds } from './partition';

/**
 * PUTTING A PACK TOGETHER, AND REFUSING TO CALL A BROKEN ONE READY.
 *
 * Assembly is where the immutability promise is actually kept. A pack is
 * validated against its schema, hashed over its own contents, and only then
 * given a terminal state — so a build that fell over half-way produces a
 * `partial` or a `failed` row rather than a `ready` one that blows up on the
 * screen after it.
 *
 * The content hash covers the records, the pin and the partition, and nothing
 * else. Not the timings, not the byte counts, not the clock: two builds of the
 * same ground from the same release should hash identically even though one took
 * four seconds longer, because that is what lets a caller tell "the world
 * changed" from "the network was slower today".
 */

export interface AssembleInput {
  id: string;
  scope: GeographicScope;
  releases: readonly SourceRelease[];
  partition: PartitionPlan;
  layers: readonly PackLayer[];
  diagnostics: Omit<PackDiagnostics, 'featuresRead' | 'featuresRetained'>;
  now: Date;
  /** Set when something was missed. Drives `partial` rather than `ready`. */
  incompleteBecause?: string;
  /** How long a pack of this release should be trusted before a refresh. */
  refreshAfterDays?: number;
}

export const DEFAULT_REFRESH_AFTER_DAYS = 45;

export function assemblePack(input: AssembleInput): RegionPack {
  const bounds = scopeBounds(input.scope);
  const records = input.layers.flatMap((layer) => layer.records);
  const links = linkRecords(records);

  const featuresRead = input.layers.reduce((total, layer) => total + layer.featuresRead, 0);
  const featuresRetained = records.length;

  const spatialCoverage = layerSpatialCoverage(input.layers, input.partition, bounds);
  /*
   * A lopsided places layer is a build defect, not a property of the ground.
   *
   * The failure this catches: a scan that stopped on a retained budget after
   * reading row groups from one corner produced a `ready` pack whose place
   * inventory covered a sixth of the requested box — and every downstream layer
   * then described the missing five sixths as an empty destination. The scan
   * now stratifies its reads, so tripping this means something upstream has
   * regressed or the source itself is holed; either way the pack is `partial`
   * and says why, because "ready" is a claim about the whole scope.
   */
  const lopsidedPlaces = spatialCoverage.find(
    (entry) =>
      entry.lopsided &&
      input.layers.some((layer) => layer.id === entry.layerId && layer.kind === 'primary_places'),
  );

  /*
   * A LOPSIDED ADMINISTRATIVE LAYER IS A MEMBERSHIP FAILURE, NOT A THIN ONE.
   *
   * The check above was written for the place inventory, and the administrative
   * layer fails differently and worse. Places decide *what there is to do*;
   * divisions decide *what belongs*, and they are the only thing that does —
   * a city publishes no polygon, so `inside_selected_division` is the strongest
   * positive available and it is resolved entirely out of this layer.
   *
   * Measured on the Tokyo pack stored on this machine: the divisions layer read
   * 800 features, retained its cap of 320, and those 320 span a quarter of the
   * requested box's latitude — one strip of wards, none of them the destination's
   * own. The pack was written `ready`. Downstream, 3,767 of 3,787 records came
   * back `membership_unknown`, every one of 56 attractions was demoted out of
   * the anchor slot, and the board said "64 things to do, 0 of which could hold
   * a morning" without anything anywhere saying the ground had been read in a
   * strip. `ready` is a claim about the whole scope, and this is not one.
   */
  const lopsidedDivisions = spatialCoverage.find(
    (entry) =>
      entry.lopsided &&
      input.layers.some(
        (layer) => layer.id === entry.layerId && layer.kind === 'administrative_divisions',
      ),
  );

  const failedCells = input.layers.flatMap((layer) => layer.failedCellIds);
  const incomplete =
    input.incompleteBecause ??
    (failedCells.length > 0
      ? `${new Set(failedCells).size} of ${input.partition.cells.length} areas could not be read.`
      : input.partition.droppedCells > 0
        ? `${input.partition.droppedCells} areas were outside this build's limit and were not read.`
        : lopsidedPlaces
          ? `The place inventory covers only part of the requested area (${Math.round(
              Math.min(lopsidedPlaces.latSpanFraction, lopsidedPlaces.lngSpanFraction) * 100,
            )}% of its span on the narrower axis).`
          : lopsidedDivisions
            ? `The administrative layer covers only part of the requested area (${Math.round(
                Math.min(
                  lopsidedDivisions.latSpanFraction,
                  lopsidedDivisions.lngSpanFraction,
                ) * 100,
              )}% of its span on the narrower axis), so membership could not be decided everywhere.`
            : undefined);

  const state: RegionPackState = records.length === 0 ? 'failed' : incomplete ? 'partial' : 'ready';

  const candidate = {
    schemaVersion: REGION_PACK_VERSION,
    id: input.id,
    scopeHash: packScopeHash({
      destinationCandidateId: input.scope.destinationCandidateId,
      bounds,
    }),
    scope: {
      destinationCandidateId: input.scope.destinationCandidateId,
      destinationName: input.scope.destinationName,
      center: scopeCenter(input.scope),
      bounds,
      breadth: input.scope.breadth,
    },
    state,
    releases: [...input.releases],
    partition: input.partition,
    layers: [...input.layers],
    links,
    licences: [],
    diagnostics: {
      ...input.diagnostics,
      featuresRead,
      featuresRetained,
      ...(spatialCoverage.length > 0 ? { spatialCoverage } : {}),
    },
    contentHash: '',
    createdAt: input.now.toISOString(),
    ...(state === 'failed'
      ? {}
      : { completedAt: input.now.toISOString() }),
    refreshRecommendedAfter: new Date(
      input.now.getTime() + (input.refreshAfterDays ?? DEFAULT_REFRESH_AFTER_DAYS) * 86_400_000,
    ).toISOString(),
    ...(state === 'failed'
      ? {
          failure: {
            code: 'coverage_insufficient',
            detail: incomplete ?? 'No source layer returned anything for this area.',
          },
        }
      : {}),
  } satisfies Omit<RegionPack, 'licences' | 'contentHash'> & {
    licences: RegionPack['licences'];
    contentHash: string;
  };

  const withLicences: RegionPack = {
    ...candidate,
    licences: packLicences(candidate as RegionPack),
  };

  /**
   * Validated before it is hashed, and hashed before it is returned.
   *
   * The order matters: a hash over an object the schema would reject is an
   * identity for something that cannot exist, and a caller that cached it would
   * be caching a build failure under a name that looks like success.
   */
  const parsed = regionPackSchema.parse({ ...withLicences, contentHash: 'pending' });
  return { ...parsed, contentHash: contentHashOf(parsed) };
}

/**
 * Enough records that a narrow spread is a defect rather than a small place.
 *
 * A national-park pack legitimately holds sixty records along one valley; a
 * layer holding a hundred or more that all sit in one corner of the requested
 * box is a truncated read. The threshold is deliberately generous — the check
 * exists to catch a scan reading one percent of a metropolis, not to argue with
 * a sparse coastline.
 */
const COVERAGE_MIN_RECORDS = 100;

/** Below this span on either axis, a well-populated layer is lopsided. */
const COVERAGE_MIN_SPAN_FRACTION = 0.4;

/**
 * How much of the requested ground each layer's records actually span.
 *
 * Measured from the records' own coordinates against the scope bounds, plus
 * the share of partition cells holding at least one record. Pure arithmetic
 * over data the pack already carries; the verdict threshold is documented on
 * the constants above.
 */
export function layerSpatialCoverage(
  layers: readonly PackLayer[],
  partition: PartitionPlan,
  bounds: ReturnType<typeof scopeBounds>,
): PackLayerCoverage[] {
  const latSpan = bounds.northEast.lat - bounds.southWest.lat;
  const lngSpan = bounds.northEast.lng - bounds.southWest.lng;
  const cellCount = Math.max(1, partition.cells.length);

  const coverage: PackLayerCoverage[] = [];
  for (const layer of layers) {
    if (layer.records.length === 0) continue;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    const occupied = new Set<string>();
    for (const record of layer.records) {
      minLat = Math.min(minLat, record.coordinates.lat);
      maxLat = Math.max(maxLat, record.coordinates.lat);
      minLng = Math.min(minLng, record.coordinates.lng);
      maxLng = Math.max(maxLng, record.coordinates.lng);
      occupied.add(record.cellId);
    }
    const latSpanFraction = latSpan > 0 ? clamp01((maxLat - minLat) / latSpan) : 1;
    const lngSpanFraction = lngSpan > 0 ? clamp01((maxLng - minLng) / lngSpan) : 1;
    coverage.push({
      layerId: layer.id,
      recordCount: layer.records.length,
      latSpanFraction: round2(latSpanFraction),
      lngSpanFraction: round2(lngSpanFraction),
      occupiedCellShare: round2(clamp01(occupied.size / cellCount)),
      lopsided:
        layer.records.length >= COVERAGE_MIN_RECORDS &&
        (latSpanFraction < COVERAGE_MIN_SPAN_FRACTION ||
          lngSpanFraction < COVERAGE_MIN_SPAN_FRACTION),
    });
  }
  return coverage;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A stable hash over the parts of a pack that are claims about the world.
 *
 * FNV-1a over a canonical string rather than SHA-256, and deliberately so: this
 * is a cache and comparison identity, not a security boundary, and the compiler
 * package is pure TypeScript with no Node built-ins — importing `node:crypto`
 * here would make it unusable in any other runtime for no gain.
 */
export function contentHashOf(pack: RegionPack): string {
  const canonical = [
    `v${pack.schemaVersion}`,
    pack.scopeHash,
    ...pack.releases
      .map((release) => `${release.catalog}@${release.releaseId}`)
      .sort(),
    `cells:${pack.partition.cells.map((cell) => cell.id).sort().join(',')}`,
    ...pack.layers
      .map(
        (layer) =>
          `${layer.id}:${layer.records
            .map((record) => `${record.sourceId}#${record.name}`)
            .sort()
            .join('|')}`,
      )
      .sort(),
  ].join('\n');

  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A second pass with a different offset basis, concatenated, so two packs
  // differing only in a long tail do not collide as readily as 32 bits alone.
  let second = 0x1000193;
  for (let index = canonical.length - 1; index >= 0; index -= 1) {
    second ^= canonical.charCodeAt(index);
    second = Math.imul(second, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** A pack whose build failed outright, still schema-valid and still inspectable. */
export function failedPack(input: {
  id: string;
  scope: GeographicScope;
  releases: readonly SourceRelease[];
  partition: PartitionPlan;
  now: Date;
  code: string;
  detail: string;
}): RegionPack {
  const bounds = scopeBounds(input.scope);
  const pack: RegionPack = {
    schemaVersion: REGION_PACK_VERSION,
    id: input.id,
    scopeHash: packScopeHash({
      destinationCandidateId: input.scope.destinationCandidateId,
      bounds,
    }),
    scope: {
      destinationCandidateId: input.scope.destinationCandidateId,
      destinationName: input.scope.destinationName,
      center: scopeCenter(input.scope),
      bounds,
      breadth: input.scope.breadth,
    },
    state: 'failed',
    releases: [...input.releases],
    partition: input.partition,
    layers: [],
    links: [],
    licences: [],
    diagnostics: {
      filesInspected: 0,
      rowGroupsInspected: 0,
      rowGroupsRead: 0,
      bytesTransferred: 0,
      featuresRead: 0,
      featuresRetained: 0,
      durationMs: 0,
      budgetsExhausted: [],
      layerTimings: [],
    },
    contentHash: 'pending',
    createdAt: input.now.toISOString(),
    failure: { code: input.code, detail: input.detail },
  };
  const parsed = regionPackSchema.parse(pack);
  return { ...parsed, contentHash: contentHashOf(parsed) };
}
