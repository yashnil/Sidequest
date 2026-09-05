/*
 * STEP 2 OF THE BOUNDED WHOLE-ROUTE REPAIR ROUND — CONSTRUCT, BUT DO NOT
 * SEND, THE COMPACT PRODUCTION REPAIR REQUEST.
 *
 * Builds the exact `SkeletonRepairContext` a real repair call would use for
 * the frozen Iceland skeleton, from nothing but persisted artifacts already
 * on disk this session (the frozen skeleton, the frozen evidence packet,
 * and the real `SkeletonRepairIssue`/measured-evidence JSON two prior live
 * runs already wrote) — no live Nominatim, no live Valhalla, no fresh
 * discovery, no model call. Calls `buildProductionRepairTask()` (the real,
 * synchronous, offline-testable half of `repairTripSkeleton()`) and stops
 * there — it never calls `repairTripSkeleton()` itself, so no Anthropic
 * call happens.
 *
 * ANTHROPIC CALLS: 0.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-repair-request-construction.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ART_DIR = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-production-hydration-2026-08-29');
const SKELETON_PATH = path.join(
  REPO_ROOT,
  '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/trip-skeleton.json',
);
const PACKET_PATH = path.join(
  REPO_ROOT,
  '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/skeleton-evidence-packet.json',
);
const REQUEST_SNAPSHOT_PATH = path.join(
  REPO_ROOT,
  '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/skeleton-request-snapshot.json',
);

async function main() {
  const { buildProductionRepairTask } = await import('../src/lib/benchmark/baseline/skeleton-repair');

  const skeleton = JSON.parse(readFileSync(SKELETON_PATH, 'utf8'));
  const packet = JSON.parse(readFileSync(PACKET_PATH, 'utf8'));

  // --- Issue 1: Höfn -> Akureyri — the REAL SkeletonRepairIssue a real
  // --- production run actually returned (production-plan-result-confirmed-routing.json). ---
  const planResult = JSON.parse(readFileSync(path.join(ART_DIR, 'production-plan-result-confirmed-routing.json'), 'utf8'));
  const hofnToAkureyri = planResult.repairIssue;
  if (!hofnToAkureyri || hofnToAkureyri.kind !== 'relocation_infeasible') {
    throw new Error('Expected a real relocation_infeasible repair issue in production-plan-result-confirmed-routing.json.');
  }

  // --- Issue 2: Akureyri -> Reykjavík — the production loop never reached
  // --- this leg (it returns on the first infeasible leg with no remedy).
  // --- Constructed here from the REAL, persisted measurement
  // --- (complete-relocation-evidence.json, obtained via the same real
  // --- productionConfirmRoute() this whole round validated), following the
  // --- identical construction `assessRelocationFeasibility` itself uses —
  // --- not a second measurement, not an invented one. ---------------------
  const evidence = JSON.parse(readFileSync(path.join(ART_DIR, 'complete-relocation-evidence.json'), 'utf8'));
  const akureyriToReykjavik = evidence.find((e: { leg: string }) => e.leg === 'Akureyri → Reykjavík');
  if (!akureyriToReykjavik || akureyriToReykjavik.measuredMinutes === null) {
    console.log('No trustworthy persisted measurement exists for the fourth leg — it would need one deterministic route measurement before a complete repair context could be built. STOPPING rather than fabricating it.');
    return;
  }
  if (akureyriToReykjavik.pass !== false) {
    throw new Error('Expected the fourth leg to be over the hard ceiling in the persisted evidence — re-check before building a repair request around it.');
  }

  const baseReport = JSON.parse(readFileSync(path.join(ART_DIR, 'base-resolution-report-confirmed-routing.json'), 'utf8'));
  const akureyriName = baseReport.find((b: { skeletonBaseId: string }) => b.skeletonBaseId === 'akureyri')?.resolvedName ?? 'Akureyri';
  const reykjavik2Name = baseReport.find((b: { skeletonBaseId: string }) => b.skeletonBaseId === 'reykjavik-2')?.resolvedName ?? 'Reykjavik';
  const ceiling = akureyriToReykjavik.hardCeilingMinutes;

  const secondIssue = {
    kind: 'relocation_infeasible' as const,
    detail: `${akureyriName} → ${reykjavik2Name} measures ${akureyriToReykjavik.measuredMinutes} minute(s), past the traveller's stated ${ceiling}-minute daily driving limit, and no verified intermediate base resolves it.`,
    affectedDayNumbers: [] as number[],
    affectedBaseIds: ['akureyri', 'reykjavik-2'],
    relocationEvidence: {
      fromBaseId: 'akureyri',
      toBaseId: 'reykjavik-2',
      fromPlaceId: akureyriToReykjavik.fromId,
      toPlaceId: akureyriToReykjavik.toId,
      measuredMinutes: akureyriToReykjavik.measuredMinutes,
      hardCeilingMinutes: ceiling,
      matrixMode: 'car',
      matrixOutcome: 'authoritative_no_route',
      confirmationAttempted: true,
      confirmationProvider: 'valhalla',
      confirmationMinutes: akureyriToReykjavik.measuredMinutes,
      confirmationKm: akureyriToReykjavik.measuredKm,
      finalEvidenceClassification: 'direct_route_confirmed',
    },
    // Same deterministic remedy-search conclusion as the real Höfn -> Akureyri
    // issue: the compiled region has exactly one base-eligible candidate
    // (Reykjavík itself), so no intermediate base could ever be verified for
    // this leg either — an honest empty list, not a search failure.
    verifiedAlternatives: [] as { placeId: string; name: string; reason: string }[],
  };

  const context = {
    skeleton,
    packet,
    issues: [hofnToAkureyri, secondIssue],
  };

  const built = buildProductionRepairTask(context);
  if (!built.ok) {
    console.log('Repair task could not be built:', built.detail);
    return;
  }

  console.log('=== ISSUES INCLUDED ===');
  for (const issue of built.eligibleIssues) console.log(`- [${issue.kind}] ${issue.detail}`);

  console.log('\n=== FULL TASK TEXT (NOT SENT) ===\n');
  console.log(built.task);

  const taskBytes = Buffer.byteLength(built.task, 'utf8');
  let originalRequestBytes: number | null = null;
  try {
    const snapshot = JSON.parse(readFileSync(REQUEST_SNAPSHOT_PATH, 'utf8'));
    if (typeof snapshot.task === 'string') originalRequestBytes = Buffer.byteLength(snapshot.task, 'utf8');
  } catch {
    // Original request snapshot not available — size comparison skipped, not fabricated.
  }

  const sizeReport = {
    repairTaskBytes: taskBytes,
    repairTaskCharacters: built.task.length,
    originalGenerationRequestBytes: originalRequestBytes,
    ratio: originalRequestBytes ? Number((taskBytes / originalRequestBytes).toFixed(4)) : null,
  };
  console.log('\n=== SIZE COMPARISON ===');
  console.log(JSON.stringify(sizeReport, null, 2));

  writeFileSync(path.join(ART_DIR, 'repair-context-constructed-not-sent.json'), JSON.stringify(context, null, 2));
  writeFileSync(path.join(ART_DIR, 'repair-task-constructed-not-sent.txt'), built.task);
  writeFileSync(path.join(ART_DIR, 'repair-task-size-report.json'), JSON.stringify(sizeReport, null, 2));

  console.log('\nAnthropic calls: 0 (constructed only — never sent).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
