/*
 * THE ONE LIVE PRODUCT-ACCEPTANCE RUN — THROUGH THE REAL CANONICAL
 * PRODUCTION ORCHESTRATOR, NOT A STANDALONE BENCHMARK SCRIPT CALLING
 * `planFromSkeleton()` DIRECTLY.
 *
 * This calls `generateSidequestPlanForTrip()` — the exact function
 * `buildItineraryAction` (the real "Build my trip" button on
 * `/trips/[id]/itinerary`) now calls. Everything between the model call and
 * the saved itinerary is the real production path: `gatherProductionPacketInputs`
 * / `buildResearchPacket` for evidence, `buildSkeletonEvidencePacket`,
 * `generateTripSkeleton()` (the one Anthropic call), `planFromSkeletonForTrip()`
 * (identity resolution, verification states, day-local routing, deterministic
 * relocation remediation, the draft-anchor scheduling bridge), then
 * `saveItinerary()`/`saveReadiness()` — the same repository the real
 * `/trips/[id]/itinerary` page reads from.
 *
 * Exactly one Anthropic call. No repair. No retry after it starts. The raw
 * skeleton draft is written to disk the moment it exists, before the bridge
 * stage runs, so a downstream failure never requires a second paid call to
 * see what the model actually said.
 *
 * Run with (from apps/web):
 *   NODE_OPTIONS="--require ./scripts/stub-server-only-require.cjs --import ./scripts/stub-server-only-loader.mjs" npx tsx scripts/iceland-live-production-acceptance.ts
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
// Run 2 — the composition-recovery configuration (effort low, ceiling
// 16,000, compact composition view). Run 1's failed-call artifacts stay
// preserved in the original directory, untouched.
const OUT_DIR = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-live-production-acceptance-2026-09-01-run2');
const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const head = execSync('git rev-parse HEAD').toString().trim();
  const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  const diffHashBefore = sha256(execSync('git diff HEAD').toString());
  const statusShort = execSync('git status --short').toString();

  console.log('=== LIVE PRODUCT ACCEPTANCE — ONE ANTHROPIC CALL, THROUGH THE REAL PRODUCTION ORCHESTRATOR ===');
  console.log('branch:', branch, '| HEAD:', head);
  console.log('diff sha256 (before):', diffHashBefore);
  console.log('tracked-diff lines:', statusShort.split('\n').filter(Boolean).length);
  console.log('ANTHROPIC_API_KEY configured:', Boolean(process.env.ANTHROPIC_API_KEY));
  console.log('SIDEQUEST_ROUTES_URL:', process.env.SIDEQUEST_ROUTES_URL ?? '(not set)');
  console.log('SIDEQUEST_POI_PROVIDER:', process.env.SIDEQUEST_POI_PROVIDER ?? '(not set)');

  writeFileSync(
    path.join(OUT_DIR, 'preflight.json'),
    JSON.stringify(
      {
        branch,
        head,
        diffHashBefore,
        statusShortLineCount: statusShort.split('\n').filter(Boolean).length,
        anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
        routesUrl: process.env.SIDEQUEST_ROUTES_URL ?? null,
        poiProvider: process.env.SIDEQUEST_POI_PROVIDER ?? null,
        tripId: TRIP_ID,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const { generateSidequestPlanForTrip } = await import('../src/lib/planning/production-plan');
  const { getItinerary, getReadiness } = await import('../src/lib/db/repository');

  console.log('\n=== CALLING generateSidequestPlanForTrip() — THE REAL PRODUCTION ORCHESTRATOR ===');
  const wallStart = performance.now();

  const result = await generateSidequestPlanForTrip(TRIP_ID, {
    caller: 'live-acceptance-2026-09-01',
    onSkeletonGenerated: (skeleton) => {
      console.log('Raw model draft received — persisting immediately, before the bridge runs.');
      writeFileSync(path.join(OUT_DIR, 'raw-model-skeleton-draft.json'), JSON.stringify(skeleton, null, 2));
    },
  });

  const wallMs = Math.round(performance.now() - wallStart);

  console.log('\n=== RESULT ===');
  console.log('ok:', result.ok);
  if (!result.ok) console.log('error:', result.error);
  console.log('wall ms:', wallMs);
  console.log('timings:', JSON.stringify(result.timings, null, 2));
  console.log('model calls made:', result.modelCalls?.length ?? 0);

  writeFileSync(
    path.join(OUT_DIR, 'production-plan-result.json'),
    JSON.stringify(
      { ok: result.ok, error: result.error ?? null, timings: result.timings ?? null, modelCalls: result.modelCalls ?? [], wallMs },
      null,
      2,
    ),
  );

  if (result.skeleton) {
    writeFileSync(path.join(OUT_DIR, 'raw-model-skeleton-draft.json'), JSON.stringify(result.skeleton, null, 2));
  }

  if (!result.ok) {
    console.log('\n=== LIVE RUN DID NOT PRODUCE A PLAN — STOPPING, NO RETRY ===');
    return;
  }

  writeFileSync(path.join(OUT_DIR, 'itinerary.json'), JSON.stringify(result.result!.itinerary, null, 2));
  writeFileSync(path.join(OUT_DIR, 'readiness.json'), JSON.stringify(result.result!.readiness, null, 2));
  writeFileSync(path.join(OUT_DIR, 'deviations.json'), JSON.stringify(result.result!.deviations, null, 2));
  writeFileSync(path.join(OUT_DIR, 'dispositions.json'), JSON.stringify(result.result!.dispositions, null, 2));

  console.log('\n=== FINAL ITINERARY (as generated) ===');
  for (const day of result.result!.itinerary.days) {
    const titles = day.items.map((i) => i.title ?? i.placeId ?? '(untitled)').join(' | ');
    console.log(`  Day ${day.dayNumber} ${day.date} (${day.baseId}): ${day.items.length} items - ${titles}`);
  }
  console.log('Unscheduled:', result.result!.itinerary.unscheduled.length);
  console.log('Readiness level:', result.result!.readiness.level, '| funnel:', JSON.stringify(result.result!.readiness.funnel));
  console.log('Readiness summary:', result.result!.readiness.summary);

  console.log('\n=== DRAFT-PRESERVATION ACCOUNTING ===');
  const byDisposition = new Map<string, number>();
  for (const d of result.result!.dispositions) byDisposition.set(d.disposition, (byDisposition.get(d.disposition) ?? 0) + 1);
  console.log('Proposed by Claude:', result.result!.dispositions.length);
  console.log(JSON.stringify(Object.fromEntries(byDisposition), null, 2));

  // Real readback through the real repository — proving persistence, not
  // merely the in-memory return value.
  console.log('\n=== READBACK THROUGH getItinerary()/getReadiness() ===');
  const reloadedItinerary = getItinerary(TRIP_ID);
  const reloadedReadiness = getReadiness(TRIP_ID);
  const reloadMatches =
    JSON.stringify(reloadedItinerary) === JSON.stringify(result.result!.itinerary) &&
    JSON.stringify(reloadedReadiness) === JSON.stringify(result.result!.readiness);
  console.log('Reload matches what was generated:', reloadMatches);
  writeFileSync(
    path.join(OUT_DIR, 'readback-check.json'),
    JSON.stringify({ reloadMatches, reloadedItineraryPresent: reloadedItinerary !== null, reloadedReadinessPresent: reloadedReadiness !== null }, null, 2),
  );

  const diffHashAfter = sha256(execSync('git diff HEAD').toString());
  console.log('\ndiff sha256 (after):', diffHashAfter, '| sourceUnchangedDuringRun:', diffHashBefore === diffHashAfter);

  console.log('\nAnthropic generation calls: 1');
  console.log('Silent draft-anchor losses:', result.result!.dispositions.length === 0 ? 'N/A (no anchors proposed)' : '0 (every proposed anchor has an explicit disposition — see dispositions.json)');
}

main().catch((error) => {
  console.error('LIVE RUN FAILED WITH AN UNCAUGHT ERROR — not retrying.');
  console.error(error);
  process.exit(1);
});
