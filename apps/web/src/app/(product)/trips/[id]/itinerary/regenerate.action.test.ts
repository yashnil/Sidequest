import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Repository from '@/lib/db/repository';

/**
 * V1 CONVERGENCE — REGENERATE IS A DURABLE RUN, NOT A TWO-MINUTE SERVER ACTION.
 *
 * The action may only record a run and return: the generation itself is
 * scheduled by `startBuildRun` and watched from `/trips/[id]/build`. A preflight
 * refusal comes back as its own sentence with nothing recorded and nothing
 * written, and the must-keep stops that are board places reach the board as
 * the traveller's includes before the run starts — never after a refusal.
 */
const calls = {
  startBuildRun: vi.fn(),
  setSelection: vi.fn(),
  generate: vi.fn(),
};
let preflightOk = true;
let running = false;

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    const error = new Error('NEXT_REDIRECT') as Error & { digest: string };
    error.digest = `NEXT_REDIRECT;replace;${href};307;`;
    throw error;
  },
}));
vi.mock('@/lib/net/trip-access', () => ({ tripAccessRefusal: async () => null }));
vi.mock('@/lib/net/caller', () => ({ guardAction: async () => null, callerKey: async () => 'test-caller' }));
vi.mock('@/lib/planning/production-plan', () => ({ generateSidequestPlanForTrip: calls.generate }));
vi.mock('@/lib/planning/build-runs', () => ({
  buildRunView: () => (running ? { state: 'running', buildKey: 'already-running-key' } : { state: 'none' }),
  startBuildRun: (input: unknown) => {
    calls.startBuildRun(input);
    return { started: true, view: { state: 'running' } };
  },
}));
vi.mock('@/lib/planning/build-preflight', () => ({
  buildPreflight: () => (preflightOk ? { ok: true } : { ok: false, failure: { cause: 'composer_unavailable', message: 'Sidequest cannot plan new trips right now. Your answers are saved.' }, operatorReason: 'test' }),
}));
vi.mock('@/lib/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof Repository>();
  return {
    ...actual,
    getTrip: () => ({ id: 'trip-1' }),
    getItinerary: () => ({
      days: [{ dayNumber: 1, items: [{ kind: 'activity', title: 'Old Fort', placeId: 'board-fort' }] }],
      package: { anchors: [{ id: 'a1', dayNumber: 1, name: 'Old Fort', placeId: 'board-fort', note: 'You marked this must-keep.' }] },
      diagnostics: { revisions: [] },
    }),
    getItineraryLocks: () => [],
    getSelections: () => [{ placeId: 'board-fort', status: 'included', source: 'auto', updatedAt: '2026-01-01' }],
    setSelection: (...args: unknown[]) => calls.setSelection(...args),
  };
});

beforeEach(() => {
  calls.startBuildRun.mockReset();
  calls.setSelection.mockReset();
  calls.generate.mockReset();
  preflightOk = true;
  running = false;
});

describe('Regenerate', () => {
  it('records a durable run under the press’s key and never awaits a generation', async () => {
    const { regenerateItineraryAction } = await import('./actions');
    const result = await regenerateItineraryAction('trip-1', 'press-key-12345');
    expect(result).toEqual({ ok: true, buildKey: 'press-key-12345' });
    expect(calls.startBuildRun).toHaveBeenCalledWith(expect.objectContaining({ tripId: 'trip-1', buildKey: 'press-key-12345', mode: 'full' }));
    expect(calls.generate).not.toHaveBeenCalled();
  });

  it('carries a must-keep board place as the traveller’s own include before the run starts', async () => {
    const { regenerateItineraryAction } = await import('./actions');
    await regenerateItineraryAction('trip-1', 'press-key-12345');
    expect(calls.setSelection).toHaveBeenCalledWith('trip-1', 'board-fort', 'included', 'user');
  });

  it('a preflight refusal is the failure’s own sentence, with no run and nothing written', async () => {
    preflightOk = false;
    const { regenerateItineraryAction } = await import('./actions');
    const result = await regenerateItineraryAction('trip-1', 'press-key-12345');
    expect(result).toEqual({ ok: false, error: 'Sidequest cannot plan new trips right now. Your answers are saved.' });
    expect(calls.startBuildRun).not.toHaveBeenCalled();
    expect(calls.setSelection).not.toHaveBeenCalled();
  });

  it('a run already under way is attached to, not doubled', async () => {
    running = true;
    const { regenerateItineraryAction } = await import('./actions');
    expect(await regenerateItineraryAction('trip-1', 'press-key-12345')).toEqual({ ok: true, buildKey: 'already-running-key' });
    expect(calls.startBuildRun).not.toHaveBeenCalled();
  });

  it('refuses a malformed key', async () => {
    const { regenerateItineraryAction } = await import('./actions');
    expect((await regenerateItineraryAction('trip-1', 'bad key!')).ok).toBe(false);
  });

  it('"Rebuild my trip" starts the same durable run and goes to the build screen', async () => {
    const { buildItineraryAction } = await import('./actions');
    await expect(buildItineraryAction('trip-1', 'press-key-67890')).rejects.toMatchObject({ digest: expect.stringContaining('/trips/trip-1/build') });
    expect(calls.startBuildRun).toHaveBeenCalledWith(expect.objectContaining({ buildKey: 'press-key-67890' }));
    expect(calls.generate).not.toHaveBeenCalled();
  });
});
