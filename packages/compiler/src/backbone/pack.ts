import type {
  GeographicScope,
  PackCell,
  PackLayer,
  RegionPack,
  SourceRelease,
} from '@sidequest/core';

/**
 * THE SEAM THE PLACE BACKBONE TALKS TO.
 *
 * Two interfaces rather than one, because release discovery and data extraction
 * fail differently and are cached differently. A catalogue that is briefly
 * unreachable should not stop a build that already has a pinned release; an
 * extraction that runs out of bytes should not invalidate the pin.
 *
 * Nothing in either signature names a catalogue, a file format, a country or a
 * kind of place. A hosted extraction service, a local index and a bounded
 * range-read over cloud-hosted columnar files all satisfy the same shapes.
 */

/**
 * Scope membership travels with the seam, because it is part of the contract.
 *
 * A provider that reads a bounded box has to be told what belonging means, or it
 * will hand back whatever the box contained — which is the defect this phase
 * exists to remove. Re-exported here rather than added to the package barrel so
 * that the barrel keeps one entry per module and adapters get containment from
 * the same import they already take the provider interfaces from.
 */
export * from './containment';

export interface ReleaseCatalogProvider {
  readonly name: string;
  /**
   * The newest release this build can read, pinned for one pack build.
   *
   * Returns the release **and** whether it was newer than the one asked for, so
   * a caller can offer a refresh rather than performing one. Nothing here
   * downloads on a page render.
   */
  latestRelease(input: { now: Date }): Promise<SourceRelease>;
}

/** Why an extraction stopped short. Never silent, never inferred downstream. */
export const EXTRACTION_STOP_REASONS = [
  'complete',
  'cell_budget',
  'byte_budget',
  'feature_budget',
  'time_budget',
  'provider_error',
  'schema_incompatible',
  'cancelled',
] as const;
export type ExtractionStopReason = (typeof EXTRACTION_STOP_REASONS)[number];

export interface ExtractionBudget {
  /** Files whose footers may be read. */
  maxFiles: number;
  /** Row groups that may actually be decoded. The real cost dial. */
  maxRowGroups: number;
  maxBytes: number;
  /** Features decoded, before filtering. */
  maxFeaturesRead: number;
  /** Features kept after filtering. */
  maxFeaturesRetained: number;
  /** Wall-clock ceiling for the whole extraction. */
  maxMs: number;
}

export const DEFAULT_EXTRACTION_BUDGET: ExtractionBudget = {
  maxFiles: 12,
  maxRowGroups: 90,
  maxBytes: 220_000_000,
  maxFeaturesRead: 400_000,
  maxFeaturesRetained: 6_000,
  maxMs: 90_000,
};

export interface LayerExtractionResult {
  layer: PackLayer;
  bytesTransferred: number;
  filesInspected: number;
  rowGroupsInspected: number;
  rowGroupsRead: number;
  stoppedBecause: ExtractionStopReason;
  ms: number;
}

/**
 * One layer, over one set of cells, against one pinned release.
 *
 * Per-layer rather than per-pack so a layer that fails takes only itself down —
 * the same reasoning that split one Overpass union into six requests, and for
 * the same observed reason: a national park whose geographic layer answers and
 * whose place layer does not is a thin region, not an empty one.
 */
export interface ScopedExtractionProvider {
  readonly name: string;
  /** Which layers this provider can serve, in the order they should be tried. */
  layers(): readonly { id: string; kind: PackLayer['kind'] }[];
  extract(input: {
    layerId: string;
    release: SourceRelease;
    cells: readonly PackCell[];
    budget: ExtractionBudget;
    /** Absolute epoch-ms deadline. A provider past it must stop and say so. */
    deadlineMs: number;
    signal?: AbortSignal;
  }): Promise<LayerExtractionResult>;
}

/**
 * What a caller gets back when it asks for a pack.
 *
 * `source` is the honest part: a pack served from the store, one built now, one
 * built from an older release, and one that could not be built at all are four
 * different things to tell a traveller, and collapsing them is how a stale map
 * gets presented as today's.
 */
export type RegionPackOutcome =
  | { kind: 'ready'; pack: RegionPack; source: 'cache' | 'built' }
  | { kind: 'stale'; pack: RegionPack; reason: string }
  | { kind: 'partial'; pack: RegionPack; reason: string }
  | { kind: 'unavailable'; code: string; message: string };

export interface RegionPackProvider {
  readonly name: string;
  /**
   * A pack covering this scope.
   *
   * `forceRefresh` is the only way to reach a newer release, and it is a
   * deliberate act: a build that silently rebuilt on every newer release would
   * make two compilations of the same trip incomparable, and would spend
   * bandwidth on a page render.
   */
  getPack(input: {
    scope: GeographicScope;
    now: Date;
    forceRefresh?: boolean;
    onProgress?: (progress: PackProgress) => void;
    signal?: AbortSignal;
  }): Promise<RegionPackOutcome>;
}

export interface PackProgress {
  state: RegionPack['state'];
  /** "3 of 6 areas" — a real number, never a percentage of unknown work. */
  detail: string;
}
