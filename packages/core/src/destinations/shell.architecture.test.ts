import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PHASE 11 GUARDRAILS: THE SHELL BELONGS TO NOWHERE, AND THE TYPEAHEAD TOUCHES
 * NOTHING.
 *
 * Two rules that are easy to state, easy to break by accident, and expensive to
 * notice by eye.
 *
 * **The global shell may not name a place.** It did — `EASTERN SIERRA` beside
 * the wordmark and a snowpack caution in the footer, shown to somebody planning
 * Kyrgyzstan. That is not a copy bug; it is what happens when the one region the
 * product could plan leaks into the chrome. A test is the only thing that keeps
 * it out, because the next such line will also look reasonable in isolation.
 *
 * **The suggestion path may not make a network request.** A dropdown that
 * queried a public geocoder per keystroke would violate that service's usage
 * policy, put half-typed text on somebody else's server, and be as slow as the
 * internet. The index exists precisely so it does not have to.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/**
 * Source with its comments removed.
 *
 * The same rule `architecture.test.ts` already applies, and for the same reason:
 * a comment recording that the header *used to* say `EASTERN SIERRA`, and why
 * that was wrong, is exactly the reasoning this repository wants written down.
 * Banning the words from prose would delete the explanation along with the bug.
 */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  const full = join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const relative = `${dir}/${entry}`;
    if (statSync(join(ROOT, relative)).isDirectory()) walk(relative, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative);
  }
  return out;
}

/**
 * Files that render on every page regardless of destination.
 *
 * Deliberately a short, explicit list rather than a glob: this is the chrome,
 * and the point is that adding to it is a decision.
 */
const SHELL_FILES = [
  'apps/web/src/app/layout.tsx',
  'apps/web/src/app/page.tsx',
  'apps/web/src/app/not-found.tsx',
  'apps/web/src/components/TripContextBar.tsx',
  'apps/web/src/components/ui.tsx',
  'apps/web/src/components/DestinationCombobox.tsx',
  'apps/web/src/components/TripComposer.tsx',
  'apps/web/src/components/CompilationProgress.tsx',
  'apps/web/src/components/ScopePreview.tsx',
  'apps/web/src/components/PlanFlow.tsx',
];

const PLACE_NAMES = [/eastern\s*sierra/i, /mammoth/i, /highway\s*395/i, /june\s+lake/i, /mono\s+lake/i];

describe('the global shell names no place', () => {
  it.each(SHELL_FILES)('%s carries no destination-specific copy', (file) => {
    const source = code(file);
    for (const pattern of PLACE_NAMES) {
      expect(pattern.test(source), `${file} mentions ${pattern}`).toBe(false);
    }
  });

  it('the footer disclaimer applies anywhere on earth', () => {
    const layout = code('apps/web/src/app/layout.tsx');
    expect(layout).toMatch(/published sources/i);
    // The words that made the old one local.
    expect(layout).not.toMatch(/snowpack/i);
    expect(layout).not.toMatch(/seasonal access in the/i);
  });

  it('the header holds only the wordmark and a link, never a region label', () => {
    const layout = code('apps/web/src/app/layout.tsx');
    const header = layout.slice(layout.indexOf('<header'), layout.indexOf('</header>'));
    expect(header).toContain('Sidequest');
    expect(header).not.toMatch(/uppercase tracking-\[0\.18em\] text-ink-faint/);
  });
});

describe('destination suggestion never reaches the network', () => {
  /** Every module on the path from a keystroke to a ranked list. */
  const SUGGESTION_PATH = [
    'packages/core/src/destinations/normalize.ts',
    'packages/core/src/destinations/match.ts',
    'packages/core/src/destinations/provider.ts',
    'apps/web/src/lib/destinations/provider.ts',
    'apps/web/src/lib/db/destination-index-repository.ts',
    'apps/web/src/app/api/destinations/suggest/route.ts',
  ];

  const NETWORK = [
    /\bfetch\s*\(/,
    /nominatim/i,
    /anthropic/i,
    /overpass/i,
    /valhalla/i,
    /https?:\/\//,
  ];

  it.each(SUGGESTION_PATH)('%s makes no request and names no provider', (file) => {
    const source = code(file);
    for (const pattern of NETWORK) {
      expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
    }
  });

  it('the suggestion index holds nothing about a traveller', () => {
    const forbidden = [
      'tripId',
      'travelerNeeds',
      'fitScore',
      'pace',
      'budget',
      'interests',
      'selection',
    ];
    for (const file of [
      'packages/core/src/schemas/destination-index.ts',
      'apps/web/src/lib/db/destination-index-repository.ts',
    ]) {
      const source = read(file);
      for (const word of forbidden) {
        expect(source.includes(word), `${file} names ${word}`).toBe(false);
      }
    }
  });
});

describe('no destination-specific rule reached the new engine', () => {
  const NEW_MODULES = [
    'packages/core/src/dates',
    'packages/core/src/scope',
    'packages/core/src/destinations',
  ];

  /**
   * A short list of countries and regions that a "generic" recommender is most
   * likely to acquire an opinion about — the ones every guidebook has a rule for.
   */
  const TEMPTING = [
    'kyrgyz',
    'iceland',
    'japan',
    'slovenia',
    'portugal',
    'turkey',
    'new zealand',
    'bali',
    'denali',
    'skye',
  ];

  it.each(NEW_MODULES)('%s names no country', (dir) => {
    for (const file of walk(dir)) {
      if (file.endsWith('.test.ts')) continue;
      const source = code(file);
      for (const name of TEMPTING) {
        expect(source.toLowerCase().includes(name), `${file} names ${name}`).toBe(false);
      }
    }
  });
});
