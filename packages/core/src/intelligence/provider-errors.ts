import { z } from 'zod';

/**
 * PROVIDER FAILURES, NORMALISED.
 *
 * Ten reasons that are not interchangeable. What a traveller reads for each
 * is fixed here so that a timeout can never be worded as "this place does not
 * exist" and "no route" is only ever said when a router said it.
 */
export const PROVIDER_ERROR_REASONS = [
  'not_found',
  'no_route',
  'unsupported',
  'unauthorized',
  'quota',
  'rate_limited',
  'timeout',
  'provider_error',
  'invalid_request',
  'temporarily_unavailable',
] as const;
export const providerErrorReasonSchema = z.enum(PROVIDER_ERROR_REASONS);
export type ProviderErrorReason = z.infer<typeof providerErrorReasonSchema>;

export class ProviderFailure extends Error {
  constructor(
    readonly reason: ProviderErrorReason,
    readonly provider: string,
    message?: string,
    readonly status?: number,
  ) {
    super(message ?? `${provider}: ${reason}`);
    this.name = 'ProviderFailure';
  }
}

/** What each failure means for the trip. None of them is "impossible". */
export const PROVIDER_ERROR_DEGRADATION: Record<ProviderErrorReason, { traveller: string; claimState: 'unverified' | 'contradicted'; retryable: boolean }> = {
  not_found: { traveller: 'Sidequest could not independently resolve this.', claimState: 'unverified', retryable: false },
  no_route: { traveller: 'The route provider found no way to make this journey by that mode.', claimState: 'contradicted', retryable: false },
  unsupported: { traveller: 'Sidequest cannot check this kind of journey yet.', claimState: 'unverified', retryable: false },
  unauthorized: { traveller: 'Verification is unavailable right now.', claimState: 'unverified', retryable: false },
  quota: { traveller: 'Verification is unavailable right now.', claimState: 'unverified', retryable: true },
  rate_limited: { traveller: 'Verification is unavailable right now.', claimState: 'unverified', retryable: true },
  timeout: { traveller: 'Verification did not finish in time.', claimState: 'unverified', retryable: true },
  provider_error: { traveller: 'Verification is unavailable right now.', claimState: 'unverified', retryable: true },
  invalid_request: { traveller: 'Sidequest could not check this.', claimState: 'unverified', retryable: false },
  temporarily_unavailable: { traveller: 'Verification is unavailable right now.', claimState: 'unverified', retryable: true },
};

/** Map an HTTP status to the reason a provider most likely meant. */
export function reasonFromStatus(status: number): ProviderErrorReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 402) return 'quota';
  if (status === 503 || status === 502 || status === 504) return 'temporarily_unavailable';
  return 'provider_error';
}

/** A provider failure is never a physical impossibility. */
export function isPhysicalImpossibility(reason: ProviderErrorReason): boolean {
  return reason === 'no_route';
}
