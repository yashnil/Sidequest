import { Fragment } from 'react';
import {
  PRIMARY_FORCED_CHOICE,
  PRODUCING_SYSTEMS,
  RATING_DIMENSIONS,
  isMeasured,
  labelForSystem,
  subjectsNotInInventory,
  type BlindAssignment,
  type Measurement,
  type PlanLabel,
  type ProducingSystem,
} from '@sidequest/bench';
import { caseById } from '@sidequest/bench/cases';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY, usd } from '@/components/benchmark/copy';
import { Badge, Panel } from '@/components/ui';
import { revealedPlanFor } from '@/lib/benchmark/blind';
import {
  getAssignment,
  getRunForArm,
  headPlanForRun,
  listBenchmarkSessions,
  type BenchmarkRun,
  type BenchmarkSession,
} from '@/lib/db/benchmark-repository';
import {
  getReview,
  getValidation,
  listCorrections,
  readRunMetrics,
} from '@/lib/db/benchmark-review-repository';

export const dynamic = 'force-dynamic';

/**
 * TOTALS, AND AN HONEST LABEL ON TOP OF THEM.
 *
 * The most dangerous artifact this phase can produce is a tidy dashboard of
 * percentages built from eight comparisons. It looks like a result, it gets
 * screenshotted, and the number behind it never travels with it. Four rules stop
 * that, and each is structural rather than a caveat in small print:
 *
 * **A weight label at the top that cannot be dismissed.** Derived, never chosen,
 * and derived from all four gates the pre-registered rules name rather than from
 * a session count alone — because thirty comparisons by one reviewer over one
 * kind of trip is thirty observations of one reviewer and one kind of trip.
 *
 * **No rate at all below the meaningful-sample label**, and none below a floor of
 * decided comparisons even above it. The gap between four and five wins out of
 * nine is twenty percentage points, and a rate would claim otherwise.
 *
 * **Every figure states what it was worked out from.** A mean of one review and a
 * mean of forty print identically without an `n` beside them, and the rule that
 * only one number on this page had to earn its denominator was the rule that let
 * fourteen others skip it.
 *
 * **No inferential statistics at all.** No p-value, no interval, and the word
 * "significant" appears nowhere. One reviewer over seventeen trips is not a
 * sample that supports any of them, and printing one would borrow authority the
 * design has not earned.
 *
 * Practice comparisons are aggregated separately and never mixed in — see
 * `sourceOf` for why the stored `seeded` flag is not on its own enough to make
 * that split.
 */

/** Below this many decided *and attributed* comparisons: counts, no division. */
const MIN_FOR_A_RATE = 10;

/**
 * §2 of `.claude-private/benchmark/decision-rules.md`, transcribed.
 *
 * All four have to hold at once. The count was the only one this page used to
 * check, which meant a label reading "meaningful sample" could sit above a
 * column of numbers produced by one person, on one kind of trip, with one of the
 * two display orders never drawn — the three confounds §3 spends a page saying a
 * pilot cannot separate.
 */
const SAMPLE_MIN_SESSIONS = 30;
const SAMPLE_MIN_REVIEWERS = 3;
const SAMPLE_MIN_BALANCED_CASE_TYPES = 4;

/**
 * What a run reports when nothing observed the state of the caches beneath it.
 *
 * Warmth used to be unrecoverable here for a structural reason — it is a
 * classification, `saveRunMetrics` stores one row per `Measurement`, and a plain
 * enum had nowhere to go — so every run printed as unknown and every latency
 * figure on this page pooled first runs with repeats. It now has its own column
 * on the run and each arm derives it from something it saw. This constant is the
 * honest remainder: a run whose warmth genuinely was not observed.
 */
const WARMTH_NOT_RECORDED = 'unknown';

export default async function DashboardPage() {
  const rows = listBenchmarkSessions(500).map(readSession);
  const live = rows.filter((row) => row.source === 'live');
  const fixture = rows.filter((row) => row.source === 'fixture');
  const gates = sampleGates(live);
  const weight = weightFor(live, gates);

  /*
   * THE SYSTEM NAMES DO NOT APPEAR UNTIL SOMETHING HAS BEEN REVEALED.
   *
   * This page is two clicks from every blind screen — the labs header links to
   * the index and the index links here — and it printed both producing systems
   * by name unconditionally, in every column heading and every row label. The
   * offline token scan passed because the names arrive as an imported constant
   * rather than as a string literal, and no browser assertion had ever been
   * pointed at this route.
   *
   * Nothing here is attributed to a system before that session is revealed, so
   * until at least one *has* been, the names label columns of nothing. They are
   * withheld until then. After a reveal the mapping is already the reviewer's,
   * and hiding it would be theatre rather than blinding.
   */
  const namesAreOut = rows.some((row) => row.attribution.length > 0);
  const nameOf = (system: ProducingSystem): string =>
    namesAreOut ? system : LABS_COPY.systemPlaceholder(PRODUCING_SYSTEMS.indexOf(system) + 1);


  return (
    <div className="mx-auto max-w-5xl px-3 py-8 sm:px-8 sm:py-12">
      <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {LABS_COPY.dashboardTitle}
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">{LABS_COPY.dashboardLede}</p>

      {/*
        Not dismissible, not collapsible, and above everything it qualifies. A
        caveat somebody has to open is a caveat that travels separately from the
        number it belongs to.
      */}
      <Panel className="mt-6 border-amber p-4" testId="weight-label">
        <p className="text-sm font-medium text-ink">{LABS_COPY.weightLabels[weight]}</p>
        <p className="measure mt-1 text-sm leading-relaxed text-ink-muted">
          {LABS_COPY.weightBodies[weight]}
        </p>

        {/*
          The distance to the next label, as readings rather than as a verdict.

          "Not enough yet" invites the reader to guess how much is missing and
          the guess is always generous. Three numbers against three thresholds
          is the same refusal with nothing left to imagine.
        */}
        {weight === 'sample' ? null : (
          <div className="mt-3 border-t border-rule pt-3">
            <p className="text-xs font-medium text-ink">{LABS_COPY.sampleGatesHeading}</p>
            <dl className="mt-2 grid gap-1 text-sm" data-testid="sample-gates">
              <Pair
                label={LABS_COPY.gateSessions}
                value={LABS_COPY.gateReading(gates.sessions, SAMPLE_MIN_SESSIONS)}
              />
              <Pair
                label={LABS_COPY.gateReviewers}
                value={LABS_COPY.gateReading(gates.reviewers, SAMPLE_MIN_REVIEWERS)}
              />
              <Pair
                label={LABS_COPY.gateCaseTypes}
                value={LABS_COPY.gateReading(
                  gates.balancedCaseTypes,
                  SAMPLE_MIN_BALANCED_CASE_TYPES,
                )}
              />
            </dl>
          </div>
        )}
      </Panel>

      <Aggregate
        heading={LABS_COPY.liveHeading}
        rows={live}
        weight={weight}
        nameOf={nameOf}
        testId="live-aggregate"
      />

      <Panel className="mt-10 border-dashed p-4">
        <h2 className="font-display text-xl text-ink">{LABS_COPY.fixtureHeading}</h2>
        <p className="measure mt-1 text-sm leading-relaxed text-ink-muted">
          {LABS_COPY.fixtureBody}
        </p>
      </Panel>
      {/*
        Always `smoke`, whatever the count. §2 is explicit that a fixture-driven
        session establishes nothing about either system, so a hundred of them
        still buy no rate.
      */}
      <Aggregate
        heading={LABS_COPY.fixtureHeading}
        rows={fixture}
        weight="smoke"
        nameOf={nameOf}
        testId="fixture-aggregate"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The evidence label
 * ------------------------------------------------------------------ */

type WeightLabel = 'smoke' | 'pilot' | 'sample';

interface SampleGates {
  sessions: number;
  reviewers: number;
  /** Case *types* with live sessions drawn into both display-order cells. */
  balancedCaseTypes: number;
}

/**
 * THE GATE COUNTS KINDS OF TRIP, NOT NAMES OF CASE.
 *
 * The pre-registered rules require at least four distinct case *types*. This
 * keyed on `caseId`, so thirty sessions drawn from four different city cases
 * satisfied it and the page printed "meaningful sample" — unlocking the §5
 * thresholds over a sample that exercised one kind of trip, which is the exact
 * confound §3 spends a page saying a pilot cannot separate. The type is on the
 * case already and is read a few lines below for the trait chips.
 *
 * And the balance is on which *system* was shown first, for the reason
 * `firstSystem` gives: the label cells are exchangeable by construction and
 * balancing them establishes nothing.
 */
function sampleGates(live: readonly SessionRow[]): SampleGates {
  const reviewers = new Set<string>();
  const cells = new Map<string, Set<ProducingSystem>>();
  for (const row of live) {
    if (row.reviewer !== null && row.reviewer.length > 0) reviewers.add(row.reviewer);
    if (row.caseKind === null || row.firstSystem === null) continue;
    const drawn = cells.get(row.caseKind) ?? new Set<ProducingSystem>();
    drawn.add(row.firstSystem);
    cells.set(row.caseKind, drawn);
  }
  return {
    sessions: live.length,
    reviewers: reviewers.size,
    balancedCaseTypes: [...cells.values()].filter((drawn) => drawn.size === 2).length,
  };
}

/**
 * Which of the three labels this aggregate has earned.
 *
 * The counts between the pilot's upper bound and the sample's lower one are
 * reported as a pilot rather than as something in between. §2 grants the sample
 * label on four conditions and grants nothing for being close to them, so the
 * only honest place for twenty comparisons by one reviewer is the label that
 * says it may point at something and settles nothing.
 */
function weightFor(live: readonly SessionRow[], gates: SampleGates): WeightLabel {
  if (live.length === 0) return 'smoke';
  const sample =
    gates.sessions >= SAMPLE_MIN_SESSIONS &&
    gates.reviewers >= SAMPLE_MIN_REVIEWERS &&
    gates.balancedCaseTypes >= SAMPLE_MIN_BALANCED_CASE_TYPES;
  return sample ? 'sample' : 'pilot';
}

/* ------------------------------------------------------------------ *
 * Reading one session
 * ------------------------------------------------------------------ */

interface Attribution {
  system: ProducingSystem;
  label: PlanLabel;
  scores: Record<string, number>;
  /** `null` when no validator ever ran. Never zero standing in for that. */
  critical: number | null;
  major: number | null;
  /** How many checks were actually decided, which is the honest denominator. */
  decided: number | null;
  /** Checks the shared inventory could not run because it lacked the place. */
  notInInventory: number | null;
  /** `null` when no correction round was attempted at all for this session. */
  corrections: number | null;
  firstValueMs: number | null;
  /** This arm's own operation time. Never what a person waited. */
  armMs: number | null;
  /** What a person waited for the whole comparison. Identical on both arms. */
  sessionWallMs: number | null;
  /** Of that, the part the machines owned. Identical on both arms. */
  sessionMachineMs: number | null;
  costMicroUsd: number | null;
  warmth: string;
  /** `null` when no plan existed. "No plan" and "cited nothing" are not one fact. */
  evidenceBacked: number | null;
  evidenceTotal: number | null;
}

interface SessionRow {
  source: 'live' | 'fixture';
  reviewed: boolean;
  primaryChoice: string | null;
  /** Who locked the review, for the reviewer-count gate. `null` until locked. */
  reviewer: string | null;
  /** The library case, for the record. `null` for a written request. */
  caseId: string | null;
  /** The *kind* of trip, which is what the case-type gate counts. */
  caseKind: string | null;
  /** Which label was drawn first. Kept for the gate's readability only. */
  firstLabel: PlanLabel | null;
  /**
   * WHICH *SYSTEM* WAS SHOWN FIRST — WHICH IS THE ONLY SPLIT THAT SEPARATES
   * POSITION FROM SYSTEM.
   *
   * The cells used to be keyed on the label. Label and order are two independent
   * coin flips, so each label-cell contains about half of each system, and the
   * two cells are exchangeable populations by construction: a reviewer with a
   * pure first-position preference produces about fifty per cent in both, which
   * is indistinguishable from no effect at all — while the copy beside it told
   * the reader that comparing the halves is exactly what separates the two.
   *
   * Split on the system that occupied position one and the same pure position
   * bias reads a hundred per cent against zero.
   *
   * `null` until the session is revealed, on the same rule attribution follows: a
   * dashboard that named the first-shown system before the reveal would be a side
   * channel out of a locked review.
   */
  firstSystem: ProducingSystem | null;
  /** Empty until the identities are out. See the note below. */
  attribution: Attribution[];
  traits: string[];
  partial: boolean;
  failed: boolean;
}

/**
 * One session, flattened.
 *
 * Nothing is attributed to a system until that session has been revealed, and
 * that rule is what keeps this page from being a side channel. A reviewer who
 * has locked but not revealed could otherwise open the dashboard, watch one
 * system's count go up by one, and learn which panel they had just chosen.
 * Everything that needs no identity — how many were started, reviewed, drawn —
 * is counted from every session regardless.
 */
function readSession(session: BenchmarkSession): SessionRow {
  const assignment = getAssignment(session.id);
  const review = getReview(session.id);
  const library = session.caseId === null ? null : caseById(session.caseId);
  const corrections = listCorrections(session.id);

  const runs = PRODUCING_SYSTEMS.map((system) => ({
    system,
    run: getRunForArm(session.id, system),
  }));

  const attribution: Attribution[] = [];
  if (session.revealedAt !== null && assignment !== null) {
    for (const { system, run } of runs) {
      const label = labelForSystem(assignment, system);
      const metrics = run === null ? {} : readRunMetrics(run.id);
      const head = run === null ? null : headPlanForRun(run.id);
      const report = head === null ? null : getValidation(head.id);
      const rating = review?.ratings.find((entry) => entry.label === label);
      const coverage = evidenceCoverage(session.id, label);

      attribution.push({
        system,
        label,
        scores: rating && rating.state === 'rated' ? { ...rating.scores } : {},
        critical: report === null ? null : report.counts.critical,
        major: report === null ? null : report.counts.major,
        decided: report === null ? null : report.verifiability.decided,
        notInInventory: report === null ? null : subjectsNotInInventory(report),
        /*
         * `null`, not `0`, when nobody asked for a change.
         *
         * "Both systems needed zero corrections" and "nobody ran the correction
         * experiment" printed identically — under a heading a pre-registered
         * threshold reads, which is the one place a fabricated zero does real
         * damage.
         */
        corrections:
          corrections.length === 0
            ? null
            : corrections.filter((round) => round.system === system).length,
        firstValueMs: valueOrNull(metrics.timeToFirstUsefulResultMs),
        armMs: valueOrNull(metrics.totalWallTimeMs),
        sessionWallMs: valueOrNull(metrics.sessionWallTimeMs),
        sessionMachineMs: valueOrNull(metrics.sessionMachineTimeMs),
        costMicroUsd: valueOrNull(metrics.estimatedCostMicroUsd),
        warmth: run?.warmth ?? WARMTH_NOT_RECORDED,
        evidenceBacked: coverage.backed,
        evidenceTotal: coverage.total,
      });
    }
  }

  return {
    source: sourceOf(session, assignment, runs),
    reviewed: review !== null,
    primaryChoice: review ? (review.choices[PRIMARY_FORCED_CHOICE] ?? null) : null,
    reviewer: review === null ? null : review.reviewer.trim().toLowerCase(),
    caseId: session.caseId,
    caseKind: library?.traits.kind ?? null,
    firstLabel: assignment?.firstLabel ?? null,
    firstSystem:
      session.revealedAt !== null && assignment !== null
        ? PRODUCING_SYSTEMS.find(
            (system) => labelForSystem(assignment, system) === assignment.firstLabel,
          ) ?? null
        : null,
    attribution,
    traits:
      library === null
        ? []
        : [
            library.traits.kind,
            library.traits.transit ? 'transit' : 'no transit',
            library.traits.dataStrength,
            library.traits.length,
          ],
    partial: runs.some(({ run }) => run?.state === 'partial'),
    failed: runs.some(({ run }) => run?.state === 'failed'),
  };
}

/**
 * WHETHER THIS COMPARISON WAS ACTUALLY RUN, OR MERELY WRITTEN DOWN.
 *
 * Answered from a fact the session recorded about itself at the press: were paid
 * operations permitted when it started.
 *
 * Two earlier answers were both wrong. `assignment.source` records how the coin
 * was drawn, which is a different question — a session started through the
 * ordinary composer draws `system` whether or not the build could call anything.
 * Then it was inferred from the spend ledger, requiring *both* arms to have
 * recorded a model call — and a fully warm compilation makes none, so a run of
 * twelve sessions on one destination filed eleven of them as practice. That bias
 * is one-sided and correlated with the outcome: the warmest, fastest, cheapest
 * sessions are the ones that disappear, and the pre-registered rules forbid
 * excluding a session for anything but a documented harness defect.
 *
 * A seeded draw still means fixture: the fixture seam writes plans directly and
 * spends nothing, and it is the only thing that draws seeded entropy outside the
 * offline suite.
 */
function sourceOf(
  session: BenchmarkSession,
  assignment: BlindAssignment | null,
  runs: readonly { system: ProducingSystem; run: BenchmarkRun | null }[],
): 'live' | 'fixture' {
  if (assignment === null || assignment.source === 'seeded') return 'fixture';
  if (runs.some(({ run }) => run === null)) return 'fixture';
  return session.paidMode ? 'live' : 'fixture';
}

function evidenceCoverage(
  sessionId: string,
  label: PlanLabel,
): { backed: number | null; total: number | null } {
  const stored = revealedPlanFor(sessionId, label);
  if (!stored) return { backed: null, total: null };
  let backed = 0;
  let total = 0;
  for (const day of stored.plan.days) {
    for (const block of day.blocks) {
      total += 1;
      if (block.evidence.length > 0) backed += 1;
    }
  }
  return { backed, total };
}

function valueOrNull(measurement: Measurement | undefined): number | null {
  return measurement !== undefined && isMeasured(measurement) ? measurement.value : null;
}

/* ------------------------------------------------------------------ *
 * The aggregate
 * ------------------------------------------------------------------ */

/**
 * A REACT KEY IS NOT A PRIVATE FIELD. IT IS IN THE PAYLOAD.
 *
 * Every `key={system}` on this page put the literal system name into the
 * serialised flight payload — placeholders on screen and the real names one
 * right-click away, on a route two clicks from every blind screen. This is the
 * failure the neutral projection exists to prevent, arriving through the one
 * attribute nobody thinks of as content.
 *
 * The key is the position: stable, unique, and silent.
 */
function keyOf(system: ProducingSystem): string {
  return String(PRODUCING_SYSTEMS.indexOf(system));
}

function Aggregate({
  heading,
  rows,
  weight,
  nameOf,
  testId,
}: {
  heading: string;
  rows: SessionRow[];
  weight: WeightLabel;
  /** Neutral until a session has been revealed. See `namesAreOut`. */
  nameOf: (system: ProducingSystem) => string;
  testId: string;
}) {
  const reviewed = rows.filter((row) => row.reviewed);
  const attributed = rows.filter((row) => row.attribution.length > 0);

  /*
   * ONE POPULATION, FOR THE GATE AND THE FRACTION ALIKE.
   *
   * The rate used to divide two different sets: every reviewed comparison on the
   * bottom, and only the revealed ones on the top. A locked-but-unrevealed
   * session is in the denominator and can be in neither numerator, so both
   * shares were pulled down and the two never summed to a hundred — a dashboard
   * quietly reporting that the two systems together won eighty per cent of the
   * comparisons between them. The gate was read off the wrong set too, so ten
   * reviews could unlock a rate computed over three.
   *
   * Attribution is the binding constraint and it has to be: a win cannot be
   * credited to a system whose identity is still sealed. So the set is decided
   * *and* attributed, and its size is printed beside the rate rather than left
   * for the reader to assume.
   */
  const decidedAndAttributed = rows.filter(
    (row) =>
      row.reviewed &&
      row.attribution.length > 0 &&
      (row.primaryChoice === 'A' || row.primaryChoice === 'B'),
  );
  const rateIsAllowed = weight === 'sample' && decidedAndAttributed.length >= MIN_FOR_A_RATE;

  return (
    <section aria-label={heading} data-testid={testId} className="mt-8">
      <Panel className="p-4 sm:p-5">
        <h2 className="font-display text-xl text-ink">{heading}</h2>
        <dl className="mt-4 grid gap-1 text-sm sm:grid-cols-2">
          <Pair label={LABS_COPY.totalSessions} value={String(rows.length)} />
          <Pair label={LABS_COPY.totalReviewed} value={String(reviewed.length)} />
          <Pair
            label={LABS_COPY.totalPartial}
            value={String(rows.filter((row) => row.partial).length)}
          />
          <Pair
            label={LABS_COPY.totalFailed}
            value={String(rows.filter((row) => row.failed).length)}
          />
        </dl>
      </Panel>

      <Panel className="mt-4 p-4 sm:p-5">
        <h3 className="text-sm font-medium text-ink">{LABS_COPY.choiceHeading}</h3>
        <dl className="mt-3 grid gap-1 text-sm">
          <Pair
            label={LABS_COPY.tieCount}
            value={String(reviewed.filter((row) => row.primaryChoice === 'tie').length)}
          />
          <Pair
            label={LABS_COPY.cannotJudgeCount}
            value={String(reviewed.filter((row) => row.primaryChoice === 'cannot_judge').length)}
          />
          {PRODUCING_SYSTEMS.map((system) => (
            <Pair
              key={keyOf(system)}
              label={`${LABS_COPY.winsLabel} — ${nameOf(system)}`}
              value={String(winsFor(decidedAndAttributed, system))}
            />
          ))}
        </dl>

        {/*
          THE SAME COUNTS, SPLIT BY WHICH PANEL WAS SHOWN FIRST.

          §4 of the pre-registered rules requires the primary metric reported per
          display-order cell "as well as pooled, always", and nothing computed it.
          That omission is not cosmetic: with one reviewer, first-position
          preference and system preference are confounded, and the *only* thing
          that can separate them is whether the same system wins in both cells.
          A pooled figure alone cannot distinguish "this system is better" from
          "this reviewer prefers the plan they read first".

          Counts, never a rate. Splitting a small sample in two produces cells
          small enough that a percentage would be actively misleading, and the
          floor that governs the pooled rate would refuse both of them anyway.
        */}
        <div className="mt-4 border-t border-rule pt-3">
          <h4 className="text-xs font-medium text-ink">{LABS_COPY.orderCellHeading}</h4>
          <p className="measure mt-1 text-xs leading-relaxed text-ink-muted">
            {LABS_COPY.orderCellWhy}
          </p>
          <dl className="mt-2 grid gap-1 text-sm" data-testid="order-cells">
            {PRODUCING_SYSTEMS.map((first) => {
              const cell = decidedAndAttributed.filter((row) => row.firstSystem === first);
              return (
                <Pair
                  key={keyOf(first)}
                  label={LABS_COPY.orderCellLabel(nameOf(first))}
                  value={
                    cell.length === 0
                      ? LABS_COPY.notMeasured
                      : `${PRODUCING_SYSTEMS.map(
                          (system) => `${nameOf(system)} ${winsFor(cell, system)}`,
                        ).join(' · ')} — ${LABS_COPY.sampleSize(cell.length)}`
                  }
                />
              );
            })}
          </dl>
        </div>

        <p className="mt-3 text-sm" data-testid="non-tied-rate">
          <span className="text-ink-muted">{LABS_COPY.nonTiedRate}: </span>
          {rateIsAllowed ? (
            <span className="tabular-nums text-ink">
              {PRODUCING_SYSTEMS.map(
                (system) =>
                  `${system} ${Math.round((winsFor(decidedAndAttributed, system) / decidedAndAttributed.length) * 100)}%`,
              ).join(' · ')}
            </span>
          ) : (
            <span className="text-ink">{LABS_COPY.tooFewForARate}</span>
          )}{' '}
          <span className="text-ink-muted">
            ({LABS_COPY.sampleSize(decidedAndAttributed.length)})
          </span>
        </p>
      </Panel>

      {/*
        A mean to one decimal place printed from one review looks exactly like a
        mean printed from forty, and the "no rates below a threshold" rule used
        to apply to precisely one number on this page. It applies to all of them
        now, and every figure that clears it states what it was worked out from.
      */}
      <Panel className="mt-4 p-4 sm:p-5">
        <h3 className="text-sm font-medium text-ink">{LABS_COPY.ratingsAverageHeading}</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-sm">
            <thead>
              <tr className="text-xs text-ink-faint">
                <th scope="col" className="py-1 pr-3 font-normal">
                  {LABS_COPY.ratingsAverageHeading}
                </th>
                {PRODUCING_SYSTEMS.map((system) => (
                  <th key={keyOf(system)} scope="col" className="py-1 pr-3 font-normal">
                    {nameOf(system)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RATING_DIMENSIONS.map((dimension) => (
                <tr key={dimension.id} className="border-t border-rule">
                  <th scope="row" className="py-1 pr-3 font-normal text-ink-muted">
                    {dimension.id.replace(/_/g, ' ')}
                  </th>
                  {PRODUCING_SYSTEMS.map((system) => (
                    <td key={keyOf(system)} className="py-1 pr-3 tabular-nums text-ink">
                      {averageScore(attributed, system, dimension.id)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel className="mt-4 p-4 sm:p-5">
        {/*
          Sums, and each says how much of itself it could actually see.

          A run with no validation report contributes no defect count, not a
          defect count of zero, and a metric nobody recorded contributes no cost.
          The old `?? 0` turned both absences into the most flattering possible
          number and printed it to four decimal places — "~ 0.0000" under a cost
          heading being, on a page built to be screenshotted, the single most
          quotable false statement it could have made.
        */}
        {/*
          COUNTS, THEIR DENOMINATOR, AND HOW FAR APART THE TWO DENOMINATORS ARE.

          A raw defect count is not comparable between the two arms and the page
          used to print one as though it were. The shared inventory the checker
          resolves against is the world the harness buys: that is one arm's whole
          planning input and only an overlapping subset of the other's, which
          compiles its own region. So one arm's stops resolve nearly always and
          the other's resolve sometimes, and *how exposed a plan is to being
          caught* differs for a reason that is a property of the instrument.

          The rate over decided checks is the comparable figure, and the
          not-in-inventory count is what tells a reader how far apart the two
          denominators were. Both are printed beside the counts rather than
          instead of them, because the counts are what a repair budget is spent
          on and are worth seeing.
        */}
        <h3 className="text-sm font-medium text-ink">{LABS_COPY.defectHeading}</h3>
        <p className="measure mt-1 text-xs leading-relaxed text-ink-muted">
          {LABS_COPY.defectsAreNotComparableInLevel}
        </p>
        <dl className="mt-3 grid gap-1 text-sm">
          {PRODUCING_SYSTEMS.map((system) => (
            <Fragment key={keyOf(system)}>
              <Pair
                label={`${nameOf(system)} — ${LABS_COPY.severities.critical}`}
                value={countText(sum(attributed, system, (entry) => entry.critical))}
              />
              <Pair
                label={`${nameOf(system)} — ${LABS_COPY.severities.major}`}
                value={countText(sum(attributed, system, (entry) => entry.major))}
              />
              <Pair
                label={`${nameOf(system)} — ${LABS_COPY.defectsDecided}`}
                value={countText(sum(attributed, system, (entry) => entry.decided))}
              />
              <Pair
                label={`${nameOf(system)} — ${LABS_COPY.defectsPerHundred}`}
                value={ratePerHundred(
                  sum(attributed, system, (entry) =>
                    entry.critical === null || entry.major === null
                      ? null
                      : entry.critical + entry.major,
                  ),
                  sum(attributed, system, (entry) => entry.decided),
                )}
              />
              <Pair
                label={`${nameOf(system)} — ${LABS_COPY.defectsNotInInventory}`}
                value={countText(sum(attributed, system, (entry) => entry.notInInventory))}
              />
            </Fragment>
          ))}
        </dl>

        <h3 className="mt-5 text-sm font-medium text-ink">{LABS_COPY.correctionsHeading}</h3>
        <dl className="mt-3 grid gap-1 text-sm">
          {PRODUCING_SYSTEMS.map((system) => (
            <Pair
              key={keyOf(system)}
              label={nameOf(system)}
              value={countText(sum(attributed, system, (entry) => entry.corrections))}
            />
          ))}
        </dl>

        {/*
          TWO CLOCKS, LABELLED APART, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.

          The per-arm figure is one planner's own operation time: it excludes the
          shared world-buying, the other arm, and every second spent waiting for
          the traveller to answer. It is the right number to compare *between*
          the two systems and it is emphatically not the number to quote as "how
          long this takes" — the arms run one after the other, so adding them and
          hoping is exactly the mistake the separation exists to prevent.

          The session figures below it are what a person sat through, and the
          machine figure is that less the time they spent answering. They are
          identical on both arms by construction, like the shared preparation,
          and are printed once per system only because this table has a column
          per system.
        */}
        <h3 className="mt-5 text-sm font-medium text-ink">{LABS_COPY.timingHeading}</h3>
        <p className="measure mt-1 text-xs leading-relaxed text-ink-muted">
          {LABS_COPY.timingClocksDiffer}
        </p>
        <dl className="mt-3 grid gap-1 text-sm">
          {PRODUCING_SYSTEMS.map((system) => (
            <Fragment key={keyOf(system)}>
              <Pair
                label={`${nameOf(system)} — ${LABS_COPY.timeToFirstValue}`}
                value={mean(attributed, system, (entry) => entry.firstValueMs)}
              />
              <Pair
                label={`${nameOf(system)} — ${LABS_COPY.timeArmOperation}`}
                value={mean(attributed, system, (entry) => entry.armMs)}
              />
            </Fragment>
          ))}
        </dl>
        <dl className="mt-3 grid gap-1 border-t border-rule pt-3 text-sm">
          <Pair
            label={LABS_COPY.timeSessionWall}
            value={mean(attributed, PRODUCING_SYSTEMS[0], (entry) => entry.sessionWallMs)}
          />
          <Pair
            label={LABS_COPY.timeSessionMachine}
            value={mean(attributed, PRODUCING_SYSTEMS[0], (entry) => entry.sessionMachineMs)}
          />
        </dl>

        <h3 className="mt-5 text-sm font-medium text-ink">{LABS_COPY.costHeading}</h3>
        <p className="measure mt-1 text-xs leading-relaxed text-ink-muted">
          {LABS_COPY.costIsAnEstimate}
        </p>
        <dl className="mt-2 grid gap-1 text-sm">
          {PRODUCING_SYSTEMS.map((system) => (
            <Pair
              key={keyOf(system)}
              label={nameOf(system)}
              value={totalText(
                sum(attributed, system, (entry) => entry.costMicroUsd),
                (value) => usd(value),
                LABS_COPY.notPriced,
              )}
            />
          ))}
        </dl>

        <h3 className="mt-5 text-sm font-medium text-ink">{LABS_COPY.evidenceHeading}</h3>
        <dl className="mt-3 grid gap-1 text-sm">
          {PRODUCING_SYSTEMS.map((system) => (
            <Pair
              key={keyOf(system)}
              label={nameOf(system)}
              value={`${countText(sum(attributed, system, (entry) => entry.evidenceBacked))} / ${countText(sum(attributed, system, (entry) => entry.evidenceTotal))}`}
            />
          ))}
        </dl>

        <h3 className="mt-5 text-sm font-medium text-ink">{LABS_COPY.warmthHeading}</h3>
        <dl className="mt-3 grid gap-1 text-sm">
          <Pair label={LABS_COPY.warmthCold} value={String(countWarmth(attributed, 'cold'))} />
          <Pair label={LABS_COPY.warmthWarm} value={String(countWarmth(attributed, 'warm'))} />
          <Pair label={LABS_COPY.warmthMixed} value={String(countWarmth(attributed, 'mixed'))} />
          <Pair
            label={LABS_COPY.warmthUnknown}
            value={String(countWarmth(attributed, WARMTH_NOT_RECORDED))}
          />
        </dl>
      </Panel>

      <Panel className="mt-4 p-4 sm:p-5">
        <h3 className="text-sm font-medium text-ink">{LABS_COPY.breakdownHeading}</h3>
        <ul className="mt-3 flex flex-wrap gap-2" data-testid="trait-chips">
          {traitCounts(rows).map((entry) => (
            <li key={entry.trait}>
              <Badge tone="neutral">
                {entry.trait.replace(/_/g, ' ')} · {entry.count}
              </Badge>
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Arithmetic, all of it descriptive
 * ------------------------------------------------------------------ */

function winsFor(rows: SessionRow[], system: ProducingSystem): number {
  return rows.filter((row) =>
    row.attribution.some((entry) => entry.system === system && entry.label === row.primaryChoice),
  ).length;
}

/**
 * A total, and how much of itself it could see.
 *
 * `over` is how many of the `of` runs contributed a value at all. When the two
 * differ the total is a floor, and saying so is the whole reason this returns a
 * shape rather than a number: the previous version coalesced every absence to
 * zero, so a system whose metrics were never recorded showed a complete-looking
 * total of nothing at all.
 */
interface Total {
  total: number;
  over: number;
  of: number;
}

function sum(
  rows: SessionRow[],
  system: ProducingSystem,
  pick: (entry: Attribution) => number | null,
): Total {
  let total = 0;
  let over = 0;
  let of = 0;
  for (const row of rows) {
    for (const entry of row.attribution) {
      if (entry.system !== system) continue;
      of += 1;
      const value = pick(entry);
      if (value === null) continue;
      over += 1;
      total += value;
    }
  }
  return { total, over, of };
}

/** A count, said the way `totalText` says everything else. */
function countText(total: Total): string {
  return totalText(total, (value) => String(value));
}

/**
 * A total as a sentence, with its own completeness in it.
 *
 * The prefix travels with the number rather than only with a footnote beneath
 * it, because the number is what gets copied out of this page and the footnote
 * is what stays behind.
 */
function totalText(
  total: Total,
  render: (value: number) => string,
  /** What an all-absent total says. "Not validated" is wrong under a cost. */
  whenNoneMeasured: string = LABS_COPY.notValidated,
): string {
  if (total.of === 0) return LABS_COPY.notMeasured;
  if (total.over === 0) return whenNoneMeasured;
  const figure = render(total.total);
  return total.over < total.of
    ? `${LABS_COPY.atLeastPrefix} ${figure} — ${LABS_COPY.atLeastOverRuns(total.over, total.of)}`
    : `${figure} — ${LABS_COPY.overRuns(total.of)}`;
}

/**
 * A mean, its `n`, or a refusal.
 *
 * Under the threshold this prints the same "too few to give a rate" the win rate
 * does. A mean *is* a rate — a total divided by a count — and exempting it
 * because it happens to be printed in a table was how fourteen of the fifteen
 * rating dimensions came to report one-decimal figures drawn from a single
 * review.
 */
function mean(
  rows: SessionRow[],
  system: ProducingSystem,
  pick: (entry: Attribution) => number | null,
): string {
  return meanText(collect(rows, system, pick), (average) => String(Math.round(average)));
}

function averageScore(rows: SessionRow[], system: ProducingSystem, dimensionId: string): string {
  const values = collect(rows, system, (entry) => entry.scores[dimensionId] ?? null);
  return meanText(values, (average) => average.toFixed(1));
}

function collect(
  rows: SessionRow[],
  system: ProducingSystem,
  pick: (entry: Attribution) => number | null,
): number[] {
  const values: number[] = [];
  for (const row of rows) {
    for (const entry of row.attribution) {
      if (entry.system !== system) continue;
      const value = pick(entry);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

function meanText(values: readonly number[], render: (average: number) => string): string {
  const size = LABS_COPY.sampleSize(values.length);
  if (values.length === 0) return `${LABS_COPY.notMeasured} — ${size}`;
  if (values.length < MIN_FOR_A_RATE) return `${LABS_COPY.tooFewForARate} — ${size}`;
  const average = values.reduce((left, right) => left + right, 0) / values.length;
  return `${render(average)} — ${size}`;
}

/**
 * A rate, or a refusal, and never a division by a number nobody measured.
 *
 * Printed to one decimal because the difference between 1.2 and 1.8 defects per
 * hundred checks is real and the difference between 1.24 and 1.26 is not.
 */
function ratePerHundred(defects: Total, decided: Total): string {
  if (decided.over === 0 || decided.total <= 0) return LABS_COPY.notMeasured;
  if (defects.over === 0) return LABS_COPY.notValidated;
  const rate = (defects.total / decided.total) * 100;
  const prefix = defects.over < defects.of || decided.over < decided.of ? `${LABS_COPY.atLeastPrefix} ` : '';
  return `${prefix}${rate.toFixed(1)} — ${LABS_COPY.overRuns(decided.of)}`;
}

function countWarmth(rows: SessionRow[], warmth: string): number {
  let total = 0;
  for (const row of rows) {
    for (const entry of row.attribution) {
      if (entry.warmth === warmth) total += 1;
    }
  }
  return total;
}

function traitCounts(rows: SessionRow[]): { trait: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const trait of row.traits) counts.set(trait, (counts.get(trait) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([trait, count]) => ({ trait, count }))
    .sort((left, right) => (left.trait < right.trait ? -1 : 1));
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}
