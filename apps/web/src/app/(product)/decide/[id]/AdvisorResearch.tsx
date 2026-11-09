'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { widenAdvisorShortlistAction } from '../advisor-actions';

/**
 * WIDER RESEARCH, AFTER THE ANSWER RATHER THAN BEFORE IT.
 *
 * The shortlist on screen is the atlas's own and is complete without this.
 * When the server says a wider look is worth one model call — the list is thin
 * or weak, research is switched on, and it has not been tried for this list —
 * this asks for it once, says so in one quiet line while it runs, and re-reads
 * the page when it comes back. The model may only propose names; the atlas
 * verifies and ranks them, and the card of any that makes the list says so.
 *
 * Three properties worth stating:
 *
 * **It never blocks the list.** It renders one line above it and nothing else.
 *
 * **It fires once per mount.** The server stops asking once the stored list
 * records that research was tried, and the ref holds the line in between: the
 * refresh that follows cannot start a second call.
 *
 * **It never reports failure.** A search that found nothing, timed out or was
 * declined leaves the list exactly as it was, which is not something to
 * interrupt somebody choosing where to go with.
 */
export function AdvisorResearch({
  sessionId,
  possible,
}: {
  sessionId: string;
  /** Worked out on the server. False means do nothing and draw nothing. */
  possible: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const asked = useRef(false);

  useEffect(() => {
    if (!possible || asked.current) return;
    asked.current = true;
    startTransition(async () => {
      try {
        const result = await widenAdvisorShortlistAction(sessionId);
        if (result.ok) router.refresh();
      } catch {
        /* The list on screen stands. */
      }
    });
  }, [sessionId, possible, router]);

  if (!possible && !pending) return null;
  /* The line's height is held whether or not it has words, so the list below does not move when it finishes. */
  return (
    <p role="status" aria-live="polite" data-testid="advisor-research" className="mb-4 flex min-h-6 items-center gap-2 type-small text-ink-muted">
      {pending ? (
        <>
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-flare" />
          Looking further afield…
        </>
      ) : null}
    </p>
  );
}
