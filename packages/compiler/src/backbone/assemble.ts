import {
  packScopeHash,
  regionPackSchema,
  REGION_PACK_VERSION,
  scopeCenter,
  type GeographicScope,
  type PackDiagnostics,
  type PackLayer,
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

  const failedCells = input.layers.flatMap((layer) => layer.failedCellIds);
  const incomplete =
    input.incompleteBecause ??
    (failedCells.length > 0
      ? `${new Set(failedCells).size} of ${input.partition.cells.length} areas could not be read.`
      : input.partition.droppedCells > 0
        ? `${input.partition.droppedCells} areas were outside this build's limit and were not read.`
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
