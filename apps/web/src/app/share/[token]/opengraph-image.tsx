import { ImageResponse } from 'next/og';
import type { Itinerary } from '@sidequest/core';
import { getItinerary, tripForShareToken } from '@/lib/db/repository';
import { OVERVIEW_CARD_SIZE, OverviewCard, overviewCardModel } from '@/lib/execution/trip-cards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const alt = 'A Sidequest trip';
export const size = OVERVIEW_CARD_SIZE;
export const contentType = 'image/png';

/**
 * V9 §11 — THE SHARE LINK'S PREVIEW, FROM THE TOKEN ALONE.
 *
 * The same overview card the owner can post, derived the same way the share
 * page derives its document: exact token match, no id fallback, no cookie
 * read. A bad token gets a plain card that names nothing, because a preview
 * fetcher is a crawler and a crawler learns nothing here.
 */
export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const trip = tripForShareToken(token);
  let itinerary: Itinerary | null = null;
  if (trip) {
    try {
      itinerary = getItinerary(trip.id);
    } catch {
      itinerary = null;
    }
  }
  if (!trip || !itinerary) {
    return new ImageResponse(
      (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#101d24', color: '#e9eef0', fontSize: 64, fontFamily: 'sans-serif' }}>
          <div>A Sidequest trip</div>
        </div>
      ),
      { ...OVERVIEW_CARD_SIZE },
    );
  }
  return new ImageResponse(<OverviewCard model={overviewCardModel(trip, itinerary)} />, { ...OVERVIEW_CARD_SIZE });
}
