import { afterEach, describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, type BenchmarkTripRequest } from '@sidequest/bench';
import type { StructuredModel } from '../../providers/interpretation-model';
import { fixtureGeneration, fixturePacketInputs } from './fixtures';
import {
  COMPOSER_EFFORT_ENV,
  COMPOSER_MODEL_ENV,
  DEFAULT_COMPOSER_MODEL,
  GENERATION_MAX_TOKENS,
  GENERATION_TIMEOUT_MS,
  SOFT_PROSE_CAPS,
  baselineGenerationSchema,
  buildGenerationTask,
  classifyModelFailure,
  composerEffort,
  composerModel,
  generateBaselinePlan,
  normalizeBaselineGeneration,
  type BaselineGeneration,
} from './generate';
import { buildResearchPacket } from './packet';
import { runPreliminaryScan } from './scan';

/**
 * AN ANSWER THAT RAN OUT OF ROOM IS NOT AN ANSWER IN THE WRONG SHAPE.
 *
 * Both arrive from the client as the same unusable output, and the run used to
 * treat them the same way: give up, with two thirds of the call budget unspent
 * and an empty plan in the results table. They are different failures. One is a
 * model that could not follow a schema; the other is a plan that was too long
 * for the envelope it was given — and the second is fixed by asking for
 * something shorter, which is only possible if the two are told apart.
 */

const REQUEST: BenchmarkTripRequest = benchmarkTripRequestSchema.parse({
  ...(BENCHMARK_CASES[0]?.request ?? {}),
  requestId: 'req-generate',
});

const PACKET = buildResearchPacket(fixturePacketInputs());
const SCAN = runPreliminaryScan({ request: REQUEST, packet: PACKET });

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Records what the call asked for, and answers with something the schema takes. */
interface RecordedCall {
  task: string;
  /** The other half of the request, and the half a security claim is about. */
  untrusted?: unknown;
  maxTokens?: number;
  effort?: string;
}

function recordingModel(): { model: StructuredModel; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const model: StructuredModel = {
    callsRemaining: 2,
    async structured<T>(input: {
      task: string;
      untrusted?: unknown;
      maxTokens?: number;
      effort?: 'low' | 'medium' | 'high';
    }) {
      calls.push({
        task: input.task,
        ...(input.untrusted === undefined ? {} : { untrusted: input.untrusted }),
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      });
      return fixtureGeneration() as T;
    },
  };
  return { model, calls };
}

describe('classifying an unusable answer', () => {
  it('tells a truncated plan apart from a malformed one', () => {
    const truncated = classifyModelFailure(
      failure('malformed_output', 'The model returned nothing usable (max_tokens).'),
    );
    expect(truncated.failureKind).toBe('malformed_output');
    expect(truncated.truncated).toBe(true);
    expect(truncated.detail).toContain('incomplete');

    const malformed = classifyModelFailure(
      failure('malformed_output', 'The model returned nothing usable (end_turn).'),
    );
    expect(malformed.failureKind).toBe('malformed_output');
    expect(malformed.truncated).toBeUndefined();
  });

  /**
   * The kinds that are facts about the provider rather than about one answer.
   * Neither is worth a second ask, and neither may be mistaken for one.
   */
  it('leaves an outage, a rate limit and a timeout as they were', () => {
    expect(classifyModelFailure(failure('request_failed', 'nothing')).failureKind).toBe(
      'model_unavailable',
    );
    expect(classifyModelFailure(failure('not_configured', 'no key')).failureKind).toBe(
      'model_unavailable',
    );
    expect(
      classifyModelFailure(Object.assign(new Error('slow'), { name: 'TimeoutError' })).failureKind,
    ).toBe('timeout');
    for (const kind of ['request_failed', 'not_configured'] as const) {
      expect(classifyModelFailure(failure(kind, 'max_tokens')).truncated).toBeUndefined();
    }
  });
});

describe('the one generation call', () => {
  it('asks for enough room that a long trip and its reasoning both fit', async () => {
    const { model, calls } = recordingModel();
    await generateBaselinePlan({
      model,
      request: REQUEST,
      packet: PACKET,
      scan: SCAN,
      followUpAnswers: [],
    });
    expect(calls[0]?.maxTokens).toBe(GENERATION_MAX_TOKENS);
    // The floor moved from 64,000 to 32,000 with schema version 3's tighter
    // per-block prose caps — see the constant's own note for the arithmetic.
    expect(GENERATION_MAX_TOKENS).toBeGreaterThanOrEqual(32_000);
    expect(calls[0]?.effort).toBe('high');
  });

  /**
   * A retry that repeated the request verbatim would run out of room in exactly
   * the same place and spend the last call in the budget doing it.
   */
  it('asks for something shorter after an answer that ran out of room', async () => {
    const { model, calls } = recordingModel();
    await generateBaselinePlan({
      model,
      request: REQUEST,
      packet: PACKET,
      scan: SCAN,
      followUpAnswers: [],
      retry: 'truncated',
    });

    expect(calls[0]?.task).toContain('RAN OUT OF ROOM');
    expect(calls[0]?.task).toContain('fewer words');
    // Reasoning is drawn from the same envelope as the answer, so less of it is
    // spent thinking on the ask that already overflowed.
    expect(calls[0]?.effort).toBe('medium');
  });

  it('asks again plainly after an answer in the wrong shape', () => {
    const task = buildGenerationTask({
      request: REQUEST,
      packet: PACKET,
      scan: SCAN,
      followUpAnswers: [],
      retry: 'malformed',
    });
    expect(task).toContain('DID NOT MATCH THE REQUIRED SHAPE');
    expect(task).not.toContain('RAN OUT OF ROOM');
  });

  /**
   * A live Iceland run scoped the whole country down to its western/northern
   * quarter and named the traveller's daily driving limit as the reason — but
   * the validator this plan is graded against already exempts a measured
   * inter-base transfer from that same cap (`checkDailyBudgets` in
   * `packages/bench/src/validate/routing.ts`). Nothing told the model that, so
   * it planned as if a relocation day had to fit the excursion ceiling too.
   * This is destination-agnostic: any request whose `maxBaseChanges` is
   * positive must carry the distinction, not only Iceland's.
   */
  it('tells the model a relocation day is not bounded by the day-trip driving ceiling', () => {
    const moving = benchmarkTripRequestSchema.parse({
      ...REQUEST,
      movement: { ...REQUEST.movement, maxBaseChanges: 2 },
    });
    const task = buildGenerationTask({ request: moving, packet: PACKET, scan: SCAN, followUpAnswers: [] });
    expect(task).toContain('not bounded by the driving/travelling limits above');
    expect(task).toContain('relocat');
  });

  it('says a single-base trip has no relocation day to exempt', () => {
    const fixed = benchmarkTripRequestSchema.parse({
      ...REQUEST,
      movement: { ...REQUEST.movement, maxBaseChanges: 0 },
    });
    const task = buildGenerationTask({ request: fixed, packet: PACKET, scan: SCAN, followUpAnswers: [] });
    expect(task).toContain('keeps one base throughout');
    expect(task).not.toContain('not bounded by the driving/travelling limits above');
  });

  it('says nothing about a previous answer on the first ask', () => {
    const task = buildGenerationTask({
      request: REQUEST,
      packet: PACKET,
      scan: SCAN,
      followUpAnswers: [],
    });
    expect(task).not.toContain('YOUR PREVIOUS ANSWER');
  });

  /**
   * THE ANSWERS ARE IN THE ASK — AND IN THE UNTRUSTED HALF OF IT.
   *
   * The prompt contract states that confirmed follow-up answers are supplied to
   * this call, and for a long time an empty list was supplied on every run: the
   * questions were derived and discarded inside the same invocation that
   * generated the plan, so nobody could ever have answered them.
   *
   * Wiring them in put them in the *instruction* turn, under a docstring still
   * promising nothing free-typed appeared there. An answer is a string a browser
   * posted; a value beginning "evening" and continuing with a paragraph of
   * ALL-CAPS instructions sat in the same turn as our own headings and was
   * lexically indistinguishable from them. The question is no safer: a
   * model-synthesised one was written by a call whose own untrusted turn carried
   * the traveller's free text.
   *
   * So this asserts both halves: the answers reach the model, and they reach it
   * where the standing rules say what to do with somebody else's words.
   */
  it("puts the traveller's confirmed answers in the untrusted turn, not the instruction", async () => {
    const { model, calls } = recordingModel();
    await generateBaselinePlan({
      model,
      request: REQUEST,
      packet: PACKET,
      scan: SCAN,
      followUpAnswers: [
        { question: 'Roughly what time do you expect to arrive?', answer: 'evening' },
      ],
    });

    const sent = JSON.stringify(calls[0]?.untrusted ?? {});
    expect(sent).toContain('Roughly what time do you expect to arrive?');
    expect(sent).toContain('evening');

    // The task carries a count and a pointer, and no free-typed text.
    const task = calls[0]?.task ?? '';
    expect(task).toContain('ANSWERS THE TRAVELLER GAVE');
    expect(task).not.toContain('Roughly what time do you expect to arrive?');
  });

  it('says nothing about answers when none were given', () => {
    const task = buildGenerationTask({
      request: REQUEST,
      packet: PACKET,
      scan: SCAN,
      followUpAnswers: [],
    });
    // Not an empty heading with nothing under it: a prompt that says "here are
    // their answers" and then lists none invites the model to supply some.
    expect(task).not.toContain('ANSWERS THE TRAVELLER GAVE');
  });

  it('refuses to spend a call the run does not have', async () => {
    const spent: StructuredModel = {
      callsRemaining: 0,
      async structured<T>(): Promise<T> {
        throw new Error('This should never be reached.');
      },
    };
    const outcome = await generateBaselinePlan({
      model: spent,
      request: REQUEST,
      packet: PACKET,
      scan: SCAN,
      followUpAnswers: [],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failureKind).toBe('budget_exhausted');
  });
});

/**
 * The three fields the neutral plan schema carries and this arm could not
 * write. Without them one arm was structurally uncheckable on daily travel
 * limits, could not say a gate stops admitting before it closes, and had to
 * call a scheduled ferry an unmeasured guess.
 */
describe('what a plan is allowed to say', () => {
  it('accepts a day that states its own totals, a last admission and a timetable', () => {
    const base = fixtureGeneration();
    const parsed = baselineGenerationSchema.safeParse({
      ...base,
      days: [
        {
          ...base.days[0]!,
          statedTotals: { travelMinutes: 40, driveMinutes: 40, freeMinutes: 120 },
          blocks: [
            {
              ...base.days[0]!.blocks[0]!,
              opening: {
                openMinute: 600,
                closeMinute: 1020,
                lastAdmissionMinute: 960,
                sourceIndex: 0,
              },
              travel: {
                mode: 'ferry',
                fromPlaceIndex: 0,
                toPlaceIndex: 1,
                minutes: 35,
                provenance: 'published_timetable',
              },
            },
          ],
        },
        base.days[1]!,
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('still has no word for a travel time somebody worked out', () => {
    const base = fixtureGeneration();
    const invented = {
      ...base,
      days: [
        {
          ...base.days[0]!,
          blocks: [
            {
              ...base.days[0]!.blocks[0]!,
              travel: {
                mode: 'drive',
                fromPlaceIndex: 0,
                toPlaceIndex: 1,
                minutes: 35,
                provenance: 'estimated',
              },
            },
          ],
        },
        base.days[1]!,
      ],
    };
    expect(baselineGenerationSchema.safeParse(invented).success).toBe(false);
  });

  it('will not take a day that declines to say anything about its totals', () => {
    const base = fixtureGeneration();
    const { statedTotals: _omitted, ...withoutTotals } = base.days[0]!;
    expect(
      baselineGenerationSchema.safeParse({ ...base, days: [withoutTotals, base.days[1]!] }).success,
    ).toBe(false);
  });
});

/**
 * THE APPLICATION-OWNED DEADLINE, UNCHANGED BY A COMPOSER-EFFICIENCY PASS.
 *
 * This pass was explicitly told not to touch it — the lever for finishing
 * inside 240 seconds is how much there is to read and generate, not how
 * long Sidequest waits.
 */
describe('the application deadline', () => {
  it('stays at 240 seconds', () => {
    expect(GENERATION_TIMEOUT_MS).toBe(240_000);
  });
});

/**
 * THE MODEL/EFFORT POLICY IS A SETTING, NOT A LITERAL AT THE CALL SITE.
 *
 * `sonnet-5` is the new default and the primary candidate for the next
 * validation; the previous model stays fully selectable for a controlled
 * comparison, by a dedicated env var that cannot leak into any other
 * `ResearchModel` caller in the product.
 */
describe('the composer model/effort policy', () => {
  const ORIGINAL_MODEL = process.env[COMPOSER_MODEL_ENV];
  const ORIGINAL_EFFORT = process.env[COMPOSER_EFFORT_ENV];

  afterEach(() => {
    if (ORIGINAL_MODEL === undefined) delete process.env[COMPOSER_MODEL_ENV];
    else process.env[COMPOSER_MODEL_ENV] = ORIGINAL_MODEL;
    if (ORIGINAL_EFFORT === undefined) delete process.env[COMPOSER_EFFORT_ENV];
    else process.env[COMPOSER_EFFORT_ENV] = ORIGINAL_EFFORT;
  });

  it('defaults to claude-sonnet-5, the next validation’s primary candidate', () => {
    delete process.env[COMPOSER_MODEL_ENV];
    expect(composerModel()).toBe('claude-sonnet-5');
    expect(DEFAULT_COMPOSER_MODEL).toBe('claude-sonnet-5');
  });

  it('keeps the previous model selectable, for a controlled comparison', () => {
    process.env[COMPOSER_MODEL_ENV] = 'claude-opus-5';
    expect(composerModel()).toBe('claude-opus-5');
  });

  it('does not fall back to the generic ANTHROPIC_MODEL variable other callers use', () => {
    delete process.env[COMPOSER_MODEL_ENV];
    const originalGeneric = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    try {
      expect(composerModel()).toBe('claude-sonnet-5');
    } finally {
      if (originalGeneric === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = originalGeneric;
    }
  });

  it('defaults effort to high and accepts a configured override', () => {
    delete process.env[COMPOSER_EFFORT_ENV];
    expect(composerEffort()).toBe('high');
    process.env[COMPOSER_EFFORT_ENV] = 'medium';
    expect(composerEffort()).toBe('medium');
  });

  it('falls back to the default on an unrecognised effort value', () => {
    process.env[COMPOSER_EFFORT_ENV] = 'maximum-overdrive';
    expect(composerEffort()).toBe('high');
  });

  it('reaches the outbound call: the configured model/effort are what generateBaselinePlan actually sends', async () => {
    process.env[COMPOSER_MODEL_ENV] = 'claude-sonnet-5';
    process.env[COMPOSER_EFFORT_ENV] = 'medium';
    const { model, calls } = recordingModel();
    await generateBaselinePlan({ model, request: REQUEST, packet: PACKET, scan: SCAN, followUpAnswers: [] });
    // `structured()` is not given a model per call — it lives on the
    // `ResearchModel` instance `hybrid.ts` constructs with
    // `composerModel()`. What this call site controls per-call is effort,
    // which this asserts directly.
    expect(calls[0]?.effort).toBe('medium');
  });
});

/**
 * THE OUTPUT CEILING, PROVEN AGAINST A REAL MAXIMAL PAYLOAD — NOT JUST
 * ARITHMETIC IN A COMMENT.
 *
 * Builds an actual `BaselineGeneration` with every array at its cap and
 * every string at its maximum length, confirms the current schema still
 * accepts it (so the documented arithmetic beside `GENERATION_MAX_TOKENS`
 * is checked against the schema actually in force, not a stale description
 * of it), and compares its real serialized size — JSON structural overhead
 * included, which a hand-computed character sum leaves out and this test
 * caught doing exactly that during this pass — against the equivalent v3
 * payload, built with v3's own caps on the fields v4 changed.
 */
describe('the output ceiling, measured against a real maximal payload', () => {
  const filler = (n: number) => 'x'.repeat(n);

  function maximalBlock(index: number) {
    return {
      kind: 'activity' as const,
      title: filler(120),
      startMinute: 480,
      endMinute: 540,
      placeIndex: index,
      travel: null,
      meal: null,
      opening: null,
      note: filler(220),
      uncertainty: [filler(120), filler(120)],
      sourceIndex: 0,
    };
  }

  // Unchanged between v3 and v4 — see `BASELINE_OUTPUT_SCHEMA_VERSION`'s own
  // note on why the per-day/per-block budget was left alone this round.
  function maximalDay(dayNumber: number) {
    return {
      dayNumber,
      baseId: 'base-one',
      theme: filler(120),
      blocks: Array.from({ length: 10 }, (_, i) => maximalBlock(i)),
      statedTotals: { travelMinutes: 100, driveMinutes: 100, freeMinutes: 100 },
      alternatives: [
        { placeIndex: 0, trigger: filler(120), why: filler(150) },
        { placeIndex: 1, trigger: filler(120), why: filler(150) },
      ],
      warnings: [filler(150), filler(150), filler(150)],
    };
  }

  /** The trip-level fields at v4's caps — the ones this pass actually changed. */
  function maximalTripV4(dayCount: number) {
    return {
      summary: filler(800),
      scopeNote: filler(300),
      bases: Array.from({ length: 8 }, (_, i) => ({
        id: `base-${i}`,
        placeIndex: i,
        name: filler(120),
        nights: 3,
        why: filler(160),
      })),
      days: Array.from({ length: dayCount }, (_, i) => maximalDay(i + 1)),
      exclusions: Array.from({ length: 20 }, (_, i) => ({ placeIndex: i, reason: filler(150) })),
      unknowns: Array.from({ length: 15 }, () => filler(160)),
      preparation: Array.from({ length: 10 }, () => filler(150)),
      warnings: Array.from({ length: 8 }, () => filler(160)),
    };
  }

  /** The same shape at v3's caps on the trip-level fields, for a fair, measured comparison. */
  function maximalTripV3(dayCount: number) {
    return {
      summary: filler(1200),
      scopeNote: filler(400),
      bases: Array.from({ length: 8 }, (_, i) => ({
        id: `base-${i}`,
        placeIndex: i,
        name: filler(120),
        nights: 3,
        why: filler(200),
      })),
      days: Array.from({ length: dayCount }, (_, i) => maximalDay(i + 1)),
      exclusions: Array.from({ length: 20 }, (_, i) => ({ placeIndex: i, reason: filler(180) })),
      unknowns: Array.from({ length: 20 }, () => filler(200)),
      preparation: Array.from({ length: 20 }, () => filler(200)),
      warnings: Array.from({ length: 12 }, () => filler(200)),
    };
  }

  it('the current schema still accepts a maximal payload at every cap', () => {
    expect(baselineGenerationSchema.safeParse(maximalTripV4(13)).success).toBe(true);
  });

  it('is smaller than the v3 worst case, measured the same way, at every trip length tested', () => {
    // The trip-level fields this pass cut are a shrinking fraction of the
    // total as a trip gets longer — the per-day/per-block budget (deliberately
    // untouched this round) dominates a long trip's worst case, so the real
    // reduction is meaningfully bigger on a 5-day trip than a 21-day one.
    // Both are still strictly smaller; that is the property this asserts,
    // rather than one fixed percentage that would be true at one length and
    // false at another.
    for (const days of [5, 13, 21]) {
      const v4Bytes = JSON.stringify(maximalTripV4(days)).length;
      const v3Bytes = JSON.stringify(maximalTripV3(days)).length;
      expect(v4Bytes, `${days}-day v4 worst case should be smaller than v3's`).toBeLessThan(v3Bytes);
    }
  });

  it('reports real, JSON-overhead-included sizes at 5, 13 and 21 days — not a hand-computed character sum', () => {
    // No fixed thresholds here on purpose: the previous version of this test
    // asserted a hand-computed estimate that omitted JSON's own key/quote/
    // punctuation overhead, and a real measurement came in materially higher
    // (13-day: ~127,800 bytes measured vs. ~101,350 estimated) — the exact
    // gap this test exists to keep visible rather than silently re-introduce.
    // What is asserted is monotonicity: more days is always more bytes, and
    // a 21-day trip's real worst case is not smaller than a 13-day one's.
    const byLength = [5, 13, 21].map((days) => ({ days, bytes: JSON.stringify(maximalTripV4(days)).length }));
    expect(byLength[1]!.bytes).toBeGreaterThan(byLength[0]!.bytes);
    expect(byLength[2]!.bytes).toBeGreaterThan(byLength[1]!.bytes);
    // The 21-day case genuinely needs more than `GENERATION_MAX_TOKENS`
    // covers at any ordinary chars-per-token estimate — recorded here so a
    // change to either number is a visible, deliberate decision rather than
    // a silent drift. See `GENERATION_MAX_TOKENS`'s own note.
    expect(byLength[2]!.bytes).toBeGreaterThan(GENERATION_MAX_TOKENS * 3);
  });
});

/**
 * THE MEDIUM-EFFORT MALFORMED RESPONSE, DIAGNOSED FROM WHAT WAS ACTUALLY
 * PRESERVED — AND REPRODUCED AS A REPRESENTATIVE FIXTURE.
 *
 * A live `claude-sonnet-5`, `effort: medium` replay
 * (`.claude-private/benchmark/iceland-transport-diagnostic-2026-08-29/effort-medium-result.json`)
 * completed inside the 240s deadline (183.5s, `stop_reason: 'end_turn'`,
 * 19,913 output tokens, 24,342 response bytes) but failed with
 * `ResearchModelError`'s exact text: "The model answered in a shape the
 * schema refused (end_turn)." That sentence is diagnostic, not incidental —
 * `parseStreamedOutput` (`anthropic.ts`) has three distinct failure exits,
 * each with its own wording, and only one of them says "answered in a shape
 * the schema refused": the third, reached only when `JSON.parse` already
 * *succeeded* and `schema.safeParse` rejected the result. The other two
 * ("returned nothing usable") fire on empty text or a `JSON.parse` failure —
 * neither is what happened here. So, from the preserved artifact alone,
 * without the raw text (never captured — this codebase does not log a
 * model's own answer; see the same function's comment on why the Zod issue
 * detail itself is withheld): the response was valid, parseable JSON, not
 * prose- or code-fence-wrapped, that nonetheless violated one or more of the
 * schema's *structural* constraints — a required field, a wrong type or
 * enum, a string past its `prose(N)` length cap, or a string that failed
 * `SAFE_PROSE_PATTERN`. The single largest real number in the diagnostic —
 * 19,913 output tokens against only 24,342 response bytes, roughly 1.2
 * bytes/token versus English/JSON's usual ~4 — says most of that call's
 * budget went to invisible reasoning, not to the visible answer; whether a
 * rushed final stretch of generation is *why* the shape slipped is a
 * hypothesis this evidence supports, not a fact this evidence proves.
 *
 * The fixture below is deliberately NOT a byte-exact reproduction — the raw
 * text was never captured, by design, so no reproduction of it can exist.
 * It is a *representative* fixture of the diagnosed failure class: valid,
 * complete JSON matching the schema's shape everywhere except one field
 * pushed past its length cap, which is the most specific failure the
 * preserved evidence actually supports.
 */
describe('the medium-effort malformed response — a representative regression fixture', () => {
  it('reproduces the diagnosed failure class: valid JSON, one field past its length cap', () => {
    const base = fixtureGeneration();
    const tooLong = {
      ...base,
      days: [
        {
          ...base.days[0]!,
          blocks: [
            {
              ...base.days[0]!.blocks[0]!,
              // One character past `note`'s 220-char cap — everything else
              // about this object is otherwise schema-conformant.
              note: 'x'.repeat(221),
            },
            base.days[0]!.blocks[1]!,
          ],
        },
        base.days[1]!,
      ],
    };
    const parsed = baselineGenerationSchema.safeParse(tooLong);
    expect(parsed.success).toBe(false);
  });

  it('reproduces the failure class the other way: valid JSON, one field violating the safe-prose pattern', () => {
    const base = fixtureGeneration();
    const forbiddenPattern = {
      ...base,
      scopeNote: 'See https://example.com for details.',
    };
    const parsed = baselineGenerationSchema.safeParse(forbiddenPattern);
    expect(parsed.success).toBe(false);
  });

  it('is not the failure class this fixture rules out: prose or a code fence around the JSON', () => {
    // Distinguishing evidence, not asserted behaviour of the fixture above:
    // a prose- or fence-wrapped answer fails earlier, in `JSON.parse`, with
    // a different message ("returned nothing usable") than the one actually
    // observed ("answered in a shape the schema refused"). This test exists
    // to keep that distinction itself checked, not just written in a comment.
    const codeFenced = '```json\n{"note":"fine"}\n```';
    expect(() => JSON.parse(codeFenced.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''))).not.toThrow();
    const proseWrapped = 'Here is your itinerary:\n\n{"note":"fine"}';
    expect(() => JSON.parse(proseWrapped)).toThrow();
  });
});

describe('normalizeBaselineGeneration — cosmetic fields, and only cosmetic fields', () => {
  it('clips a soft field past its cap, and the clipped answer then passes strict validation', () => {
    const base = fixtureGeneration();
    const tooLong = {
      ...base,
      days: [
        {
          ...base.days[0]!,
          blocks: [
            { ...base.days[0]!.blocks[0]!, note: 'x'.repeat(SOFT_PROSE_CAPS.blockNote + 10) },
            base.days[0]!.blocks[1]!,
          ],
        },
        base.days[1]!,
      ],
    };
    // Exactly the fixture the previous describe block proved fails strict
    // validation as-is.
    expect(baselineGenerationSchema.safeParse(tooLong).success).toBe(false);

    const { value, normalizedFields } = normalizeBaselineGeneration(tooLong);
    expect(normalizedFields).toContain('days[0].blocks[0].note');
    const revalidated = baselineGenerationSchema.safeParse(value);
    expect(revalidated.success).toBe(true);
    if (revalidated.success) {
      expect(revalidated.data.days[0]!.blocks[0]!.note.length).toBe(SOFT_PROSE_CAPS.blockNote);
    }
  });

  it('trims whitespace on a soft field even when it is not over the cap', () => {
    const base = fixtureGeneration({ scopeNote: '  Everything is close by.  ' });
    const { value, normalizedFields } = normalizeBaselineGeneration(base);
    expect(normalizedFields).toContain('scopeNote');
    expect((value as { scopeNote: string }).scopeNote).toBe('Everything is close by.');
  });

  it('does not touch a field that is clean and within its cap', () => {
    const base = fixtureGeneration();
    const { value, normalizedFields } = normalizeBaselineGeneration(base);
    expect(normalizedFields).toEqual([]);
    expect(value).toEqual(base);
  });

  it('never clips a field that violates the safe-prose pattern — the hard failure survives untouched', () => {
    const base = fixtureGeneration();
    const withUrl = { ...base, scopeNote: `See https://example.com for details. ${'x'.repeat(SOFT_PROSE_CAPS.scopeNote)}` };
    expect(baselineGenerationSchema.safeParse(withUrl).success).toBe(false);

    const { value, normalizedFields } = normalizeBaselineGeneration(withUrl);
    expect(normalizedFields).not.toContain('scopeNote');
    expect((value as { scopeNote: string }).scopeNote).toBe(withUrl.scopeNote);
    expect(baselineGenerationSchema.safeParse(value).success).toBe(false);
  });

  it('never clips a hard field — a too-long block title is left for strict validation to reject', () => {
    const base = fixtureGeneration();
    const tooLongTitle = {
      ...base,
      days: [
        {
          ...base.days[0]!,
          blocks: [
            { ...base.days[0]!.blocks[0]!, title: 'x'.repeat(121) },
            base.days[0]!.blocks[1]!,
          ],
        },
        base.days[1]!,
      ],
    };
    expect(baselineGenerationSchema.safeParse(tooLongTitle).success).toBe(false);
    const { value, normalizedFields } = normalizeBaselineGeneration(tooLongTitle);
    expect(normalizedFields).toEqual([]);
    expect(baselineGenerationSchema.safeParse(value).success).toBe(false);
  });

  it('never truncates an array to fit a length cap — that would delete part of the itinerary', () => {
    const base = fixtureGeneration();
    const extraBlock = { ...base.days[0]!.blocks[0]! };
    const tooManyBlocks = {
      ...base,
      days: [
        { ...base.days[0]!, blocks: Array.from({ length: 11 }, () => extraBlock) },
        base.days[1]!,
      ],
    };
    expect(baselineGenerationSchema.safeParse(tooManyBlocks).success).toBe(false);
    const { value } = normalizeBaselineGeneration(tooManyBlocks);
    expect((value as { days: { blocks: unknown[] }[] }).days[0]!.blocks.length).toBe(11);
    expect(baselineGenerationSchema.safeParse(value).success).toBe(false);
  });

  it('never touches a place/source reference, an id, or an enum', () => {
    const base = fixtureGeneration();
    const { value } = normalizeBaselineGeneration(base);
    const normalized = value as BaselineGeneration;
    expect(normalized.bases[0]!.id).toBe(base.bases[0]!.id);
    expect(normalized.bases[0]!.placeIndex).toBe(base.bases[0]!.placeIndex);
    expect(normalized.days[0]!.baseId).toBe(base.days[0]!.baseId);
    expect(normalized.days[0]!.blocks[0]!.kind).toBe(base.days[0]!.blocks[0]!.kind);
    expect(normalized.days[0]!.blocks[0]!.placeIndex).toBe(base.days[0]!.blocks[0]!.placeIndex);
  });

  it('leaves a non-object payload alone', () => {
    expect(normalizeBaselineGeneration(null)).toEqual({ value: null, normalizedFields: [] });
    expect(normalizeBaselineGeneration('not an object')).toEqual({
      value: 'not an object',
      normalizedFields: [],
    });
    expect(normalizeBaselineGeneration([1, 2, 3])).toEqual({ value: [1, 2, 3], normalizedFields: [] });
  });

  it('is what generateBaselinePlan and repairBaselinePlan actually pass to structured()', async () => {
    const model: StructuredModel = {
      callsRemaining: 2,
      async structured<T>(input: { normalize?: (raw: unknown) => unknown }) {
        expect(input.normalize).toBe(normalizeBaselineGeneration);
        return fixtureGeneration() as T;
      },
    };
    await generateBaselinePlan({ model, request: REQUEST, packet: PACKET, scan: SCAN, followUpAnswers: [] });
  });
});
