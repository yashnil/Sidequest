/**
 * WHAT A FREE STRING FROM A MODEL MAY CONTAIN.
 *
 * PRODUCTION LOCK V5. These two patterns are the canonical definitions and
 * they live here, on the production planning path, because that is where they
 * are load-bearing: `trip-draft.ts` validates every prose field in the trip a
 * traveller reads against `SAFE_PROSE_PATTERN`, and every base slug against
 * `SAFE_SLUG_PATTERN`.
 *
 * They used to live in `benchmark/baseline/generate.ts`, which meant the one
 * canonical itinerary schema imported a benchmark module to know what safe
 * prose is. The benchmark still uses them — it re-exports these — but the
 * dependency now points the right way: benchmark may depend on the product,
 * never the reverse (`benchmark-isolation.test.ts`).
 *
 * A whole-string negative lookahead rather than a sanitiser, because a schema
 * that *rejects* is auditable and a sanitiser that *strips* is a place for a
 * bypass to hide.
 */
export const SAFE_PROSE_PATTERN =
  /^(?![\s\S]*(?::\/\/|javascript:|data:|vbscript:|file:|mailto:|www\.))[^<>]*$/;

/** Identifiers the model mints to tie a day to a base. Letters, digits, dashes. */
export const SAFE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
