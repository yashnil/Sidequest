import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyComposerAnswers, parseTravelRequest } from '@sidequest/core';


/* These load the real atlas artifact; the budget is for a loaded machine, not a performance claim. */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The advisor's one outward call — checking the picks against live climate
 * records — under failure. A provider that errors, hangs or is switched off
 * changes what a card says about its weather and nothing else: the list is
 * the atlas's, and it is returned.
 */
const NOW = new Date('2026-11-08T12:00:00Z');
const climate = vi.hoisted(() => ({ mode: 'error' as 'error' | 'hang' | 'empty' }));

vi.mock('./preflight', () => ({
  climateWithReason: vi.fn(async () => {
    if (climate.mode === 'error') throw new Error('archive unreachable');
    if (climate.mode === 'hang') return new Promise(() => undefined);
    return { profile: null, reason: 'provider_unavailable' };
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function advise(text: string) {
  const { adviseFor } = await import('./advisor');
  const { advisorWorld } = await import('../atlas/world');
  const base = { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month' as const, wantsRecommendation: false } };
  const { answers } = parseTravelRequest(text, base, NOW, advisorWorld().atlas ?? undefined);
  return adviseFor(answers, NOW, null);
}

describe('adviseFor when the climate archive fails', () => {
  it('returns the same list and marks the weather unchecked when the provider errors', async () => {
    climate.mode = 'error';
    const shortlist = await advise('Remote hiking in Central Asia in August, far from crowds.');
    expect(shortlist.picks.length).toBe(3);
    expect(shortlist.stats.climateChecked).toBe(0);
    for (const pick of [...shortlist.picks, ...shortlist.alternates]) expect(pick.climate.status).toBe('unavailable');
    expect(shortlist.stats.catalog).toBeGreaterThan(30_000);
  });

  it('does not wait past its deadline for a provider that never answers', async () => {
    climate.mode = 'hang';
    vi.useFakeTimers();
    const pending = advise('Volcanoes and beaches in Hawaii for ten days in February.');
    await vi.advanceTimersByTimeAsync(9_500);
    const shortlist = await pending;
    expect(shortlist.picks.length).toBe(3);
    for (const pick of shortlist.picks) expect(pick.climate.status).toBe('unavailable');
  });

  it('makes no climate call at all when the provider is switched off', async () => {
    climate.mode = 'error';
    vi.stubEnv('SIDEQUEST_CLIMATE_PROVIDER', 'off');
    const { climateWithReason } = await import('./preflight');
    vi.mocked(climateWithReason).mockClear();
    const shortlist = await advise('Tea plantations, misty hills and train rides, in February.');
    expect(shortlist.picks.length).toBe(3);
    expect(climateWithReason).not.toHaveBeenCalled();
    for (const pick of shortlist.picks) expect(pick.climate.status).toBe('not_checked');
  });
});
