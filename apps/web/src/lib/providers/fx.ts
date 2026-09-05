import { z } from 'zod';
import { ProviderFailure, reasonFromStatus, type FxRate } from '@sidequest/core';

/**
 * FX — A REFERENCE RATE WITH A DATE ON IT.
 *
 * Frankfurter republishes the European Central Bank's daily reference rates
 * (documented at https://www.frankfurter.app/docs/): `GET /latest?from=USD&to=EUR`
 * answers `{ amount, base, date, rates: { EUR: 0.92 } }`. That is the whole
 * contract Sidequest uses. No historical or future rate is ever invented: the
 * answer carries the ECB's own date.
 */
const FRANKFURTER_BASE = 'https://api.frankfurter.app';
const REQUEST_TIMEOUT_MS = 6_000;

const responseSchema = z.object({
  amount: z.number(),
  base: z.string(),
  date: z.string(),
  rates: z.record(z.string(), z.number()),
});

export type FxProviderChoice = 'frankfurter' | 'fixture' | 'off';

export function fxProviderChoice(env: Record<string, string | undefined> = process.env): FxProviderChoice {
  const raw = (env.SIDEQUEST_FX_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'frankfurter' || raw === 'fixture' ? raw : 'off';
}

/** Fixture rates for zero-spend development. Dated, so nothing pretends to be today's rate. */
export const FIXTURE_FX: Record<string, number> = { 'USD>EUR': 0.92, 'USD>GBP': 0.78, 'USD>ISK': 138, 'USD>JPY': 149, 'EUR>USD': 1.09, 'GBP>USD': 1.28, 'EUR>GBP': 0.85 };

export async function fetchReferenceRate(base: string, quote: string, options: { fetchImpl?: typeof fetch; choice?: FxProviderChoice; now?: Date } = {}): Promise<FxRate | null> {
  const choice = options.choice ?? fxProviderChoice();
  if (choice === 'off') return null;
  if (base === quote) return { base, quote, rate: 1, asOf: (options.now ?? new Date()).toISOString().slice(0, 10), source: 'identity' };
  if (choice === 'fixture') {
    const rate = FIXTURE_FX[`${base}>${quote}`];
    return rate ? { base, quote, rate, asOf: '2026-09-01', source: 'fixture' } : null;
  }
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${FRANKFURTER_BASE}/latest?from=${encodeURIComponent(base)}&to=${encodeURIComponent(quote)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' } });
  } catch (error) {
    throw new ProviderFailure(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'provider_error', 'frankfurter');
  }
  if (!response.ok) throw new ProviderFailure(reasonFromStatus(response.status), 'frankfurter', undefined, response.status);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ProviderFailure('provider_error', 'frankfurter', 'Unexpected response shape.');
  const rate = parsed.data.rates[quote];
  if (rate === undefined) throw new ProviderFailure('not_found', 'frankfurter', `${quote} is not a currency the ECB publishes.`);
  return { base: parsed.data.base, quote, rate, asOf: parsed.data.date, source: 'ECB via Frankfurter' };
}
