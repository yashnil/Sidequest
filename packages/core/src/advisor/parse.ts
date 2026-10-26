import type { TripComposerAnswers } from '../schemas/composer';
import { emptyAdvisorAnswers, FOCUS_LABELS, type AdvisorAnswers, type FocusKey } from './answers';
import type { WorldRegion } from './catalog/schema';
import { originPointFromText } from './origin';
import { REGION_GROUPS, REGION_GROUP_LABELS, type QuestionId } from './questions';
import { monthsLabel } from './advise';
import { seasonMonthsForTraveller } from './profile';

/**
 * READING WHAT SOMEBODY TYPED BEFORE ASKING THEM ANYTHING.
 *
 * "Find me somewhere outdoors for the summer. I love hiking, wildlife,
 * mountains, lakes, coast and swimming. I'm flexible on duration." already
 * answers when, what for and how long. Asking those again is the first thing a
 * bad advisor does.
 *
 * Deterministic: a phrase table, no model. It reads only what is plainly said
 * and never upgrades vague words into specific facts — "outdoors" alone sets no
 * interest, because it does not say which outdoors, and that is exactly the
 * question worth asking. Every reading comes back as a labelled chip so the
 * traveller can see, and correct, what was understood.
 */

export interface Reading {
  kind: 'when' | 'length' | 'focus' | 'budget' | 'party' | 'adventure' | 'reach' | 'region' | 'origin' | 'transport' | 'crowds' | 'novelty' | 'climate';
  label: string;
}

export interface ParsedRequest {
  answers: TripComposerAnswers;
  readings: Reading[];
  assumptions: string[];
  /** Phrases recognised as too vague to act on, so the interview knows what to ask. */
  vague: string[];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const FOCUS_PATTERNS: [RegExp, FocusKey[]][] = [
  [/\b(hik(e|es|ing)|walk(s|ing)? in the hills|trails?)\b/, ['hiking']],
  [/\b(trek(s|king)?|hut[- ]to[- ]hut|thru[- ]hike)\b/, ['mountains', 'hiking']],
  [/\b(mountains?|alpine|alps|high country|peaks?|highlands)\b/, ['mountains']],
  [/\b(wildlife|animals?|safari|game drives?|birds?|birding|bears?|whales?|puffins?|gorillas?)\b/, ['wildlife']],
  [/\blakes?\b/, ['lakes']],
  [/\b(beach(es)?|coast(al|line)?|seaside|island(s)?|snorkel(ling|ing)?|div(e|ing)|reefs?|sea\b|ocean)\b/, ['beaches']],
  [/\b(rain ?forest|jungle|cloud forest|tropical forest)\b/, ['rainforest']],
  [/\b(road ?trip|scenic drives?|driving holiday)\b/, ['road_trips']],
  [/\b(desert|dunes?|canyons?)\b/, ['desert']],
  [/\b(volcano(es)?|volcanic|hot springs?|geothermal|geysers?)\b/, ['volcanoes']],
  [/\b(ski(ing)?|snow(board)?|northern lights|aurora)\b/, ['snow']],
  [/\b(food|eat(ing)?|cuisine|culture|history|museums?|villages?|architecture|wine)\b/, ['culture_food']],
  [/\b(city|cities|urban|nightlife)\b/, ['cities']],
];

const REGION_PATTERNS: [RegExp, WorldRegion[], string][] = [
  [/\b(southeast|south[- ]east) asia\b/, ['southeast_asia'], 'Southeast Asia'],

  [/\bmediterranean\b/, ['southern_europe', 'north_africa', 'middle_east'], 'The Mediterranean'],
  [/\bcaribbean\b/, ['caribbean'], 'The Caribbean'],
  [/\bcentral america\b/, ['mexico_central_america'], 'Central America'],
  [/\bsouth america\b/, ['south_america_north', 'south_america_south'], 'South America'],
  [/\b(north america|usa|the us|the states|canada)\b/, ['north_america_west', 'north_america_east', 'north_america_north'], 'North America'],
  [/\b(the )?americas\b/, REGION_GROUPS.americas!, REGION_GROUP_LABELS.americas!],
  [/\b(europe|european)\b/, REGION_GROUPS.europe!, REGION_GROUP_LABELS.europe!],
  [/\b(asia|asian)\b/, REGION_GROUPS.asia!, REGION_GROUP_LABELS.asia!],
  [/\b(africa|african)\b/, REGION_GROUPS.africa!, REGION_GROUP_LABELS.africa!],
  [/\b(australia|new zealand|oceania|pacific islands)\b/, REGION_GROUPS.oceania!, REGION_GROUP_LABELS.oceania!],
];

export const COUNTRY_GROUPS: [RegExp, string[], string][] = [
  [/\b(the )?balkans\b/, ['SI', 'HR', 'BA', 'RS', 'ME', 'MK', 'AL', 'XK', 'BG', 'GR', 'RO'], 'The Balkans'],
  [/\bscandinavia(n)?\b/, ['NO', 'SE', 'DK'], 'Scandinavia'],
  [/\b(nordic|nordics)\b/, ['NO', 'SE', 'DK', 'FI', 'IS', 'FO'], 'The Nordics'],
  [/\bpatagonia\b/, ['AR', 'CL'], 'Patagonia'],
];

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, couple: 2, few: 3 };

function numberOf(word: string): number | null {
  const n = Number(word);
  if (Number.isFinite(n) && n > 0) return n;
  return WORD_NUMBERS[word] ?? null;
}

function discoveryOf(answers: TripComposerAnswers): AdvisorAnswers {
  return answers.discovery ?? emptyAdvisorAnswers();
}

export function parseTravelRequest(text: string, base: TripComposerAnswers): ParsedRequest {
  const raw = text.slice(0, 600);
  const t = ` ${raw.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'\-\s]/g, ' ').replace(/\s+/g, ' ')} `;
  let answers: TripComposerAnswers = { ...base, discovery: { ...discoveryOf(base), request: raw.trim() || undefined } };
  const readings: Reading[] = [];
  const assumptions: string[] = [];
  const vague: string[] = [];
  const asked = new Set<QuestionId>(discoveryOf(base).asked as QuestionId[]);
  const patchDiscovery = (patch: Partial<AdvisorAnswers>) => {
    answers = { ...answers, discovery: { ...discoveryOf(answers), ...patch } };
  };

  // ---- origin (read first: it decides what "summer" means) -----------------
  const from = /\b(?:from|based in|live in|living in|flying out of|leaving from)\s+([a-z][a-z\s]{1,30}?)(?=\s(?:and|for|in|to|i|we|with|on|this|next)\b|\s*$)/.exec(t);
  if (from) {
    const point = originPointFromText(from[1]!.trim());
    if (point) {
      answers = { ...answers, origin: point.label, ...(point.countryCode ? { originCountry: point.countryCode } : {}) };
      readings.push({ kind: 'origin', label: `From ${point.label}` });
    }
  }
  const origin = originPointFromText(answers.origin, answers.originCountry);

  // ---- when ------------------------------------------------------------------
  const monthHits = MONTHS.map((name, index) => (new RegExp(`\\b(${name}|${MONTH_SHORT[index]})\\b`).test(t) ? index + 1 : 0)).filter(Boolean);
  const seasonHit = /\b(summer|winter|spring|autumn|fall)\b/.exec(t);
  if (monthHits.length === 1) {
    answers = { ...answers, dates: { mode: 'month', month: monthHits[0]!, wantsRecommendation: false } };
    readings.push({ kind: 'when', label: MONTHS[monthHits[0]! - 1]!.replace(/^./, (c) => c.toUpperCase()) });
  } else if (monthHits.length > 1) {
    answers = { ...answers, dates: { mode: 'months', months: monthHits, wantsRecommendation: false } };
    readings.push({ kind: 'when', label: monthsLabel(monthHits) });
  } else if (/\b(christmas|new year)\b/.test(t)) {
    answers = { ...answers, dates: { mode: 'months', months: [12, 1], wantsRecommendation: false } };
    readings.push({ kind: 'when', label: 'Late December – early January' });
  } else if (seasonHit) {
    const season = seasonHit[1] === 'fall' ? 'autumn' : (seasonHit[1] as 'summer' | 'winter' | 'spring' | 'autumn');
    answers = { ...answers, dates: { mode: 'season', season, wantsRecommendation: false } };
    const months = seasonMonthsForTraveller(season, origin);
    readings.push({ kind: 'when', label: `${season[0]!.toUpperCase()}${season.slice(1)} · ${monthsLabel(months)}` });
    if (!origin) assumptions.push(`We read “${seasonHit[1]}” as ${monthsLabel(months)}. If your ${seasonHit[1]} is in the southern hemisphere, tell us where you’re starting from.`);
  } else if (/\b(any ?time|whenever|flexible on (dates|timing|when))\b/.test(t)) {
    answers = { ...answers, dates: { mode: 'flexible', wantsRecommendation: true } };
    readings.push({ kind: 'when', label: 'Dates flexible' });
  }

  // ---- how long ---------------------------------------------------------------
  const span = /\b(\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|couple of|few)\s*(?:-|to)?\s*(\d{1,2})?\s*(days?|nights?|weeks?)\b/.exec(t);
  if (/\blong weekend\b|\bweekend\b/.test(t) && !span) {
    answers = { ...answers, duration: { mode: 'range', minNights: 2, maxNights: 3, wantsRecommendation: false } };
    readings.push({ kind: 'length', label: 'A weekend' });
  } else if (span) {
    const first = numberOf(span[1]!.replace(' of', '')) ?? 1;
    const second = span[2] ? Number(span[2]) : null;
    const unit = span[3]!.startsWith('week') ? 7 : 1;
    const toNights = (value: number) => (unit === 7 ? value * 7 : span[3]!.startsWith('day') ? Math.max(1, value - 1) : value);
    const min = toNights(first);
    const max = second ? toNights(second) : min;
    const clampN = (n: number) => Math.min(30, Math.max(1, n));
    answers = {
      ...answers,
      duration: min === max ? { mode: 'fixed', nights: clampN(min), wantsRecommendation: false } : { mode: 'range', minNights: clampN(min), maxNights: clampN(max), wantsRecommendation: false },
    };
    readings.push({ kind: 'length', label: min === max ? `${clampN(min)} nights` : `${clampN(min)}–${clampN(max)} nights` });
  } else if (/\bflexible (on|about) (duration|length|how long)|any length|duration is flexible|no fixed length\b/.test(t)) {
    answers = { ...answers, duration: { mode: 'unknown', wantsRecommendation: true } };
    readings.push({ kind: 'length', label: 'Length flexible' });
  }

  // ---- what for ---------------------------------------------------------------
  const focus: FocusKey[] = [...(discoveryOf(answers).focus ?? [])];
  for (const [pattern, keys] of FOCUS_PATTERNS) if (pattern.test(t)) for (const key of keys) if (!focus.includes(key)) focus.push(key);
  if (/\bswim(ming)?\b/.test(t) && !focus.includes('beaches') && !focus.includes('lakes')) focus.push('beaches');
  if (focus.length > 0) {
    patchDiscovery({ focus, focusRanked: focus.length === 1 });
    for (const key of focus) readings.push({ kind: 'focus', label: FOCUS_LABELS[key] });
  } else if (/\b(outdoors?|outside|nature)\b/.test(t)) {
    vague.push('outdoors');
  }
  if (/\bsafari\b/.test(t)) patchDiscovery({ wildlifeKind: 'safari' });
  else if (/\b(whales?|snorkel|reef|marine|dolphins?)\b/.test(t) && focus.includes('wildlife')) patchDiscovery({ wildlifeKind: 'marine' });
  if (/\b(hut[- ]to[- ]hut|multi[- ]day|thru[- ]hike)\b/.test(t)) patchDiscovery({ mountainStyle: 'hut_to_hut' });
  if (/\b(warm (sea|water)|tropical beach)/.test(t)) patchDiscovery({ swimStyle: 'warm_sea' });

  // ---- budget -----------------------------------------------------------------
  const budget = /\b(luxury|luxurious|five[- ]star)\b/.test(t)
    ? 'luxury'
    : /\b(splurge|comfortable budget|nice hotels|high[- ]end|premium)\b/.test(t)
      ? 'premium'
      : /\b(mid[- ]range|moderate budget|medium budget|moderately priced|reasonable budget)\b/.test(t)
        ? 'mid_range'
        : /\b(cheap|budget|shoestring|backpack(ing|er)?|affordable|inexpensive)\b/.test(t)
          ? 'budget'
          : null;
  if (budget) {
    answers = { ...answers, budget };
    readings.push({ kind: 'budget', label: { budget: 'Budget-conscious', mid_range: 'Moderate budget', premium: 'Comfortable budget', luxury: 'Luxury' }[budget] });
  }

  // ---- party --------------------------------------------------------------------
  const needs = new Set(answers.travelerNeeds);
  if (/\b(kids?|children|toddlers?|my son|my daughter|family with)\b/.test(t)) {
    answers = { ...answers, children: Math.max(1, answers.children) };
    needs.add('kids_under_12');
    readings.push({ kind: 'party', label: 'With children' });
  }
  if (/\b(parents|grandparents|elderly|older (relatives|travellers|travelers)|multi[- ]generation(al)?|grandma|grandpa)\b/.test(t)) {
    needs.add('seniors_in_group');
    readings.push({ kind: 'party', label: 'Older travellers' });
  }
  if (/\b(wheelchair|limited mobility|mobility issues|can'?t walk far|bad knees|walking aid)\b/.test(t)) {
    needs.add('mobility_limited');
    readings.push({ kind: 'party', label: 'Limited mobility' });
  }
  answers = { ...answers, travelerNeeds: [...needs] };
  if (/\b(solo|by myself|alone)\b/.test(t)) {
    answers = { ...answers, adults: 1 };
    readings.push({ kind: 'party', label: 'Solo' });
  }

  // ---- adventure ----------------------------------------------------------------
  const adventure = /\b(expedition|technical|mountaineering|base camp|high altitude)\b/.test(t)
    ? 'expedition'
    : /\b(rugged|remote|wild|off[- ]grid|challenging|strenuous|hardcore)\b/.test(t)
      ? 'rugged'
      : /\b(easy|relaxed|relaxing|gentle|not too (strenuous|hard|intense)|accessible)\b/.test(t)
        ? 'comfortable'
        : /\b(active|moderately active)\b/.test(t)
          ? 'active'
          : null;
  if (adventure) {
    patchDiscovery({ adventure });
    answers = { ...answers, outdoorIntensity: adventure === 'comfortable' ? 'gentle' : adventure === 'active' ? 'moderate' : 'strenuous' };
    readings.push({ kind: 'adventure', label: { comfortable: 'Comfortable', active: 'Active', rugged: 'Rugged', expedition: 'Expedition-style' }[adventure] });
  }

  // ---- where in the world --------------------------------------------------------
  if (/\b(anywhere( in the world)?|worldwide|wherever|any country|don'?t mind where)\b/.test(t)) {
    answers = { ...answers, flightTolerance: 'any' };
    asked.add('region');
    readings.push({ kind: 'reach', label: 'Anywhere in the world' });
  } else if (/\b(close to home|nearby|not too far|short flight|within driving distance)\b/.test(t)) {
    answers = { ...answers, flightTolerance: 'short' };
    readings.push({ kind: 'reach', label: 'Close to home' });
  }
  if (/\b(domestic|in my own country|in the country)\b/.test(t)) {
    answers = { ...answers, tripScope: 'domestic' };
    readings.push({ kind: 'reach', label: 'Stay in my country' });
  }
  const regions: WorldRegion[] = [];
  const spans: [number, number][] = [];
  /* Named areas that are sets of countries, not world regions. */
  for (const [pattern, countries, label] of COUNTRY_GROUPS) {
    const match = pattern.exec(t);
    if (!match) continue;
    spans.push([match.index, match.index + match[0].length]);
    patchDiscovery({ countries: [...new Set([...(discoveryOf(answers).countries ?? []), ...countries])] });
    asked.add('region');
    readings.push({ kind: 'region', label });
  }
  for (const [pattern, list, label] of REGION_PATTERNS) {
    /* "from the US" names an origin, not a destination. */
    const match = pattern.exec(t);
    if (!match) continue;
    const before = t.slice(Math.max(0, match.index - 12), match.index);
    if (/\b(from|live in|based in)\s*$/.test(before)) continue;
    /* "Southeast Asia" already matched: the "Asia" inside it is not a second, wider region. */
    const end = match.index + match[0].length;
    if (spans.some(([a, b]) => match.index < b && end > a)) continue;
    spans.push([match.index, end]);
    if (regions.length > 0 && list.every((region) => regions.includes(region))) continue;
    regions.push(...list.filter((region) => !regions.includes(region)));
    readings.push({ kind: 'region', label });
  }
  if (regions.length > 0) {
    patchDiscovery({ regions });
    asked.add('region');
  }

  // ---- transport, crowds, novelty, climate -------------------------------------
  if (/\b(no car|without a car|don'?t (want to )?drive|can'?t drive|public transport|by train|trains)\b/.test(t)) {
    answers = { ...answers, transport: 'public_transport' };
    readings.push({ kind: 'transport', label: 'No car' });
  } else if (/\b(road ?trip|rent a car|happy to drive|driving|campervan|camper van)\b/.test(t)) {
    answers = { ...answers, transport: 'drive' };
    readings.push({ kind: 'transport', label: 'Happy to drive' });
  }
  if (/\b(avoid (the )?crowds|not crowded|uncrowded|quiet|no crowds|fewer tourists|not touristy|away from tourists)\b/.test(t)) {
    answers = { ...answers, crowdTolerance: 'avoid' };
    readings.push({ kind: 'crowds', label: 'Away from crowds' });
  }
  if (/\b(hidden gems?|off the beaten (path|track)|unusual|lesser[- ]known|surprise me|somewhere different)\b/.test(t)) {
    answers = { ...answers, surpriseAppetite: 'surprise_me' };
    readings.push({ kind: 'novelty', label: 'Somewhere unexpected' });
  } else if (/\b(classic|classics|iconic|famous|must[- ]see|first time|bucket list)\b/.test(t)) {
    answers = { ...answers, surpriseAppetite: 'familiar' };
    readings.push({ kind: 'novelty', label: 'The classics' });
  }
  if (/\b(not too hot|avoid (the )?heat|avoid extreme heat|escape the heat|cooler|cool weather|no heat)\b/.test(t)) {
    answers = { ...answers, climatePreference: 'mild' };
    readings.push({ kind: 'climate', label: 'Not too hot' });
  } else if (/\b(warm|hot(?! springs?)|sunny|sunshine|tropical|escape the (cold|winter))\b/.test(t)) {
    answers = { ...answers, climatePreference: 'warm' };
    readings.push({ kind: 'climate', label: 'Warm' });
  } else if (/\b(cold|snowy|crisp)\b/.test(t) && !/\bnot (too )?cold\b/.test(t)) {
    answers = { ...answers, climatePreference: 'cold' };
    readings.push({ kind: 'climate', label: 'Cool' });
  }

  patchDiscovery({ asked: [...asked], assumptions: [...new Set([...(discoveryOf(answers).assumptions ?? []), ...assumptions])].slice(0, 12) });
  return { answers, readings, assumptions, vague };
}
