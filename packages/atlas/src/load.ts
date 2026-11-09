import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Atlas, destinationCatalog, type AtlasArtifact, type AtlasEmbeddings, type AtlasOptions } from '@sidequest/core';

/**
 * LOADING THE GLOBAL DESTINATION ATLAS.
 *
 * One gzipped file, committed beside this package (`data/atlas.json.gz`, built
 * by `build/`), read and decoded once per process. Nothing is downloaded at
 * request time and nothing is downloaded at start-up: the product's knowledge of
 * the world ships with the product, and a rebuild is a new commit.
 *
 * The file is found by walking up from wherever the server happens to run
 * (`apps/web` under `next start`, the repository root under Vitest), or at
 * `SIDEQUEST_ATLAS_PATH` when a deployment keeps it elsewhere.
 */

export const ATLAS_FILE = 'packages/atlas/data/atlas.json.gz';

export function atlasPath(): string | null {
  const configured = process.env.SIDEQUEST_ATLAS_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  const starts = [process.cwd()];
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* bundled without a file URL: the working directory is enough */
  }
  for (const start of starts) {
    let folder = resolve(start);
    for (let hop = 0; hop < 8; hop += 1) {
      const candidate = join(folder, ATLAS_FILE);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
  return null;
}

export function readAtlasArtifact(path: string): AtlasArtifact {
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as AtlasArtifact;
}

export interface LoadedAtlas {
  atlas: Atlas;
  path: string;
  loadMs: number;
  /** Why the meaning channel is off, when it is; the atlas then retrieves on words alone. */
  embeddings: 'attached' | string;
}

/*
 * Process-wide rather than module-local. Next bundles the instrumentation hook
 * separately from the pages, so a plain `let` gave the warm-up at start-up one
 * copy of this module and the first request another: two decoded atlases and no
 * benefit (performance pass, 2026-11).
 */
const SLOT = Symbol.for('sidequest.atlas.state');
interface AtlasState {
  held: LoadedAtlas | null;
  failed: string | null;
}
function state(): AtlasState {
  const scope = globalThis as unknown as Record<symbol, AtlasState | undefined>;
  return (scope[SLOT] ??= { held: null, failed: null });
}

/**
 * The atlas, or null with the reason when the file is missing or unreadable —
 * in which case the caller falls back to the curated catalog alone and says so.
 * A missing file never throws on a request path.
 */
export function loadAtlas(options: AtlasOptions = {}): LoadedAtlas | null {
  const slot = state();
  if (slot.held) return slot.held;
  if (slot.failed) return null;
  const path = atlasPath();
  if (!path) {
    slot.failed = 'atlas file not found';
    return null;
  }
  try {
    const started = performance.now();
    const atlas = new Atlas(readAtlasArtifact(path), destinationCatalog(), options);
    let embeddings: LoadedAtlas['embeddings'] = 'no embedding file';
    const beside = join(dirname(path), 'embeddings.json.gz');
    if (process.env.SIDEQUEST_ATLAS_EMBEDDINGS?.trim().toLowerCase() === 'off') embeddings = 'switched off';
    else if (existsSync(beside)) {
      try {
        embeddings = atlas.attachEmbeddings(JSON.parse(gunzipSync(readFileSync(beside)).toString('utf8')) as AtlasEmbeddings) ?? 'attached';
      } catch (error) {
        embeddings = error instanceof Error ? error.message : 'unreadable embedding file';
      }
    }
    /* Its own ODbL database, kept beside the atlas and joined only here, in memory. Absent means unknown, never "no skiing". */
    const skiFile = join(dirname(path), 'ski-areas.odbl.json.gz');
    if (existsSync(skiFile)) {
      try {
        atlas.attachSkiAreas((JSON.parse(gunzipSync(readFileSync(skiFile)).toString('utf8')) as { rows: number[][] }).rows);
      } catch {
        /* Unreadable ski data costs the lift check, nothing else. */
      }
    }
    slot.held = { atlas, path, loadMs: Math.round(performance.now() - started), embeddings };
    return slot.held;
  } catch (error) {
    slot.failed = error instanceof Error ? error.message : String(error);
    return null;
  }
}

export function atlasFailure(): string | null {
  return state().failed;
}

/** For tests: forget the loaded atlas so the next call reads the file again. */
export function resetAtlasForTests(): void {
  const slot = state();
  slot.held = null;
  slot.failed = null;
}
