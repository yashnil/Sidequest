import 'server-only';
import { MEDIA_CONTEXTS, type MediaContext } from './frame';
import { saveMediaSelections, unresolvedMediaIds } from './repository';
import { resolveMedia, type ResolveMediaOptions } from './resolve';
import type { MediaSubject } from './select';

/**
 * A BOUNDED, POLITE PASS THAT FILLS THE MEDIA CACHE FOR THE PLACES ON SCREEN.
 *
 * Called from a server action after the page is already showing (the advisor
 * shortlist's `AdvisorImagery` effect). Skips every place whose answer is on
 * disk and current; resolves the rest one at a time with a pause between them;
 * stops at the first "service unavailable" (Commons answers bursts with 429),
 * leaving the rest for the next visit. Never throws.
 */
export async function fillMedia(
  subjects: readonly MediaSubject[],
  options: ResolveMediaOptions & { contexts?: readonly MediaContext[]; limit?: number; pauseMs?: number } = {},
): Promise<{ resolved: number; selected: number; calls: number }> {
  const now = options.now ?? new Date();
  const contexts = options.contexts ?? MEDIA_CONTEXTS;
  const pending = new Set(unresolvedMediaIds(subjects.map((subject) => subject.wikidataId), contexts, now));
  const queue = subjects.filter((subject) => pending.delete(subject.wikidataId)).slice(0, options.limit ?? 8);
  const pauseMs = options.pauseMs ?? 400;
  let resolved = 0;
  let selected = 0;
  let calls = 0;
  for (const [index, subject] of queue.entries()) {
    if (index > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    try {
      const result = await resolveMedia(subject, { ...options, now });
      calls += result.calls;
      const values = Object.values(result.selections);
      if (values.some((selection) => selection.status === 'none' && selection.reason === 'provider_unavailable')) break;
      saveMediaSelections(result.selections, now);
      resolved += 1;
      if (values.some((selection) => selection.status === 'selected')) selected += 1;
    } catch (error) {
      console.error('Media lookup failed', { subject: subject.wikidataId, error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  return { resolved, selected, calls };
}
