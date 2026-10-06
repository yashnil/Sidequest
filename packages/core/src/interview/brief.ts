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

/**
 * Discovery Board decisions, kept apart by who made them.
 *
 * `mustInclude`, `boardLikes` and `boardRejects` are the traveller's own;
 * `sidequestRecommended` is what Sidequest pre-selected. The two used to arrive
 * in one "Must include" list, which told the model an automatic pick was the
 * traveller's choice. See `discovery/decisions.ts`.
 */
export interface TravelerBriefSignals {
  /** Names the traveller typed or marked as must-include — never a Sidequest pick. Never capped. */
  mustInclude: readonly string[];
  /** The traveller's maybes. */
  boardLikes: readonly string[];
  /** The traveller's skips, with the reason where one was given ("Name — too expensive"). */
  boardRejects: readonly string[];
  /** Sidequest's own pre-selection, in fit order. */
  sidequestRecommended?: readonly string[];
  /** How many of each capped list a prompt-size cap left out upstream. */
  omitted?: { boardLikes?: number; boardRejects?: number; sidequestRecommended?: number };
}

export interface TravelerBriefOwnWords {
  mustDo: readonly string[];
  dislikes: readonly string[];
  freeText?: string;
  groupNotes?: string;
  mobilityNotes?: string;
}

/**
 * V6 §3/§5 — one named person on the trip, as the composition reads them.
 *
 * Only what changes the plan: hard dietary rules, functional needs, what
 * this person enjoys when it differs from the group, their physical capacity
 * and their own words about what to plan around. No diagnosis, no private
 * notes, no age unless it was given as a planning fact.
 */
export interface TravelerBriefPartyMember {
  displayName: string;
  ageGroup?: string;
  relationship?: string;
  /** Hard dietary rules, one label each. */
  dietaryHard: readonly string[];
  /** Soft dietary preferences. */
  dietarySoft: readonly string[];
  /** Functional needs, one label each. */
  needs: readonly string[];
  /** "avoid steep climbs", "loves markets" — the differences from the group, in planning words. */
  differences: readonly string[];
  physicalCapability?: 'low' | 'moderate' | 'high';
  /** Their own words about what to plan around, verbatim. */
  notes?: string;
  /** False when this person's preferences are not to shape the plan (a baby, an invited guest who has not answered). */
  preferencesApply: boolean;
  constraintsApply: boolean;
}

export interface TravelerBrief {
  version: typeof TRAVELER_BRIEF_VERSION;
  tripFacts: TravelerBriefTripFacts;
  /** V6 — every named member of the party; empty when the traveller gave only counts. */
  party: TravelerBriefPartyMember[];
  /** V6 — what earlier trips taught Sidequest about this account, as leanings. */
  learned: string[];
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
  /**
   * MVP V3 — the sentences the traveller wrote beside an option they chose.
   *
   * "I'm very fit but don't want two huge hiking days back to back" says
   * something no enum in the profile holds, and it is the difference between a
   * trip that fits and one that technically satisfies every setting. Rendered
   * verbatim, in the traveller's own words, alongside the setting it qualifies.
   */
  inTheirWords: { about: string; note: string; readAs?: string[] }[];
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
  party?: readonly TravelerBriefPartyMember[];
  /** V6 §18 — leanings learned from earlier trips, medium or high confidence, phrased as leanings. Never rules. */
  learned?: readonly string[];
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
  /* V6 §5 — a person's hard rules are the group's hard rules: the kitchen and the trail do not average. */
  for (const member of input.party ?? []) {
    if (!member.constraintsApply) continue;
    for (const rule of member.dietaryHard) hard.push(`${member.displayName} cannot eat: ${rule}`);
    for (const need of member.needs) hard.push(`${member.displayName}: ${need}`);
  }
  if (profile.food.dietaryStrict && profile.food.dietaryNeeds.length > 0) {
    hard.push(`Dietary needs are absolute: ${profile.food.dietaryNeeds.map((n) => DIETARY_NEED_LABELS[n]).join(', ')}${profile.food.dietaryNotes ? ` — in their words: "${profile.food.dietaryNotes}"` : ''}`);
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
  if (interview.trailSetting !== 'mixed' || provenance.trail_setting) {
    secondary.push(line('trail_setting', interview.trailSetting === 'backcountry' ? 'Trails: backcountry welcome — huts, long approaches, real remoteness' : interview.trailSetting === 'frontcountry' ? 'Trails: front-country only — marked trails from a car park, back by dinner' : 'Trails: mostly front-country, with room for one bigger day'));
  }
  if (interview.permitSensitiveActivities !== 'keep_flexible' || provenance.permit_activities) {
    secondary.push(line('permit_activities', interview.permitSensitiveActivities === 'build_around' ? 'Permit-sensitive days: build the trip around them and list exactly what to book and by when' : 'Permit-sensitive days: leave out anything that needs a permit or a booking weeks ahead'));
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
      interview.transportChoice === 'rail_transfers'
        ? 'Getting around: trains and hired transfers for the regional days; on foot, metro and ride-hailing in the city; no self-drive'
        : profile.transport.willDrive
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
  /*
   * The traveller's own words about food, verbatim and unparsed, whether the
   * needs are strict or not. "Vegetarian, but I eat eggs" is a sentence the
   * enum cannot hold and the model can act on.
   */
  if (profile.food.dietaryNotes) food.push(line('dietary', `In their words: "${profile.food.dietaryNotes}"`));
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
  /*
   * Every "Something else" the traveller wrote, paired with the question it
   * qualifies. Nothing is parsed out of these; they travel as written.
   */
  const inTheirWords = Object.entries(profile.preferenceNotes ?? {})
    .flatMap(([questionId, note]) => {
      if (typeof note !== 'string' || note.trim().length === 0) return [];
      /* V7 §5 — what Sidequest read from the note, as accepted on screen; the sentence itself stays verbatim. */
      const readings = (profile.noteReadings?.[questionId] ?? []).map((r) => `${r.label} (${r.strength.replace(/_/g, ' ')})`);
      return [{ about: questionId.replace(/[_:]/g, ' '), note: note.trim(), ...(readings.length > 0 ? { readAs: readings } : {}) }];
    })
    .slice(0, 12);

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
    party: [...(input.party ?? [])],
    learned: [...(input.learned ?? [])],
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
      /* Never capped: these are bounded by the board and by what the traveller typed, and dropping one is a silent loss. */
      mustInclude: [...new Set([...(input.signals?.mustInclude ?? []), ...interview.mustInclude])],
      boardLikes: [...(input.signals?.boardLikes ?? [])].slice(0, SIGNAL_CAP),
      boardRejects: [...(input.signals?.boardRejects ?? [])].slice(0, SIGNAL_CAP),
      sidequestRecommended: [...(input.signals?.sidequestRecommended ?? [])].slice(0, SIGNAL_CAP),
      omitted: {
        boardLikes: (input.signals?.omitted?.boardLikes ?? 0) + Math.max(0, (input.signals?.boardLikes?.length ?? 0) - SIGNAL_CAP),
        boardRejects: (input.signals?.omitted?.boardRejects ?? 0) + Math.max(0, (input.signals?.boardRejects?.length ?? 0) - SIGNAL_CAP),
        sidequestRecommended:
          (input.signals?.omitted?.sidequestRecommended ?? 0) + Math.max(0, (input.signals?.sidequestRecommended?.length ?? 0) - SIGNAL_CAP),
      },
      smartDefaults,
    },
    assumptions,
    inTheirWords,
    ownWords,
  };
}

/** Prompt-size cap on each capped signal list; what it leaves out is counted, never silent. */
const SIGNAL_CAP = 10;

function omittedLine(count: number | undefined, noun: string): string[] {
  return count && count > 0 ? [`and ${count} more ${noun} (not shown)`] : [];
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
    ...(brief.party.length > 0
      ? section(
          'party',
          brief.party.map((m) => {
            const bits = [
              m.ageGroup ? m.ageGroup : null,
              m.relationship ? m.relationship : null,
              m.physicalCapability ? `${m.physicalCapability} physical capacity` : null,
              m.dietaryHard.length > 0 ? `cannot eat ${m.dietaryHard.join(', ')}` : null,
              m.dietarySoft.length > 0 ? `prefers to avoid ${m.dietarySoft.join(', ')}` : null,
              m.needs.length > 0 ? `plan around: ${m.needs.join('; ')}` : null,
              ...m.differences,
              m.notes ? `in their words: "${m.notes}"` : null,
              !m.preferencesApply ? 'their tastes do not shape the plan' : null,
            ].filter(Boolean);
            return `${m.displayName}${bits.length > 0 ? ` — ${bits.join('; ')}` : ''}`;
          }),
        )
      : []),
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
    /*
     * Four sections, one per author and intent. A Sidequest pre-selection is
     * never described as something the traveller chose.
     */
    ...(brief.signals.mustInclude.length > 0
      ? section('traveller_must_includes', [`Must include: ${brief.signals.mustInclude.join('; ')}`, 'Chosen by the traveller — schedule every one, or say why it could not be'])
      : []),
    ...(brief.signals.boardRejects.length > 0
      ? section('traveller_exclusions', [
          `The traveller said no — never schedule: ${brief.signals.boardRejects.join('; ')}`,
          ...omittedLine(brief.signals.omitted?.boardRejects, 'traveller exclusions'),
        ])
      : []),
    ...(brief.signals.boardLikes.length > 0
      ? section('traveller_maybes', [
          `The traveller marked maybe — include if it fits: ${brief.signals.boardLikes.join('; ')}`,
          ...omittedLine(brief.signals.omitted?.boardLikes, 'traveller maybes'),
        ])
      : []),
    ...((brief.signals.sidequestRecommended?.length ?? 0) > 0
      ? section('sidequest_recommended_candidates', [
          `Pre-selected by Sidequest, not by the traveller — use where they fit the plan, drop any that do not: ${brief.signals.sidequestRecommended!.join('; ')}`,
          ...omittedLine(brief.signals.omitted?.sidequestRecommended, 'Sidequest recommendations'),
        ])
      : []),
    ...section('sidequest_signals', [
      `${brief.signals.smartDefaults} setting${brief.signals.smartDefaults === 1 ? '' : 's'} above marked [assumed] were chosen by Sidequest, not the traveller`,
    ]),
    ...section(
      'in_their_words',
      brief.inTheirWords.map((entry) => `On ${entry.about}: "${entry.note}"${entry.readAs && entry.readAs.length > 0 ? ` [read as: ${entry.readAs.join('; ')}]` : ''}`),
    ),
    ...section('assumptions', brief.assumptions, 'none — the traveller answered everything'),
    ...(brief.learned.length > 0 ? section('learned_leanings', brief.learned.map((line) => `${line} — a leaning from earlier trips, never a rule; this trip's own answers win`)) : []),
    '</traveler_brief>',
  ];
  return lines.join('\n');
}
