import { INTEREST_LABELS, formatMinuteOfDay, type Interest, type InterestLevel } from '../schemas/common';
import { DIETARY_NEED_LABELS } from '../schemas/food';
import type { PreferenceProvenance } from '../schemas/interview';
import type { TravelerProfile } from '../schemas/profile';
import { describeHard } from './review';

/**
 * THE COMPOSITION PREFERENCE SUMMARY.
 *
 * Only planning signals, as sentences the composition model can act on,
 * split three ways: hard constraints (filters), explicit preferences (what
 * the traveller chose), and assumptions (what Sidequest decided, tagged so
 * the model knows it may trade them away). Built from the profile alone so a
 * test can prove that changing one answer changes exactly the lines that
 * answer feeds.
 */
export interface CompositionPreferenceSummary {
  version: 'sidequest-preference-summary/1';
  hard: string[];
  explicit: string[];
  assumed: string[];
  mustInclude: string[];
  mustAvoid: string[];
}

type Bucket = 'explicit' | 'assumed';

function bucketFor(provenance: PreferenceProvenance | undefined): Bucket {
  return provenance?.source === 'explicit' ? 'explicit' : 'assumed';
}

function tag(provenance: PreferenceProvenance | undefined): string {
  if (!provenance) return ' (assumed)';
  if (provenance.source === 'explicit') return '';
  if (provenance.source === 'existing_profile') return ' (from their trip setup)';
  if (provenance.source === 'destination_prior') return ' (assumed from the destination)';
  return ' (assumed)';
}

const LEVEL_PHRASE: Record<InterestLevel, string> = {
  avoid: 'avoid',
  low: 'only if it is right there',
  occasional: 'once or twice',
  frequent: 'a few times',
  core: 'the heart of the trip',
};

export function compositionPreferenceSummary(profile: TravelerProfile): CompositionPreferenceSummary {
  const hard: string[] = [];
  const explicit: string[] = [];
  const assumed: string[] = [];
  const provenance = profile.provenance;
  const add = (questionId: string, sentence: string) => {
    const entry = provenance[questionId];
    (bucketFor(entry) === 'explicit' ? explicit : assumed).push(`${sentence}${tag(entry)}`);
  };
  const interview = profile.interview;

  // --- hard --------------------------------------------------------------------
  for (const constraint of profile.hard) hard.push(describeHard(constraint));
  if (profile.food.dietaryStrict && profile.food.dietaryNeeds.length > 0) {
    hard.push(`Dietary needs are absolute: ${profile.food.dietaryNeeds.map((n) => DIETARY_NEED_LABELS[n]).join(', ')}`);
  }
  if (profile.accessibility.mobilityLimited) hard.push('Somebody in the group has limited mobility: low-effort, step-free stops only');
  if (!profile.transport.willDrive && provenance.transport_mode?.strength === 'hard') hard.push('Nobody will be driving');

  // --- priorities --------------------------------------------------------------------
  const chosen = (Object.entries(profile.interests) as [Interest, InterestLevel][]).filter(([, level]) => level === 'occasional' || level === 'frequent' || level === 'core');
  if (chosen.length > 0) {
    add('priorities', `Priorities: ${chosen.map(([interest, level]) => `${INTEREST_LABELS[interest].toLowerCase()} (${LEVEL_PHRASE[level]})`).join('; ')}`);
  }
  const avoided = (Object.entries(profile.interests) as [Interest, InterestLevel][]).filter(([, level]) => level === 'avoid');
  if (avoided.length > 0) explicit.push(`Not interested in: ${avoided.map(([interest]) => INTEREST_LABELS[interest].toLowerCase()).join(', ')}`);

  // --- rhythm ---------------------------------------------------------------------------
  add('day_shape', profile.pace === 'slow' ? 'Days: one major experience, then time to linger' : profile.pace === 'fast' ? 'Days: cover a lot, happy to be on the move' : 'Days: two or three meaningful stops');
  add('day_start', profile.dayStart === 'early' ? 'Starts early, before the light gets flat' : profile.dayStart === 'relaxed' ? 'Relaxed mornings, no alarms' : 'Moving by mid-morning');
  add('effort', `Effort: ${profile.dailyIntensity}`);
  if (interview.lateNights !== 'sometimes' || provenance.late_nights) add('late_nights', interview.lateNights === 'fine' ? 'Late nights are fine' : interview.lateNights === 'no' ? 'Early nights: dinner, then done' : 'A late night or two, never before an early start');

  // --- movement --------------------------------------------------------------------------
  add(
    'transport_mode',
    profile.transport.willDrive
      ? `Getting around: a car, at most ${profile.transport.maxDailyDriveMinutes} minutes driving on an ordinary day`
      : interview.guideWillingness === 'prefer'
        ? 'Getting around: guided, with arranged transfers'
        : interview.privateTransfers === 'fine' && profile.transport.priority === 'least_stressful'
          ? 'Getting around: mostly taxis and rideshare, no car'
          : 'Getting around: on foot and by public transport, no car',
  );
  if (profile.transport.willDrive) {
    add('daily_driving', `Daily driving ceiling: ${profile.transport.maxDailyDriveMinutes} minutes round trip`);
    add('road_comfort', profile.transport.comfortableGravelRoads ? 'Mountain passes and graded gravel are fine' : profile.transport.comfortableMountainRoads ? 'Mountain passes are fine; no gravel' : 'Paved roads only');
    add('scenic_reach', `Range from base: ${profile.regionalExpansion.replace(/_/g, ' ')}, detours up to ${profile.derived.effectiveDetourMinutes} minutes one way`);
  } else {
    add('walking_tolerance', interview.walkingTolerance === 'lots' ? 'Happy to cover whole neighbourhoods on foot' : interview.walkingTolerance === 'little' ? 'Keep walking short; ride between stops' : 'A comfortable amount on foot, then a ride');
    add('transit_comfort', profile.transport.priority === 'least_stressful' ? 'Prefers taxis when a transit change is awkward' : profile.transport.priority === 'cheapest' ? 'Rides the network whatever it takes' : 'Public transport when it is simple, a taxi when it is not');
  }
  add('day_trips', interview.dayTripAppetite === 'stay_in_city' ? 'Stay in the city every day' : interview.dayTripAppetite === 'several' ? 'Several day trips out of the city' : 'One day trip out of the city at most');
  add('base_moves', interview.baseMoveTolerance === 'stay_put' ? 'One base for the whole trip' : interview.baseMoveTolerance === 'move_once' ? 'Change hotels once if it saves real time' : interview.baseMoveTolerance === 'move_freely' ? 'Move as often as the route wants' : 'Move hotels only when it clearly saves time');
  add('coverage_strategy', interview.scopeStrategy === 'depth' ? 'Go deep on one or two regions rather than moving around' : interview.scopeStrategy === 'breadth' ? 'Move around and see more of the country' : 'Choose the best coherent subset that fits the days');
  add('guide_willingness', interview.guideWillingness === 'prefer' ? 'Prefers guided days' : interview.guideWillingness === 'avoid' ? 'Avoids guides; self-guided wherever possible' : 'Guides only where they earn their place');
  add('private_transfers', interview.privateTransfers === 'fine' ? 'Arranged transfers Sidequest cannot verify are acceptable (mark them unverified)' : interview.privateTransfers === 'avoid' ? 'Only transport legs that can be verified' : 'Arranged transfers only where nothing else works');
  add('remote_comfort', interview.remoteComfort === 'fine' ? 'Days without signal or services are fine' : interview.remoteComfort === 'cannot' ? 'Never out of reach of services' : 'Keep most days near a town');
  add('boats_ferries', interview.boatsAndFerries === 'fine' ? 'Boats and ferries are fine' : interview.boatsAndFerries === 'cannot' ? 'No boats' : 'Rather not take boats; short crossings only');
  add('internal_flights', interview.internalFlights === 'fine' ? 'Short internal flights are fine where they save a day' : interview.internalFlights === 'cannot' ? 'No small aircraft' : 'Rather not fly internally');
  add('altitude_comfort', interview.altitudeComfort === 'fine' ? 'Altitude is not a concern' : interview.altitudeComfort === 'avoid_high' ? 'Keep the plan below high altitude' : 'Take altitude slowly: easy first days, sleep low');
  add('hike_appetite', interview.hikeAppetite === 'none' ? 'No real hikes; viewpoints and easy paths' : interview.hikeAppetite === 'short' ? 'Hikes under two hours, gentle' : interview.hikeAppetite === 'full_day' ? 'A full-day hike is welcome' : 'Half-day hikes are fine');
  add('trail_setting', interview.trailSetting === 'backcountry' ? 'Backcountry welcome: huts, long approaches, real remoteness' : interview.trailSetting === 'frontcountry' ? 'Front-country only: marked trails from a car park, back by dinner' : 'Mostly front-country, with room for one bigger day');
  add('permit_activities', interview.permitSensitiveActivities === 'build_around' ? 'Build the trip around permit- or booking-bound days and list what to book' : 'Keep the plan flexible; leave out anything that needs a permit or a booking weeks ahead');
  add('stairs_hills', interview.stairsAndHills === 'fine' ? 'Stairs and steep streets are fine' : interview.stairsAndHills === 'cannot' ? 'Level access only' : 'Prefer the lift or the flat route');

  // --- taste ----------------------------------------------------------------------------
  add('iconic_crowds', interview.iconicCrowdStrategy === 'see_it_anyway' ? 'Will see famous places even when busy' : interview.iconicCrowdStrategy === 'quieter_alternative' ? 'Prefers the quieter alternative to a crowded icon' : 'Visit famous places at quiet hours, plan the day around it');
  add('famous_vs_hidden', `Mix: ${profile.discoveryMix.replace(/_/g, ' ')}`);
  add('food_tradeoff', profile.food.style === 'destination' ? `Food matters: happy to cross town for an exceptional meal (${profile.food.specialMealBudget} special meal${profile.food.specialMealBudget === 1 ? '' : 's'})` : profile.food.style === 'budget' ? 'Food is fuel: quick, cheap, on the route' : 'Good local meals near the route, no detours');
  if (profile.food.dietaryNeeds.length > 0 && !profile.food.dietaryStrict) add('dietary', `Dietary preferences: ${profile.food.dietaryNeeds.map((n) => DIETARY_NEED_LABELS[n]).join(', ')}`);
  add('budget', `Budget: ${profile.budgetStyle}${interview.budgetEnvelope ? ` (about ${interview.budgetEnvelope.currency} ${interview.budgetEnvelope.amount} ${interview.budgetEnvelope.basis.replace(/_/g, ' ')})` : ''}`);
  add('convenience_spend', interview.convenienceSpend === 'pay_to_reduce_hassle' ? 'Pays to reduce hassle: transfers, bookings, the closer bed' : interview.convenienceSpend === 'save_money' ? 'Saves money over convenience' : 'Pays for convenience only when the saving is real');
  add('lodging_style', `Lodging: ${interview.lodgingStyle.replace(/_/g, ' ')}${interview.rusticLodgingOk ? '; simple lodges and homestays acceptable' : '; proper hotels only'}`);
  if (profile.avoidances.length > 0) explicit.push(`Steer around: ${profile.avoidances.map((a) => a.replace(/_/g, ' ')).join(', ')}`);
  add('everyone_every_day', interview.everyoneEveryDay ? 'The group stays together every day' : 'The group may split for a few hours when appetites differ');
  if (interview.groupNotes) explicit.push(`About the group: ${interview.groupNotes}`);
  if (interview.mustBeBackByMinute !== undefined) hard.push(`Back at base by ${formatMinuteOfDay(interview.mustBeBackByMinute)} every day`);

  return {
    version: 'sidequest-preference-summary/1',
    hard: [...new Set(hard)],
    explicit,
    assumed,
    mustInclude: [...interview.mustInclude],
    mustAvoid: [...interview.mustAvoid],
  };
}

/** The summary as prompt lines. */
export function renderPreferenceSummary(summary: CompositionPreferenceSummary): string[] {
  const lines: string[] = ['PREFERENCES (hard constraints are filters; assumptions may be traded away for a better trip)'];
  if (summary.hard.length > 0) {
    lines.push('Hard constraints:');
    for (const entry of summary.hard) lines.push(`- ${entry}`);
  } else lines.push('Hard constraints: none stated.');
  if (summary.mustInclude.length > 0) lines.push(`Must include: ${summary.mustInclude.join('; ')}.`);
  if (summary.mustAvoid.length > 0) lines.push(`Must avoid: ${summary.mustAvoid.join('; ')}.`);
  if (summary.explicit.length > 0) {
    lines.push('Stated preferences:');
    for (const entry of summary.explicit) lines.push(`- ${entry}`);
  }
  if (summary.assumed.length > 0) {
    lines.push('Assumptions Sidequest made (tagged):');
    for (const entry of summary.assumed) lines.push(`- ${entry}`);
  }
  return lines;
}
