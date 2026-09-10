import type { QuestionnaireAnswers } from '../schemas/profile';
import type { PreferenceProvenance } from '../schemas/interview';
import { FUNCTIONAL_NEED_LABELS, STRENUOUS_BLOCKERS, type FunctionalNeed } from '../party/traveler';

/**
 * CONTRADICTION INTELLIGENCE — WHEN TWO ANSWERS PULL IN DIFFERENT DIRECTIONS.
 *
 * V6 §8. The review used to detect exactly one conflict (wheel time versus
 * detour range). This is the general engine: a small set of deterministic
 * rules over the answers, the party and the destination, each producing a
 * conflict with a severity, the decisions it touches, which answer is more
 * recent and which is explicit, and — where one exists — a safe deterministic
 * reading that needs nobody's attention.
 *
 * Only a *material* conflict interrupts the traveller: one that changes the
 * resulting trip and has no safe reading. The rest are resolved quietly and
 * recorded, so the review can say what Sidequest assumed.
 */

export const CONFLICT_IDS = [
  'drive_ceiling_vs_detour_range',
  'intense_days_vs_party_need',
  'winter_trip_vs_cold_sensitive',
  'one_base_vs_breadth',
  'no_driving_vs_road_trip_destination',
  'food_core_vs_food_is_fuel',
  'long_hikes_vs_light_days',
  'stay_put_vs_far_expansion',
] as const;
export type ConflictId = (typeof CONFLICT_IDS)[number];

export interface ConflictResolution {
  id: string;
  label: string;
  /** The answer fields this resolution writes, applied as a patch. */
  patch: Partial<QuestionnaireAnswers>;
}

export interface ConstraintConflict {
  id: ConflictId;
  severity: 'material' | 'minor';
  /** Planning decisions the conflict changes, in the impact vocabulary. */
  decisions: readonly string[];
  /** The two answers, in the traveller's words. */
  sides: [string, string];
  /** Which side was answered more recently, when provenance says. */
  moreRecent: 0 | 1 | null;
  /** Which side was stated explicitly (both may be). */
  explicit: [boolean, boolean];
  /** The reading Sidequest applies without asking, when one is safe. */
  safeReading: string | null;
  resolutions: ConflictResolution[];
}

export interface ConflictContext {
  /** Destination traits from screening: `road_trip`, `transit_city`, `alpine`, `winter_destination`, … */
  destinationTraits?: readonly string[];
  /** Functional needs across the party, by key. */
  partyNeeds?: readonly string[];
  /** The trip's months, 1–12, when dates are known. */
  months?: readonly number[];
  /** Latitude of the destination, for which months are winter. */
  latitude?: number | null;
}

function explicitAt(provenance: Record<string, PreferenceProvenance>, id: string): { explicit: boolean; at: string | null } {
  const entry = provenance[id];
  return { explicit: entry?.source === 'explicit' || entry?.source === 'existing_profile', at: entry?.at ?? null };
}

function recency(a: string | null, b: string | null): 0 | 1 | null {
  if (!a || !b || a === b) return null;
  return a > b ? 0 : 1;
}

function winterMonths(latitude: number | null | undefined): number[] {
  if (latitude === undefined || latitude === null) return [12, 1, 2];
  return latitude < 0 ? [6, 7, 8] : [12, 1, 2];
}

/**
 * Every conflict the answers hold. Pure; safe to run after every answer.
 */
export function detectConflicts(answers: QuestionnaireAnswers, context: ConflictContext = {}): ConstraintConflict[] {
  const conflicts: ConstraintConflict[] = [];
  const p = answers.provenance;
  const traits = new Set(context.destinationTraits ?? []);
  const needs = (context.partyNeeds ?? []) as FunctionalNeed[];

  // 1. A driving ceiling that allows four hours, against a detour range that allows one.
  if (answers.maxDailyTravelMinutes >= 240 && answers.detourToleranceMinutes <= 60 && answers.willDrive) {
    const a = explicitAt(p, 'daily_driving');
    const b = explicitAt(p, 'scenic_reach');
    conflicts.push({
      id: 'drive_ceiling_vs_detour_range',
      severity: a.explicit && b.explicit ? 'material' : 'minor',
      decisions: ['driving', 'detour', 'scope'],
      sides: [`Up to ${Math.round(answers.maxDailyTravelMinutes / 60)} hours of driving a day is fine`, `Nothing more than ${answers.detourToleranceMinutes} minutes off the route`],
      moreRecent: recency(a.at, b.at),
      explicit: [a.explicit, b.explicit],
      safeReading: a.explicit && b.explicit ? null : 'Long drives between bases are fine; detours off the route stay short.',
      resolutions: [
        { id: 'keep_ceiling', label: 'Long driving days are fine, and detours can be longer too', patch: { detourToleranceMinutes: 120 } },
        { id: 'keep_range', label: 'Keep driving short overall', patch: { maxDailyTravelMinutes: 150 } },
      ],
    });
  }

  // 2. Intense days, and somebody who cannot do steep ground or long walks.
  const blocker = needs.find((need) => (STRENUOUS_BLOCKERS as readonly string[]).includes(need));
  if (blocker && (answers.dailyIntensity === 'intense' || answers.hikeAppetite === 'full_day')) {
    const a = explicitAt(p, 'effort');
    conflicts.push({
      id: 'intense_days_vs_party_need',
      severity: 'material',
      decisions: ['effort', 'group_fit', 'day_density'],
      sides: [answers.dailyIntensity === 'intense' ? 'Intense days' : 'Full-day hikes', `Someone in the party: ${FUNCTIONAL_NEED_LABELS[blocker as FunctionalNeed].toLowerCase()}`],
      moreRecent: null,
      explicit: [a.explicit, true],
      safeReading: null,
      resolutions: [
        { id: 'everyone', label: 'Everyone does every day — keep it moderate', patch: { dailyIntensity: 'moderate', hikeAppetite: 'half_day' } },
        { id: 'split', label: 'Keep the big days; plan something else for them on those days', patch: { everyoneEveryDay: false } },
      ],
    });
  }

  // 3. A winter trip and someone sensitive to cold.
  const months = context.months ?? [];
  const inWinter = months.some((m) => winterMonths(context.latitude).includes(m)) || traits.has('winter_destination');
  if (inWinter && needs.includes('cold_sensitive')) {
    conflicts.push({
      id: 'winter_trip_vs_cold_sensitive',
      severity: 'minor',
      decisions: ['weather_sensitivity', 'day_start', 'lodging'],
      sides: ['Travelling in the cold months', 'Someone in the party is sensitive to cold'],
      moreRecent: null,
      explicit: [true, true],
      safeReading: 'Shorter outdoor spells, warm bases and indoor fallbacks on the coldest days.',
      resolutions: [],
    });
  }

  // 4. One base, and a breadth strategy or a far expansion.
  const stayPut = answers.baseMoveTolerance === 'stay_put';
  if (stayPut && answers.scopeStrategy === 'breadth') {
    const a = explicitAt(p, 'base_moves');
    const b = explicitAt(p, 'coverage_strategy');
    conflicts.push({
      id: 'one_base_vs_breadth',
      severity: a.explicit && b.explicit ? 'material' : 'minor',
      decisions: ['base_count', 'scope', 'hotel_switching'],
      sides: ['One base for the whole trip', 'See as much of the region as possible'],
      moreRecent: recency(a.at, b.at),
      explicit: [a.explicit, b.explicit],
      safeReading: a.explicit && b.explicit ? null : 'One base, with the reach that base allows.',
      resolutions: [
        { id: 'one_base', label: 'One base; see what it reaches', patch: { scopeStrategy: 'depth' } },
        { id: 'move', label: 'Move once or twice to cover more', patch: { baseMoveTolerance: 'move_if_it_saves_time' } },
      ],
    });
  }
  if (stayPut && (answers.regionalExpansion === 'nearby_120' || answers.regionalExpansion === 'best_regional')) {
    conflicts.push({
      id: 'stay_put_vs_far_expansion',
      severity: 'minor',
      decisions: ['regional_expansion', 'base_count'],
      sides: ['One base for the whole trip', 'Happy to go two hours or more out for the day'],
      moreRecent: null,
      explicit: [explicitAt(p, 'base_moves').explicit, explicitAt(p, 'scenic_reach').explicit],
      safeReading: 'Long day trips from one base, back each night.',
      resolutions: [],
    });
  }

  // 5. Nobody drives, at a destination that reads as a road trip.
  if (!answers.willDrive && traits.has('road_trip') && !traits.has('transit_city')) {
    const a = explicitAt(p, 'transport_mode');
    conflicts.push({
      id: 'no_driving_vs_road_trip_destination',
      severity: a.explicit ? 'material' : 'minor',
      decisions: ['transportation_mode', 'scope', 'guide_transfer'],
      sides: ['No driving', 'A destination that is mostly reached by road'],
      moreRecent: null,
      explicit: [a.explicit, true],
      safeReading: a.explicit ? null : 'Buses, transfers and a driver where the road is the only way.',
      resolutions: [
        { id: 'driver', label: 'Use transfers, tours or a driver — no driving myself', patch: { guideWillingness: 'prefer' } },
        { id: 'drive', label: 'Actually, I could drive', patch: { willDrive: true } },
      ],
    });
  }

  // 6. Food is the heart of the trip, and food is fuel.
  if (answers.interests.food_and_towns === 'core' && answers.foodStyle === 'budget') {
    const a = explicitAt(p, 'priorities');
    const b = explicitAt(p, 'food_tradeoff');
    conflicts.push({
      id: 'food_core_vs_food_is_fuel',
      severity: 'minor',
      decisions: ['food_strategy', 'meal_frequency', 'budget'],
      sides: ['Food is the heart of the trip', 'Food is fuel — cheap and quick'],
      moreRecent: recency(a.at, b.at),
      explicit: [a.explicit, b.explicit],
      safeReading: 'Cheap and excellent: markets, counters and local places rather than tasting menus.',
      resolutions: [],
    });
  }

  // 7. Long hikes and light days.
  if ((answers.hikeAppetite === 'full_day') && answers.dailyIntensity === 'light') {
    const a = explicitAt(p, 'hike_appetite');
    const b = explicitAt(p, 'effort');
    conflicts.push({
      id: 'long_hikes_vs_light_days',
      severity: a.explicit && b.explicit ? 'material' : 'minor',
      decisions: ['effort', 'activity_frequency', 'day_density'],
      sides: ['Full-day hikes', 'Light days'],
      moreRecent: recency(a.at, b.at),
      explicit: [a.explicit, b.explicit],
      safeReading: a.explicit && b.explicit ? null : 'One or two big hiking days, and easy days around them.',
      resolutions: [
        { id: 'hikes', label: 'The hikes matter more; days can be harder', patch: { dailyIntensity: 'moderate' } },
        { id: 'light', label: 'Keep days light; shorter hikes', patch: { hikeAppetite: 'half_day' } },
      ],
    });
  }

  return conflicts;
}

/** Only the conflicts worth interrupting the traveller for. */
export function materialConflicts(answers: QuestionnaireAnswers, context: ConflictContext = {}): ConstraintConflict[] {
  return detectConflicts(answers, context).filter((c) => c.severity === 'material' && c.safeReading === null);
}
