/**
 * V8 — sentences shared by the questionnaire's server actions and its client,
 * in a module with no directive so both sides can import them. (A `'use
 * server'` file may export only async functions; a `'use client'` module's
 * exports become client references when a server module imports them.)
 */

/** The sentence for a client that is behind the stored answers. Never a stack, never a version. */
export const STALE_ANSWERS_MESSAGE = 'Your answers were updated somewhere else — in another tab, or before this page was refreshed. Nothing was overwritten. Reload to carry on from the latest.';
