import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, type BenchmarkTripRequest } from '@sidequest/bench';
import type { StructuredModel } from '../../providers/interpretation-model';
import { fixtureGeneration, fixturePacketInputs } from './fixtures';
import {
  GENERATION_MAX_TOKENS,
  baselineGenerationSchema,
  buildGenerationTask,
  classifyModelFailure,
  generateBaselinePlan,
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
    expect(GENERATION_MAX_TOKENS).toBeGreaterThanOrEqual(64_000);
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
