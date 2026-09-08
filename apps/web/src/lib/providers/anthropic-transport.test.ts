import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  ResearchModel as ResearchModelClass,
  isStructuredOutputSchemaRefusal as isStructuredOutputSchemaRefusalType,
} from './anthropic';
import { TRANSPORT_IDLE_TIMEOUT_ENV } from './anthropic-liveness';

/**
 * HOW THE REQUEST LEAVES, AND WHAT IS STILL CHECKED WHEN IT COMES BACK.
 *
 * These are properties no other test could hold, because every other test in
 * the tree substitutes `StructuredModel` and therefore never reaches the
 * provider client at all. That gap is why a live-only failure survived a green
 * suite: the one call that plans a whole itinerary was refused outright — HTTP
 * 400, nothing generated, nothing billed, in under half a second — because the
 * schema it asked to be decoded against was too large for the provider to
 * compile into a grammar. No offline test builds a request, so nothing noticed.
 *
 * So this file mocks the SDK itself and asserts on the request that would have
 * gone out, plus the validation the answer is put through on the way back.
 */

const parse = vi.fn();
const finalMessage = vi.fn();
interface SentRequest {
  max_tokens: number;
  output_config?: { format?: unknown };
  messages: { content: unknown }[];
}
/** What a fake `MessageStream` needs to be: awaited for its final answer, and
 * capable of taking event listeners — real `Mock`s in the default case,
 * plain functions in a `mockImplementationOnce` override. */
interface FakeMessageStream {
  finalMessage: () => Promise<unknown>;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}
/**
 * The default fake stream: no-op `.on()`, since most tests here never touch
 * partial-stream diagnostics and only care what `finalMessage()` resolves or
 * rejects with. Tests that DO care override this per-call with
 * `stream.mockImplementationOnce(...)`.
 */
const stream = vi.fn(
  (_params: SentRequest, _options?: { signal?: AbortSignal }): FakeMessageStream => ({
    finalMessage,
    on: vi.fn(),
  }),
);

/** Stands in for `Anthropic.AnthropicError` — the SDK's base class, real `APIError`'s own parent. */
class FakeAnthropicError extends Error {}
class FakeAPIError extends FakeAnthropicError {
  requestID: string | null = null;
}
class FakeRateLimitError extends FakeAPIError {}
/** Stands in for `Anthropic.APIUserAbortError` — thrown when a caller-supplied `signal` fires. */
class FakeAPIUserAbortError extends FakeAPIError {}
/** Stands in for `Anthropic.APIConnectionTimeoutError` — the SDK's own connect-phase timeout. */
class FakeAPIConnectionTimeoutError extends FakeAPIError {}
class FakeAuthenticationError extends FakeAPIError {}
class FakePermissionDeniedError extends FakeAPIError {}
/**
 * Stands in for `Anthropic.BadRequestError` — a pre-generation 400, e.g. a
 * refused compiled grammar. Carries `status`/`type` the way the real SDK's
 * `APIError` always does (see `core/error.mjs`'s `APIError.generate`, which
 * sets `type` from the response body's `error.type` — always
 * `'invalid_request_error'` for a 400, whatever the request actually got
 * wrong), so `schemaRefusal` diagnostics have something real to assert on.
 */
class FakeBadRequestError extends FakeAPIError {
  status = 400;
  type = 'invalid_request_error';
}

let lastAnthropicConstructorOptions: unknown;

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    constructor(options: unknown) {
      lastAnthropicConstructorOptions = options;
    }
    messages = { parse, stream };
  }
  return {
    default: Object.assign(FakeAnthropic, {
      AnthropicError: FakeAnthropicError,
      APIError: FakeAPIError,
      RateLimitError: FakeRateLimitError,
      APIUserAbortError: FakeAPIUserAbortError,
      APIConnectionTimeoutError: FakeAPIConnectionTimeoutError,
      AuthenticationError: FakeAuthenticationError,
      PermissionDeniedError: FakePermissionDeniedError,
      BadRequestError: FakeBadRequestError,
    }),
  };
});

/*
 * Stands in for the real converter, and deliberately emits a schema with no
 * `pattern` in it — which is what the real one does too. That omission is the
 * reason the answer has to be re-validated locally, so a stub that quietly
 * included the pattern would hide the very gap these tests cover.
 *
 * `parse` is included, matching the real `zodOutputFormat()` — see
 * `helpers/zod.mjs` — precisely so a test can prove `structured()` strips it
 * before the request leaves this process, rather than the assertion being
 * true only because the stub never had it to strip.
 */
vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({
  zodOutputFormat: () => ({
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
      additionalProperties: false,
    },
    parse: (content: string) => JSON.parse(content),
  }),
}));

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function streamed(text: string, stopReason = 'end_turn') {
  return {
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text },
    ],
    stop_reason: stopReason,
    usage: USAGE,
    _request_id: 'req_test',
  };
}

/** The shape that matters: a bounded string that refuses a URL, as in the plan. */
const SAFE = /^(?![\s\S]*(?::\/\/|javascript:))[^<>]*$/;
const schema = z.object({ note: z.string().max(40).regex(SAFE) });

let ResearchModel: typeof ResearchModelClass;
let isStructuredOutputSchemaRefusal: typeof isStructuredOutputSchemaRefusalType;

beforeEach(async () => {
  vi.resetModules();
  parse.mockReset();
  stream.mockClear();
  finalMessage.mockReset();
  lastAnthropicConstructorOptions = undefined;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-credential';
  ({ ResearchModel, isStructuredOutputSchemaRefusal } = await import('./anthropic'));
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

function call(maxTokens: number) {
  return new ResearchModel({ maxCalls: 5 }).structured({
    promptVersion: 'test/1',
    instruction: 'test',
    task: 'test',
    schema,
    maxTokens,
  });
}

describe('how a structured request is sent', () => {
  it('streams a request whose output ceiling the provider would refuse unstreamed', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    await expect(call(64_000)).resolves.toEqual({ note: 'fine' });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 64_000 });
  });

  /**
   * ONE PIPELINE, EVERY SIZE.
   *
   * This used to be "leaves the small calls on the simpler path" —
   * `client.messages.parse()`, the SDK's own single-response helper. That
   * path never reached `parseStreamedOutput` (no `normalize`, no uniform
   * classification) and could fail in a way this file could not diagnose at
   * all: see the TripSkeleton replay this fix responds to
   * (`.claude-private/PROGRESS.md`'s own entry). A `maxTokens: 9,000` call —
   * comfortably under the old 16,000 threshold — must now take the exact
   * same route a 32,000-token call does.
   */
  it('a 9,000-token call — comfortably under the old non-streamed threshold — still streams', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    await expect(call(9_000)).resolves.toEqual({ note: 'fine' });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 9_000 });
  });

  it('never calls the SDK single-response helper at all, at any size', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    await call(200);
    await call(9_000);
    await call(64_000);

    expect(parse).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(3);
  });

  it('charges a streamed call to the ledger like any other', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    const model = new ResearchModel({ maxCalls: 5 });
    await model.structured({ promptVersion: 't/1', instruction: 'i', task: 't', schema, maxTokens: 64_000 });

    expect(model.usage.calls).toBe(1);
    expect(model.usage.inputTokens).toBe(10);
    expect(model.usage.outputTokens).toBe(20);
    expect(model.usage.estimatedCostUsd).toBeGreaterThan(0);
  });
});

describe('the schema too large to compile into a grammar', () => {
  function promptEnforced() {
    return new ResearchModel({ maxCalls: 5 }).structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'Plan it.',
      schema,
      maxTokens: 64_000,
      schemaEnforcement: 'prompt',
    });
  }

  it('sends no output format, because asking for one is what the provider refuses', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    await promptEnforced();

    const sent = stream.mock.calls[0]![0];
    expect(sent.output_config?.format).toBeUndefined();
  });

  it('states the schema in the prompt instead', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    await promptEnforced();

    const sent = stream.mock.calls[0]![0];
    const task = String(sent.messages.at(-1)?.content);
    expect(task).toContain('Plan it.');
    expect(task).toContain('JSON Schema');
    expect(task).toContain('"note"');
  });

  /**
   * The property the whole trade rests on. Nothing constrains the decoder here,
   * so if the answer were trusted the pattern would go unenforced — and the
   * pattern is the rule that keeps a URL out of a field a reviewer's browser
   * renders. It has to be refused on exactly the same terms as in the other mode.
   */
  it('still refuses an answer the schema forbids', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"see javascript:alert(1)"}'));

    await expect(promptEnforced()).rejects.toMatchObject({ code: 'malformed_output' });
  });

  it('accepts an answer the model wrapped in a code fence', async () => {
    finalMessage.mockResolvedValue(streamed('```json\n{"note":"fine"}\n```'));

    await expect(promptEnforced()).resolves.toEqual({ note: 'fine' });
  });

  it('keeps the output format when nobody asks for the other mode', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    await call(64_000);

    const sent = stream.mock.calls[0]![0];
    expect(sent.output_config?.format).toBeDefined();
  });

  /**
   * NATIVE STRUCTURED OUTPUTS, KEPT — WITHOUT THE SDK'S OWN PARSE HELPER
   * RACING `parseStreamedOutput`.
   *
   * `zodOutputFormat()` returns `{type, schema, parse}`. The wire format
   * still carries `type`/`schema` — the provider still compiles a grammar
   * from it, structured outputs are not disabled — but `parse` must never
   * be sent: it is what let the SDK's own `zodObject.safeParse` run inside
   * `stream.finalMessage()` (`MessageStream`'s own `message_stop` handling)
   * and throw a bare `AnthropicError` before this method's own validation
   * ever ran. This is at every size, not only the ones that used to stream.
   */
  it.each([9_000, 64_000])('sends schema/type but never the SDK parse helper, at %i tokens', async (maxTokens) => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    await call(maxTokens);

    const sent = stream.mock.calls[0]![0];
    const format = sent.output_config?.format as { type?: unknown; schema?: unknown; parse?: unknown } | undefined;
    expect(format?.type).toBe('json_schema');
    expect(format?.schema).toBeDefined();
    expect(format).not.toHaveProperty('parse');
  });
});

describe('what the streamed answer is still held to', () => {
  /**
   * The load-bearing one. `zodOutputFormat` cannot express `pattern`, so the
   * provider never receives the rule that keeps a URL out of a rendered field.
   * If the streamed path returned the parsed JSON without re-running the
   * caller's own schema, this answer would be accepted.
   */
  it('refuses an answer the wire schema could never have refused', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"see javascript:alert(1)"}'));

    await expect(call(64_000)).rejects.toMatchObject({ code: 'malformed_output' });
  });

  it('refuses an answer that is the wrong shape', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":42}'));

    await expect(call(64_000)).rejects.toMatchObject({ code: 'malformed_output' });
  });

  it('names the stop reason when an answer is cut off, so a retry can ask for less', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"trunca', 'max_tokens'));

    // The one caller that retries tells truncation from malformation by looking
    // for this word in this sentence. See `classifyModelFailure`.
    await expect(call(64_000)).rejects.toMatchObject({
      code: 'malformed_output',
      message: expect.stringContaining('max_tokens'),
    });
  });

  it('refuses an answer with no text at all', async () => {
    finalMessage.mockResolvedValue({
      content: [{ type: 'thinking', thinking: '' }],
      stop_reason: 'refusal',
      usage: USAGE,
      _request_id: 'req_test',
    });

    await expect(call(64_000)).rejects.toMatchObject({ code: 'malformed_output' });
  });

  /**
   * `end_turn` — THE MODEL'S OWN "I FINISHED" — SURVIVES A SUCCESSFUL CALL.
   */
  it('preserves stop_reason: end_turn on a clean completion', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}', 'end_turn'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 });

    expect(model.callLog[0]?.stopReason).toBe('end_turn');
    expect(model.callLog[0]?.outcome).toBe('completed');
  });

  /**
   * THE EXACT ZOD ISSUES, RETAINED — PRIVATE DIAGNOSTICS ONLY.
   *
   * Where the old non-streamed path lost this entirely (the SDK's own
   * `AnthropicError` carried it, then got discarded into "did not answer" —
   * see the fix's own note above `buildParams`), the unified path captures
   * it directly from this method's own `schema.safeParse`.
   */
  it('retains the exact Zod issue paths/codes/messages for a hard validation failure', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":42}'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model
      .structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 })
      .catch(() => undefined);

    const issues = model.callLog[0]?.schemaValidationIssues;
    expect(issues).not.toBeNull();
    expect(issues!.length).toBeGreaterThan(0);
    expect(issues![0]).toMatchObject({ path: 'note', code: expect.any(String), message: expect.any(String) });
    // stop_reason/usage/request id are no longer lost either — the message
    // was assigned before validation ran, unlike the old non-streamed path.
    expect(model.callLog[0]?.stopReason).toBe('end_turn');
    expect(model.callLog[0]?.requestId).toBe('req_test');
  });

  /*
   * MVP V3 — a truncated answer is salvaged, then judged.
   *
   * This used to assert that truncation never reached `safeParse`, because the
   * extractor refused it outright. It now reaches validation: the salvage pass
   * (`json-repair.ts`) discards the tail the model never finished and hands over
   * what it did write, so the failure is reported as the *field that is missing*
   * rather than as "nothing usable". That is a strictly better diagnosis, and it
   * is what recovers a long draft whose last day was cut off.
   */
  it('salvages a truncated answer and reports the field the answer never reached', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"trunca', 'max_tokens'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model
      .structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 })
      .catch(() => undefined);

    const issues = model.callLog[0]?.schemaValidationIssues;
    expect(issues).not.toBeNull();
    expect(issues![0]).toMatchObject({ path: 'note' });
    expect(model.callLog[0]?.normalizedFields).toContain('json (unterminated_string)');
  });

  it('leaves schemaValidationIssues null for a clean completion', async () => {
    finalMessage.mockResolvedValue(streamed('{"note":"fine"}'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 });

    expect(model.callLog[0]?.schemaValidationIssues).toBeNull();
  });
});

/**
 * A BARE `AnthropicError` — THE SDK'S OWN BASE CLASS, DISTINCT FROM ANY
 * PROVIDER `APIError`.
 *
 * The exact failure the TripSkeleton replay exposed: the SDK can reject a
 * response with a plain `AnthropicError` that is not an `instanceof
 * Anthropic.APIError` at all. Before this fix, that fell to the fully
 * generic catch-all and reported "The research model did not answer,"
 * indistinguishable from a genuine network outage. `buildParams` stripping
 * `.parse` (tested above) removes the one confirmed source of this; these
 * tests hold the classification itself to account for any other bare
 * `AnthropicError` the SDK might still raise internally.
 */
describe('a bare AnthropicError — not an APIError — is classified, not swallowed', () => {
  it('is not reported as the fully generic "did not answer" — its own safe message survives', async () => {
    finalMessage.mockRejectedValueOnce(new FakeAnthropicError('Unexpected event order, got message_start'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const thrown = await model
      .structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: 'request_failed' });
    expect((thrown as Error).message).toContain('Unexpected event order');
    expect((thrown as Error).message).not.toBe('The research model did not answer.');
  });

  it('is not misclassified as any of the more specific provider error codes', async () => {
    finalMessage.mockRejectedValueOnce(new FakeAnthropicError('stream has ended, this shouldn’t happen'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const thrown = await model
      .structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: 'request_failed' });
    expect((thrown as { code?: string }).code).not.toBe('auth_rejected');
    expect((thrown as { code?: string }).code).not.toBe('rate_limited');
    expect((thrown as { code?: string }).code).not.toBe('timeout');
  });

  it('still counts as one billed attempt in callLog, with outcome network_error', async () => {
    finalMessage.mockRejectedValueOnce(new FakeAnthropicError('request ended without sending any chunks'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model
      .structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 })
      .catch(() => undefined);

    expect(model.callLog).toHaveLength(1);
    expect(model.callLog[0]?.outcome).toBe('network_error');
  });

  it('a real APIError (BadRequestError) still takes its own specific path, not this one', async () => {
    // Confirms the new branch sits strictly after the specific ones: an
    // unrelated 400 in grammar mode still propagates as `request_failed`
    // via the existing `APIError` branch, not the bare-`AnthropicError` one.
    finalMessage.mockRejectedValueOnce(new FakeBadRequestError('messages.0.content: unexpected field'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const thrown = await model
      .structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 })
      .catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code: 'request_failed' });
    expect(model.callLog[0]?.schemaRefusal).toMatchObject({ status: 400, type: 'invalid_request_error' });
  });
});

/**
 * THE APPLICATION-OWNED DEADLINE.
 *
 * Proven from the SDK's own source (`client.mjs`'s `fetchWithTimeout`) that
 * `requestOptions.timeout` only ever bounded the call to `fetch()` itself —
 * cleared the moment headers arrived, seconds into a call that then streamed
 * for however long the provider felt like. A call configured with a
 * 240,000ms timeout ran for 1,060,592ms and left nothing in `callLog`,
 * because the old `logCall` only ran after a successful `record()`. These
 * tests hold the replacement to what it actually has to do: abort the
 * in-flight request at an absolute wall-clock deadline regardless of
 * whether the stream is silent or still emitting, never let that abort
 * create a second billed attempt, and log the attempt either way.
 *
 * The fake stream below is deliberately not `MessageStream` — it is the
 * smallest double that reproduces the one property the real SDK proved to
 * have: a caller-supplied `signal` rejects `finalMessage()` with
 * `Anthropic.APIUserAbortError` once fired, at any point, including one that
 * never otherwise resolves.
 */
describe('the application-owned deadline', () => {
  function hangingStream() {
    let capturedSignal: AbortSignal | undefined;
    const onCalls: string[] = [];
    let rejectFinal!: (error: unknown) => void;
    const finalPromise = new Promise<never>((_, reject) => {
      rejectFinal = reject;
    });
    stream.mockImplementationOnce((_params, options) => {
      capturedSignal = options?.signal;
      capturedSignal?.addEventListener('abort', () => {
        rejectFinal(new FakeAPIUserAbortError('Request was aborted.'));
      });
      return {
        on: vi.fn((event: string) => {
          onCalls.push(event);
        }),
        finalMessage: () => finalPromise,
      };
    });
    return { onCalls, signal: () => capturedSignal };
  }

  function deadlineCall(timeoutMs: number) {
    return new ResearchModel({ maxCalls: 5, maxRetries: 0 }).structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
      timeoutMs,
    });
  }

  /**
   * A stream that writes some of its answer, then never finishes.
   *
   * The live shape this exists for: two Kyrgyzstan runs on 2026-09-08 reached
   * the hundred-second deadline with 1,285 and 8,534 bytes of good JSON
   * already written, and both were discarded for a failure screen.
   */
  function partialStream(chunks: readonly string[]) {
    let capturedSignal: AbortSignal | undefined;
    let rejectFinal!: (error: unknown) => void;
    const finalPromise = new Promise<never>((_, reject) => {
      rejectFinal = reject;
    });
    /*
     * The salvage path resolves rather than rethrows, so nothing downstream
     * consumes this rejection. Attached here so a passing test does not also
     * report an unhandled rejection; the model has already seen it by then.
     */
    finalPromise.catch(() => undefined);
    stream.mockImplementationOnce((_params, options) => {
      capturedSignal = options?.signal;
      capturedSignal?.addEventListener('abort', () => rejectFinal(new FakeAPIUserAbortError('Request was aborted.')));
      return {
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (event === 'text') for (const chunk of chunks) listener(chunk);
        }),
        finalMessage: () => finalPromise,
      };
    });
    return { signal: () => capturedSignal };
  }

  function salvageCall(timeoutMs: number, salvage: boolean) {
    return new ResearchModel({ maxCalls: 5, maxRetries: 0 }).structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
      timeoutMs,
      salvagePartialOnDeadline: salvage,
    });
  }

  it('records where the bytes were on the clock, so a slow answer needs no second call', async () => {
    partialStream(['{"note":"', 'a plan that arrived"}']);
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const promise = model.structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000, timeoutMs: 5_000, salvagePartialOnDeadline: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
    const stream = model.callLog[0]!.stream;
    // The whole call is five seconds, so the thirty-second mark was never reached.
    expect(stream.visibleBytesAt30s).toBeNull();
    // The rate is measured over the writing window and is a real number.
    expect(stream.visibleBytesPerSecond === null || stream.visibleBytesPerSecond >= 0).toBe(true);
  });

  it('a caller that opted in gets the answer that had already arrived', async () => {
    partialStream(['{"note":"a plan', ' that arrived"}']);
    const promise = salvageCall(5_000, true);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual({ note: 'a plan that arrived' });
  });

  it('a partial the schema still refuses is a timeout, not a half-answer', async () => {
    partialStream(['{"unrelated":']);
    // The assertion is attached before the clock moves, as everywhere else in
    // this block: a rejection with no handler yet is an unhandled rejection.
    const outcome = expect(salvageCall(5_000, true)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
  });

  it('a caller that did not opt in is unaffected', async () => {
    partialStream(['{"note":"a plan that arrived"}']);
    const outcome = expect(salvageCall(5_000, false)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('force-aborts a stream that never finishes, at exactly the configured deadline', async () => {
    const fake = hangingStream();

    const outcome = expect(deadlineCall(5_000)).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('5000ms'),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;

    // The abort actually reached the in-flight call: the same signal object
    // the SDK was handed is the one that fired.
    expect(fake.signal()?.aborted).toBe(true);
  });

  it('cannot be extended by continuous activity — an absolute ceiling, not an idle-between-chunks watchdog', async () => {
    const fake = hangingStream();

    const outcome = expect(deadlineCall(5_000)).rejects.toMatchObject({ code: 'timeout' });
    // Advanced in increments, as if events kept arriving along the way. A
    // watchdog that reset on activity would never fire; this must still fire
    // at the same absolute total.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;

    expect(fake.signal()?.aborted).toBe(true);
  });

  it('does not resolve early, and only aborts once the deadline is actually reached', async () => {
    const fake = hangingStream();

    const promise = deadlineCall(5_000);
    let settled = false;
    promise.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    expect(fake.signal()?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
  });

  it('attempts the call exactly once — no SDK-level retry behind an abort', async () => {
    hangingStream();

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const outcome = expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;

    expect(stream).toHaveBeenCalledTimes(1);
    // The client itself was told not to retry — the other half of the
    // guarantee, enforced one layer below anything this file can call
    // directly (see `client.mjs`'s `makeRequest`, read as part of this
    // pass's own diagnosis: `retriesRemaining` starts at 0 and a caller
    // abort is checked, and thrown, before the retry branch is ever reached).
    expect(lastAnthropicConstructorOptions).toMatchObject({ maxRetries: 0 });
  });

  it('logs the aborted attempt in callLog, with token counts honestly unknown rather than zero', async () => {
    hangingStream();

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const outcome = expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        timeoutMs: 5_000,
        callLabel: 'generation',
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;

    expect(model.callLog).toHaveLength(1);
    expect(model.callLog[0]).toMatchObject({
      callLabel: 'generation',
      outcome: 'aborted_deadline',
      inputTokens: null,
      outputTokens: null,
      stopReason: null,
      attempt: 1,
    });
    expect(model.callLog[0]?.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(typeof model.callLog[0]?.startedAt).toBe('string');
    expect(typeof model.callLog[0]?.finishedAt).toBe('string');
  });

  it('still logs normal usage and a `completed` outcome for a call that answers in time', async () => {
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        timeoutMs: 5_000,
        callLabel: 'generation',
      }),
    ).resolves.toEqual({ note: 'fine' });

    expect(model.callLog).toHaveLength(1);
    expect(model.callLog[0]).toMatchObject({
      callLabel: 'generation',
      outcome: 'completed',
      inputTokens: 10,
      outputTokens: 20,
      stopReason: 'end_turn',
      requestId: 'req_test',
    });
    expect(model.callLog[0]?.responseBytes).toBeGreaterThan(0);
  });

  it('releases the deadline timer once a call completes, rather than leaving one armed', async () => {
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
      timeoutMs: 5_000,
    });

    // A timer left running after the call it belonged to already settled is
    // exactly the leak `clearTimeout` in `structured()`'s `finally` exists to
    // prevent.
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * THE THREE-SLOT BUDGET, PROVEN AT THE MECHANISM IT ACTUALLY RESTS ON.
   *
   * Phase 17's call policy — one generation, at most one structural re-ask,
   * at most one independently-reserved repair — is `hybrid.ts`'s own
   * orchestration (`reserveModelCalls(3, …)`, `maxCalls: 3`), not this
   * file's. What belongs here is the primitive that policy depends on:
   * `maxCalls`/`callsRemaining` grants three genuinely independent calls, so
   * a re-ask spending the second one never touches the third.
   */
  it('keeps a third call available after a first and second are both spent, so a re-ask never starves the reserved repair', async () => {
    const model = new ResearchModel({ maxCalls: 3, maxRetries: 0 });
    const base = {
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
    } as const;

    finalMessage.mockResolvedValueOnce(streamed('{"note":"a"}'));
    await model.structured({ ...base, callLabel: 'generation', attempt: 1 });
    expect(model.callsRemaining).toBe(2);

    finalMessage.mockResolvedValueOnce(streamed('{"note":"b"}'));
    await model.structured({ ...base, callLabel: 'structural_reask', attempt: 2 });
    // The slot a repair needs is still there — a re-ask spent its own slot,
    // not the one reserved independently for repair.
    expect(model.callsRemaining).toBe(1);

    finalMessage.mockResolvedValueOnce(streamed('{"note":"c"}'));
    await model.structured({ ...base, callLabel: 'repair', attempt: 1 });
    expect(model.callsRemaining).toBe(0);

    expect(model.callLog.map((entry) => entry.callLabel)).toEqual([
      'generation',
      'structural_reask',
      'repair',
    ]);
    expect(model.callLog.every((entry) => entry.outcome === 'completed')).toBe(true);
  });
});

/**
 * THE TRANSPORT-IDLE WATCHDOG, WIRED THROUGH `structured()` ITSELF.
 *
 * `anthropic-liveness.test.ts` drives the middleware directly with a real
 * SSE byte stream and proves pings tick the transport tracker; these tests
 * prove the *other* half — that `structured()` actually arms, resets and
 * fires the idle timer, classifies the result as `transport_idle_timeout`
 * distinctly from `aborted_deadline`, and never touches the re-ask/repair
 * budget when it does. The fake `stream()` mock never invokes the real
 * middleware (it is a plain `vi.fn()`, not `client.mjs`), which is exactly
 * equivalent to "no transport event of any kind ever arrives" — the case
 * these tests need.
 */
describe('the transport-idle watchdog', () => {
  const ORIGINAL_IDLE_MS = process.env[TRANSPORT_IDLE_TIMEOUT_ENV];

  function neverRespondingStream() {
    let capturedSignal: AbortSignal | undefined;
    let rejectFinal!: (error: unknown) => void;
    const finalPromise = new Promise<never>((_, reject) => {
      rejectFinal = reject;
    });
    stream.mockImplementationOnce((_params, options) => {
      capturedSignal = options?.signal;
      capturedSignal?.addEventListener('abort', () => {
        rejectFinal(new FakeAPIUserAbortError('Request was aborted.'));
      });
      // No `.on(...)` calls needed — nothing here ever fires an event, which
      // is the scenario itself: no bytes, no pings, forever.
      return { on: vi.fn(), finalMessage: () => finalPromise };
    });
    return { signal: () => capturedSignal };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_IDLE_MS === undefined) delete process.env[TRANSPORT_IDLE_TIMEOUT_ENV];
    else process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = ORIGINAL_IDLE_MS;
  });

  it('fires before the absolute deadline when no transport event ever arrives, and classifies distinctly', async () => {
    process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = '10000';
    neverRespondingStream();

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const outcome = expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        timeoutMs: 60_000, // far longer than the 10s idle threshold below
        callLabel: 'generation',
      }),
    ).rejects.toMatchObject({ code: 'timeout' });

    // Well past the 10s idle threshold, well short of the 60s deadline.
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;

    expect(model.callLog).toHaveLength(1);
    expect(model.callLog[0]?.outcome).toBe('transport_idle_timeout');
    expect(model.callLog[0]?.elapsedMs).toBeLessThan(60_000);
  });

  it('does not consume the structural-reask/repair budget — a third call is still available afterward', async () => {
    process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = '5000';
    neverRespondingStream();

    const model = new ResearchModel({ maxCalls: 3, maxRetries: 0 });
    const outcome = expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;

    // `callsRemaining` is a billed-usage ledger (`usage.calls`, which only
    // `record()` on a *successful* response increments) — a call that never
    // completed spends nothing from it, which is a stronger guarantee than
    // "one slot used": the aborted attempt leaves the whole budget intact
    // for hybrid.ts's own re-ask/repair policy to spend on its own terms,
    // rather than this one failed attempt having silently claimed a slot.
    expect(model.usage.calls).toBe(0);
    expect(model.callsRemaining).toBe(3);
  });

  it('leaves the absolute 240-second-class deadline in charge when the idle threshold is configured longer than it', async () => {
    // A transport that never goes idle for longer than a very generous
    // threshold — equivalent to "pings keep arriving forever" — must still
    // be bounded by the absolute deadline, which this proves by setting the
    // idle threshold longer than the deadline: nothing here can make the
    // idle timer fire first.
    process.env[TRANSPORT_IDLE_TIMEOUT_ENV] = '600000';
    neverRespondingStream();

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    const outcome = expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        timeoutMs: 8_000,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(8_000);
    await outcome;

    expect(model.callLog[0]?.outcome).toBe('aborted_deadline');
  });

  it('clears both the deadline and the idle timer on a normal completion — no leaked timers', async () => {
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
      timeoutMs: 60_000,
    });

    expect(model.callLog[0]?.outcome).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports the transport-liveness fields on a normal completion, distinct from model-event fields', async () => {
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
    });

    const entry = model.callLog[0];
    expect(entry?.stream).toMatchObject({
      // The fake harness never invokes the real middleware, so transport
      // activity is honestly zero here — the property under test is that
      // the fields exist and are structurally separate from the model-event
      // ones, not that this particular fake produced traffic.
      transportEventCount: 0,
      pingCount: 0,
      lastPingAtMs: null,
    });
    // Model-event fields still populate from the parsed stream, exactly as before.
    expect(entry?.stream?.eventCount).toBeGreaterThanOrEqual(0);
  });
});

/**
 * THE ONE-TIME GRAMMAR→PROMPT FALLBACK.
 *
 * A `grammar`-enforced request the provider refuses to compile is a
 * pre-generation `BadRequestError` — nothing generated, nothing billed. This
 * is a *transport*-layer fallback, not a second application-level attempt:
 * `hybrid.ts`'s call budget, and `logCall`'s own `attempt` field, see one
 * generation either way. `enforcementFallback` is the diagnostic that says
 * it happened.
 */
/**
 * THE CLASSIFIER ITSELF, IN ISOLATION FROM `structured()`'S RETRY LOOP.
 *
 * Every one of the provider's 400s carries the same generic `type` —
 * `'invalid_request_error'` — so `type` cannot be what this decides on
 * (`FakeBadRequestError` above sets it identically for every case below,
 * on purpose, to prove that). Only `error.message`, and only being a
 * `BadRequestError` at all, may decide it.
 */
describe('isStructuredOutputSchemaRefusal — the narrow classifier', () => {
  it('is true for the one refusal this codebase has actually observed live', () => {
    expect(isStructuredOutputSchemaRefusal(new FakeBadRequestError('the compiled grammar is too large'))).toBe(
      true,
    );
  });

  it('is true for other documented-concept phrasings of a schema-compilation refusal', () => {
    expect(isStructuredOutputSchemaRefusal(new FakeBadRequestError('Schema is too complex to compile.'))).toBe(
      true,
    );
    expect(
      isStructuredOutputSchemaRefusal(new FakeBadRequestError('recursive schema definitions are not supported')),
    ).toBe(true);
  });

  it('is false for an unrelated 400 — same status, same generic type, unrelated message', () => {
    expect(
      isStructuredOutputSchemaRefusal(new FakeBadRequestError('messages.0.content: unexpected field "foo"')),
    ).toBe(false);
    expect(isStructuredOutputSchemaRefusal(new FakeBadRequestError('max_tokens must be at least 1'))).toBe(false);
  });

  it('is false for the bare word "schema" without a compilation/support concept attached', () => {
    expect(isStructuredOutputSchemaRefusal(new FakeBadRequestError('the request schema was invalid'))).toBe(
      false,
    );
  });

  it('is false for a matching phrase on the wrong error type — status/type alone are not enough either way', () => {
    // A rate limit, a server error, a timeout: none of these are a
    // `BadRequestError` at all, regardless of what their message says.
    expect(isStructuredOutputSchemaRefusal(new FakeRateLimitError('the compiled grammar is too large'))).toBe(
      false,
    );
  });

  it('is false for a non-error value', () => {
    expect(isStructuredOutputSchemaRefusal(undefined)).toBe(false);
    expect(isStructuredOutputSchemaRefusal('the compiled grammar is too large')).toBe(false);
    expect(isStructuredOutputSchemaRefusal(new Error('the compiled grammar is too large'))).toBe(false);
  });
});

describe('the grammar→prompt fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function grammarCall(overrides: Partial<{ schemaEnforcement: 'grammar' | 'prompt' }> = {}) {
    return new ResearchModel({ maxCalls: 5, maxRetries: 0 }).structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
      ...overrides,
    });
  }

  it('retries once in prompt mode after a compiled-grammar rejection, and succeeds', async () => {
    stream.mockImplementationOnce(() => ({
      on: vi.fn(),
      finalMessage: () => Promise.reject(new FakeBadRequestError('the compiled grammar is too large')),
    }));
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        callLabel: 'generation',
      }),
    ).resolves.toEqual({ note: 'fine' });

    // Two HTTP attempts...
    expect(stream).toHaveBeenCalledTimes(2);
    // ...the second one now stating the schema in the prompt instead.
    const secondCallTask = String(stream.mock.calls[1]?.[0]?.messages.at(-1)?.content);
    expect(secondCallTask).toContain('JSON Schema');
    // ...but exactly one diagnostic entry, one attempt, one billed call — the
    // fallback is excluded from `usage.calls`/`attempt` accounting, but the
    // second HTTP request it made is fully visible in its own fields below.
    expect(model.callLog).toHaveLength(1);
    expect(model.callLog[0]?.attempt).toBe(1);
    expect(model.callLog[0]?.enforcementFallback).toBe(true);
    expect(model.callLog[0]?.outcome).toBe('completed');
    expect(model.usage.calls).toBe(1);
    // ...and the second request genuinely happened, in the diagnostics, not
    // just in `stream`'s own call count.
    expect(model.callLog[0]?.enforcementAttempted).toEqual(['grammar', 'prompt']);
    expect(model.callLog[0]?.schemaRefusal).toMatchObject({ status: 400, type: 'invalid_request_error' });
    expect(model.callLog[0]?.enforcementFallbackReason).toMatch(/retrying once in prompt mode/);
  });

  it('does not fall back when enforcement was already `prompt`', async () => {
    // A `BadRequestError` from a `prompt`-mode request is a different kind
    // of rejection (not a compiled-grammar one) and must not loop.
    stream.mockImplementationOnce(() => ({
      on: vi.fn(),
      finalMessage: () => Promise.reject(new FakeBadRequestError('some other 400')),
    }));

    await expect(grammarCall({ schemaEnforcement: 'prompt' })).rejects.toMatchObject({ code: 'request_failed' });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('does not fall back on an unrelated BadRequestError in grammar mode — propagates instead of retrying', async () => {
    stream.mockImplementationOnce(() => ({
      on: vi.fn(),
      finalMessage: () => Promise.reject(new FakeBadRequestError('messages.0.content: unexpected field "foo"')),
    }));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
      }),
    ).rejects.toMatchObject({ code: 'request_failed' });

    // Exactly one HTTP request — an unrelated 400 must not spend a second,
    // potentially billed, attempt on a retry that cannot succeed.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(model.callLog).toHaveLength(1);
    expect(model.callLog[0]?.enforcementFallback).toBe(false);
    expect(model.callLog[0]?.enforcementAttempted).toEqual(['grammar']);
    expect(model.callLog[0]?.schemaRefusal).toMatchObject({ status: 400, type: 'invalid_request_error' });
    expect(model.callLog[0]?.enforcementFallbackReason).toMatch(/not classified as a structured-output schema/);
    expect(model.callLog[0]?.outcome).toBe('network_error');
  });

  it('does not fall back on a network/server/rate-limit error — only a BadRequestError is eligible', async () => {
    stream.mockImplementationOnce(() => ({
      on: vi.fn(),
      finalMessage: () => Promise.reject(new FakeRateLimitError('slow down')),
    }));

    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(model.callLog[0]?.enforcementFallback).toBe(false);
    expect(model.callLog[0]?.enforcementAttempted).toEqual(['grammar']);
    // Never a `BadRequestError` at all, so the refusal-diagnostic fields
    // stay `null` rather than describing something that did not occur.
    expect(model.callLog[0]?.schemaRefusal).toBeNull();
    expect(model.callLog[0]?.enforcementFallbackReason).toBeNull();
  });

  it('does not loop on a second BadRequestError — bounded to exactly one fallback', async () => {
    stream.mockImplementationOnce(() => ({
      on: vi.fn(),
      finalMessage: () => Promise.reject(new FakeBadRequestError('the compiled grammar is too large')),
    }));
    stream.mockImplementationOnce(() => ({
      on: vi.fn(),
      finalMessage: () => Promise.reject(new FakeBadRequestError('rejected again in prompt mode too')),
    }));

    await expect(grammarCall()).rejects.toMatchObject({ code: 'request_failed' });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('records enforcementFallback: false on an ordinary completion', async () => {
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
    });
    expect(model.callLog[0]?.enforcementFallback).toBe(false);
    expect(model.callLog[0]?.enforcementAttempted).toEqual(['grammar']);
    expect(model.callLog[0]?.schemaRefusal).toBeNull();
    expect(model.callLog[0]?.enforcementFallbackReason).toBeNull();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('does not consume the deadline or idle-watchdog timers a second time — both still clear on the fallback path', async () => {
    stream.mockImplementationOnce(() => ({
      on: vi.fn(),
      finalMessage: () => Promise.reject(new FakeBadRequestError('the compiled grammar is too large')),
    }));
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));

    await grammarCall();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * THINKING-TOKEN ACCOUNTING — OPERATIONAL COUNTS ONLY.
 */
describe('thinking-token diagnostics', () => {
  it('splits output tokens when the provider reports output_tokens_details', async () => {
    finalMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"note":"fine"}' }],
      stop_reason: 'end_turn',
      usage: { ...USAGE, output_tokens: 100, output_tokens_details: { thinking_tokens: 80 } },
      _request_id: 'req_test',
    });
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
    });
    expect(model.callLog[0]?.outputTokens).toBe(100);
    expect(model.callLog[0]?.thinkingTokens).toBe(80);
    expect(model.callLog[0]?.nonThinkingOutputTokens).toBe(20);
  });

  it('reports null, not zero, when the provider does not supply output_tokens_details', async () => {
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({
      promptVersion: 'test/1',
      instruction: 'test',
      task: 'test',
      schema,
      maxTokens: 64_000,
    });
    expect(model.callLog[0]?.thinkingTokens).toBeNull();
    expect(model.callLog[0]?.nonThinkingOutputTokens).toBeNull();
    expect(model.callLog[0]?.outputTokens).toBe(20);
  });

  it('never carries thinking content — only the SSE listener count, no text', () => {
    // Structural guarantee, not a runtime assertion: `structured()` never
    // registers a `'thinking'` listener at all (see its own comment beside
    // the `stream.on(...)` calls), so there is no code path here that could
    // capture thinking text even accidentally.
    const path = new URL('./anthropic.ts', import.meta.url).pathname;
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/stream\.on\(\s*['"]thinking['"]/);
  });
});

/**
 * THE `normalize` HOOK — ONE GENERATION, NOT TWO, OVER A COSMETIC DEFECT.
 *
 * `normalizeBaselineGeneration` itself is exercised directly in
 * `benchmark/baseline/generate.test.ts`; what belongs here is the piece
 * only `structured()` can prove — that a caller-supplied `normalize` runs
 * before `schema.safeParse`, in the same HTTP call, so a field that is
 * over-length but otherwise clean does not cost a second, potentially
 * billed, generation the way an uncaught `malformed_output` would.
 */
describe('the normalize hook — cosmetic fields fixed before strict validation, without a second call', () => {
  const clipNote = (raw: unknown) => {
    const record = raw as { note?: unknown };
    if (typeof record.note === 'string' && record.note.length > 40) {
      return { value: { ...record, note: record.note.slice(0, 40) }, normalizedFields: ['note'] };
    }
    return { value: raw, normalizedFields: [] };
  };

  it('without normalize, an over-length but otherwise-clean field is a hard failure', async () => {
    finalMessage.mockResolvedValueOnce(streamed(JSON.stringify({ note: 'x'.repeat(45) })));
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 }),
    ).rejects.toMatchObject({ code: 'malformed_output' });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('with normalize, the same response is accepted in the same call — no second request', async () => {
    finalMessage.mockResolvedValueOnce(streamed(JSON.stringify({ note: 'x'.repeat(45) })));
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        normalize: clipNote,
      }),
    ).resolves.toEqual({ note: 'x'.repeat(40) });

    // One HTTP request, one logged call, one billed generation — a cosmetic
    // fix, not a re-ask.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(model.callLog).toHaveLength(1);
    expect(model.usage.calls).toBe(1);
    expect(model.callLog[0]?.normalizedFields).toEqual(['note']);
    expect(model.callLog[0]?.outcome).toBe('completed');
  });

  /**
   * THE FIX, PROVEN DIRECTLY: NORMALIZATION NOW REACHES THE SKELETON'S OWN
   * TOKEN CEILING.
   *
   * `SKELETON_MAX_TOKENS` is 9,000 — comfortably under the old 16,000
   * threshold that used to route a call like this through
   * `client.messages.parse()` instead, where `normalize` never ran at all
   * (`ResearchModel.structured`'s own prior comment said so explicitly).
   * This is the exact scenario the TripSkeleton replay hit blind to: a
   * cosmetic-only violation on a small call, now rescued in the same
   * request rather than surfacing as an unclassified failure.
   */
  it('applies at maxTokens: 9,000 — the skeleton composer’s own ceiling, once below the old streaming threshold', async () => {
    finalMessage.mockResolvedValueOnce(streamed(JSON.stringify({ note: 'x'.repeat(45) })));
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 9_000,
        normalize: clipNote,
      }),
    ).resolves.toEqual({ note: 'x'.repeat(40) });

    expect(parse).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(model.callLog[0]?.normalizedFields).toEqual(['note']);
    expect(model.callLog[0]?.outcome).toBe('completed');
  });

  it('a violation normalize declines to touch still fails strict validation, exactly as before', async () => {
    // `clipNote` only ever touches `note`; a schema violation on a
    // different, hypothetical field would pass through unchanged and still
    // be rejected — proven here by a `note` so long that clipping to 40
    // characters is the only thing standing between "fails" and "passes",
    // withheld by using a normalize that refuses to act (returns the input
    // unchanged) to show the failure path still exists when normalization
    // does not apply.
    finalMessage.mockResolvedValueOnce(streamed(JSON.stringify({ note: 'x'.repeat(45) })));
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await expect(
      model.structured({
        promptVersion: 'test/1',
        instruction: 'test',
        task: 'test',
        schema,
        maxTokens: 64_000,
        normalize: (raw) => ({ value: raw, normalizedFields: [] }),
      }),
    ).rejects.toMatchObject({ code: 'malformed_output' });
    expect(model.callLog[0]?.normalizedFields).toEqual([]);
  });

  it('records [] , not undefined, when no normalize is supplied at all', async () => {
    finalMessage.mockResolvedValueOnce(streamed('{"note":"fine"}'));
    const model = new ResearchModel({ maxCalls: 5, maxRetries: 0 });
    await model.structured({ promptVersion: 'test/1', instruction: 'test', task: 'test', schema, maxTokens: 64_000 });
    expect(model.callLog[0]?.normalizedFields).toEqual([]);
  });
});
