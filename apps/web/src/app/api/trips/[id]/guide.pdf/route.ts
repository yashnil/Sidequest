import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getTrip } from '@/lib/db/repository';
import { guidePrintPath, pdfRendererConfig } from '@/lib/guide/export';
import { loadGuide } from '@/lib/guide/load';
import { guideVariantOf, type GuideVariant } from '@/lib/guide/model';
import { mintGuideToken } from '@/lib/guide/token';
import { tripAccessRefusal } from '@/lib/net/trip-access';

export const dynamic = 'force-dynamic';

/**
 * THE GUIDE AS A PDF FILE.
 *
 * Owner-only, by the same rule as every trip door. The web app has no browser
 * of its own, so it asks the PDF renderer service (`services/pdf-renderer`)
 * to print the dedicated layout: it mints a five-minute token for this trip
 * and variant, hands the renderer the print URL, and streams back the PDF.
 *
 * Cached by the content of the guide itself (a hash of the assembled model),
 * so a rebuilt plan, a new booking or a changed share link produces a new
 * file and an unchanged trip is printed once.
 *
 * When no renderer is configured — or it fails — the request is redirected to
 * the print layout with `?print=1`, which opens the browser's own print
 * dialog on the same pages. The button is never broken.
 */
/** Bump when the printed layout changes, so a cached file never outlives the stylesheet that made it. */
const GUIDE_LAYOUT_VERSION = 'guide-layout-2';
const CACHE_LIMIT = 24;
const CACHE_TTL_MS = 60 * 60_000;
const cache = new Map<string, { at: number; pdf: Uint8Array }>();

function cached(key: string): Uint8Array | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.pdf;
}

function remember(key: string, pdf: Uint8Array): void {
  cache.set(key, { at: Date.now(), pdf });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function filename(destination: string, variant: GuideVariant): string {
  const slug = destination
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase();
  return `${slug || 'trip'}-${variant === 'complete' ? 'travel-guide' : 'itinerary'}.pdf`;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (await tripAccessRefusal(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const trip = getTrip(id);
  if (!trip) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const variant = guideVariantOf(new URL(request.url).searchParams.get('variant'));
  const fallback = () => NextResponse.redirect(new URL(guidePrintPath(id, variant, { print: true }), request.url), 303);

  const renderer = pdfRendererConfig();
  if (!renderer) return fallback();

  const guide = await loadGuide({ trip, variant, audience: 'owner' });
  if (!guide) return NextResponse.json({ error: 'no_plan' }, { status: 404 });
  const key = `${id}:${variant}:` + createHash('sha256').update(GUIDE_LAYOUT_VERSION).update(JSON.stringify(guide)).digest('hex');
  const headers = {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="${filename(trip.basics.destinationInput, variant)}"`,
    'cache-control': 'private, no-store',
  };
  const hit = cached(key);
  if (hit) return new Response(Buffer.from(hit), { headers });

  const token = mintGuideToken(id, variant);
  if (!token) return fallback();
  const source = `${renderer.sourceOrigin}${guidePrintPath(id, variant)}&t=${encodeURIComponent(token)}`;
  try {
    const response = await fetch(`${renderer.url}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-renderer-secret': renderer.secret },
      body: JSON.stringify({ url: source, timezone: guide.identity.timeZone?.id ?? 'UTC', locale: 'en-GB' }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/pdf')) {
      console.error('PDF renderer refused the guide', { trip: id.slice(0, 8), status: response.status });
      return fallback();
    }
    const pdf = new Uint8Array(await response.arrayBuffer());
    remember(key, pdf);
    return new Response(Buffer.from(pdf), { headers });
  } catch (error) {
    console.error('PDF renderer unreachable', { trip: id.slice(0, 8), message: error instanceof Error ? error.message : String(error) });
    return fallback();
  }
}
