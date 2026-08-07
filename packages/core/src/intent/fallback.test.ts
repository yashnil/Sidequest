import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  cacheKeyForSpans,
  canOfferModelPass,
  clampModelStrength,
  deriveConfidence,
  interpretationCacheKey,
  mergeModelProposals,
  normalizeSpanForKey,
  recordModelPass,
  spansForModel,
  type UnresolvedSpan,
} from './fallback';
import { classifyPreferences } from './classify';
import { applyInterpretation } from './apply';
import {
  AVOIDANCES,
  BUDGET_STYLES,
  CROWD_TOLERANCES,
  DAY_STARTS,
  DISCOVERY_MIXES,
  INTERESTS,
  PACES,
} from '../schemas/common';
import {
  CONTROLLED_PREFERENCE_KEYS,
  INTERPRETATION_VERSION,
  LEXICON_VERSION,
  MODEL_INTERPRETATION_SCHEMA_VERSION,
  chipTargetForKey,
  keyForChipTarget,
  modelInterpretationResponseSchema,
  type InterpretationSet,
  type ModelInterpretationResponse,
} from '../schemas/interpretation';
import { LEXICON_LOCALE } from './phrases';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';

/**
 * THE BOUNDED FALLBACK, TESTED AT THE THREE PLACES IT COULD GO WRONG.
 *
 * **Whether the model is reached at all**, which is the difference between a
 * fallback and a dependency. **What it is allowed to say**, which is a property
 * of a schema rather than a prompt and is therefore something a test can hold.
 * **Whether anything it said changes a trip before somebody agreed**, which is
 * the promise the whole interpretation layer is built on.
 *
 * There is no network here and there is no model here — this package has no
 * client and never will. The provider-side call budget is asserted in
 * `apps/web/src/lib/providers/interpretation-model.test.ts` against a fake that
 * counts calls; what this file asserts is everything that decides whether that
 * call happens and what happens to its answer.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const CONTEXT = { travelerNeeds: [], tripDays: 5 };
const PROMPT_VERSION = 'interpret-preferences/2026-08-03.1';
const MODEL_ID = 'claude-opus-5';
const NOW = '2026-08-03T09:00:00Z';

/** A set with hand-placed unresolved spans, so a merge test controls its input. */
function setWith(
  entries: { text: string; field?: 'mustDo' | 'avoid' }[],
  chips: InterpretationSet['chips'] = [],
): InterpretationSet {
  let cursor = 0;
  return {
    schemaVersion: INTERPRETATION_VERSION,
    lexiconVersion: LEXICON_VERSION,
    lexiconLocale: LEXICON_LOCALE,
    chips,
    unresolved: entries.map((entry) => {
      const start = cursor;
      cursor += entry.text.length + 2;
      return {
        span: [start, start + entry.text.length] as [number, number],
        quote: entry.text,
        looksLikeAName: false,
        field: entry.field ?? ('mustDo' as const),
      };
    }),
    suggestedQuestions: [],
  };
}

function merge(set: InterpretationSet, spans: readonly UnresolvedSpan[], response: unknown) {
  return mergeModelProposals({
    set,
    spans,
    response,
    attemptedAt: NOW,
    promptVersion: PROMPT_VERSION,
    modelId: MODEL_ID,
  });
}

// ---------------------------------------------------------------------------

describe('what the model is allowed to say', () => {
  /**
   * THE ASSERTION THIS WHOLE SLICE RESTS ON.
   *
   * Not "the prompt asks it not to name a place" — a prompt is a request and
   * traveller free text is the one channel in this product where somebody can
   * address the model directly. The guarantee is that the response *shape* has
   * nowhere a place, a URL, a fact, a provider instruction or a sentence of
   * prose could be written: every string in the schema carries an `enum`, so
   * the value space is closed and every member of it is something we chose.
   */
  it('has no free string field at any depth', () => {
    const schema = z.toJSONSchema(modelInterpretationResponseSchema) as Record<string, unknown>;
    const offenders: string[] = [];

    const visit = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.type === 'string' && !Array.isArray(record.enum) && !record.const) {
        offenders.push(path);
      }
      for (const [key, value] of Object.entries(record)) visit(value, `${path}.${key}`);
    };

    visit(schema, '$');
    expect(offenders, `an unconstrained string at ${offenders.join(', ')}`).toEqual([]);
    // And the serialised schema names nothing a place could arrive under.
    const serialised = JSON.stringify(schema).toLowerCase();
    for (const forbidden of ['destination', 'url', 'href', 'latitude', 'longitude', 'address']) {
      expect(serialised.includes(forbidden), `schema exposes "${forbidden}"`).toBe(false);
    }
  });

  it('offers only vocabularies that already exist, and no sensitive one', () => {
    const vocabularies: Record<string, readonly string[]> = {
      interest: INTERESTS,
      avoidance: AVOIDANCES,
      pace: PACES,
      day_start: DAY_STARTS,
      budget: BUDGET_STYLES,
      crowd: CROWD_TOLERANCES,
      discovery_mix: DISCOVERY_MIXES,
    };
    expect(CONTROLLED_PREFERENCE_KEYS.length).toBeGreaterThan(20);
    for (const key of CONTROLLED_PREFERENCE_KEYS) {
      const target = chipTargetForKey(key);
      expect(target, key).not.toBeNull();
      expect(keyForChipTarget(target!)).toBe(key);
      expect(vocabularies[target!.kind], key).toContain(target!.value);
    }
    // The vocabularies a wrong answer could not be recovered from are absent.
    for (const sensitive of ['mobility', 'dietary', 'allerg', 'medical', 'visa', 'safety', 'income']) {
      expect(
        CONTROLLED_PREFERENCE_KEYS.some((key) => key.includes(sensitive)),
        `a ${sensitive} key exists`,
      ).toBe(false);
    }
  });

  it('rejects a key it was never offered', () => {
    const bad = { proposals: [{ spanIndex: 0, key: 'mobility:limited', polarity: 'affirms', needsClarification: false }] };
    expect(modelInterpretationResponseSchema.safeParse(bad).success).toBe(false);
    expect(chipTargetForKey('mobility:limited')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('what may be sent', () => {
  /**
   * Deterministic-only input reaches no model, and cannot: `spansForModel`
   * reads the unresolved array, and a fully-parsed sentence has an empty one.
   */
  it('offers nothing when the phrase table resolved everything', () => {
    const set = classifyPreferences({ mustDo: 'hot springs and hiking', avoid: 'crowds' });
    expect(set.unresolved).toHaveLength(0);
    expect(spansForModel(set)).toEqual({ spans: [], refusal: 'nothing_unresolved' });
    expect(canOfferModelPass(set)).toBe(false);
  });

  it('sends only the unknown half of a mixed sentence', () => {
    const set = classifyPreferences({
      mustDo: 'hot springs. We want somewhere we can potter about with no fixed plan.',
    });
    expect(set.chips.map((chip) => chip.target.value)).toContain('hot_springs');
    expect(set.unresolved.length).toBeGreaterThan(0);

    const { spans, refusal } = spansForModel(set);
    expect(refusal).toBeNull();
    expect(spans.length).toBe(set.unresolved.length);
    // The half the table resolved is not in the payload at all.
    for (const span of spans) expect(span.text.toLowerCase()).not.toContain('hot spring');
    // And nothing in the payload is anything but the traveller's own characters.
    for (const span of spans) {
      expect(Object.keys(span).sort()).toEqual(['field', 'index', 'span', 'text']);
    }
  });

  it('refuses to call at all on oversized input rather than truncating it', () => {
    const many = setWith(
      Array.from({ length: 12 }, (_, index) => ({ text: `a leftover fragment number ${index}` })),
    );
    expect(spansForModel(many)).toEqual({ spans: [], refusal: 'oversized_input' });

    const long = setWith([{ text: 'x'.repeat(200) }, { text: 'y'.repeat(200) }, { text: 'z'.repeat(200) }, { text: 'w'.repeat(200) }, { text: 'v'.repeat(200) }]);
    expect(spansForModel(long).refusal).toBe('oversized_input');
    expect(canOfferModelPass(long)).toBe(false);
  });

  it('never re-offers text that already raised a safety question', () => {
    const set = setWith([{ text: 'nothing with a nut allergy in the kitchen' }, { text: 'somewhere restful' }]);
    const { spans } = spansForModel(set);
    expect(spans.map((span) => span.text)).toEqual(['somewhere restful']);
  });
});

// ---------------------------------------------------------------------------

describe('the cache key', () => {
  const base = {
    spans: ['somewhere we can potter about'],
    taxonomyVersion: LEXICON_VERSION,
    promptVersion: PROMPT_VERSION,
    schemaVersion: MODEL_INTERPRETATION_SCHEMA_VERSION,
    modelId: MODEL_ID,
    locale: 'en',
  };

  it('changes when any input that could change the answer changes', () => {
    const original = interpretationCacheKey(base);
    const variants = [
      { ...base, spans: ['somewhere we can sit still'] },
      { ...base, taxonomyVersion: 'phrases-en/2099-01-01.1' },
      { ...base, promptVersion: 'interpret-preferences/2099-01-01.1' },
      { ...base, schemaVersion: base.schemaVersion + 1 },
      { ...base, modelId: 'some-other-model' },
      { ...base, locale: 'fr' },
    ];
    for (const variant of variants) {
      expect(interpretationCacheKey(variant), JSON.stringify(variant)).not.toBe(original);
    }
    expect(interpretationCacheKey(base)).toBe(original);
  });

  /**
   * Invisible controls are the same sentence; a different script is not.
   *
   * Folding a Cyrillic "о" onto a Latin "o" would mean one traveller's text
   * could be served the cached reading of a different traveller's text that
   * merely looked identical — which is the exact failure a cache key exists to
   * prevent, dressed up as a convenience.
   */
  it('treats invisible controls as the same text and confusable scripts as different text', () => {
    const plain = 'somewhere we can potter about';
    const withControls = '\u202Esomewhere\u200B we can potter about\u2069';
    const confusable = 's\u043Emewhere we can potter ab\u043Eut'; // Cyrillic o

    expect(normalizeSpanForKey(withControls)).toBe(normalizeSpanForKey(plain));
    expect(interpretationCacheKey({ ...base, spans: [withControls] })).toBe(
      interpretationCacheKey({ ...base, spans: [plain] }),
    );
    expect(normalizeSpanForKey(confusable)).not.toBe(normalizeSpanForKey(plain));
    expect(interpretationCacheKey({ ...base, spans: [confusable] })).not.toBe(
      interpretationCacheKey({ ...base, spans: [plain] }),
    );
  });

  it('carries a confusable span through to a chip with the traveller’s own characters', () => {
    const confusable = 's\u043Emewhere quiet'; // Cyrillic o
    const set = setWith([{ text: confusable }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [{ spanIndex: 0, key: 'pace:slow', polarity: 'affirms', needsClarification: false }],
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.quote).toBe(confusable);
  });

  it('is stable for the same spans and versions', () => {
    const spans: UnresolvedSpan[] = [
      { index: 0, field: 'mustDo', span: [0, 5], text: 'A  B' },
      { index: 1, field: 'avoid', span: [0, 3], text: 'a b' },
    ];
    const key = cacheKeyForSpans({
      spans,
      taxonomyVersion: LEXICON_VERSION,
      promptVersion: PROMPT_VERSION,
      modelId: MODEL_ID,
    });
    expect(key).toMatch(/^interp:[0-9a-f]{16}$/);
    expect(
      cacheKeyForSpans({
        spans,
        taxonomyVersion: LEXICON_VERSION,
        promptVersion: PROMPT_VERSION,
        modelId: MODEL_ID,
      }),
    ).toBe(key);
  });
});

// ---------------------------------------------------------------------------

/**
 * THE ISOLATION PROOF, IN THE IDIOM OF THE EVIDENCE-STORE ARCHITECTURE TEST.
 *
 * `architecture.test.ts` asserts that the shared evidence tables carry no
 * `trip_id` and cascade from nothing, because a fact about a museum is
 * universal. This is the same rule read in the other direction: a *reading of
 * one person's sentence* is the opposite kind of thing, so its table must be
 * trip-scoped, and its key must never appear anywhere a second traveller could
 * be served by it. If it ever did, one person's phrasing would steer another
 * person's ranking — and nothing about the code's shape would make that obvious.
 */
describe('traveller interpretation never enters a shared cache', () => {
  const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

  it('keys the interpretation cache on a trip, and cascades from it', () => {
    const schema = read('apps/web/src/lib/db/schema.ts');
    const block = schema.split('CREATE TABLE IF NOT EXISTS interpretation_cache (')[1] ?? '';
    const body = block.slice(0, block.indexOf(');'));
    expect(body, 'the interpretation cache is not trip-scoped').toMatch(/trip_id/);
    expect(body, 'the interpretation cache outlives its trip').toMatch(/REFERENCES trips/);
    expect(body).toMatch(/ON DELETE CASCADE/);
  });

  it('is not named by any shared cache or shared derivation', () => {
    /** Everything that answers a question about the world rather than a person. */
    const shared = [
      'packages/core/src/evidence/identity.ts',
      'packages/core/src/evidence/claims.ts',
      'packages/core/src/recommend/rank.ts',
      'packages/core/src/recommend/shortlist.ts',
      'packages/compiler/src/evidence-store.ts',
      'packages/compiler/src/claims.ts',
      'apps/web/src/lib/db/evidence-repository.ts',
      'apps/web/src/lib/db/pack-repository.ts',
      'apps/web/src/lib/providers/nominatim.ts',
      'apps/web/src/lib/providers/overpass.ts',
      'apps/web/src/lib/providers/valhalla.ts',
    ];
    const tokens = [
      'interpretationCacheKey',
      'cacheKeyForSpans',
      'interpretation_cache',
      'normalizeSpanForKey',
      'mergeModelProposals',
      'spansForModel',
      'interpretation',
    ];
    const offenders: string[] = [];
    for (const file of shared) {
      const code = read(file);
      for (const token of tokens) {
        if (code.includes(token)) offenders.push(`${file} names ${token}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('names no shared cache itself', () => {
    const mine = ['packages/core/src/intent/fallback.ts', 'apps/web/src/lib/db/interpretation-repository.ts'];
    const forbidden = [
      'evidence_',
      'region_packs',
      'provider_cache',
      'destination_index',
      'compiled_regions',
      'geocodeCacheKey',
      'overpassCacheKey',
      'matrixCacheKey',
      'factSetKeyFor',
    ];
    const offenders: string[] = [];
    for (const file of mine) {
      const code = read(file);
      for (const token of forbidden) {
        // Comments are allowed to *contrast* with the evidence store; code is not.
        const withoutComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (withoutComments.includes(token)) offenders.push(`${file} names ${token}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('validating a reading', () => {
  it('discards an invalid response whole rather than salvaging part of it', () => {
    const set = setWith([{ text: 'somewhere we can potter about' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'pace:slow', polarity: 'affirms', needsClarification: false },
        { spanIndex: 0, key: 'not-a-key', polarity: 'affirms', needsClarification: false },
      ],
    });
    expect(result.outcome).toBe('invalid_response');
    expect(result.accepted).toEqual([]);
    expect(result.set.chips).toEqual([]);
    // The traveller's words are byte-identical.
    expect(result.set.unresolved).toEqual(set.unresolved);
    expect(result.set.modelPass?.chipsAccepted).toBe(0);
  });

  it('ignores a span index it was never offered', () => {
    const set = setWith([{ text: 'somewhere we can potter about' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [{ spanIndex: 5, key: 'pace:slow', polarity: 'affirms', needsClarification: false }],
    });
    expect(result.accepted).toEqual([]);
    expect(result.outcome).toBe('no_proposals');
  });

  /**
   * A model reading can never be a requirement or a blocker.
   *
   * `must_have` produces a board that will not drop the thing; `hard_avoid`
   * produces "which you asked us to skip". A traveller whose sentence the
   * phrase table could not even read has not asked us either of those.
   */
  it('never lets a reading become a requirement or a blocker', () => {
    expect(clampModelStrength('must_have')).toBe('preference');
    expect(clampModelStrength('hard_avoid')).toBe('dislike');

    const set = setWith([{ text: 'we absolutely have to get out on the water, non-negotiable' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'interest:lakes_and_rivers', polarity: 'affirms', needsClarification: false },
      ],
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.strength).toBe('preference');
    expect(result.accepted[0]!.source).toBe('model');
    expect(result.accepted[0]!.status).toBe('proposed');
  });

  it('leaves medical text as a question rather than a preference', () => {
    const parsed = classifyPreferences({ avoid: 'nothing strenuous — my knee is bad' });
    expect(parsed.chips).toHaveLength(0);
    expect(parsed.suggestedQuestions.map((question) => question.topic)).toContain('mobility');

    // And even if such a span reached the merge, a permitted key is refused.
    const set = setWith([{ text: 'nothing too hard on my knee', field: 'avoid' }]);
    const spans: UnresolvedSpan[] = [{ index: 0, field: 'avoid', span: [0, 27], text: 'nothing too hard on my knee' }];
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'avoidance:strenuous_activity', polarity: 'refuses', needsClarification: false },
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.declined[0]!.reason).toBe('for_the_traveller_to_state_themselves');
  });

  it('leaves allergy text as a question rather than a food preference', () => {
    const parsed = classifyPreferences({ avoid: 'nut allergy, so nothing risky' });
    expect(parsed.chips).toHaveLength(0);
    expect(parsed.suggestedQuestions.map((question) => question.topic)).toContain('dietary');

    const set = setWith([{ text: 'somewhere the nut allergy will not be a problem' }]);
    const spans: UnresolvedSpan[] = [
      { index: 0, field: 'mustDo', span: [0, 46], text: 'somewhere the nut allergy will not be a problem' },
    ];
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'interest:food_and_towns', polarity: 'affirms', needsClarification: false },
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.declined[0]!.reason).toBe('for_the_traveller_to_state_themselves');
    expect(JSON.stringify(result.set)).not.toContain('dietaryNeeds');
  });

  it('refuses to pick a side on an ambiguous dislike', () => {
    const set = setWith([{ text: 'we are not really ones for the whole big production' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'avoidance:crowds_and_tourist_traps', polarity: 'refuses', needsClarification: false },
        { spanIndex: 0, key: 'avoidance:expensive_activities', polarity: 'refuses', needsClarification: false },
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.declined.map((entry) => entry.reason)).toEqual([
      'ambiguous_between_preferences',
      'ambiguous_between_preferences',
    ]);
    expect(result.set.unresolved[0]!.clarificationReason).toBe('ambiguous_between_preferences');
  });

  it('refuses both readings when the polarity is mixed', () => {
    const set = setWith([{ text: 'a bit of a lie-in most days' }, { text: 'up and out before the light goes' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'day_start:relaxed', polarity: 'affirms', needsClarification: false },
        { spanIndex: 1, key: 'day_start:relaxed', polarity: 'refuses', needsClarification: false },
      ],
    });
    expect(result.accepted).toEqual([]);
    for (const entry of result.declined) {
      expect(entry.reason).toBe('contradicts_another_part_of_the_text');
    }
  });

  it('turns a flagged proposal into a reason on screen, never a chip', () => {
    const set = setWith([{ text: 'the place my brother went on about' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [
        {
          spanIndex: 0,
          key: 'interest:history_and_culture',
          polarity: 'affirms',
          needsClarification: true,
          clarificationReason: 'reads_like_a_place_or_a_thing',
        },
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.set.unresolved[0]!.clarificationReason).toBe('reads_like_a_place_or_a_thing');
    expect(result.set.unresolved[0]!.quote).toBe('the place my brother went on about');
  });

  it('never affirms out of the avoid box', () => {
    const set = setWith([{ text: 'anything that turns into a whole day of walking', field: 'avoid' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [{ spanIndex: 0, key: 'interest:hiking', polarity: 'affirms', needsClarification: false }],
    });
    expect(result.accepted).toEqual([]);
    expect(result.declined[0]!.reason).toBe('contradicts_another_part_of_the_text');
  });

  it('has no representation for a positively-stated avoidance', () => {
    const set = setWith([{ text: 'we rather enjoy a good throng of people' }]);
    const { spans } = spansForModel(set);
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'avoidance:crowds_and_tourist_traps', polarity: 'affirms', needsClarification: false },
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.declined[0]!.reason).toBe('outside_the_controlled_vocabulary');
  });
});

// ---------------------------------------------------------------------------

describe('confidence is derived, never asserted', () => {
  const clean = {
    schemaValid: true,
    spanAligned: true,
    ambiguous: false,
    contradicted: false,
    overlapsParser: false,
    flaggedForClarification: false,
  };

  it('reads every signal, and downgrades rather than discards where it can', () => {
    expect(deriveConfidence(clean)).toBe('high');
    expect(deriveConfidence({ ...clean, schemaValid: false })).toBe('low');
    expect(deriveConfidence({ ...clean, spanAligned: false })).toBe('low');
    expect(deriveConfidence({ ...clean, ambiguous: true })).toBe('low');
    expect(deriveConfidence({ ...clean, contradicted: true })).toBe('low');
    expect(deriveConfidence({ ...clean, flaggedForClarification: true })).toBe('low');
    expect(deriveConfidence({ ...clean, overlapsParser: true })).toBe('medium');
  });

  it('has no way for a model to raise its own confidence', () => {
    const source = readFileSync(join(ROOT, 'packages/core/src/schemas/interpretation.ts'), 'utf8');
    const block = /export const modelPreferenceProposalSchema = z\.object\(\{([\s\S]*?)\}\);/.exec(source)?.[1] ?? '';
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/confidence|certainty|probability|score/i);
  });

  it('downgrades a reading that lands where the parser already read', () => {
    const parsed = classifyPreferences({ mustDo: 'hiking and something a bit gentler in the afternoons' });
    const overlapping = parsed.chips[0]!;
    const set: InterpretationSet = {
      ...parsed,
      unresolved: [
        {
          span: overlapping.span,
          quote: overlapping.quote,
          looksLikeAName: false,
          field: 'mustDo',
        },
      ],
    };
    const spans: UnresolvedSpan[] = [
      { index: 0, field: 'mustDo', span: overlapping.span, text: overlapping.quote },
    ];
    const result = merge(set, spans, {
      proposals: [
        { spanIndex: 0, key: 'interest:easy_nature_walks', polarity: 'affirms', needsClarification: false },
      ],
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.confidence).toBe('medium');
  });
});

// ---------------------------------------------------------------------------

describe('nothing a reading produces applies before confirmation', () => {
  const proposal: ModelInterpretationResponse = {
    proposals: [{ spanIndex: 0, key: 'interest:stargazing', polarity: 'affirms', needsClarification: false }],
  };

  function readSet(): InterpretationSet {
    const set = setWith([{ text: 'we would like to be somewhere properly dark at night' }]);
    return merge(set, spansForModel(set).spans, proposal).set;
  }

  /**
   * Ranking changes only after confirmation.
   *
   * The profile is the only thing the board scorer, the auto-selector and the
   * planner read — a profile that has not changed is a board that has not
   * changed — so asserting on it is asserting on the ranking, without building
   * a candidate fixture to say the same thing more slowly.
   */
  it('changes no answer and no profile while a chip is only proposed', () => {
    const base = defaultAnswers(CONTEXT);
    const proposed = readSet();
    expect(proposed.chips.some((chip) => chip.source === 'model')).toBe(true);
    expect(proposed.confirmedAt).toBeUndefined();

    expect(applyInterpretation(base, proposed).answers).toEqual(base);
    expect(buildTravelerProfile(applyInterpretation(base, proposed).answers, CONTEXT)).toEqual(
      buildTravelerProfile(base, CONTEXT),
    );
  });

  it('changes the profile once, and only once, somebody accepts it', () => {
    const base = defaultAnswers(CONTEXT);
    const proposed = readSet();
    const confirmed: InterpretationSet = {
      ...proposed,
      chips: proposed.chips.map((chip) => ({ ...chip, status: 'confirmed' as const })),
      confirmedAt: NOW,
    };
    const applied = applyInterpretation(base, confirmed).answers;
    expect(applied.interests.stargazing).not.toBe(base.interests.stargazing);
    expect(buildTravelerProfile(applied, CONTEXT).interests.stargazing).toBe(
      applied.interests.stargazing,
    );
  });

  it('keeps a rejected chip rejected when the reading runs again', () => {
    const proposed = readSet();
    const rejectedId = proposed.chips.find((chip) => chip.source === 'model')!.id;
    const afterRejection: InterpretationSet = {
      ...proposed,
      chips: proposed.chips.map((chip) =>
        chip.id === rejectedId ? { ...chip, status: 'rejected' as const } : chip,
      ),
    };

    // The same text, read again: the chip id collides, so nothing is added and
    // the rejection stands rather than being resurrected under a new identity.
    const set = setWith([{ text: 'we would like to be somewhere properly dark at night' }]);
    const again = mergeModelProposals({
      set: { ...afterRejection, unresolved: set.unresolved },
      spans: spansForModel(set).spans,
      response: proposal,
      attemptedAt: NOW,
      promptVersion: PROMPT_VERSION,
      modelId: MODEL_ID,
    });
    expect(again.accepted).toEqual([]);
    expect(again.set.chips.find((chip) => chip.id === rejectedId)!.status).toBe('rejected');

    const base = defaultAnswers(CONTEXT);
    const confirmed: InterpretationSet = { ...again.set, confirmedAt: NOW };
    expect(applyInterpretation(base, confirmed).answers.interests.stargazing).toBe(
      base.interests.stargazing,
    );
  });

  /**
   * Editing the text after confirming starts again, from the parser.
   *
   * The re-parse is a fresh, unconfirmed set — so the previous acceptance does
   * not carry across to words nobody has seen — and its cache key is different,
   * so the trip's one reading is about the new sentence rather than the old one.
   */
  it('starts a fresh, unconfirmed reading when the traveller edits the text', () => {
    const original = 'we would like to be somewhere properly dark at night';
    const edited = 'we would like to be somewhere properly quiet at night';

    const first = merge(setWith([{ text: original }]), spansForModel(setWith([{ text: original }])).spans, proposal);
    const confirmed: InterpretationSet = {
      ...first.set,
      chips: first.set.chips.map((chip) => ({ ...chip, status: 'confirmed' as const })),
      confirmedAt: NOW,
    };
    expect(canOfferModelPass(confirmed)).toBe(false);

    const reparsed = classifyPreferences({ mustDo: edited });
    expect(reparsed.confirmedAt).toBeUndefined();
    expect(reparsed.modelPass).toBeUndefined();
    expect(applyInterpretation(defaultAnswers(CONTEXT), reparsed).answers).toEqual(
      defaultAnswers(CONTEXT),
    );

    const keyFor = (text: string): string =>
      cacheKeyForSpans({
        spans: spansForModel(setWith([{ text }])).spans,
        taxonomyVersion: LEXICON_VERSION,
        promptVersion: PROMPT_VERSION,
        modelId: MODEL_ID,
      });
    expect(keyFor(edited)).not.toBe(keyFor(original));
  });
});

// ---------------------------------------------------------------------------

describe('failure keeps the traveller’s words', () => {
  it('records every refusal without touching a chip or a quote', () => {
    const set = classifyPreferences({
      mustDo: 'hot springs. Somewhere we can potter about with no fixed plan.',
    });
    for (const outcome of [
      'not_configured',
      'oversized_input',
      'budget_exhausted',
      'provider_unavailable',
      'invalid_response',
    ] as const) {
      const after = recordModelPass({
        set,
        outcome,
        attemptedAt: NOW,
        promptVersion: PROMPT_VERSION,
        modelId: MODEL_ID,
        spansOffered: 1,
        calls: outcome === 'not_configured' || outcome === 'oversized_input' ? 0 : 1,
      });
      expect(after.chips, outcome).toEqual(set.chips);
      expect(after.unresolved, outcome).toEqual(set.unresolved);
      expect(after.confirmedAt, outcome).toBeUndefined();
      expect(after.modelPass!.outcome, outcome).toBe(outcome);
      expect(after.modelPass!.calls, outcome).toBeLessThanOrEqual(1);
    }
  });

  it('stops offering a reading once one has been attempted, spent or not', () => {
    const set = classifyPreferences({ mustDo: 'somewhere we can potter about with no fixed plan' });
    expect(canOfferModelPass(set)).toBe(true);

    for (const [outcome, calls] of [
      ['provider_unavailable', 1],
      ['not_configured', 0],
      ['invalid_response', 1],
    ] as const) {
      const after = recordModelPass({
        set,
        outcome,
        attemptedAt: NOW,
        promptVersion: PROMPT_VERSION,
        modelId: MODEL_ID,
        spansOffered: 1,
        calls,
      });
      expect(canOfferModelPass(after), outcome).toBe(false);
      // The recorded spend is what the server-side guard reads, and it is the
      // narrower of the two: a refusal that never called has spent nothing.
      expect(after.modelPass!.calls, outcome).toBe(calls);
    }
  });
});
