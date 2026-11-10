import type { TripComposerAnswers } from '../schemas/composer';
import { emptyAdvisorAnswers, FOCUS_LABELS, MOOD_LABELS, PURSUIT_LABELS, type AdvisorAnswers, type FocusKey, type MoodKey, type PursuitKey } from './answers';
import { WORLD_REGIONS, type WorldRegion } from './catalog/schema';
import { originPointFromText } from './origin';
import { REGION_GROUPS, REGION_GROUP_LABELS, type QuestionId } from './questions';
import { monthsLabel } from './advise';
import { seasonMonthsForTraveller } from './profile';
import type { PlaceMention } from '../atlas/atlas';
import { atlasTokens } from '../atlas/lexical';

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
  [/\b(hik(e|es|ing|ers?)|walk(s|ing)? in the hills|hill ?walk(s|ing)?|walking (holiday|trip|vacation)s?|trails?|scrambl(e|es|ing))\b/, ['hiking']],
  /* A trek is a mountain walk unless it says otherwise: a jungle trek, a gorilla trek or a camel trek is a walk through something else. */
  [/\b(?<!(jungle|rainforest|forest|gorilla|chimp|chimpanzee|orangutan|desert|camel|village|elephant)\s)(trek(s|king)?|hut[- ]to[- ]hut|thru[- ]hike)\b/, ['mountains', 'hiking']],
  [/\b(jungle|rainforest|forest|gorilla|chimp|chimpanzee|orangutan|desert|camel|village|elephant)\s(trek(s|king)?)\b/, ['hiking']],
  [/\b(glaciers?|icebergs?|ice ?(fields?|caps?)|summits?|mountaineering|base camp)\b/, ['mountains']],
  [/\b(mountains?|alpine|alps|high country|peaks?|highlands)\b/, ['mountains']],
  [/\b(wildlife|animals?|safari|game drives?|birds?|birding|bears?|whales?|puffins?|gorillas?|penguins?|orangutans?|big cats?|elephants?|lions?|tigers?|leopards?|monkeys?|sloths?|turtles?|dolphins?|seals?)\b/, ['wildlife']],
  [/\blakes?\b/, ['lakes']],
  [/\b(beach(es)?|coast(al|line)?|seaside|island(s)?|snorkel(ling|ing)?|div(e|ing)|reefs?|sea\b|ocean)\b/, ['beaches']],
  [/\b(rain ?forest|jungle|cloud forest|tropical forest)\b/, ['rainforest']],
  [/\b(road ?trips?|scenic driv(e|es|ing)|driving (holiday|loop|route|tour)s?|self[- ]drive|empty highways?|open road)\b/, ['road_trips']],
  [/\b(desert|dunes?|canyons?)\b/, ['desert']],
  [/\b(volcano(es)?|volcanic|geothermal(?! (bath|pool|lagoon|spa))|geysers?|lava|craters?|calderas?)\b/, ['volcanoes']],
  [/\b(ski(s|ing|ers?)?|snow(y|fall|board(s|ing|ers?)?|shoe(s|ing)?)?|northern lights|aurora|winter sports?|winter wonderland|white christmas|reindeer|husk(y|ies)|dog ?sledd?ing)\b/, ['snow']],
  [/\b(food|eat(ing)?|cuisine|culture|cultural|history|historic(al)?|museums?|villages?|architecture|wine|old towns?|temples?|ruins|archaeolog\w+|castles?|medinas?|monaster(y|ies)|palaces?|colonial|heritage|markets?|medieval|shrines?)\b/, ['culture_food']],
  [/\b(rail (journey|trip|holiday|adventure|tour)s?|train (journey|trip|ride|travel|tour)s?|scenic (trains?|railways?)|interrail(ing)?|eurail|sleeper trains?|railways?|by sleeper)\b/, ['rail']],
  [/\b(city|cities|urban|nightlife)\b/, ['cities']],
];

/** One precise thing a request can name that no broad focus says ("hot springs" is not "volcanoes"). */
const PURSUIT_PATTERNS: [RegExp, PursuitKey][] = [
  [/\b(stargaz\w+|star[- ]gaz\w+|dark sk(y|ies)|night sk(y|ies)|milky way|astro(nomy|photography|tourism)|meteor showers?|see the stars|starry (sk(y|ies)|nights?)|sleep(ing)? under the stars)\b/, 'stargazing'],
  [/\b(hot springs?|onsens?|thermal (baths?|springs?|pools?|spas?|waters?)|geothermal (baths?|pools?|lagoons?|spas?)|hot pools?|natural hot tubs?)\b/, 'hot_springs'],
  [/\b(spas?|wellness|yoga|retreats?|detox|pamper\w*|massages?)\b/, 'wellness'],
  [/\b(kayak\w*|canoe\w*|paddl\w+|(white[- ]?water )?raft(ing)?|sail(ing)?|boat(ing| trips?| tours?)|packraft\w*|houseboats?)\b/, 'paddling'],
];
const FOOD_WORDS = /\b(food|foodie|eat(ing)?|cuisine|culinary|gastronom\w+|street food|restaurants?|wine|wineries|vineyards?|tapas|seafood|cooking|coffee|breweries|craft beer|whisky|tastings?)\b/;
const CULTURE_WORDS = /\b(culture|cultural|history|historic(al)?|museums?|villages?|architecture|old towns?|temples?|ruins|archaeolog\w+|castles?|medinas?|monaster(y|ies)|palaces?|colonial|heritage|medieval|shrines?|galleries|art)\b/;

/**
 * What a request says when it names no activity. Read as a leaning, shown back
 * as an assumption, and dropped the moment the traveller says something
 * specific. The phrases are the ordinary ways people describe a trip they have
 * not decided on.
 */
const MOOD_PATTERNS: [RegExp, MoodKey][] = [
  [/\b(beautiful|scenery|scenic|stunning|picturesque|breath ?taking|gorgeous|spectacular|dramatic|views?|landscapes?|pretty|nature|natural beauty|outdoors?|photogenic|photograph\w+)\b/, 'scenic'],
  [/\b(relax(ing|ed|ation)?|unwind(ing)?|chill(ed)?|laid[- ]back|restful|rest|peaceful|tranquil|recharge|switch off|slow(er)? pace|do nothing|low[- ]key|calm|lazy|take it easy|easy[- ]going|easygoing|leisurely)\b/, 'relaxing'],
  [/\b(adventur(e|es|ous)|thrill(s|ing)?|adrenaline|exciting|excitement|active|explor(e|ing)|outdoorsy)\b/, 'adventurous'],
  [/\b(with (my |our |some |a few |the )?(friends|mates|buddies|pals|lads|girls|guys)|group of friends|friends'? trip|girls'? trip|guys'? trip|bachelor(ette)?|stag|hen (do|party)|party|nightlife|lively|fun)\b/, 'social'],
  [/\b(unforgettable|memorable|once[- ]in[- ]a[- ]lifetime|trip of a lifetime|bucket[- ]list|epic|special|blow (my|our) minds?|wow|extraordinary|life[- ]changing|incredible|amazing)\b/, 'memorable'],
  [/\b(romantic|romance|honeymoon|anniversary|proposal|couples? (trip|getaway|retreat))\b/, 'romantic'],
];

const REGION_PATTERNS: [RegExp, WorldRegion[], string][] = [
  [/\b(southeast|south[- ]east) asia\b/, ['southeast_asia'], 'Southeast Asia'],

  [/\bmediterranean\b/, ['southern_europe', 'north_africa', 'middle_east'], 'The Mediterranean'],
  [/\bcaribbean\b/, ['caribbean'], 'The Caribbean'],
  [/\bcentral america(n)?\b/, ['mexico_central_america'], 'Central America'],
  [/\bsouth america(n)?\b/, ['south_america_north', 'south_america_south'], 'South America'],
  [/\blatin america(n)?\b/, ['south_america_north', 'south_america_south', 'mexico_central_america'], 'Latin America'],
  [/\b(north america(n)?|usa|the us|the states|canada)\b/, ['north_america_west', 'north_america_east', 'north_america_north'], 'North America'],
  [/\bnorth africa(n)?\b/, ['north_africa'], 'North Africa'],
  [/\b(east africa(n)?)\b/, ['east_africa'], 'East Africa'],
  [/\b(southern africa(n)?)\b/, ['southern_africa'], 'Southern Africa'],
  [/\b(middle east(ern)?)\b/, ['middle_east'], 'The Middle East'],
  [/\b(central asia(n)?)\b/, ['caucasus_central_asia'], 'Central Asia'],
  [/\b(south asia(n)?)\b/, ['south_asia'], 'South Asia'],
  [/\b(east asia(n)?)\b/, ['east_asia'], 'East Asia'],
  [/\b(eastern europe(an)?)\b/, ['central_eastern_europe'], 'Eastern Europe'],
  [/\b(south pacific|pacific islands?)\b/, ['pacific_islands'], 'The Pacific Islands'],
  [/\b(indian ocean)\b/, ['indian_ocean', 'south_asia', 'east_africa'], 'The Indian Ocean'],
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

/*
 * NEGATION. "Hiking but no snow" asks for hiking and against snow; reading
 * every keyword as a wish turned that sentence into a ski trip. A word is
 * negated when its own clause (commas, full stops and "but" end a clause)
 * puts a negator right before it, allowing a few filler words: "no snow",
 * "don't want to drive", "anything but beaches", "avoid snow and ice".
 * "Don't mind snow" is consent, not refusal.
 */
const NEGATOR = "(?:no|not|non|without|avoid(?:ing)?|don't|dont|do not|doesn't|didn't|never|hate|dislike|rather not|nothing|zero|skip(?:ping)?|anything but|except|aren't|isn't|can't|cannot|won't|no more|less)";
const FILLER = "(?:want|wanna|wanting|like|need|enjoy|love|care for|fancy|any|too|much|many|to|really|the|a|an|of|more|heavy|deep|go|do|be|in|into|for|big|real|serious|long|lots of|interested in|keen on|and|or|crazy|massive|extreme)";
const NEGATION_TAIL = new RegExp(`\\b${NEGATOR}(?:\\s+${FILLER})*\\s*$`);
const CONSENT_TAIL = /\b(?:don't|dont|do not|wouldn't|would not) mind(?:\s+\w+){0,2}\s*$/;

/** The text of the clause that ends at `index`. */
function clauseBefore(t: string, index: number): string {
  const head = t.slice(0, index);
  const clause = head.slice(head.lastIndexOf('|') + 1);
  /* "but" opens a new clause: "no car but happy hiking" negates nothing after it. */
  const butAt = clause.lastIndexOf(' but ');
  return butAt >= 0 && !/\banything but\s*$/.test(clause) ? clause.slice(butAt + 5) : clause;
}

function isNegated(t: string, index: number): boolean {
  const clause = clauseBefore(t, index);
  return NEGATION_TAIL.test(clause) && !CONSENT_TAIL.test(clause);
}

/** Every occurrence of `pattern` in `t`, split into wished-for and refused. */
function occurrences(pattern: RegExp, t: string): { positive: number; negative: number } {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let positive = 0;
  let negative = 0;
  for (let match = global.exec(t); match; match = global.exec(t)) {
    /* "Don't mind snow" tolerates it: neither a wish nor a refusal. */
    if (CONSENT_TAIL.test(clauseBefore(t, match.index))) continue;
    if (isNegated(t, match.index)) negative += 1;
    else positive += 1;
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return { positive, negative };
}

function saysYes(pattern: RegExp, t: string): boolean {
  return occurrences(pattern, t).positive > 0;
}

const CURRENCY: Record<string, string> = { $: '$', usd: '$', dollar: '$', dollars: '$', bucks: '$', '€': '€', eur: '€', euro: '€', euros: '€', '£': '£', gbp: '£', pound: '£', pounds: '£', quid: '£' };
const BAND_WORDS = { budget: 'budget-conscious', mid_range: 'a moderate budget', premium: 'a comfortable budget', luxury: 'luxury' } as const;

/**
 * "Under $1,500 for a week", "€100 a day". An amount is only money when a
 * currency says so (a bare number is a year, a party or a length). Read per
 * night — the trip's own nights, or a week when the length is open — and
 * banded; the reading is returned as an assumption the traveller can correct.
 */
export function moneyBudget(raw: string, answers: Pick<TripComposerAnswers, 'duration'>): { band: 'budget' | 'mid_range' | 'premium' | 'luxury'; label: string; assumption: string } | null {
  const text = raw.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const match = /([$€£])\s?(\d+(?:\.\d+)?)\s*(k)?\b|\b(\d+(?:\.\d+)?)\s*(k)?\s*(usd|dollars?|bucks|eur|euros?|gbp|pounds?|quid)\b/.exec(text);
  if (!match) return null;
  const amount = Number(match[2] ?? match[4]) * (match[3] ?? match[5] ? 1000 : 1);
  if (!Number.isFinite(amount) || amount < 20) return null;
  const symbol = CURRENCY[match[1] ?? match[6]!] ?? '$';
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
  const perNight = /^\s*(?:a|per|\/|each|every)\s*(?:day|night)\b/.test(after);
  const duration = answers.duration;
  const nights = duration.mode === 'fixed' && duration.nights ? duration.nights : duration.mode === 'range' && duration.maxNights ? duration.maxNights : 7;
  const nightly = perNight ? amount : amount / nights;
  const band = nightly <= 120 ? 'budget' : nightly <= 250 ? 'mid_range' : nightly <= 500 ? 'premium' : 'luxury';
  const shown = `${symbol}${amount.toLocaleString('en-US')}`;
  return {
    band,
    label: `About ${symbol}${Math.round(nightly)} a night`,
    assumption: perNight
      ? `We read ${shown} a day, excluding flights, as ${BAND_WORDS[band]}.`
      : `We read ${shown} over ${nights} nights as about ${symbol}${Math.round(nightly)} a night excluding flights — ${BAND_WORDS[band]}.`,
  };
}

function discoveryOf(answers: TripComposerAnswers): AdvisorAnswers {
  return answers.discovery ?? emptyAdvisorAnswers();
}

const MONTH_WORD = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const DAY_WORD = '(\\d{1,2})(?:st|nd|rd|th)?';
const RANGE_JOIN = '\\s*(?:-|–|—|to|until|through|thru|till)\\s*';

function monthIndex(word: string): number {
  const key = word.slice(0, 3);
  return MONTH_SHORT.indexOf(key) + 1;
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * "March 19-27", "19–27 March", "Mar 30 to Apr 4", "19th of March until the
 * 27th". A range of calendar days already answers both *when* and *how long*,
 * so it must never be read as a bare month (which is what left "how long" to be
 * asked). The year is the range's next occurrence from `now`; nights are the
 * difference between the two days.
 */
export function parseDateRange(text: string, now: Date): { startDate: string; endDate: string; nights: number } | null {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "'").replace(/,/g, ' ').replace(/\s+/g, ' ')} `;
  const of = '(?:\\s+of)?';
  const the = '(?:the\\s+)?';
  const between = '(?:between\\s+)';
  const and = '\\s+(?:and|&)\\s+';
  const patterns: [RegExp, (m: RegExpExecArray) => [number, number, number, number]][] = [
    // between the 3rd and the 14th of June / between June 3 and 14 / between June 3 and July 2
    [new RegExp(`\\b${between}${the}${DAY_WORD}${and}${the}${DAY_WORD}${of}\\s+${MONTH_WORD}\\b`), (m) => [monthIndex(m[3]!), Number(m[1]), monthIndex(m[3]!), Number(m[2])]],
    [new RegExp(`\\b${between}${MONTH_WORD}\\s+${DAY_WORD}${and}${MONTH_WORD}\\s+${DAY_WORD}\\b`), (m) => [monthIndex(m[1]!), Number(m[2]), monthIndex(m[3]!), Number(m[4])]],
    [new RegExp(`\\b${between}${MONTH_WORD}\\s+${DAY_WORD}${and}${the}${DAY_WORD}\\b`), (m) => [monthIndex(m[1]!), Number(m[2]), monthIndex(m[1]!), Number(m[3])]],
    /*
     * 3/19 - 3/27 or 19/3 – 27/3. Read only when a day above twelve says which
     * number is the month; 3/4 – 3/9 is left for the "when" question rather than guessed.
     */
    [/\b(\d{1,2})\/(\d{1,2})\s*(?:-|–|—|to|until|through|thru|till)\s*(\d{1,2})\/(\d{1,2})\b/, (m) => {
      const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      if ((b > 12 || d > 12) && a <= 12 && c <= 12) return [a, b, c, d];
      if ((a > 12 || c > 12) && b <= 12 && d <= 12) return [b, a, d, c];
      return [0, 0, 0, 0];
    }],
    // March 19 - April 2 / Mar 19 to Mar 27
    [new RegExp(`\\b${MONTH_WORD}\\s+${DAY_WORD}${RANGE_JOIN}${MONTH_WORD}\\s+${DAY_WORD}\\b`), (m) => [monthIndex(m[1]!), Number(m[2]), monthIndex(m[3]!), Number(m[4])]],
    // 19 March - 2 April / 19th of March to the 2nd of April
    [new RegExp(`\\b${the}${DAY_WORD}${of}\\s+${MONTH_WORD}${RANGE_JOIN}${the}${DAY_WORD}${of}\\s+${MONTH_WORD}\\b`), (m) => [monthIndex(m[2]!), Number(m[1]), monthIndex(m[4]!), Number(m[3])]],
    // March 19-27 / March 19th to the 27th
    [new RegExp(`\\b${MONTH_WORD}\\s+${DAY_WORD}${RANGE_JOIN}${the}${DAY_WORD}\\b(?!\\s*(?:days?|nights?|weeks?|people|persons|travell?ers|adults|of us))`), (m) => [monthIndex(m[1]!), Number(m[2]), monthIndex(m[1]!), Number(m[3])]],
    // 19-27 March / 19th to 27th of March
    [new RegExp(`\\b${the}${DAY_WORD}${RANGE_JOIN}${the}${DAY_WORD}${of}\\s+${MONTH_WORD}\\b`), (m) => [monthIndex(m[3]!), Number(m[1]), monthIndex(m[3]!), Number(m[2])]],
    // 19th of March until the 27th
    [new RegExp(`\\b${the}${DAY_WORD}${of}\\s+${MONTH_WORD}${RANGE_JOIN}${the}${DAY_WORD}\\b(?!\\s*(?:days?|nights?|weeks?|of))`), (m) => [monthIndex(m[2]!), Number(m[1]), monthIndex(m[2]!), Number(m[3])]],
  ];
  for (const [pattern, read] of patterns) {
    const match = pattern.exec(t);
    if (!match) continue;
    const [startMonth, startDay, endMonth, endDay] = read(match);
    if (!startMonth || !endMonth) continue;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let year = now.getUTCFullYear();
    const startThisYear = Date.UTC(year, startMonth - 1, startDay);
    if (startThisYear < today) year += 1;
    const endYear = endMonth < startMonth ? year + 1 : year;
    const startDate = isoDate(year, startMonth, startDay);
    const endDate = isoDate(endYear, endMonth, endDay);
    if (!startDate || !endDate) continue;
    const nights = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000);
    if (nights < 1 || nights > 30) continue;
    return { startDate, endDate, nights };
  }
  return null;
}

function rangeLabel(startDate: string, endDate: string): string {
  const fmt = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]!.replace(/^./, (c) => c.toUpperCase())} ${Number(iso.slice(8, 10))}`;
  const sameMonth = startDate.slice(0, 7) === endDate.slice(0, 7);
  return sameMonth ? `${fmt(startDate)}–${Number(endDate.slice(8, 10))}` : `${fmt(startDate)} – ${fmt(endDate)}`;
}

/** Something that can say which places a sentence names — the atlas, in production. */
export interface RequestPlaces {
  findPlaces(text: string): PlaceMention[];
}

/**
 * Words that say nothing about a place: how the request is phrased, who is
 * going, what it costs, when. What is left after these, the month names and the
 * interest vocabulary are the request's own words — "tea plantations", "karst",
 * "fishing villages" — and those are looked for in the travel guides.
 */
const REQUEST_FILLER = new Set(
  'want wanna wanting looking look find finding somewhere anywhere someplace trip trips travel travelling traveling holiday holidays vacation vacations break getaway escape week weeks weekend weekends night nights month months day days people friend friends family families kid kids child children toddler teenager teenagers parent parents couple solo honeymoon budget cheap cheaper expensive inexpensive affordable money cost costs price flight flights flying fly drive driving car rent rental train trains happy fine okay basic love like enjoy prefer need plus maybe possible possibly really quite bit lot lots something anything everything thing things stuff good better great amazing beautiful incredible stunning spectacular nice cool fun interesting lovely pretty gorgeous dramatic less more fewer crowded crowd crowds touristy tourist tourists quiet quieter busy remote underrated hidden gem gems famous popular known unknown season weather warm hot cold cool sunny mild january february march april may june july august september october november december summer winter spring autumn fall early late mid year years time first next last far near close short long world place places destination destinations country region area stay staying hotel hotels lodge lodges guesthouse guesthouses hostel hostels resort resorts moderate comfortable luxury luxurious easy hard fit adventurous adventure adventures experience experiences sensible realistic worth still enough without with also rather instead other another usual type kind style big small little lively relaxed relaxing few many old new possible ideally prefer preferably mostly mainly including include especially particularly along away around about trying try tried done been seen visit visited visiting see seeing going go get getting take taking day-trips daytrips option options idea ideas recommend recommendation suggestions suggest help choose decide where when what which who how why this that these those there here from into onto over under between during after before again only just even ever never always often sometimes already yet soon now thanks thank please hello cheers regards sorry help then than too very much such both either neither each every all any some most least own same different similar alternative alternatives version equivalent unusual class world-class level minimum maximum total per person adults adult aged ages age using use used via within outside inside across through throughout north south east west northern southern eastern western central one two three four five six seven eight nine ten eleven twelve fourteen couple half quarter whole entire lively atmospheric cosy cozy reliable proper real true wild truly completely totally fully mostly partly kind sort mix mixed variety various several nothing anyone everyone someone nobody happy glad keen able unable unforgettable memorable lifetime epic special extraordinary incredible wow relax unwind unwinding chill chilled restful rest peaceful tranquil recharge calm lazy leisurely scenery scenic picturesque breathtaking photogenic romantic romance anniversary proposal birthday graduation celebrate celebrating celebration retirement retired mates buddies pals lads girls guys bachelor bachelorette stag hen party wheelchair wheelchairs user users accessible accessibility disabled disability mobility pregnant elderly senior seniors grandparents grandma grandpa mum mom dad wife husband partner girlfriend boyfriend baby babies toddlers teen teens stroller pushchair difficult difficulty strenuous demanding challenging tough exciting excitement thrill thrilling adrenaline active explore exploring exploration outdoorsy memories focused focus centred centered themed weekender difficult works work suit suits suitable'.split(
    /\s+/,
  ),
);

/**
 * The interest words too broad to look up: every guide to a mountain says
 * "mountain". The *specific* words that also name an interest — "gorilla",
 * "penguin", "temple", "loch" — are kept, because a traveller who asked for
 * gorillas did not ask for wildlife in general.
 */
const GENERIC_INTEREST_WORDS = new Set(
  'hike hikes hiking hiker hikers walk walks walking trail trails trek treks trekking mountain mountains alpine peak peaks wildlife animal animals bird birds birding lake lakes beach beaches coast coastal coastline seaside island islands sea ocean snorkel snorkelling snorkeling dive diving rainforest jungle forest roadtrip drive drives driving desert volcano volcanoes volcanic ski skiing snow snowboard snowboarding food eat eating cuisine culture cultural history historic historical city cities urban village villages swim swimming outdoors outdoor nature scenery scenic view views landscape landscapes sport sports activity activities sight sights sightseeing town towns'.split(
    /\s+/,
  ),
);

/**
 * The request's own words: what is left when place names, filler and the
 * interest vocabulary are taken away. `terms` are folded for the lexical index;
 * `phrase` is the same words as written, in order, for retrieval by meaning.
 */
export function requestWords(raw: string, mentions: readonly PlaceMention[]): { terms: string[]; phrase: string } {
  let text = raw;
  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) text = `${text.slice(0, mention.start)} ${text.slice(mention.end)}`;
  const terms: string[] = [];
  const words: string[] = [];
  const lowered = text.toLowerCase();
  const clauses = ` ${lowered.replace(/[’']/g, "'").replace(/[,.;:!?()]+/g, ' | ')} `;
  for (const match of lowered.matchAll(/[\p{L}]+/gu)) {
    const word = match[0];
    if (word.length < 3 || REQUEST_FILLER.has(word) || GENERIC_INTEREST_WORDS.has(word)) continue;
    const term = atlasTokens(word)[0];
    if (!term || REQUEST_FILLER.has(term) || GENERIC_INTEREST_WORDS.has(term) || terms.includes(term)) continue;
    /* A word the traveller refused ("no long hikes") is not something to look for. */
    const at = clauses.indexOf(` ${word}`);
    if (at >= 0 && isNegated(clauses, at + 1)) continue;
    terms.push(term);
    words.push(word);
  }
  return { terms: terms.slice(0, 8), phrase: words.slice(0, 8).join(' ') };
}

export function requestTerms(raw: string, mentions: readonly PlaceMention[]): string[] {
  return requestWords(raw, mentions).terms;
}

export function parseTravelRequest(text: string, base: TripComposerAnswers, now: Date = new Date(), places?: RequestPlaces): ParsedRequest {
  const raw = text.slice(0, 600);
  /* Clause breaks survive as " | " so a negation never reaches across a comma. */
  const t = ` ${raw.toLowerCase().replace(/[’']/g, "'").replace(/[,.;:!?()]+/g, ' | ').replace(/[^a-z0-9'\-|\s]/g, ' ').replace(/\s+/g, ' ')} `;
  let answers: TripComposerAnswers = { ...base, discovery: { ...discoveryOf(base), request: raw.trim() || undefined } };
  const readings: Reading[] = [];
  const assumptions: string[] = [];
  const vague: string[] = [];
  const asked = new Set<QuestionId>(discoveryOf(base).asked as QuestionId[]);
  const patchDiscovery = (patch: Partial<AdvisorAnswers>) => {
    answers = { ...answers, discovery: { ...discoveryOf(answers), ...patch } };
  };

  // ---- origin (read first: it decides what "summer" means) -----------------
  const from = /\b(?:from|based in|live in|living in|flying out of|leaving from)\s+([a-z][a-z\s]{1,30}?)(?=\s(?:and|for|in|to|i|we|with|on|this|next)\b|\s\||\s*$)/.exec(t);
  if (from) {
    const point = originPointFromText(from[1]!.trim());
    if (point) {
      answers = { ...answers, origin: point.label, ...(point.countryCode ? { originCountry: point.countryCode } : {}) };
      readings.push({ kind: 'origin', label: `From ${point.label}` });
    }
  }
  const origin = originPointFromText(answers.origin, answers.originCountry);

  // ---- when ------------------------------------------------------------------
  /* "May" is also a verb: "we may go hiking" names no month. */
  const mayIsMonth = /(?:\b(?:in|of|early|late|mid|end of|during|this|next|around|or|and|to|until|through|from|by)[\s-]+may\b)|\bmay\s+(?:to|through|until|till|-|or|and)\b|\bmay\s+\d|(?:^|\|)\s*may\s*(?:\||$)|^\s*may\s+(?!i\b|we\b|you\b|be\b)|\bmay\s*(?:-|or|and|to)\s*(?:june|jun|april|apr)\b/.test(t);
  const monthHits = MONTHS.map((name, index) => (index === 4 ? mayIsMonth : new RegExp(`\\b(${name}|${MONTH_SHORT[index]})\\b`).test(t)) ? index + 1 : 0).filter(Boolean);
  const seasonHit = /\b(summer|winter|spring|autumn|fall)\b/.exec(t);
  const range = parseDateRange(raw, now);
  if (range) {
    answers = {
      ...answers,
      dates: { mode: 'exact', startDate: range.startDate, endDate: range.endDate, wantsRecommendation: false },
      duration: { mode: 'fixed', nights: range.nights, wantsRecommendation: false },
    };
    readings.push({ kind: 'when', label: rangeLabel(range.startDate, range.endDate) });
    readings.push({ kind: 'length', label: `${range.nights} nights` });
  } else if (monthHits.length === 1) {
    answers = { ...answers, dates: { mode: 'month', month: monthHits[0]!, wantsRecommendation: false } };
    readings.push({ kind: 'when', label: MONTHS[monthHits[0]! - 1]!.replace(/^./, (c) => c.toUpperCase()) });
  } else if (monthHits.length > 1) {
    answers = { ...answers, dates: { mode: 'months', months: monthHits, wantsRecommendation: false } };
    readings.push({ kind: 'when', label: monthsLabel(monthHits) });
  } else if (/\b(next|this|in a) month\b/.test(t)) {
    /* "Next month" is a month, counted from today. */
    const month = /\bthis month\b/.test(t) ? now.getUTCMonth() + 1 : ((now.getUTCMonth() + 1) % 12) + 1;
    answers = { ...answers, dates: { mode: 'month', month, wantsRecommendation: false } };
    readings.push({ kind: 'when', label: MONTHS[month - 1]!.replace(/^./, (c) => c.toUpperCase()) });
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
  /* "A week or two" is a range, not a week: the trailing number belongs to the same unit. */
  const orMore = /\b(a|an|one|two|three)\s+(days?|nights?|weeks?)\s+or\s+(two|three|four|so)\b/.exec(t);
  /* "A day" and "a night" are rates ("€100 a day"), never the trip's length. */
  const spanMatch = [...t.matchAll(/\b(\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|couple of|few)\s*(?:-|to|or)?\s*(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen)?\s*(days?|nights?|weeks?)\b/g)].find(
    (m) => !(/^an?$/.test(m[1]!) && !m[2] && /^(day|night)$/.test(m[3]!)),
  );
  const span: [string, string, string | undefined, string] | null = orMore
    ? [orMore[0], orMore[1]!, orMore[3] === 'so' ? undefined : orMore[3], orMore[2]!]
    : spanMatch
      ? [spanMatch[0], spanMatch[1]!, spanMatch[2], spanMatch[3]!]
      : null;
  if (range) {
    // The calendar range already said how long.
  } else if (/\blong weekend\b|\bweekend\b/.test(t) && !span) {
    answers = { ...answers, duration: { mode: 'range', minNights: 2, maxNights: 3, wantsRecommendation: false } };
    readings.push({ kind: 'length', label: 'A weekend' });
  } else if (span) {
    const first = numberOf(span[1]!.replace(' of', '')) ?? 1;
    const second = span[2] ? numberOf(span[2]) : null;
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
  const refused = new Set<FocusKey>();
  const said = new Map<FocusKey, number>();
  for (const [pattern, keys] of FOCUS_PATTERNS) {
    const seen = occurrences(pattern, t);
    if (seen.positive > 0) for (const key of keys) said.set(key, (said.get(key) ?? 0) + seen.positive);
    if (seen.positive > 0) for (const key of keys) if (!focus.includes(key)) focus.push(key);
    if (seen.negative > 0 && seen.positive === 0) for (const key of keys) refused.add(key);
  }
  if (saysYes(/\bswim(ming)?\b/, t) && !focus.includes('beaches') && !focus.includes('lakes')) focus.push('beaches');
  /* "Hiking but no snow": the snow is refused, and that is a reading of its own, not merely a missing interest. */
  const refusesSnow = !focus.includes('snow') && occurrences(/\b(snow(y|fall|bound)?|ice|icy|freezing|frozen|ski(ing)?|winter (weather|conditions))\b/, t).negative > 0;
  const refusedKeys = [...refused].filter((key) => !focus.includes(key) && key !== 'snow');
  if (refusedKeys.length > 0) {
    patchDiscovery({ refused: refusedKeys });
    for (const key of refusedKeys) readings.push({ kind: 'focus', label: `Not ${FOCUS_LABELS[key].toLowerCase()}` });
  }
  if (refusesSnow) {
    patchDiscovery({ avoidSnow: true });
    readings.push({ kind: 'climate', label: 'No snow' });
  }
  /* "Mostly hiking, some food": the traveller already said what leads, so "which matters most" is not asked. */
  let leadSaid = false;
  const leadPhrase = /\b(?:mainly|mostly|primarily|above all|especially|most importantly|first and foremost|main focus is|mainly about|mostly about|priority is)\s+(?:on\s+|about\s+|for\s+)?([a-z'\- ]{3,30}?)(?=\s*\||\s+(?:and|but|with|in|for|some|plus)\b|\s*$)/.exec(t);
  if (leadPhrase && focus.length >= 2) {
    const keys = FOCUS_PATTERNS.filter(([pattern]) => pattern.test(` ${leadPhrase[1]} `)).flatMap(([, keys]) => keys);
    const lead = keys.find((key) => focus.includes(key));
    if (lead) {
      focus.splice(focus.indexOf(lead), 1);
      focus.unshift(lead);
      leadSaid = true;
    }
  }
  /*
   * Said again is said first. "Winter sports: reliable snow, good skiing and a
   * lively village" is a ski trip with a village in it, not an even split — an
   * interest the request returns to, at least twice as often as any other,
   * leads.
   */
  if (!leadSaid && focus.length >= 2) {
    const counted = focus.map((key) => [key, said.get(key) ?? 0] as const).sort((a, b) => b[1] - a[1]);
    if (counted[0]![1] >= 2 && counted[0]![1] >= 2 * counted[1]![1]) {
      const lead = counted[0]![0];
      focus.splice(focus.indexOf(lead), 1);
      focus.unshift(lead);
      leadSaid = true;
    }
  }
  /*
   * Pursuits: the precise thing where the request named one. A food trip is
   * not half a culture trip, and the reverse: when only one side of "culture
   * and food" was said, that side is what is scored.
   */
  const pursuits: PursuitKey[] = [];
  for (const [pattern, key] of PURSUIT_PATTERNS) if (saysYes(pattern, t) && !pursuits.includes(key)) pursuits.push(key);
  if (focus.includes('culture_food')) {
    const food = occurrences(FOOD_WORDS, t).positive;
    const culture = occurrences(CULTURE_WORDS, t).positive;
    const one: PursuitKey | null = food > 0 && culture === 0 ? 'food' : culture > 0 && food === 0 ? 'culture' : null;
    if (one) {
      focus.splice(focus.indexOf('culture_food'), 1);
      pursuits.unshift(one);
    }
  }
  /* "Spa" beside "hot springs" is the same wish said twice. */
  if (pursuits.includes('hot_springs') && pursuits.includes('wellness')) pursuits.splice(pursuits.indexOf('wellness'), 1);
  if (focus.length > 0) {
    patchDiscovery({ focus, focusRanked: (focus.length === 1 && pursuits.length === 0) || leadSaid });
    for (const key of focus) readings.push({ kind: 'focus', label: FOCUS_LABELS[key] });
  }
  if (pursuits.length > 0) {
    patchDiscovery({ pursuits });
    for (const key of pursuits) readings.push({ kind: 'focus', label: PURSUIT_LABELS[key] });
  }
  /*
   * Nothing specific was named: read the mood. "Somewhere beautiful and
   * relaxing" is a leaning towards scenery and rest, said back as an
   * assumption. With children along and nothing else said, the leaning is an
   * easy family trip.
   */
  if (focus.length === 0 && pursuits.length === 0) {
    const moods: MoodKey[] = [];
    for (const [pattern, key] of MOOD_PATTERNS) if (saysYes(pattern, t) && !moods.includes(key)) moods.push(key);
    if (moods.length === 0 && /\b(kids?|children|child|toddlers?|family (trip|holiday|vacation))\b/.test(t)) moods.push('family');
    if (moods.length > 0) {
      const kept = moods.slice(0, 3);
      patchDiscovery({ moods: kept });
      for (const key of kept) readings.push({ kind: 'focus', label: MOOD_LABELS[key] });
      assumptions.push(`No activity named, so we looked for ${kept.map((key) => MOOD_LABELS[key].toLowerCase()).join(' and ')}. Tell us what you’d like to do.`.slice(0, 160));
      vague.push('interests');
    }
    if (/\b(outdoors?|outside|nature)\b/.test(t)) vague.push('outdoors');
  }
  if (focus.includes('snow') && saysYes(/\b(ski(s|ing|ers?)?|snowboard(s|ing|ers?)?|lift pass|pistes?|powder)\b/, t)) patchDiscovery({ skiing: true });
  if (saysYes(/\bsafari\b/, t)) patchDiscovery({ wildlifeKind: 'safari' });
  else if (saysYes(/\b(whales?|snorkel|reef|marine|dolphins?)\b/, t) && focus.includes('wildlife')) patchDiscovery({ wildlifeKind: 'marine' });
  if (saysYes(/\b(glaciers?|icebergs?|ice ?(fields?|caps?))\b/, t) && !saysYes(/\b(trek(s|king)?|climb(ing)?|mountaineering|hut[- ]to[- ]hut)\b/, t)) patchDiscovery({ mountainStyle: 'glaciers' });
  else if (saysYes(/\b(high[- ]altitude|high and wild|above \d{4} ?m|base camp)\b/, t)) patchDiscovery({ mountainStyle: 'high_altitude' });
  else if (saysYes(/\b(hut[- ]to[- ]hut|multi[- ]day|thru[- ]hike|long[- ]distance (trail|walk|hike)s?)\b/, t)) patchDiscovery({ mountainStyle: 'hut_to_hut' });
  else if (saysYes(/\bday hikes?\b/, t) && focus.includes('mountains')) patchDiscovery({ mountainStyle: 'base_day_hikes' });
  /* What kind of sea trip: for a diver the reef is the destination and the sand is incidental. */
  const diveSaid = occurrences(/\b(scuba|div(e|es|ing|ers?)|liveaboards?|dive sites?|wreck div\w+)\b/, t).positive;
  const snorkelSaid = occurrences(/\b(snorkel(l?ing|s)?|reefs?|coral)\b/, t).positive;
  const beachSaid = occurrences(/\b(beach(es)?|sand|sunbath\w+|swim(ming)?)\b/, t).positive;
  if (diveSaid > 0 && diveSaid >= beachSaid) patchDiscovery({ swimStyle: 'diving' });
  else if (snorkelSaid > 0 || diveSaid > 0) patchDiscovery({ swimStyle: 'snorkel' });
  else if (/\b(warm (sea|water)|tropical beach)/.test(t)) patchDiscovery({ swimStyle: 'warm_sea' });

  // ---- budget -----------------------------------------------------------------
  /*
   * Words first, money second. "No budget" and "money is no object" are the
   * opposite of "budget"; "not too expensive" is the middle, not the bottom.
   * A stated amount is read per night (a total over the trip's nights, or a
   * week when the length is open), and the reading is stated as an assumption.
   */
  const money = moneyBudget(raw, answers);
  const budget: 'budget' | 'mid_range' | 'premium' | 'luxury' | null =
    /\b(money is no object|price is no object|unlimited budget|no budget (limit|cap)?|sky'?s the limit)\b/.test(t)
      ? 'luxury'
      : /\b(budget (is|isn't|is not) (not )?(an? )?(issue|concern|problem|constraint)|cost (is|isn't|is not) (not )?(an? )?(issue|concern))\b/.test(t)
        ? 'premium'
        : saysYes(/\b(luxury|luxurious|five[- ]star)\b/, t)
          ? 'luxury'
          : saysYes(/\b(splurge|comfortable budget|nice hotels|high[- ]end|premium)\b/, t)
            ? 'premium'
            : /\b(mid[- ]range|moderate budget|medium budget|moderately priced|reasonable budget|not (too |very |super |overly )?(expensive|pricey|costly)|nothing (too )?(fancy|expensive|pricey))\b/.test(t)
              ? 'mid_range'
              : saysYes(/\b(cheap|shoestring|backpack(ing|er)?|affordable|inexpensive|low[- ]cost|frugal|tight on money|on a dime|budget[- ]friendly|budget[- ]conscious|on a tight budget)\b/, t)
                ? 'budget'
                : money
                  ? money.band
                  : saysYes(/\b(cheap|budget)\b/, t)
                    ? 'budget'
                    : null;
  if (budget) {
    answers = { ...answers, budget };
    readings.push({ kind: 'budget', label: money && budget === money.band ? money.label : { budget: 'Budget-conscious', mid_range: 'Moderate budget', premium: 'Comfortable budget', luxury: 'Luxury' }[budget] });
    if (money && budget === money.band) assumptions.push(money.assumption);
  }

  // ---- party --------------------------------------------------------------------
  const needs = new Set(answers.travelerNeeds);
  const kids = /\b(?:(\d{1,2}|one|two|three|four|five|six)\s+(?:young\s+|little\s+|small\s+)?)?(kids?|children|child|toddlers?|sons?|daughters?)\b/.exec(t);
  const kidsRefused = kids ? isNegated(t, kids.index) : false;
  if ((kids && !kidsRefused) || /\b(my son|my daughter|family with|with the family|family trip|family holiday|family vacation)\b/.test(t)) {
    const named = kids?.[1] ? numberOf(kids[1]) ?? 1 : 1;
    /* Ages say whether the children are young; teenagers are children on the booking, not on the trail. */
    const ages = [...t.matchAll(/\b(?:aged?|ages)\s+((?:\d{1,2}(?:\s*(?:and|&|-|\|)\s*)?)+)/g)].flatMap((m) => m[1]!.match(/\d{1,2}/g) ?? []).map(Number);
    if (ages.length === 0 || ages.some((age) => age < 12)) needs.add('kids_under_12');
    const count = Math.max(named, ages.length);
    answers = { ...answers, children: Math.min(12, Math.max(count, answers.children, 1)) };
    readings.push({ kind: 'party', label: count > 1 ? `With ${count} children` : 'With children' });
    asked.add('party');
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
  /* Who is going, when it is said, answers "who's going" — even when the answer is "just adults". */
  if (/\b(solo|by myself|alone|on my own)\b/.test(t)) {
    answers = { ...answers, adults: 1 };
    readings.push({ kind: 'party', label: 'Solo' });
    asked.add('party');
  } else {
    const group = /\b(?:(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of us|friends|adults|people|mates|guys|girls))\b|\b(group of friends|with friends|friends trip|girls'? trip|guys'? trip|bachelor(ette)?|stag|hen (do|party)|my mates|a group)\b/.exec(t);
    const couple = /\b(couple(?! of)|my (partner|wife|husband|girlfriend|boyfriend|fianc[ée]e?)|honeymoon|romantic|two of us|the two of us)\b/.test(t);
    if (group) {
      const size = group[1] ? numberOf(group[1]) : null;
      answers = { ...answers, adults: Math.min(12, Math.max(answers.adults, size ?? 3)) };
      readings.push({ kind: 'party', label: size ? `${size} adults` : 'A group of friends' });
      if (answers.children === 0) asked.add('party');
    } else if (couple) {
      answers = { ...answers, adults: 2 };
      readings.push({ kind: 'party', label: 'A couple' });
      if (answers.children === 0) asked.add('party');
    }
  }

  // ---- adventure ----------------------------------------------------------------
  /*
   * "Not too strenuous" contains "strenuous": the softening is read first, and
   * every harder word must be wished for, not refused.
   */
  const softened = /\b(not too|nothing too|not overly|not very|not super|not that) (strenuous|hard|intense|demanding|challenging|tough|difficult|rugged|active|physical)\b/.test(t);
  const adventure = softened
    ? 'comfortable'
    : saysYes(/\b(expedition|technical|mountaineering|base camp|high[- ]altitude|peak bagging|summit(s|ing)?)\b/, t)
      ? 'expedition'
      : saysYes(/\b(rugged|remote|(?<!in the )wild(?!life)|off[- ]grid|challenging|strenuous|hardcore|intense|demanding|tough|gruelling|grueling|hard hik(es|ing)|very active|highly active|super active|push (myself|ourselves))\b/, t)
        ? 'rugged'
        : saysYes(/\b(easy|easygoing|easy-going|relaxed|relaxing|gentle|leisurely|chill|laid[- ]back|low[- ]key|accessible)\b/, t)
          ? 'comfortable'
          : saysYes(/\b(active|moderately active|moderate hik(es|ing)|fairly fit)\b/, t)
            ? 'active'
            : null;
  /* "Adventurous but not too difficult" asks for both: something active, short of hard. */
  const softenedAdventure = softened && saysYes(/\b(adventur(e|es|ous)|thrill\w*|adrenaline|exciting|active)\b/, t);
  if (softenedAdventure) {
    patchDiscovery({ adventure: 'active' });
    answers = { ...answers, outdoorIntensity: 'moderate' };
    readings.push({ kind: 'adventure', label: 'Active, nothing too hard' });
  } else if (adventure) {
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
  const refusedRegions = new Set<WorldRegion>();
  const refusedLabels: string[] = [];
  for (const [pattern, list, label] of REGION_PATTERNS) {
    /* "from the US" names an origin, not a destination. */
    const match = pattern.exec(t);
    if (!match) continue;
    const before = t.slice(Math.max(0, match.index - 12), match.index);
    if (/\b(from|live in|based in)\s*$/.test(before)) continue;
    /* "Anywhere but Europe" and "not Asia" rule a region out; they never rule it in. */
    if (isNegated(t, match.index) || /\b(anywhere|somewhere) (but|except|other than|outside( of)?)\s*(the\s*)?$/.test(t.slice(0, match.index))) {
      spans.push([match.index, match.index + match[0].length]);
      for (const region of list) refusedRegions.add(region);
      refusedLabels.push(label);
      continue;
    }
    /* "Southeast Asia" already matched: the "Asia" inside it is not a second, wider region. */
    const end = match.index + match[0].length;
    if (spans.some(([a, b]) => match.index < b && end > a)) continue;
    spans.push([match.index, end]);
    if (regions.length > 0 && list.every((region) => regions.includes(region))) continue;
    regions.push(...list.filter((region) => !regions.includes(region)));
    readings.push({ kind: 'region', label });
  }
  if (regions.length === 0 && refusedRegions.size > 0) {
    regions.push(...WORLD_REGIONS.filter((region) => !refusedRegions.has(region)));
    readings.push({ kind: 'region', label: `Not ${refusedLabels.join(' or ')}` });
  }
  if (regions.length > 0) {
    patchDiscovery({ regions });
    asked.add('region');
  }

  // ---- transport, crowds, novelty, climate -------------------------------------
  const driveWords = /\b(road ?trips?|rent(ing)? a car|car rental|happy to drive|drive|driving|campervan|camper van|self[- ]drive)\b/;
  if (
    /\b(no car|without a car|car[- ]free|don'?t have a car|can'?t drive|no license|no licence|public transport(ation)?|public transit|by train|trains|by rail|rail pass)\b/.test(t) ||
    occurrences(driveWords, t).negative > 0 && !saysYes(/\b(happy to drive|rent(ing)? a car|self[- ]drive)\b/, t)
  ) {
    answers = { ...answers, transport: 'public_transport' };
    readings.push({ kind: 'transport', label: 'No car' });
  } else if (saysYes(driveWords, t)) {
    answers = { ...answers, transport: 'drive' };
    readings.push({ kind: 'transport', label: 'Happy to drive' });
  }
  if (
    /\b(avoid (the )?crowds|not crowded|uncrowded|quiet|no crowds|fewer tourists|not touristy|away from tourists|away from the crowds|hate crowds)\b/.test(t) ||
    /\b(avoid|avoiding|hate|no|without|not)\b[^|]{0,30}\b(crowds|crowded|tourist traps?|touristy|overtouristed)\b/.test(t)
  ) {
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
  const warmWords = /\b(warm|hot(?! springs?)|sunny|sunshine|tropical|heat|humid)\b/;
  const coolSaid = /\b(somewhere cool\b|cool (place|climate|summer|air|temperatures?)|stay cool|keep cool|\bbut somewhere cool)\b/.test(t);
  const coldWords = /\b(cold|chilly|freezing|snowy|crisp)\b/;
  if (coolSaid || /\b(not too hot|avoid (the )?heat|avoid extreme heat|escape the heat|cooler|cool weather|no heat|not dangerously hot)\b/.test(t) || (occurrences(warmWords, t).negative > 0 && !saysYes(warmWords, t))) {
    answers = { ...answers, climatePreference: 'mild' };
    readings.push({ kind: 'climate', label: 'Not too hot' });
  } else if (/\bescape the (cold|winter)\b/.test(t) || saysYes(/\b(warm|hot(?! springs?)|sunny|sunshine|tropical)\b/, t)) {
    answers = { ...answers, climatePreference: 'warm' };
    readings.push({ kind: 'climate', label: 'Warm' });
  } else if (occurrences(coldWords, t).negative > 0 && !saysYes(coldWords, t)) {
    /* "Not cold" is not a wish for heat: it is the mild middle. */
    answers = { ...answers, climatePreference: 'mild' };
    readings.push({ kind: 'climate', label: 'Not cold' });
  } else if (saysYes(coldWords, t)) {
    answers = { ...answers, climatePreference: 'cold' };
    readings.push({ kind: 'climate', label: 'Cool' });
  }

  // ---- named places: a scope, a comparison, a refusal or a starting point ------
  /*
   * "Trekking in the Karakoram", "like the Dolomites but cheaper", "not Bali",
   * "from Delhi". A named place is never the answer itself: it bounds the
   * search, sets what to resemble, or is ruled out. Which of those is read from
   * the words around it, and each reading is shown back as a chip.
   */
  if (places) {
    const mentions = places.findPlaces(raw);
    const continentWords = /^(europe|asia|africa|americas|oceania|caribbean|mediterranean|north america|south america|central america)$/;
    const within: string[] = [];
    const withinLabels: string[] = [];
    const scopedCountries: string[] = [];
    const outside: string[] = [];
    let similarTo: string | undefined = discoveryOf(answers).similarTo;
    for (const mention of mentions) {
      const said = raw.slice(mention.start, mention.end).toLowerCase();
      if (mention.role === 'origin') {
        if (!originPointFromText(answers.origin, answers.originCountry) && !discoveryOf(answers).originPoint) {
          answers = { ...answers, origin: mention.name };
          patchDiscovery({ originPoint: { lat: mention.center.lat, lng: mention.center.lng, label: mention.name, countryCode: mention.country } });
          readings.push({ kind: 'origin', label: `From ${mention.name}` });
        }
        continue;
      }
      if (mention.role === 'similar') {
        if (!similarTo) {
          similarTo = mention.id;
          readings.push({ kind: 'region', label: `Like ${mention.name}` });
        }
        continue;
      }
      if (mention.role === 'avoid') {
        /* "Not Europe", "anywhere but Asia": the continent table already read the refusal, with its negation. */
        if (continentWords.test(said)) continue;
        if (!outside.includes(mention.id)) {
          outside.push(mention.id);
          readings.push({ kind: 'region', label: `Not ${mention.name}` });
        }
        continue;
      }
      /* The hand-written continent table already read these words, negations included. */
      if (continentWords.test(said)) continue;
      /* A single town named in passing is not an area to search inside. */
      if (!mention.wide) continue;
      if (mention.country) {
        if (!scopedCountries.includes(mention.country)) scopedCountries.push(mention.country);
        readings.push({ kind: 'region', label: mention.name });
      } else if (!within.includes(mention.id)) {
        /* One name, several records ("Patagonia" is filed once under Chile and once under Argentina): the scope is all of them. */
        for (const id of mention.ids) if (!within.includes(id)) within.push(id);
        withinLabels.push(mention.name);
        readings.push({ kind: 'region', label: mention.name });
      }
    }
    if (within.length > 0 || scopedCountries.length > 0) {
      /*
       * A named country or area is the scope. The coarser readings the tables
       * made of the same words ("Canada" as all of North America, "Patagonia"
       * as the whole of Argentina and Chile) give way to it.
       */
      const named = [...new Set(readings.filter((reading) => reading.kind === 'region').map((reading) => reading.label))];
      void named;
      patchDiscovery({
        ...(within.length > 0 ? { within: within.slice(0, 6), withinLabels: withinLabels.slice(0, 6) } : {}),
        ...(scopedCountries.length > 0 ? { countries: scopedCountries.slice(0, 40) } : within.length > 0 ? { countries: undefined } : {}),
        regions: undefined,
      });
      asked.add('region');
    }
    if (outside.length > 0) patchDiscovery({ outside: outside.slice(0, 8) });
    if (similarTo && similarTo !== discoveryOf(answers).similarTo) {
      patchDiscovery({ similarTo });
      asked.add('region');
    }
    const own = requestWords(raw, mentions);
    /* "Northern lights" folds to nothing an index holds; the word guides use for it is kept. */
    if (/\b(northern lights|southern lights|aurora)\b/.test(t)) patchDiscovery({ aurora: true });
    if (/\b(northern lights|aurora)\b/.test(t) && !own.terms.includes('aurora')) {
      own.terms.unshift('aurora');
      own.phrase = `aurora northern lights ${own.phrase}`.trim();
    }
    if (own.terms.length > 0) patchDiscovery({ terms: own.terms.slice(0, 8), phrase: own.phrase });
  }
  /* Comparatives. "Cheaper", "quieter", "less touristy" are asks in their own right, most often said against a named place. */
  if (/\b(cheaper|less expensive|less pricey|more affordable|lower cost|costs? less)\b/.test(t) && !answers.budget) {
    patchDiscovery({ refinements: [...new Set([...(discoveryOf(answers).refinements ?? []), 'cheaper' as const])] });
    readings.push({ kind: 'budget', label: 'Less expensive' });
  }
  if (/\b(quieter|less (crowded|busy|touristy|developed|commerciali[sz]ed)|fewer (people|tourists|crowds)|without the (\w+ )?crowds|crowd[- ]free|few (cruise ships|tourists|people))\b/.test(t) && answers.crowdTolerance !== 'avoid') {
    answers = { ...answers, crowdTolerance: 'avoid' };
    readings.push({ kind: 'crowds', label: 'Away from crowds' });
  }
  if (/\b(underrated|under the radar|undiscovered|less touristy|lesser known|alternatives? to|most tourists skip|never heard of|off[- ]the[- ]beaten)\b/.test(t) && !answers.surpriseAppetite) {
    answers = { ...answers, surpriseAppetite: 'surprise_me' };
    readings.push({ kind: 'novelty', label: 'Somewhere unexpected' });
  }

  patchDiscovery({ asked: [...asked], assumptions: [...new Set([...(discoveryOf(answers).assumptions ?? []), ...assumptions])].slice(0, 12) });
  return { answers, readings, assumptions, vague };
}
