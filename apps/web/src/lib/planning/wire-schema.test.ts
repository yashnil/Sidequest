import { expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { tripDraftSchema } from '@/lib/planning/trip-draft';
it('wire schema carries no constraint the provider refuses', () => {
  const format = zodOutputFormat(tripDraftSchema) as unknown as { schema: unknown };
  const text = JSON.stringify(format.schema);
  for (const key of ['minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'multipleOf']) expect(text, key).not.toContain(`"${key}"`);
});
