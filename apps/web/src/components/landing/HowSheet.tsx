import { HOW_TOUR as TOUR } from './how-sequence';
import { HowSequence } from './HowSequence';

/**
 * THE FRONT PAGE'S ONE SHEET — the product shown in its own language.
 *
 * Round 2 (2026-10): the three static rows became one scroll-directed
 * sequence (`HowSequence`): a stage that fills in — destination typed, one
 * question answered, candidates as numbered pins, five chosen, the order
 * drawn, a day — as six captions pass the reading line. Complete and legible
 * standing still: with no JavaScript or with reduced motion it is the whole
 * picture beside the six captions. Then the confidence legend, drawn with the
 * same line styles the maps use.
 *
 * Everything on it is the Iceland *example shape* the globe flies, and the
 * sheet says so in its margin and on the stage. The places are the example's
 * real towns; lines between them are straight and drawn dotted, and the one
 * distance is computed from their coordinates and labelled straight-line.
 */
export function HowSheet() {
  return (
    <section className="survey border-t border-ink/10" aria-labelledby="how-heading">
      <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8 sm:py-24">
        <p className="sheet-label text-ink-muted">How it works</p>
        <h2 id="how-heading" className="mt-6 max-w-4xl font-display text-[clamp(2.4rem,1.6rem+3vw,4.5rem)] leading-[0.96] font-[340] tracking-[-0.035em] text-ink">
          Answer once. <em className="font-[300]">Pick</em> what’s in. Get the days.
        </h2>
        <p className="mt-5 max-w-xl type-body text-ink-muted sm:text-lg">
          Watch Sidequest plan an example trip — {TOUR.days} days around Iceland — in six steps. <span className="whitespace-nowrap text-ink">Keep scrolling to play it ↓</span>
        </p>

        <HowSequence />

        <Legend />
      </div>
    </section>
  );
}

const LEGEND = [
  { word: 'Measured', line: 'Travel time from a real routing service.', sample: 'solid' },
  { word: 'Estimated', line: 'Worked out from distance and how you travel.', sample: 'dashed' },
  { word: 'Not measured', line: 'We couldn’t time it — and we tell you.', sample: 'dotted' },
  { word: 'Backup', line: 'An indoor plan for a rainy day.', sample: 'backup' },
  { word: 'Left out', line: 'What didn’t fit, and why.', sample: 'out' },
] as const;

/** The confidence vocabulary, drawn exactly as the maps draw it. */
function Legend() {
  return (
    <div className="mt-14" aria-labelledby="legend-heading">
      <h3 id="legend-heading" className="sheet-label text-ink-muted">
        How to read the lines on your plan
      </h3>
      <ul className="mt-4 grid min-w-0 border-t border-ink/15 sm:grid-cols-2 lg:grid-cols-5" aria-label="How a plan labels what it knows">
        {LEGEND.map((item) => (
          <li key={item.word} className="flex min-w-0 items-start gap-3 border-b border-ink/15 py-4 pr-4 lg:border-b-0">
            <Sample kind={item.sample} />
            <span className="min-w-0">
              <span className="block font-mono text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-ink">{item.word}</span>
              <span className="mt-1 block type-small text-ink-muted">{item.line}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sample({ kind }: { kind: (typeof LEGEND)[number]['sample'] }) {
  const common = { x1: 2, y1: 8, x2: 38, y2: 8, stroke: 'var(--color-route)', strokeWidth: 2.4, strokeLinecap: 'round' as const };
  return (
    <svg aria-hidden="true" viewBox="0 0 40 16" className="mt-0.5 h-4 w-10 shrink-0">
      {kind === 'solid' ? <line {...common} /> : null}
      {kind === 'dashed' ? <line {...common} strokeDasharray="6 4" strokeLinecap="butt" /> : null}
      {kind === 'dotted' ? <line {...common} stroke="var(--color-ink-muted)" strokeDasharray="0.1 5" /> : null}
      {kind === 'backup' ? <rect x={13} y={1} width={14} height={14} fill="none" stroke="var(--color-slate-blue)" strokeWidth={1.6} /> : null}
      {kind === 'out' ? (
        <g stroke="var(--color-ink-muted)" strokeWidth={1.6}>
          <circle cx={20} cy={8} r={6} fill="none" />
          <line x1={14} y1={14} x2={26} y2={2} />
        </g>
      ) : null}
    </svg>
  );
}
