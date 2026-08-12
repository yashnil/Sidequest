// Stands in for the `server-only` package inside the compile worker, exactly
// as `vitest.server-only.ts` does under Vitest: the guard exists to keep
// server modules out of client bundles, and a dedicated Node worker process is
// the most server-side context there is. See `compile-worker.mjs`.
export {};
