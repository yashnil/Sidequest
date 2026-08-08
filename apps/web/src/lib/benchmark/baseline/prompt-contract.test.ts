import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINE_OUTPUT_SCHEMA_VERSION } from './generate';
import { BASELINE_PROMPT_VERSIONS } from './prompts';
import { BASELINE_MAX_MODEL_CALLS, MAX_GENERATION_ATTEMPTS } from './orchestrate';

/**
 * THE CONTRACT DOCUMENT AND THE CONSTANTS IT NAMES.
 *
 * `prompt-contract.md` is the production contract for this arm, and its own rule
 * is that a change to a prompt or a schema after a live result has been inspected
 * creates a new benchmark version. That makes a drifted document worse than an
 * absent one: a reader reconciling stored results against it attributes them to
 * the wrong prompt, in good faith.
 *
 * It had drifted in five places at once — three version strings, the schema
 * version, the generation bound, the instance count and the travel-provenance
 * vocabulary — because nothing tied the two together. This is that tie.
 *
 * The document is private and not checked in, so this asserts only when it is
 * present. A guard that failed on a machine without it would be a test about
 * somebody's working copy.
 */

const CONTRACT = join(
  new URL('.', import.meta.url).pathname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '.claude-private',
  'benchmark',
  'prompt-contract.md',
);

function contractText(): string | null {
  try {
    return readFileSync(CONTRACT, 'utf8');
  } catch {
    return null;
  }
}

describe('the private prompt contract, when it is present', () => {
  it('names every version the code exports', () => {
    const text = contractText();
    if (text === null) return;
    for (const version of Object.values(BASELINE_PROMPT_VERSIONS)) {
      expect(text, `the contract does not name ${version}`).toContain(version);
    }
    expect(text).toContain(`BASELINE_OUTPUT_SCHEMA_VERSION = ${BASELINE_OUTPUT_SCHEMA_VERSION}`);
  });

  it('states the call ceiling the code enforces', () => {
    const text = contractText();
    if (text === null) return;
    // Spelled out in the document; asserted here so the two cannot drift.
    expect(BASELINE_MAX_MODEL_CALLS).toBe(3);
    expect(MAX_GENERATION_ATTEMPTS).toBe(2);
    expect(text).toContain('**Three, total.**');
    expect(text).toContain('re-ask');
  });
});
