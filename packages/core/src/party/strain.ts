import type { ItineraryDay } from '../schemas/itinerary';
import type { DietaryNeed } from '../schemas/food';

/*
 * V6 — WHAT A DAY DEMANDS OF A BODY, AND WHAT IT OFFERS INSTEAD.
 *
 * A live Madhya Pradesh build labelled two jeep-safari days "intense" and the
 * party audit declared them contradicted for a grandmother who must avoid
 * steep descents. Nothing in those days went downhill; the model had even
 * written "Rest at the lodge — Amma can sit and rest" into one of them. The
 * intensity word is the model's estimate of how long and tiring a day is. It
 * is not evidence of steep ground, and unknown ≠ false: a finding that
 * somebody cannot do a day needs a stop that says why.
 *
 * `dayStrain` reads the day for affirmative evidence in two directions —
 * stops that name demanding ground, and stops or notes that give the person
 * an easier option — and leaves the verdict to the audit and the feasibility
 * report, which agree on this one reading.
 */

/** A stop whose text says it goes up, down or a long way on foot. */
export const DEMANDING_GROUND = /\b(hike|hiking|hikes|trek|trekking|trail|trails|summit|scramble|scrambling|steep|descent|descend|descends|downhill|climb|climbing|ascent|ascend|ridge|stairs|steps|via ferrata|canyoning|glacier walk|long walk)\b/i;

/** A stop or note that offers the person something gentler, or splits the party. */
export const EASIER_OPTION = /\b(split|separately|while the others|the rest of the party|rejoin|easier option|can sit|sit out|sit this out|rest|resting|manageable|on the flat|flat|gentle|level|benches?|short walk|optional|skip)\b/i;

export interface DayStrain {
  /** Titles of the stops that name demanding ground; empty when nothing does. */
  demanding: string[];
  /** The day splits, or a stop or note gives an easier option. */
  accommodated: boolean;
  /** A long or tiring day by the plan's own measure, regardless of ground. */
  full: boolean;
}

export function dayStrain(day: Pick<ItineraryDay, 'items' | 'intensity' | 'totals' | 'split' | 'warnings'>): DayStrain {
  const activities = day.items.filter((item) => item.kind === 'activity');
  const demanding = activities
    .filter((item) => item.physicalIntensity === 'strenuous' || DEMANDING_GROUND.test(`${item.title} ${item.reason ?? ''}`))
    .map((item) => item.title);
  const accommodated =
    day.split !== undefined ||
    day.items.some((item) => EASIER_OPTION.test(`${item.title} ${item.reason ?? ''}`)) ||
    (day.warnings ?? []).some((warning) => /split/i.test(warning));
  const full = day.intensity === 'intense' || day.totals.strenuousCount > 0 || demanding.length > 0;
  return { demanding, accommodated, full };
}

/*
 * V6 — THE PARTY'S KITCHEN RULE, FOR SIDEQUEST'S OWN CHECKS.
 *
 * The composition reads the party person by person (the brief's `<party>`
 * section) so that one vegetarian does not make every meal vegetarian for
 * everyone. Sidequest's deterministic side — the food plan, the food
 * intelligence, the disclosure copy — reads one profile, and a live family
 * build showed that profile with no dietary rules at all while three of the
 * four travellers had them. This merge is for that side only: the union of
 * every applying member's needs, strict when any member's are. It is never
 * fed back into the brief.
 */
export interface PartyDietSource {
  constraintsApply: boolean;
  diet: { needs: readonly DietaryNeed[]; strict: boolean };
}

export function mergePartyDiet<P extends { food: { dietaryNeeds: readonly DietaryNeed[]; dietaryStrict: boolean } }>(profile: P, members: readonly PartyDietSource[]): P {
  const applying = members.filter((member) => member.constraintsApply && member.diet.needs.length > 0);
  if (applying.length === 0) return profile;
  const needs = new Set<DietaryNeed>(profile.food.dietaryNeeds);
  let strict = profile.food.dietaryStrict;
  for (const member of applying) {
    for (const need of member.diet.needs) needs.add(need);
    if (member.diet.strict) strict = true;
  }
  if (needs.size === profile.food.dietaryNeeds.length && strict === profile.food.dietaryStrict) return profile;
  return { ...profile, food: { ...profile.food, dietaryNeeds: [...needs], dietaryStrict: strict } };
}
