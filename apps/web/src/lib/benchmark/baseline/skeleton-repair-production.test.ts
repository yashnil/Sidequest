import { describe, expect, it } from 'vitest';
import type { StructuredModel } from '../../providers/interpretation-model';
import {
  buildProductionRepairTask,
  isRepairEligible,
  repairTripSkeleton,
  type RelocationEvidenceLike,
  type SkeletonRepairContext,
  type SkeletonRepairIssueLike,
} from './skeleton-repair';
import { skeletonRepairPatchSchema, type SkeletonRepairPatch } from './skeleton-repair-patch';
import type { TripSkeleton } from './skeleton';
import type { SkeletonEvidencePacket } from './skeleton-packet';

/** A patch that changes nothing — reconstructs the original skeleton byte-for-byte. Used where a test only needs the send path to succeed, not to prove any particular repair. */
function noOpPatch(): SkeletonRepairPatch {
  return {
    summary: 'No change required for this fixture.',
    insertBases: [],
    removeBaseIds: [],
    reorderBaseIds: null,
    nightsChanges: [],
    dayReassignments: [],
    anchorMoves: [],
    anchorDrops: [],
    addedMajorOmissions: [],
  };
}

/**
 * THE PRODUCTION REPAIR CONTRACT — CONSTRUCTED ENTIRELY FROM PERSISTED
 * SKELETON-ERA ARTIFACTS, NEVER A RESEARCHPACKET.
 *
 * Every fixture here is deliberately generic — two fictional bases, "Anchor
 * Town" and "Far Town" — not Iceland, not any real destination. The shape
 * this contract needs to prove ("a matrix says a leg is infeasible, a model
 * repairs the route shape") reproduces with any two places.
 */

const TRAVELLER = {
  nights: 3,
  arrival: 'exact 11:00',
  departure: 'exact 17:00',
  pace: 'balanced',
  activityIntensity: 'moderate',
  transportPreference: 'drive',
  carAvailable: true,
  maxDailyDriveMinutes: 240,
  maxDailyTravelMinutes: 300,
  desiredBaseCount: 2,
  maxBaseChanges: 1,
  strongInterests: [],
  hardAvoidances: [],
  mustDo: [],
  budget: 'midrange',
};

function packet(): SkeletonEvidencePacket {
  return {
    destination: { name: 'Fictional Region', countryCode: 'XX', scale: 'region' },
    tripLength: { days: 4, startDate: '2026-08-12', endDate: '2026-08-15' },
    traveller: TRAVELLER,
    places: [],
    totalPlacesInPacket: 0,
    clusters: [],
    baseCandidates: [],
    routeLegs: [],
  };
}

function skeleton(): TripSkeleton {
  return {
    archetype: 'moving_route',
    purpose: 'A round trip through three fictional bases, used only to prove the production repair contract.',
    bases: [
      { id: 'anchor', placeIndex: null, name: 'Anchor Town', nights: 2, why: 'The trip starts and ends here.' },
      { id: 'mid', placeIndex: null, name: 'Mid Town', nights: 1, why: 'A real intermediate stop.' },
      { id: 'far', placeIndex: null, name: 'Far Town', nights: 1, why: 'The far side of the region.' },
    ],
    days: [
      { dayNumber: 1, baseId: 'anchor', theme: 'Arrival', intensity: 'light', anchors: [] },
      { dayNumber: 2, baseId: 'mid', theme: 'Midway', intensity: 'moderate', anchors: [] },
      { dayNumber: 3, baseId: 'far', theme: 'Far side', intensity: 'moderate', anchors: [] },
      { dayNumber: 4, baseId: 'anchor', theme: 'Departure', intensity: 'light', anchors: [] },
    ],
    majorOmissions: [],
    unresolved: [],
  };
}

function relocationInfeasibleIssue(fromId: string, toId: string, measuredMinutes: number, overrides: Partial<SkeletonRepairIssueLike> = {}): SkeletonRepairIssueLike {
  const evidence: RelocationEvidenceLike = {
    fromBaseId: fromId,
    toBaseId: toId,
    measuredMinutes,
    hardCeilingMinutes: 240,
    matrixMode: 'car',
    finalEvidenceClassification: 'direct_route_confirmed',
    confirmationAttempted: true,
    confirmationProvider: 'fixture-router',
    confirmationMinutes: measuredMinutes,
  };
  return {
    kind: 'relocation_infeasible',
    detail: `${fromId} → ${toId} measures ${measuredMinutes} minute(s), past the traveller's stated 240-minute daily driving limit, and no verified intermediate base resolves it.`,
    affectedDayNumbers: [],
    affectedBaseIds: [fromId, toId],
    relocationEvidence: evidence,
    verifiedAlternatives: [],
    ...overrides,
  };
}

function fakeModel(response: unknown): { model: StructuredModel; calls: unknown[] } {
  const calls: unknown[] = [];
  const model: StructuredModel = {
    callsRemaining: 1,
    async structured<T>(input: unknown) {
      calls.push(input);
      return response as T;
    },
  };
  return { model, calls };
}

describe('the production repair contract is built entirely from persisted skeleton-era artifacts', () => {
  it('constructs a real repair task from nothing but a TripSkeleton, a SkeletonEvidencePacket and SkeletonRepairIssues — no ResearchPacket, no async provider call', () => {
    const context: SkeletonRepairContext = {
      skeleton: skeleton(),
      packet: packet(),
      issues: [relocationInfeasibleIssue('mid', 'far', 336)],
    };
    // Synchronous — proves no fresh discovery/provider call is required to
    // build the request at all, distinct from sending it.
    const built = buildProductionRepairTask(context);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.task).toContain('relocation_infeasible');
    expect(built.task).toContain('mid → far');
    expect(built.task).toContain('336 min');
    expect(built.task).toContain('direct_route_confirmed');
  });

  it('represents relocation_infeasible accurately, including the measured evidence and its provenance', () => {
    const context: SkeletonRepairContext = {
      skeleton: skeleton(),
      packet: packet(),
      issues: [relocationInfeasibleIssue('mid', 'far', 336)],
    };
    const built = buildProductionRepairTask(context);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.task).toMatch(/measured 336 min \(ceiling 240 min, car\)/);
    expect(built.task).toMatch(/confirmed directly via fixture-router \(336 min\)/);
  });

  it('rejects routing_evidence_unavailable as non-repair-eligible — a provider gap is never sent to the model', () => {
    const unavailable = relocationInfeasibleIssue('mid', 'far', 336, {
      kind: 'routing_evidence_unavailable',
      relocationEvidence: {
        fromBaseId: 'mid',
        toBaseId: 'far',
        measuredMinutes: null,
        hardCeilingMinutes: 240,
        matrixMode: 'car',
        finalEvidenceClassification: 'evidence_unavailable',
        confirmationAttempted: true,
      },
    });
    expect(isRepairEligible(unavailable)).toBe(false);

    const context: SkeletonRepairContext = { skeleton: skeleton(), packet: packet(), issues: [unavailable] };
    const built = buildProductionRepairTask(context);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.detail).toMatch(/not repair-eligible/);
  });

  it('a mix of one eligible and one ineligible issue sends only the eligible one', async () => {
    const eligible = relocationInfeasibleIssue('anchor', 'mid', 260);
    const ineligible = relocationInfeasibleIssue('mid', 'far', 260, { kind: 'routing_evidence_unavailable' });
    const { model, calls } = fakeModel(noOpPatch());
    const result = await repairTripSkeleton({ skeleton: skeleton(), packet: packet(), issues: [eligible, ineligible] }, model);
    expect(result.ok).toBe(true);
    const sent = calls[0] as { task: string };
    expect(sent.task).toContain('anchor → mid');
    expect(sent.task).not.toContain('routing_evidence_unavailable');
  });

  it('supplies multiple consequential relocation failures in one repair context — never fixes one leg only to discover the next later', () => {
    const context: SkeletonRepairContext = {
      skeleton: skeleton(),
      packet: packet(),
      issues: [relocationInfeasibleIssue('mid', 'far', 336), relocationInfeasibleIssue('far', 'anchor', 298)],
    };
    const built = buildProductionRepairTask(context);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.eligibleIssues.length).toBe(2);
    expect(built.task).toContain('mid → far');
    expect(built.task).toContain('far → anchor');
    expect(built.task).toContain('336 min');
    expect(built.task).toContain('298 min');
  });

  it('locked decisions survive: a base/day untouched by any issue is named LOCKED, an affected one is not', () => {
    const context: SkeletonRepairContext = {
      skeleton: skeleton(),
      packet: packet(),
      issues: [relocationInfeasibleIssue('mid', 'far', 336)],
    };
    const built = buildProductionRepairTask(context);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.task).toMatch(/LOCKED — DO NOT CHANGE:.*base id\(s\) anchor/);
    // "mid" and "far" are affected by the issue and must not appear in the locked base list.
    const lockedLine = built.task.split('\n').find((line) => line.startsWith('LOCKED'))!;
    expect(lockedLine).not.toContain('mid');
    expect(lockedLine).not.toContain('far');
  });

  it('is bounded — never sends more issues than the existing MAX_SKELETON_REPAIR_ISSUES cap, no iterative loop', async () => {
    const many = Array.from({ length: 12 }, (_, i) => relocationInfeasibleIssue(`base-${i}`, `base-${i + 1}`, 300));
    const context: SkeletonRepairContext = { skeleton: skeleton(), packet: packet(), issues: many };
    const built = buildProductionRepairTask(context);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.eligibleIssues.length).toBeLessThanOrEqual(8);
  });

  it('sends the compact patch schema, not the whole TripSkeleton schema — the model answers with a patch, Sidequest reconstructs and validates the skeleton itself', async () => {
    const { model, calls } = fakeModel(noOpPatch());
    const context: SkeletonRepairContext = { skeleton: skeleton(), packet: packet(), issues: [relocationInfeasibleIssue('mid', 'far', 336)] };
    const result = await repairTripSkeleton(context, model);
    expect(result.ok).toBe(true);
    const sent = calls[0] as { schema: unknown; attempt: number };
    expect(sent.schema).toBe(skeletonRepairPatchSchema);
    expect(sent.attempt).toBe(2);
  });

  it('a malformed patch response never becomes an unrecoverable diagnostic gap — the exact schema issues survive on the outcome itself', async () => {
    const model: StructuredModel = {
      callsRemaining: 1,
      async structured() {
        const error = new Error('The model answered in a shape the schema refused (end_turn).') as Error & {
          code: string;
          schemaValidationIssues: readonly { path: string; code: string; message: string }[];
        };
        error.code = 'malformed_output';
        error.schemaValidationIssues = [
          { path: 'insertBases.0.nights', code: 'too_big', message: 'Number must be less than or equal to 60.' },
        ];
        throw error;
      },
    };
    const context: SkeletonRepairContext = { skeleton: skeleton(), packet: packet(), issues: [relocationInfeasibleIssue('mid', 'far', 336)] };
    const result = await repairTripSkeleton(context, model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureKind).toBe('malformed_output');
    expect(result.schemaValidationIssues).toEqual([
      { path: 'insertBases.0.nights', code: 'too_big', message: 'Number must be less than or equal to 60.' },
    ]);
  });

  it('a patch the applier rejects (an impossible or contradictory operation) is reported as patch_rejected, distinct from a schema failure', async () => {
    const badPatch: SkeletonRepairPatch = {
      ...noOpPatch(),
      removeBaseIds: ['far'], // day 3 still names "far" and is never reassigned — contradictory.
      // Nights compensated (far's 1 folded into anchor) so this fails on the dangling day
      // reference alone, not on the nights-sum check.
      nightsChanges: [{ baseId: 'anchor', nights: 3 }],
    };
    const { model } = fakeModel(badPatch);
    const context: SkeletonRepairContext = { skeleton: skeleton(), packet: packet(), issues: [relocationInfeasibleIssue('mid', 'far', 336)] };
    const result = await repairTripSkeleton(context, model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failureKind).toBe('patch_rejected');
    expect(result.detail).toMatch(/Day 3.*"far"/);
  });

  it('offers verified alternatives when present, and says plainly when none exist rather than staying silent', () => {
    const withAlternative = relocationInfeasibleIssue('mid', 'far', 336, {
      verifiedAlternatives: [{ placeId: 'real-place-1', name: 'Real Waypoint', reason: 'A real, currently-reachable base candidate.' }],
    });
    const built = buildProductionRepairTask({ skeleton: skeleton(), packet: packet(), issues: [withAlternative] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.task).toContain('Real Waypoint');

    const withoutAlternative = relocationInfeasibleIssue('mid', 'far', 336);
    const builtEmpty = buildProductionRepairTask({ skeleton: skeleton(), packet: packet(), issues: [withoutAlternative] });
    expect(builtEmpty.ok).toBe(true);
    if (!builtEmpty.ok) return;
    expect(builtEmpty.task).toMatch(/No verified alternative was found/);
  });

  it('refuses to spend a call the run does not have', async () => {
    const { model } = fakeModel(skeleton());
    (model as { callsRemaining: number }).callsRemaining = 0;
    const context: SkeletonRepairContext = { skeleton: skeleton(), packet: packet(), issues: [relocationInfeasibleIssue('mid', 'far', 336)] };
    const result = await repairTripSkeleton(context, model);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failureKind).toBe('budget_exhausted');
  });
});
