import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE BUILD QUEUE, WHICH DID NOT EXIST.
 *
 * Deployment-wide build concurrency is one — `limits.ts` says why, and it is a
 * promise made to volunteer-run services rather than a guess about hardware.
 * Until this file, the other side of that ceiling was nothing at all: a press
 * that arrived while somebody else's build ran was refused outright, with no
 * line, no place and no automatic retry, on the single most expensive and most
 * important action in the product. At a launch cohort's click rate that is
 * roughly one press in three turned away.
 *
 * `runner.start.test.ts` next door asserted the refusal, in good faith, as the
 * contract. It is the contract these tests replace.
 *
 * Nothing here spawns a process. `pumpCompilationQueue` takes its dispatcher as
 * an argument for exactly this reason: the subject is which job is started and
 * when, and a test that actually launched compile workers would be asserting
 * the queue's policy through four provider stacks and a `spawn`.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

const OPEN_STACK = {
  SIDEQUEST_COMPILER_PROVIDER: 'open',
  SIDEQUEST_GEOCODER_PROVIDER: 'nominatim',
  SIDEQUEST_PLACE_BACKBONE: 'overture',
  SIDEQUEST_ROUTES_PROVIDER: 'valhalla',
  SIDEQUEST_RESEARCH_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-test-never-a-real-key',
} as const;

const ENV_KEYS = [
  ...Object.keys(OPEN_STACK),
  'SIDEQUEST_DAILY_LIVE_COMPILATIONS',
  'SIDEQUEST_DAILY_MODEL_CALLS',
  'SIDEQUEST_MAX_CONCURRENT_COMPILATIONS',
  'SIDEQUEST_MAX_QUEUED_COMPILATIONS',
];

beforeEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sidequest-build-queue-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

/** Seeded under the fixture stack; the scope does not depend on the provider. */
async function seededConfirmedTrip(destination: string): Promise<{ tripId: string }> {
  const { createTrip } = await import('../db/repository');
  const repo = await import('../db/compiler-repository');
  const { compilerProviders } = await import('./providers');
  const { deriveScope, rebuildClarificationSet } = await import('@sidequest/compiler');

  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: destination,
    regionId: 'open-world',
    startDate: '2026-09-01',
    endDate: '2026-09-04',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });
  repo.saveDestinationQuery(trip.id, 'known_destination', destination);
  const { providers } = compilerProviders();
  const resolution = await providers.resolver.resolve({ query: destination, now: new Date() });
  repo.saveResolution(trip.id, resolution);
  const candidate = resolution.candidates[0]!;
  repo.saveSelectedCandidate(trip.id, candidate.id);
  const clarifications = rebuildClarificationSet({ resolution, candidate, nights: 3, known: {} });
  repo.saveClarifications(trip.id, clarifications);
  const scope = deriveScope({
    candidate,
    clarifications,
    nights: 3,
    revision: 1,
    transitMeasurable: false,
  });
  repo.saveScope(trip.id, scope);
  const intent = repo.getIntent(trip.id)!;
  repo.saveScope(trip.id, {
    ...intent.scope!,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });
  return { tripId: trip.id };
}

function goOpen(): void {
  for (const [key, value] of Object.entries(OPEN_STACK)) process.env[key] = value;
}

/** Back to the deterministic stack, so a test may finish a build without a network. */
function goFixture(): void {
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
}

/** Every job the queue handed to a process, in the order it handed them over. */
function recorder(): { calls: { tripId: string; jobId: string }[]; dispatch: (input: { tripId: string; jobId: string }) => void } {
  const calls: { tripId: string; jobId: string }[] = [];
  return { calls, dispatch: (input) => void calls.push(input) };
}

/**
 * A build that holds the deployment's one slot, without spending anything.
 *
 * Started under the fixture stack deliberately: a fixture build costs nothing
 * and is never gated, so this seeds an *occupied slot* without asserting
 * anything about the gate the tests below are actually about.
 */
async function occupyTheSlot(tripId: string, now?: Date): Promise<string> {
  const { getTrip } = await import('../db/repository');
  const { startCompilation } = await import('./runner');
  const outcome = startCompilation(getTrip(tripId)!, now);
  expect(outcome.kind, 'the first build should have started').toBe('started');
  return outcome.kind === 'started' ? outcome.jobId : '';
}

describe('the build queue', () => {
  /**
   * The defect, stated as the behaviour that replaces it: a second traveller
   * arriving while the one slot is busy is *accepted and told where they are*,
   * not turned away. Nothing is silently dropped either — there is a row, with
   * a place in line, that survives a refresh.
   */
  it('queues a second trip’s build instead of refusing it while the one slot is busy', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const repo = await import('../db/compiler-repository');

    await occupyTheSlot(first);

    goOpen();
    const outcome = startCompilation(getTrip(second)!);
    expect(outcome.kind, 'a contested press was refused rather than queued').toBe('queued');
    if (outcome.kind !== 'queued') return;
    expect(outcome.position).toBe(1);

    const parked = repo.getActiveJob(second);
    expect(parked, 'a queued build must be a row, not a promise').not.toBeNull();
    expect(parked!.state).toBe('queued');
    expect(parked!.waitingSince, 'nothing has been dispatched for a parked job').toBeDefined();
    expect(repo.queuePositionFor(parked!.id)).toBe(1);
    // And it is not counted as running: a parked job must not be its own
    // backpressure, or the queue could never drain.
    expect(repo.occupiedCompilationSlots(new Date())).toBe(1);
  });

  /**
   * Capacity is freed by a build *finishing*, through the real completion path
   * — `runCompilation` into `completeJob` — rather than by a state written by
   * hand. A fixture build is a real build; it lands terminal in a second and
   * costs nothing.
   */
  it('starts the queued build when the one ahead of it completes', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation, runCompilation } = await import('./runner');
    const { pumpCompilationQueue } = await import('./queue');
    const { isTerminal } = await import('@sidequest/core');
    const repo = await import('../db/compiler-repository');

    const firstJob = await occupyTheSlot(first);

    goOpen();
    const queued = startCompilation(getTrip(second)!);
    expect(queued.kind).toBe('queued');

    goFixture();
    await runCompilation({ trip: getTrip(first)!, jobId: firstJob });
    expect(isTerminal(repo.getJob(firstJob)!.state), 'the build ahead did not finish').toBe(true);

    const { calls, dispatch } = recorder();
    expect(pumpCompilationQueue(new Date(), dispatch)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tripId).toBe(second);
    expect(repo.getActiveJob(second)!.waitingSince, 'an admitted job is no longer parked').toBeUndefined();
  });

  /** The same rule for the unhappy ending: a failure frees the slot it held. */
  it('starts the queued build when the one ahead of it fails', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { pumpCompilationQueue } = await import('./queue');
    const repo = await import('../db/compiler-repository');

    const firstJob = await occupyTheSlot(first);
    goOpen();
    expect(startCompilation(getTrip(second)!).kind).toBe('queued');

    repo.failJob({
      jobId: firstJob,
      code: 'provider_unavailable',
      detail: 'One of our sources did not answer.',
      now: new Date(),
    });

    const { calls, dispatch } = recorder();
    expect(pumpCompilationQueue(new Date(), dispatch)).toBe(1);
    expect(calls[0]!.tripId).toBe(second);
  });

  /**
   * And for the one the traveller chooses. `requestCancel` flips the row
   * terminal in the same call, so the slot is free from that write rather than
   * from whenever the worker notices — which is what makes the person behind
   * them start now rather than five minutes from now.
   */
  it('starts the queued build when the one ahead of it is cancelled', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { pumpCompilationQueue } = await import('./queue');
    const repo = await import('../db/compiler-repository');

    await occupyTheSlot(first);
    goOpen();
    expect(startCompilation(getTrip(second)!).kind).toBe('queued');

    repo.requestCancel(first);

    const { calls, dispatch } = recorder();
    expect(pumpCompilationQueue(new Date(), dispatch)).toBe(1);
    expect(calls[0]!.tripId).toBe(second);
  });

  /**
   * A QUEUE IS EXACTLY WHERE A DUPLICATE REQUEST WOULD BE FREE TO HIDE.
   *
   * The unique partial index spans `('queued','running')` and a parked job is
   * `queued`, so a second press, a second tab or a direct POST lands on the row
   * that is already in line rather than taking a second place in it — and the
   * traveller is shown the thing that is already happening.
   */
  it('deduplicates a second press for a trip that is already waiting onto its job', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const repo = await import('../db/compiler-repository');

    await occupyTheSlot(first);
    goOpen();
    const queued = startCompilation(getTrip(second)!);
    expect(queued.kind).toBe('queued');
    const jobId = queued.kind === 'queued' ? queued.jobId : '';

    const again = startCompilation(getTrip(second)!);
    expect(again.kind, 'a second press took a second place in line').toBe('already_running');
    expect(again.kind === 'already_running' ? again.jobId : '').toBe(jobId);
    expect(repo.queuedCompilationDepth(), 'one traveller, one place').toBe(1);
  });

  /**
   * And the same for a build that is already *running*: pressing again adopts
   * it rather than joining a queue behind a build for this very trip.
   */
  it('deduplicates a second press for a trip whose build is already running', async () => {
    const { tripId } = await seededConfirmedTrip('Harbour City');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const repo = await import('../db/compiler-repository');

    goOpen();
    const first = startCompilation(getTrip(tripId)!);
    expect(first.kind).toBe('started');

    const again = startCompilation(getTrip(tripId)!);
    expect(again.kind).toBe('already_running');
    expect(again.kind === 'already_running' ? again.jobId : '').toBe(
      first.kind === 'started' ? first.jobId : '',
    );
    expect(repo.queuedCompilationDepth()).toBe(0);
  });

  /**
   * THE BOUND, AND THE HONESTY OF THE REFUSAL PAST IT.
   *
   * A queue with no bound is a refusal with the refusal hidden. Past the depth
   * the traveller is told the truth — the queue is full, nothing was lost, and
   * what to do — and no row is written, so nobody is holding a place they were
   * never given.
   */
  it('bounds the queue, and refuses honestly beyond it', async () => {
    const { tripId: running } = await seededConfirmedTrip('Harbour City');
    const waiting = [
      (await seededConfirmedTrip('Old Harbour')).tripId,
      (await seededConfirmedTrip('Outer Isles')).tripId,
      (await seededConfirmedTrip('Two Rivers')).tripId,
    ];
    const { tripId: overflow } = await seededConfirmedTrip('Thin Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const repo = await import('../db/compiler-repository');

    await occupyTheSlot(running);
    goOpen();
    waiting.forEach((tripId, index) => {
      const outcome = startCompilation(getTrip(tripId)!);
      expect(outcome.kind).toBe('queued');
      expect(outcome.kind === 'queued' ? outcome.position : 0).toBe(index + 1);
    });
    expect(repo.queuedCompilationDepth()).toBe(3);

    const refused = startCompilation(getTrip(overflow)!);
    expect(refused.kind, 'the queue took a fourth place it cannot honour').toBe('blocked');
    if (refused.kind !== 'blocked') return;
    // Retryable, and worded as backpressure rather than as the daily ceiling's
    // "come back tomorrow" — this clears in minutes.
    expect(refused.code).toBe('provider_rate_limited');
    expect(refused.message).toContain('saved');
    expect(refused.message).toMatch(/several minutes/);
    expect(refused.message).not.toContain('tomorrow');
    expect(refused.message).not.toMatch(/SIDEQUEST_/);
    // Refused, not silently dropped, and not half-accepted: no row was written,
    // so this trip can press again the moment the line moves.
    expect(repo.getActiveJob(overflow)).toBeNull();
    expect(repo.queuedCompilationDepth()).toBe(3);
  });

  /**
   * A SLOT HELD BY A CORPSE IS THE QUEUE'S WORST FAILURE MODE.
   *
   * The build ahead stops writing its heartbeat — its machine went away. The
   * queue must not wait for it, and the reclaim that ends it is the *existing*
   * one, extended to sweep the deployment rather than only the trip whose page
   * somebody happens to have open. The traveller whose worker died is precisely
   * the one who will not be reloading it.
   *
   * The second half matters as much: the parked job's own heartbeat is equally
   * cold, and it must survive, because a job nobody dispatched has no process to
   * have died. Reclaiming those would fail every queued traveller five minutes
   * into a wait for a build that legitimately runs twelve.
   */
  it('releases a slot held by a build whose heartbeat has gone cold', async () => {
    const { HEARTBEAT_TIMEOUT_MS } = await import('@sidequest/core');
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { pumpCompilationQueue } = await import('./queue');
    const repo = await import('../db/compiler-repository');

    const now = new Date();
    const firstJob = await occupyTheSlot(first, now);
    goOpen();
    expect(startCompilation(getTrip(second)!, now).kind).toBe('queued');

    const later = new Date(now.getTime() + HEARTBEAT_TIMEOUT_MS + 1_000);
    const { calls, dispatch } = recorder();
    expect(pumpCompilationQueue(later, dispatch)).toBe(1);

    expect(repo.getJob(firstJob)!.state, 'a silent build kept its slot').toBe('failed');
    expect(repo.getJob(firstJob)!.errorCode).toBe('compilation_interrupted');
    expect(calls[0]!.tripId).toBe(second);
    expect(repo.getActiveJob(second)!.state).toBe('queued');
    expect(repo.getActiveJob(second)!.waitingSince).toBeUndefined();
  });

  /**
   * A place in line nobody ever came back for.
   *
   * The heartbeat cannot end this — a parked job has no process to keep one —
   * so the wait ceiling does, and the verdict says what actually happened
   * rather than borrowing the sentence for a source that throttled us.
   */
  it('gives up a place in line nobody came back for, and says so honestly', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { pumpCompilationQueue } = await import('./queue');
    const { queueWaitCeilingMs } = await import('./limits');
    const { compilationVerdict, QUEUE_WAIT_DETAIL_PREFIX } = await import('./verdict');
    const repo = await import('../db/compiler-repository');

    const now = new Date();
    await occupyTheSlot(first, now);
    goOpen();
    expect(startCompilation(getTrip(second)!, now).kind).toBe('queued');

    const far = new Date(now.getTime() + queueWaitCeilingMs() + 1_000);
    const { calls, dispatch } = recorder();
    pumpCompilationQueue(far, dispatch);

    const job = repo.getLatestJob(second)!;
    expect(job.state, 'a forgotten place in line was held for ever').toBe('failed');
    expect(job.errorDetail).toContain(QUEUE_WAIT_DETAIL_PREFIX);
    expect(calls, 'an expired place must not then be dispatched').toHaveLength(0);

    const verdict = compilationVerdict({
      errorCode: job.errorCode!,
      errorDetail: job.errorDetail,
      stages: job.stages,
    });
    expect(verdict.retryable).toBe(true);
    expect(verdict.message).toContain('never started');
    expect(verdict.message).not.toContain('source');
  });

  /**
   * ONE JOB, ONE PROCESS, HOWEVER MANY PUMPS RACE FOR IT.
   *
   * The pump runs from every snapshot poll, every build press and every worker
   * exit, so two callers reaching the same head of the queue within the same
   * second is the expected case rather than the exotic one. Admission is a
   * guarded UPDATE: exactly one caller wins, and the loser dispatches nothing.
   */
  it('admits a queued job exactly once, however many callers reach it', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const repo = await import('../db/compiler-repository');

    await occupyTheSlot(first);
    goOpen();
    const queued = startCompilation(getTrip(second)!);
    const jobId = queued.kind === 'queued' ? queued.jobId : '';

    const now = new Date();
    expect(repo.admitQueuedCompilation(jobId, now)).toBe(true);
    expect(repo.admitQueuedCompilation(jobId, now), 'two workers for one job').toBe(false);
  });

  /**
   * TWO TRIPS, TWO BUILDS, NOTHING SHARED BUT THE SLOT.
   *
   * Concurrency bugs in a per-trip system show up as one traveller's state
   * appearing on another's screen. Every fact the queue holds is asserted here
   * against the trip it belongs to, before and after the line moves.
   */
  it('never lets one trip’s queued build become another trip’s', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { pumpCompilationQueue } = await import('./queue');
    const repo = await import('../db/compiler-repository');

    const firstJob = await occupyTheSlot(first);
    goOpen();
    const queued = startCompilation(getTrip(second)!);
    const secondJob = queued.kind === 'queued' ? queued.jobId : '';

    expect(secondJob).not.toBe(firstJob);
    expect(repo.getJob(firstJob)!.tripId).toBe(first);
    expect(repo.getJob(secondJob)!.tripId).toBe(second);
    // Waiting is a property of one job, not of the deployment: the running one
    // is not parked and the parked one is not running.
    expect(repo.getJob(firstJob)!.waitingSince).toBeUndefined();
    expect(repo.getJob(secondJob)!.waitingSince).toBeDefined();
    expect(repo.queuePositionFor(firstJob), 'a running build is not in a queue').toBeNull();
    expect(repo.queuePositionFor(secondJob)).toBe(1);
    expect(repo.getActiveJob(first)!.id).toBe(firstJob);
    expect(repo.getActiveJob(second)!.id).toBe(secondJob);

    repo.requestCancel(first);
    const { calls, dispatch } = recorder();
    pumpCompilationQueue(new Date(), dispatch);

    // The line moved, and it moved the right trip's job.
    expect(calls).toEqual([{ tripId: second, jobId: secondJob }]);
    expect(repo.getJob(firstJob)!.state).toBe('cancelled');
    expect(repo.getJob(firstJob)!.tripId).toBe(first);
    expect(repo.getJob(secondJob)!.state).toBe('queued');
    expect(repo.getJob(secondJob)!.tripId).toBe(second);
    expect(repo.getLatestJob(first)!.id).toBe(firstJob);
    expect(repo.getLatestJob(second)!.id).toBe(secondJob);
  });

  /**
   * The operator's escape hatch still works, and it is the one that raises
   * *concurrency* rather than spend: an operator on self-hosted endpoints who
   * sets it never meets the queue at all.
   */
  it('does not queue at all when the operator has raised the concurrency bound', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const repo = await import('../db/compiler-repository');

    goOpen();
    process.env.SIDEQUEST_MAX_CONCURRENT_COMPILATIONS = '2';
    expect(startCompilation(getTrip(first)!).kind).toBe('started');
    expect(startCompilation(getTrip(second)!).kind).toBe('started');
    expect(repo.queuedCompilationDepth()).toBe(0);
  });

  /**
   * THE QUEUE DEFERS SPEND; IT DOES NOT CREATE ANY.
   *
   * A queued build books its one live compilation on the day's ledger at the
   * moment the traveller is given a place, exactly as a dispatched one does.
   * Booking it on dispatch instead would let a full queue quietly overrun the
   * ceiling between the press and the slot — a ceiling discovered by crossing
   * it is not a ceiling.
   */
  it('reserves a queued build on the day’s ledger when it joins the line', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const { dailySpendSoFar } = await import('./daily-ceiling');

    await occupyTheSlot(first);
    goOpen();
    expect(startCompilation(getTrip(second)!).kind).toBe('queued');
    expect(dailySpendSoFar('live_compilations')).toBe(1);
  });

  /**
   * And the ledger still bites in front of the queue: a day that is spent must
   * not hand out places in a line for builds it will refuse to run.
   */
  it('refuses at the day’s ceiling rather than offering a place in the queue', async () => {
    const { tripId: first } = await seededConfirmedTrip('Harbour City');
    const { tripId: second } = await seededConfirmedTrip('Old Harbour');
    const { getTrip } = await import('../db/repository');
    const { startCompilation } = await import('./runner');
    const repo = await import('../db/compiler-repository');

    await occupyTheSlot(first);
    goOpen();
    process.env.SIDEQUEST_DAILY_LIVE_COMPILATIONS = '0';
    const outcome = startCompilation(getTrip(second)!);
    expect(outcome.kind).toBe('blocked');
    expect(outcome.kind === 'blocked' ? outcome.code : '').toBe('budget_exhausted');
    expect(repo.queuedCompilationDepth()).toBe(0);
  });
});
