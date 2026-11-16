import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ComponentIndex, type WaterIndex } from '@sidequest/core';
import { atlasPath } from './load';

/**
 * The offline land and lake indexes (`build/10-water.py`), read once per
 * process from beside the atlas. The land file is its own ODbL database
 * (© OpenStreetMap contributors) and is only ever joined in memory; the lake
 * file is HydroLAKES (CC BY 4.0). Missing or unreadable files mean "unknown",
 * never "no water": `assessCrossing(null, …)` answers `unknown` and nothing
 * downstream changes.
 */
export const LAND_FILE = 'land.odbl.bin.gz';
export const LAKES_FILE = 'lakes.ccby.bin.gz';

const SLOT = Symbol.for('sidequest.water.state');
interface WaterState {
  held: WaterIndex | null;
  tried: boolean;
}
function state(): WaterState {
  const scope = globalThis as unknown as Record<symbol, WaterState | undefined>;
  return (scope[SLOT] ??= { held: null, tried: false });
}

export function loadWaterIndex(): WaterIndex | null {
  const slot = state();
  if (slot.tried) return slot.held;
  slot.tried = true;
  if (process.env.SIDEQUEST_WATER_INDEX?.trim().toLowerCase() === 'off') return null;
  const atlas = atlasPath();
  if (!atlas) return null;
  const landFile = join(dirname(atlas), LAND_FILE);
  if (!existsSync(landFile)) return null;
  try {
    const land = new ComponentIndex(gunzipSync(readFileSync(landFile)));
    let lakes: ComponentIndex | null = null;
    const lakesFile = join(dirname(atlas), LAKES_FILE);
    if (existsSync(lakesFile)) {
      try {
        lakes = new ComponentIndex(gunzipSync(readFileSync(lakesFile)));
      } catch {
        /* An unreadable lake file costs the lake check, nothing else. */
      }
    }
    slot.held = { land, lakes };
  } catch (error) {
    console.error('The land index could not be loaded; water crossings are judged by routers alone.', { reason: error instanceof Error ? error.message : String(error) });
    slot.held = null;
  }
  return slot.held;
}

/** For tests: forget the loaded index. */
export function resetWaterIndexForTests(): void {
  const slot = state();
  slot.held = null;
  slot.tried = false;
}
