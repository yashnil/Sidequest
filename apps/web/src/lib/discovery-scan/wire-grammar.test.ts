import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { scanProposalWireSchema } from './prompt';

/**
 * The provider compiles the wire schema into a grammar, and rejects one that is
 * too large ("The compiled grammar is too large…") — whereupon the call falls
 * back to prompt-only output, which degraded into malformed JSON on live scans
 * (eval v3, 2026-11-14: every new-build scan failed). Optional properties are
 * what grows the grammar. This is the count the provider was verified to accept
 * live; adding a field means checking the provider again, not raising the number.
 */
const ACCEPTED_OPTIONAL_PROPERTIES = 12;

function optionalProperties(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const n = node as { properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: unknown[] };
  let count = 0;
  if (n.properties) {
    const required = new Set(n.required ?? []);
    for (const [key, value] of Object.entries(n.properties)) {
      if (!required.has(key)) count += 1;
      count += optionalProperties(value);
    }
  }
  if (n.items) count += optionalProperties(n.items);
  for (const branch of n.anyOf ?? []) count += optionalProperties(branch);
  return count;
}

describe('the scan wire schema stays within the provider grammar limit', () => {
  it(`has no more optional properties than the verified-accepted ${ACCEPTED_OPTIONAL_PROPERTIES}`, () => {
    const schema = zodOutputFormat(scanProposalWireSchema as unknown as z.ZodType).schema;
    expect(optionalProperties(schema)).toBeLessThanOrEqual(ACCEPTED_OPTIONAL_PROPERTIES);
  });
});
