import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonClass, cx } from '../ui';
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  HomeIcon,
  InfoIcon,
  PencilIcon,
  PeopleIcon,
  RouteIcon,
} from './icons';

/**
 * THE BOARD'S HEADER — where am I, what is this trip, what do I do here.
 *
 * Three answers, each glanceable: a three-step trail (answers → places → trip)
 * so a first-time traveller knows this is the middle step; the trip itself as
 * a row of small fact chips; and one line of instruction. Where the places came
 * from is a single chip that opens into the honest sentence rather than a
 * paragraph in front of the board.
 *
 * Server-renderable: no state, no effects. The provenance disclosure is a
 * native `<details>`, so it works before hydration and with no script.
 */
export function BoardHeader({
  tripId,
  title,
  facts,
  planned,
  provenance,
  rescan,
}: {
  tripId: string;
  title: string;
  facts: { dates: string; days: number; travellers: string; base: string; reach: string };
  planned: boolean;
  /** Null when the board was not built by a Discovery scan, which then makes no claim about its sources. */
  provenance: 'research' | 'open-data' | null;
  /** The rescan control, when this board can be rescanned. */
  rescan: ReactNode;
}) {
  return (
    <header className="board-header pb-6">
      <nav aria-label="Trip steps" className="print:hidden">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-medium text-ink-muted">
          <li>
            <Link
              href={`/trips/${tripId}/questionnaire`}
              className="inline-flex items-center gap-1.5 rounded-full py-1 pr-1 hover:text-ink"
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-pine text-paper">
                <CheckIcon className="h-3 w-3" />
              </span>
              Your answers
            </Link>
          </li>
          <li aria-hidden="true" className="h-px w-5 bg-ink/20" />
          <li aria-current="step" className="inline-flex items-center gap-1.5 text-ink">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-ink font-mono text-[10px] text-paper">2</span>
            Pick places
          </li>
          <li aria-hidden="true" className="h-px w-5 bg-ink/20" />
          <li>
            {planned ? (
              <Link
                href={`/trips/${tripId}/itinerary`}
                className="inline-flex items-center gap-1.5 rounded-full py-1 pr-1 hover:text-ink"
              >
                <span className="grid h-5 w-5 place-items-center rounded-full border border-ink/30 font-mono text-[10px]">3</span>
                Your trip
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <span className="grid h-5 w-5 place-items-center rounded-full border border-ink/30 font-mono text-[10px]">3</span>
                Your trip
              </span>
            )}
          </li>
        </ol>
      </nav>

      <h1 className="display-stage mt-4 text-ink">{title}</h1>

      <ul className="mt-4 flex flex-wrap gap-1.5" data-testid="trip-line" aria-label="This trip">
        <FactChip icon={<CalendarIcon />}>
          {facts.dates} · {facts.days} days
        </FactChip>
        <FactChip icon={<PeopleIcon />}>{facts.travellers}</FactChip>
        <FactChip icon={<HomeIcon />}>Staying in {facts.base}</FactChip>
        <FactChip icon={<RouteIcon />}>{facts.reach}</FactChip>
      </ul>

      <div className="mt-5 flex flex-wrap items-center gap-2 print:hidden">
        {planned ? (
          <Link href={`/trips/${tripId}/itinerary`} className={cx(buttonClass('primary', 'sm'), 'pl-4')}>
            View your trip
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        ) : null}
        <Link href={`/trips/${tripId}/questionnaire`} className={cx(buttonClass('ghost', 'sm'), 'gap-1.5')}>
          <PencilIcon className="h-3.5 w-3.5" />
          Change my answers
        </Link>
        {rescan ? <div className="board-header-rescan contents">{rescan}</div> : null}
      </div>

      <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-ink-muted">
        <Step n={1}>Tick what sounds good</Step>
        <span aria-hidden="true" className="text-ink-faint">→</span>
        <Step n={2}>or let us choose</Step>
        <span aria-hidden="true" className="text-ink-faint">→</span>
        <Step n={3}>build your trip</Step>
      </p>

      {provenance ? <ProvenanceChip source={provenance} /> : null}
    </header>
  );
}

function FactChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-ink/12 bg-paper-raised/70 px-3 py-1 text-[13px] text-ink backdrop-blur-[2px]">
      <span className="text-ink-muted">{icon}</span>
      {children}
    </li>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="grid h-[18px] w-[18px] place-items-center rounded-full bg-ink/8 font-mono text-[10px] text-ink">
        {n}
      </span>
      <span className="text-ink">{children}</span>
    </span>
  );
}

/**
 * Where these places came from, as one chip that opens into the full sentence.
 *
 * The open-data case is the one that must never be silent: when the research
 * model could not answer, the board was built from open map data, and the chip
 * says so in its own label — the detail is a press away, the fact is not.
 */
function ProvenanceChip({ source }: { source: 'research' | 'open-data' }) {
  const openData = source === 'open-data';
  return (
    <details className="board-provenance group relative mt-4 w-fit" data-testid="board-provenance" data-source={source}>
      <summary
        className={cx(
          'inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium [&::-webkit-details-marker]:hidden',
          openData ? 'bg-slate-blue-soft text-slate-blue' : 'bg-pine-soft text-pine',
        )}
      >
        <InfoIcon className="h-3.5 w-3.5" />
        {openData ? 'From open map data' : 'Picked by Sidequest for you'}
        <span className="sr-only"> — how this list was made</span>
      </summary>
      <p className="measure mt-2 rounded-[var(--radius-card)] border border-ink/10 bg-paper-raised p-3 text-[13px] leading-relaxed text-ink-muted shadow-panel">
        {openData
          ? 'Our research step wasn’t available, so these places come from OpenStreetMap and Wikidata — notable places near you, ranked by your interests. Rescanning replaces the list.'
          : 'Sidequest’s research proposed these places for how you travel, and placed each one on a real map. Rescan any time: your picks on places that still appear are kept.'}
      </p>
    </details>
  );
}
