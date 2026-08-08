/**
 * WORDS THE BLIND SURFACE MAY NOT CONTAIN, AND THE ONES IT USES INSTEAD.
 *
 * A reviewer rating two trip plans must not be able to tell which system made
 * which, and the automated half of that guarantee is this list plus the two
 * tests that assert against it: a source scan over the benchmark routes and
 * components, and a scan over the entire rendered response body — markup, hidden
 * attributes and the serialised page payload alike, because a value handed to a
 * client component is shipped to the browser whether or not it is rendered.
 *
 * The list is deliberately wider than the obvious names. Three kinds of thing
 * leak identity and only the first is guessable:
 *
 * - **Product and vendor names.** Straightforward.
 * - **Architecture words.** "deterministic", "AI-generated", "prompt", "model",
 *   "scheduler". A reviewer who reads either on a page knows what they are
 *   looking at even without a brand name.
 * - **This product's own nouns.** "Discovery board", "provisional", "verified",
 *   "hidden gem", "fit". These are the vocabulary of one of the two competitors,
 *   and using any of them in the neutral renderer would be labelling one plan in
 *   its maker's own words.
 *
 * The stage names are derived from the registry rather than copied, because a
 * copied list silently rots the first time somebody adds a stage.
 *
 * What this list cannot catch — and the reason the post-reveal questionnaire
 * asks the reviewer directly whether they suspected anything — is a tell that is
 * not a word: plan length, structural density, the number of sources, tone. Some
 * of those are real differences between the plans and must not be engineered
 * away. They are recorded as a limitation instead.
 */

import { COMPILATION_STAGES, STAGE_REGISTRY } from '@sidequest/core';

/** Names, whether of a company, a product, or a model. */
const NAMES = [
  'sidequest',
  'claude',
  'anthropic',
  'opus',
  'sonnet',
  'haiku',
  'openai',
  'gpt',
  'gemini',
];

/** Words that describe how a plan was made rather than what it says. */
const ARCHITECTURE = [
  'deterministic',
  'ai-generated',
  'ai generated',
  'artificial intelligence',
  'large language model',
  'language model',
  'prompt',
  'token',
  'scheduler',
  'optimiser',
  'optimizer',
  'compiler',
  'compilation',
  'baseline',
  'planner engine',
  'pipeline',
  'adapter',
  'algorithm',
  'automatically generated',
];

/** This product's own surface vocabulary. Using it would label one plan. */
const PRODUCT_NOUNS = [
  'discovery board',
  'provisional board',
  'provisional',
  'shortlist',
  'help me decide',
  'fit meter',
  'fit band',
  'hidden gem',
  'worth a detour',
  'region searched',
  'base portfolio',
  'candidate portfolio',
  'trip personality',
  'compiled region',
  'region pack',
  'evidence store',
  'evidence claim',
  'scope fingerprint',
  'planner readiness',
  'sources disagree',
  'not established',
];

/**
 * Short tokens matched on a word boundary rather than as a substring.
 *
 * Without this, "model" fails inside "remodelled" and "gpt" inside nothing at
 * all — but "fit" would fail inside "benefit", "outfit" and "fifty", which is
 * how a leakage test becomes something people switch off.
 */
const WORD_BOUNDARY_TOKENS = new Set(['gpt', 'token', 'prompt', 'model', 'provisional', 'shortlist']);

export const FORBIDDEN_TOKENS: readonly string[] = [
  ...NAMES,
  ...ARCHITECTURE,
  ...PRODUCT_NOUNS,
  // Derived, never copied: a stage added next month is covered without anybody
  // remembering to come back here.
  ...COMPILATION_STAGES,
  ...STAGE_REGISTRY.map((stage) => stage.label),
].map((token) => token.toLowerCase());

/**
 * Every forbidden token that appears in a piece of text.
 *
 * Returns the matches rather than a boolean so a failing test can say which word
 * it found and where, which is the difference between a test somebody fixes and
 * a test somebody deletes.
 */
export function forbiddenTokensIn(text: string): string[] {
  const haystack = text.toLowerCase();
  const found: string[] = [];
  for (const token of FORBIDDEN_TOKENS) {
    if (token.length === 0) continue;
    if (WORD_BOUNDARY_TOKENS.has(token) || token.length < 6) {
      const pattern = new RegExp(`\\b${escapeForRegExp(token)}\\b`, 'i');
      if (pattern.test(haystack)) found.push(token);
    } else if (haystack.includes(token)) {
      found.push(token);
    }
  }
  return found;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The neutral vocabulary, in one place so that a leakage test can assert the
 * whole visible surface is drawn from it.
 *
 * Every string a reviewer can read before the reveal is here. Inlined copy
 * across ten components would make the leakage check a grep with false
 * negatives, which is worse than no check because it reads as one.
 */
export const NEUTRAL_COPY = {
  suiteName: 'Plan comparison',
  eyebrow: 'Internal evaluation',
  planLabel: (label: 'A' | 'B') => `Plan ${label}`,

  loadingTitle: 'Preparing this comparison…',
  loadingBody:
    'Both plans are being built from the same request. Nothing on this screen says which is which.',

  running: 'Still working. This plan has not finished.',
  partialTitle: 'Partly built',
  partialBody:
    'Some of this plan is finished and some of it is not. What is here is shown as it was produced; the gaps are listed below.',
  failedTitle: 'Did not finish',
  failedBody:
    'This plan stopped before it was complete. It is still part of the comparison — rate what is here, or say you cannot judge.',

  errorTitle: 'Something went wrong on this screen',
  errorBody: 'Nothing about the comparison was changed. Reload to try again.',

  lockedNotice: 'This review is locked. Nothing here can be changed.',
  preRevealNotice: 'Identities stay hidden until the review is locked.',
  notYetReviewable: 'Both plans have to finish before either can be reviewed.',

  /* Section headings on a plan. Deliberately plain. */
  sections: {
    days: 'Days',
    bases: 'Where you sleep',
    places: 'Places',
    travel: 'Travel',
    meals: 'Meals',
    freeTime: 'Free time',
    alternatives: 'If something will not work',
    preparation: 'Getting ready',
    unknowns: 'Unknowns',
    exclusions: 'Left out',
    warnings: 'Worth reading',
    sources: 'Sources',
  },

  /* The absent case, rendered identically for both plans. */
  notStated: 'Not stated',
  noSources: 'No supporting sources given',
  noAlternatives: 'No alternatives given',
  noUnknowns: 'Nothing flagged as uncertain',
  unknownValue: 'Unknown',
} as const;
