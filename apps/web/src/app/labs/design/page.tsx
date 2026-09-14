import type { Metadata } from 'next';
import { ASSURANCE_COPY, ASSURANCE_TIERS, RERANK_LABELS, RERANK_CONTROLS, type AssuranceTier } from '@sidequest/core';
import { Badge, Panel, buttonClass, cx } from '@/components/ui';

/**
 * V11 §5 — THE DESIGN LAB: THE VISUAL SOURCE OF TRUTH.
 *
 * Every pattern the product is allowed to use, on one page, rendered by the
 * same primitives production renders. Not a styleguide written beside the code
 * — a page that *imports* `ui.tsx`, `ASSURANCE_COPY` and the real tokens, so it
 * cannot drift from what ships. If a swatch here looks wrong, the product looks
 * wrong.
 *
 * It exists because V11 counted what improvisation had cost: **eighteen**
 * distinct traveller-facing status labels drawn from four vocabularies,
 * **fourteen** distinct `rounded-*` values, **thirteen** tones on status
 * objects, and twenty-three files defining a pill. None of that was anyone's
 * decision; it is what happens when each component answers the question alone.
 *
 * ## Where it lives, and why
 *
 * Under the internal `/labs` prefix, which already has the gate this needs: `middleware.ts` matches
 * `/labs/:path*` and `labsAccess` closes it on any billable deployment unless
 * `SIDEQUEST_LABS_TOKEN` is presented. Putting the lab anywhere else would have
 * meant inventing a second gating mechanism to say the same thing, and two
 * mechanisms that must agree eventually do not. It is a plain server component
 * with no server action, so the action gate has nothing to guard here.
 */
export const metadata: Metadata = { title: 'Design lab', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-rule pt-8">
      <h2 id={id} className="type-section text-ink">
        {title}
      </h2>
      <p className="type-small mt-1 max-w-2xl text-ink-muted">{note}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-4 py-3">
      <span className="label w-40 shrink-0 text-ink-faint">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const ASSURANCE_CLASS: Record<AssuranceTier, string> = {
  confirmed: 'bg-pine-soft text-pine-strong',
  planned: 'bg-paper-sunk text-ink-muted',
  check: 'bg-amber-soft text-amber',
  unresolved: 'bg-clay-soft text-clay',
};

export default function DesignLabPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-6">
      <header>
        <p className="eyebrow text-ink-faint">Internal</p>
        <h1 className="display-lg mt-1 text-ink">Design lab</h1>
        <p className="type-body mt-3 max-w-2xl text-ink-muted">
          Every pattern the product may use, rendered by the primitives production renders. A new component reuses what is here rather than
          inventing a style. The rules behind each section are in the V11 design-system document.
        </p>
      </header>

      <div className="mt-10 grid gap-10">
        <Section id="type" title="Typography" note="Seven roles. A component that needs a size not on this list needs a different layout, not a new size. Nothing informational goes below 13px.">
          <div className="grid gap-3">
            <p className="display-hero text-ink">Display</p>
            <p className="display-lg text-ink">Page title</p>
            {/*
              V11 §C — IN THE ORDER THEY ACTUALLY RENDER.

              These two were listed the other way up and labelled "Section
              heading" and "Card heading" — and `type-title` is the larger of the
              two in `globals.css`. A styleguide that contradicts the stylesheet
              is worse than no styleguide: the Trip Pack was built from this list
              and came out with its sub-headings bigger than the sections holding
              them.
            */}
            <p className="type-title text-ink">View heading</p>
            <p className="type-section text-ink">Section heading</p>
            <p className="type-body text-ink">Body — the size a traveller reads a sentence at.</p>
            <p className="type-small text-ink-muted">Supporting — a second line under a heading.</p>
            <p className="type-meta text-ink-faint">Caption — the floor, 13px.</p>
            <p className="type-figure text-ink">08:15 · 4 h 20 · 288 km · $2,500</p>
          </div>
        </Section>

        <Section id="buttons" title="Buttons" note="One obvious primary per screen. If a screen seems to need two, it is two screens or one of them is secondary.">
          <Row label="Variants">
            <button type="button" className={buttonClass('primary')}>Primary</button>
            <button type="button" className={buttonClass('accent')}>Accent</button>
            <button type="button" className={buttonClass('secondary')}>Secondary</button>
            <button type="button" className={buttonClass('ghost')}>Quiet</button>
          </Row>
          <Row label="Sizes">
            <button type="button" className={buttonClass('secondary', 'sm')}>Small</button>
            <button type="button" className={buttonClass('secondary', 'md')}>Medium</button>
            <button type="button" className={buttonClass('secondary', 'lg')}>Large</button>
          </Row>
          <Row label="Disabled">
            <button type="button" disabled className={buttonClass('primary')}>Unavailable</button>
          </Row>
        </Section>

        <Section
          id="status"
          title="Status — four words, and only four"
          note="Eighteen traveller-facing labels from four internal vocabularies fold into these. The exact evidence state is kept on the record and shown on disclosure; it never sets the badge."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {ASSURANCE_TIERS.map((tier) => (
              <div key={tier} className="flex items-start gap-3">
                <span className={cx('inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium', ASSURANCE_CLASS[tier])}>{ASSURANCE_COPY[tier].label}</span>
                <span className="type-small text-ink-muted">{ASSURANCE_COPY[tier].blurb}</span>
              </div>
            ))}
          </div>
          <p className="type-meta mt-4 text-ink-faint">
            Aggregate rather than repeat: a day says “2 journey times still being worked out” once, not a badge on every row.
          </p>
        </Section>

        <Section id="pills" title="Pills" note="A pill earns its place by carrying a decision. A value that never changes is prose, not a chip.">
          <Row label="Tones">
            <Badge tone="pine">Confirmed</Badge>
            <Badge tone="neutral">Planned</Badge>
            <Badge tone="amber">Check</Badge>
            <Badge tone="clay">Still checking</Badge>
            <Badge tone="blue">On the water</Badge>
          </Row>
        </Section>

        <Section id="surfaces" title="Surfaces" note="Five, and a card may not contain a card. Inside a card, group with whitespace, a hairline and type hierarchy.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-[var(--radius-card)] bg-paper p-4">
              <p className="type-title text-ink">Canvas</p>
              <p className="type-small mt-1 text-ink-muted">The page ground.</p>
            </div>
            <Panel className="p-4">
              <p className="type-title text-ink">Elevated card</p>
              <p className="type-small mt-1 text-ink-muted">An object the traveller acts on.</p>
            </Panel>
            <div className="rounded-[var(--radius-card)] bg-paper-sunk p-4">
              <p className="type-title text-ink">Subtle panel</p>
              <p className="type-small mt-1 text-ink-muted">A well inside a card. No shadow, no second border.</p>
            </div>
            <div className="atlas rounded-[var(--radius-plate)] p-4">
              <p className="type-title">Dark hero / map</p>
              <p className="type-small mt-1 opacity-80">The brand’s second surface.</p>
            </div>
          </div>
        </Section>

        <Section id="timeline" title="Itinerary timeline" note="Time, activity, duration, travel between. Everything epistemic lives behind “Timing & checks”.">
          <Panel className="p-5">
            <p className="label text-ink-faint">Day 4 · The long drive</p>
            <p className="type-title mt-0.5 text-ink">First base → Second base</p>
            <p className="type-meta mt-1 text-ink-faint">Intense · about 4 h 20 driving</p>
            <ol className="mt-4 grid gap-0">
              {[
                { time: '07:00', title: 'Leave the first base', detail: null },
                { time: '08:15', title: 'A lake viewpoint', detail: '45 min' },
                { time: '10:30', title: 'A glacier stop', detail: 'Glacier walk' },
                { time: '13:30', title: 'Lunch', detail: null },
                { time: '15:00', title: 'A waterfall', detail: '30 min' },
                { time: '17:00', title: 'The second base', detail: 'Check in' },
              ].map((stop) => (
                <li key={stop.time} className="flex gap-4 border-l border-rule py-2.5 pl-4 first:pt-0 last:pb-0">
                  <span className="type-figure w-14 shrink-0 text-ink-muted">{stop.time}</span>
                  <span className="min-w-0">
                    <span className="block text-ink">{stop.title}</span>
                    {stop.detail ? <span className="type-meta block text-ink-faint">{stop.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
            <p className="type-meta mt-4 text-ink-faint">2 journey times still being worked out · Timing &amp; checks</p>
          </Panel>
        </Section>

        <Section id="recommendation" title="Recommendation card" note="Fit, best dates, trip shape, budget honesty, the burden of getting there, and one tradeoff. Never a fabricated fare.">
          <Panel className="p-5">
            <div className="flex items-start justify-between gap-4">
              <p className="type-title text-ink">A mountain region</p>
              <span className="type-meta text-ink-faint">Strong match</span>
            </div>
            <p className="type-small mt-1 text-ink-muted">20 Dec – 1 Jan · two bases, one long traverse</p>
            <p className="type-body mt-3 text-ink">Your strongest preference is demanding hiking, and this is the season for it.</p>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
              {[
                ['Getting there', 'A long way — about 10,500 km'],
                ['Budget', 'Tight at $2,500 a head, on the ground'],
                ['How busy', 'Peak season on the trails'],
                ['New to you', 'Yes'],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="label text-ink-faint">{k}</dt>
                  <dd className="type-small text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="type-meta mt-3 text-ink-faint">Tradeoff: two long flying days out of twelve.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={buttonClass('accent', 'sm')}>Plan this</button>
              <button type="button" className={buttonClass('secondary', 'sm')}>Why this over the next one?</button>
            </div>
          </Panel>
        </Section>

        <Section id="rerank" title="Reranking controls" note="Each one re-weights a dimension already measured, so pressing it is instant and needs no new evidence.">
          <Row label="Controls">
            {RERANK_CONTROLS.map((control) => (
              <button key={control} type="button" className={buttonClass('secondary', 'sm')}>
                {RERANK_LABELS[control]}
              </button>
            ))}
          </Row>
        </Section>

        <Section id="markers" title="Map markers" note="A base or a signature must dominate an ordinary stop. Six types, one weight each.">
          <Row label="Types">
            {[
              ['Gateway', 'h-4 w-4 rounded-sm bg-slate-blue'],
              ['Base', 'h-5 w-5 rounded-full bg-ink ring-2 ring-paper'],
              ['Signature', 'h-4 w-4 rounded-full bg-accent ring-2 ring-paper'],
              ['Stop', 'h-2.5 w-2.5 rounded-full bg-ink-faint'],
              ['Overnight experience', 'h-4 w-4 rounded-full bg-pine ring-2 ring-paper'],
              ['Unresolved', 'h-3 w-3 rounded-full border border-dashed border-ink-faint'],
            ].map(([label, cls]) => (
              <span key={label} className="inline-flex items-center gap-2">
                <span aria-hidden className={cls as string} />
                <span className="type-meta text-ink-muted">{label}</span>
              </span>
            ))}
          </Row>
        </Section>

        <Section id="states" title="Loading, empty and error" note="A skeleton keeps the layout; an empty state says what would fill it; an error says what to do.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Panel className="p-4">
              <div className="h-4 w-2/3 animate-pulse rounded bg-paper-sunk" />
              <div className="mt-2 h-3 w-full animate-pulse rounded bg-paper-sunk" />
              <div className="mt-1.5 h-3 w-4/5 animate-pulse rounded bg-paper-sunk" />
            </Panel>
            <Panel className="p-4">
              <p className="type-title text-ink">Nothing here yet</p>
              <p className="type-small mt-1 text-ink-muted">Trips you save will show up here.</p>
            </Panel>
            <Panel className="p-4">
              <p className="type-title text-clay">That did not work</p>
              <p className="type-small mt-1 text-ink-muted">Nothing was lost. Try again, or carry on and come back to it.</p>
            </Panel>
          </div>
        </Section>

        <Section id="radius" title="Radius" note="Four tokens and rounded-full. A literal pixel radius is always wrong.">
          <Row label="Tokens">
            {[
              ['plate', 'rounded-[var(--radius-plate)]'],
              ['panel', 'rounded-[var(--radius-panel)]'],
              ['card', 'rounded-[var(--radius-card)]'],
              ['control', 'rounded-[var(--radius-control)]'],
              ['full', 'rounded-full'],
            ].map(([label, cls]) => (
              <span key={label} className="inline-grid gap-1 text-center">
                <span aria-hidden className={cx('h-12 w-16 border border-rule bg-paper-raised', cls as string)} />
                <span className="type-meta text-ink-faint">{label}</span>
              </span>
            ))}
          </Row>
        </Section>
      </div>
    </div>
  );
}
