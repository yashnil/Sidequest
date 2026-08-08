import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PRODUCING_SYSTEMS } from '@sidequest/bench';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY } from '@/components/benchmark/copy';
import { ReviewSurface } from '@/components/benchmark/ReviewSurface';
import { readDraft, toNeutralPanel } from '@/components/benchmark/neutral-dto';
import { Panel, buttonClass } from '@/components/ui';
import { blindPanels } from '@/lib/benchmark/blind';
import { getBenchmarkSession } from '@/lib/db/benchmark-repository';
import {
  getReview,
  getReviewDraft,
  listCorrections,
} from '@/lib/db/benchmark-review-repository';
import { sessionIdFromParam } from '../session-id';
import { lockReviewAction, requestCorrectionAction, saveReviewDraftAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * THE BLIND REVIEW.
 *
 * Everything on this page comes through `blindPanels`, which returns a type that
 * structurally cannot carry the producing system, and then through
 * `toNeutralPanel`, which redacts every string inside it. Nothing else about the
 * session reaches the client: not a run row, not a latency, not a cost, not the
 * head plan id — whose stored form contains the arm's name — and not the number
 * of correction rounds each arm has had, only the higher of the two.
 *
 * The gate is `bothTerminal`, and it is not politeness. If a panel appeared as
 * soon as its arm finished, arrival order would announce the quicker system on
 * every single session, and no wording anywhere would undo it.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const sessionId = sessionIdFromParam((await params).sessionId);
  const session = getBenchmarkSession(sessionId);
  if (!session) notFound();

  const presentation = blindPanels(sessionId);
  if (presentation === null) notFound();

  if (!presentation.bothTerminal) {
    return (
      <div className="mx-auto max-w-3xl px-3 py-10 sm:px-8">
        <Panel className="p-5">
          <h1 className="font-display text-2xl text-ink">{NEUTRAL_COPY.suiteName}</h1>
          <p className="measure mt-3 text-sm leading-relaxed text-ink-muted">
            {NEUTRAL_COPY.notYetReviewable}
          </p>
          <Link
            href={`/labs/benchmark/${sessionId}/run`}
            className={`${buttonClass('secondary')} mt-5`}
          >
            {LABS_COPY.runTitle}
          </Link>
        </Panel>
      </div>
    );
  }

  const panels = presentation.panels.map(toNeutralPanel);
  const locked = getReview(sessionId) !== null;

  /*
   * One number, not two.
   *
   * Correction rounds are claimed for both arms by the same press, so the counts
   * agree in every ordinary case — and where they do not, the higher one is the
   * only figure that tells the reviewer anything they need. A per-arm pair would
   * be a fingerprint on a screen whose whole purpose is that there is not one.
   */
  const rounds = listCorrections(sessionId);
  const perSystem = new Map<string, number>();
  for (const round of rounds) perSystem.set(round.system, (perSystem.get(round.system) ?? 0) + 1);
  const correctionRoundsUsed = Math.max(
    0,
    ...PRODUCING_SYSTEMS.map((system) => perSystem.get(system) ?? 0),
  );

  return (
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-8 sm:py-12">
      <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {LABS_COPY.reviewTitle}
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">{LABS_COPY.reviewLede}</p>

      <div className="mt-8">
        <ReviewSurface
          sessionId={sessionId}
          panels={panels}
          initialDraft={readDraft(getReviewDraft(sessionId))}
          locked={locked}
          correctionRoundsUsed={correctionRoundsUsed}
          saveDraft={saveReviewDraftAction}
          lock={lockReviewAction}
          requestCorrection={requestCorrectionAction}
        />
      </div>

      {locked ? (
        <div className="mt-8">
          <Link href={`/labs/benchmark/${sessionId}/results`} className={buttonClass('primary')}>
            {LABS_COPY.revealHeading}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
