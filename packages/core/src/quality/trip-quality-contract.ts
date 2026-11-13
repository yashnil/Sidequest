import type { ScanKind } from '../scan/proposal';

/**
 * THE TRIP-QUALITY CONTRACT — WHAT A SUCCESSFUL TRIP IS, DECIDED BEFORE THE DAYS.
 *
 * The 2026-11 blind evaluation found plans that were feasible and still wrong
 * for the trip: a Kodo pilgrimage with no Kodo walk, a "by train" trip with a
 * rental car, a restful family trip with 05:30 starts, a beach retreat built
 * around a 13-hour hike. Nothing upstream said what the trip was *for*, so
 * nothing downstream could notice it had been lost.
 *
 * This module says it, deterministically, from the traveller's own words, the
 * profile, the destination's semantic type and the discovery proposal's own
 * `defining` marks — and then checks the finished plan against it:
 *
 * - **Requirements vs preferences.** A requirement failing fails the contract
 *   (and is stated to the traveller with a way to recover); a preference
 *   failing is a warning. Nothing here deletes or moves a stop.
 * - **Essential experiences** come from three sources: what the traveller said
 *   (their must-dos, "safari", "by train"), what kind of destination it is
 *   (a trail is walked, a safari is game drives, a beach retreat has beach
 *   time), and what the proposal marked as defining for this destination.
 * - **Where it failed.** A missing essential is attributed to *discovery* (no
 *   candidate on the board could satisfy it), *selection* (one was on the board
 *   and the plan left it out) or *scheduling*; that is what the repeatability
 *   harness reports.
 *
 * Every word table is data about activities, never about a place. Never patch
 * a destination by name.
 */

export const TRIP_QUALITY_CONTRACT_VERSION = 1 as const;

export type TripPurpose = 'rest' | 'trail' | 'wildlife' | 'route' | 'beach' | 'snow' | 'mountain_walking' | 'city_culture' | 'general';
export type ExperienceSource = 'traveller' | 'request' | 'destination' | 'proposal';
export type Requirement = 'requirement' | 'preference';

export interface EssentialExperience {
  id: string;
  label: string;
  requirement: Requirement;
  source: ExperienceSource;
  /** Satisfied by any of these candidates (proposal-defining, traveller-named). */
  placeIds?: readonly string[];
  /** …or by stops of these kinds, at least `minCount` of them. */
  kinds?: readonly ScanKind[];
  /** …or by stops whose name carries one of these words (activity words, never place names). */
  nameTerms?: readonly string[];
  minCount: number;
  /** What the traveller can do when it is missing. */
  recovery: string;
}

export interface ContractConstraint {
  id: string;
  text: string;
  requirement: Requirement;
}

export interface TripQualityContract {
  version: typeof TRIP_QUALITY_CONTRACT_VERSION;
  purpose: TripPurpose;
  secondary: readonly TripPurpose[];
  essentials: readonly EssentialExperience[];
  constraints: readonly ContractConstraint[];
  pace: 'slow' | 'balanced' | 'fast';
  intensity: 'light' | 'moderate' | 'intense';
  transport: { mode: 'self_drive' | 'public_transport' | 'operator' | 'undecided'; stated: boolean };
  structure: 'single_base' | 'multi_base' | 'route' | 'trail_stages' | 'undecided';
  timing: {
    /** No day starts before this minute unless a stop that needs it was picked by the traveller. */
    earliestStartMinute: number;
    /** Optional dawn experiences need the traveller's own pick. */
    dawnNeedsConsent: boolean;
    maxDailyTravelMinutes: number | null;
  };
  namedParts: readonly string[];
  mustSee: readonly string[];
  mustAvoid: readonly string[];
  uncertainties: readonly string[];
}

/* ---------- activity word tables (data; extend, never special-case a place) ---------- */

const words = (list: readonly string[]) => new RegExp(`\\b(?:${list.join('|')})\\b`, 'i');
/** Walking a named path is the point: generic path words in the languages travellers type them in. */
export const TRAIL_WORDS = words(['trail', 'trek', 'trekking', 'hike', 'hiking', 'camino', 'pilgrimage', 'pilgrim', 'kodo', 'kōdō', 'sentiero', 'wanderweg', 'randonn[ée]e', 'thru-hike', 'long-distance walk', 'walking holiday', 'hut to hut', 'hut-to-hut', 'GR ?\\d+']);
export const SAFARI_WORDS = words(['safari', 'game drives?', 'big five', 'wildlife']);
export const ROUTE_WORDS = words(['road ?trip', 'ring road', 'scenic drive', 'self-drive', 'drive around', 'loop drive']);
export const BEACH_WORDS = words(['beach', 'beaches', 'island retreat', 'snorkel(?:ling)?', 'surf(?:ing)?', 'lagoon']);
export const SNOW_WORDS = words(['ski', 'skiing', 'snowboard(?:ing)?', 'ski trip', 'ski holiday', 'slopes']);
export const MOUNTAIN_WALK_WORDS = words(['hiking', 'hikes', 'walking', 'trekking', 'mountain walks?']);
export const REST_WORDS = words(['retreat', 'relax(?:ing)?', 'rest(?:ful)?', 'unwind', 'stress(?:ful|ed)?', 'spa', 'wellness', 'recharge', 'feel good', 'easy days?', 'slow']);

const TRAIL_KINDS: ScanKind[] = ['day_hike', 'easy_walk'];
const WILDLIFE_KINDS: ScanKind[] = ['wildlife', 'national_park'];
const BEACH_KINDS: ScanKind[] = ['beach'];
const WALK_KINDS: ScanKind[] = ['day_hike', 'easy_walk', 'national_park'];
const CULTURE_KINDS: ScanKind[] = ['museum', 'gallery', 'historic_site', 'castle_or_palace', 'temple_or_shrine', 'religious_site', 'neighbourhood', 'landmark', 'market', 'cultural_experience'];

export interface TripQualityContractInput {
  /** Everything the traveller typed: the destination phrase, a Help-me-choose request, notes and must-dos. */
  ownWords: string;
  /** The destination's semantic type (`destinations/semantics.ts`). */
  semanticType?: string | null;
  /** A route the traveller asked to travel (`destinations/route-shape.ts`). */
  routeKind?: string | null;
  tripDays: number;
  pace: 'slow' | 'balanced' | 'fast';
  intensity: 'light' | 'moderate' | 'intense';
  /** The concept's restful weight (restoration + wellness + family rest), 0–1. */
  restfulWeight: number;
  carAvailable: boolean;
  statedMode: 'drive' | 'public_transport' | null;
  maxDailyTravelMinutes: number | null;
  preferredStartMinute: number | null;
  namedParts: readonly string[];
  mustDos: readonly string[];
  avoidances: readonly string[];
  /** The destination's pillars for this trip (structured defining experiences): each satisfied by any one of its candidates. */
  pillars?: readonly { name: string; tier: 'essential' | 'recommended' | 'optional'; why: string; placeIds: readonly string[] }[];
  /** The board's candidates: id, name, kind, whether the proposal marked it defining, and whether it is usable on this trip. */
  candidates: readonly { id: string; name: string; kind?: ScanKind | null; defining?: boolean; blocked?: boolean; mustDo?: boolean }[];
}

export function buildTripQualityContract(input: TripQualityContractInput): TripQualityContract {
  const text = input.ownWords;
  const purposes: TripPurpose[] = [];
  const restful = input.restfulWeight >= 0.5 || REST_WORDS.test(text);
  const trail = TRAIL_WORDS.test(text) && !SNOW_WORDS.test(text);
  if (trail && (input.semanticType === 'corridor' || /\b(?:trail|camino|pilgrimage|kodo|kōdō|sentiero|wanderweg|GR ?\d+|hut[- ]to[- ]hut)\b/i.test(text))) purposes.push('trail');
  if (SAFARI_WORDS.test(text)) purposes.push('wildlife');
  if (input.routeKind || ROUTE_WORDS.test(text)) purposes.push('route');
  if (BEACH_WORDS.test(text) || input.semanticType === 'island' || input.semanticType === 'island_group') purposes.push('beach');
  if (SNOW_WORDS.test(text)) purposes.push('snow');
  if (!purposes.includes('trail') && (input.semanticType === 'mountain_region' || /\bmountains?\b/i.test(text)) && MOUNTAIN_WALK_WORDS.test(text)) purposes.push('mountain_walking');
  if ((input.semanticType === 'settlement' || input.semanticType === 'city_region') && purposes.length === 0) purposes.push('city_culture');
  if (restful) purposes.unshift('rest');
  if (purposes.length === 0) purposes.push('general');
  const purpose = purposes[0]!;
  const days = Math.max(1, input.tripDays);

  const essentials: EssentialExperience[] = [];
  const have = (id: string) => essentials.some((e) => e.id === id);
  if (purposes.includes('trail')) {
    essentials.push({ id: 'walk_the_trail', label: 'Walking a stage of the trail itself', requirement: 'requirement', source: 'destination', kinds: TRAIL_KINDS, nameTerms: ['trail', 'stage', 'walk', 'hike', 'kodo', 'camino', 'path'], minCount: 1, recovery: 'Add a walkable stage of the trail on the Discovery Board, or tell Sidequest which section suits the party.' });
  }
  if (purposes.includes('wildlife')) {
    essentials.push({ id: 'wildlife_viewing', label: 'Game drives in the parks', requirement: 'requirement', source: 'request', kinds: WILDLIFE_KINDS, nameTerms: ['game drive', 'safari', 'crater', 'national park', 'reserve'], minCount: Math.max(2, Math.floor(days / 3)), recovery: 'Add game drives in the parks on the Discovery Board; an operator-run circuit is the usual way.' });
  }
  if (purposes.includes('beach')) {
    essentials.push({ id: 'beach_time', label: 'Unhurried time on a beach', requirement: purpose === 'beach' || restful ? 'requirement' : 'preference', source: 'destination', kinds: BEACH_KINDS, nameTerms: ['beach', 'bay', 'cove', 'lagoon'], minCount: Math.max(1, Math.floor(days / 3)), recovery: 'Add beach days on the Discovery Board.' });
  }
  if (purposes.includes('snow')) {
    essentials.push({ id: 'ski_days', label: 'Days on the slopes', requirement: 'requirement', source: 'request', nameTerms: ['ski', 'piste', 'slopes', 'lift'], minCount: Math.max(1, Math.floor(days / 2)), recovery: 'Add ski days on the Discovery Board.' });
  }
  if (purposes.includes('mountain_walking') && !have('walk_the_trail')) {
    essentials.push({ id: 'mountain_walks', label: 'Real walks in the mountains', requirement: 'requirement', source: 'request', kinds: WALK_KINDS, nameTerms: ['hike', 'trail', 'walk', 'loop', 'circuit'], minCount: Math.max(2, Math.floor(days / 3)), recovery: 'Add more day hikes on the Discovery Board.' });
  }
  if (purposes.includes('city_culture')) {
    essentials.push({ id: 'city_culture', label: 'The city’s own culture and neighbourhoods', requirement: 'preference', source: 'destination', kinds: CULTURE_KINDS, minCount: Math.max(2, Math.floor(days * 0.8)), recovery: 'Add museums, historic quarters or neighbourhoods on the Discovery Board.' });
  }
  /*
   * Pillars: one requirement per essential pillar and one preference per
   * recommended pillar, each covered by any one of its candidates the traveller
   * can use. A pillar whose candidates are all unusable or unplaced is still a
   * requirement — the evaluation reports it as a discovery gap with its reason.
   */
  const usableIds = new Set(input.candidates.filter((c) => !c.blocked).map((c) => c.id));
  const nameOf = new Map(input.candidates.map((c) => [c.id, c.name] as const));
  for (const [index, pillar] of (input.pillars ?? []).entries()) {
    if (pillar.tier === 'optional') continue;
    const ids = pillar.placeIds.filter((id) => usableIds.has(id));
    const names = ids.map((id) => nameOf.get(id)).filter((n): n is string => Boolean(n)).slice(0, 3);
    essentials.push({
      id: `pillar:${index}`,
      label: pillar.name,
      requirement: pillar.tier === 'essential' ? 'requirement' : 'preference',
      source: 'proposal',
      placeIds: ids,
      minCount: 1,
      recovery: names.length > 0 ? `${pillar.why ? `${pillar.why} ` : ''}Keep one of ${names.join(', ')} on the Discovery Board and rebuild.` : `${pillar.why ? `${pillar.why} ` : ''}Nothing that offers it could be placed for this trip; ask Sidequest for it by name, or choose dates or a length that fit it.`,
    });
  }
  /* What the proposal marked as defining, where no pillars were named. */
  const defining = (input.pillars ?? []).length > 0 ? [] : input.candidates.filter((c) => c.defining && !c.blocked);
  if (defining.length > 0) {
    essentials.push({ id: 'destination_defining', label: `What the destination is known for (${defining.slice(0, 3).map((c) => c.name).join(', ')})`, requirement: 'requirement', source: 'proposal', placeIds: defining.map((c) => c.id), minCount: 1, recovery: 'Keep at least one of these on the Discovery Board and rebuild.' });
  }
  for (const c of input.candidates.filter((c) => c.mustDo)) {
    essentials.push({ id: `must:${c.id}`, label: c.name, requirement: 'requirement', source: 'traveller', placeIds: [c.id], minCount: 1, recovery: `Lock ${c.name} to a day, or free a day for it.` });
  }

  const constraints: ContractConstraint[] = [];
  const transportMode: TripQualityContract['transport']['mode'] = input.statedMode === 'public_transport' ? 'public_transport' : purposes.includes('wildlife') ? 'operator' : input.statedMode === 'drive' || input.carAvailable ? 'self_drive' : input.carAvailable === false ? 'public_transport' : 'undecided';
  if (transportMode === 'public_transport') constraints.push({ id: 'no_self_drive', text: 'No hire car: the trip moves by public transport and on foot.', requirement: input.statedMode ? 'requirement' : 'preference' });
  if (transportMode === 'operator') constraints.push({ id: 'operator_ground', text: 'Ground travel is the operator’s vehicle and driver-guide, not a self-drive hire car.', requirement: 'requirement' });
  if (restful) constraints.push({ id: 'restful_pace', text: 'Unhurried days: no pre-dawn starts the traveller did not choose, and short travel.', requirement: 'requirement' });
  if (input.maxDailyTravelMinutes) constraints.push({ id: 'daily_travel', text: `No more than about ${input.maxDailyTravelMinutes} minutes of travel a day.`, requirement: 'preference' });
  for (const a of input.avoidances.slice(0, 8)) constraints.push({ id: `avoid:${a}`, text: `Avoid ${a}.`, requirement: 'requirement' });

  const earliest = restful || input.pace === 'slow' ? Math.max(input.preferredStartMinute ?? 0, 7 * 60) : Math.max(input.preferredStartMinute ?? 0, 6 * 60);
  const uncertainties: string[] = [];
  if (purposes.includes('trail') && !defining.length && !input.candidates.some((c) => c.kind && TRAIL_KINDS.includes(c.kind))) uncertainties.push('No walkable stage of the trail was proposed; Sidequest cannot yet say which section suits the party.');
  if (transportMode === 'undecided') uncertainties.push('How the trip moves is not settled.');

  return {
    version: TRIP_QUALITY_CONTRACT_VERSION,
    purpose,
    secondary: purposes.slice(1),
    essentials,
    constraints,
    pace: input.pace,
    intensity: input.intensity,
    transport: { mode: transportMode, stated: input.statedMode !== null },
    structure: purposes.includes('trail') && days >= 3 ? 'trail_stages' : purposes.includes('route') ? 'route' : input.namedParts.length >= 2 ? 'multi_base' : 'undecided',
    timing: { earliestStartMinute: earliest, dawnNeedsConsent: restful || input.pace === 'slow', maxDailyTravelMinutes: input.maxDailyTravelMinutes },
    namedParts: input.namedParts,
    mustSee: input.mustDos,
    mustAvoid: input.avoidances,
    uncertainties,
  };
}

/* ---------- evaluation ---------- */

export type ContractFailureStage = 'discovery' | 'selection' | 'scheduling' | 'transport' | 'timing' | 'pace';

export interface ContractViolation {
  id: string;
  severity: 'fail' | 'warn';
  stage: ContractFailureStage;
  detail: string;
  recovery?: string;
}

export interface TripQualityEvaluation {
  version: typeof TRIP_QUALITY_CONTRACT_VERSION;
  passed: boolean;
  satisfied: readonly string[];
  violations: readonly ContractViolation[];
}

export interface PlanForContract {
  days: readonly {
    dayNumber: number;
    /** First scheduled minute of the day (activities only), local. */
    firstStartMinute: number | null;
    stops: readonly { placeId?: string; name: string; kind?: ScanKind | null; startMinute: number; pickedByTraveller?: boolean }[];
    travelMinutes: number;
  }[];
  /** Candidates on the board (so a missing essential can be attributed). */
  board: readonly { id: string; name: string; kind?: ScanKind | null }[];
  /** Whether bookings, budget or prepare ask for a self-drive hire car. */
  selfDriveRequested: boolean;
  /** The stay decision's trail record (`scan/trail-stages.ts`), when the scan judged one: whether the stays follow it, and why not. */
  trail?: { followed: boolean; gap?: string | undefined } | null;
}

function matches(e: EssentialExperience, stop: { placeId?: string; name: string; kind?: ScanKind | null }): boolean {
  if (e.placeIds && stop.placeId && e.placeIds.includes(stop.placeId)) return true;
  if (e.kinds && stop.kind && e.kinds.includes(stop.kind)) return true;
  if (e.nameTerms && e.nameTerms.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(stop.name))) return true;
  return false;
}

export function evaluateTripQualityContract(contract: TripQualityContract, plan: PlanForContract): TripQualityEvaluation {
  const violations: ContractViolation[] = [];
  const satisfied: string[] = [];
  const stops = plan.days.flatMap((d) => d.stops);
  for (const e of contract.essentials) {
    const count = stops.filter((s) => matches(e, s)).length;
    if (count >= e.minCount) {
      satisfied.push(e.id);
      continue;
    }
    const onBoard = plan.board.some((c) => matches(e, { placeId: c.id, name: c.name, kind: c.kind ?? null }));
    const stage: ContractFailureStage = count > 0 ? 'scheduling' : onBoard ? 'selection' : 'discovery';
    violations.push({
      id: e.id,
      severity: e.requirement === 'requirement' ? 'fail' : 'warn',
      stage,
      detail: count > 0 ? `${e.label}: ${count} of the ${e.minCount} a trip like this needs.` : `${e.label} is not in the plan${stage === 'discovery' ? ', and nothing on the board offers it' : ', although the board offers it'}.`,
      recovery: e.recovery,
    });
  }
  /*
   * A stage-based walk that could not be planned inn to inn is a gap in the
   * contract, said in its own words — never papered over with day hikes that
   * look like a trek. The walk itself is still checked above.
   */
  if (contract.structure === 'trail_stages' && plan.trail && !plan.trail.followed) {
    violations.push({ id: 'trail_stages', severity: 'warn', stage: 'discovery', detail: plan.trail.gap ?? 'This trip is not planned as a walk from inn to inn.', recovery: 'Add the trail stages that suit the party, with places to sleep at their ends, on the Discovery Board, or tell Sidequest which section to walk.' });
  }
  const hard = (id: string) => contract.constraints.find((c) => c.id === id);
  const noDrive = hard('no_self_drive') ?? hard('operator_ground');
  if (noDrive && plan.selfDriveRequested) violations.push({ id: noDrive.id, severity: noDrive.requirement === 'requirement' ? 'fail' : 'warn', stage: 'transport', detail: `${noDrive.text} The plan still asks for a hire car.` });
  for (const day of plan.days) {
    const early = day.stops.filter((s) => s.startMinute < contract.timing.earliestStartMinute && !(contract.timing.dawnNeedsConsent && s.pickedByTraveller));
    if (early.length > 0) violations.push({ id: `early:${day.dayNumber}`, severity: hard('restful_pace') ? 'fail' : 'warn', stage: 'pace', detail: `Day ${day.dayNumber} starts at ${String(Math.floor(early[0]!.startMinute / 60)).padStart(2, '0')}:${String(early[0]!.startMinute % 60).padStart(2, '0')} for ${early[0]!.name}, earlier than this trip asked for.` });
    if (contract.timing.maxDailyTravelMinutes && day.travelMinutes > contract.timing.maxDailyTravelMinutes * 1.25) violations.push({ id: `travel:${day.dayNumber}`, severity: 'warn', stage: 'scheduling', detail: `Day ${day.dayNumber} has about ${Math.round(day.travelMinutes)} minutes of travel, well past the ${contract.timing.maxDailyTravelMinutes} the trip allows.` });
  }
  return { version: TRIP_QUALITY_CONTRACT_VERSION, passed: !violations.some((v) => v.severity === 'fail'), satisfied, violations };
}
