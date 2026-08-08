import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResearchModel as ResearchModelClass } from './anthropic';

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
const stream = vi.fn((_params: SentRequest, _options?: unknown) => ({ finalMessage }));

class FakeAPIError extends Error {}
class FakeRateLimitError extends FakeAPIError {}

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { parse, stream };
  }
  return {
    default: Object.assign(FakeAnthropic, {
      APIError: FakeAPIError,
      RateLimitError: FakeRateLimitError,
    }),
  };
});

/*
 * Stands in for the real converter, and deliberately emits a schema with no
 * `pattern` in it — which is what the real one does too. That omission is the
 * reason the answer has to be re-validated locally, so a stub that quietly
 * included the pattern would hide the very gap these tests cover.
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

beforeEach(async () => {
  vi.resetModules();
  parse.mockReset();
  stream.mockClear();
  finalMessage.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-credential';
  ({ ResearchModel } = await import('./anthropic'));
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

  it('leaves the small calls on the simpler path', async () => {
    parse.mockResolvedValue({ parsed_output: { note: 'fine' }, usage: USAGE, stop_reason: 'end_turn' });

    await expect(call(8192)).resolves.toEqual({ note: 'fine' });

    expect(parse).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
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
});
