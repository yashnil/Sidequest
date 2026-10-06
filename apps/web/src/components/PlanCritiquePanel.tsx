import type { PlanCritique } from '@/lib/planning/plan-critique';
import { Panel } from './ui';

/**
 * "I ALREADY HAVE A PLAN" — WHAT SIDEQUEST MADE OF IT.
 *
 * A server component over a pure critique (`planning/plan-critique.ts`): the
 * plan as the traveller wrote it, checked against the board's places, the same
 * travel minutes, daily windows, pace and forecast the build uses. It never
 * rewrites their plan; their places are already their own includes, so the
 * build keeps them and these sentences say what it will have to work around.
 */
const VERDICT_LABEL: Record<PlanCritique['verdict'], string> = {
  works: 'Works as written',
  works_with_changes: 'Works with changes',
  rethink: 'Needs rethinking',
};
const SEVERITY_LABEL = { major: 'Does not work', minor: 'Costs you', note: 'Worth knowing' } as const;

export function PlanCritiquePanel({ critique }: { critique: PlanCritique }) {
  return (
    <Panel className="mb-8 p-5" as="section" testId="plan-critique">
      <p className="eyebrow">Your plan, checked · {VERDICT_LABEL[critique.verdict]}</p>
      <p className="measure mt-2 text-base font-medium text-ink" data-testid="plan-critique-headline">
        {critique.headline}
      </p>
      {critique.findings.length > 0 ? (
        <ul className="mt-4 space-y-2.5">
          {critique.findings.map((finding, index) => (
            <li key={`${finding.kind}-${finding.dayNumber ?? 'all'}-${index}`} className="measure text-sm leading-relaxed text-ink-muted" data-testid="plan-critique-finding" data-kind={finding.kind} data-severity={finding.severity}>
              <span className={finding.severity === 'major' ? 'font-medium text-ink' : 'font-medium text-ink-muted'}>{SEVERITY_LABEL[finding.severity]}:</span> {finding.sentence}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-4 type-small text-ink-faint">
        {critique.matched} of {critique.named} places found on this trip. Every place you named is kept as your own pick.
        {critique.minutesEstimated ? ' Travel times are estimates from distance, not timed routes.' : ''}
      </p>
    </Panel>
  );
}
