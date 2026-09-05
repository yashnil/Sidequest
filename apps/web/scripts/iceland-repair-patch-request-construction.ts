/*
 * THE PATCH-BASED REPAIR REQUEST — CONSTRUCTED, NOT SENT.
 *
 * Same real, persisted Iceland artifacts as the earlier
 * `iceland-repair-request-construction.ts` (the frozen skeleton, the frozen
 * evidence packet, the real Höfn -> Akureyri `SkeletonRepairIssue`, and the
 * real measured Akureyri -> Reykjavík evidence), rebuilt against the new
 * `SkeletonRepairPatch` contract instead of the old full-skeleton one. Calls
 * `buildProductionRepairTask()` and stops there, exactly as the earlier
 * script did — that function is pure and synchronous, and never sends
 * anything. No Anthropic call, no Valhalla, no Nominatim, no discovery.
 *
 * ANTHROPIC CALLS: 0.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-repair-patch-request-construction.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

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

async function main() {
  const { buildProductionRepairTask } = await import('../src/lib/benchmark/baseline/skeleton-repair');
  const { skeletonRepairPatchSchema, SKELETON_REPAIR_PATCH_MAX_TOKENS, SKELETON_REPAIR_PATCH_INSTRUCTION } = await import(
    '../src/lib/benchmark/baseline/skeleton-repair-patch'
  );
  const { tripSkeletonSchema, SKELETON_MAX_TOKENS } = await import('../src/lib/benchmark/baseline/skeleton');

  const skeleton = JSON.parse(readFileSync(SKELETON_PATH, 'utf8'));
  const packet = JSON.parse(readFileSync(PACKET_PATH, 'utf8'));

  // --- Issue 1: Höfn -> Akureyri — the REAL SkeletonRepairIssue a real production run actually returned. ---
  const planResult = JSON.parse(readFileSync(path.join(ART_DIR, 'production-plan-result-confirmed-routing.json'), 'utf8'));
  const hofnToAkureyri = planResult.repairIssue;
  if (!hofnToAkureyri || hofnToAkureyri.kind !== 'relocation_infeasible') {
    throw new Error('Expected a real relocation_infeasible repair issue in production-plan-result-confirmed-routing.json.');
  }

  // --- Issue 2: Akureyri -> Reykjavík — constructed from the real, persisted measurement, identically to the earlier script. ---
  const evidence = JSON.parse(readFileSync(path.join(ART_DIR, 'complete-relocation-evidence.json'), 'utf8'));
  const akureyriToReykjavik = evidence.find((e: { leg: string }) => e.leg === 'Akureyri → Reykjavík');
  if (!akureyriToReykjavik || akureyriToReykjavik.measuredMinutes === null) {
    console.log('No trustworthy persisted measurement exists for the fourth leg — stopping rather than fabricating it.');
    return;
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
    verifiedAlternatives: [] as { placeId: string; name: string; reason: string }[],
  };

  const context = { skeleton, packet, issues: [hofnToAkureyri, secondIssue] };

  const built = buildProductionRepairTask(context);
  if (!built.ok) {
    console.log('Repair task could not be built:', built.detail);
    return;
  }

  console.log('=== ISSUES INCLUDED ===');
  for (const issue of built.eligibleIssues) console.log(`- [${issue.kind}] ${issue.detail}`);

  console.log('\n=== FULL TASK TEXT (patch-oriented trailer; not sent) ===\n');
  console.log(built.task);

  const taskBytes = Buffer.byteLength(built.task, 'utf8');
  const patchSchemaBytes = JSON.stringify(zodOutputFormat(skeletonRepairPatchSchema)).length;
  const fullSkeletonSchemaBytes = JSON.stringify(zodOutputFormat(tripSkeletonSchema)).length;

  const lockedLine = built.task.split('\n').find((line: string) => line.startsWith('LOCKED'));

  const report = {
    requestBytes: {
      taskTextBytes: taskBytes,
      instructionBytes: Buffer.byteLength(SKELETON_REPAIR_PATCH_INSTRUCTION, 'utf8'),
      totalApproxRequestBytes: taskBytes + Buffer.byteLength(SKELETON_REPAIR_PATCH_INSTRUCTION, 'utf8'),
    },
    schemaBytes: {
      patchSchema: patchSchemaBytes,
      fullSkeletonSchemaForComparison: fullSkeletonSchemaBytes,
    },
    tokenCeilings: {
      patch: SKELETON_REPAIR_PATCH_MAX_TOKENS,
      fullSkeletonGeneration: SKELETON_MAX_TOKENS,
      ratio: Number((SKELETON_REPAIR_PATCH_MAX_TOKENS / SKELETON_MAX_TOKENS).toFixed(3)),
    },
    lockedDecisionsLine: lockedLine ?? null,
    allowedMutations: Object.keys(skeletonRepairPatchSchema.shape),
    droppedFromTheOldFullSkeletonRequest: [
      'The instruction to "return the whole skeleton in the same shape, corrected" — a patch has no whole-skeleton field to return.',
      'Every unaffected base object (reykjavik-1, vik) restated verbatim by the model — now never resent; the applier copies them from the original untouched.',
      'Every unaffected day object (11 of 13 days) restated verbatim — now never resent; only the specific days that change base need a dayReassignments entry.',
      'archetype/purpose/unresolved — previously implicitly at risk of drifting on regeneration even though untouched; now structurally impossible for the model to touch, since the patch schema has no field for any of them.',
      'The total 12-night sum — previously the model had to reproduce it correctly by re-summing 5 bases; now Sidequest verifies it deterministically after the patch is applied, and rejects a mismatch before hydration ever runs.',
    ],
  };

  console.log('\n=== SIZE / CONTRACT REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  writeFileSync(path.join(ART_DIR, 'repair-patch-context-constructed-not-sent.json'), JSON.stringify(context, null, 2));
  writeFileSync(path.join(ART_DIR, 'repair-patch-task-constructed-not-sent.txt'), built.task);
  writeFileSync(path.join(ART_DIR, 'repair-patch-request-report.json'), JSON.stringify(report, null, 2));

  console.log('\nAnthropic calls: 0 (constructed only — never sent).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
