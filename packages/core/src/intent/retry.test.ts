import { describe, expect, it } from 'vitest';
import { canOfferModelPass, canRetryModelPass, recordModelPass } from './fallback';
import { classifyPreferences } from './classify';
import { MODEL_FALLBACK_OUTCOMES, type ModelFallbackOutcome } from '../schemas/interpretation';

/**
 * A READER THAT DID NOT ANSWER MUST STAY ANSWERABLE.
 *
 * The audit's finding: "The reader did not answer" was a terminal screen. The
 * outcome sentence rendered once, the button was gone — `canOfferModelPass` is
 * false the moment *any* pass is recorded — and the traveller's avoidances
 * stayed unmodelled with no way to try again. A provider having an afternoon
 * became a permanent property of the trip.
 *
 * `canRetryModelPass` is the other half of the pair: true exactly when a pass
 * exists, failed for provider reasons, and the text is still eligible. Every
 * other outcome stays terminal — re-asking about an unusable answer or a spent
 * budget is how a button becomes a bill.
 */

const RETRYABLE: ModelFallbackOutcome[] = ['provider_unavailable'];

function withOutcome(outcome: ModelFallbackOutcome) {
  const set = classifyPreferences({
    mustDo: 'somewhere we can potter about with no fixed plan',
  });
  return recordModelPass({
    set,
    outcome,
    attemptedAt: '2026-08-11T00:00:00Z',
    promptVersion: 'test/1',
    modelId: 'offline',
    spansOffered: 1,
    calls: outcome === 'provider_unavailable' || outcome === 'invalid_response' ? 1 : 0,
  });
}

describe('retrying the bounded reader', () => {
  it('offers a retry after the provider did not answer', () => {
    const after = withOutcome('provider_unavailable');
    expect(canOfferModelPass(after)).toBe(false);
    expect(canRetryModelPass(after)).toBe(true);
  });

  it('stays terminal for every other outcome', () => {
    for (const outcome of MODEL_FALLBACK_OUTCOMES) {
      if (RETRYABLE.includes(outcome)) continue;
      expect(canRetryModelPass(withOutcome(outcome)), outcome).toBe(false);
    }
  });

  it('never retries a confirmed interpretation', () => {
    const after = { ...withOutcome('provider_unavailable'), confirmedAt: '2026-08-11T01:00:00Z' };
    expect(canRetryModelPass(after)).toBe(false);
  });

  it('is mutually exclusive with the first offer', () => {
    const fresh = classifyPreferences({
      mustDo: 'somewhere we can potter about with no fixed plan',
    });
    expect(canOfferModelPass(fresh)).toBe(true);
    expect(canRetryModelPass(fresh)).toBe(false);
  });
});
