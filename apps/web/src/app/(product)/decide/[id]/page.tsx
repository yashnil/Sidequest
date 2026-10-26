import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  ADVISOR_QUESTIONS,
  destinationCatalog,
  emptyComposerAnswers,
  parseTravelRequest,
  profileChips,
  type QuestionId,
} from '@sidequest/core';
import { AdvisorInterview } from '@/components/advisor/AdvisorInterview';
import { AdvisorShortlistView } from '@/components/advisor/AdvisorShortlistView';
import { AdvisorImagery } from './AdvisorImagery';
import { ownedDecisionSession } from '@/lib/net/decision-access';
import { acceptedImagesFor } from '@/lib/db/imagery-repository';
import { advisorImageSubjects } from '@/lib/destinations/advisor-images';

/**
 * ONE DECISION: THE INTERVIEW UNTIL THERE IS A SHORTLIST, THEN THE SHORTLIST.
 *
 * Reads rows only. The interview runs in the browser on the stored answers;
 * the shortlist is built by an explicit action and stored, so a refresh renders
 * what is on disk and a back button costs nothing. A session from the previous
 * ranker (stored before the 2026-10 rebuild) has its answers and no advisor
 * shortlist, so it re-enters the interview with everything it already said.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Where should I go — Sidequest',
};

export default async function DecideSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  /* The owner's decision or nothing — see `lib/net/decision-access`. */
  const session = await ownedDecisionSession(id);
  if (!session) notFound();
  if (session.resolvedTripId) redirect(`/trips/${session.resolvedTripId}/plan`);

  const catalog = destinationCatalog();
  const points = catalog.map((entry) => ({ id: entry.id, lat: entry.center.lat, lng: entry.center.lng }));
  const editing = query.edit === '1';
  const askParam = typeof query.ask === 'string' ? query.ask : null;
  const startAt = askParam && ADVISOR_QUESTIONS.some((question) => question.id === askParam) ? (askParam as QuestionId) : null;

  if (session.advisor && !editing) {
    const subjects = advisorImageSubjects(session.advisor);
    const images = acceptedImagesFor(subjects);
    const missing = subjects.filter((subject) => !images[subject.id]).length;
    return (
      <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
        <AdvisorImagery sessionId={id} missing={missing} />
        <AdvisorShortlistView
          sessionId={id}
          shortlist={session.advisor}
          images={images}
          points={points}
          summary={profileChips(session.answers).map((chip) => chip.label)}
        />
        <p className="mt-14 rule-top pt-6 type-small text-ink-muted">
          <Link href={`/decide/${id}?edit=1`} className="underline underline-offset-4 hover:text-pine">
            Change your answers
          </Link>
          {' · '}
          <Link href="/decide" className="underline underline-offset-4 hover:text-pine">
            Start again
          </Link>
          {' · '}
          <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
            I know where I’m going
          </Link>
        </p>
      </div>
    );
  }

  const request = session.answers.discovery?.request;
  const understood = request ? parseTravelRequest(request, emptyComposerAnswers('help_me_decide', new Date())).readings.map((reading) => reading.label) : [];

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="sheet-label inline-flex items-center gap-2 text-accent">
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
        Help me choose
      </p>
      {request ? (
        <blockquote className="mt-3 max-w-3xl border-l-2 border-flare pl-4 font-display text-xl leading-snug text-ink-muted italic">“{request}”</blockquote>
      ) : null}
      <div className="mt-8">
        <AdvisorInterview
          sessionId={id}
          initial={editing ? { ...session.answers, discovery: session.answers.discovery ? { ...session.answers.discovery, asked: [] } : undefined } : session.answers}
          understood={understood}
          startAt={startAt}
        />
      </div>
      <p className="mt-14 rule-top pt-6 type-small text-ink-muted">
        Already know where you are going?{' '}
        <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
          Start from a destination instead.
        </Link>
      </p>
    </div>
  );
}
