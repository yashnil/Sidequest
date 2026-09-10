import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ANCHOR_KIND_LABELS } from '@sidequest/core';
import { getItinerary } from '@/lib/db/repository';
import { ownedTrip } from '@/lib/net/trip-access';
import { FeedbackForm } from './FeedbackForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'How was it? — Sidequest',
};

/**
 * V6 §46 — the post-trip page. The categories offered are the trip's own:
 * the kinds of place it actually held, so "what did you love" is a tap on a
 * chip rather than a form.
 */
export default async function FeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) notFound();
  const itinerary = getItinerary(id);
  const categories = [...new Set((itinerary?.package?.anchors ?? []).filter((a) => !a.disposition.startsWith('rejected') && (a.anchorKind ?? 'named_place') in ANCHOR_KIND_LABELS).map((a) => a.category))].slice(0, 10);
  const places = (itinerary?.package?.anchors ?? []).filter((a) => a.role === 'core' && !a.disposition.startsWith('rejected')).map((a) => a.name).slice(0, 8);

  return (
    <div className="mx-auto max-w-2xl px-5 py-10 sm:px-8 sm:py-14" data-testid="feedback-page">
      <p className="eyebrow">{trip.title ?? trip.basics.destinationInput}</p>
      <h1 className="mt-2 font-display text-4xl leading-[1.08] text-ink">How was it?</h1>
      <p className="measure mt-3 type-body text-ink-muted">Nothing here is required. Whatever you tell us shapes the next trip and nothing else.</p>
      <FeedbackForm tripId={id} chips={[...places, ...categories.map((c) => c.replace(/_/g, ' '))]} />
    </div>
  );
}
