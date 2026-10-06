import { z } from 'zod';
import { ProviderFailure, reasonFromStatus, type FxRate } from '@sidequest/core';
import { CACHE_TTL_MS, cacheKeyFor } from './cache-policy';

/**
 * FX — A REFERENCE RATE WITH A DATE ON IT.
 *
 * Frankfurter republishes the European Central Bank's daily reference rates
 * (documented at https://frankfurter.dev): `GET /v1/latest?from=USD&to=EUR,JPY`
 * answers `{ amount, base, date, rates: { EUR: 0.92, JPY: 149 } }`. That is the
 * whole contract Sidequest uses. No historical or future rate is ever invented:
 * the answer carries the ECB's own date.
 *
 * V1 CONVERGENCE — ON BY DEFAULT. It is keyless and free, it is asked at most
 * once per generation (one request for every currency the budget needs), and an
 * answer is reused in-process for a day. `SIDEQUEST_FX_PROVIDER=off` turns it
 * off and `fixture` serves the dated table below. A currency the ECB does not
 * publish (VND, KGS, …) is never requested and never guessed: the budget stays
 * in US dollars and says no conversion was applied.
 */
const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';
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
  if (raw === '') return 'frankfurter';
  return raw === 'frankfurter' || raw === 'fixture' ? raw : 'off';
}

/** The currencies the ECB publishes a daily reference rate for (Frankfurter's `/currencies`, read 2026-10-06). */
export const ECB_CURRENCIES: ReadonlySet<string> = new Set(['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR']);

/** Fixture rates for zero-spend development. Dated, so nothing pretends to be today's rate. */
export const FIXTURE_FX: Record<string, number> = { 'USD>EUR': 0.92, 'USD>GBP': 0.78, 'USD>ISK': 138, 'USD>JPY': 149, 'USD>CHF': 0.88, 'USD>CAD': 1.36, 'EUR>USD': 1.09, 'GBP>USD': 1.28, 'EUR>GBP': 0.85 };

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

const cache = new Map<string, { at: number; rates: FxRate[] }>();

/**
 * Every USD-based (or other-based) reference rate the budget needs, in ONE
 * request. Currencies the ECB does not publish are dropped before asking and
 * simply absent from the answer; the caller treats absence as "no conversion".
 * Answers are cached in-process for the `fx` cache class's TTL (a day).
 */
export async function fetchReferenceRates(base: string, quotes: readonly string[], options: { fetchImpl?: typeof fetch; choice?: FxProviderChoice; now?: Date } = {}): Promise<FxRate[]> {
  const choice = options.choice ?? fxProviderChoice();
  if (choice === 'off') return [];
  const wanted = [...new Set(quotes.map((q) => q.toUpperCase()))].filter((q) => q !== base).sort();
  if (wanted.length === 0) return [];
  if (choice === 'fixture') return wanted.flatMap((quote) => (FIXTURE_FX[`${base}>${quote}`] ? [{ base, quote, rate: FIXTURE_FX[`${base}>${quote}`]!, asOf: '2026-09-01', source: 'fixture' }] : []));
  const askable = ECB_CURRENCIES.has(base) ? wanted.filter((q) => ECB_CURRENCIES.has(q)) : [];
  if (askable.length === 0) return [];
  const now = options.now ?? new Date();
  const key = cacheKeyFor('fx', [base, askable.join(',')], { date: now.toISOString().slice(0, 10) });
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_TTL_MS.fx) return hit.rates;
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${FRANKFURTER_BASE}/latest?from=${encodeURIComponent(base)}&to=${askable.map(encodeURIComponent).join(',')}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json' } });
  } catch (error) {
    throw new ProviderFailure(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'provider_error', 'frankfurter');
  }
  if (!response.ok) throw new ProviderFailure(reasonFromStatus(response.status), 'frankfurter', undefined, response.status);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new ProviderFailure('provider_error', 'frankfurter', 'Unexpected response shape.');
  const rates = askable.flatMap((quote) => {
    const rate = parsed.data.rates[quote];
    return rate !== undefined && rate > 0 ? [{ base: parsed.data.base, quote, rate, asOf: parsed.data.date, source: 'ECB via Frankfurter' }] : [];
  });
  cache.set(key, { at: now.getTime(), rates });
  return rates;
}

/** Test seam: forget cached answers. */
export function clearFxCache(): void {
  cache.clear();
}
