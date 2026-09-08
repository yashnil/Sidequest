import { NextResponse } from 'next/server';
import { getItinerary } from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { mediaFacts } from '@/lib/providers/google-places';
import { arePlacePhotosEnabled } from '@/lib/providers/switches';

/**
 * A PLACE'S OWN PHOTOGRAPH, FETCHED WHEN SOMEBODY LOOKS AT IT AND STORED NOWHERE.
 *
 * MVP V3, Stages 32 and 33. Sidequest's durable imagery is Wikimedia Commons —
 * open licences, published as structured fields, safe to keep. It does not cover
 * a neighbourhood restaurant or a small museum, and the founder's ask was for a
 * trip that looks like the place rather than like a form.
 *
 * Google Places photos fill that gap, and the terms decide the shape of this
 * route rather than convenience doing so:
 *
 * - **Nothing is persisted.** Not the bytes, and — the part that is easy to get
 *   wrong — not the photo *name*. A `places/…/photos/…` reference is a short-
 *   lived token, not an identity, and writing one into a row would create a
 *   durable record of Google content and a link that silently rots. The only
 *   thing this route keeps is the place id, which the plan already stored and
 *   which the terms allow.
 * - **The key never leaves the server.** The browser asks this origin for an
 *   image; this route resolves the photo and streams the bytes. A `key=` in an
 *   `<img src>` would publish the credential to anybody who opened the page.
 * - **Attribution travels with the picture**, rendered by `DestinationImage`
 *   from the header below, never invented client-side.
 * - **It is off unless somebody turned it on.** Every view costs two Places
 *   requests, so this is a deliberate configuration
 *   (`SIDEQUEST_PLACE_PHOTOS=google`), and the plan renders exactly as before
 *   when it is off.
 * - **It is owner-gated.** A photo is fetched only for an anchor on a trip the
 *   asking browser owns, so this cannot become an open Places proxy.
 *
 * The one hour of private browser caching is a performance measure, not storage:
 * without it, scrolling a day back into view would buy the same photograph
 * again. Nothing is written to disk and nothing is shared between travellers.
 */

export const dynamic = 'force-dynamic';

const MAX_WIDTH = 1200;
const REQUEST_TIMEOUT_MS = 10_000;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tripId = url.searchParams.get('trip') ?? '';
  const anchorId = url.searchParams.get('anchor') ?? '';
  if (!tripId || !anchorId) return NextResponse.json({ error: 'missing parameters' }, { status: 400 });
  if (!arePlacePhotosEnabled()) return NextResponse.json({ error: 'not configured' }, { status: 404 });

  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let itinerary;
  try {
    itinerary = getItinerary(tripId);
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const anchor = itinerary?.package?.anchors.find((entry) => entry.id === anchorId);
  const identity = anchor?.identity;
  if (!identity || identity.provider !== 'google-places' || !identity.providerRef) {
    return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });
  }

  try {
    const facts = await mediaFacts(identity.providerRef);
    const photo = facts?.photos[0];
    if (!photo) return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });

    const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (!key) return NextResponse.json({ error: 'not configured' }, { status: 404 });
    const media = `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=${MAX_WIDTH}&skipHttpRedirect=false`;
    const response = await fetch(media, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok || !response.body) return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });

    return new Response(response.body, {
      status: 200,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'image/jpeg',
        // Performance, not storage: nothing is written anywhere, and nothing is shared.
        'cache-control': 'private, max-age=3600',
        // Rendered beside the picture. The obligation is to show these words.
        'x-sidequest-attribution': photo.attribution,
        ...(photo.attributionUri ? { 'x-sidequest-attribution-uri': photo.attributionUri } : {}),
      },
    });
  } catch {
    // A photograph is the least important thing on the page; a failure is a missing picture.
    return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });
  }
}
