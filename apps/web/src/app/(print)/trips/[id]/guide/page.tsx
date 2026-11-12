import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GuideDocument } from '@/components/guide/GuideDocument';
import { getTrip } from '@/lib/db/repository';
import { japanGuideFixture } from '@/lib/guide/fixtures/japan';
import { loadGuide } from '@/lib/guide/load';
import { guideVariantOf } from '@/lib/guide/model';
import { verifyGuideToken } from '@/lib/guide/token';
import { ownedTrip } from '@/lib/net/trip-access';
import { isFixtureComposer } from '@/lib/providers/switches';

export const dynamic = 'force-dynamic';

/**
 * THE PRINTED GUIDE — THE OWNER'S COPY.
 *
 * A document with no product chrome, laid out for paper (see `GuideDocument`).
 * Two ways in, both owner-only:
 *
 * - the owner's own browser, judged by the same rule as every trip page
 *   (`ownedTrip`) — this is the browser-print fallback;
 * - a five-minute token minted by `/api/trips/[id]/guide.pdf` after that same
 *   check, for the headless renderer, which has no cookie (`lib/guide/token`).
 *
 * A trip that is not the caller's renders as missing, like every trip URL.
 * The shared, public copy lives at `/share/<token>/guide`.
 */
export const metadata: Metadata = { title: 'Travel guide — Sidequest', robots: { index: false, follow: false } };

function fixturesAllowed(): boolean {
  return isFixtureComposer() && (process.env.NODE_ENV !== 'production' || process.env.SIDEQUEST_FIXTURES === 'allow');
}

export default async function GuidePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const query = await searchParams;
  const variant = guideVariantOf(typeof query.variant === 'string' ? query.variant : null);
  if (id === 'fixture-japan' && fixturesAllowed()) return <GuideDocument guide={japanGuideFixture(variant)} />;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  const token = typeof query.t === 'string' ? query.t : null;
  const trip = token && verifyGuideToken(token, id, variant) ? getTrip(id) : await ownedTrip(id);
  if (!trip) notFound();
  const guide = await loadGuide({ trip, variant, audience: 'owner' });
  if (!guide) notFound();
  return <GuideDocument guide={guide} />;
}
