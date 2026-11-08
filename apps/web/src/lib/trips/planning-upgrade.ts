import 'server-only';
import { scanBaseUpgrade } from '@sidequest/core';
import { compiledRegionFor } from '@/lib/region';

/**
 * Whether the trip page should offer "Rebuild with improved planning".
 *
 * A pure read of the adopted compiled region — no provider, no model, nothing
 * written — so it is safe on a render. Only the two counts reach the client.
 */
export function planningUpgradeFor(tripId: string): { storedBaseCount: number; currentBaseCount: number } | null {
  try {
    const region = compiledRegionFor(tripId);
    const upgrade = region ? scanBaseUpgrade(region) : null;
    return upgrade ? { storedBaseCount: upgrade.storedBaseCount, currentBaseCount: upgrade.currentBaseCount } : null;
  } catch {
    return null;
  }
}
