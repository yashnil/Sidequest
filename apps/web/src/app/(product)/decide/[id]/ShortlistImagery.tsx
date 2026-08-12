'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { resolveShortlistImageryAction } from '../actions';

/**
 * THE PICTURES, AFTER THE ANSWER RATHER THAN BEFORE IT.
 *
 * Renders nothing. It exists so that resolving eight destination photographs —
 * eight sequential requests to a volunteer-run service, deliberately not
 * parallelised — happens *after* the ranking is on screen instead of in front
 * of it. See `buildShortlistAction` for the twenty-five seconds this cost.
 *
 * Two properties worth stating:
 *
 * **It fires once per mount and only when something is missing.** The imagery
 * cache stores refusals as well as acceptances, so a second call is free — but
 * a component that asked on every render would still be asking on every back
 * button, and free is not the same as harmless.
 *
 * **It never reports failure.** A picture that could not be found is not
 * something to interrupt somebody choosing where to go with; the card draws its
 * coordinate-derived graphic and the screen is complete without it.
 */
export function ShortlistImagery({
  sessionId,
  missing,
}: {
  sessionId: string;
  /** How many picks have no stored image record yet. Zero means do nothing. */
  missing: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const asked = useRef(false);

  useEffect(() => {
    if (missing === 0 || asked.current) return;
    asked.current = true;
    startTransition(async () => {
      const result = await resolveShortlistImageryAction(sessionId);
      if (result.ok) router.refresh();
    });
  }, [sessionId, missing, router]);

  return null;
}
