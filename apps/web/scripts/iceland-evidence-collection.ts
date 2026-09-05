/*
 * STEP 1 OF THE BOUNDED WHOLE-ROUTE REPAIR ROUND — COMPLETE RELOCATION
 * EVIDENCE, NO MODEL, NEVER STOPPING AT THE FIRST FAILURE.
 *
 * `assessRelocationFeasibility()` (the real production function) correctly
 * stops at the first infeasible leg with no remedy — that is the right
 * behaviour for hydration, but it means a single production run only ever
 * reports the *first* failing leg. This script measures all four mandatory
 * legs unconditionally, using the same real production functions
 * (`productionGeocodeLocality`, `productionRouteMatrix`,
 * `productionConfirmRoute`) the adapter itself uses, so a whole-route
 * repair can be built from complete evidence instead of one problem at a
 * time. NOT a second production hydration — no `planFromSkeleton()` call
 * here at all, just direct measurement.
 *
 * ZERO ANTHROPIC CALLS.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-evidence-collection.ts
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-production-hydration-2026-08-29');
const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';

async function main() {
  const { getTrip, getProfile } = await import('../src/lib/db/repository');
  const trip = getTrip(TRIP_ID);
  if (!trip) throw new Error(`Trip ${TRIP_ID} not found.`);
  const profile = getProfile(TRIP_ID);
  if (!profile) throw new Error(`Trip ${TRIP_ID} has no saved profile.`);

  const { resolveTripRegion, boardFor } = await import('../src/lib/region');
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) throw new Error(`Region resolution failed: ${resolved.error}`);
  const region = resolved.context;
  const board = boardFor(trip, profile, region);

  const { productionGeocodeLocality, productionRouteMatrix, productionConfirmRoute } = await import(
    '../src/lib/planning/skeleton-orchestrator'
  );
  const { createOpenProviders } = await import('../src/lib/providers/live');
  const { providers } = createOpenProviders({ maxModelCalls: 0 });

  // --- Resolve the five real base identities — the same deterministic
  // --- tiers the adapter itself uses: Reykjavík via the Discovery Board
  // --- (already established, real id, stable across every prior run this
  // --- session), Vík/Höfn/Akureyri via the same real geocoder call. -------
  const reykjavikId = 'land_use:decd76f4-1ec7-320c-837c-11d3968ee263';
  const reykjavikCandidate = board.candidates.find((c) => c.place.id === reykjavikId);
  if (!reykjavikCandidate) throw new Error('Reykjavík (Austurvöllur) not found on the board — cannot proceed.');
  const reykjavik = { id: reykjavikId, name: 'Reykjavik (Austurvöllur)', ...reykjavikCandidate.place.coordinates };

  async function geocodeOne(query: string, label: string) {
    const results = await productionGeocodeLocality(query);
    const accepted = results[0];
    if (!accepted) throw new Error(`No geocoder result for ${label}.`);
    return { id: accepted.sourceId, name: `${label} (${accepted.name})`, lat: accepted.lat, lng: accepted.lng };
  }
  const vik = await geocodeOne('Vik, Iceland', 'Vik');
  const hofn = await geocodeOne('Höfn, Iceland', 'Höfn');
  const akureyri = await geocodeOne('Akureyri, Iceland', 'Akureyri');

  console.log('Resolved base identities:');
  for (const b of [reykjavik, vik, hofn, akureyri]) console.log(' ', b.name, b.id, b.lat, b.lng);

  // --- Measure all four consecutive legs unconditionally, matrix first, --
  // --- direct confirmation only where the matrix has no trustworthy value. -
  const ceiling = profile.transport.maxDailyDriveMinutes;
  const legs: { from: typeof reykjavik; to: typeof reykjavik; label: string }[] = [
    { from: reykjavik, to: vik, label: 'Reykjavík → Vík' },
    { from: vik, to: hofn, label: 'Vík → Höfn' },
    { from: hofn, to: akureyri, label: 'Höfn → Akureyri' },
    { from: akureyri, to: reykjavik, label: 'Akureyri → Reykjavík' },
  ];

  const results: unknown[] = [];
  for (const leg of legs) {
    const matrixResult = await productionRouteMatrix(providers.routing, region.matrix.mode, [
      { id: leg.from.id, lat: leg.from.lat, lng: leg.from.lng },
      { id: leg.to.id, lat: leg.to.lat, lng: leg.to.lng },
    ]);
    const fromIndex = matrixResult?.ids.indexOf(leg.from.id) ?? -1;
    const toIndex = matrixResult?.ids.indexOf(leg.to.id) ?? -1;
    const matrixMinutes = fromIndex >= 0 && toIndex >= 0 ? matrixResult?.minutes[fromIndex]?.[toIndex] : undefined;
    const matrixKm = fromIndex >= 0 && toIndex >= 0 ? matrixResult?.km[fromIndex]?.[toIndex] : undefined;
    const matrixFound = typeof matrixMinutes === 'number' && Number.isFinite(matrixMinutes);

    let evidenceSource = 'matrix';
    let minutes: number | null = matrixFound ? (matrixMinutes as number) : null;
    let km: number | null = matrixFound ? (matrixKm as number) : null;
    let matrixFailureReason: string | null = null;
    if (!matrixFound) {
      matrixFailureReason = matrixResult?.failedPairs?.find((p) => p.fromId === leg.from.id && p.toId === leg.to.id)?.reason ?? null;
      const confirmation = await productionConfirmRoute(
        providers.routing,
        region.matrix.mode,
        { lat: leg.from.lat, lng: leg.from.lng },
        { lat: leg.to.lat, lng: leg.to.lng },
      );
      evidenceSource = 'direct_route_confirmation';
      if (confirmation?.found) {
        minutes = confirmation.minutes;
        km = confirmation.km;
      } else {
        minutes = null;
        km = null;
      }
    }

    const record = {
      leg: leg.label,
      fromId: leg.from.id,
      toId: leg.to.id,
      matrixFound,
      matrixFailureReason,
      evidenceSource,
      measuredMinutes: minutes,
      measuredKm: km,
      hardCeilingMinutes: ceiling,
      pass: minutes === null ? null : minutes <= ceiling,
    };
    results.push(record);
    console.log(JSON.stringify(record, null, 2));
  }

  writeFileSync(path.join(OUT_DIR, 'complete-relocation-evidence.json'), JSON.stringify(results, null, 2));
  console.log('\nAnthropic calls: 0');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
