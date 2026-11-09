import { NextResponse } from 'next/server';
import { getItinerary } from '@/lib/db/repository';
import { guardAction } from '@/lib/net/caller';
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
const MAX_IMAGE_BYTES = 6_000_000;

/** The redirect target, only when it is an https Google image host. */
function imageHostUrl(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase();
    return host.endsWith('.googleusercontent.com') || host.endsWith('.ggpht.com') || host.endsWith('.googleapis.com') ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tripId = url.searchParams.get('trip') ?? '';
  const anchorId = url.searchParams.get('anchor') ?? '';
  if (!tripId || !anchorId) return NextResponse.json({ error: 'missing parameters' }, { status: 400 });
  if (!arePlacePhotosEnabled()) return NextResponse.json({ error: 'not configured' }, { status: 404 });

  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return NextResponse.json({ error: 'not found' }, { status: 404 });
  /* RELEASE PASS — every uncached image is two billed provider requests, and a cache-busting query defeats the browser's hour. Fenced after ownership. */
  if (await guardAction('place_photo')) return NextResponse.json({ error: 'busy' }, { status: 429, headers: { 'retry-after': '30' } });

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
    /*
     * RELEASE PASS — THE KEY GOES TO ONE HOST, AND ONLY AN IMAGE COMES BACK.
     *
     * The media endpoint answers with a redirect to the image's own host, and
     * `fetch` followed it carrying `x-goog-api-key`: a custom header is not
     * one the platform strips across origins, so the credential travelled to
     * wherever the redirect pointed. The redirect is now followed by hand —
     * the key is sent to `places.googleapis.com` and nowhere else, and the
     * second request goes, without it, only to an https Google image host.
     * The path segment comes from the provider's response and must have the
     * documented shape; the body must say it is an image and fit the cap.
     */
    if (!/^places\/[A-Za-z0-9_-]{1,300}\/photos\/[A-Za-z0-9_-]{1,600}$/.test(photo.name)) return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });
    const media = `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=${MAX_WIDTH}&skipHttpRedirect=false`;
    let response = await fetch(media, { headers: { 'x-goog-api-key': key }, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const target = imageHostUrl(response.headers.get('location'));
      await response.body?.cancel().catch(() => undefined);
      if (!target) return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });
      response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (!response.ok || !response.body || !/^image\/(jpeg|png|webp|avif|gif)$/.test(contentType) || declared > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });

    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': contentType,
        // Performance, not storage: nothing is written anywhere, and nothing is shared.
        'cache-control': 'private, max-age=3600',
        /*
         * Rendered beside the picture. A contributor's name is any Unicode and a
         * header is Latin-1: a name outside it threw, and the photograph became
         * a 404. Percent-encoded, so the words always travel.
         */
        'x-sidequest-attribution': encodeURIComponent(photo.attribution).slice(0, 600),
        ...(photo.attributionUri && /^https:\/\//i.test(photo.attributionUri) ? { 'x-sidequest-attribution-uri': encodeURI(photo.attributionUri).slice(0, 600) } : {}),
      },
    });
  } catch {
    // A photograph is the least important thing on the page; a failure is a missing picture.
    return NextResponse.json({ error: 'no photograph for this stop' }, { status: 404 });
  }
}
