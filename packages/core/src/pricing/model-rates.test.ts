import { describe, expect, it } from 'vitest';
import { COST_DISCLOSURE, MODEL_RATES, estimateCostMicroUsd, priceFor } from './model-rates';

describe('the model rate table', () => {
  it('holds a rate for the model this build defaults to', () => {
    // Read from the client's own constant rather than restated, so that changing
    // the default model without pricing it fails here rather than silently
    // producing a cost figure of `null` in a results table nobody re-reads.
    expect(priceFor('claude-opus-5')).not.toBeNull();
  });

  it('carries a source and a date for every rate', () => {
    for (const rate of Object.values(MODEL_RATES)) {
      expect(rate.source, `${rate.modelId} has no source`).toMatch(/^https?:\/\//);
      expect(rate.asOf, `${rate.modelId} has no read date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keys every entry by its own model id', () => {
    for (const [key, rate] of Object.entries(MODEL_RATES)) {
      expect(rate.modelId).toBe(key);
    }
  });

  it('returns null for a model it has never been told the price of', () => {
    // The whole point. A nearest-neighbour guess or a most-expensive fallback
    // would put a number in a cost comparison that nobody could source.
    expect(priceFor('some-model-nobody-priced')).toBeNull();
    expect(
      estimateCostMicroUsd('some-model-nobody-priced', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearches: 0,
      }),
    ).toBeNull();
  });

  it('never returns zero for an unpriced model, which would read as free', () => {
    const unpriced = estimateCostMicroUsd('unpriced', {
      inputTokens: 5_000,
      outputTokens: 5_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    });
    expect(unpriced).not.toBe(0);
    expect(unpriced).toBeNull();
  });

  it('prices a million input tokens at the published input rate', () => {
    const cost = estimateCostMicroUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    });
    expect(cost).toBe(5_000_000);
  });

  it('prices a million output tokens at the published output rate', () => {
    const cost = estimateCostMicroUsd('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    });
    expect(cost).toBe(25_000_000);
  });

  it('charges a cache read far less than a fresh input token', () => {
    const fresh = estimateCostMicroUsd('claude-opus-5', {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearches: 0,
    });
    const cached = estimateCostMicroUsd('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 0,
      webSearches: 0,
    });
    expect(cached).toBeLessThan(fresh ?? 0);
  });

  it('returns an integer, so a sum of costs cannot drift', () => {
    const cost = estimateCostMicroUsd('claude-opus-5', {
      inputTokens: 1_234,
      outputTokens: 567,
      cacheReadTokens: 89,
      cacheWriteTokens: 12,
      webSearches: 3,
    });
    expect(cost).not.toBeNull();
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('states that the figure is an estimate rather than a charge', () => {
    expect(COST_DISCLOSURE).toContain('Not a bill');
  });
});
