import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  BENCH_SEVERITIES,
  PLAN_LABELS,
  subjectsNotInInventory,
  type BenchFinding,
  type BenchmarkPlan,
  type BenchSeverity,
  type Measurement,
  type PlanLabel,
  type ProducingSystem,
} from '@sidequest/bench';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY, redactForbidden, usd } from '@/components/benchmark/copy';
import { Badge, Panel, buttonClass } from '@/components/ui';
import { revealedMapping, revealedPlanFor } from '@/lib/benchmark/blind';
import {
  getBenchmarkSession,
  getRunForArm,
  nativeArtifactsForRun,
} from '@/lib/db/benchmark-repository';
import {
  getPostRevealAnswers,
  getValidation,
  readRunMetrics,
  sessionSpend,
} from '@/lib/db/benchmark-review-repository';
import { sessionIdFromParam } from '../session-id';
import { revealIdentitiesAction, savePostRevealAction } from './actions';

export const dynamic = 'force-dynamic';

const MICRO_PER_USD = 1_000_000;

/**
 * WHAT THE TWO WERE, AND EVERYTHING THAT COULD NOT BE SHOWN BEFORE.
 *
 * Three refusals hold this page up, and each is a `null` from a guarded function
 * rather than a check somebody remembered to write. `revealedMapping` returns
 * nothing until the session has actually been revealed; so does
 * `revealedPlanFor`, which is the only way to reach a plan that still carries
 * `producedBy`. A reviewer who typed this URL before locking sees the refusal,
 * and so does one who reached it by any other route.
 *
 * The identities are rendered as the stored identifiers rather than through a
 * display-name table. That is not terseness: a table mapping each system to a
 * pretty name would be the one place in this whole interface where a product
 * name appeared as a string literal, and the leakage scan over these modules
 * would have to grow an exception for the file most likely to be copied from.
 *
 * Cost is labelled an estimate everywhere it appears, because it is one — it
 * comes from a checked-in rate table, not from an invoice, and a benchmark that
 * reported it as spend would be making a claim it cannot support.
 */
export default async function SessionResultsPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const sessionId = sessionIdFromParam((await params).sessionId);
  const session = getBenchmarkSession(sessionId);
  if (!session) notFound();

  const locked = session.reviewLockedAt !== null;
  const mapping = revealedMapping(sessionId);

  if (!locked) {
    return (
      <Shell>
        <Panel className="p-5">
          <p className="measure text-sm leading-relaxed text-ink-muted">
            {LABS_COPY.resultsRefusal}
          </p>
          <Link
            href={`/labs/benchmark/${sessionId}/review`}
            className={`${buttonClass('secondary')} mt-5`}
          >
            {LABS_COPY.backToReview}
          </Link>
        </Panel>
      </Shell>
    );
  }

  if (mapping === null) {
    return (
      <Shell>
        <Panel className="p-5">
          <h2 className="font-display text-2xl text-ink">{LABS_COPY.revealHeading}</h2>
          <p className="measure mt-3 text-sm leading-relaxed text-ink-muted">
            {LABS_COPY.revealLede}
          </p>
          <form action={revealIdentitiesAction.bind(null, sessionId)} className="mt-5">
            <button type="submit" data-testid="reveal" className={buttonClass('primary')}>
              {LABS_COPY.revealButton}
            </button>
          </form>
        </Panel>
      </Shell>
    );
  }

  const spend = sessionSpend(sessionId);
  const columns = PLAN_LABELS.map((label) => buildColumn(sessionId, label, mapping[label]));
  const post = getPostRevealAnswers(sessionId);

  return (
    <Shell>
      <Panel className="p-4 sm:p-5" testId="identities">
        <h2 className="font-display text-2xl text-ink">{LABS_COPY.identityHeading}</h2>
        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
          {columns.map((column) => (
            <div key={column.label} className="flex items-center gap-3">
              <dt className="text-sm text-ink-faint">{NEUTRAL_COPY.planLabel(column.label)}</dt>
              <dd className="text-sm font-medium text-ink" data-testid={`identity-${column.label}`}>
                {column.system}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        {columns.map((column) => (
          <section
            key={column.label}
            aria-labelledby={`report-${column.label}`}
            className="min-w-0"
          >
            <Panel className="p-4 sm:p-5">
              <h2 id={`report-${column.label}`} className="font-display text-xl text-ink">
                {NEUTRAL_COPY.planLabel(column.label)} · {column.system}
              </h2>

              <Block heading={LABS_COPY.findingsHeading}>
                <Findings report={column.report} />
              </Block>

              {/*
                Two clocks, and the labels say which is which.

                `totalWallTimeMs` is this plan alone once it started. The two
                plans are built one after the other, so it is the right figure to
                compare between them and the wrong one to read as "how long this
                took me" — the session figures beneath it are that, and they are
                the same number in both columns by construction.
              */}
              <Block heading={LABS_COPY.latencyHeading}>
                <p className="measure text-xs leading-relaxed text-ink-muted">
                  {LABS_COPY.timingClocksDiffer}
                </p>
                <dl className="mt-2 grid gap-1 text-sm">
                  <Measure label={LABS_COPY.timeToFirstValue} value={column.metrics.timeToFirstUsefulResultMs} />
                  <Measure label={LABS_COPY.timeArmOperation} value={column.metrics.totalWallTimeMs} />
                  <Measure label={LABS_COPY.timeSharedPreparation} value={column.metrics.sharedPreparationMs} />
                  <Measure label={LABS_COPY.timeSessionWall} value={column.metrics.sessionWallTimeMs} />
                  <Measure label={LABS_COPY.timeHumanWait} value={column.metrics.humanAnswerWaitMs} />
                  <Measure label={LABS_COPY.timeSessionMachine} value={column.metrics.sessionMachineTimeMs} />
                </dl>
              </Block>

              <Block heading={LABS_COPY.warmthHeading}>
                <p className="text-sm text-ink">{column.warmth}</p>
                <p className="measure mt-1 text-xs leading-relaxed text-ink-muted">
                  {column.warmthBasis}
                </p>
              </Block>

              <Block heading={LABS_COPY.costHeading}>
                <p className="measure text-xs leading-relaxed text-ink-muted">
                  {LABS_COPY.costIsAnEstimate}
                </p>
                <dl className="mt-2 grid gap-1 text-sm">
                  {/*
                    One currency renderer, the same one the totals page uses. The
                    generic `Measure` printed "41000 micro_usd" here while the
                    session total two panels down printed "~ $0.0623" — the same
                    quantity in two units under the same heading, which is the
                    ambiguity the unit table exists to remove.
                  */}
                  <Pair
                    label={LABS_COPY.costHeading}
                    value={
                      column.metrics.estimatedCostMicroUsd?.state === 'measured'
                        ? usd(column.metrics.estimatedCostMicroUsd.value)
                        : (column.metrics.estimatedCostMicroUsd?.detail ?? NEUTRAL_COPY.unknownValue)
                    }
                  />
                </dl>
              </Block>

              <Block heading={LABS_COPY.evidenceHeading}>
                <p className="measure text-xs leading-relaxed text-ink-muted">
                  {LABS_COPY.evidenceBody}
                </p>
                <p className="mt-2 text-sm text-ink tabular-nums">
                  {column.evidence.backed} / {column.evidence.total}
                </p>
              </Block>

              <Block heading={LABS_COPY.parityHeading}>
                <p className="measure text-xs leading-relaxed text-ink-muted">
                  {LABS_COPY.parityBody}
                </p>
                {column.parity === null ? (
                  <p className="mt-2 text-sm text-ink">{LABS_COPY.parityNone}</p>
                ) : (
                  <dl className="mt-2 grid gap-1 text-sm">
                    <Pair
                      label={LABS_COPY.parityHeading}
                      value={LABS_COPY.parityCounts(
                        column.parity.binding,
                        column.parity.advisory,
                        column.parity.dropped,
                      )}
                    />
                    <Pair
                      label={LABS_COPY.transferHeading}
                      value={LABS_COPY.transferCounts(
                        column.parity.transferApplied,
                        column.parity.transferNotRepresentable,
                        column.parity.transferUnanswered,
                      )}
                    />
                  </dl>
                )}
              </Block>

              <details className="mt-5">
                <summary className="min-h-11 cursor-pointer text-sm text-ink">
                  {LABS_COPY.diagnosticsHeading}
                </summary>
                <p className="mt-1 text-xs text-ink-muted">{LABS_COPY.diagnosticsHint}</p>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-paper-sunk p-3 text-[11px] leading-relaxed text-ink-muted">
                  {column.diagnostics}
                </pre>
              </details>
            </Panel>
          </section>
        ))}
      </div>

      <Panel className="mt-6 p-4 sm:p-5">
        <h2 className="font-display text-xl text-ink">{LABS_COPY.costHeading}</h2>
        <dl className="mt-3 grid gap-1 text-sm">
          {/*
            A session whose every call went to a model with no row in the rate
            table has no total, and printing "~ 0.0000" for it would read as a
            comparison that cost nothing. A session that priced some of its calls
            has a floor rather than a total, and says so in the figure itself
            rather than only in the count beneath it — the number is what gets
            screenshotted, and the count beside it does not travel with it.
          */}
          <Pair
            label={LABS_COPY.costHeading}
            value={
              spend.costMicroUsd === null
                ? LABS_COPY.notMeasured
                : `${spend.unpricedCalls > 0 ? `${LABS_COPY.atLeastPrefix} ` : ''}~ ${(spend.costMicroUsd / MICRO_PER_USD).toFixed(4)}`
            }
          />
          <Pair label={LABS_COPY.unpricedCalls} value={String(spend.unpricedCalls)} />
        </dl>
        <p className="measure mt-2 text-xs leading-relaxed text-ink-muted">
          {LABS_COPY.costIsAnEstimate}
        </p>
      </Panel>

      <Panel className="mt-6 p-4 sm:p-5">
        <h2 className="font-display text-xl text-ink">{LABS_COPY.postRevealHeading}</h2>
        <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
          {LABS_COPY.postRevealLede}
        </p>
        <form action={savePostRevealAction.bind(null, sessionId)} className="mt-4 grid gap-4">
          <PostSelect
            name="slowerPlanJustifiesWait"
            label={LABS_COPY.postRevealQuestions.slowerPlanJustifiesWait}
            options={['yes', 'no', 'depends']}
            current={post?.slowerPlanJustifiesWait ?? null}
          />
          <PostSelect
            name="wouldWaitForTheBetterPlan"
            label={LABS_COPY.postRevealQuestions.wouldWaitForTheBetterPlan}
            options={['yes', 'no', 'only_for_some_trips']}
            current={post?.wouldWaitForTheBetterPlan ?? null}
          />
          <PostSelect
            name="wouldUseForARealTrip"
            label={LABS_COPY.postRevealQuestions.wouldUseForARealTrip}
            options={['A', 'B', 'either', 'neither']}
            current={post?.wouldUseForARealTrip ?? null}
          />
          <PostSelect
            name="wouldPayMoreFor"
            label={LABS_COPY.postRevealQuestions.wouldPayMoreFor}
            options={['A', 'B', 'no', 'unsure']}
            current={post?.wouldPayMoreFor ?? null}
          />
          <div>
            <label htmlFor="suspectedIdentityBecause" className="block text-sm font-medium text-ink">
              {LABS_COPY.postRevealQuestions.suspectedIdentityBecause}
            </label>
            <textarea
              id="suspectedIdentityBecause"
              name="suspectedIdentityBecause"
              rows={3}
              defaultValue={post?.suspectedIdentityBecause ?? ''}
              className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
            />
          </div>
          <div>
            <button type="submit" className={buttonClass('primary')} data-testid="post-reveal-save">
              {LABS_COPY.postRevealSave}
            </button>
          </div>
        </form>
        {post?.answeredAt ? (
          <p role="status" className="mt-2 text-sm text-ink-muted">
            {LABS_COPY.postRevealSaved}
          </p>
        ) : null}
      </Panel>
    </Shell>
  );
}

/* ------------------------------------------------------------------ *
 * One column of the report
 * ------------------------------------------------------------------ */

interface ReportColumn {
  label: PlanLabel;
  system: ProducingSystem;
  /**
   * `null` when no validator ever ran, which is not the same fact as a clean
   * report and must not be rendered as one.
   *
   * A column of zeroes under "what the checks found" reads as a plan that passed
   * everything, and it is the most flattering possible rendering of a plan
   * nobody checked. The two states are distinguished here rather than at the
   * point of display, because a `?? empty` at the boundary destroys the
   * distinction before any renderer can honour it.
   */
  report: {
    counts: Record<BenchSeverity, number>;
    attempted: number;
    decided: number;
    /** Checks the shared record could not run because it lacked the place. */
    notInInventory: number;
    findings: BenchFinding[];
  } | null;
  metrics: Record<string, Measurement | undefined>;
  evidence: { backed: number; total: number };
  /** Cold, warm or unknown, as this run observed it, with what it read that off. */
  warmth: string;
  warmthBasis: string;
  /**
   * What became of every field of the shared request inside this system, and of
   * every answer the follow-up round produced.
   *
   * `null` for the arm that keeps no such record. Shown only here, after the
   * reveal, because the report names fields in one system's own vocabulary.
   */
  parity: ParityRecord | null;
  diagnostics: string;
}

interface ParityRecord {
  binding: number;
  advisory: number;
  dropped: number;
  transferApplied: number;
  transferNotRepresentable: number;
  transferUnanswered: number;
}

function buildColumn(
  sessionId: string,
  label: PlanLabel,
  system: ProducingSystem,
): ReportColumn {
  const stored = revealedPlanFor(sessionId, label);
  const report = stored === null ? null : getValidation(stored.id);
  const run = getRunForArm(sessionId, system);

  return {
    label,
    system,
    report:
      report === null
        ? null
        : {
            counts: report.counts,
            attempted: report.verifiability.attempted,
            decided: report.verifiability.decided,
            notInInventory: subjectsNotInInventory(report),
            findings: report.findings,
          },
    metrics: run === null ? {} : readRunMetrics(run.id),
    evidence: evidenceCoverage(stored?.plan ?? null),
    warmth: run?.warmth ?? NEUTRAL_COPY.unknownValue,
    warmthBasis: run?.warmthBasis ?? NEUTRAL_COPY.unknownValue,
    parity: run === null ? null : parityFor(run.id),
    diagnostics:
      run === null
        ? NEUTRAL_COPY.unknownValue
        : JSON.stringify(nativeArtifactsForRun(run.id), null, 1).slice(0, 20_000),
  };
}

/**
 * THE PARITY RECORD, READ BACK OFF THE STORED ARTIFACT.
 *
 * It was computed on every run and thrown away — the single most useful artifact
 * for telling a difference in planning from a difference in plumbing, and no
 * reader of the results could see it. It is persisted now, and counted here
 * rather than dumped, because the number that matters is how many fields had
 * nowhere to land.
 *
 * Shaped defensively: the artifact is JSON from the store and a build that
 * changes the report's shape must not throw on this page.
 */
function parityFor(runId: string): ParityRecord | null {
  const artifact = nativeArtifactsForRun(runId).find((entry) => entry.kind === 'parity');
  if (!artifact) return null;
  const payload = artifact.payload as {
    fields?: { verdict?: unknown }[];
    transfer?: { verdict?: unknown }[];
  };
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  const transfer = Array.isArray(payload.transfer) ? payload.transfer : [];
  const count = (rows: { verdict?: unknown }[], verdict: string): number =>
    rows.filter((row) => row.verdict === verdict).length;

  return {
    binding: count(fields, 'binding'),
    advisory: count(fields, 'advisory'),
    dropped: count(fields, 'not_representable'),
    transferApplied: count(transfer, 'applied'),
    transferNotRepresentable: count(transfer, 'not_representable'),
    transferUnanswered: count(transfer, 'unanswered'),
  };
}

/**
 * What the checks found, or the fact that nothing checked.
 *
 * The absent case is a sentence rather than a column of zeroes. Zeroes under
 * "what the checks found" is the most flattering possible rendering of a plan
 * nobody validated, and it is indistinguishable from a plan that passed every
 * check — on the one screen where the two systems' defect counts sit side by
 * side.
 */
function Findings({ report }: { report: ReportColumn['report'] }) {
  if (report === null) return <p className="text-sm text-ink">{LABS_COPY.notValidated}</p>;

  return (
    <>
      <p className="measure text-xs leading-relaxed text-ink-muted">
        {LABS_COPY.defectsAreNotComparableInLevel}
      </p>
      <ul className="mt-2 grid gap-1.5 text-sm">
        {BENCH_SEVERITIES.map((severity) => (
          <li key={severity} className="flex items-center justify-between gap-3">
            <span className="text-ink-muted">{LABS_COPY.severities[severity]}</span>
            <span className="tabular-nums text-ink">{report.counts[severity]}</span>
          </li>
        ))}
      </ul>

      {/*
        The unknown count is printed beside verifiability rather than under the
        defects, and this is where that matters most. A plan that states nothing
        collects almost no defects, and reading the defect column alone would
        make silence look like quality.

        The two sentences sit outside the list rather than inside it. A `<p>`
        between a `<dt>` and its `<dd>` breaks the description-list mapping
        outright, and a screen reader then stops pairing the terms with their
        values and reads six unrelated fragments in a row.
      */}
      <div className="mt-4 rounded-lg bg-paper-sunk p-3">
        <p className="text-xs font-medium text-ink">{LABS_COPY.verifiabilityHeading}</p>
        <p className="measure mt-1 text-xs leading-relaxed text-ink-muted">
          {LABS_COPY.verifiabilityBody}
        </p>
        <dl className="mt-2 grid gap-1 text-sm">
          <Pair label={LABS_COPY.attempted} value={String(report.attempted)} />
          <Pair label={LABS_COPY.decided} value={String(report.decided)} />
          <Pair label={LABS_COPY.undecided} value={String(report.counts.unknown)} />
          <Pair
            label={LABS_COPY.defectsPerHundred}
            value={
              report.decided > 0
                ? (((report.counts.critical + report.counts.major) / report.decided) * 100).toFixed(1)
                : LABS_COPY.notMeasured
            }
          />
          <Pair
            label={LABS_COPY.defectsNotInInventory}
            value={String(report.notInInventory)}
          />
        </dl>
      </div>

      {report.findings.length > 0 ? (
        <ul className="mt-3 grid gap-1.5 text-xs text-ink-muted">
          {report.findings.slice(0, 12).map((finding, index) => (
            <li key={`${finding.code}-${index}`}>
              <Badge tone="neutral">{LABS_COPY.severities[finding.severity]}</Badge>{' '}
              {redactForbidden(finding.message)}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * How much of the day names something behind it.
 *
 * Counted over the blocks a plan actually wrote rather than over some notion of
 * what it should have written, because the two systems agreed to no such notion.
 * A plan with one day and one source is not being compared with a plan that has
 * fourteen — the fraction is, which is the only comparison the schema supports.
 */
function evidenceCoverage(plan: BenchmarkPlan | null): { backed: number; total: number } {
  if (plan === null) return { backed: 0, total: 0 };
  let backed = 0;
  let total = 0;
  for (const day of plan.days) {
    for (const block of day.blocks) {
      total += 1;
      if (block.evidence.length > 0) backed += 1;
    }
  }
  return { backed, total };
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-8 sm:py-12">
      <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
      <h1 className="mt-3 mb-8 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {LABS_COPY.resultsTitle}
      </h1>
      {children}
    </div>
  );
}

function Block({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint">{heading}</h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/**
 * A measurement, or the reason there is not one.
 *
 * Never a zero standing in for an absence. "Nobody measured this" and "this was
 * zero" are different facts and the union in the metrics schema exists so they
 * cannot be confused; rendering an unavailable measurement as `0` here would put
 * the confusion back at the last possible moment.
 */
function Measure({ label, value }: { label: string; value: Measurement | undefined }) {
  if (value === undefined) {
    return <Pair label={label} value={LABS_COPY.notMeasured} />;
  }
  if (value.state === 'measured') {
    return <Pair label={label} value={`${value.value} ${value.unit}`} />;
  }
  return <Pair label={label} value={`${LABS_COPY.notMeasured} — ${value.detail}`} />;
}

function PostSelect({
  name,
  label,
  options,
  current,
}: {
  name: string;
  label: string;
  options: readonly string[];
  current: string | null;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={name} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={current ?? ''}
        className="mt-2 min-h-11 w-full max-w-xs rounded-lg border border-rule bg-paper-raised px-3 text-sm text-ink"
      >
        <option value="">{NEUTRAL_COPY.notStated}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    </div>
  );
}
