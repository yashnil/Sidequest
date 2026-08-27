import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchModel, ResearchModelError } from './anthropic';

/**
 * A DEAD CREDENTIAL IS A CONFIGURATION FACT, NOT A BAD MINUTE.
 *
 * Twelve live builds ran against a rejected key: every research call 401'd,
 * every stage caught the failure as it catches a transient one, recorded a gap
 * and degraded — and the builds shipped as quiet `partial` artifacts with zero
 * extracted facts while still charging the day's allowance. Nothing anywhere
 * distinguished "this key will fail every call until an operator acts" from
 * "the provider had a bad minute".
 *
 * The transport is the one place that sees the provider's own verdict, so the
 * distinction is made here: an authentication/permission rejection throws its
 * own error code, is counted on the usage ledger the runner reads
 * (`authFailures`), and latches — the second call is refused on the spot
 * rather than billed against a key known to be dead. A transient 5xx keeps the
 * `request_failed` path and its bounded degradation, which is asserted beside
 * the new behaviour so only the auth class became fatal.
 *
 * The client is stubbed at the instance seam rather than the module: the error
 * classes must be the SDK's real ones, because `instanceof` against them is
 * the classification under test.
 */

/** A real SDK error by prototype, without depending on constructor shape. */
type ProviderApiError = InstanceType<typeof Anthropic.APIError>;

function apiError(
  kind: 'authentication' | 'permission' | 'server' | 'rate_limit',
): ProviderApiError {
  const prototypes = {
    authentication: Anthropic.AuthenticationError.prototype,
    permission: Anthropic.PermissionDeniedError.prototype,
    server: Anthropic.InternalServerError.prototype,
    rate_limit: Anthropic.RateLimitError.prototype,
  } as const;
  const statuses = { authentication: 401, permission: 403, server: 500, rate_limit: 429 } as const;
  const types = {
    authentication: 'authentication_error',
    permission: 'permission_error',
    server: 'api_error',
    rate_limit: 'rate_limit_error',
  } as const;
  return Object.assign(Object.create(prototypes[kind]) as ProviderApiError, {
    status: statuses[kind],
    type: types[kind],
    message: `stub ${types[kind]}`,
    requestID: 'req_test',
  });
}

/** A model whose client throws the given error, counting attempts on the wire. */
function modelThatThrows(error: unknown): { model: ResearchModel; wire: { calls: number } } {
  process.env.ANTHROPIC_API_KEY = 'sk-test-never-a-real-key';
  const model = new ResearchModel({ maxCalls: 10, maxRetries: 0 });
  const wire = { calls: 0 };
  const thrower = async () => {
    wire.calls += 1;
    throw error;
  };
  (model as unknown as { client: { messages: unknown } }).client.messages = {
    parse: thrower,
    create: thrower,
    stream: () => ({ finalMessage: thrower }),
  };
  return { model, wire };
}

const { z } = await import('zod');
const ASK = {
  promptVersion: 'test/1',
  instruction: 'test',
  task: 'test',
  schema: z.object({ ok: z.boolean() }),
};

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('what the transport does with a rejected credential', () => {
  it('throws its own code for a 401 and counts it where the runner reads', async () => {
    const { model } = modelThatThrows(apiError('authentication'));

    const thrown = await model.structured(ASK).catch((error) => error as ResearchModelError);
    expect(thrown).toBeInstanceOf(ResearchModelError);
    expect((thrown as ResearchModelError).code).toBe('auth_rejected');
    expect(model.usage.authFailures).toBe(1);
  });

  it('treats a 403 permission rejection the same way', async () => {
    const { model } = modelThatThrows(apiError('permission'));

    const thrown = await model.structured(ASK).catch((error) => error as ResearchModelError);
    expect((thrown as ResearchModelError).code).toBe('auth_rejected');
    expect(model.usage.authFailures).toBe(1);
  });

  it('latches: the second call is refused without touching the wire', async () => {
    const { model, wire } = modelThatThrows(apiError('authentication'));

    await model.structured(ASK).catch(() => undefined);
    const second = await model.structured(ASK).catch((error) => error as ResearchModelError);

    expect((second as ResearchModelError).code).toBe('auth_rejected');
    // One wire attempt, not two: a key known dead is not retried per stage.
    expect(wire.calls).toBe(1);
  });

  it('latches the search door too, in both directions', async () => {
    const { model, wire } = modelThatThrows(apiError('authentication'));

    const search = { promptVersion: 'test/1', instruction: 'test', task: 'test', maxSearches: 2 };
    const thrown = await model.search(search).catch((error) => error as ResearchModelError);
    expect((thrown as ResearchModelError).code).toBe('auth_rejected');

    await model.structured(ASK).catch(() => undefined);
    expect(wire.calls).toBe(1);
  });

  it('keeps a transient 500 on the degradation path, uncounted and unlatched', async () => {
    const { model, wire } = modelThatThrows(apiError('server'));

    const first = await model.structured(ASK).catch((error) => error as ResearchModelError);
    expect((first as ResearchModelError).code).toBe('request_failed');
    expect(model.usage.authFailures).toBe(0);

    // A second attempt still reaches the wire — bounded degradation, preserved.
    await model.structured(ASK).catch(() => undefined);
    expect(wire.calls).toBe(2);
  });

  it('keeps a rate limit on its own path, uncounted and unlatched', async () => {
    const { model } = modelThatThrows(apiError('rate_limit'));

    const thrown = await model.structured(ASK).catch((error) => error as ResearchModelError);
    expect((thrown as ResearchModelError).code).toBe('rate_limited');
    expect(model.usage.authFailures).toBe(0);
  });
});
