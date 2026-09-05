/**
 * THE PLANNING DECISIONS A QUESTION CAN CHANGE.
 *
 * Every interview question names at least one of these. The list is the
 * product's own vocabulary for what the planner, the reconciler and the
 * composition prompt actually decide, so "what does this answer change?" is
 * always answerable, and a question that changes nothing cannot be added
 * without a test failing (`impact.test.ts`).
 *
 * Keys are named after concepts that exist downstream today — `base_count`
 * is the draft's bases, `hard_constraints` is `profile.hard`, `day_start`
 * is the daily window — not after wishes.
 */
export const PLANNING_IMPACT_KEYS = [
  'trip_archetype',
  'scope',
  'base_count',
  'hotel_switching',
  'day_density',
  'day_start',
  'activity_frequency',
  'effort',
  'walking',
  'driving',
  'detour',
  'transportation_mode',
  'remote_logistics',
  'guide_transfer',
  'ferry',
  'flight',
  'food_strategy',
  'meal_frequency',
  'lodging',
  'budget',
  'convenience',
  'crowds',
  'famous_vs_hidden',
  'regional_expansion',
  'weather_sensitivity',
  'accessibility',
  'hard_constraints',
  'group_fit',
] as const;
export type PlanningImpactKey = (typeof PLANNING_IMPACT_KEYS)[number];

export const PLANNING_IMPACT_LABELS: Record<PlanningImpactKey, string> = {
  trip_archetype: 'the shape of the trip',
  scope: 'how much ground the trip covers',
  base_count: 'how many places you sleep',
  hotel_switching: 'whether you change hotels',
  day_density: 'how much fits in a day',
  day_start: 'when days begin',
  activity_frequency: 'how often each kind of thing appears',
  effort: 'how physically demanding days are',
  walking: 'how much walking is planned',
  driving: 'how much driving is planned',
  detour: 'how far off the direct route the plan goes',
  transportation_mode: 'how you get around',
  remote_logistics: 'whether remote places are in reach',
  guide_transfer: 'whether guides or transfers are assumed',
  ferry: 'whether boats are part of the plan',
  flight: 'whether internal flights are part of the plan',
  food_strategy: 'how meals are chosen',
  meal_frequency: 'how many meals are events',
  lodging: 'what kind of place you stay in',
  budget: 'which paid things make the cut',
  convenience: 'when the plan pays to save hassle',
  crowds: 'how the plan handles busy places',
  famous_vs_hidden: 'the balance of famous and quiet places',
  regional_expansion: 'how far from base the plan looks',
  weather_sensitivity: 'how weather reshapes days',
  accessibility: 'what terrain and access are acceptable',
  hard_constraints: 'the filters nothing may cross',
  group_fit: 'how the plan serves everyone travelling',
};

/**
 * Where each impact is consumed. Documentation the test can point at rather
 * than a runtime dependency: every key must name a real downstream reader.
 */
export const PLANNING_IMPACT_CONSUMERS: Record<PlanningImpactKey, string> = {
  trip_archetype: 'composition task (TRIP + PREFERENCES); TripDraft.trip.archetype',
  scope: 'composition task; hybrid-request movement.desiredBaseCount; scope strategy',
  base_count: 'hybrid-request movement.desiredBaseCount / maxBaseChanges',
  hotel_switching: 'hybrid-request movement.maxBaseChanges; reconcile relocation feasibility',
  day_density: 'profile.pace → derived.activitySlotsPerDay; planner day end',
  day_start: 'profile.dayStart → buildDailyWindows',
  activity_frequency: 'profile.interests → derived.frequencyCaps; composition interests line',
  effort: 'profile.dailyIntensity → derived.maxPhysicalIntensity',
  walking: 'profile.transport.maxAccessWalkMinutes; interview.walkingTolerance → request.movement',
  driving: 'profile.transport.maxDailyDriveMinutes → reconcile hard ceiling',
  detour: 'profile.detourToleranceMinutes → derived.effectiveDetourMinutes',
  transportation_mode: 'profile.transport.willDrive / priority → request.movement.preference',
  remote_logistics: 'interview.remoteComfort → request avoidances / composition PREFERENCES',
  guide_transfer: 'interview.guideWillingness / privateTransfers → request.practicalities.guidedTours, movement.preference',
  ferry: 'interview.boatsAndFerries → request.movement.willUseShuttlesAndFerries / hardAvoidances',
  flight: 'interview.internalFlights → hardAvoidances small_aircraft; composition PREFERENCES',
  food_strategy: 'profile.food.style → food planner / composition',
  meal_frequency: 'profile.food.specialMealBudget',
  lodging: 'interview.lodgingStyle → request.practicalities.accommodation',
  budget: 'profile.budgetStyle → derived.comfortableCostLevel; request.practicalities.budget',
  convenience: 'interview.convenienceSpend → request.practicalities.reservations; composition PREFERENCES',
  crowds: 'profile.crowdTolerance / avoidTouristTraps → scoring; composition',
  famous_vs_hidden: 'profile.discoveryMix → derived.hiddenGemTarget',
  regional_expansion: 'profile.regionalExpansion → derived.effectiveDetourMinutes; compiler radius',
  weather_sensitivity: 'avoidances extreme_heat/cold → weather layer; request.conditions',
  accessibility: 'profile.accessibility → derived.maxPhysicalIntensity; request.party.mobility',
  hard_constraints: 'profile.hard → reconcile windows/caps; composition HARD CONSTRAINTS',
  group_fit: 'interview.everyoneEveryDay / groupNotes → composition PREFERENCES',
};

export function isPlanningImpactKey(value: string): value is PlanningImpactKey {
  return (PLANNING_IMPACT_KEYS as readonly string[]).includes(value);
}
