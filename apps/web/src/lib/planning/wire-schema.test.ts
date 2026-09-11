import { expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { compositionWireDecision } from './composition';
import { GRAMMAR_MODE_LIMITS, grammarModeSuitable, tripDraftWireSchema, wireSchemaProfile } from './trip-draft-wire';
import { tripDraftSchema } from './trip-draft';

/**
 * COMPOSITION RELIABILITY — the schema that goes over the wire is measured
 * here, and the guard decides the mode from those numbers before any paid
 * request. The live Tasmania refusal ("compiled grammar is too large") was
 * against the 8.7 kB canonical schema; the wire schema is well under half of
 * it, and whichever side of the guard it lands on is asserted, not hoped.
 */
const format = () => (zodOutputFormat(tripDraftWireSchema) as unknown as { schema: unknown }).schema;

it('the wire schema carries no keyword the provider refuses', () => {
  const text = JSON.stringify(format());
  for (const key of ['minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'multipleOf', 'format']) expect(text, key).not.toContain(`"${key}"`);
});

it('the wire schema is materially smaller than the canonical one', () => {
  const wire = wireSchemaProfile(format());
  const canonical = wireSchemaProfile((zodOutputFormat(tripDraftSchema) as unknown as { schema: unknown }).schema);
  expect(wire.bytes).toBeLessThan(canonical.bytes * 0.5);
  expect(wire.unsupportedKeywords).toEqual([]);
  /*
   * The grammar ceiling is kept honest here rather than asserted against this
   * schema: both refusals on record (8,706 bytes and 3,726) were larger than it,
   * and there is no successful compile to calibrate against. If this ever drops
   * below the ceiling the mode flips by itself and `wire-schema` says so.
   */
  expect(GRAMMAR_MODE_LIMITS.bytes).toBeLessThan(3_726);
});

it('the mode is decided locally from the measured profile, once, and matches the guard', () => {
  const decision = compositionWireDecision();
  const verdict = grammarModeSuitable(decision.profile);
  /*
   * LATENCY CLOSURE — the compact wire is grammar-eligible and the call is
   * pinned to prompt mode anyway.
   *
   * At 2,386 bytes the compact schema clears the 3,000-byte limit that refused
   * the 3,726-byte long wire live, so the guard now says "suitable". The pin is
   * deliberate and documented in `compositionWireDecision`: prompt mode's
   * throughput on this task is measured and constrained decoding's is not, and
   * this is a closure about latency with one live call to spend. The guard is
   * still exercised, and still decides if the pin is removed.
   */
  /* V7 — episodes, day moves and the food strategy pushed the schema past the grammar ceiling; the pin to prompt mode stands, and the guard says why. */
  expect(verdict.suitable, 'the V7 compact wire is deliberately past the grammar ceiling').toBe(false);
  expect(decision.enforcement).toBe('prompt');
  expect(decision.reasons.join(' ')).toMatch(/bytes >/);
  expect(decision.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(compositionWireDecision()).toBe(decision);
  /*
   * MVP V3 — prompt mode, and now for a *measured* reason rather than an
   * invented one.
   *
   * The guard used to carry three structural proxies (depth, property count,
   * arrays of objects) with no observation behind them. Removing them put this
   * schema into grammar mode, and the live run of 2026-09-08 got the provider's
   * answer: "The compiled grammar is too large" — at **3,726 bytes**, less than
   * half the 8,706-byte schema refused in September. The compiled grammar is not
   * the schema text, and for a draft made of arrays of objects with closed enums
   * it is far bigger.
   *
   * So the ceiling sits under the smaller refusal and this schema takes the
   * prompt path — which is now safe, because `json-repair.ts` mends the one slip
   * the model actually makes rather than discarding a paid answer. The exact
   * mode is asserted either way: a change to it should be a decision.
   */
  expect(decision.enforcement).toBe('prompt');
  expect(decision.reasons.length).toBeGreaterThan(0);
});
