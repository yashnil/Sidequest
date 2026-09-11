import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftOf } from './acceptance/harness';

/**
 * V8 — THE BUILD/RETRY STATE MACHINE, AS THE PRODUCTION SESSION EXERCISED IT.
 *
 * `.claude-private/V8-BUILD-FAILURE.md`: a Build request died on the wire, the
 * server kept composing and spent the call, "Try again" remounted the interview
 * and overwrote the answers, and a second Build was pressed on a stale review.
 * These tests pin the invariants that make that sequence impossible:
 *
 * - one key, one run: a duplicate press attaches, it never composes twice;
 * - a live run under another key is attached to, not replaced;
 * - a thrown generation lands on the row as a failure with a reference and a
 *   kind, never as an unhandled rejection;
 * - a run that failed after its draft was saved retries on the draft, with no
 *   model call; one that failed before composing composes again;
 * - a silent row goes `lost` after the stale window, and only then;
 * - a save presenting an old revision is refused rather than applied.
 *
 * The generation itself is faked: the thing under test is what happens around
 * it. `after()` has no request scope here and falls through to a detached run.
 */

const generate = vi.fn();
vi.mock('./production-plan', () => ({
  generateSidequestPlanForTrip: (...args: unknown[]) => generate(...args),
}));

describe('build runs', () => {
  let dir: string;
  function releaseDatabase(): void {
    const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
    holder.sidequestDb?.close();
    delete holder.sidequestDb;
  }
  beforeEach(() => {
    releaseDatabase();
    dir = mkdtempSync(join(tmpdir(), 'sq-build-runs-'));
    process.env.SIDEQUEST_DB_PATH = join(dir, 'runs.db');
    generate.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    releaseDatabase();
    delete process.env.SIDEQUEST_DB_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  async function trip() {
    const repo = await import('../db/repository');
    return repo.createTrip({ mode: 'known_destination', destinationInput: 'Kenya and Tanzania', regionId: 'dynamic', startDate: '2027-06-13', endDate: '2027-06-19', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [] });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('one key is one run: a duplicate press attaches and never composes twice', async () => {
    const t = await trip();
    const runs = await import('./build-runs');
    const progress = await import('../db/generation-progress-repository');
    let finish: (value: unknown) => void = () => undefined;
    generate.mockImplementation(async (tripId: string, options: { buildKey?: string }) => {
      progress.beginGeneration(tripId, new Date(), { buildKey: options.buildKey ?? null });
      progress.markGenerationStage(tripId, 'composing', new Date());
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = runs.startBuildRun({ tripId: t.id, buildKey: 'press-1-aaaaaaaa', caller: null });
    expect(first.started).toBe(true);
    expect(first.view.state).toBe('running');
    await settle();
    /* The same press, arriving again (a refresh, a retried request): attached, nothing started. */
    const again = runs.startBuildRun({ tripId: t.id, buildKey: 'press-1-aaaaaaaa', caller: null });
    expect(again.started).toBe(false);
    expect(again.view.state).toBe('running');
    /* A different press while the run is live: also attached — two presses seconds apart are one build. */
    const impatient = runs.startBuildRun({ tripId: t.id, buildKey: 'press-2-bbbbbbbb', caller: null });
    expect(impatient.started).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    /* The worker's own beginGeneration under the same key attached to the row rather than resetting it. */
    expect(progress.getGenerationProgress(t.id)?.stage).toBe('composing');
    finish({ ok: true });
    await settle();
    /* Still one composition. */
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('a thrown generation becomes a recorded failure with a reference and a kind', async () => {
    const t = await trip();
    const runs = await import('./build-runs');
    const progress = await import('../db/generation-progress-repository');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    generate.mockImplementation(async (tripId: string, options: { buildKey?: string }) => {
      progress.beginGeneration(tripId, new Date(), { buildKey: options.buildKey ?? null });
      progress.markGenerationModelInvoked(tripId, new Date());
      throw new Error('ZodError: bases[0].name expected string — with an Authorization header inside');
    });
    runs.startBuildRun({ tripId: t.id, buildKey: 'press-3-cccccccc', caller: null });
    await settle();
    const view = runs.buildRunView(t.id);
    expect(view.state).toBe('failed');
    if (view.state !== 'failed') throw new Error('unreachable');
    expect(view.failure?.kind).toBe('model_failed');
    expect(view.failure?.ref).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(view.failure?.modelInvoked).toBe(true);
    expect(view.failure?.draftSaved).toBe(false);
    /* One structured line, under the same reference the traveller sees. */
    const line = errors.mock.calls.find((call) => call[0] === 'Build failed');
    expect(line?.[1]).toMatchObject({ ref: view.failure?.ref, kind: 'model_failed', tripId: t.id });
    errors.mockRestore();
  });

  it('a run that fails after its draft was saved retries on the draft; one that failed before composing composes again', async () => {
    const t = await trip();
    const runs = await import('./build-runs');
    const progress = await import('../db/generation-progress-repository');
    const drafts = await import('../db/draft-repository');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    /* Failed before anything was composed. */
    generate.mockImplementationOnce(async (tripId: string, options: { buildKey?: string }) => {
      progress.beginGeneration(tripId, new Date(), { buildKey: options.buildKey ?? null });
      return { ok: false, error: 'No model credential is configured, so we cannot compose a first draft yet.' };
    });
    runs.startBuildRun({ tripId: t.id, buildKey: 'press-4-dddddddd', caller: null });
    await settle();
    let view = runs.buildRunView(t.id);
    expect(view.state).toBe('failed');
    expect(view.state === 'failed' && view.failure?.kind).toBe('before_model');
    expect(runs.retryPlanFor(view)).toEqual({ reuseStoredDraft: false });
    /* Retry composes; this time the draft lands and verification throws. */
    generate.mockImplementationOnce(async (tripId: string, options: { buildKey?: string; reuseStoredDraft?: boolean }) => {
      expect(options.reuseStoredDraft).toBeUndefined();
      progress.beginGeneration(tripId, new Date(), { buildKey: options.buildKey ?? null });
      progress.markGenerationModelInvoked(tripId, new Date());
      drafts.saveTripDraft({ tripId, draft: minimalDraft(), now: new Date() });
      progress.markGenerationDraftSaved(tripId, new Date());
      throw new Error('router exploded');
    });
    runs.startBuildRun({ tripId: t.id, buildKey: 'press-5-eeeeeeee', caller: null, ...runs.retryPlanFor(view) });
    await settle();
    view = runs.buildRunView(t.id);
    expect(view.state === 'failed' && view.failure?.kind).toBe('after_model');
    expect(runs.retryPlanFor(view)).toEqual({ reuseStoredDraft: true });
    /* And the retry of *that* run re-verifies the stored draft: no composition. */
    generate.mockImplementationOnce(async (tripId: string, options: { buildKey?: string; reuseStoredDraft?: boolean }) => {
      expect(options.reuseStoredDraft).toBe(true);
      progress.beginGeneration(tripId, new Date(), { buildKey: options.buildKey ?? null });
      progress.finishGeneration(tripId, 'ok', new Date());
      return { ok: true };
    });
    runs.startBuildRun({ tripId: t.id, buildKey: 'press-6-ffffffff', caller: null, ...runs.retryPlanFor(view) });
    await settle();
    expect(runs.buildRunView(t.id).state).toBe('succeeded');
    expect(generate).toHaveBeenCalledTimes(3);
    errors.mockRestore();
  });

  it('a silent row is lost only after the stale window, and a heartbeat keeps a long model call alive', async () => {
    const t = await trip();
    const progress = await import('../db/generation-progress-repository');
    const started = new Date('2026-09-11T08:06:50Z');
    progress.beginGeneration(t.id, started, { buildKey: 'press-7-gggggggg' });
    const row = () => progress.getGenerationProgress(t.id)!;
    expect(progress.buildRunStateOf(row(), new Date(started.getTime() + 30_000))).toBe('running');
    expect(progress.buildRunStateOf(row(), new Date(started.getTime() + progress.BUILD_STALE_MS + 1))).toBe('lost');
    progress.heartbeatGeneration(t.id, new Date(started.getTime() + 55_000));
    expect(progress.buildRunStateOf(row(), new Date(started.getTime() + 100_000))).toBe('running');
    /* A lost run is replaced by the next press, not attached to. */
    const runs = await import('./build-runs');
    generate.mockImplementation(async () => ({ ok: true }));
    const view = runs.buildRunView(t.id, new Date(started.getTime() + 200_000));
    expect(view.state).toBe('lost');
    const next = runs.startBuildRun({ tripId: t.id, buildKey: 'press-8-hhhhhhhh', caller: null }, new Date(started.getTime() + 200_000));
    expect(next.started).toBe(true);
  });

  it('a save presenting an old revision is refused, and the stored answers stand', async () => {
    const t = await trip();
    const repo = await import('../db/repository');
    const core = await import('@sidequest/core');
    const answers = core.defaultAnswers({ travelerNeeds: [], tripDays: 7, offeredInterests: [] });
    const first = repo.saveAnswers(t.id, { ...answers, interview: { mode: 'normal', asked: ['priorities'], decided: [], skipped: [], position: 'priorities' } } as never);
    expect(repo.answersRevision(t.id)).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = repo.saveAnswers(t.id, { ...answers, interview: { mode: 'normal', asked: ['priorities', 'effort'], decided: [], skipped: [], position: 'review' } } as never);
    expect(second).not.toBe(first);
    /* The action's guard: a client holding `first` is behind the row. */
    const actions = await import('@/app/(product)/trips/[id]/questionnaire/actions');
    const stale = await actions.saveDraftAction(t.id, answers, undefined, first);
    expect(stale.ok).toBe(false);
    expect(stale.stale).toBe(true);
    expect(repo.getAnswers(t.id)?.interview?.position).toBe('review');
    /* A client holding the current revision may write, and receives the next. */
    const fresh = await actions.saveDraftAction(t.id, { ...answers, interview: { mode: 'normal', asked: [], decided: [], skipped: [], position: 'effort' } } as never, undefined, second);
    expect(fresh.ok).toBe(true);
    expect(fresh.revision).toBe(repo.answersRevision(t.id));
    /* A client with no revision at all (a first visit) is never refused. */
    const nothing = await actions.saveDraftAction(t.id, answers);
    expect(nothing.ok).toBe(true);
  });
});


/** The smallest draft the harness builds: one base, one day, one anchor. */
function minimalDraft() {
  return draftOf({ bases: [{ id: 'b1', name: 'Nairobi', nights: 6 }], days: [{ base: 'b1', anchors: [{ name: 'Nairobi National Museum' }] }] });
}
