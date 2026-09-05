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
  expect(wire.bytes).toBeLessThan(GRAMMAR_MODE_LIMITS.bytes);
  expect(wire.unsupportedKeywords).toEqual([]);
});

it('the mode is decided locally from the measured profile, once, and matches the guard', () => {
  const decision = compositionWireDecision();
  const verdict = grammarModeSuitable(decision.profile);
  expect(decision.enforcement).toBe(verdict.suitable ? 'grammar' : 'prompt');
  expect(decision.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(compositionWireDecision()).toBe(decision);
  // The wire schema still has more object-typed arrays (stays, days, activities, omissions, backups) than the guard
  // allows for grammar compilation, so today's answer is the prompt path — and a change to that is a deliberate one.
  expect(decision.enforcement).toBe('prompt');
  expect(decision.reasons.length).toBeGreaterThan(0);
});
