'use client';

import { useRouter } from 'next/navigation';
import { AskSidequest, type RefinementReply } from '@/components/hub/AskSidequest';
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
export function AskSidequestMount({ tripId, ready, canUndo }: { tripId: string; ready: boolean; canUndo: boolean }) {
  const router = useRouter();
  const refreshIfChanged = (reply: RefinementReply): RefinementReply => {
    if (reply.ok && (reply.summary || reply.version !== undefined)) router.refresh();
    return reply;
  };
  return (
    <AskSidequest
      tripId={tripId}
      ready={ready}
      canUndo={canUndo}
      onAsk={async (input) => refreshIfChanged(await refineTripAction(input))}
      onAnswer={async (input) => refreshIfChanged(await answerRefinementAction(input))}
      onUndo={async (input) => refreshIfChanged(await undoRefinementAction(input))}
    />
  );
}
