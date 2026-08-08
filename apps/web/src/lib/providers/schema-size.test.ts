import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { baselineGenerationSchema } from '@/lib/benchmark/baseline/generate';
import {
  classificationSchema,
  expansionSchema,
  extractionSchema,
  interpretationSchema,
  planningExtractionSchema,
  reconciliationSchema,
} from '@/lib/providers/anthropic';

/**
 * THE FAILURE THAT ONLY EXISTS AGAINST THE REAL PROVIDER.
 *
 * Constrained decoding compiles the schema into a grammar, and that compilation
 * has a size limit. Past it the request is refused outright — HTTP 400, "the
 * compiled grammar is too large", nothing generated, nothing billed, in under
 * half a second. Every offline test passes, because no offline test compiles a
 * grammar; the first sign is the whole arm failing the moment it is pointed at
 * a live provider, in a way that reads in a log exactly like an outage.
 *
 * This file is the offline stand-in. It cannot compile a grammar either, so it
 * holds the two things it can check: which schemas have opted out, and how
 * large the rest have grown.
 */

const SCHEMAS: readonly (readonly [string, z.ZodType])[] = [
  ['interpretationSchema', interpretationSchema],
  ['expansionSchema', expansionSchema],
  ['classificationSchema', classificationSchema],
  ['extractionSchema', extractionSchema],
  ['planningExtractionSchema', planningExtractionSchema],
  ['reconciliationSchema', reconciliationSchema],
];

function wireBytes(schema: z.ZodType): number {
  return JSON.stringify(zodOutputFormat(schema)).length;
}

/**
 * A proxy, and honest about being one.
 *
 * Grammar size is not published and is not a function of byte count alone, so
 * this is calibrated against the two measurements actually taken against the
 * provider: `baselineGenerationSchema` at 7,742 bytes is refused, and
 * `planningExtractionSchema` at 3,739 bytes compiles. Five thousand sits
 * between them, nearer the one that works.
 *
 * Tripping this is not proof that a schema will be refused. It means a schema
 * has grown into the region where the only refusal we have ever seen lives, and
 * that somebody should check it against the provider before shipping it — which
 * is a far better failure than discovering it in a live run.
 */
const GRAMMAR_RISK_BYTES = 5_000;

describe('schemas that ask the provider to compile a grammar', () => {
  it.each(SCHEMAS)('%s is comfortably inside the size that has been refused', (_name, schema) => {
    expect(wireBytes(schema)).toBeLessThan(GRAMMAR_RISK_BYTES);
  });

  /**
   * Non-vacuity. If the threshold were ever raised past the one schema known to
   * be refused, the check above would pass while meaning nothing.
   */
  it('is calibrated against a schema the provider actually refuses', () => {
    expect(wireBytes(baselineGenerationSchema)).toBeGreaterThan(GRAMMAR_RISK_BYTES);
  });
});

describe('the schema that opts out of constrained decoding', () => {
  const callSites = [
    'src/lib/benchmark/baseline/generate.ts',
    'src/lib/benchmark/baseline/repair.ts',
  ];

  /**
   * Both calls that answer in the plan shape must opt out, not just the one
   * somebody happened to hit first. A repair inherits the generation's shape,
   * so a repair left on constrained decoding fails exactly when it is needed —
   * after a plan has already been produced and found wanting.
   */
  it.each(callSites)('%s asks for prompt enforcement', (file) => {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect(source).toContain('schema: baselineGenerationSchema');
    expect(source).toContain("schemaEnforcement: 'prompt'");
  });

  /**
   * And nothing else does. Prompt enforcement gives up first-pass conformance,
   * which is a real cost; it is the answer to a schema the provider will not
   * compile, not a default to drift into.
   */
  it('is the only shape that opts out', () => {
    const sources = [
      ...callSites,
      'src/lib/benchmark/baseline/followups.ts',
      'src/lib/benchmark/baseline/scan.ts',
      'src/lib/providers/anthropic.ts',
      'src/lib/providers/interpretation-model.ts',
    ];
    const optedOut = sources.filter((file) =>
      readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8').includes(
        "schemaEnforcement: 'prompt'",
      ),
    );
    expect(optedOut).toEqual(callSites);
  });
});
