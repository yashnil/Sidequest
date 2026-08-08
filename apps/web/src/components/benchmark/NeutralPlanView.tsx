import type { ReactNode } from 'react';
import type { BlindPlan } from '@sidequest/bench';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY, clockTime, durationText } from './copy';
import type { NeutralPanel } from './neutral-dto';

/**
 * ONE RENDERER, TWO PANELS, ONE SHAPE.
 *
 * Both plans go through this component and there is no second path, no
 * conditional branch on which panel is being drawn, and no prop that could carry
 * one. `render.test.ts` renders two structurally identical plans through it and
 * asserts the markup is byte-identical apart from `data-plan-label` — which is
 * the only attribute permitted to differ, and is there so the review form can
 * associate a rating with a panel.
 *
 * The heading that says "Plan A" is deliberately *not* in here. If it were, the
 * two markups would differ by more than the one attribute and the byte-identity
 * test would have to be weakened into a fuzzy comparison — at which point it
 * would stop catching the thing it exists to catch. The label is rendered once,
 * by the wrapper.
 *
 * Every section is always present, including when there is nothing in it, and
 * that is the other half of the guarantee. Hiding an empty section would mean a
 * plan that states its sources renders eleven sections and a plan that does not
 * renders ten, and a reviewer who noticed that once would have a rule for the
 * rest of the sitting. So absence has an explicit rendering — the same sentence,
 * in the same element, for both.
 */

export function NeutralPlanView({ panel }: { panel: NeutralPanel }) {
  const state = LABS_COPY.panelStates[panel.state];
  const plan = panel.plan;

  return (
    <article data-plan-label={panel.label} data-testid="plan-body" className="min-w-0">
      <div className="border-b border-rule pb-4">
        <p data-field="state-title" className="text-sm font-medium text-ink">
          {state.title}
        </p>
        {/*
          No version counter here, and its absence is deliberate.

          A per-panel "2 / 3" is a fact about one arm, and the moment one of them
          produces a revised plan and the other does not, the two columns are
          labelled for the rest of the sitting. How many rounds the *comparison*
          has been through is a fact about the comparison, and is shown once, on
          the surface that asks for a change.
        */}
        <p data-field="state-body" className="measure mt-1 text-sm leading-relaxed text-ink-muted">
          {state.body}
        </p>
      </div>

      <Section id="summary" heading={LABS_COPY.planSummary}>
        <p className="measure text-sm leading-relaxed text-ink">
          {plan && plan.summary.length > 0 ? plan.summary : NEUTRAL_COPY.notStated}
        </p>
      </Section>

      <Section id="outline" heading={LABS_COPY.planOutline}>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Row label={LABS_COPY.planWhere} value={plan ? plan.destination.name : NEUTRAL_COPY.notStated} />
          <Row
            label={LABS_COPY.planWhen}
            value={plan ? `${plan.startDate} → ${plan.endDate}` : NEUTRAL_COPY.notStated}
          />
          <Row
            label={LABS_COPY.planHowWide}
            value={plan && plan.scopeNote.length > 0 ? plan.scopeNote : NEUTRAL_COPY.notStated}
          />
        </dl>
      </Section>

      <Section id="bases" heading={NEUTRAL_COPY.sections.bases}>
        <List
          items={(plan?.bases ?? []).map((base) => (
            <>
              <span className="font-medium text-ink">{base.place.name}</span>
              <span className="text-ink-muted">
                {' · '}
                {LABS_COPY.nights} {base.nights}
              </span>
              {base.why.length > 0 ? (
                <span className="mt-0.5 block text-ink-muted">{base.why}</span>
              ) : null}
            </>
          ))}
          empty={LABS_COPY.noBases}
        />
      </Section>

      <Section id="days" heading={NEUTRAL_COPY.sections.days}>
        {plan && plan.days.length > 0 ? (
          <ol className="grid gap-4">
            {plan.days.map((day) => (
              <li key={`${day.dayNumber}-${day.date}`} className="min-w-0">
                <PlanDayView day={day} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-ink-muted">{LABS_COPY.noDays}</p>
        )}
      </Section>

      <Section id="exclusions" heading={NEUTRAL_COPY.sections.exclusions}>
        <List
          items={(plan?.exclusions ?? []).map((exclusion) => (
            <>
              <span className="font-medium text-ink">{exclusion.place.name}</span>
              <span className="mt-0.5 block text-ink-muted">{exclusion.reason}</span>
            </>
          ))}
          empty={LABS_COPY.noExclusions}
        />
      </Section>

      <Section id="unknowns" heading={NEUTRAL_COPY.sections.unknowns}>
        <List
          items={(plan?.unknowns ?? []).map((entry) => <>{entry}</>)}
          empty={NEUTRAL_COPY.noUnknowns}
        />
      </Section>

      <Section id="preparation" heading={NEUTRAL_COPY.sections.preparation}>
        <List
          items={(plan?.preparation ?? []).map((entry) => <>{entry}</>)}
          empty={LABS_COPY.noPreparation}
        />
      </Section>

      <Section id="warnings" heading={NEUTRAL_COPY.sections.warnings}>
        <List
          items={(plan?.warnings ?? []).map((entry) => <>{entry}</>)}
          empty={LABS_COPY.noWarnings}
        />
      </Section>

      {/*
        Hosts, never links.

        The plan schema keeps a full URL for the post-reveal diagnostics and says
        plainly that the pre-reveal surface gets the host alone. The reason is
        not tidiness: a URL that reached an `href` would be a string one of the
        two systems chose, rendered as something the reviewer's browser will
        follow, and the free-text field of a benchmark request is the one place
        an attacker controls.
      */}
      <Section id="sources" heading={NEUTRAL_COPY.sections.sources}>
        <List
          items={(plan?.sources ?? []).map((source) => (
            <>
              <span className="text-ink">{source.host}</span>
              {source.title ? <span className="text-ink-muted">{` · ${source.title}`}</span> : null}
            </>
          ))}
          empty={NEUTRAL_COPY.noSources}
        />
      </Section>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * A day
 * ------------------------------------------------------------------ */

function PlanDayView({ day }: { day: BlindPlan['days'][number] }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-rule bg-paper-sunk p-3">
      <p className="text-sm font-medium text-ink">
        {LABS_COPY.planDay} {day.dayNumber} · {day.date}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted">
        {day.theme.length > 0 ? day.theme : NEUTRAL_COPY.notStated}
      </p>

      {day.blocks.length > 0 ? (
        <ol className="mt-3 grid gap-2">
          {day.blocks.map((block, index) => (
            <li
              key={`${day.dayNumber}-${index}`}
              className="rounded-lg border border-rule bg-paper-raised p-2.5"
            >
              <PlanBlockView block={block} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-sm text-ink-muted">{LABS_COPY.emptyDay}</p>
      )}

      <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-3">
        <Row label={LABS_COPY.totalTravel} value={durationText(day.statedTotals.travelMinutes)} />
        <Row label={LABS_COPY.totalDrive} value={durationText(day.statedTotals.driveMinutes)} />
        <Row label={LABS_COPY.totalFree} value={durationText(day.statedTotals.freeMinutes)} />
      </dl>

      <div className="mt-3">
        <p className="text-xs font-medium text-ink">{NEUTRAL_COPY.sections.alternatives}</p>
        <List
          items={day.alternatives.map((alternative) => (
            <>
              <span className="text-ink">{alternative.place.name}</span>
              <span className="mt-0.5 block text-ink-muted">{alternative.trigger}</span>
            </>
          ))}
          empty={NEUTRAL_COPY.noAlternatives}
        />
      </div>

      <div className="mt-3">
        <p className="text-xs font-medium text-ink">{NEUTRAL_COPY.sections.warnings}</p>
        <List items={day.warnings.map((entry) => <>{entry}</>)} empty={LABS_COPY.noWarnings} />
      </div>
    </div>
  );
}

function PlanBlockView({ block }: { block: BlindPlan['days'][number]['blocks'][number] }) {
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        <span className="text-ink-faint tabular-nums">
          {clockTime(block.startMinute)}–{clockTime(block.endMinute)}
        </span>
        <span className="font-medium text-ink">{block.title}</span>
        <span className="text-xs text-ink-muted">{LABS_COPY.blockKinds[block.kind]}</span>
      </p>

      <dl className="mt-1.5 grid gap-1 text-xs">
        <Row label={NEUTRAL_COPY.sections.places} value={block.place?.name ?? NEUTRAL_COPY.notStated} />
        <Row
          label={NEUTRAL_COPY.sections.travel}
          value={
            block.travel
              ? `${LABS_COPY.travelModes[block.travel.mode]} · ${durationText(block.travel.minutes)}`
              : NEUTRAL_COPY.notStated
          }
        />
        <Row
          label={LABS_COPY.blockHowKnown}
          value={block.travel ? LABS_COPY.travelProvenances[block.travel.provenance] : NEUTRAL_COPY.notStated}
        />
        <Row
          label={NEUTRAL_COPY.sections.meals}
          value={
            block.meal
              ? `${LABS_COPY.mealSlots[block.meal.slot]} · ${LABS_COPY.mealStopKinds[block.meal.stopKind]}`
              : NEUTRAL_COPY.notStated
          }
        />
        <Row
          label={LABS_COPY.blockOpen}
          value={
            block.opening
              ? `${clockTime(block.opening.openMinute)}–${clockTime(block.opening.closeMinute)}`
              : NEUTRAL_COPY.notStated
          }
        />
        <Row
          label={LABS_COPY.blockNote}
          value={block.note.length > 0 ? block.note : NEUTRAL_COPY.notStated}
        />
        <Row
          label={LABS_COPY.blockUnsure}
          value={block.uncertainty.length > 0 ? block.uncertainty.join(' · ') : NEUTRAL_COPY.noUnknowns}
        />
        <Row
          label={LABS_COPY.blockSupport}
          value={block.evidence.length > 0 ? String(block.evidence.length) : NEUTRAL_COPY.noSources}
        />
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The three shapes everything above is built from
 * ------------------------------------------------------------------ */

function Section({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <section data-section={id} className="mt-5 min-w-0">
      <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">{heading}</h3>
      <div className="mt-2 min-w-0">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 sm:flex sm:gap-3">
      <dt className="shrink-0 text-ink-faint sm:w-40">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{value}</dd>
    </div>
  );
}

/**
 * A list, or the sentence that stands in for one.
 *
 * The empty case renders in the same element with the same classes as a
 * populated one, so the two differ in their text and in nothing else. It used to
 * be greyed, which sounds like a kindness and is a whole-page tell: a plan that
 * states fewer of its sources, exclusions, unknowns and warnings than the other
 * one reads as a wash of grey beside a column of black, and a reviewer picks
 * that up in peripheral vision long before they could name it. No token scan
 * catches a colour, so the colour does not vary.
 */
function List({ items, empty }: { items: ReactNode[]; empty: string }) {
  return (
    <ul className="grid gap-1.5 text-sm">
      {items.length === 0 ? (
        <li className="min-w-0">{empty}</li>
      ) : (
        items.map((item, index) => (
          <li key={index} className="min-w-0">
            {item}
          </li>
        ))
      )}
    </ul>
  );
}
