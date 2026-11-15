import type { Metadata } from 'next';
import Link from 'next/link';
import { PlanCheck } from '@/components/plan-check/PlanCheck';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Check a plan you already have — Sidequest',
};

/**
 * THE THIRD DOOR: "I ALREADY HAVE A PLAN — OPTIMISE IT".
 *
 * Master prompt §7, Mode 3. The traveller pastes what they have — "Tokyo,
 * Kyoto, Osaka and Hokkaido in 10 days, is that too much?", or a day-by-day
 * list — and gets a straight answer before any trip exists: whether the pace
 * holds, whether the order doubles back, how each move is realistically made
 * and roughly how long it takes, and what to change. Then they plan it, as
 * written or improved, through the same door every trip uses.
 *
 * Deterministic end to end (`plan-check/parse.ts`, `plan-check/critique.ts`);
 * the only provider is the geocoder that places the stops.
 */
export default function ImprovePlanPage() {
  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-14">
        <div className="min-w-0">
          <p className="sheet-label inline-flex items-center gap-2 text-accent">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
            I already have a plan
          </p>
          <h1 className="mt-3 max-w-[18ch] font-display text-[clamp(2.4rem,1.5rem+3vw,4.4rem)] leading-[0.98] font-[340] tracking-[-0.035em] text-balance text-ink">
            Got a plan? <span className="text-ink-muted italic">We’ll tell you if it works.</span>
          </h1>
          <p className="measure mt-4 type-body text-ink-muted">Paste the places in order. We’ll check the pace, the order and how you’d get between them — then plan it as written, or with our changes.</p>
        </div>
        <aside className="survey-night rounded-[var(--radius-card)] p-5 text-bone lg:mt-8" aria-label="What gets checked">
          <p className="sheet-label text-[var(--color-glacier)]">What we check</p>
          <dl className="mt-4 space-y-4 text-sm">
            <div>
              <dt className="font-display text-lg text-bone">Pace</dt>
              <dd className="mt-1 text-bone/75">Nights per place, hotel moves for the trip’s length, and how much of the trip goes to moving.</dd>
            </div>
            <div>
              <dt className="font-display text-lg text-bone">Order</dt>
              <dd className="mt-1 text-bone/75">Your route against the shortest order of the same places, first and last stops kept.</dd>
            </div>
            <div>
              <dt className="font-display text-lg text-bone">Getting between</dt>
              <dd className="mt-1 text-bone/75">Each move by the way the country usually travels — and when a jump is really a flight.</dd>
            </div>
          </dl>
        </aside>
      </div>

      <div className="mt-10">
        <PlanCheck />
      </div>

      <p className="mt-14 rule-top pt-6 type-small text-ink-muted">
        Rather answer one question at a time?{' '}
        <Link href="/trips/new?have=plan" className="underline underline-offset-4 hover:text-pine">
          Start from a destination and add your plan as you go.
        </Link>
      </p>
    </div>
  );
}
