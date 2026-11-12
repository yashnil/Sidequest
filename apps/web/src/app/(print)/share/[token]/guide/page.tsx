import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { GuideDocument } from '@/components/guide/GuideDocument';
import { tripForShareToken } from '@/lib/db/repository';
import { loadGuide } from '@/lib/guide/load';
import { guideVariantOf } from '@/lib/guide/model';

export const dynamic = 'force-dynamic';

/**
 * THE PRINTED GUIDE — THE SHARED COPY.
 *
 * The share token is the only key, as on `/share/<token>`. The guide is built
 * for the public audience: the trip's intelligence is derived without the
 * readiness profile or party facts, `stripForShare` removes booked references,
 * notes, costs and links, and the assembler adds no party, no booking status,
 * no addresses and no budget. Nothing to hide in the layout, because none of
 * it reaches the layout.
 */
export const metadata: Metadata = { title: 'A shared travel guide — Sidequest', robots: { index: false, follow: false } };

export default async function SharedGuidePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const query = await searchParams;
  const trip = tripForShareToken(token);
  if (!trip) notFound();
  const guide = await loadGuide({ trip, variant: guideVariantOf(typeof query.variant === 'string' ? query.variant : null), audience: 'public', shareToken: token });
  if (!guide) notFound();
  return <GuideDocument guide={guide} />;
}
