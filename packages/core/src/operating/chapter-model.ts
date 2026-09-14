import type { Chapter } from '../experience/chapters';
import type { TravelerIntent } from '../intent/traveler-intent';
import { PREFERENCE_ROLE_RANK } from '../intent/roles';
import type { Interest } from '../schemas/common';
import { policyFor, type OperatingPolicy, type OperatingType, type TripOperatingModel } from './model';

/**
 * V12 §8 §44 — A CHAPTER IS A PLANNING UNIT, NOT A HEADING.
 *
 * V11 derived chapters and used them to *present* the trip: a rail of day chips
 * under "ARRIVE · ALA-KUL TRAVERSE · RECOVERY". §8 asks for the next step —
 * that a chapter carry how *it* works, because most good trips are mixed and one
 * trip-level policy cannot be right for all of them.
 *
 * The live Kyrgyzstan build is the argument in one line: Bishkek, Song-Köl,
 * Karakol, a three-day traverse, a recovery day, Bishkek. The traverse is
 * operator-owned, trail-borne, full, and catered. The recovery day is none of
 * those. Judging both by one policy makes the recovery day look empty and the
 * traverse look like hotel churn.
 *
 * ── WHAT DECIDES A CHAPTER'S MODE ───────────────────────────────────────────
 *
 * The chapter's own facts, in this order and no other:
 *
 *   1. it *is* an experience      → the experience decides (a trek is a trek)
 *   2. its derived role           → recovery and transition are their own modes
 *   3. otherwise                  → it inherits the trip's model
 *
 * Nothing here looks at a destination, and nothing overrides the trip's model
 * on a guess: a chapter that is simply part of the trip is planned the trip's
 * way, which is the §44 requirement that one dominant type must not overwrite
 * the whole trip *and* must not be discarded either.
 */

export interface ChapterOperatingModel {
  chapterId: string;
  title: string;
  operatingType: OperatingType;
  /** What this chapter is for, in one sentence a traveller could read. */
  primaryGoal: string;
  policy: OperatingPolicy;
  /** Why this chapter is planned this way. */
  basis: 'experience' | 'recovery' | 'transition' | 'arrival' | 'finale' | 'inherited';
  /** What must be arranged for this chapter to happen at all. */
  criticalDependencies: string[];
  /** 0–1. How much this chapter takes out of the traveller. */
  recoveryLoad: number;
  /** What Sidequest should check hardest here. */
  verificationPriority: 'transport' | 'access_and_permits' | 'opening_hours' | 'operator' | 'nothing_special';
}

const RECOVERY_POLICY: Partial<OperatingPolicy> = {
  activityDensity: 'light',
  scheduleGranularity: 'loose',
  restExpectation: 0.8,
  recoveryImportance: 0.9,
  dayRhythm: 'slow_morning',
};

const TRANSITION_POLICY: Partial<OperatingPolicy> = {
  activityDensity: 'sparse',
  scheduleGranularity: 'to_the_part_of_day',
  restExpectation: 0.5,
  routeImportance: 0.9,
};

/** The interests a chapter is about, from the trip's goals and the chapter's own experience name. */
function goalFor(chapter: Chapter, intent: TravelerIntent): string {
  if (chapter.experience) return chapter.experience;
  const strongest = [...intent.primaryGoals, ...intent.secondaryGoals].sort((a, b) => PREFERENCE_ROLE_RANK[b.role] - PREFERENCE_ROLE_RANK[a.role])[0];
  switch (chapter.role) {
    case 'arrival':
      return 'Arrive and get your bearings';
    case 'finale':
      return 'The last of it, and getting away cleanly';
    case 'recovery':
      return 'Recover from what came before';
    case 'transition':
      return 'Move on';
    default:
      return strongest ? `${strongest.label} around ${chapter.title}` : chapter.title;
  }
}

export function deriveChapterModels(input: { chapters: readonly Chapter[]; trip: TripOperatingModel; intent: TravelerIntent; strenuousDays?: ReadonlySet<number> | undefined }): ChapterOperatingModel[] {
  return input.chapters.map((chapter): ChapterOperatingModel => {
    const tripPolicy = input.trip.policy;
    const strenuous = [...(input.strenuousDays ?? [])].filter((day) => chapter.dayNumbers.includes(day)).length;

    /* 1 — the chapter *is* an experience. */
    if (chapter.experience) {
      const operatingType: OperatingType = input.trip.type === 'guided_wildlife' ? 'guided_wildlife' : 'multi_day_trek';
      return {
        chapterId: chapter.id,
        title: chapter.title,
        operatingType,
        primaryGoal: goalFor(chapter, input.intent),
        policy: { ...policyFor(operatingType) },
        basis: 'experience',
        criticalDependencies: [`${chapter.experience} has to be arranged before the trip — it is what these days are.`],
        recoveryLoad: 0.9,
        verificationPriority: 'operator',
      };
    }

    /* 2 — the role is the mode. */
    if (chapter.role === 'recovery') {
      return {
        chapterId: chapter.id,
        title: chapter.title,
        operatingType: input.trip.type,
        primaryGoal: goalFor(chapter, input.intent),
        policy: { ...tripPolicy, ...RECOVERY_POLICY },
        basis: 'recovery',
        criticalDependencies: [],
        recoveryLoad: 0.1,
        verificationPriority: 'nothing_special',
      };
    }
    if (chapter.role === 'transition') {
      return {
        chapterId: chapter.id,
        title: chapter.title,
        operatingType: input.trip.type,
        primaryGoal: goalFor(chapter, input.intent),
        policy: { ...tripPolicy, ...TRANSITION_POLICY },
        basis: 'transition',
        criticalDependencies: ['The day is the journey — the transfer is what has to work.'],
        recoveryLoad: 0.5,
        verificationPriority: 'transport',
      };
    }

    /* 3 — an ordinary chapter is planned the trip's way. */
    const arrivalOrFinale = chapter.role === 'arrival' || chapter.role === 'finale';
    return {
      chapterId: chapter.id,
      title: chapter.title,
      operatingType: input.trip.type,
      primaryGoal: goalFor(chapter, input.intent),
      policy: arrivalOrFinale ? { ...tripPolicy, activityDensity: 'light', restExpectation: Math.max(tripPolicy.restExpectation, 0.5) } : { ...tripPolicy },
      basis: arrivalOrFinale ? (chapter.role as 'arrival' | 'finale') : 'inherited',
      criticalDependencies: [],
      recoveryLoad: strenuous > 0 ? Math.min(0.9, 0.3 + strenuous * 0.2) : 0.3,
      verificationPriority:
        tripPolicy.operatorDependence >= 0.7
          ? 'operator'
          : tripPolicy.transportCertaintyRequirement >= 0.8
            ? 'transport'
            : tripPolicy.bookingIntensity >= 0.7
              ? 'access_and_permits'
              : tripPolicy.scheduleGranularity === 'to_the_hour'
                ? 'opening_hours'
                : 'nothing_special',
    };
  });
}

/**
 * §8's own warning, enforced: chapter data must not be decorative.
 *
 * A chapter whose policy is identical to the trip's in every field, and whose
 * basis says it was inherited, carries no information — which is fine and
 * expected. What would not be fine is a chapter claiming its own mode while
 * changing nothing, so this is what a caller asserts on.
 */
export function chapterChangesPlanning(chapter: ChapterOperatingModel, trip: TripOperatingModel): boolean {
  if (chapter.basis === 'inherited') return false;
  return (
    chapter.operatingType !== trip.type ||
    (Object.keys(chapter.policy) as (keyof OperatingPolicy)[]).some((key) => chapter.policy[key] !== trip.policy[key])
  );
}

/** The interests a chapter exists for, for the intent-satisfaction report's structural measure. */
export function chapterInterests(chapters: readonly Chapter[], intent: TravelerIntent, dayInterests: ReadonlyMap<number, readonly Interest[]>): Record<string, Interest[]> {
  const out: Record<string, Interest[]> = {};
  for (const chapter of chapters) {
    const counts = new Map<Interest, number>();
    for (const day of chapter.dayNumbers) for (const interest of dayInterests.get(day) ?? []) counts.set(interest, (counts.get(interest) ?? 0) + 1);
    /*
     * A chapter exists *for* an interest when that interest is on most of its
     * days — not merely present on one of them. Otherwise every chapter would
     * claim every interest that happened inside it, and the structural measure
     * in the satisfaction report would become the day count again.
     */
    const threshold = Math.max(2, Math.ceil(chapter.dayNumbers.length * 0.6));
    const defining = [...counts.entries()].filter(([, count]) => count >= threshold).map(([interest]) => interest);
    if (defining.length > 0) out[chapter.id] = defining.sort((a, b) => PREFERENCE_ROLE_RANK[intent.roles[b] ?? 'opportunistic'] - PREFERENCE_ROLE_RANK[intent.roles[a] ?? 'opportunistic']);
  }
  return out;
}
