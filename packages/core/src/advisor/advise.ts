import type { TripComposerAnswers } from '../schemas/composer';
import { EXPERIENCE_LABELS, type CatalogDestination, type Experience } from './catalog/schema';
import { ADVISOR_INTEREST_LABELS, type FocusKey, type InterestKey } from './answers';
import { arrayWorld, type Destination, type DestinationWorld } from './destination';
import { profileFrom, type AdvisorProfile, type FactorId } from './profile';
import { GOOD_MONTH, compareScored, monthWord, scoreDestination, seasonModelFor, type AdvisorExclusion, type ScoredDestination } from './score';
import { overlap, selectShortlist, similarity } from './select';
import { durationVerdict, staysNeeded, type VacationFit } from './concept';
import { advisorKm } from './origin';
import { travellerSeason, type Activity } from '../atlas/seasonality';
import { ADVISOR_SHORTLIST_VERSION, type AdvisorPick, type AdvisorShortlist } from './shortlist-schema';

/**
 * THE ADVISOR, END TO END, WITHOUT A NETWORK.
 *
 * answers → profile → every catalog destination scored → hard constraints
 * applied → MMR shortlist → the words a traveller reads. No model, no provider,
 * no clock beyond `now`. The web layer adds one thing afterwards — a climate
 * check of the picks against twenty years of records — and says whether it
 * agreed.
 */

export const FACTOR_LABELS: Record<FactorId, string> = {
  experience: 'What you came for',
  season: 'Season',
  climate: 'Temperature',
  duration: 'Trip length',
  budget: 'Budget',
  adventure: 'Adventure level',
  reach: 'Getting there',
  getting_around: 'Getting around',
  crowds: 'Crowds',
  novelty: 'Classic or unusual',
  group: 'Your group',
  vacation: 'How the trip would feel',
  similar: 'Like the one you picked',
};

export interface Ranking {
  profile: AdvisorProfile;
  ranked: ScoredDestination[];
  excluded: ScoredDestination[];
  /** How many places the world holds, and how many the first pass handed to the detailed scorer. */
  worldSize: number;
  considered: number;
}

/** How many candidates the detailed scorer reads. Enough that the first pass never decides a shortlist; few enough to stay interactive. */
export const DETAILED_CANDIDATES = 900;

export type DestinationSource = readonly (CatalogDestination | Destination)[] | DestinationWorld;

function worldOf(source: DestinationSource): DestinationWorld {
  return Array.isArray(source) ? arrayWorld(source as readonly (CatalogDestination | Destination)[]) : (source as DestinationWorld);
}

/**
 * Two stages. The world narrows itself to the candidates worth reading closely
 * (a cheap pass over everything it holds: scope, what the place offers, the
 * words of the request, resemblance to a named place); then every candidate
 * gets the full factor-by-factor reading, hard constraints included. A plain
 * array is scored whole.
 */
export function rankCatalog(answers: TripComposerAnswers, source: DestinationSource, limit = DETAILED_CANDIDATES, include: readonly string[] = []): Ranking {
  const world = worldOf(source);
  const profile = profileFrom(answers);
  const target = profile.similarTo ? world.byId(profile.similarTo) : null;
  const withinTargets = profile.within ? profile.within.map((id) => world.byId(id)).filter((entry): entry is Destination => entry !== null) : null;
  const outsideTargets = profile.outside.map((id) => world.byId(id)).filter((entry): entry is Destination => entry !== null);
  /* A named place is a scope or a comparison, never the answer: it and whatever contains it are left out. */
  const notAnswers = new Set<string>();
  if (target) notAnswers.add(target.id);
  for (const scope of withinTargets ?? []) {
    notAnswers.add(scope.id);
    for (const parent of scope.parents) notAnswers.add(parent);
  }
  const candidates = world.candidates({
    wants: profile.wants,
    regions: profile.regions,
    countries: profile.countries,
    within: withinTargets && withinTargets.length > 0 ? withinTargets.map((entry) => entry.id) : null,
    similarTo: target?.id ?? null,
    terms: profile.terms,
    named: profile.named,
    ...(profile.phrase ? { phrase: profile.phrase } : {}),
    months: profile.months,
    excluded: profile.excluded,
    limit,
    include,
  });
  const ranked: ScoredDestination[] = [];
  const excluded: ScoredDestination[] = [];
  const scopedCountries = profile.countries && profile.countries.length <= 3 ? new Set(profile.countries) : null;
  for (const destination of candidates) {
    if (notAnswers.has(destination.id)) continue;
    /* "Islands in the Philippines" is not answered with "the Philippines". */
    if (scopedCountries && destination.kind === 'country' && destination.countries.every((code) => scopedCountries.has(code))) continue;
    const scored = scoreDestination(destination, profile, { similarTarget: target, withinTargets, outsideTargets });
    (scored.exclusion ? excluded : ranked).push(scored);
  }
  ranked.sort(compareScored);
  return { profile, ranked: withoutBroadStandIns(ranked, profile), excluded, worldSize: world.size, considered: candidates.length };
}

/** A country wider than this (as a radius) is more than one trip covers; below it — Costa Rica, Sri Lanka, Jamaica — the country is the trip. */
export const TRIP_SIZED_KM = 150;
/** A derived region wider than this is an area on a map, not somewhere to spend a week. */
const VAST_KM = 300;
/**
 * How far below its whole a part may score and still be the better answer. Wide
 * on purpose: a country's reading is the sum of everything inside it, so it
 * nearly always outscores any one of its regions — and is still the less useful
 * thing to be told.
 */
const PART_MARGIN = 0.2;
/** When the traveller asked for a trip that spans a country, a part has to all but match it. */
const SPANNING_MARGIN = 0.04;

/**
 * THE MOST SPECIFIC PLACE THAT CARRIES THE TRIP.
 *
 * "Italy" is true and useless when Sicily scores as well: somebody still has to
 * decide where in Italy. A whole country, or a derived region too wide to be
 * one trip, stands down whenever one of its own parts answers the request
 * about as well. It stays when nothing inside it comes close — and it is held
 * to a narrower margin when the traveller asked for the kind of trip that
 * spans a country (a long road trip, a rail journey), because then the whole
 * may honestly be the destination.
 */
function withoutBroadStandIns(ranked: readonly ScoredDestination[], profile: AdvisorProfile): ScoredDestination[] {
  const nights = profile.nights?.max ?? 0;
  const spanning = ((profile.focus.includes('road_trips') || profile.focus.includes('rail')) && nights >= 10) || nights >= 18;
  const margin = spanning ? SPANNING_MARGIN : PART_MARGIN;
  const byCountry = new Map<string, ScoredDestination[]>();
  for (const entry of ranked) {
    const { destination } = entry;
    if (destination.kind === 'country' || destination.countries.length !== 1) continue;
    const list = byCountry.get(destination.countries[0]!);
    if (list) list.push(entry);
    else byCountry.set(destination.countries[0]!, [entry]);
  }
  const stoodDown = new Set<string>();
  for (const entry of ranked) {
    const { destination } = entry;
    const country = destination.kind === 'country' && destination.countries.length === 1 && destination.radiusKm > TRIP_SIZED_KM;
    const vast = destination.kind !== 'country' && destination.origin !== 'editorial' && destination.radiusKm > VAST_KM;
    if (!country && !vast) continue;
    const parts = country ? (byCountry.get(destination.countries[0]!) ?? []) : ranked.filter((other) => other.destination.parents.includes(destination.id));
    /* `ranked` is in score order, so the first part is the best one. */
    /* A country with a do-not-travel area inside it is no answer when somebody could be sent to exactly that area by following it. */
    const warnedInParts = country && (destination.advisory?.parts?.some((part) => part.level >= 4) ?? false);
    const best = parts.find((other) => other.destination.radiusKm < destination.radiusKm && !stoodDown.has(other.destination.id));
    if (warnedInParts || (best && best.score >= entry.score - margin)) stoodDown.add(destination.id);
  }
  return stoodDown.size === 0 ? [...ranked] : ranked.filter((entry) => !stoodDown.has(entry.destination.id));
}

/** Contiguous month runs as words: [6,7,8] → "June–August". Wraps across December. */
export function monthsLabel(months: readonly number[]): string {
  if (months.length === 0) return 'Timing to confirm';
  if (months.length === 12) return 'Any time of year';
  const set = new Set(months);
  const runs: [number, number][] = [];
  const start = [...set].find((month) => !set.has(((month + 10) % 12) + 1)) ?? Math.min(...set);
  let current: [number, number] | null = null;
  for (let step = 0; step < 12; step += 1) {
    const month = ((start - 1 + step) % 12) + 1;
    if (set.has(month)) {
      if (current) current[1] = month;
      else current = [month, month];
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  if (current) runs.push(current);
  return runs.map(([a, b]) => (a === b ? monthWord(a) : `${monthWord(a)}–${monthWord(b)}`)).join(', ');
}

const FOCUS_WORDS: Record<FocusKey, RegExp> = {
  mountains: /mountain|peak|ridge|summit|trek|alp|pass|glacier|massif|range|hut/i,
  hiking: /hike|hiking|trail|walk|trek|ridge|path|way\b/i,
  wildlife: /wildlife|bear|whale|bird|elephant|gorilla|chimp|lion|leopard|safari|puffin|seal|turtle|orangutan|moose|wolf|dolphin|penguin|game|animal|shark|manta|lemur|jaguar|condor/i,
  lakes: /lake|loch|tarn|lagoon|river|fjord/i,
  beaches: /beach|swim|snorkel|reef|cove|bay|island|coast|dive|sea|sand/i,
  rainforest: /rainforest|jungle|cloud forest|canopy/i,
  road_trips: /drive|road|highway|route|loop/i,
  desert: /desert|dune|canyon|oasis|sand/i,
  volcanoes: /volcan|crater|geyser|hot spring|lava|thermal/i,
  snow: /ski|snow|aurora|northern lights|husky|winter/i,
  culture_food: /village|town|food|market|monaster|temple|wine|culture|church|castle|old town|cuisine|tea/i,
  cities: /city|old town|museum|market|food|bar|neighbourhood|district/i,
  rail: /rail|train|railway|line|station|funicular|tram/i,
};

/** Highlights chosen for this traveller: the ones that speak to their interests first, in their order. */
function relevantHighlights(destination: Destination, focus: readonly FocusKey[]): string[] {
  const scored = destination.highlights.map((highlight, index) => {
    let score = 0;
    focus.forEach((key, rank) => {
      if (FOCUS_WORDS[key].test(highlight)) score += 10 - rank;
    });
    return { highlight, score, index };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((entry) => entry.highlight);
}

const level = (value: number): number => Math.min(3, Math.max(0, Math.round(value)));

function characterOf(destination: Destination): string {
  const effort = ['Gentle days', 'Easy-to-moderate days out', 'Big days on foot', 'Expedition-grade'][level(destination.challenge.typical)]!;
  const remote = ['well served', 'some quiet corners', 'remote', 'very remote'][level(destination.remoteness)]!;
  const easier =
    destination.challenge.easiest < destination.challenge.typical ? `; gentler versions exist` : '';
  return `${effort}, ${remote}${easier}`;
}

const COST_LABELS = ['', 'Easy on the budget', 'Moderate costs', 'Pricey on the ground', 'Expensive'];

function nightsFor(destination: Destination, profile: AdvisorProfile): AdvisorPick['nights'] {
  const { min, ideal, max } = destination.nights;
  if (!profile.nights) return { suggested: ideal, min, max };
  const suggested = Math.min(Math.max(ideal, profile.nights.min), Math.max(min, profile.nights.max));
  /*
   * Never more than the place carries. Ten nights used to be suggested for a
   * region whose own range topped out at six; the rest of the time belongs to a
   * pairing (`lengthFor`), not to more days of the same.
   */
  return { suggested: Math.min(suggested, max), min, max };
}

/**
 * The trip is longer than this place deserves: say so, and name the best
 * nearby place to spend the rest on — same country, a different kind of place
 * (not overlapping ground), close enough to pair (great-circle, never a drive
 * time), and good for the traveller in its own right.
 */
function lengthFor(scored: ScoredDestination, profile: AdvisorProfile, pool: readonly ScoredDestination[]): AdvisorPick['length'] {
  const nights = profile.nights?.max ?? null;
  const d = scored.destination;
  const verdict = durationVerdict(d, nights);
  if (!verdict.overlong || nights === null) return null;
  const rest = nights - verdict.best.max;
  const partner = pool
    .filter((other) => other.destination.id !== d.id && !other.exclusion)
    .filter((other) => other.destination.countries.some((code) => d.countries.includes(code)))
    .filter((other) => overlap(other.destination, d) < 0.2 && !other.destination.parents.includes(d.id) && !d.parents.includes(other.destination.id))
    .filter((other) => other.destination.kind !== 'country' && other.destination.nights.min <= Math.max(2, rest))
    .map((other) => ({ other, km: Math.round(advisorKm(d.center, other.destination.center)) }))
    .filter(({ km }) => km >= 40 && km <= 700)
    .sort((a, b) => b.other.score - a.other.score)[0];
  const range = verdict.best.min === verdict.best.max ? `${verdict.best.max} nights` : `${verdict.best.min}–${verdict.best.max} nights`;
  const note = partner
    ? `Best for ${range}. With ${nights}, spend the rest in ${partner.other.destination.name} (about ${roundKm(partner.km)} km away).`
    : `Best for ${range}. With ${nights}, consider pairing it with another region.`;
  return { note, best: verdict.best, pairWith: partner ? { id: partner.other.destination.id, name: partner.other.destination.name, km: partner.km } : null };
}

function roundKm(km: number): number {
  return km < 100 ? Math.round(km / 10) * 10 : Math.round(km / 50) * 50;
}

function interestLabel(key: InterestKey): string {
  return ADVISOR_INTEREST_LABELS[key].toLowerCase();
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function whyFor(scored: ScoredDestination, profile: AdvisorProfile, windowLabel: string, feel: VacationFit | null): string {
  const strong = scored.interestFit.filter((fit) => fit.value >= 0.6).map((fit) => interestLabel(fit.key));
  const weak = scored.interestFit.filter((fit) => fit.value < 0.4).map((fit) => interestLabel(fit.key));
  const signature = Object.entries(scored.destination.experiences)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 2)
    .map(([experience]) => EXPERIENCE_LABELS[experience as Experience].toLowerCase());
  /*
   * Led by what this place is — its own signature and what carries the kind of
   * trip asked for — so six cards do not open with the same "Strong on …".
   */
  let sentence: string;
  if (feel && feel.carries.length > 0) {
    /* What carries the kind of trip, then how the trip would run: the verdict itself is the card's own line (`feel.basis`). */
    sentence = `${capitalise(joinWords(feel.carries.slice(0, 3)))}; ${logisticsOf(scored.destination)}`;
  } else if (strong.length > 0) {
    sentence = `${capitalise(joinWords(signature))}; strong on ${joinWords(strong)}`;
  } else {
    sentence = `Best for ${joinWords(signature)}`;
  }
  const season = scored.factors.find((factor) => factor.id === 'season');
  if (profile.months && season?.measure.kind === 'measured' && season.measure.value < 0.8) {
    sentence += `, though only partly in season ${windowLabel === 'Any time of year' ? '' : `in ${windowLabel}`}`.trimEnd();
  }
  if (weak.length > 0 && (strong.length > 0 || feel)) sentence += `; lighter on ${joinWords(weak)}`;
  return `${sentence}.`;
}

/** How the trip would run, in words: where to sleep and whether a car is needed. */
function logisticsOf(d: Destination): string {
  const needed = staysNeeded(d);
  const names = d.bases.slice(0, 2);
  const stays =
    names.length === 0
      ? needed === 1 ? 'one base' : `${needed} places to stay`
      : needed === 1
        ? names.length > 1 ? `one base in ${names[0]} or ${names[1]}` : `one base in ${names[0]}`
        : `split between ${joinWords(d.bases.slice(0, Math.min(needed, 3)))}`;
  const car = d.access.car === 'essential' ? 'you will want a car' : d.access.car === 'helpful' ? 'easier with a car' : d.access.car === 'unnecessary' ? 'no car needed' : null;
  return car ? `${stays}, ${car}` : stays;
}

function capitalise(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

function tradeoffsFor(scored: ScoredDestination, profile: AdvisorProfile): string[] {
  /*
   * A disqualifying conflict with the trip asked for comes first, then what
   * else works against the kind of trip: the trade-offs the traveller most
   * needs to see. Both are read from the scored record, so the card says what
   * ranked the place, never a second opinion of it.
   */
  const out: string[] = scored.conflicts.map((conflict) => conflict.sentence);
  for (const line of scored.feel?.against ?? []) if (out.length < 2 && !out.includes(line)) out.push(line);
  for (const factor of scored.factors) {
    if (factor.measure.kind !== 'measured' || factor.measure.value >= 0.6) continue;
    switch (factor.id) {
      case 'budget':
        out.push(`Costs run above your budget: ${factor.measure.basis}.`);
        break;
      case 'reach':
        out.push(profile.origin ? `A long way to go: ${factor.measure.basis}.` : 'Takes several connections to reach.');
        break;
      case 'season':
        out.push(`Only partly in season for your dates (${factor.measure.basis}).`);
        break;
      case 'crowds':
        out.push('Busy at its peak, which you said you would rather avoid.');
        break;
      case 'getting_around':
        if (!scored.conflicts.some((conflict) => conflict.code === 'needs_a_car')) out.push('Much easier with a car.');
        break;
      case 'adventure':
        out.push(`${factor.measure.basis[0]!.toUpperCase()}${factor.measure.basis.slice(1)}.`);
        break;
      case 'climate':
        out.push(`Temperatures may not suit you: ${factor.measure.basis}.`);
        break;
      default:
        break;
    }
  }
  for (const line of scored.destination.tradeoffs) if (out.length < 3) out.push(line);
  return out.slice(0, 3);
}

/** A room range in words, always with what it rests on, never as a current price. */
function roomsLine(d: Destination): string | null {
  const evidence = d.costEvidence;
  if (!evidence) return null;
  const [low, high] = evidence.roomUsd;
  const when = evidence.years ? (evidence.years[0] === evidence.years[1] ? `${evidence.years[0]}` : `${evidence.years[0]}–${evidence.years[1]}`) : null;
  const source = evidence.basis === 'historical_observation' && when ? `from travel-guide listings dated ${when}` : when ? `our estimate, using a few guide listings from ${when}` : 'our estimate from nearby guide listings';
  return `A double room has run roughly $${low}–$${high} a night (${source}; not a current price).`;
}

function unverifiedFor(scored: ScoredDestination, profile: AdvisorProfile): string[] {
  const out: string[] = [];
  const d = scored.destination;
  /* An advisory short of "do not travel" is the traveller's call, and they should make it knowingly. */
  if (d.advisory && d.advisory.level === 3) out.push(`${d.advisory.source} advises reconsidering travel to ${d.advisory.area ?? 'this country'} (as of ${d.advisory.asOf}). Read the current advisory before you commit.`);
  /* A warning for part of a country that could not be placed is said out loud. Nothing here says this place is outside it. */
  if (d.advisory?.parts?.length && !d.advisory.area) out.push(`${d.advisory.parts.map((part) => part.source).join(' and ')} ${d.advisory.parts.length > 1 ? 'warn' : 'warns'} against travel to parts of this country. Check whether that covers where you would go.`);
  if (d.origin !== 'editorial') out.push('What it offers is read from open travel guides and map data, not checked by an editor.');
  if (!profile.origin) out.push('How long it takes to get there from you — we don’t know where you’re starting.');
  if (profile.budget === null) out.push('Whether it fits your budget — you haven’t said one.');
  out.push('Prices, opening dates and permits for your exact dates.');
  for (const caution of d.cautions) if (out.length < 4) out.push(caution);
  return out.slice(0, 5);
}

const ACTIVITY_WORDS: Record<Activity, string> = {
  hike_low: 'Walking and day hikes',
  hike_high: 'The high trails',
  beach: 'Swimming',
  dive: 'Snorkelling and diving',
  ski: 'Skiing',
  winter: 'Snow on the ground',
  safari: 'Game viewing',
  wild: 'Wildlife and forest',
  city: 'Towns and culture',
  desert: 'The desert',
  drive: 'Driving',
  paddle: 'Lakes and paddling',
  sky: 'Night skies',
  scenery: 'Coast and scenery',
  any: 'A visit',
};

/**
 * When, by activity — the sentence a single "in season" badge cannot say.
 *
 * For the two activities that matter most to this traveller here, the months a
 * typical year makes them good, from the place's own normals: "The high
 * trails: usually July–September. Walking and day hikes: May–October." Always
 * "usually": it is a climate normal, and the card says where it came from.
 */
export function seasonNoteFor(scored: ScoredDestination, profile: AdvisorProfile): string | null {
  const destination = scored.destination;
  const model = seasonModelFor(destination);
  const { drivers } = travellerSeason(model, profile.wants, destination.experiences);
  const parts: string[] = [];
  for (const activity of drivers.slice(0, 2)) {
    if (activity === 'any') continue;
    const good = model.fit[activity].map((month, index) => (month.value >= GOOD_MONTH ? index + 1 : 0)).filter((month) => month > 0);
    if (good.length === 12) parts.push(`${ACTIVITY_WORDS[activity]}: good all year`);
    else if (good.length === 0) parts.push(`${ACTIVITY_WORDS[activity]}: no month is reliably good`);
    else parts.push(`${ACTIVITY_WORDS[activity]}: usually ${monthsLabel(good)}`);
  }
  if (parts.length === 0) return null;
  const source = destination.measured ? 'from 1981–2010 climate normals' : 'from our own reading of its climate';
  /* A climate normal is not a sighting or an opening date, and the card says which it is. */
  const caveat = drivers[0] === 'safari' || drivers[0] === 'wild' ? ' Wildlife timing here is a rule of thumb from rainfall, not sightings data.' : drivers[0] === 'ski' ? ' That is the snow; when the lifts run is up to the resort.' : '';
  return `${parts.join('. ')} (${source}).${caveat}`;
}

function differsBy(scored: ScoredDestination, earlier: readonly ScoredDestination[]): string | null {
  if (earlier.length === 0) return null;
  const closest = earlier.reduce((winner, candidate) => (similarity(scored, candidate) > similarity(scored, winner) ? candidate : winner), earlier[0]!);
  const mine = Object.entries(scored.destination.experiences) as [Experience, number][];
  const distinctive = mine
    .filter(([experience, value]) => value >= 2 && (closest.destination.experiences[experience] ?? 0) <= value - 2)
    .sort((a, b) => b[1] - a[1])
    .map(([experience]) => EXPERIENCE_LABELS[experience].toLowerCase())
    .slice(0, 2);
  const where = scored.destination.worldRegion !== closest.destination.worldRegion ? ` in a different part of the world` : '';
  if (distinctive.length > 0) return `Unlike ${closest.destination.name}: ${joinWords(distinctive)}${where}.`;
  if (where) return `A similar trip to ${closest.destination.name}${where}.`;
  const harder = scored.destination.challenge.typical - closest.destination.challenge.typical;
  if (harder !== 0) return `${harder > 0 ? 'Wilder' : 'Gentler'} than ${closest.destination.name}.`;
  return null;
}

function matchOf(scored: ScoredDestination): AdvisorPick['match'] {
  if (scored.score >= 0.8 && scored.coverage >= 0.55) return 'strong';
  if (scored.score >= 0.68) return 'good';
  return 'possible';
}

function gettingThere(scored: ScoredDestination, profile: AdvisorProfile): string {
  const d = scored.destination;
  const nearest = d.airports[0];
  /* Derived records state what was measured — the nearest scheduled airport and how far — rather than a count of connections nobody counted. */
  if (d.origin !== 'editorial' && nearest) {
    const hub = d.airports.find((airport) => airport.size === 'large');
    const first = `Nearest airport with scheduled flights: ${nearest.name} (${nearest.iata}), about ${Math.round(nearest.km / 10) * 10 || 10} km away`;
    const second = hub && hub.iata !== nearest.iata ? `; nearest major hub ${hub.name} (${hub.iata}), about ${Math.round(hub.km / 10) * 10} km` : '';
    const far = scored.distanceKm !== null && profile.origin ? ` · about ${(Math.round(scored.distanceKm / 100) * 100).toLocaleString('en-US')} km from ${profile.origin.label}` : '';
    return `${first}${second}${far}.`;
  }
  const airports = d.access.airports.join(', ');
  const hops = ['Direct flights from major hubs', 'One connection from most hubs', 'A connection plus a regional flight or long transfer', 'Several connections or a long overland leg'][level(d.access.reach)]!;
  const distance = scored.distanceKm !== null && profile.origin ? ` · about ${(Math.round(scored.distanceKm / 100) * 100).toLocaleString('en-US')} km from ${profile.origin.label}` : '';
  return `${hops}${airports ? ` (${airports})` : ''}${distance}.`;
}

export function pickFrom(scored: ScoredDestination, profile: AdvisorProfile, role: AdvisorPick['role'], earlier: readonly ScoredDestination[], pool: readonly ScoredDestination[] = []): AdvisorPick {
  const d = scored.destination;
  const feel = scored.feel;
  const monthValue = (month: number) => scored.seasonMonths[month - 1]?.value ?? 0;
  const peak = Math.max(0, ...scored.bestMonths.map(monthValue));
  const windowMonths = scored.bestMonths.filter((month) => monthValue(month) >= (peak >= 0.85 ? 0.85 : GOOD_MONTH)).sort((a, b) => a - b);
  /* No good month inside the window: say so, rather than "timing to confirm". */
  const windowLabel = windowMonths.length > 0 || scored.bestMonths.length > 0 ? monthsLabel(windowMonths.length > 0 ? windowMonths : scored.bestMonths) : profile.months ? `Not at its best in ${monthsLabel(profile.months)}` : 'Timing to confirm';
  const versusBudget =
    profile.budget === null ? null : d.cost - profile.budget <= 0.25 ? 'Within what you said' : d.cost - profile.budget <= 1.25 ? 'A stretch on what you said' : 'Well above what you said';
  const costLevel = Math.min(4, Math.max(1, Math.round(d.cost)));
  return {
    id: d.id,
    name: d.name,
    context: d.context,
    kind: d.kind,
    worldRegion: d.worldRegion,
    countries: [...d.countries],
    center: d.center,
    radiusKm: d.radiusKm,
    resolveAs: d.resolveAs,
    ...(d.wikidataId ? { wikidataId: d.wikidataId } : {}),
    role,
    score: Math.round(scored.score * 1000) / 1000,
    coverage: Math.round(scored.coverage * 100) / 100,
    match: matchOf(scored),
    pitch: d.pitch,
    why: whyFor(scored, profile, windowLabel, feel),
    experiences: relevantHighlights(d, profile.focus),
    strongFor: scored.interestFit.filter((fit) => fit.value >= 0.6).map((fit) => ADVISOR_INTEREST_LABELS[fit.key]),
    window: { months: windowMonths.length > 0 ? windowMonths : scored.bestMonths, label: windowLabel },
    nights: nightsFor(d, profile),
    character: characterOf(d),
    gettingThere: gettingThere(scored, profile),
    gettingAround: d.access.note,
    cost: { level: costLevel, label: `${COST_LABELS[costLevel]!}${d.basis.cost !== 'estimated' ? '' : d.costEvidence ? ' (estimated)' : ' (estimated from national price levels)'}`, versusBudget, rooms: roomsLine(d) },
    bases: [...d.bases],
    tradeoffs: tradeoffsFor(scored, profile),
    unverified: unverifiedFor(scored, profile),
    differsBy: role === 'primary' || earlier.length > 0 ? differsBy(scored, earlier) : null,
    distanceKm: scored.distanceKm,
    climate: { status: 'not_checked', note: 'Weather not yet checked against records.' },
    factors: scored.factors.map((factor) => ({
      id: factor.id,
      label: FACTOR_LABELS[factor.id],
      weight: Math.round(factor.weight * 1000) / 1000,
      value: factor.measure.kind === 'measured' ? Math.round(factor.measure.value * 100) / 100 : null,
      basis: factor.measure.kind === 'measured' ? factor.measure.basis : `Not asked yet: ${factor.measure.question.toLowerCase()}`,
    })),
    references: [...d.evidence.references],
    signature: null,
    basis: d.origin === 'editorial' ? 'editorial' : d.origin === 'research' ? 'research' : 'open_data',
    confidence: Math.round(d.confidence * 100) / 100,
    seasonNote: seasonNoteFor(scored, profile),
    length: lengthFor(scored, profile, pool),
    feel: feel ? { value: feel.value, basis: feel.basis, carries: feel.carries, against: feel.against } : null,
    measured: d.measured !== null,
    suggested: false,
  };
}

const PRESSURE_WORDS: Partial<Record<FactorId, string>> = {
  budget: 'your budget',
  season: 'the season',
  reach: 'the distance',
  adventure: 'the adventure level',
  getting_around: 'getting around without a car',
  crowds: 'avoiding crowds',
  climate: 'the temperature you want',
  duration: 'the trip length',
  group: 'your group’s needs',
};

/** Which factor most holds back the places that do serve the lead. */
function leadPressure(ranked: readonly ScoredDestination[], profile: AdvisorProfile): string | null {
  const serving = ranked.filter((candidate) => (candidate.interestFit[0]?.value ?? 0) >= 0.6).slice(0, 12);
  if (serving.length === 0) return null;
  const totals = new Map<FactorId, number>();
  for (const candidate of serving) {
    for (const factor of candidate.factors) {
      if (factor.measure.kind !== 'measured' || factor.id === 'experience') continue;
      totals.set(factor.id, (totals.get(factor.id) ?? 0) + factor.weight * (1 - factor.measure.value));
    }
  }
  const worst = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  void profile;
  return worst && worst[1] / serving.length > 0.02 ? PRESSURE_WORDS[worst[0]] ?? null : null;
}

const EXCLUSION_RELAXATION: Record<AdvisorExclusion['code'], string> = {
  outside_requested_area: 'widening the part of the world you asked for',
  out_of_season: 'moving your dates',
  too_far: 'flying a little further',
  too_short: 'adding a few nights',
  too_demanding: 'allowing a few harder days',
  mobility: 'looking at easier-access places',
  needs_a_car: 'being open to renting a car',
  over_budget: 'stretching the budget a little',
  traveller_avoided: 'reconsidering what you ruled out',
  set_aside: 'bringing back places you set aside',
  nothing_you_asked_for: 'broadening what you want to do',
  advisory: 'checking the current travel advisories yourself',
  home: 'looking a little further from home',
};

function driversOf(profile: AdvisorProfile, picks: readonly ScoredDestination[]): string[] {
  const out: string[] = [];
  if (profile.focus.length > 0) {
    const lead = profile.interests.length > 1 && profile.interests[0]!.weight > profile.interests[1]!.weight ? `, ${interestLabel(profile.focus[0]!)} first` : '';
    out.push(`What you want to do: ${joinWords(profile.focus.map(interestLabel))}${lead}`);
  }
  if (profile.months) out.push(`Being in season in ${monthsLabel(profile.months)}`);
  const measuredIds = new Set<FactorId>();
  for (const pick of picks) for (const factor of pick.factors) if (factor.measure.kind === 'measured') measuredIds.add(factor.id);
  if (measuredIds.has('adventure') && profile.adventure !== null) out.push(`Adventure: ${['comfortable', 'active', 'rugged', 'expedition-style'][profile.adventure]}`);
  if (measuredIds.has('budget') && profile.budget !== null) out.push(`Budget: ${['', 'budget-conscious', 'moderate', 'comfortable', 'luxury'][profile.budget]}`);
  if (profile.nights) out.push(`Trip length: ${profile.nights.min === profile.nights.max ? profile.nights.min : `${profile.nights.min}–${profile.nights.max}`} nights`);
  if (profile.origin && measuredIds.has('reach')) out.push(`Distance from ${profile.origin.label}`);
  if (profile.avoidCrowds) out.push('Avoiding crowds');
  if (profile.novelty === 'unusual') out.push('Somewhere less well known');
  if (profile.novelty === 'familiar') out.push('Proven classics');
  if (profile.car === 'no_car') out.push('No car needed');
  if (profile.kids) out.push('Travelling with children');
  if (profile.limitedMobility) out.push('Limited mobility');
  return out;
}

function openQuestionsOf(profile: AdvisorProfile): string[] {
  const out: string[] = [];
  if (!profile.months) out.push('When you can go');
  if (profile.adventure === null) out.push('How adventurous you want it');
  if (profile.budget === null) out.push('Your budget');
  if (!profile.origin) out.push('Where you’re starting from');
  if (!profile.nights) out.push('How long you have');
  return out;
}

/**
 * Each pick's signature: the experiences it is best at among what the traveller
 * wants, preferring ones the other picks are not also best at — so three picks
 * read as "glaciers and bears", "lakes and old towns", "whales and crater
 * lakes" rather than "hiking, hiking, hiking".
 */
function signaturesOf(picks: readonly ScoredDestination[], profile: AdvisorProfile): string[] {
  const wanted = (Object.entries(profile.wants) as [Experience, number][]).filter(([, weight]) => weight > 0).map(([experience]) => experience);
  const pool = wanted.length > 0 ? wanted : (Object.keys(EXPERIENCE_LABELS) as Experience[]);
  const leadSet = new Set<Experience>(profile.leadStated && profile.interests[0] ? (Object.keys(profile.interests[0].mapping) as Experience[]) : []);
  return picks.map((scored, index) => {
    const others = picks.filter((_, other) => other !== index);
    const ranked = pool
      .map((experience) => {
        const mine = scored.destination.experiences[experience] ?? 0;
        const theirs = Math.max(0, ...others.map((other) => other.destination.experiences[experience] ?? 0));
        return { experience, mine, edge: mine - theirs };
      })
      .filter((entry) => entry.mine >= 2)
      /* What the trip must be brilliant at comes first, then what sets this one apart. */
      .sort((a, b) => Number(leadSet.has(b.experience)) - Number(leadSet.has(a.experience)) || b.edge - a.edge || b.mine - a.mine || pool.indexOf(a.experience) - pool.indexOf(b.experience));
    return joinWords(ranked.slice(0, 2).map((entry) => EXPERIENCE_LABELS[entry.experience].toLowerCase()));
  });
}

function spreadOf(picks: readonly AdvisorPick[], profile: AdvisorProfile): string | null {
  if (picks.length < 2) return null;
  const narrowed = profile.regions !== null || profile.countries !== null || profile.within !== null;
  const lines = picks.map((pick) => (pick.signature ? `${pick.name} for ${pick.signature}` : pick.name));
  const regions = new Set(picks.map((pick) => pick.worldRegion)).size;
  if (narrowed) return `All in the part of the world you asked for: ${lines.join('; ')}.`;
  if (regions === picks.length) return `${picks.length === 3 ? 'Three' : 'Two'} different answers — ${lines.join('; ')}.`;
  return `${lines.join('; ')}.`;
}

export interface BuildInput {
  answers: TripComposerAnswers;
  catalog: DestinationSource;
  catalogVersion: string;
  now: Date;
  previous?: AdvisorShortlist | null;
  assumptions?: readonly string[];
  /**
   * Destination ids a research model proposed for this request. They are read
   * closely alongside the world's own candidates and ranked by the same scorer;
   * a pick that came from here says so on its card.
   */
  research?: { ids: readonly string[]; proposed: number; note: string } | null;
}

export function buildAdvisorShortlist(input: BuildInput): AdvisorShortlist {
  const started = Date.now();
  const proposed = new Set(input.research?.ids ?? []);
  const { profile, ranked, excluded, worldSize, considered } = rankCatalog(input.answers, input.catalog, DETAILED_CANDIDATES, [...proposed]);
  const selection = selectShortlist(ranked, profile);
  const earlier: ScoredDestination[] = [];
  const signatures = signaturesOf(selection.picks, profile);
  const picks = selection.picks.map((scored, index) => {
    const pick = { ...pickFrom(scored, profile, 'primary', earlier, ranked), signature: signatures[index] || null, suggested: proposed.has(scored.destination.id) };
    earlier.push(scored);
    return pick;
  });
  const alternateSignatures = signaturesOf([...selection.picks, ...selection.alternates], profile).slice(selection.picks.length);
  const alternates = selection.alternates.map((scored, index) => ({ ...pickFrom(scored, profile, 'alternate', selection.picks, ranked), signature: alternateSignatures[index] || null, suggested: proposed.has(scored.destination.id) }));

  const excludedCounts: Record<string, number> = {};
  for (const entry of excluded) excludedCounts[entry.exclusion!.code] = (excludedCounts[entry.exclusion!.code] ?? 0) + 1;

  let relaxation: string | null = null;
  if (selection.leadShort > 0 && profile.interests[0]) {
    const served = picks.length - selection.leadShort;
    const lead = interestLabel(profile.interests[0].key);
    const pressing = leadPressure(ranked, profile);
    relaxation = `Only ${served === 0 ? 'no place' : served === 1 ? 'one place' : `${served} places`} fit ${lead} with everything else you said${pressing ? ` — ${pressing} rules most of the rest out` : ''}. The ${selection.leadShort === 1 ? 'other pick is' : 'other picks are'} strong on your other interests instead.`;
  }
  if (selection.stretched) {
    const pressing = leadPressure(ranked, profile) ?? (profile.months ? 'the season' : null);
    relaxation = `Nothing fits everything you asked well${pressing ? ` — ${pressing} holds every option back` : ''}. These are the closest; treat them as a starting point, not a recommendation.`;
  } else if (picks.length < 3) {
    const worst = Object.entries(excludedCounts)
      .filter(([code]) => code !== 'set_aside')
      .sort((a, b) => b[1] - a[1])[0];
    relaxation = worst
      ? `Only ${picks.length === 0 ? 'nothing' : picks.length === 1 ? 'one place' : 'two places'} fit everything you asked. The constraint that ruled out most (${worst[1]} places) was ${worst[0].replace(/_/g, ' ')} — try ${EXCLUSION_RELAXATION[worst[0] as AdvisorExclusion['code']]}.`
      : null;
  }

  const assumptions = [...(input.answers.discovery?.assumptions ?? []), ...(input.assumptions ?? [])];
  if (input.answers.dates.mode === 'season' && input.answers.dates.season && !profile.origin && !assumptions.some((line) => line.includes(input.answers.dates.season!))) {
    assumptions.push(`We read “${input.answers.dates.season}” as ${monthsLabel(profile.months ?? [])}, the northern-hemisphere ${input.answers.dates.season}.`);
  }

  const previousIds = input.previous ? input.previous.picks.map((pick) => pick.id) : [];
  const changes: string[] = [];
  if (input.previous) {
    /*
     * Each change with its reason, read from the new scoring of the same world:
     * a place that arrived says what now fits, a place that left says what
     * ruled it out or held it back. The whole world is re-read on every answer,
     * so new places can appear that were never on the earlier list.
     */
    const reasonIn = (pick: AdvisorPick) => (pick.feel && pick.feel.value >= 0.75 ? pick.feel.basis : pick.why.replace(/\.$/, '').toLowerCase());
    const added = picks.filter((pick) => !previousIds.includes(pick.id));
    const kept = picks.filter((pick) => previousIds.includes(pick.id)).map((pick) => pick.name);
    for (const pick of added.slice(0, 3)) changes.push(`New: ${pick.name} — ${reasonIn(pick)}.`);
    const nowIds = new Set([...picks, ...alternates].map((pick) => pick.id));
    for (const old of input.previous.picks.filter((pick) => !nowIds.has(pick.id)).slice(0, 3)) {
      const out = excluded.find((entry) => entry.destination.id === old.id);
      const still = ranked.find((entry) => entry.destination.id === old.id);
      const weakest = still?.factors
        .filter((factor) => factor.measure.kind === 'measured')
        .sort((a, b) => a.weight * (1 - (a.measure as { value: number }).value) - b.weight * (1 - (b.measure as { value: number }).value))
        .pop();
      const why = out?.exclusion?.message.replace(/\.$/, '') ?? (weakest && weakest.measure.kind === 'measured' ? `${FACTOR_LABELS[weakest.id].toLowerCase()}: ${weakest.measure.basis}` : 'others now fit better');
      changes.push(`Dropped: ${old.name} — ${why}.`);
    }
    if (kept.length > 0) changes.push(`Still here: ${joinWords(kept)}.`);
    if (added.length === 0) changes.push('Nothing better fits that change — the list held.');
  }

  return {
    kind: 'advisor',
    version: ADVISOR_SHORTLIST_VERSION,
    catalogVersion: input.catalogVersion,
    builtAt: input.now.toISOString(),
    elapsedMs: Date.now() - started,
    picks,
    alternates,
    readout: {
      drivers: driversOf(profile, selection.picks),
      assumptions: [...new Set(assumptions)],
      openQuestions: openQuestionsOf(profile),
      spread: spreadOf(picks, profile),
      relaxation,
      closeCalls: selection.closeCalls.map((scored) => scored.destination.name),
    },
    stats: {
      catalog: worldSize,
      considered,
      eligible: ranked.length,
      excluded: excludedCounts,
      lambda: selection.lambda,
      climateChecked: 0,
      climateVerified: 0,
      research: input.research
        ? {
            proposed: input.research.proposed,
            resolved: proposed.size,
            shown: [...selection.picks, ...selection.alternates].filter((scored) => proposed.has(scored.destination.id)).length,
            note: input.research.note,
          }
        : null,
    },
    changes,
    previousIds,
  };
}

/**
 * The dates a chosen destination becomes a trip with, when the traveller gave
 * a season or a window rather than dates.
 *
 * The month is the destination's best month *inside the traveller's window*
 * (never outside it), in its next occurrence from today; the nights are the
 * suggestion already on the card. `dates.mode` is preserved by the caller, so
 * nothing downstream presents the midpoint as a decision the traveller made.
 */
export function adoptionWindow(answers: TripComposerAnswers, pick: AdvisorPick, now: Date): { month: number; year: number; nights: number } {
  const profile = profileFrom(answers);
  const inWindow = profile.months ? pick.window.months.filter((month) => profile.months!.includes(month)) : pick.window.months;
  const month = inWindow[0] ?? pick.window.months[0] ?? profile.months?.[0] ?? ((now.getUTCMonth() + 2) % 12) + 1;
  const currentMonth = now.getUTCMonth() + 1;
  const year = month <= currentMonth ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const nights = answers.duration.mode === 'fixed' && answers.duration.nights ? answers.duration.nights : pick.nights.suggested;
  return { month, year, nights };
}
