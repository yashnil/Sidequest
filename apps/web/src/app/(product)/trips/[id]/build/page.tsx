import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { GenerationScreen } from '@/components/interview/GenerationScreen';
import type { DestinationGeometry } from '@/components/interview/DestinationMap';
import { resolveMapBasemap } from '@/components/map-adapter';
import type { GenerationProgressView } from '@/app/api/trips/[id]/progress/route';
import { GENERATION_STAGES, GENERATION_STAGE_DETAIL, GENERATION_STAGE_LABELS, buildRunStateOf, getGenerationProgress, milestonesFor } from '@/lib/db/generation-progress-repository';
import { getIntent } from '@/lib/db/compiler-repository';
import { hasItinerary } from '@/lib/db/repository';
import { ownedTrip } from '@/lib/net/trip-access';
import { runFailureView } from '@/lib/planning/build-run-view';
import { resolveTripRegion } from '@/lib/region';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  return { title: trip ? `${trip.basics.destinationInput} — Building your trip — Sidequest` : 'Building your trip — Sidequest' };
}

/**
 * V8 — THE BUILD, AS A PLACE A TRAVELLER CAN COME BACK TO.
 *
 * Rendered from the run row and nothing else. Running → the generation
 * screen, which polls and leaves for the Trip Hub when the row says done.
 * Succeeded with a plan on disk → straight to the hub. Failed or lost → the
 * failure state, with "Try build again" on the saved profile. No run at all →
 * the review, which is where a build is started. A reload, a back button or a
 * bookmark lands on exactly the state the server holds; nothing here infers
 * "start the interview again" from a URL.
 */
export default async function BuildPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) notFound();
  const progress = getGenerationProgress(id);
  if (!progress) redirect(`/trips/${id}/questionnaire`);
  const now = new Date();
  const state = buildRunStateOf(progress, now);
  const planExists = hasItinerary(id);
  if (state === 'succeeded' && planExists) redirect(`/trips/${id}/itinerary`);

  const startedAt = Date.parse(progress.startedAt);
  const initial: GenerationProgressView = {
    stage: progress.stage,
    label: GENERATION_STAGE_LABELS[progress.stage],
    detail: GENERATION_STAGE_DETAIL[progress.stage],
    reached: progress.reached,
    all: GENERATION_STAGES.map((stage) => ({ id: stage, label: GENERATION_STAGE_LABELS[stage] })),
    elapsedSeconds: Number.isNaN(startedAt) ? 0 : Math.max(0, Math.round((now.getTime() - startedAt) / 1000)),
    finished: progress.finished,
    outcome: progress.outcome,
    milestones: milestonesFor(progress.counters, progress.stage),
    state,
    buildKey: progress.buildKey,
    failure: runFailureView(progress, state),
    hasItinerary: planExists,
    placed: progress.placed,
  };

  /* The same map the review showed, so the screens read as one continuous surface. */
  const intent = getIntent(id);
  const selected = intent?.selectedDestination ?? intent?.resolution?.candidates.find((c) => c.id === (intent?.selectedCandidateId ?? intent?.resolution?.unambiguousCandidateId)) ?? intent?.resolution?.candidates[0] ?? null;
  const semantics = intent?.destinationIntent?.semantics ?? null;
  let geometry: DestinationGeometry | null = selected?.center
    ? { name: selected.displayName ?? trip.basics.destinationInput, center: selected.center, bounds: selected.bounds ?? null, featureType: 'entityType' in selected ? selected.entityType : selected.featureType, ...(semantics ? { scale: semantics.scale, ...(semantics.extent ? { extentSource: semantics.extent.source } : {}) } : {}) }
    : null;
  if (!geometry) {
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) geometry = { name: resolved.context.region.name, center: resolved.context.region.baseCoordinates, bounds: null };
  }

  return <GenerationScreen tripId={id} destination={trip.basics.destinationInput} geometry={geometry} tiles={resolveMapBasemap(process.env)} initial={initial} variant="page" />;
}
