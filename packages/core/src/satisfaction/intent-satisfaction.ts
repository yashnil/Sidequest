import { z } from 'zod';
import { INTEREST_LABELS, type Interest } from '../schemas/common';
import { PREFERENCE_ROLE_RANK, ROLE_DEMANDS, type PreferenceRole } from '../intent/roles';
import type { DesiredFeeling, TravelerIntent } from '../intent/traveler-intent';
import type { TripOperatingModel } from '../operating/model';

/**
 * V12 §29–§36 — DID THE TRIP DELIVER WHAT THE TRAVELLER ASKED FOR?
 *
 * The V12 architecture audit's clearest finding was that nothing in the product
 * asks this. The quality compiler runs fifteen checks and every one is
 * structural or operational; `TripQualityReport` scores twelve dimensions and
 * **not one of them reads the traveller's preferences at all**. A trip could
 * score `strong` on all twelve while containing nothing the traveller wanted.
 * The only intent check anywhere is the contract's veto on contradictions,
 * which a trip that violates nothing and delivers nothing passes cleanly.
 *
 * This is the missing measure, and it is deliberately **not a score**. §29 is
 * explicit: for every goal, whether it is represented, how strongly, where, and
 * whether the coverage is real or token. A single number would hide exactly the
 * thing worth knowing.
 *
 * ── WHAT "SATISFIED" MEANS (§31) ────────────────────────────────────────────
 *
 * Not a checkbox. One ramen lunch does not satisfy food as a core reason for
 * going to Japan, and one two-hour walk does not satisfy a hiking trip. So
 * coverage is measured four ways and a goal has to earn its verdict on more than
 * one of them:
 *
 *   occurrences   — how many distinct days carry it
 *   timeShare     — how much of the trip's activity time it holds
 *   structural    — whether a chapter or base exists because of it
 *   distribution  — whether it is spread through the trip or bunched into a corner
 *
 * ── OMISSIONS ARE ALLOWED (§34) ─────────────────────────────────────────────
 *
 * A strong trip may leave something out. The gate must not reward stuffing: a
 * goal the plan explicitly and defensibly omitted is recorded as `omitted`, not
 * as a failure, and the report says so. What is never allowed is silence —
 * dropping a stated goal without saying anything.
 *
 * Pure: no model, no provider, no clock.
 */

/** How well one goal came out. Ordered, so a caller can compare without a table. */
export const COVERAGE_VERDICTS = ['missing', 'token', 'present', 'strong', 'omitted'] as const;
export const coverageVerdictSchema = z.enum(COVERAGE_VERDICTS);
export type CoverageVerdict = z.infer<typeof coverageVerdictSchema>;

/** What the itinerary shows for one interest, measured rather than asserted. */
export interface GoalCoverage {
  interest: Interest;
  label: string;
  role: PreferenceRole;
  verdict: CoverageVerdict;
  /** Distinct days carrying it. */
  occurrences: number;
  /** What the role asked for, so a reader can see the comparison rather than trust the verdict. */
  required: number;
  /** 0–1 of the trip's activity minutes. */
  timeShare: number;
  /** Whether a chapter exists because of this goal. */
  structural: boolean;
  /** Day numbers carrying it, so the explanation can say *where*. */
  dayNumbers: number[];
  /** One sentence. Traveller-readable, no field names. */
  reads: string;
}

/** A feeling the traveller asked for, and whether the plan's shape contradicts it. */
export interface FeelingCheck {
  feeling: DesiredFeeling;
  /** `honoured` | `contradicted` | `unmeasured` — three answers, because "we did not check" is one. */
  verdict: 'honoured' | 'contradicted' | 'unmeasured';
  /** What in the plan's shape said so. Empty when unmeasured. */
  signals: string[];
}

export interface IntentSatisfactionReport {
  version: 1;
  goals: GoalCoverage[];
  feelings: FeelingCheck[];
  /**
   * §33 — a hard constraint that the plan breaks. Not low satisfaction: a
   * blocker, and the reason this report can fail a trip that routes perfectly.
   */
  hardConstraintFailures: string[];
  /**
   * §35 — goals at `core` that the plan neither delivered nor explained. The
   * single most important output: a perfectly routed trip missing the reason it
   * exists is not production quality.
   */
  unmetPrimaryGoals: string[];
  /** Goals the plan deliberately left out, with the reason it gave. */
  deliberateOmissions: { interest: Interest; reason: string }[];
}

export interface ItineraryEvidence {
  /** One entry per day, in order. */
  days: readonly {
    dayNumber: number;
    /** Which interests this day carries, as the caller's own evidence — never guessed here. */
    interests: readonly Interest[];
    /** Minutes spent on activities, for the time-share measure. */
    activityMinutes: number;
    /** The chapter this day belongs to, when the trip has chapters. */
    chapterId?: string | undefined;
  }[];
  /** Chapters whose reason for existing is one of these interests. */
  chapterInterests?: Readonly<Record<string, readonly Interest[]>> | undefined;
  /** What the plan said it left out, and why (`package.tradeoffs` and the draft's own omissions). */
  statedOmissions?: readonly { interest: Interest; reason: string }[] | undefined;
  /** Hard constraints the plan is known to break, already determined by the contract layer. */
  brokenHardConstraints?: readonly string[] | undefined;
}

/** A goal spread across the trip rather than bunched into one corner of it. */
function distributed(dayNumbers: readonly number[], totalDays: number): boolean {
  if (dayNumbers.length < 2 || totalDays < 4) return true;
  const span = Math.max(...dayNumbers) - Math.min(...dayNumbers) + 1;
  return span >= Math.min(totalDays, dayNumbers.length + 1);
}

function verdictFor(input: {
  role: PreferenceRole;
  occurrences: number;
  required: number;
  timeShare: number;
  structural: boolean;
  spread: boolean;
  omitted: boolean;
}): CoverageVerdict {
  if (input.omitted) return 'omitted';
  if (input.occurrences === 0) return input.required === 0 ? 'present' : 'missing';
  if (input.occurrences < input.required) return 'token';
  /*
   * §31 — meeting the count is not the same as being what the trip is about.
   * A `core` goal must also have shaped the structure or hold a real share of
   * the trip's time; otherwise it is present, not strong, however many days
   * mention it.
   */
  if (input.role === 'core' && !input.structural && input.timeShare < 0.25) return 'present';
  if (ROLE_DEMANDS[input.role].wantsRepetition && !input.spread) return 'present';
  return 'strong';
}

/**
 * Whether the plan's *shape* contradicts a feeling the traveller asked for.
 *
 * §32 warns against over-formalising subjective emotion, so this only ever
 * reports a contradiction it can point at — a restful trip that changes hotel
 * every night, a spontaneous one with every hour booked. A feeling with nothing
 * to measure comes back `unmeasured`, which is an answer rather than a pass.
 */
function checkFeelings(
  intent: TravelerIntent,
  shape: { days: number; hotelChanges: number; scheduledShare: number; averageActivitiesPerDay: number; freeDays: number; strenuousDays: number },
): FeelingCheck[] {
  return intent.desiredFeeling.map(({ feeling }): FeelingCheck => {
    const signals: string[] = [];
    switch (feeling) {
      case 'restful':
      case 'slow': {
        if (shape.days >= 4 && shape.hotelChanges >= shape.days - 1) signals.push('the trip changes where you sleep almost every night');
        if (shape.averageActivitiesPerDay >= 4) signals.push('most days carry four or more things to do');
        if (shape.freeDays === 0 && shape.days >= 6) signals.push('no day is left open');
        return { feeling, verdict: signals.length > 0 ? 'contradicted' : 'honoured', signals };
      }
      case 'spontaneous': {
        if (shape.scheduledShare > 0.85) signals.push('almost everything is pinned to a time');
        return { feeling, verdict: signals.length > 0 ? 'contradicted' : 'honoured', signals };
      }
      case 'challenging':
      case 'high_energy': {
        /*
         * EFFORT, NOT ITEM COUNT.
         *
         * This counted activities per day, and the first live backpacking trip
         * showed why that is wrong: four Salkantay trek days carry **one anchor
         * each** — the pass, the lake, the cloud forest — and they are the
         * hardest days of the trip. Counting them as light and reporting
         * "challenging" as contradicted was the report misreading the very
         * trip it was built to recognise. A day's own intensity is what says
         * how hard it was.
         */
        if (shape.strenuousDays === 0 && shape.days >= 5) signals.push('no day on this trip is a hard one');
        return { feeling, verdict: signals.length > 0 ? 'contradicted' : 'honoured', signals };
      }
      default:
        /* No structural test exists for this feeling yet, and inventing one would be the over-formalising §32 warns about. */
        return { feeling, verdict: 'unmeasured', signals: [] };
    }
  });
}

export function buildIntentSatisfaction(input: {
  intent: TravelerIntent;
  itinerary: ItineraryEvidence;
  operating?: TripOperatingModel | undefined;
  shape: {
    hotelChanges: number;
    scheduledShare: number;
    freeDays: number;
    /** Days the itinerary itself marks as hard. What "challenging" is measured against. */
    strenuousDays?: number | undefined;
  };
}): IntentSatisfactionReport {
  const { intent, itinerary } = input;
  const totalDays = itinerary.days.length;
  const totalActivityMinutes = itinerary.days.reduce((sum, day) => sum + day.activityMinutes, 0);
  const omissions = new Map((itinerary.statedOmissions ?? []).map((entry) => [entry.interest, entry.reason] as const));

  const structuralInterests = new Set<Interest>();
  for (const interests of Object.values(itinerary.chapterInterests ?? {})) for (const interest of interests) structuralInterests.add(interest);

  const goals: GoalCoverage[] = [];
  const graded = [...intent.primaryGoals, ...intent.secondaryGoals];
  for (const entry of graded) {
    const dayNumbers = itinerary.days.filter((day) => day.interests.includes(entry.interest)).map((day) => day.dayNumber);
    const minutes = itinerary.days.filter((day) => day.interests.includes(entry.interest)).reduce((sum, day) => sum + day.activityMinutes, 0);
    const timeShare = totalActivityMinutes > 0 ? Math.round((minutes / totalActivityMinutes) * 100) / 100 : 0;
    const structural = structuralInterests.has(entry.interest);
    const required = entry.demand.minOccurrences;
    const omitted = omissions.has(entry.interest);
    const verdict = verdictFor({ role: entry.role, occurrences: dayNumbers.length, required, timeShare, structural, spread: distributed(dayNumbers, totalDays), omitted });

    const reads =
      verdict === 'omitted'
        ? `Left out on purpose: ${omissions.get(entry.interest)}`
        : verdict === 'missing'
          ? `Nothing on this trip delivers it.`
          : verdict === 'token'
            ? `${dayNumbers.length} day${dayNumbers.length === 1 ? '' : 's'}, where ${required} would make it real.`
            : verdict === 'strong' && structural
              ? `The trip is built around it — ${dayNumbers.length} day${dayNumbers.length === 1 ? '' : 's'}, including a chapter that exists for it.`
              : `${dayNumbers.length} day${dayNumbers.length === 1 ? '' : 's'} carry it.`;

    goals.push({ interest: entry.interest, label: INTEREST_LABELS[entry.interest], role: entry.role, verdict, occurrences: dayNumbers.length, required, timeShare, structural, dayNumbers, reads });
  }

  const averageActivitiesPerDay = totalDays > 0 ? itinerary.days.reduce((sum, day) => sum + day.interests.length, 0) / totalDays : 0;
  const feelings = checkFeelings(intent, {
    days: totalDays,
    hotelChanges: input.shape.hotelChanges,
    scheduledShare: input.shape.scheduledShare,
    averageActivitiesPerDay,
    freeDays: input.shape.freeDays,
    strenuousDays: input.shape.strenuousDays ?? 0,
  });

  /*
   * §35 — the distinction that makes this report matter. A goal the traveller
   * said to build the trip around, which the plan neither delivered nor
   * explained away, is a quality failure and not a caution. An omission with a
   * reason is neither.
   */
  const unmetPrimaryGoals = goals
    .filter((goal) => PREFERENCE_ROLE_RANK[goal.role] >= PREFERENCE_ROLE_RANK.core && (goal.verdict === 'missing' || goal.verdict === 'token'))
    .map((goal) => `${goal.label}: ${goal.reads}`);

  return {
    version: 1,
    goals,
    feelings,
    hardConstraintFailures: [...(itinerary.brokenHardConstraints ?? [])],
    unmetPrimaryGoals,
    deliberateOmissions: [...omissions.entries()].map(([interest, reason]) => ({ interest, reason })),
  };
}

/**
 * §35 — whether this report should stop a trip being called ready.
 *
 * Deliberately narrow. A broken hard constraint always blocks; a core goal the
 * plan neither delivered nor explained blocks; a contradicted feeling does not,
 * because it is a judgement about shape rather than a fact about the trip, and
 * §34 is explicit that the gate must not push towards stuffing.
 */
export function intentBlocksReady(report: IntentSatisfactionReport): boolean {
  return report.hardConstraintFailures.length > 0 || report.unmetPrimaryGoals.length > 0;
}

/**
 * §36 — what a traveller sees. Never the report.
 *
 * "Built around what you care about", with the evidence in their own terms. A
 * goal that came out weak is simply not claimed; the report is what says so
 * internally, and overclaiming here would make the reassurance worthless.
 */
export function satisfactionHighlights(report: IntentSatisfactionReport): { label: string; detail: string }[] {
  return report.goals
    .filter((goal) => goal.verdict === 'strong' || goal.verdict === 'present')
    .sort((a, b) => PREFERENCE_ROLE_RANK[b.role] - PREFERENCE_ROLE_RANK[a.role] || b.occurrences - a.occurrences)
    .slice(0, 4)
    .map((goal) => ({ label: goal.label, detail: goal.reads }));
}
