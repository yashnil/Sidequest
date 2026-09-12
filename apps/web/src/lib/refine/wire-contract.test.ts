import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { tripDraftSchema, type TripDraft } from '../planning/trip-draft';
import { applyTripPatch, patchReach, tripPatchSchema } from './patch';
import { REFINEMENT_INSTRUCTION } from './interpreter';
import { REFINEMENT_INTENTS, clarifyingQuestionSchema } from './state';
import { describeRefinementRefusal, normalizeRefinementWire } from './wire-normalize';

/**
 * V9.1 §1 — THE REFINEMENT CONTRACT, VERIFIED OFFLINE BEFORE ANOTHER CALL.
 *
 * A live structural call answered in 19.8 s, stopped of its own accord, and
 * was refused by the schema. The raw body was not persisted anywhere — the run
 * row, the checkpoints and the server log hold only the traveller sentence —
 * so the exact value it produced is unrecoverable and nothing here pretends
 * otherwise. What *is* recoverable is why any such refusal is possible, and
 * that is the first test below.
 */
const wireSchema = z.object({
  intent: z.enum(REFINEMENT_INTENTS),
  namedDays: z.array(z.number()).optional(),
  namedBases: z.array(z.string()).optional(),
  explanation: z.string().optional(),
  needsClarification: clarifyingQuestionSchema.optional(),
  patch: tripPatchSchema.partial({ version: true }).optional(),
});

const FIXTURE = join(__dirname, '..', 'planning', 'acceptance', 'fixtures', 'iceland', 'live-v9-draft.json');
const draft: TripDraft = tripDraftSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
/* Captured once, before any test runs, so "unmutated" is measured against the original bytes. */
const pristine = JSON.stringify(draft);

describe('what the provider actually enforces', () => {
  /*
   * The finding that explains the live refusal, whatever its exact value was:
   * `zodOutputFormat`'s converter writes every constraint into a `description`
   * string instead of compiling it into the grammar. The model is therefore
   * free to return any string for `intent`, any string for `op`, and prose of
   * any length — and zod, running afterwards, throws the whole answer away.
   */
  it('compiles no enum, no const and no maxLength into the grammar — only shape and type', () => {
    const grammar = JSON.stringify(zodOutputFormat(wireSchema).schema);
    expect(grammar).not.toMatch(/"enum"\s*:/);
    expect(grammar).not.toMatch(/"const"\s*:/);
    expect(grammar).not.toMatch(/"maxLength"\s*:/);
    /* The vocabulary travels as prose inside the field's description, which binds nothing. */
    const intent = (zodOutputFormat(wireSchema).schema as { properties: { intent: { type: string; description?: string } } }).properties.intent;
    expect(intent.type).toBe('string');
    expect(intent.description ?? '').toContain('preserve_x_change_y');
  });

  /* Which is why the contract itself has to say it, in the prompt the model reads. */
  it('names every legal intent in the output contract the model is given', () => {
    for (const intent of REFINEMENT_INTENTS) expect(REFINEMENT_INSTRUCTION).toContain(intent);
    expect(REFINEMENT_INSTRUCTION).toMatch(/intent, exactly one of:/);
    expect(REFINEMENT_INTENTS).toHaveLength(19);
  });
});

describe('every legal intent, end to end', () => {
  /*
   * The same minimal structural answer under each of the nineteen legal
   * intents, carried the whole way: parse → schema validation → patch
   * application → blast radius → persistence shape → reload → undo. A
   * vocabulary is only honestly "legal" if every member of it survives the
   * path the wire promises.
   */
  const patch = { operations: [{ op: 'restructure', stays: [{ id: 'hofn-area', nights: 0 }, { id: 'vik', nights: 4 }], why: 'One hotel change fewer.' }] };

  it.each(REFINEMENT_INTENTS)('%s parses, validates, applies, reaches, persists, reloads and undoes', (intent) => {
    const answer = { intent, patch };

    /* Parse and validate. */
    const parsed = wireSchema.safeParse(answer);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.intent).toBe(intent);

    /* Apply. */
    const validated = tripPatchSchema.parse(parsed.data.patch);
    const applied = applyTripPatch({ draft, patch: validated });
    expect(applied.ok).toBe(true);
    expect(applied.refused).toEqual([]);
    expect(applied.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(9);
    expect(applied.draft.days.reduce((n, d) => n + d.anchors.length, 0)).toBe(22);

    /* Blast radius. */
    const reach = patchReach(validated, draft);
    expect(reach.bases).toEqual(['hofn-area', 'vik']);
    expect(reach.days.length).toBeGreaterThan(0);

    /* Persistence shape and reload: the applied draft is itself a valid stored draft, unchanged by the round trip. */
    const round = tripDraftSchema.parse(JSON.parse(JSON.stringify(applied.draft)));
    expect(JSON.stringify(round)).toBe(JSON.stringify(applied.draft));

    /*
     * What undo depends on: applying a patch never mutates the draft it was
     * given, so the prior version is still byte-identical afterwards and can be
     * written back as it stands. (The persisted version store and its restore
     * are exercised against the database in `refine.test.ts` §46.)
     */
    expect(JSON.stringify(draft)).toBe(pristine);
    expect(applied.draft).not.toBe(draft);
  });
});

describe('an illegal intent', () => {
  /*
   * §1 — a semantically sensible word outside the vocabulary must be refused
   * with something a reviewer can act on. This is the shape the live failure
   * most plausibly took, and the one the old path answered with "a shape the
   * schema refused" and nothing else.
   */
  it('is rejected, and the refusal names the field and every value that would have been taken', () => {
    const answer = { intent: 'reduce_hotel_changes', patch: { operations: [] } };
    const parsed = wireSchema.safeParse(answer);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
    expect(issues[0]?.path).toBe('intent');
    const said = describeRefinementRefusal(issues);
    expect(said).toContain('"intent"');
    for (const intent of REFINEMENT_INTENTS) expect(said).toContain(intent);
    /* And it repeats nothing the model wrote. */
    expect(said).not.toContain('reduce_hotel_changes');
  });

  it('is never repaired into a legal one: an enum is a hard field', () => {
    const answer = { intent: 'reduce_hotel_changes', patch: { operations: [] } };
    const { value, normalizedFields } = normalizeRefinementWire(wireSchema, answer);
    expect(normalizedFields).toEqual([]);
    expect(value).toEqual(answer);
    expect(wireSchema.safeParse(value).success).toBe(false);
  });
});

describe('the deterministic repair', () => {
  it('clips a soft prose field that is purely over its cap, and says which', () => {
    const long = 'x'.repeat(400);
    const answer = { intent: 'change_route' as const, patch: { operations: [{ op: 'restructure', stays: [{ id: 'vik', nights: 4 }], why: long }] } };
    expect(wireSchema.safeParse(answer).success).toBe(false);
    const { value, normalizedFields } = normalizeRefinementWire(wireSchema, answer);
    expect(normalizedFields).toEqual(['patch.operations.0.why']);
    const after = wireSchema.safeParse(value);
    expect(after.success).toBe(true);
    /* Clipped to the cap the schema itself reported, never to a number written here. */
    if (after.success) expect((after.data.patch?.operations[0] as { why: string }).why.length).toBe(200);
  });

  it('leaves an answer that already parses exactly as it arrived', () => {
    const answer = { intent: 'change_route' as const, patch: { operations: [{ op: 'restructure', stays: [{ id: 'vik', nights: 4 }], why: 'Short.' }] } };
    const { value, normalizedFields } = normalizeRefinementWire(wireSchema, answer);
    expect(normalizedFields).toEqual([]);
    expect(value).toBe(answer);
  });

  it('never touches a hard field, however cosmetic the overrun looks', () => {
    /* A base name is a label the plan is keyed on; a too-long one is a real defect. */
    const answer = {
      intent: 'change_base' as const,
      patch: { operations: [{ op: 'replace_base', id: 'vik', name: 'y'.repeat(200), nights: 4, why: 'ok' }] },
    };
    const { value, normalizedFields } = normalizeRefinementWire(wireSchema, answer);
    expect(normalizedFields).toEqual([]);
    expect(wireSchema.safeParse(value).success).toBe(false);
  });

  it('never touches a clarifying question, whose options are choices put to the traveller', () => {
    const answer = {
      intent: 'change_route' as const,
      needsClarification: { question: 'q'.repeat(400), options: ['a', 'b'], because: 'r'.repeat(400) },
    };
    const { normalizedFields } = normalizeRefinementWire(wireSchema, answer);
    expect(normalizedFields).toEqual([]);
  });
});
