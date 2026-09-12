'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AskSidequest, type RefinementReply } from '@/components/hub/AskSidequest';
import { ASK_OPEN_EVENT } from '@/components/hub/HubShell';
import { answerRefinementAction, refineTripAction, undoRefinementAction } from '@/lib/refine/actions';

/**
 * THE CLIENT BOUNDARY FOR ASK SIDEQUEST.
 *
 * PRODUCTION LOCK V5 §43. The panel is a presentation component with no
 * knowledge of server actions; this is the one file that wires it to them and
 * refreshes the page when the trip actually changed.
 *
 * The refresh is conditional on purpose. A read-only answer ("why did you leave
 * out the second island?") changes nothing, and re-rendering the whole trip
 * underneath a traveller who asked a question would look like an edit they did
 * not make.
 */
export function AskSidequestMount({ tripId, ready, canUndo, dayCount, baseNames }: { tripId: string; ready: boolean; canUndo: boolean; dayCount?: number; baseNames?: readonly string[] }) {
  const router = useRouter();
  /*
   * V9 §17 — A REQUEST CARRIED IN THE ADDRESS.
   *
   * Another page ("Suggest a split for day N" on the party page) cannot raise
   * a DOM event into this one, so it links here with `?ask=<request>#day-N`.
   * Once, after mount, the request is handed to the sheet exactly as a chip
   * would hand it — pre-filled, never sent on its own — and the parameter is
   * dropped so a reload does not ask again. The hash is kept: it is the day.
   */
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const request = params.get('ask');
    if (!request || request.trim().length === 0) return;
    askedRef.current = true;
    params.delete('ask');
    const search = params.toString();
    router.replace(`${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
    const handle = window.setTimeout(() => window.dispatchEvent(new CustomEvent(ASK_OPEN_EVENT, { detail: { request: request.trim().slice(0, 600), send: false } })), 0);
    return () => window.clearTimeout(handle);
  }, [router]);
  const refreshIfChanged = (reply: RefinementReply): RefinementReply => {
    if (reply.ok && (reply.summary || reply.version !== undefined)) router.refresh();
    return reply;
  };
  return (
    <AskSidequest
      tripId={tripId}
      ready={ready}
      canUndo={canUndo}
      {...(dayCount ? { dayCount } : {})}
      {...(baseNames && baseNames.length > 0 ? { baseNames } : {})}
      onAsk={async (input) => refreshIfChanged(await refineTripAction(input))}
      onAnswer={async (input) => refreshIfChanged(await answerRefinementAction(input))}
      onUndo={async (input) => refreshIfChanged(await undoRefinementAction(input))}
    />
  );
}
