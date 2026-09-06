import { AVOIDANCE_LABELS, INTEREST_LABELS, formatMinuteOfDay, type Interest, type InterestLevel } from '../schemas/common';
import { DIETARY_NEED_LABELS } from '../schemas/food';
import type { PreferenceProvenance } from '../schemas/interview';
import type { TravelerProfile } from '../schemas/profile';
import { describeHard } from './review';

/**
 * THE TRAVELER BRIEF — ONE COMPACT, RIGOROUS ACCOUNT OF THE TRAVELLER FOR THE
 * ONE COMPOSITION CALL.
 *
 * The interview produces ~40 typed answers plus provenance; the profile adds
 * derived figures; the composer adds dates, party and edges; bookings and
 * Discovery Board decisions add signals. The model must not receive that as
 * forty settings — it receives this: a short document, section by section,
 * where every line is a planning-bearing sentence, hard rules come first,
 * and anything Sidequest decided on the traveller's behalf is marked
 * `[assumed]` so the model knows it may trade it away for a better trip.
 *
 * Built from the profile alone plus the trip facts the caller already holds.
 * `brief-coverage.test.ts` proves every impact-bearing questionnaire field
 * changes at least one line here, or is listed as intentionally
 * non-composition.
 */

export const TRAVELER_BRIEF_VERSION = 'sidequest-traveler-brief/1' as const;

export interface TravelerBriefTripFacts {
  destination: string;
  qualifiedName?: string;
  countryName?: string;
  scale?: string;
  startDate?: string;
  endDate?: string;
  nights: number;
  days: number;
  season?: string;
  adults: number;
  children: number;
  seniors?: boolean;
  /** "at 11:00", "in the afternoon", "time not stated". */
  arrival: string;
  departure: string;
  origin?: string;
  /** One line per binding booking, already compacted. */
  bookedFacts: readonly string[];
}

export interface TravelerBriefSignals {
  /** Names the traveller typed or marked as must-include. */
  mustInclude: readonly string[];
  boardLikes: readonly string[];
  boardRejects: readonly string[];
}

export interface TravelerBriefOwnWords {
  mustDo: readonly string[];
  dislikes: readonly string[];
  freeText?: string;
  groupNotes?: string;
  mobilityNotes?: string;
}

export interface TravelerBrief {
  version: typeof TRAVELER_BRIEF_VERSION;
  tripFacts: TravelerBriefTripFacts;
  hardConstraints: string[];
  travelStyle: string[];
  priorities: { theme: string; frequency: string; assumed: boolean }[];
  secondary: string[];
  avoid: string[];
  transport: string[];
  lodging: string[];
  food: string[];
  budget: string[];
  popularity: string[];
  scope: string[];
  signals: TravelerBriefSignals & { smartDefaults: number };
  assumptions: string[];
  ownWords: TravelerBriefOwnWords;
}

const LEVEL_PHRASE: Record<InterestLevel, string> = {
  avoid: 'avoid',
  low: 'only if it is right there',
  occasional: 'once or twice',
  frequent: 'a few times',
  core: 'the heart of the trip',
};

function isExplicit(entry: PreferenceProvenance | undefined): boolean {
  return entry?.source === 'explicit' || entry?.source === 'existing_profile';
}

function mark(explicit: boolean): string {
  return explicit ? '' : ' [assumed]';
}

export function buildTravelerBrief(input: {
  profile: TravelerProfile;
  trip: TravelerBriefTripFacts;
  signals?: Partial<TravelerBriefSignals>;
  ownWords?: Partial<TravelerBriefOwnWords>;
}): TravelerBrief {
  const { profile, trip } = input;
  const provenance = profile.provenance;
  const interview = profile.interview;
  const assumptions: string[] = [];
  let smartDefaults = 0;

  /** A sentence that belongs to one interview question; tagged when Sidequest decided it. */
  const line = (questionId: string, sentence: string): string => {
    const explicit = isExplicit(provenance[questionId]);
    if (!explicit) {
      smartDefaults += 1;
      const reason = provenance[questionId]?.reason;
      assumptions.push(reason ? `${sentence} — ${reason}` : sentence);
    }
    return `${sentence}${mark(explicit)}`;
  };

  // --- hard --------------------------------------------------------------------
  const hard: string[] = [];
  for (const constraint of profile.hard) hard.push(describeHard(constraint));
  if (profile.food.dietaryStrict && profile.food.dietaryNeeds.length > 0) {
    hard.push(`Dietary needs are absolute: ${profile.food.dietaryNeeds.map((n) => DIETARY_NEED_LABELS[n]).join(', ')}`);
  }
  if (profile.accessibility.mobilityLimited) hard.push('Somebody in the group has limited mobility: low-effort, step-free stops only');
  if (!profile.transport.willDrive && provenance.transport_mode?.strength === 'hard') hard.push('Nobody will be driving');
  if (interview.mustBeBackByMinute !== undefined) hard.push(`Back at base by ${formatMinuteOfDay(interview.mustBeBackByMinute)} every day`);
  if (interview.maxWalkingMinutesPerDay !== undefined) hard.push(`At most ${interview.maxWalkingMinutesPerDay} minutes on foot in a day`);
  if (interview.mustInclude.length > 0) hard.push(`Must include: ${interview.mustInclude.join('; ')}`);
  if (interview.mustAvoid.length > 0) hard.push(`Must avoid: ${interview.mustAvoid.join('; ')}`);
  if (trip.bookedFacts.length > 0) hard.push(...trip.bookedFacts.map((fact) => `Booked: ${fact}`));

  // --- travel style ---------------------------------------------------------------
  const travelStyle: string[] = [];
  travelStyle.push(line('day_shape', profile.pace === 'slow' ? 'Days: one major experience, then time to linger' : profile.pace === 'fast' ? 'Days: cover a lot, happy to be on the move' : 'Days: two or three meaningful stops'));
  travelStyle.push(line('day_start', profile.dayStart === 'early' ? 'Starts early, before the light gets flat' : profile.dayStart === 'relaxed' ? 'Relaxed mornings, no alarms' : 'Moving by mid-morning'));
  travelStyle.push(line('effort', `Effort: ${profile.dailyIntensity}`));
  travelStyle.push(line('free_time', profile.freeTime === 'lots' ? 'Wants real free time most days' : profile.freeTime === 'packed' ? 'Happy for days to be full' : 'Some unplanned time, not every day'));
  travelStyle.push(line('late_nights', interview.lateNights === 'fine' ? 'Late nights are fine' : interview.lateNights === 'no' ? 'Early nights: dinner, then done' : 'A late night or two, never before an early start'));
  travelStyle.push(line('base_moves', interview.baseMoveTolerance === 'stay_put' ? 'One base for the whole trip' : interview.baseMoveTolerance === 'move_once' ? 'Change hotels once if it saves real time' : interview.baseMoveTolerance === 'move_freely' ? 'Move as often as the route wants' : 'Move hotels only when it clearly saves time'));
  travelStyle.push(line('everyone_every_day', interview.everyoneEveryDay ? 'The group stays together every day' : 'The group may split for a few hours when appetites differ'));

  // --- priorities -------------------------------------------------------------------
  const priorityExplicit = isExplicit(provenance.priorities);
  const chosen = (Object.entries(profile.interests) as [Interest, InterestLevel][]).filter(([, level]) => level === 'core' || level === 'frequent');
  const secondaryLevels = (Object.entries(profile.interests) as [Interest, InterestLevel][]).filter(([, level]) => level === 'occasional');
  const avoided = (Object.entries(profile.interests) as [Interest, InterestLevel][]).filter(([, level]) => level === 'avoid');
  if (!priorityExplicit && chosen.length + secondaryLevels.length > 0) {
    smartDefaults += 1;
    assumptions.push(`Priorities were assumed from the destination${provenance.priorities?.reason ? ` — ${provenance.priorities.reason}` : ''}`);
  }
  const priorities = chosen.map(([interest, level]) => {
    // The role is explicit when the traveller answered it on its own screen or on the one-screen matrix.
    const role = provenance[`priority_role:${interest}`] ?? provenance.priority_roles;
    return { theme: INTEREST_LABELS[interest].toLowerCase(), frequency: LEVEL_PHRASE[level], assumed: !(priorityExplicit && (role === undefined || isExplicit(role))) };
  });
  const secondary = secondaryLevels.map(([interest, level]) => `${INTEREST_LABELS[interest].toLowerCase()} (${LEVEL_PHRASE[level]})${mark(priorityExplicit)}`);
  if (interview.hikeAppetite !== 'half_day' || provenance.hike_appetite) {
    secondary.push(line('hike_appetite', interview.hikeAppetite === 'none' ? 'No real hikes; viewpoints and easy paths' : interview.hikeAppetite === 'short' ? 'Hikes under two hours, gentle' : interview.hikeAppetite === 'full_day' ? 'A full-day hike is welcome' : 'Half-day hikes are fine'));
  }
  if (interview.dayTripAppetite !== 'one_day_trip' || provenance.day_trips) {
    secondary.push(line('day_trips', interview.dayTripAppetite === 'stay_in_city' ? 'Stay in the city every day' : interview.dayTripAppetite === 'several' ? 'Several day trips out of the city' : 'One day trip out of the city at most'));
  }

  // --- avoid ------------------------------------------------------------------------
  const avoid: string[] = [];
  if (avoided.length > 0) avoid.push(`Not interested in: ${avoided.map(([interest]) => INTEREST_LABELS[interest].toLowerCase()).join(', ')}`);
  if (profile.avoidances.length > 0) avoid.push(`Steer around: ${profile.avoidances.map((a) => AVOIDANCE_LABELS[a].toLowerCase()).join(', ')}`);
  for (const dislike of input.ownWords?.dislikes ?? []) avoid.push(`Would rather not: ${dislike}`);

  // --- transport --------------------------------------------------------------------
  const transport: string[] = [];
  transport.push(
    line(
      'transport_mode',
      profile.transport.willDrive
        ? `Getting around: a car, at most ${profile.transport.maxDailyDriveMinutes} minutes driving on an ordinary day (a relocation to a new base is judged separately)`
        : interview.guideWillingness === 'prefer'
          ? 'Getting around: guided, with arranged transfers; no car'
          : interview.privateTransfers === 'fine' && profile.transport.priority === 'least_stressful'
            ? 'Getting around: mostly taxis and rideshare, no car'
            : 'Getting around: on foot and by public transport, no car',
    ),
  );
  if (profile.transport.willDrive) {
    transport.push(line('daily_driving', `Daily driving ceiling: ${profile.transport.maxDailyDriveMinutes} minutes round trip`));
    transport.push(line('road_comfort', profile.transport.comfortableGravelRoads ? 'Mountain passes and graded gravel are fine' : profile.transport.comfortableMountainRoads ? 'Mountain passes are fine; no gravel' : 'Paved roads only'));
  }
  // Walking and transit comfort matter without a car, and whenever the traveller chose to say something about them.
  if (!profile.transport.willDrive || provenance.walking_tolerance) {
    transport.push(line('walking_tolerance', interview.walkingTolerance === 'lots' ? 'Happy to cover whole neighbourhoods on foot' : interview.walkingTolerance === 'little' ? 'Keep walking short; ride between stops' : 'A comfortable amount on foot, then a ride'));
  }
  if (!profile.transport.willDrive || provenance.transit_comfort) {
    transport.push(line('transit_comfort', profile.transport.priority === 'least_stressful' ? 'Prefers taxis when a transit change is awkward' : profile.transport.priority === 'cheapest' ? 'Rides the network whatever it takes' : 'Public transport when it is simple, a taxi when it is not'));
  }
  transport.push(`Max walk to reach something: ${profile.transport.maxAccessWalkMinutes} minutes`);
  transport.push(line('guide_willingness', interview.guideWillingness === 'prefer' ? 'Prefers guided days' : interview.guideWillingness === 'avoid' ? 'Avoids guides; self-guided wherever possible' : 'Guides only where they earn their place'));
  transport.push(line('private_transfers', interview.privateTransfers === 'fine' ? 'Arranged private transfers are fine' : interview.privateTransfers === 'avoid' ? 'Only transport legs that can be verified; no arranged transfers' : 'Arranged transfers only where nothing else works'));
  transport.push(line('boats_ferries', interview.boatsAndFerries === 'fine' ? 'Boats and ferries are fine' : interview.boatsAndFerries === 'cannot' ? 'No boats' : 'Rather not take boats; short crossings only'));
  transport.push(line('internal_flights', interview.internalFlights === 'fine' ? 'Short internal flights are fine where they save a day' : interview.internalFlights === 'cannot' ? 'No small aircraft' : 'Rather not fly internally'));
  transport.push(line('remote_comfort', interview.remoteComfort === 'fine' ? 'Days without signal or services are fine' : interview.remoteComfort === 'cannot' ? 'Never out of reach of services' : 'Keep most days near a town'));
  transport.push(line('altitude_comfort', interview.altitudeComfort === 'fine' ? 'Altitude is not a concern' : interview.altitudeComfort === 'avoid_high' ? 'Keep the plan below high altitude' : 'Take altitude slowly: easy first days, sleep low'));
  transport.push(line('stairs_hills', interview.stairsAndHills === 'fine' ? 'Stairs and steep streets are fine' : interview.stairsAndHills === 'cannot' ? 'Level access only' : 'Prefer the lift or the flat route'));

  // --- lodging ----------------------------------------------------------------------
  const lodging: string[] = [];
  lodging.push(line('lodging_style', `Lodging: ${interview.lodgingStyle.replace(/_/g, ' ')}${interview.rusticLodgingOk ? '; simple lodges and homestays acceptable' : '; proper hotels only'}`));
  lodging.push(line('base_moves', interview.baseMoveTolerance === 'stay_put' ? 'Hotel changes: none' : interview.baseMoveTolerance === 'move_once' ? 'Hotel changes: at most one' : interview.baseMoveTolerance === 'move_freely' ? 'Hotel changes: as many as the route needs' : 'Hotel changes: only when it clearly saves time'));

  // --- food -------------------------------------------------------------------------
  const food: string[] = [];
  food.push(line('food_tradeoff', profile.food.style === 'destination' ? `Food matters: happy to cross town for an exceptional meal (${profile.food.specialMealBudget} special meal${profile.food.specialMealBudget === 1 ? '' : 's'} across the trip)` : profile.food.style === 'budget' ? 'Food is fuel: quick, cheap, on the route' : `Good local meals near the route, no detours (${profile.food.specialMealBudget} special meal${profile.food.specialMealBudget === 1 ? '' : 's'} across the trip)`));
  if (profile.food.dietaryNeeds.length > 0 && !profile.food.dietaryStrict) food.push(line('dietary', `Dietary preferences: ${profile.food.dietaryNeeds.map((n) => DIETARY_NEED_LABELS[n]).join(', ')}`));
  food.push(line('breakfast', profile.food.breakfastStyle === 'coffee_light' ? 'Breakfast: coffee and something light, near base' : profile.food.breakfastStyle === 'skip' ? 'Breakfast: skips it' : `Breakfast: ${profile.food.breakfastStyle.replace(/_/g, ' ')}`));
  food.push(line('pack_lunch', profile.food.willPackLunch ? 'Happy to pack lunch on outdoor days' : 'Wants a sit-down lunch even on outdoor days'));

  // --- budget -----------------------------------------------------------------------
  const budget: string[] = [];
  budget.push(line('budget', `Budget: ${profile.budgetStyle}${interview.budgetEnvelope ? ` (about ${interview.budgetEnvelope.currency} ${interview.budgetEnvelope.amount} ${interview.budgetEnvelope.basis.replace(/_/g, ' ')})` : ''}`));
  budget.push(line('convenience_spend', interview.convenienceSpend === 'pay_to_reduce_hassle' ? 'Pays to reduce hassle: transfers, bookings, the closer bed' : interview.convenienceSpend === 'save_money' ? 'Saves money over convenience' : 'Pays for convenience only when the saving is real'));

  // --- popularity -------------------------------------------------------------------
  const popularity: string[] = [];
  popularity.push(line('famous_vs_hidden', `Mix: ${profile.discoveryMix.replace(/_/g, ' ')}`));
  popularity.push(line('iconic_crowds', interview.iconicCrowdStrategy === 'see_it_anyway' ? 'Will see famous places even when busy' : interview.iconicCrowdStrategy === 'quieter_alternative' ? 'Prefers the quieter alternative to a crowded icon' : 'Visit famous places at quiet hours, plan the day around it'));
  popularity.push(`Crowds: ${profile.crowdTolerance.replace(/_/g, ' ')}${profile.avoidTouristTraps ? '; warn about tourist traps' : ''}`);

  // --- scope ------------------------------------------------------------------------
  const scope: string[] = [];
  scope.push(line('coverage_strategy', interview.scopeStrategy === 'depth' ? 'Go deep on one or two regions rather than moving around' : interview.scopeStrategy === 'breadth' ? 'Move around and see more of the country' : 'Choose the best coherent subset that fits the days'));
  if (profile.transport.willDrive) scope.push(line('scenic_reach', `Range from base: ${profile.regionalExpansion.replace(/_/g, ' ')}, detours up to ${profile.derived.effectiveDetourMinutes} minutes one way`));

  // --- own words ----------------------------------------------------------------------
  const ownWords: TravelerBriefOwnWords = {
    mustDo: [...(input.ownWords?.mustDo ?? [])],
    dislikes: [...(input.ownWords?.dislikes ?? [])],
    ...(input.ownWords?.freeText ? { freeText: input.ownWords.freeText } : {}),
    ...(interview.groupNotes ? { groupNotes: interview.groupNotes } : input.ownWords?.groupNotes ? { groupNotes: input.ownWords.groupNotes } : {}),
    ...(profile.accessibility.notes ? { mobilityNotes: profile.accessibility.notes } : input.ownWords?.mobilityNotes ? { mobilityNotes: input.ownWords.mobilityNotes } : {}),
  };

  return {
    version: TRAVELER_BRIEF_VERSION,
    tripFacts: trip,
    hardConstraints: [...new Set(hard)],
    travelStyle,
    priorities,
    secondary,
    avoid,
    transport,
    lodging,
    food,
    budget,
    popularity,
    scope,
    signals: {
      mustInclude: [...new Set([...(input.signals?.mustInclude ?? []), ...interview.mustInclude])].slice(0, 12),
      boardLikes: [...(input.signals?.boardLikes ?? [])].slice(0, 10),
      boardRejects: [...(input.signals?.boardRejects ?? [])].slice(0, 10),
      smartDefaults,
    },
    assumptions,
    ownWords,
  };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function section(tag: string, lines: readonly string[], empty?: string): string[] {
  if (lines.length === 0 && !empty) return [];
  const body = lines.length === 0 ? [`- ${empty}`] : lines.map((entry) => `- ${escapeXml(entry)}`);
  return [`<${tag}>`, ...body, `</${tag}>`];
}

/**
 * The brief as the composition call's context block. XML tags because they
 * are what the model separates cleanly; one sentence per line inside them.
 * Nothing here is an instruction — the system prompt owns those.
 */
export function renderTravelerBriefXml(brief: TravelerBrief): string {
  const t = brief.tripFacts;
  const partyBits = [`${t.adults} adult${t.adults === 1 ? '' : 's'}`, t.children > 0 ? `${t.children} child${t.children === 1 ? '' : 'ren'}` : null, t.seniors ? 'including older travellers' : null].filter(Boolean);
  const tripFacts = [
    `Destination: ${t.qualifiedName ?? t.destination}${t.scale ? ` (${t.scale})` : ''}${t.countryName ? `, ${t.countryName}` : ''}`,
    `Dates: ${t.startDate && t.endDate ? `${t.startDate} to ${t.endDate}` : 'not fixed'} — ${t.days} day${t.days === 1 ? '' : 's'}, ${t.nights} night${t.nights === 1 ? '' : 's'}${t.season ? ` (${t.season})` : ''}`,
    `Party: ${partyBits.join(', ')}`,
    `Arrival: ${t.arrival}. Departure: ${t.departure}.`,
    ...(t.origin ? [`Travelling from: ${t.origin}`] : []),
    ...(t.bookedFacts.length > 0 ? t.bookedFacts.map((fact) => `Already booked: ${fact}`) : ['Nothing booked yet']),
  ];
  const lines: string[] = [
    `<traveler_brief version="${brief.version}">`,
    ...section('trip_facts', tripFacts),
    ...section('hard_constraints', brief.hardConstraints, 'none stated'),
    ...section('travel_style', brief.travelStyle),
    ...section(
      'priorities',
      brief.priorities.map((p) => `${p.theme}: ${p.frequency}${p.assumed ? ' [assumed]' : ''}`),
      'none stated — choose the destination-defining experiences a first-time visitor would regret missing',
    ),
    ...section('secondary_preferences', brief.secondary),
    ...section('avoid', brief.avoid, 'nothing stated'),
    ...section('transport', brief.transport),
    ...section('lodging', brief.lodging),
    ...section('food', brief.food),
    ...section('budget', brief.budget),
    ...section('popularity', brief.popularity),
    ...section('scope', brief.scope),
    ...section('sidequest_signals', [
      ...(brief.signals.mustInclude.length > 0 ? [`Must include: ${brief.signals.mustInclude.join('; ')}`] : []),
      ...(brief.signals.boardLikes.length > 0 ? [`Discovery Board — sounds good: ${brief.signals.boardLikes.join('; ')}`] : []),
      ...(brief.signals.boardRejects.length > 0 ? [`Discovery Board — not interested: ${brief.signals.boardRejects.join('; ')}`] : []),
      `${brief.signals.smartDefaults} setting${brief.signals.smartDefaults === 1 ? '' : 's'} above marked [assumed] were chosen by Sidequest, not the traveller`,
    ]),
    ...section('assumptions', brief.assumptions, 'none — the traveller answered everything'),
    '</traveler_brief>',
  ];
  return lines.join('\n');
}
