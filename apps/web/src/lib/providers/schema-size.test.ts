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
 * THE FAILURE THAT ONLY EXISTS AGAINST THE REAL PROVIDER — AND WHAT CHANGED
 * ABOUT HOW THIS CODEBASE RESPONDS TO IT.
 *
 * Constrained decoding compiles the schema into a grammar, and that compilation
 * has a size limit. Past it the request is refused outright — HTTP 400, "the
 * compiled grammar is too large", nothing generated, nothing billed, in under
 * half a second. Every offline test passes, because no offline test compiles a
 * grammar; the first sign used to be the whole arm failing the moment it was
 * pointed at a live provider, in a way that read in a log exactly like an
 * outage.
 *
 * `baselineGenerationSchema` used to opt out of constrained decoding
 * permanently, unconditionally, at the two call sites that use it
 * (`generate.ts`, `repair.ts`) — `schemaEnforcement: 'prompt'`, hard-coded.
 * A composer-quality pass measured the schema again after several rounds of
 * prose-length cuts: **7,708 wire bytes**, against the **7,742** measured
 * the day the provider actually refused it. A 34-byte, 0.4% difference — the
 * length caps those rounds tightened do not meaningfully change a compiled
 * grammar's size, because `zodOutputFormat`'s own converter
 * (`transform-json-schema.mjs`) does not encode `maxLength`/`pattern`/
 * `minItems` as enforced grammar constraints at all; it *describes* them as
 * text inside each field's `description`, so a shorter cap saves a few
 * digits of that text and nothing structural. What was never touched by any
 * of those rounds — the actual likely driver, per this file's own prior
 * comment — is the schema's *shape*: days containing blocks, each carrying
 * travel/meal/opening sub-objects, the same nesting the schema has always
 * had. So this schema is not expected to compile now where it did not
 * before; nothing measured here supports that expectation.
 *
 * What *did* change is that the two call sites stopped opting out. Both now
 * default to `'grammar'` (unset, same as every other schema below) and rely
 * on `ResearchModel.structured()`'s own new safety net instead: a
 * `BadRequestError` on a `grammar`-enforced attempt is retried exactly once,
 * automatically, in `prompt` mode, within the same logical call — see
 * `structured()`'s own comment on "THE ONE-TIME, GRAMMAR-ONLY,
 * PRE-GENERATION FALLBACK". If this schema is refused again, the fallback
 * reproduces the old behaviour exactly, at the cost of one extra sub-second
 * round trip. If some other change (a future provider limit increase, a
 * further schema simplification) ever lets it compile, malformed-shape
 * answers become structurally unrepresentable instead of merely forbidden —
 * for free, the next time either call runs live.
 *
 * This file is still the offline stand-in for the one check that can only
 * happen against the real provider. It holds what it can check without one:
 * how large the schemas have grown, and that the two calls known to sit in
 * the risk zone are the ones the SDK is told to fall back for.
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

describe('the schema that leans on the fallback instead of opting out', () => {
  const callSites = [
    'src/lib/benchmark/baseline/generate.ts',
    'src/lib/benchmark/baseline/repair.ts',
  ];

  /**
   * Both calls that answer in the plan shape must leave enforcement unset,
   * not just the one somebody happened to hit first. A repair inherits the
   * generation's shape, so a repair pinned back to `'prompt'` while the
   * generation attempts `'grammar'` would silently reintroduce the asymmetry
   * `repair.ts`'s own comment warns against — a repair that fails exactly
   * when the generation it is fixing already worked in grammar mode.
   */
  it.each(callSites)(
    '%s leaves baselineGenerationSchema on the default enforcement',
    (file) => {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      expect(source).toContain('schema: baselineGenerationSchema');
      expect(source).not.toContain("schemaEnforcement: 'prompt'");
    },
  );

  /**
   * And nothing else forces it either. A hard-coded `'prompt'` anywhere here
   * would be a standing admission that constrained decoding is not even
   * attempted for that call — which the bounded fallback in `structured()`
   * exists precisely so no call site has to declare permanently. If this
   * schema is still refused live, the fallback pays for it once per call,
   * automatically; a static opt-out would pay for it forever, silently,
   * even after the day it stops being necessary.
   */
  it('no call site forces prompt enforcement', () => {
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
    expect(optedOut).toEqual([]);
  });
});
