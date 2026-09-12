import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import type { TripDraft } from '../planning/trip-draft';
import type { RefinementInterpretation } from './graph';

/**
 * V9 §3/§4 — THE DELTA BEFORE APPLY, THE DECISION AFTER, AND UNDO EXACT.
 *
 * Driven through the real server actions with the one model seam faked: the
 * interpreter returns a fixed patch, the verification pipeline is stood in
 * for by the fixture reconciler, and everything else — ownership, the lease,
 * the versions, the decisions table, the evidence ledger — is real. Offline,
 * fixed readings, no clock dependence.
 */
const jar = new Map<string, string>();
const readings: RefinementInterpretation[] = [];

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));
vi.mock('@/lib/providers/switches', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isCompositionModelConfigured: () => true,
  isFixtureComposer: () => false,
}));
vi.mock('@/lib/providers/anthropic', () => ({ ResearchModel: class {} }));
vi.mock('@/lib/compiler/daily-ceiling', () => ({ reserveModelCalls: () => ({ allowed: true }) }));
vi.mock('@/lib/planning/composition-model', () => ({ composerModel: () => 'fixture' }));
vi.mock('@/lib/refine/interpreter', () => ({
  modelRefinementInterpreter: () => ({
    async interpret() {
      const reading = readings.shift();
      if (!reading) throw new Error('the fake interpreter ran out of readings');
      return reading;
    },
  }),
}));
/* The verification pipeline: the fixture reconciler over the patched draft, retargeted at the trip. */
vi.mock('@/lib/planning/production-plan', () => ({
  generateSidequestPlanForTrip: async (tripId: string, options: { useDraft: TripDraft }) => {
    const { boardWorld } = await import('@/lib/planning/acceptance/harness');
    const { reconcileTripDraft } = await import('@/lib/planning/reconcile');
    const result = await reconcileTripDraft({ draft: options.useDraft, context: boardWorld() });
    const itinerary = { ...result.itinerary, tripId };
    const { saveItinerary } = await import('@/lib/db/repository');
    saveItinerary(itinerary);
    return { ok: true, result: { itinerary } };
  },
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  readings.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-refine-delta-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const BASICS = {
  mode: 'known_destination' as const,
  destinationInput: 'Harbour City',
  regionId: 'open-world',
  startDate: '2026-06-01',
  endDate: '2026-06-05',
  arrivalTime: '10:00',
  departureTime: '18:00',
  arrivalPrecision: 'exact' as const,
  departurePrecision: 'exact' as const,
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

/** A two-base trip, built and stored, owned by `session:mine`. */
async function builtTrip(): Promise<{ tripId: string; draft: TripDraft; itinerary: Itinerary }> {
  const { createTrip, saveItinerary } = await import('@/lib/db/repository');
  const { saveTripDraft } = await import('@/lib/db/draft-repository');
  const { boardWorld, draftOf } = await import('@/lib/planning/acceptance/harness');
  const { reconcileTripDraft } = await import('@/lib/planning/reconcile');
  const trip = createTrip(BASICS, 'session:mine');
  const draft = draftOf({
    bases: [
      { id: 'city', name: 'Harbour City', nights: 2, style: 'small hotel in the market quarter' },
      { id: 'valley', name: 'Upper Valley', nights: 2, style: 'guesthouse by the river' },
    ],
    days: [
      { base: 'city', anchors: [{ name: 'Victoria Peak' }, { name: 'Temple Street Night Market', timeOfDay: 'night' }] },
      { base: 'city', anchors: [{ name: 'Sheung Wan Heritage Walk' }] },
      { base: 'valley', anchors: [{ name: 'Riverside Trail' }] },
      { base: 'valley', anchors: [{ name: 'Valley Viewpoint' }] },
      { base: 'city', anchors: [{ name: 'Harbour Promenade' }] },
    ],
    signatures: ['Victoria Peak'],
    driving: 'private_driver',
  });
  saveTripDraft({ tripId: trip.id, draft });
  const built = await reconcileTripDraft({ draft, context: boardWorld() });
  saveItinerary({ ...built.itinerary, tripId: trip.id });
  jar.set('sidequest_session', 'session:mine');
  /* The baseline is the plan as stored — the round trip through the repository is what Undo restores. */
  const { getItinerary } = await import('@/lib/db/repository');
  return { tripId: trip.id, draft, itinerary: getItinerary(trip.id)! };
}

/** "Stay in the city the whole time": the valley nights move to the city — one base fewer, no hotel change. */
const consolidate = (): RefinementInterpretation => ({
  intent: 'change_base',
  namedBases: ['valley', 'city'],
  patch: {
    version: 'sidequest-trip-patch/1',
    changed: ['One base for the whole trip.'],
    kept: ['Victoria Peak'],
    operations: [
      { op: 'update_base', id: 'valley', nights: 0, why: 'Consolidated as asked.' },
      { op: 'update_base', id: 'city', nights: 4, why: 'Consolidated as asked.' },
    ],
  },
});

describe('V9 §4 — a proposal carries the deterministic delta', () => {
  it('shows bases and hotel changes going down before anything is applied', async () => {
    const { tripId } = await builtTrip();
    const { refineTripAction } = await import('./actions');
    readings.push(consolidate());
    const result = await refineTripAction({ tripId, request: 'Stay in the city the whole time.' });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('proposal');
    const delta = result.proposal?.delta;
    expect(delta).toBeDefined();
    const byLabel = Object.fromEntries(delta!.lines.map((line) => [line.label, line]));
    expect(byLabel['Bases']).toMatchObject({ before: '2', after: '1', change: -1 });
    expect(byLabel['Hotel changes']).toMatchObject({ before: '2', after: '0', tone: 'better' });
    expect(byLabel['Signature stops kept']).toMatchObject({ tone: 'better' });
    expect(byLabel['Signature stops kept']!.after).toMatch(/^(\d+)\/\1$/);
    expect(delta!.headline).toMatch(/Bases 2 → 1/);
    /* Nothing landed: the stored plan is the built one. */
    const { getItinerary } = await import('@/lib/db/repository');
    expect(getItinerary(tripId)?.package?.bases.filter((b) => b.nights > 0)).toHaveLength(2);
  });
});

describe('V9 §3 — Apply records the decision; Undo restores the exact previous plan', () => {
  it('writes a refinement decision row at user_explicit and reports the applied delta shape', async () => {
    const { tripId } = await builtTrip();
    const { refineTripAction, answerRefinementAction } = await import('./actions');
    const { listDecisions } = await import('@/lib/db/execution-repository');
    readings.push(consolidate());
    const proposal = await refineTripAction({ tripId, request: 'Stay in the city the whole time.' });
    expect(proposal.mode).toBe('proposal');
    const applied = await answerRefinementAction({ tripId, runId: proposal.runId!, answer: 'Apply' });
    expect(applied.ok).toBe(true);
    expect(applied.mode).toBe('applied');
    expect(applied.version).toBe(2);
    const rows = listDecisions(tripId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'refinement:2', chosen: 'Stay in the city the whole time.', lock: 'user_explicit', decidedBy: 'traveller' });
    expect(rows[0]!.scope?.baseIds).toEqual(expect.arrayContaining(['valley']));
    /* The measured delta, when both versions carry metrics, is a list of lines; never invented when they do not. */
    expect(applied.delta === undefined || Array.isArray(applied.delta)).toBe(true);
  });

  it('Undo restores the previous itinerary JSON exactly', async () => {
    const { tripId, itinerary } = await builtTrip();
    const { refineTripAction, answerRefinementAction, undoRefinementAction } = await import('./actions');
    const { getItinerary } = await import('@/lib/db/repository');
    readings.push(consolidate());
    const proposal = await refineTripAction({ tripId, request: 'Stay in the city the whole time.' });
    await answerRefinementAction({ tripId, runId: proposal.runId!, answer: 'Apply' });
    expect(getItinerary(tripId)?.package?.bases.filter((b) => b.nights > 0)).toHaveLength(1);
    const undone = await undoRefinementAction({ tripId });
    expect(undone.ok).toBe(true);
    expect(JSON.stringify(getItinerary(tripId))).toBe(JSON.stringify(itinerary));
  });
});

describe('V9 §18 — cancelling a proposal that moves a base leaves a leaning, never a rule', () => {
  it('records one trip-scoped behaviour row against hotel changes, and changes nothing else', async () => {
    const { tripId, itinerary } = await builtTrip();
    const { refineTripAction, answerRefinementAction } = await import('./actions');
    const { listTripEvidence } = await import('@/lib/db/preference-evidence-repository');
    const { listDecisions } = await import('@/lib/db/execution-repository');
    const { getItinerary } = await import('@/lib/db/repository');
    readings.push(consolidate());
    const proposal = await refineTripAction({ tripId, request: 'Stay in the city the whole time.' });
    const cancelled = await answerRefinementAction({ tripId, runId: proposal.runId!, answer: 'Cancel' });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.mode).toBe('answer');
    const rows = listTripEvidence(tripId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: 'hotel_changes', polarity: -1, source: 'behaviour', scope: 'trip', tripId });
    expect(listDecisions(tripId)).toEqual([]);
    expect(JSON.stringify(getItinerary(tripId))).toBe(JSON.stringify(itinerary));
  });
});
