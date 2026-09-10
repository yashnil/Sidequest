/**
 * WHICH MODEL COMPOSES A TRIP, AND HOW HARD IT THINKS.
 *
 * PRODUCTION LOCK V5. Read straight from the environment with a documented
 * default, so the one canonical generation path does not have to import a
 * benchmark module to learn its own model id. `generate.ts` re-exports these
 * for the benchmark, which is the direction the dependency belongs in.
 */
export const COMPOSER_MODEL_ENV = 'SIDEQUEST_COMPOSER_MODEL';
export const COMPOSER_EFFORT_ENV = 'SIDEQUEST_COMPOSER_EFFORT';
export const DEFAULT_COMPOSER_MODEL = 'claude-sonnet-5';
const DEFAULT_COMPOSER_EFFORT: 'low' | 'medium' | 'high' = 'high';

export function composerModel(): string {
  return process.env[COMPOSER_MODEL_ENV]?.trim() || DEFAULT_COMPOSER_MODEL;
}

/**
 * The reasoning effort the *benchmark* composer's first attempt should use.
 *
 * The canonical composition call has its own, deliberately different, setting
 * (`compositionEffort()` in `composition.ts`, defaulting to `low` on measured
 * latency grounds). This one belongs to the baseline generator.
 */
export function composerEffort(): 'low' | 'medium' | 'high' {
  const raw = process.env[COMPOSER_EFFORT_ENV]?.trim();
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return DEFAULT_COMPOSER_EFFORT;
}
