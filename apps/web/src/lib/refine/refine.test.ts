import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { createTrip } from '../db/repository';
import { getDb } from '../db/client';
import { boardWorld, draftOf } from '../planning/acceptance/harness';
import { reconcileTripDraft } from '../planning/reconcile';
import type { Itinerary } from '@sidequest/core';
import type { TripDraft } from '../planning/trip-draft';
import { applyTripPatch, tripPatchSchema, anchorIndex, type TripPatch } from './patch';
import { blastRadiusFor, lockConflicts, preservationContractFor } from './blast-radius';
import { describeContract, describeKept, describeRechecking, describeRefusal } from './describe';
import { patchInvariantViolations } from './invariants';
import { buildRefinementGraph, resumeWith, type RefinementInterpretation, type RefinementInterpreter } from './graph';
import { SqliteRefinementCheckpointer } from './checkpointer';
import { RefinementBusyError, activeRun, beginRun, listRuns, releaseStaleRuns, updateRun } from './run-repository';
import { StaleTripVersionError, currentVersion, ensureBaselineVersion, listVersions, recordVersion, undoTarget } from './version-repository';
import { alternativeThreadId, refinementRunThreadId, refinementThreadId, tripIdOfThread } from './threads';
import { MAX_REFINEMENT_MODEL_CALLS, type RefinementLock } from './state';
import { REFINEMENT_MAX_TOKENS, REFINEMENT_TIMEOUT_MS } from './interpreter';

/**
 * THE CONVERSATIONAL REFINEMENT PROPERTIES, TESTED.
 *
 * PRODUCTION LOCK V5 §52. Each test here is one of the properties the spec asks
 * for as a property rather than as a screenshot: what changed, what stayed, what
 * a lock means, what a second press does, what undo restores, and what happens
 * when the model fails.
 *
 * All offline. The one seam that reaches a model is `RefinementInterpreter`, and
 * every test here fills it with a fake that returns a fixed reading — so these
 * assert Sidequest's behaviour, not the model's.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-refine-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'refine.db');
  const globalForDb = globalThis as unknown as { sidequestDb?: { close(): void } };
  globalForDb.sidequestDb?.close();
  delete globalForDb.sidequestDb;
});

afterEach(() => {
  const globalForDb = globalThis as unknown as { sidequestDb?: { close(): void } };
  globalForDb.sidequestDb?.close();
  delete globalForDb.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function newTrip() {
  return createTrip({ mode: 'known_destination', destinationInput: 'Harbour City', regionId: 'dynamic', startDate: '2026-06-01', endDate: '2026-06-05', arrivalTime: '10:00', departureTime: '18:00', arrivalPrecision: 'exact', departurePrecision: 'exact', adults: 2, children: 0, travelerNeeds: [] });
}

/** A five-day trip with a two-day trek in the middle: the shape most of the interesting rules are about. */
function trekDraft(): TripDraft {
  return draftOf({
    bases: [
      { id: 'city', name: 'Harbour City', nights: 2, style: 'small hotel in the market quarter' },
      { id: 'mountain', name: 'Upper Valley', nights: 2, style: 'mountain hut on the ridge', overnight: 'hut' },
    ],
    days: [
      { base: 'city', anchors: [{ name: 'Victoria Peak' }, { name: 'Temple Street Night Market', timeOfDay: 'night' }] },
      { base: 'city', anchors: [{ name: 'Sheung Wan Heritage Walk' }] },
      { base: 'mountain', anchors: [{ name: 'Ala-Kul Ascent' }], partOf: 'The Ala-Kul Traverse', intensity: 'intense' },
      { base: 'mountain', anchors: [{ name: 'Ala-Kul Pass Descent' }], partOf: 'The Ala-Kul Traverse', intensity: 'intense' },
      { base: 'city', anchors: [{ name: 'Harbour Promenade' }] },
    ],
    signatures: ['The Ala-Kul Traverse'],
    driving: 'private_driver',
  });
}

function idOf(draft: TripDraft, name: string): string {
  for (const [id, address] of anchorIndex(draft)) {
    if (draft.days.find((day) => day.dayNumber === address.dayNumber)?.anchors[address.index]?.name === name) return id;
  }
  throw new Error(`no anchor named ${name}`);
}

/* ------------------------------------------------------------------ *
 * §40 — the patch
 * ------------------------------------------------------------------ */

describe('§40 — a patch changes only what it names', () => {
  it('leaves every untouched day byte-for-byte identical', () => {
    const draft = trekDraft();
    const patch: TripPatch = tripPatchSchema.parse({
      changed: ['Day 2 now walks a different district.'],
      kept: ['Victoria Peak', 'the trek'],
      operations: [{ op: 'replace_activity', id: idOf(draft, 'Sheung Wan Heritage Walk'), activity: { name: 'Wan Chai Market Walk', kind: 'neighbourhood', why: 'Denser food, fewer tour groups.' } }],
    });
    const result = applyTripPatch({ draft, patch });
    expect(result.ok).toBe(true);
    /* Every day but the second is the same object graph it was. */
    for (const dayNumber of [1, 3, 4, 5]) {
      expect(result.draft.days.find((d) => d.dayNumber === dayNumber)).toEqual(draft.days.find((d) => d.dayNumber === dayNumber));
    }
    expect(result.draft.bases).toEqual(draft.bases);
    expect(result.draft.package).toEqual(draft.package);
    expect(result.draft.days[1]!.anchors[0]!.name).toBe('Wan Chai Market Walk');
  });

  it('refuses a locked activity and says so instead of quietly skipping it', () => {
    const draft = trekDraft();
    const peak = idOf(draft, 'Victoria Peak');
    const patch = tripPatchSchema.parse({ changed: [], kept: [], operations: [{ op: 'remove_activity', id: peak, reason: 'Too touristy.' }] });
    const result = applyTripPatch({ draft, patch, locked: [`activity:${peak}`] });
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.refused[0]).toMatchObject({ op: 'remove_activity', reason: 'the traveller locked this experience' });
    expect(result.draft.days[0]!.anchors.map((a) => a.name)).toContain('Victoria Peak');
  });

  it('resolves ids against the original draft, so operation order does not matter', () => {
    const draft = trekDraft();
    const market = idOf(draft, 'Temple Street Night Market');
    const peak = idOf(draft, 'Victoria Peak');
    /* Removing the FIRST anchor shifts the second one's index. Both must still resolve. */
    const patch = tripPatchSchema.parse({
      changed: [],
      kept: [],
      operations: [
        { op: 'remove_activity', id: peak, reason: 'Traveller asked for less touristy.' },
        { op: 'replace_activity', id: market, activity: { name: 'Yau Ma Tei Night Market', kind: 'market', when: 'night', why: 'Same hour, better food.' } },
      ],
    });
    const result = applyTripPatch({ draft, patch });
    expect(result.refused).toEqual([]);
    expect(result.draft.days[0]!.anchors.map((a) => a.name)).toEqual(['Yau Ma Tei Night Market']);
  });

  it('refuses an id that is not in this draft rather than applying something adjacent', () => {
    const result = applyTripPatch({ draft: trekDraft(), patch: tripPatchSchema.parse({ changed: [], kept: [], operations: [{ op: 'remove_activity', id: 'd9-a0-nothing', reason: 'x' }] }) });
    expect(result.refused[0]!.reason).toBe('no such activity in this draft');
  });
});

/* ------------------------------------------------------------------ *
 * §38/§39 — blast radius and the preservation contract
 * ------------------------------------------------------------------ */

describe('§38 — the blast radius', () => {
  it('"make Day 2 easier" reaches day 2 and nothing else', () => {
    const radius = blastRadiusFor({ draft: trekDraft(), intent: 'change_day', namedDays: [2] });
    expect(radius.days).toEqual([2]);
    expect(radius.bases).toEqual([]);
    expect(radius.wholeTrip).toBe(false);
    expect(radius.reason).toMatch(/Not the stay, not the other days, not the booked facts/);
  });

  it('pulls the whole multi-day experience in when one of its days is named', () => {
    /* Day 3 is day one of a two-day traverse: editing it alone would leave a route that does not join up. */
    const radius = blastRadiusFor({ draft: trekDraft(), intent: 'change_day', namedDays: [3] });
    expect(radius.days).toEqual([3, 4]);
  });

  it('"less driving overall" reaches the route, the bases and the transfer days', () => {
    const radius = blastRadiusFor({ draft: trekDraft(), intent: 'change_route' });
    expect(radius.wholeTrip).toBe(true);
    expect(radius.bases).toEqual(['city', 'mountain']);
    expect(radius.facts).toContain('transport');
  });

  it('a question about the trip reaches nothing', () => {
    const radius = blastRadiusFor({ draft: trekDraft(), intent: 'explain_decision' });
    expect(radius).toMatchObject({ days: [], bases: [], facts: [], wholeTrip: false });
  });

  it('a pace change reaches every day but not where the traveller sleeps', () => {
    const radius = blastRadiusFor({ draft: trekDraft(), intent: 'change_pace' });
    expect(radius.days).toEqual([1, 2, 3, 4, 5]);
    expect(radius.bases).toEqual([]);
  });
});

describe('§39 — the preservation contract', () => {
  it('names every day and activity outside the radius as preserved', () => {
    const draft = trekDraft();
    const radius = blastRadiusFor({ draft, intent: 'change_day', namedDays: [2] });
    const contract = preservationContractFor({ draft, radius, intent: 'change_day', locks: [] });
    expect(contract.change).toContain('day:2');
    expect(contract.preserve).toContain('day:1');
    expect(contract.preserve).toContain('day:5');
    expect(contract.preserve).toContain(`activity:${idOf(draft, 'Victoria Peak')}`);
    /* Hard rules and bookings are preserved because this refinement is not about them. */
    expect(contract.preserve).toContain('trip_fact:diet');
    expect(contract.preserve).toContain('trip_fact:booked_facts');
    expect(contract.preserve).toContain('trip_fact:hard_rules');
    expect(contract.recheck).toContain('day:2:travel');
  });

  it('lets a diet change touch the diet, and nothing else about the traveller', () => {
    const draft = trekDraft();
    const radius = blastRadiusFor({ draft, intent: 'change_diet_rule' });
    const contract = preservationContractFor({ draft, radius, intent: 'change_diet_rule', locks: [] });
    expect(contract.preserve).not.toContain('trip_fact:diet');
    expect(contract.preserve).toContain('trip_fact:booked_facts');
  });

  it('a lock beats the radius, always', () => {
    const draft = trekDraft();
    const locks: RefinementLock[] = [{ kind: 'day', ref: '2', label: 'Day 2', lockedAt: '2026-05-01T00:00:00.000Z' }];
    const radius = blastRadiusFor({ draft, intent: 'change_day', namedDays: [2] });
    const contract = preservationContractFor({ draft, radius, intent: 'change_day', locks });
    expect(contract.preserve).toContain('day:2');
    expect(contract.change).not.toContain('day:2');
    expect(lockConflicts({ radius, locks, draft }).map((lock) => lock.label)).toEqual(['Day 2']);
  });
});

/* ------------------------------------------------------------------ *
 * §41–§49 — the graph
 * ------------------------------------------------------------------ */

function interpreterReturning(...readings: RefinementInterpretation[]): RefinementInterpreter & { calls: number } {
  let index = 0;
  const seam = {
    calls: 0,
    async interpret(): Promise<RefinementInterpretation> {
      seam.calls += 1;
      const reading = readings[Math.min(index, readings.length - 1)];
      index += 1;
      if (!reading) throw new Error('the fake interpreter ran out of readings');
      return reading;
    },
  };
  return seam;
}

async function runGraph(input: {
  draft: TripDraft;
  readings: RefinementInterpretation[];
  request: string;
  locks?: RefinementLock[];
  commit?: (input: { draft: TripDraft; baseVersion: number }) => Promise<number>;
  threadId?: string;
  confirmMaterialChanges?: boolean;
}) {
  const interpreter = interpreterReturning(...input.readings);
  const committed: TripDraft[] = [];
  const graph = buildRefinementGraph({
    loadDraft: async () => input.draft,
    interpreter,
    commit: async ({ draft, baseVersion }) => {
      committed.push(draft);
      return input.commit ? input.commit({ draft, baseVersion }) : baseVersion + 1;
    },
    checkpointer: new MemorySaver(),
    ...(input.confirmMaterialChanges ? { confirmMaterialChanges: true } : {}),
  });
  const config = { configurable: { thread_id: input.threadId ?? 'test-thread' } };
  const state = await graph.invoke({ tripId: 'trip-1', canonicalTripVersion: 1, userRequest: input.request, locks: input.locks ?? [], status: 'classifying' as const }, config);
  return { state, interpreter, committed, graph, config };
}

describe('§41 — one model call for an ordinary refinement', () => {
  it('interprets, applies and verifies in a single call', async () => {
    const draft = trekDraft();
    const { state, interpreter, committed } = await runGraph({
      draft,
      request: 'Swap the Sheung Wan walk for somewhere with better food.',
      readings: [
        {
          intent: 'change_activity',
          namedDays: [2],
          patch: tripPatchSchema.parse({
            changed: ['Day 2 now walks Wan Chai.'],
            kept: ['Victoria Peak', 'the traverse'],
            operations: [{ op: 'replace_activity', id: idOf(draft, 'Sheung Wan Heritage Walk'), activity: { name: 'Wan Chai Market Walk', kind: 'neighbourhood', why: 'Denser food, fewer tour groups.' } }],
          }),
        },
      ],
    });
    expect(interpreter.calls).toBe(1);
    expect(state.status).toBe('done');
    expect(state.modelCallsThisAction).toBe(1);
    expect(state.applied).toEqual(['replaced Sheung Wan Heritage Walk with Wan Chai Market Walk on day 2']);
    expect(state.canonicalTripVersion).toBe(2);
    expect(committed[0]!.days[1]!.anchors[0]!.name).toBe('Wan Chai Market Walk');
    /* §51 — only the changed day is queued for re-measurement. */
    expect(state.verificationNeeded).toContain('day:2:travel');
    expect(state.verificationNeeded).not.toContain('day:1:travel');
  });

  it('answers a question without touching the trip, and spends one call', async () => {
    const { state, committed, interpreter } = await runGraph({
      draft: trekDraft(),
      request: 'Why did you leave out the second island?',
      readings: [{ intent: 'explain_decision', explanation: 'Two islands in five days would have cost a whole day on ferries for one view.' }],
    });
    expect(interpreter.calls).toBe(1);
    expect(state.status).toBe('done');
    expect(state.explanation).toMatch(/one view/);
    expect(committed).toEqual([]);
    expect(state.canonicalTripVersion).toBe(1);
  });
});

describe('§42 — the human-in-the-loop interrupt', () => {
  it('stops on a clarifying question, resumes with the answer, and spends exactly two calls', async () => {
    const draft = trekDraft();
    const question = { question: 'You asked for less driving. Would you rather drop the mountain nights or shorten the city days?', options: ['Drop the mountain nights', 'Shorten the city days'], because: 'One of them has to give.' };
    const interpreter = interpreterReturning(
      { intent: 'change_route', needsClarification: question },
      {
        intent: 'change_route',
        patch: tripPatchSchema.parse({ changed: ['The city days are shorter.'], kept: ['The traverse'], operations: [{ op: 'update_day', day: 1, intensity: 'light', why: 'A gentler first day, as asked.' }] }),
      },
    );
    const graph = buildRefinementGraph({ loadDraft: async () => draft, interpreter, commit: async ({ baseVersion }) => baseVersion + 1, checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'interrupt-thread' } };
    const first = await graph.invoke({ tripId: 'trip-1', canonicalTripVersion: 1, userRequest: 'Less driving please.', locks: [], status: 'classifying' as const }, config);
    /* The run has stopped; the question is on the state and nothing has been committed. */
    expect(first.status).toBe('awaiting_answer');
    expect(first.pendingQuestion).toEqual(question);
    expect(interpreter.calls).toBe(1);

    const resumed = await graph.invoke(resumeWith('Shorten the city days'), config);
    expect(interpreter.calls).toBe(2);
    expect(resumed.status).toBe('done');
    expect(resumed.answer).toBe('Shorten the city days');
    expect(resumed.modelCallsThisAction).toBe(MAX_REFINEMENT_MODEL_CALLS);
    expect(resumed.applied).toEqual(['updated day 1']);
  });

  it('refuses a third call, so there is no loop even if the model keeps asking', async () => {
    const question = { question: 'Which would you rather?', options: ['A', 'B'] };
    /* A model that answers every call with another question. */
    const interpreter = interpreterReturning({ intent: 'change_route', needsClarification: question });
    const graph = buildRefinementGraph({ loadDraft: async () => trekDraft(), interpreter, commit: async ({ baseVersion }) => baseVersion + 1, checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'loop-thread' } };
    await graph.invoke({ tripId: 'trip-1', canonicalTripVersion: 1, userRequest: 'Change everything.', locks: [], status: 'classifying' as const }, config);
    const resumed = await graph.invoke(resumeWith('A'), config);
    expect(interpreter.calls).toBe(2);
    expect(resumed.status).toBe('failed');
    expect(resumed.errors.join(' ')).toMatch(/produced no change to apply/);
  });

  it('interrupts on a lock in the way rather than overriding it', async () => {
    const draft = trekDraft();
    const locks: RefinementLock[] = [{ kind: 'activity', ref: idOf(draft, 'Victoria Peak'), label: 'Victoria Peak', lockedAt: '2026-05-01T00:00:00.000Z' }];
    const { state, committed } = await runGraph({
      draft,
      locks,
      request: 'Make day 1 much less touristy.',
      readings: [{ intent: 'change_day', namedDays: [1], patch: tripPatchSchema.parse({ changed: [], kept: [], operations: [{ op: 'remove_activity', id: idOf(draft, 'Victoria Peak'), reason: 'Touristy.' }] }) }],
    });
    expect(state.status).toBe('awaiting_answer');
    expect(state.pendingQuestion?.question).toMatch(/Victoria Peak, which you asked to keep/);
    expect(committed).toEqual([]);
  });
});

describe('§49 — failure leaves the trip alone', () => {
  it('reports a model failure and commits nothing', async () => {
    const interpreter: RefinementInterpreter = { async interpret() { throw new Error('the provider timed out'); } };
    const committed: TripDraft[] = [];
    const graph = buildRefinementGraph({ loadDraft: async () => trekDraft(), interpreter, commit: async ({ draft, baseVersion }) => { committed.push(draft); return baseVersion + 1; }, checkpointer: new MemorySaver() });
    const state = await graph.invoke({ tripId: 'trip-1', canonicalTripVersion: 7, userRequest: 'Anything.', locks: [], status: 'classifying' as const }, { configurable: { thread_id: 'fail-thread' } });
    expect(state.status).toBe('failed');
    expect(state.errors.join(' ')).toMatch(/timed out/);
    expect(committed).toEqual([]);
    expect(state.canonicalTripVersion).toBe(7);
  });

  it('reports a failed save and leaves the version where it was', async () => {
    const draft = trekDraft();
    const { state } = await runGraph({
      draft,
      request: 'Swap day 2.',
      commit: async () => { throw new Error('another edit landed first'); },
      readings: [{ intent: 'change_activity', namedDays: [2], patch: tripPatchSchema.parse({ changed: [], kept: [], operations: [{ op: 'update_day', day: 2, theme: 'Wan Chai' }] }) }],
    });
    expect(state.status).toBe('failed');
    expect(state.errors.join(' ')).toMatch(/another edit landed first/);
    expect(state.canonicalTripVersion).toBe(1);
  });

  it('reports a patch that applied nothing as rejected, not as success', async () => {
    const draft = trekDraft();
    const { state, committed } = await runGraph({
      draft,
      request: 'Remove something that is not there.',
      readings: [{ intent: 'remove_activity', namedDays: [1], patch: tripPatchSchema.parse({ changed: [], kept: [], operations: [{ op: 'remove_activity', id: 'd9-a0-ghost', reason: 'x' }] }) }],
    });
    expect(state.status).toBe('rejected');
    expect(state.refused[0]!.reason).toBe('no such activity in this draft');
    expect(committed).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §35 — durable checkpoints
 * ------------------------------------------------------------------ */

describe('§35 — checkpoints survive a new database connection', () => {
  it('an interrupted refinement resumes after the process forgets everything in memory', async () => {
    const trip = newTrip();
    const draft = trekDraft();
    const question = { question: 'Drop the mountain nights or shorten the city days?', options: ['Drop the mountain nights', 'Shorten the city days'] };
    const readings: RefinementInterpretation[] = [
      { intent: 'change_route', needsClarification: question },
      { intent: 'change_route', patch: tripPatchSchema.parse({ changed: ['Day 1 is gentler.'], kept: ['The traverse'], operations: [{ op: 'update_day', day: 1, intensity: 'light' }] }) },
    ];
    const threadId = refinementThreadId(trip.id);

    const first = buildRefinementGraph({ loadDraft: async () => draft, interpreter: interpreterReturning(readings[0]!), commit: async ({ baseVersion }) => baseVersion + 1, checkpointer: new SqliteRefinementCheckpointer(trip.id) });
    const paused = await first.invoke({ tripId: trip.id, canonicalTripVersion: 1, userRequest: 'Less driving.', locks: [], status: 'classifying' as const }, { configurable: { thread_id: threadId } });
    expect(paused.status).toBe('awaiting_answer');
    const stored = getDb().prepare('SELECT COUNT(*) AS n FROM refinement_checkpoints WHERE thread_id = ?').get(threadId) as { n: number };
    expect(stored.n).toBeGreaterThan(0);

    /* Everything in memory is dropped: a new connection, a new graph, a new interpreter. */
    const globalForDb = globalThis as unknown as { sidequestDb?: { close(): void } };
    globalForDb.sidequestDb?.close();
    delete globalForDb.sidequestDb;

    const second = buildRefinementGraph({ loadDraft: async () => draft, interpreter: interpreterReturning(readings[1]!), commit: async ({ baseVersion }) => baseVersion + 1, checkpointer: new SqliteRefinementCheckpointer(trip.id) });
    const resumed = await second.invoke(resumeWith('Shorten the city days'), { configurable: { thread_id: threadId } });
    expect(resumed.status).toBe('done');
    expect(resumed.answer).toBe('Shorten the city days');
    expect(resumed.applied).toEqual(['updated day 1']);
  });

  it('deletes a thread completely, writes included', async () => {
    const trip = newTrip();
    const threadId = refinementThreadId(trip.id);
    const saver = new SqliteRefinementCheckpointer(trip.id);
    const graph = buildRefinementGraph({ loadDraft: async () => trekDraft(), interpreter: interpreterReturning({ intent: 'explain_decision', explanation: 'Because.' }), commit: async ({ baseVersion }) => baseVersion + 1, checkpointer: saver });
    await graph.invoke({ tripId: trip.id, canonicalTripVersion: 1, userRequest: 'Why?', locks: [], status: 'classifying' as const }, { configurable: { thread_id: threadId } });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM refinement_checkpoints WHERE thread_id = ?').get(threadId) as { n: number }).n).toBeGreaterThan(0);
    await saver.deleteThread(threadId);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM refinement_checkpoints WHERE thread_id = ?').get(threadId) as { n: number }).n).toBe(0);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM refinement_writes WHERE thread_id = ?').get(threadId) as { n: number }).n).toBe(0);
  });

  it('cascades checkpoints away when the trip is deleted', () => {
    const trip = newTrip();
    const threadId = refinementThreadId(trip.id);
    getDb().prepare("INSERT INTO refinement_checkpoints (trip_id, thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata, created_at) VALUES (?, ?, '', 'c1', 'json', ?, ?, '2026-01-01T00:00:00.000Z')").run(trip.id, threadId, Buffer.from('{}'), Buffer.from('{}'));
    getDb().prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM refinement_checkpoints WHERE thread_id = ?').get(threadId) as { n: number }).n).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * §46/§47/§48 — versions, undo, concurrency
 * ------------------------------------------------------------------ */

/**
 * A REAL RECONCILED ITINERARY, NOT A HAND-WRITTEN STUB.
 *
 * The first version of these tests used a five-field object literal cast through
 * `as never`, and `itinerarySchema` rejected it on read — which is the schema
 * doing its job: a version whose itinerary cannot be parsed cannot be restored,
 * and "undo" that throws is worse than no undo at all. So the fixture is built
 * by the same reconciler the product uses, once, and reused.
 */
let itineraryFixture: Itinerary | null = null;
async function realItinerary(summary: string): Promise<Itinerary> {
  if (!itineraryFixture) {
    const context = boardWorld();
    const result = await reconcileTripDraft({ draft: draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 2 }], days: [{ base: 'base', anchors: [{ name: 'Convict Lake' }] }, { base: 'base', anchors: [{ name: 'Mono Lake' }] }, { base: 'base', anchors: [{ name: 'Hot Creek' }] }] }), context });
    itineraryFixture = result.itinerary;
  }
  return { ...itineraryFixture, summary };
}

describe('§46 — versions and undo', () => {
  async function version(tripId: string, previous: number, theme: string) {
    return recordVersion({ tripId, previousVersion: previous, summary: { changed: [theme], kept: [], rechecking: [] }, itinerary: await realItinerary(theme), draft: trekDraft() });
  }

  it('numbers versions monotonically and keeps every one', async () => {
    const trip = newTrip();
    expect(currentVersion(trip.id)).toBe(0);
    await version(trip.id, 0, 'first');
    await version(trip.id, 1, 'second');
    await version(trip.id, 2, 'third');
    expect(currentVersion(trip.id)).toBe(3);
    expect(listVersions(trip.id).map((entry) => entry.version)).toEqual([3, 2, 1]);
  });

  it('undo names the version before the head, and restores it exactly', async () => {
    const trip = newTrip();
    await version(trip.id, 0, 'first');
    await version(trip.id, 1, 'second');
    await version(trip.id, 2, 'third');
    const target = undoTarget(trip.id);
    expect(target?.version).toBe(2);
    expect(target?.summary.changed).toEqual(['second']);
    /* The itinerary comes back whole, so restoring is a write rather than a replay. */
    expect(target?.itinerary.summary).toBe('second');
    expect(target?.draft?.signatures).toEqual(['The Ala-Kul Traverse']);
  });

  it('has nothing to undo when the only version is the trip as built', async () => {
    const trip = newTrip();
    await version(trip.id, 0, 'as built');
    expect(undoTarget(trip.id)).toBeNull();
  });

  /*
   * The live acceptance run finished one successful refinement at head version 1,
   * and Undo was not offered: `undoTarget` is head - 1, and there was no version
   * before it. The first change a traveller makes is the one most likely to want
   * undoing, so the build itself is now version 1.
   */
  it('records the trip as built, so the FIRST refinement is undoable', async () => {
    const trip = newTrip();
    const built = await realItinerary('as Sidequest built it');
    expect(ensureBaselineVersion({ tripId: trip.id, itinerary: built, draft: trekDraft() })).toBe(1);
    /* Idempotent: a second call on a trip that already has a version changes nothing. */
    expect(ensureBaselineVersion({ tripId: trip.id, itinerary: built, draft: trekDraft() })).toBe(1);
    expect(currentVersion(trip.id)).toBe(1);

    await version(trip.id, 1, 'after the refinement');
    const target = undoTarget(trip.id);
    expect(target?.version).toBe(1);
    expect(target?.itinerary.summary).toBe('as Sidequest built it');
    expect(target?.summary.changed).toEqual([]);
  });

  it('keeps a branch out of the canonical lane', async () => {
    const trip = newTrip();
    await version(trip.id, 0, 'canonical');
    recordVersion({ tripId: trip.id, previousVersion: 0, lane: 'branch', summary: { changed: ['alt'], kept: [], rechecking: [] }, itinerary: await realItinerary('alt') });
    expect(currentVersion(trip.id, 'canonical')).toBe(1);
    expect(currentVersion(trip.id, 'branch')).toBe(1);
    expect(listVersions(trip.id, 'canonical')).toHaveLength(1);
    expect(listVersions(trip.id, 'canonical')[0]!.summary.changed).toEqual(['canonical']);
  });
});

describe('§48 — optimistic concurrency', () => {
  it('refuses a write computed against a version that is no longer current', async () => {
    const trip = newTrip();
    const itinerary = await realItinerary('a');
    recordVersion({ tripId: trip.id, previousVersion: 0, summary: { changed: ['a'], kept: [], rechecking: [] }, itinerary });
    recordVersion({ tripId: trip.id, previousVersion: 1, summary: { changed: ['b'], kept: [], rechecking: [] }, itinerary: { ...itinerary, summary: 'b' } });
    /* A second refinement that started when the head was 1 must not overwrite 2. */
    expect(() => recordVersion({ tripId: trip.id, previousVersion: 1, summary: { changed: ['c'], kept: [], rechecking: [] }, itinerary: { ...itinerary, summary: 'c' } })).toThrow(StaleTripVersionError);
    expect(currentVersion(trip.id)).toBe(2);
    expect(listVersions(trip.id)[0]!.summary.changed).toEqual(['b']);
  });
});

describe('§48/§59 — one refinement at a time, and a double press is one press', () => {
  it('rejects a second request while the first is in flight, naming the holder', () => {
    const trip = newTrip();
    const threadId = refinementThreadId(trip.id);
    const first = beginRun({ tripId: trip.id, threadId, request: 'Make Day 4 easier.', baseVersion: 1 });
    expect(first.reused).toBe(false);
    let thrown: unknown;
    try {
      beginRun({ tripId: trip.id, threadId, request: 'Actually keep the hike but change the hotel.', baseVersion: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RefinementBusyError);
    expect((thrown as RefinementBusyError).activeRun.request).toBe('Make Day 4 easier.');
    expect((thrown as RefinementBusyError).message).toMatch(/still working on your last change/);
  });

  it('returns the same run for a repeated press rather than starting a second', () => {
    const trip = newTrip();
    const threadId = refinementThreadId(trip.id);
    const first = beginRun({ tripId: trip.id, threadId, request: 'Less driving.', baseVersion: 1, idempotencyKey: 'press-1' });
    const second = beginRun({ tripId: trip.id, threadId, request: 'Less driving.', baseVersion: 1, idempotencyKey: 'press-1' });
    expect(second.reused).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    expect(listRuns(trip.id)).toHaveLength(1);
  });

  it('releases the lease when the run finishes, so the next request can start', () => {
    const trip = newTrip();
    const threadId = refinementThreadId(trip.id);
    const first = beginRun({ tripId: trip.id, threadId, request: 'One.', baseVersion: 1 });
    updateRun({ id: first.run.id, status: 'done', intent: 'change_day', modelCalls: 1 });
    expect(activeRun(trip.id)).toBeNull();
    expect(() => beginRun({ tripId: trip.id, threadId, request: 'Two.', baseVersion: 2 })).not.toThrow();
  });

  it('holds the lease while it waits for the traveller to answer', () => {
    const trip = newTrip();
    const threadId = refinementThreadId(trip.id);
    const first = beginRun({ tripId: trip.id, threadId, request: 'Less driving.', baseVersion: 1 });
    updateRun({ id: first.run.id, status: 'awaiting_answer', question: { question: 'Which?', options: ['A', 'B'] } });
    expect(activeRun(trip.id)?.status).toBe('awaiting_answer');
    expect(() => beginRun({ tripId: trip.id, threadId, request: 'Something else.', baseVersion: 1 })).toThrow(RefinementBusyError);
  });

  it('frees a lease whose process died, without retrying the work', () => {
    const trip = newTrip();
    const threadId = refinementThreadId(trip.id);
    beginRun({ tripId: trip.id, threadId, request: 'Interrupted.', baseVersion: 1, now: new Date('2026-06-01T10:00:00.000Z') });
    expect(releaseStaleRuns({ olderThanMs: 5 * 60_000, now: new Date('2026-06-01T10:10:00.000Z') })).toBe(1);
    expect(activeRun(trip.id)).toBeNull();
    expect(listRuns(trip.id)[0]!.error).toMatch(/Your trip is unchanged/);
  });
});

/* ------------------------------------------------------------------ *
 * §61 — thread ids are not authorization
 * ------------------------------------------------------------------ */

describe('§61 — thread identity', () => {
  it('is derived from the trip alone and carries nothing personal', () => {
    expect(refinementThreadId('abc-123')).toBe('sidequest:abc-123');
    expect(tripIdOfThread('sidequest:abc-123')).toBe('abc-123');
    expect(tripIdOfThread(alternativeThreadId('abc-123', 'more-lakes'))).toBe('abc-123');
    expect(tripIdOfThread('not-a-thread')).toBeNull();
  });

  it('refuses anything that is not a plain trip id, so a thread id can never carry a path or a query', () => {
    expect(() => refinementThreadId('abc/../other')).toThrow();
    expect(() => refinementThreadId('')).toThrow();
    expect(() => alternativeThreadId('abc-123', 'Bad Branch')).toThrow();
  });
});

/**
 * THE LIVE FAILURE, AS A TEST.
 *
 * PRODUCTION LOCK V5. The one live refinement of the acceptance run failed:
 * asked to reduce driving across an eleven-day route while preserving two named
 * experiences, the model was truncated at `max_tokens` and the change was lost.
 * The traveller was told their trip was unchanged — correct, and the whole
 * outcome. Two things were wrong and both are fixed here.
 */
describe('a refinement that the model could not finish', () => {
  it('leaves the trip untouched and carries the reason, rather than swallowing it', async () => {
    const draft = trekDraft();
    const interpreter: RefinementInterpreter = {
      async interpret() {
        /* Exactly what the transport raises when the answer is cut off. */
        throw new Error('The model answered in a shape the schema refused (max_tokens).');
      },
    };
    const committed: TripDraft[] = [];
    const graph = buildRefinementGraph({ loadDraft: async () => draft, interpreter, commit: async ({ draft: d, baseVersion }) => { committed.push(d); return baseVersion + 1; }, checkpointer: new MemorySaver() });
    const state = await graph.invoke({ tripId: 'trip-1', canonicalTripVersion: 3, userRequest: 'Cut the driving, keep the trek.', locks: [], status: 'classifying' as const }, { configurable: { thread_id: 'truncated' } });
    expect(state.status).toBe('failed');
    expect(state.errors.join(' ')).toMatch(/max_tokens/);
    expect(committed).toEqual([]);
    expect(state.canonicalTripVersion).toBe(3);
  });

  it('gives a patch as large as the schema allows room to be written', () => {
    /*
     * The ceiling is derived rather than guessed: 40 operations is the schema's
     * cap and a replace_activity with its reason runs to roughly 60 tokens, so
     * a maximal patch is about 2,400 tokens. The ceiling must clear that with
     * room for the model's reasoning on top.
     */
    const maximalPatchTokens = 40 * 60;
    expect(REFINEMENT_MAX_TOKENS).toBeGreaterThan(maximalPatchTokens * 3);
    /* And still under the composition call's, because it is a smaller job. */
    expect(REFINEMENT_MAX_TOKENS).toBeLessThan(16_000);
  });
});

/**
 * The preserve-and-change shape the live request actually asked for, driven
 * through the graph with a fake interpreter so the plumbing is proved without
 * spending a call.
 */
describe('§52 — "keep the trek, cut the driving"', () => {
  it('preserves the named experience, changes only what it must, and versions the result', async () => {
    const draft = trekDraft();
    const trekDayIds = [3, 4];
    const { state, committed } = await runGraph({
      draft,
      request: 'Keep the Ala-Kul trek and the yurt nights exactly as they are, but cut down the driving on the other days.',
      readings: [
        {
          intent: 'preserve_x_change_y',
          namedDays: [1, 2, 5],
          patch: tripPatchSchema.parse({
            changed: ['Day 5 stays near the harbour instead of driving out.'],
            kept: ['The Ala-Kul Traverse', 'the mountain nights'],
            operations: [{ op: 'update_day', day: 5, theme: 'A slower last day near base', why: 'Less driving, as asked.' }],
          }),
        },
      ],
    });
    expect(state.status).toBe('done');
    expect(state.intent).toBe('preserve_x_change_y');
    /* The trek's days are outside the radius, so every one of them is preserved by name. */
    for (const day of trekDayIds) expect(state.contract?.preserve).toContain(`day:${day}`);
    expect(state.contract?.preserve).toContain('trip_fact:diet');
    expect(state.contract?.preserve).toContain('trip_fact:booked_facts');
    /* The trek days come back byte-identical. */
    for (const day of trekDayIds) expect(committed[0]!.days.find((d) => d.dayNumber === day)).toEqual(draft.days.find((d) => d.dayNumber === day));
    expect(state.canonicalTripVersion).toBe(2);
    /* §51 — only the changed day is queued for re-measurement. */
    expect(state.verificationNeeded).toContain('day:5:travel');
    expect(state.verificationNeeded).not.toContain('day:3:travel');
  });
});

/**
 * TWO DEFECTS THE FINAL LIVE CLOSURE RUN EXPOSED.
 *
 * The one authorised refinement call failed, and the failure was not the one
 * that had been fixed. Both of these are recorded here because neither is
 * reachable without either a real model or a second run on the same thread, and
 * both would otherwise come back.
 */
describe('a second refinement on a trip that has already had one', () => {
  it('does not inherit the first action’s model-call count', async () => {
    /*
     * `graph.invoke` on a thread RESUMES it. With every action sharing one
     * namespace, the counter accumulated: the live run reported `modelCalls: 2`
     * for a single call. The harmless half. The dangerous half is that
     * `interpret` refuses at the ceiling — so after two failed refinements a
     * trip would silently refuse every future one, forever, without calling
     * anything.
     *
     * The namespace is the run id, so each action gets its own slice of state.
     */
    const draft = trekDraft();
    const saver = new MemorySaver();
    const readings = () => interpreterReturning({ intent: 'explain_decision', explanation: 'Because of the ridge.' });
    const runOnce = async (runId: string) => {
      const interpreter = readings();
      const graph = buildRefinementGraph({ loadDraft: async () => draft, interpreter, commit: async ({ baseVersion }) => baseVersion + 1, checkpointer: saver });
      return graph.invoke(
        { tripId: 'trip-1', canonicalTripVersion: 1, userRequest: 'Why is the pass on day 7?', locks: [], status: 'classifying' as const },
        { configurable: { thread_id: refinementRunThreadId('trip-1', runId) } },
      );
    };
    const first = await runOnce('run-a');
    const second = await runOnce('run-b');
    expect(first.modelCallsThisAction).toBe(1);
    /* Without the per-run namespace this is 2, and a third action would be refused. */
    expect(second.modelCallsThisAction).toBe(1);
    expect(second.errors).toEqual([]);
  });

  it('shares one namespace only when it is genuinely the same action resuming', async () => {
    const draft = trekDraft();
    const saver = new MemorySaver();
    const question = { question: 'Drop the mountain nights or shorten the coast leg?', options: ['Drop the mountain nights', 'Shorten the coast leg'] };
    const interpreter = interpreterReturning(
      { intent: 'change_route', needsClarification: question },
      { intent: 'change_route', patch: tripPatchSchema.parse({ changed: ['Day 1 is gentler.'], kept: ['The traverse'], operations: [{ op: 'update_day', day: 1, intensity: 'light' }] }) },
    );
    const graph = buildRefinementGraph({ loadDraft: async () => draft, interpreter, commit: async ({ baseVersion }) => baseVersion + 1, checkpointer: saver });
    const config = { configurable: { thread_id: refinementRunThreadId('trip-1', 'run-c') } };
    const paused = await graph.invoke({ tripId: 'trip-1', canonicalTripVersion: 1, userRequest: 'Less driving.', locks: [], status: 'classifying' as const }, config);
    expect(paused.status).toBe('awaiting_answer');
    const resumed = await graph.invoke(resumeWith('Shorten the coast leg'), config);
    expect(resumed.status).toBe('done');
    expect(resumed.modelCallsThisAction).toBe(2);
  });
});

describe('the refinement deadline', () => {
  it('is long enough for the refinement that was observed overrunning it', () => {
    /*
     * The live closure run began at 23:53:13.240 and ended at 23:53:58.276 —
     * 45.0 s, exactly `REFINEMENT_TIMEOUT_MS`, with the model still writing.
     * 45 s was invented alongside the 4,000-token ceiling on the same wrong
     * premise that a refinement is a small job.
     */
    const observedOverrunMs = 45_000;
    expect(REFINEMENT_TIMEOUT_MS).toBeGreaterThan(observedOverrunMs * 1.5);
    /* Still under the composition call's, because designing a trip is the larger job. */
    expect(REFINEMENT_TIMEOUT_MS).toBeLessThan(110_000);
  });
});

/* ------------------------------------------------------------------ *
 * §11, §44 — nothing internal reaches the traveller
 * ------------------------------------------------------------------ */

describe('§11 — the summary a traveller reads holds no system vocabulary', () => {
  const INTERNAL = /activity:|base:|day:\d+:|trip_fact:|patch|checkpoint|thread|blast|radius|token|provider|draft/i;

  function contractFor(days: readonly number[], locks: readonly RefinementLock[] = []) {
    const draft = trekDraft();
    const radius = { days: [...days], bases: [], facts: [], wholeTrip: false, reason: 'test' };
    return { draft, contract: preservationContractFor({ draft, radius, intent: 'change_day', locks }) };
  }

  it('names preserved days and facts in prose, never by address', () => {
    const { draft, contract } = contractFor([2]);
    const kept = describeKept({ preserve: contract.preserve, draft });
    expect(kept.length).toBeGreaterThan(0);
    for (const line of kept) expect(line).not.toMatch(INTERNAL);
    expect(kept.some((line) => /Days 1, 3, 4 and 5 exactly as they were/.test(line))).toBe(true);
  });

  it('folds an activity into its day rather than saying the same thing twice', () => {
    const { draft, contract } = contractFor([2]);
    const kept = describeKept({ preserve: contract.preserve, draft });
    /* Every anchor outside day 2 is on the preserve list, and none of them is named separately. */
    expect(kept.some((line) => line.includes('Victoria Peak'))).toBe(false);
  });

  it('names a lock inside the changing scope by its own name', () => {
    const draft = trekDraft();
    const id = idOf(draft, 'Sheung Wan Heritage Walk');
    const radius = { days: [2], bases: [], facts: [], wholeTrip: false, reason: 'test' };
    const contract = preservationContractFor({ draft, radius, intent: 'change_day', locks: [{ kind: 'activity', ref: id, label: 'Sheung Wan Heritage Walk', lockedAt: '2026-01-01' }] });
    const kept = describeKept({ preserve: contract.preserve, draft });
    expect(kept.some((line) => line === 'Sheung Wan Heritage Walk on day 2')).toBe(true);
    for (const line of kept) expect(line).not.toMatch(INTERNAL);
  });

  it('says every place you sleep when no stay changes', () => {
    const { draft, contract } = contractFor([2]);
    expect(describeKept({ preserve: contract.preserve, draft })).toContain('Every place you sleep');
  });

  it('turns the recheck list into travel times, opening hours and areas', () => {
    const { draft, contract } = contractFor([2, 3]);
    const rechecking = describeRechecking({ recheck: contract.recheck, draft });
    expect(rechecking).toContain('Travel times on days 2 and 3');
    expect(rechecking).toContain('Opening hours on days 2 and 3');
    for (const line of rechecking) expect(line).not.toMatch(INTERNAL);
  });

  it('drops an address the draft no longer resolves rather than guessing', () => {
    const draft = trekDraft();
    const kept = describeKept({ preserve: ['activity:d9-a3-gone', 'base:nowhere'], draft });
    expect(kept).toEqual([]);
  });

  it('rewrites every refusal reason the system can produce', () => {
    const reasons = ['the traveller locked this', 'a day holds at most five experiences', 'no such activity in this draft', 'the patched draft is not valid: too short', 'something new'];
    for (const reason of reasons) {
      const sentence = describeRefusal(reason);
      expect(sentence).not.toMatch(INTERNAL);
      expect(sentence.endsWith('.')).toBe(true);
    }
    expect(describeRefusal('the traveller locked this')).toMatch(/asked Sidequest to keep/);
  });

  it('returns empty lists when there is no contract at all', () => {
    expect(describeContract({ contract: undefined, draft: trekDraft() })).toEqual({ kept: [], rechecking: [] });
  });
});

/* ------------------------------------------------------------------ *
 * §9 — patch validity, and atomicity
 * ------------------------------------------------------------------ */

describe('§9 — a patch may not leave the trip impossible', () => {
  it('passes a sound trip with nothing to say', () => {
    expect(patchInvariantViolations({ draft: trekDraft() })).toEqual([]);
  });

  it('catches a day that sleeps at a stay the trip does not have', () => {
    const draft = trekDraft();
    draft.days[0]!.baseId = 'nowhere';
    expect(patchInvariantViolations({ draft }).join(' ')).toMatch(/day 1 sleeps at a stay the trip does not have/);
  });

  it('catches beds that do not cover the nights', () => {
    const draft = trekDraft();
    draft.bases[0]!.nights = 1;
    expect(patchInvariantViolations({ draft }).join(' ')).toMatch(/5 days need 4 nights of beds and the trip has 3/);
  });

  it('catches a stay no day uses', () => {
    const draft = trekDraft();
    draft.bases.push({ id: 'unused', name: 'Lakeside', nights: 0, why: 'x' } as TripDraft['bases'][number]);
    expect(patchInvariantViolations({ draft }).join(' ')).toMatch(/Lakeside is a stay no day uses/);
  });

  it('catches the same experience twice, within a day and across the trip', () => {
    const withinDay = trekDraft();
    withinDay.days[0]!.anchors.push({ ...withinDay.days[0]!.anchors[0]! });
    expect(patchInvariantViolations({ draft: withinDay }).join(' ')).toMatch(/day 1 holds Victoria Peak twice/);

    const acrossTrip = trekDraft();
    acrossTrip.days[4]!.anchors = [{ ...acrossTrip.days[0]!.anchors[0]! }];
    expect(patchInvariantViolations({ draft: acrossTrip }).join(' ')).toMatch(/Victoria Peak appears on both day 1 and day 5/);
  });

  it('catches a day left belonging to a multi-day experience the trip dropped', () => {
    const draft = trekDraft();
    draft.signatures = ['Something else entirely'];
    expect(patchInvariantViolations({ draft }).join(' ')).toMatch(/belongs to "The Ala-Kul Traverse", which the trip no longer lists/);
  });

  it('catches the same meal eaten twice in a day', () => {
    const draft = trekDraft();
    draft.days[0]!.meals = { lunch: 'Wonton noodles at the market', dinner: 'wonton noodles at the market' };
    expect(patchInvariantViolations({ draft }).join(' ')).toMatch(/day 1 eats the same meal twice/);
  });

  it('catches transport advice that contradicts how the traveller gets around', () => {
    const draft = trekDraft();
    draft.package.transport.notes = ['Rent a car at the airport and drive yourself to the valley.'];
    expect(patchInvariantViolations({ draft }).join(' ')).toMatch(/drive on a trip they are not driving/);
  });

  it('checks the dates only when the patch moved them', () => {
    const draft = trekDraft();
    draft.window = { startDate: '2020-05-01', endDate: '2020-05-02' };
    expect(patchInvariantViolations({ draft })).toEqual([]);
    const moved = patchInvariantViolations({ draft, windowMutated: true }).join(' ');
    expect(moved).toMatch(/cover 1 night and the trip has 4/);
    expect(moved).toMatch(/start in the past/);
  });

  it('catches a booking the patch orphaned', () => {
    const draft = trekDraft();
    draft.window = { startDate: '2030-05-01', endDate: '2030-05-05' };
    const violations = patchInvariantViolations({ draft, booked: [{ title: 'Mountain hut', baseId: 'gone' }, { title: 'Ferry', date: '2030-06-01' }] });
    expect(violations.join(' ')).toMatch(/"Mountain hut" is attached to a stay the trip no longer has/);
    expect(violations.join(' ')).toMatch(/"Ferry" falls outside/);
  });

  it('applies nothing at all when the result would be impossible', () => {
    const draft = trekDraft();
    const patch: TripPatch = tripPatchSchema.parse({
      changed: ['Day 5 now repeats the Peak.'],
      kept: ['everything else'],
      operations: [
        { op: 'add_activity', day: 5, activity: { name: 'Victoria Peak', kind: 'viewpoint', why: 'The traveller asked for it again.' } },
        { op: 'update_day', day: 5, theme: 'A second look from above' },
      ],
    });
    const result = applyTripPatch({ draft, patch });
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    /* Atomic: the draft that comes back is the draft that went in, theme included. */
    expect(result.draft).toEqual(draft);
    expect(result.refused.some((entry) => /appears on both day 1 and day 5/.test(entry.reason))).toBe(true);
  });

  it('refuses a booking-orphaning patch rather than half-applying it', () => {
    const draft = trekDraft();
    const patch: TripPatch = tripPatchSchema.parse({
      changed: ['Dropped the mountain hut.'],
      kept: ['the city days'],
      operations: [{ op: 'replace_base', id: 'mountain', name: 'Lower Valley', nights: 2, why: 'Lower down, warmer, same trailhead.' }],
    });
    const result = applyTripPatch({ draft, patch, booked: [{ title: 'Mountain hut', baseId: 'mountain' }] });
    /* The base id survives a rename, so this one is legal and must apply. */
    expect(result.ok).toBe(true);
    expect(result.draft.bases.find((base) => base.id === 'mountain')?.name).toBe('Lower Valley');
  });
});

/**
 * V6 §30 — PROPOSE_CHANGE BEFORE APPLY_CHANGE.
 *
 * A change of three days or more, a base, the route or the dates is shown
 * before it lands. The traveller's Apply goes straight to the apply node —
 * no second model call — and Cancel leaves the trip untouched with a
 * sentence that says so.
 */
describe('V6 §30 — a material change is proposed before it is applied', () => {
  const routeChange = () => ({
    intent: 'change_route' as const,
    patch: tripPatchSchema.parse({ changed: ['The route now ends on the coast.'], kept: ['The traverse'], operations: [{ op: 'update_day', day: 1, theme: 'Coast first', why: 'As asked.' }] }),
  });
  it('stops with a preview and applies on "Apply" without another model call', async () => {
    const { state, interpreter, committed, graph, config } = await runGraph({ draft: trekDraft(), request: 'End on the coast instead.', readings: [routeChange()], confirmMaterialChanges: true });
    expect(state.status).toBe('awaiting_answer');
    expect(state.confirm).toBe('pending');
    expect(state.pendingQuestion?.options).toEqual(['Apply', 'Cancel']);
    expect(state.pendingQuestion?.question).toMatch(/would change/);
    /* V6 — the preview is the application's own account, never the model's prose. */
    expect(state.proposedPatch?.changed).toEqual(['updated day 1']);
    expect(committed).toEqual([]);
    const applied = await graph.invoke(resumeWith('Apply'), config);
    expect(interpreter.calls).toBe(1);
    expect(applied.status).toBe('done');
    expect(applied.canonicalTripVersion).toBe(2);
    expect(committed).toHaveLength(1);
  });
  it('leaves the trip untouched on "Cancel" and says so', async () => {
    const { state, committed, graph, config } = await runGraph({ draft: trekDraft(), request: 'End on the coast instead.', readings: [routeChange()], confirmMaterialChanges: true });
    expect(state.status).toBe('awaiting_answer');
    const cancelled = await graph.invoke(resumeWith('Cancel'), config);
    expect(cancelled.status).toBe('done');
    expect(cancelled.confirm).toBe('cancelled');
    expect(cancelled.explanation).toMatch(/exactly as it was/);
    expect(committed).toEqual([]);
    expect(cancelled.canonicalTripVersion).toBe(1);
  });
  it('a proposal that moves a night says so truthfully, moves the beds, and names the stays in the scope', async () => {
    /*
     * Live Hokkaido refinement (V6 acceptance call 3): "drop the Obihiro night,
     * a third night at Akan-ko instead" produced a proposal that promised the
     * nights had moved while both stay operations were refused as "locked",
     * because the radius held no stays; days 1 and 2 — the ones asked to be
     * KEPT — were listed as changing because the request mentioned them.
     */
    const draft = draftOf({
      bases: [
        { id: 'biei', name: 'Biei', nights: 2 },
        { id: 'sounkyo', name: 'Sounkyo', nights: 2 },
        { id: 'akan-ko', name: 'Akan-ko', nights: 2 },
        { id: 'obihiro', name: 'Obihiro', nights: 1 },
      ],
      days: [
        { base: 'biei', anchors: [{ name: 'Shikisai-no-Oka' }] },
        { base: 'biei', anchors: [{ name: 'Farm Tomita' }] },
        { base: 'sounkyo', anchors: [{ name: 'Shirahige Falls' }] },
        { base: 'sounkyo', anchors: [{ name: 'Ginga Falls' }] },
        { base: 'akan-ko', anchors: [{ name: 'Lake Mashu' }] },
        { base: 'akan-ko', anchors: [{ name: 'Lake Akan cruise' }] },
        { base: 'obihiro', anchors: [{ name: 'Ikeda wine country stop' }] },
        { base: 'obihiro', anchors: [{ name: 'Rokujo Morning Market' }] },
      ],
    });
    const reading: RefinementInterpretation = {
      intent: 'preserve_x_change_y',
      namedDays: [1, 2, 7, 8],
      patch: tripPatchSchema.parse({
        changed: ['Akan-ko extended from 2 to 3 nights', 'Obihiro night removed'],
        kept: ['Both Biei days'],
        operations: [
          { op: 'update_base', id: 'akan-ko', nights: 3, why: 'A slower end.' },
          { op: 'update_base', id: 'obihiro', nights: 0, why: 'Dropped.' },
          { op: 'remove_activity', id: idOf(draft, 'Ikeda wine country stop'), reason: 'No relocation now.' },
          { op: 'add_activity', day: 7, at: 0, activity: { name: 'Akan-ko lakeside walk', kind: 'nature', why: 'Gentle.' } },
        ],
      }),
    };
    const { state, committed, graph, config } = await runGraph({ draft, request: 'Keep both Biei days exactly. Drop the Obihiro night and give us a third night at Akan-ko.', readings: [reading], confirmMaterialChanges: true });
    expect(state.status).toBe('awaiting_answer');
    expect(state.blastRadius?.days).toEqual([7, 8]);
    expect(state.blastRadius?.bases).toEqual(['akan-ko', 'obihiro']);
    expect(state.pendingQuestion?.question).toMatch(/days 7 and 8 and where you sleep in Akan-ko and Obihiro/);
    expect(state.proposedPatch?.changed).toEqual(['Akan-ko: 2 → 3 nights', 'dropped the night in Obihiro', 'removed Ikeda wine country stop from day 7: No relocation now.', 'added Akan-ko lakeside walk to day 7', 'days 7 and 8 now sleep in Akan-ko']);
    expect(state.contract?.preserve).toContain('day:1');
    expect(state.contract?.preserve).toContain('day:2');
    expect(state.contract?.preserve).not.toContain('base:akan-ko');
    const applied = await graph.invoke(resumeWith('Apply'), config);
    expect(applied.status).toBe('done');
    expect(applied.refused).toEqual([]);
    const result = committed[0]!;
    expect(result.bases.map((base) => `${base.id}:${base.nights}`)).toEqual(['biei:2', 'sounkyo:2', 'akan-ko:3']);
    expect(result.days.map((day) => day.baseId)).toEqual(['biei', 'biei', 'sounkyo', 'sounkyo', 'akan-ko', 'akan-ko', 'akan-ko', 'akan-ko']);
    expect(result.days[1]!.anchors[0]!.name).toBe('Farm Tomita');
    expect(result.days[7]!.anchors.map((a) => a.name)).toEqual(['Rokujo Morning Market']);
  });
  it('a stay outside the scope is refused as out of scope, not as a traveller lock, and the preview says so', async () => {
    const draft = trekDraft();
    const reading: RefinementInterpretation = {
      intent: 'change_day',
      namedDays: [1],
      patch: tripPatchSchema.parse({
        changed: ['Two nights up the valley'],
        kept: [],
        operations: [
          { op: 'update_day', day: 1, intensity: 'light', why: 'As asked.' },
          { op: 'update_base', id: 'mountain', nights: 3, why: 'Longer.' },
        ],
      }),
    };
    const { state } = await runGraph({ draft, request: 'Lighter day 1 and a longer mountain stay.', readings: [reading], confirmMaterialChanges: true });
    expect(state.status).toBe('done');
    expect(state.applied).toEqual(['updated day 1']);
    expect(state.refused?.[0]?.reason).toMatch(/outside the scope/);
    expect(describeRefusal(state.refused![0]!.reason)).toMatch(/outside the scope of this change/);
  });
  it('a one-day change still lands in one pass', async () => {
    const draft = trekDraft();
    const { state } = await runGraph({ draft, request: 'Lighter day 1.', readings: [{ intent: 'change_day', namedDays: [1], patch: tripPatchSchema.parse({ changed: ['Day 1 is lighter.'], kept: [], operations: [{ op: 'update_day', day: 1, intensity: 'light', why: 'As asked.' }] }) }], confirmMaterialChanges: true });
    expect(state.status).toBe('done');
    expect(state.confirm).toBeUndefined();
  });
});
