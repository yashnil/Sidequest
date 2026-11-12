import 'server-only';
import type { Trip } from '@sidequest/core';
import { itineraryViewModel } from '@/app/(product)/trips/[id]/itinerary/view-model';
import { stripForShare } from '@/app/share/[token]/strip';
import { renderInstant } from '@/lib/clock';
import { getDb } from '@/lib/db/client';
import { getItinerary } from '@/lib/db/repository';
import { assembleGuide } from './assemble';
import type { GuideAudience, GuideModel, GuideVariant } from './model';

/**
 * THE GUIDE'S INPUTS, LOADED THE SAME WAY THE TRIP PAGE LOADS THEM.
 *
 * One derivation (`itineraryViewModel`) feeds the hub, the share and this
 * guide, so the paper copy cannot drift from the screen. The public copy goes
 * through the same door the read-only share does: built for the public
 * audience (no readiness profile, no party facts ever written) and stripped by
 * `stripForShare` before the assembler sees it — and the assembler then leaves
 * out booking status, addresses and costs on its own account.
 */
function baseUrl(): string {
  return (process.env.SIDEQUEST_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
}

function shareTokenFor(tripId: string): string | null {
  try {
    const row = getDb().prepare('SELECT share_token FROM trips WHERE id = ?').get(tripId) as { share_token: string | null } | undefined;
    return row?.share_token ?? null;
  } catch {
    return null;
  }
}

export async function loadGuide(input: { trip: Trip; variant: GuideVariant; audience: GuideAudience; shareToken?: string }): Promise<GuideModel | null> {
  const { trip, variant, audience } = input;
  let itinerary;
  try {
    itinerary = getItinerary(trip.id);
  } catch {
    return null;
  }
  if (!itinerary) return null;
  const raw = await itineraryViewModel(trip, itinerary, audience === 'public' ? { audience: 'public' } : {});
  const model = audience === 'public' ? stripForShare(raw) : raw;
  const share = audience === 'public' ? input.shareToken : shareTokenFor(trip.id);
  return assembleGuide({
    variant,
    audience,
    trip: {
      destination: trip.basics.destinationInput,
      startDate: trip.basics.startDate,
      endDate: trip.basics.endDate,
      ...(audience === 'owner' ? { adults: trip.basics.adults, children: trip.basics.children } : {}),
    },
    itinerary: model.appliedItinerary,
    intelligence: model.intelligence,
    booked: model.booked,
    resolutions: model.resolutions,
    coordinates: model.coordinates,
    images: model.images,
    rationale: model.rationale,
    personality: model.personality,
    ...(model.timeZone ? { timeZone: model.timeZone } : {}),
    attributions: model.attributions,
    worthSkipping: model.worthSkipping,
    links: {
      ...(audience === 'owner' ? { trip: `${baseUrl()}/trips/${trip.id}/itinerary` } : {}),
      ...(share ? { share: `${baseUrl()}/share/${share}` } : {}),
    },
    generatedAt: new Date(renderInstant()),
  });
}
