import { describe, expect, it } from 'vitest';
import {
  BUILD_FAILURE_CAUSES,
  BUILD_FAILURE_VARIANTS,
  buildFailure,
  classifyCompositionFailure,
  classifyModelError,
  decodeBuildFailure,
  encodeBuildFailure,
} from './build-failure';

/**
 * V1 CONVERGENCE — THE BUILD FAILURE TAXONOMY.
 *
 * Every way a build can fail reaches the traveller as its own plain sentence
 * with an honest retry, and none of those sentences can carry operator detail:
 * no environment variable, no vendor, no status code, no stack.
 */

const every = [
  ...BUILD_FAILURE_CAUSES.map((cause) => buildFailure(cause)),
  ...BUILD_FAILURE_VARIANTS.map((variant) => buildFailure(variant === 'daily_allowance' ? 'provider_quota_or_limit' : 'composer_not_configured', variant)),
];

describe('traveller copy', () => {
  it('never names an environment variable, a vendor, a status code or a stack', () => {
    for (const failure of every) {
      const words = `${failure.heading} ${failure.message} ${failure.nextAction?.label ?? ''}`;
      expect(words, failure.cause).not.toMatch(/SIDEQUEST_|ANTHROPIC_|GOOGLE_|OPENROUTESERVICE/);
      expect(words, failure.cause).not.toMatch(/anthropic|claude|openai|valhalla|nominatim|fixture|zod|schema|api key|credential/i);
      expect(words, failure.cause).not.toMatch(/\b[45]\d\d\b|\bat \w+ \(|Error:|stack/);
      expect(failure.heading.length).toBeGreaterThan(0);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it('offers a retry only where pressing it can change the outcome', () => {
    expect(buildFailure('composer_not_configured').retryable).toBe(false);
    expect(buildFailure('composer_not_configured', 'fixtures_refused').retryable).toBe(false);
    expect(buildFailure('provider_auth_failure').retryable).toBe(false);
    expect(buildFailure('provider_quota_or_limit', 'daily_allowance').retryable).toBe(false);
    expect(buildFailure('provider_quota_or_limit').retryable).toBe(true);
    expect(buildFailure('provider_timeout').retryable).toBe(true);
    expect(buildFailure('provider_unavailable').retryable).toBe(true);
    expect(buildFailure('invalid_model_response').retryable).toBe(true);
    expect(buildFailure('internal_generation_error').retryable).toBe(true);
  });

  it('a site that cannot build says so, and says nothing was lost', () => {
    const failure = buildFailure('composer_not_configured');
    expect(failure.heading).toMatch(/can’t build trips right now/);
    expect(failure.message).toMatch(/Nothing was lost/);
  });

  it('the daily allowance reads differently from a busy vendor', () => {
    expect(buildFailure('provider_quota_or_limit', 'daily_allowance').message).toMatch(/tomorrow/);
    expect(buildFailure('provider_quota_or_limit').message).not.toMatch(/tomorrow/);
  });
});

describe('persistence', () => {
  it('round-trips a cause and a variant, and refuses anything else', () => {
    for (const failure of every) {
      const decoded = decodeBuildFailure(encodeBuildFailure(failure));
      expect(decoded?.cause).toBe(failure.cause);
      expect(decoded?.variant).toBe(failure.variant);
    }
    expect(decodeBuildFailure(null)).toBeNull();
    expect(decodeBuildFailure('before_model')).toBeNull();
    expect(decodeBuildFailure('provider_timeout/nonsense')?.variant).toBeUndefined();
  });
});

describe('classifyModelError', () => {
  const error = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);
  it('maps the transport’s codes and statuses to causes', () => {
    expect(classifyModelError(error({ status: 401 }))).toBe('provider_auth_failure');
    expect(classifyModelError(error({ status: 403 }))).toBe('provider_auth_failure');
    expect(classifyModelError(error({ code: 'auth_rejected' }))).toBe('provider_auth_failure');
    expect(classifyModelError(error({ code: 'not_configured' }))).toBe('composer_not_configured');
    expect(classifyModelError(error({ status: 429 }))).toBe('provider_quota_or_limit');
    expect(classifyModelError(error({ code: 'rate_limited' }))).toBe('provider_quota_or_limit');
    expect(classifyModelError(error({ code: 'timeout' }))).toBe('provider_timeout');
    expect(classifyModelError(error({ name: 'AbortError' }))).toBe('provider_timeout');
    expect(classifyModelError(error({ name: 'APIConnectionTimeoutError' }))).toBe('provider_timeout');
    expect(classifyModelError(error({ status: 500 }))).toBe('provider_unavailable');
    expect(classifyModelError(error({ status: 529 }))).toBe('provider_unavailable');
    expect(classifyModelError(error({ code: 'request_failed', httpStatus: 503 }))).toBe('provider_unavailable');
    expect(classifyModelError(error({ code: 'request_failed' }))).toBe('provider_unavailable');
    expect(classifyModelError(error({ code: 'malformed_output' }))).toBe('invalid_model_response');
    expect(classifyModelError(error({ name: 'ZodError' }))).toBe('invalid_model_response');
    expect(classifyModelError(error({ code: 'request_failed', httpStatus: 400 }))).toBe('internal_generation_error');
    expect(classifyModelError(new TypeError('cannot read x of undefined'))).toBe('internal_generation_error');
    expect(classifyModelError('a string')).toBe('internal_generation_error');
    expect(classifyModelError(null)).toBe('internal_generation_error');
  });
});

describe('classifyCompositionFailure', () => {
  it('reads what the transport said before what the composition folded it into', () => {
    /* A rate limit arrives as `malformed_output` from the composition; it is not a malformed draft. */
    expect(classifyCompositionFailure({ failureKind: 'malformed_output', providerCode: 'rate_limited' })).toBe('provider_quota_or_limit');
    expect(classifyCompositionFailure({ failureKind: 'malformed_output', providerCode: 'request_failed', providerStatus: 529 })).toBe('provider_unavailable');
    expect(classifyCompositionFailure({ failureKind: 'malformed_output', providerCode: 'request_failed' })).toBe('provider_unavailable');
    expect(classifyCompositionFailure({ failureKind: 'model_unavailable', providerCode: 'auth_rejected' })).toBe('provider_auth_failure');
    expect(classifyCompositionFailure({ failureKind: 'model_unavailable', providerCode: 'not_configured' })).toBe('composer_not_configured');
    expect(classifyCompositionFailure({ failureKind: 'timeout', providerCode: 'timeout' })).toBe('provider_timeout');
  });

  it('a draft that did not parse or normalise is an invalid response; a spent ceiling is ours', () => {
    expect(classifyCompositionFailure({ failureKind: 'malformed_output' })).toBe('invalid_model_response');
    expect(classifyCompositionFailure({ failureKind: 'malformed_output', providerCode: 'malformed_output' })).toBe('invalid_model_response');
    /* A plain Error thrown by a composer (the fixture's `unbuildable`) carries no code. */
    expect(classifyCompositionFailure({ failureKind: 'malformed_output', providerCode: null })).toBe('invalid_model_response');
    expect(classifyCompositionFailure({ failureKind: 'budget_exhausted' })).toBe('internal_generation_error');
  });
});
