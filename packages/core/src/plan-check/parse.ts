import { parseDestinationIntent, type IntentNodeKind } from '../destinations/intent-graph';
import { countriesInText } from '../reference/countries';
import { readPartyFromText, type PartyReading } from '../party/resolve';
import type { StatedTransportMode } from '../contract/stated-itinerary';

/**
 * "I ALREADY HAVE A PLAN" — THE TRAVELLER'S ROUGH PLAN, READ DETERMINISTICALLY.
 *
 * Master prompt §7, Mode 3. Somebody types "Tokyo, Kyoto, Osaka and Hokkaido
 * in 10 days — is that too much?", or pastes a day-by-day list, or writes
 * "3 nights Lisbon, 2 nights Porto". This turns that into places in order,
 * nights per place where they said them, and the trip's length where they said
 * it — with no model and no network. Where a place is (coordinates) is the
 * resolver's job afterwards; this only reads the words.
 *
 * The places are the traveller's own words. Each one is classified by the
 * same intent-graph reading the setup door uses (`parseDestinationIntent`), so
 * a country named beside the list ("…, Japan") is read as context rather than
 * as a stop, and "Lake Como" is a landscape rather than a town. Nothing here
 * knows any place by name: the vocabulary is shape words (nights, days, weeks,
 * day trip) and the calendar.
 *
 * What it cannot read it leaves unset and says so: a stop with no nights is
 * `nights: null`, never a guess passed off as theirs. Where a total length is
 * known, unstated nights are spread evenly and marked `spread`, so every later
 * sentence can say they were Sidequest's split, not the traveller's.
 */

export type StopNightsBasis = 'stated' | 'days_stated' | 'day_list' | 'spread';
export type PlanTotalBasis = 'dates' | 'nights' | 'days' | 'weeks' | 'day_list' | 'sum_of_stops';

export interface ParsedPlanStop {
  /** The traveller's words for the place, trimmed. */
  label: string;
  /** Nights here, or null when nobody said and nothing could be derived. Zero for a day trip. */
  nights: number | null;
  nightsBasis: StopNightsBasis | null;
  /** "a day trip to X": seen from the previous bed, not slept in. */
  dayTrip: boolean;
  /** The intent graph's reading of the label's shape. */
  kind: IntentNodeKind;
  /** ISO country the label names or sits in, when its own words say so. */
  countryCode?: string;
  /** "booked", "reserved", "confirmed": a stay that must not move. */
  fixed: boolean;
  /** Attractions named at this stop: "(Fushimi Inari, Kinkaku-ji)" or a day list's activities. */
  mustSee: string[];
  /** How they planned to arrive here: "by train", "(ferry)", "fly to…". */
  transportIn: StatedTransportMode | null;
  /** A date range written against this stop. */
  dates: { start: string; end: string } | null;
}

export interface ParsedPlanEdge {
  place: string | null;
  /** "15:00" when they gave a time. */
  time: string | null;
}

export interface ParsedPlan {
  stops: ParsedPlanStop[];
  /** Nights in the whole trip, when the plan says or implies it. */
  totalNights: number | null;
  totalBasis: PlanTotalBasis | null;
  startDate: string | null;
  endDate: string | null;
  /** A month named without dates ("in April"), 1–12. */
  month: number | null;
  /** Countries named as context for the list rather than as stops ("…, Japan"). */
  contextCountries: string[];
  /** The question they asked, kept verbatim ("Is that too much?"). */
  question: string | null;
  format: 'day_list' | 'list';
  /** Things the reading noticed that the traveller should see (nights that do not add up). */
  notes: string[];
  /** "Fly into…", "landing at 3pm": where and when they arrive, when they said. */
  arrival: ParsedPlanEdge | null;
  departure: ParsedPlanEdge | null;
  /** Who is going, when their words say ("for my family of four", "solo"). */
  party: PartyReading | null;
  /** 0–1: how much of the plan the reading understood (places with nights of their own count most). */
  confidence: number;
}

export const PLAN_TEXT_MAX = 2000;
export const PLAN_MAX_STOPS = 12;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty one': 21, thirty: 30,
};
const NUM = String.raw`(\d{1,3}|twenty[-\s]one|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)`;
const STAY_UNIT = String.raw`(nights?|nts?|days?|n|d)`;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const ORD = String.raw`(?:st|nd|rd|th)?`;
const RANGE = String.raw`\s*(?:-|–|—|to|until|till|through|thru)\s*`;

function toNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const folded = raw.toLowerCase().trim();
  if (/^\d+$/.test(folded)) return Number(folded);
  return NUMBER_WORDS[folded.replace(/\s+/g, ' ')] ?? null;
}

function monthIndex(raw: string): number {
  return MONTHS.indexOf(raw.toLowerCase().slice(0, 3)) + 1;
}

function iso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function nightsBetween(start: string, end: string): number | null {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The next year in which this month and day have not yet passed. */
function upcomingYear(month: number, day: number, now: Date): number {
  const year = now.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  return candidate < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) ? year + 1 : year;
}

interface Span {
  text: string;
}

/** Remove the first match of `re` from `span.text` and return the match, or null. */
function take(span: Span, re: RegExp): RegExpExecArray | null {
  const match = re.exec(span.text);
  if (!match) return null;
  span.text = `${span.text.slice(0, match.index)} ${span.text.slice(match.index + match[0].length)}`;
  return match;
}

/* ------------------------------------------------------------------------- */
/* Dates, months and the trip's length                                        */
/* ------------------------------------------------------------------------- */

interface Totals {
  startDate: string | null;
  endDate: string | null;
  month: number | null;
  totalNights: number | null;
  totalBasis: PlanTotalBasis | null;
}

function readDates(span: Span, now: Date): Pick<Totals, 'startDate' | 'endDate' | 'month'> {
  const isoRange = take(span, new RegExp(String.raw`(?:from\s+)?(\d{4}-\d{2}-\d{2})${RANGE}(\d{4}-\d{2}-\d{2})`, 'i'));
  if (isoRange) return { startDate: isoRange[1]!, endDate: isoRange[2]!, month: null };

  /* "April 2–12", "April 28 – May 6, 2027" */
  const monthFirst = take(span, new RegExp(String.raw`(?:from\s+)?\b${MONTH}\s+(\d{1,2})${ORD}${RANGE}(?:${MONTH}\s+)?(\d{1,2})${ORD}(?:,?\s*(\d{4}))?\b`, 'i'));
  if (monthFirst) {
    const m1 = monthIndex(monthFirst[1]!);
    const d1 = Number(monthFirst[2]);
    const m2 = monthFirst[3] ? monthIndex(monthFirst[3]) : m1;
    const d2 = Number(monthFirst[4]);
    const year = monthFirst[5] ? Number(monthFirst[5]) : upcomingYear(m1, d1, now);
    const start = iso(year, m1, d1);
    const end = iso(m2 < m1 ? year + 1 : year, m2, d2);
    if (start && end && nightsBetween(start, end)) return { startDate: start, endDate: end, month: null };
  }

  /* "2–12 April", "28 April – 6 May 2027" */
  const dayFirst = take(span, new RegExp(String.raw`(?:from\s+)?\b(\d{1,2})${ORD}(?:\s+${MONTH})?${RANGE}(\d{1,2})${ORD}\s+${MONTH}(?:,?\s*(\d{4}))?\b`, 'i'));
  if (dayFirst) {
    const m2 = monthIndex(dayFirst[4]!);
    const m1 = dayFirst[2] ? monthIndex(dayFirst[2]) : m2;
    const d1 = Number(dayFirst[1]);
    const d2 = Number(dayFirst[3]);
    const year = dayFirst[5] ? Number(dayFirst[5]) : upcomingYear(m1, d1, now);
    const start = iso(year, m1, d1);
    const end = iso(m2 < m1 ? year + 1 : year, m2, d2);
    if (start && end && nightsBetween(start, end)) return { startDate: start, endDate: end, month: null };
  }

  const monthOnly = take(span, new RegExp(String.raw`\b(?:in|during|this|next|over|for)\s+(?:early\s+|mid[-\s]?|late\s+)?${MONTH}\b`, 'i'));
  if (monthOnly) return { startDate: null, endDate: null, month: monthIndex(monthOnly[1]!) };
  return { startDate: null, endDate: null, month: null };
}

/** Lengths that can only mean the whole trip: "a 10-day trip", "two weeks", "10 days:" at the start. */
function readUnambiguousLength(span: Span): Pick<Totals, 'totalNights' | 'totalBasis'> & { context: string | null } {
  const weeks = take(span, new RegExp(String.raw`\b(?:(?:in|over|for|across|within)\s+)?${NUM}\s+weeks?\b|\b(?:(?:in|over|for)\s+)?(?:a\s+)?(fortnight)\b`, 'i'));
  if (weeks) {
    const count = weeks[2] ? 2 : toNumber(weeks[1]);
    if (count) return { totalNights: count * 7 - 1, totalBasis: 'weeks', context: null };
  }
  const trip = take(span, new RegExp(String.raw`\b(?:a\s+|an\s+)?${NUM}[-\s](day|night)\s+(?:trip|itinerary|holiday|vacation|tour|plan|loop|route|journey)\b`, 'i'));
  if (trip) {
    const count = toNumber(trip[1]);
    if (count) return trip[2]!.toLowerCase() === 'day' ? { totalNights: Math.max(0, count - 1), totalBasis: 'days', context: null } : { totalNights: count, totalBasis: 'nights', context: null };
  }
  const total = take(span, new RegExp(String.raw`\b${NUM}\s+(days?|nights?)\s+(?:in\s+)?total\b|\btotal(?:ling)?(?:\s+of)?\s+${NUM}\s+(days?|nights?)\b`, 'i'));
  if (total) {
    const count = toNumber(total[1] ?? total[3]);
    const unit = (total[2] ?? total[4] ?? '').toLowerCase();
    if (count) return unit.startsWith('day') ? { totalNights: Math.max(0, count - 1), totalBasis: 'days', context: null } : { totalNights: count, totalBasis: 'nights', context: null };
  }
  /* "10 days in Japan: Tokyo, Kyoto…" — the length and, sometimes, the country the list sits in. */
  const leading = take(span, new RegExp(String.raw`^\s*(?:about\s+|around\s+)?${NUM}\s+(days?|nights?)(?:\s+(?:in|around|across|through)\s+([^:\n]+?))?\s*[:\-–—]\s+`, 'i'));
  if (leading) {
    const count = toNumber(leading[1]);
    if (count) {
      const nights = leading[2]!.toLowerCase().startsWith('day') ? Math.max(0, count - 1) : count;
      return { totalNights: nights, totalBasis: leading[2]!.toLowerCase().startsWith('day') ? 'days' : 'nights', context: leading[3] ?? null };
    }
  }
  return { totalNights: null, totalBasis: null, context: null };
}

/* ------------------------------------------------------------------------- */
/* Filler and the question                                                    */
/* ------------------------------------------------------------------------- */

function splitQuestion(text: string): { body: string; question: string | null } {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const questions = sentences.filter((s) => s.trim().endsWith('?'));
  const rest = sentences.filter((s) => !s.trim().endsWith('?'));
  if (questions.length === 0) return { body: text, question: null };
  if (rest.join(' ').trim().length === 0) {
    /* The whole plan was asked as a question: keep the words, note the question. */
    return { body: text.replace(/\?+\s*$/, ''), question: text.trim() };
  }
  return { body: rest.join(' '), question: questions.map((q) => q.trim()).join(' ') };
}

const FILLER: readonly RegExp[] = [
  /^\s*(?:hi|hey|hello|so|ok|okay|well)[,!.]?\s+/i,
  /\b(?:i'?m|i am|we'?re|we are|i was|we were)\s+(?:currently\s+)?(?:thinking(?:\s+(?:of|about))?|planning(?:\s+(?:on|to\s+do|to\s+visit))?|considering|looking\s+at|hoping\s+to\s+(?:do|visit|see))\s*:?\s*/gi,
  /\b(?:i|we)\s+(?:want|would\s+like|plan|hope)\s+to\s+(?:do|visit|see|go\s+to)\s+/gi,
  /\b(?:my|our)\s+(?:rough\s+)?(?:plan|idea|route|itinerary)\s+(?:is|so\s+far\s+is|looks\s+like)\s*:?\s*/gi,
  /^\s*(?:rough\s+)?(?:plan|route|itinerary|idea)\s*:\s*/i,
  /\b(?:going\s+to|visiting|heading\s+to|travel(?:l)?ing\s+to)\s+/gi,
];

function stripFiller(text: string): string {
  let out = text;
  for (const re of FILLER) out = out.replace(re, ' ');
  return out;
}

/* ------------------------------------------------------------------------- */
/* One place and its nights                                                   */
/* ------------------------------------------------------------------------- */

interface Annotated {
  label: string;
  count: number | null;
  unit: 'night' | 'day' | null;
  /** The preposition before a trailing count ("in 10 days"), which may make it the trip's length. */
  prep: string | null;
  dayTrip: boolean;
}

const unitOf = (raw: string | undefined): 'night' | 'day' | null => (!raw ? null : /^d/i.test(raw) ? 'day' : 'night');

function cleanPlace(raw: string): string {
  return raw
    .replace(/^[\s\-–—:•*·>]+/, '')
    .replace(/^(?:in|at|to|then|and|maybe|possibly|plus|also)\s+/i, '')
    .replace(/[\s.!,;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Commas, "and" and "&" inside brackets belong to the bracket ("Kyoto (Fushimi Inari, Kinkaku-ji)"), not to the list. */
const P_COMMA = '\u0001';
const P_AND = '\u0002';
const P_AMP = '\u0003';
function protectBrackets(text: string): string {
  return text.replace(/\(([^()]*)\)/g, (_, inner: string) => `(${inner.replace(/,/g, P_COMMA).replace(/\s+and\s+/gi, ` ${P_AND} `).replace(/&/g, P_AMP)})`);
}
function restoreBrackets(text: string): string {
  return text.replace(new RegExp(P_COMMA, 'g'), ',').replace(new RegExp(`\\s*${P_AND}\\s*`, 'g'), ' and ').replace(new RegExp(P_AMP, 'g'), '&');
}

const TRANSPORT_WORDS: readonly [RegExp, StatedTransportMode][] = [
  [/^(?:train|trains|rail|shinkansen|tgv|ice|eurostar)$/i, 'rail'],
  [/^(?:car|road|drive|driving|rental|hire car|road trip)$/i, 'drive'],
  [/^(?:bus|coach)$/i, 'bus'],
  [/^(?:ferry|boat)$/i, 'ferry'],
  [/^(?:plane|air|flight|fly|flying)$/i, 'flight'],
  [/^(?:foot|walk|walking|hike|hiking)$/i, 'walk'],
];
const TRANSPORT_ALT = 'train|trains|rail|shinkansen|tgv|eurostar|car|road|drive|driving|rental car|hire car|bus|coach|ferry|boat|plane|air|flight|fly|flying|foot|walk|walking';
function transportOf(word: string): StatedTransportMode | null {
  const folded = word.trim().toLowerCase().replace(/^the\s+/, '');
  for (const [re, mode] of TRANSPORT_WORDS) if (re.test(folded)) return mode;
  return null;
}

interface StopExtras {
  fixed: boolean;
  transportIn: StatedTransportMode | null;
  mustSee: string[];
}

/** Take the stop's own marks out of its words: booked, the way in, the attractions in brackets. */
function extractExtras(raw: string): { text: string; extras: StopExtras } {
  let text = raw;
  let fixed = false;
  let transportIn: StatedTransportMode | null = null;
  const mustSee: string[] = [];
  if (/\(\s*(?:booked|reserved|confirmed|paid)\s*\)|\b(?:already\s+)?(?:booked|reserved|confirmed)\b/i.test(text)) {
    fixed = true;
    text = text.replace(/\(\s*(?:booked|reserved|confirmed|paid)\s*\)/gi, ' ').replace(/[-–—,]?\s*\b(?:already\s+)?(?:booked|reserved|confirmed)\b(?:\s+(?:hotel|stay|room))?/gi, ' ');
  }
  const leadingMove = new RegExp(String.raw`^\s*(?:then\s+)?(?:take\s+the\s+|by\s+)?(${TRANSPORT_ALT})\s+(?:to|into)\s+`, 'i').exec(text);
  if (leadingMove) {
    transportIn = transportOf(leadingMove[1]!);
    text = text.slice(leadingMove[0].length);
  }
  const byMode = new RegExp(String.raw`\s*[-–—,]?\s*\b(?:by|via|on\s+the|take\s+the|taking\s+the)\s+(${TRANSPORT_ALT})\b`, 'i').exec(text);
  if (byMode) {
    transportIn ??= transportOf(byMode[1]!);
    text = `${text.slice(0, byMode.index)} ${text.slice(byMode.index + byMode[0].length)}`;
  }
  text = text.replace(/\(([^()]*)\)/g, (whole, inner: string) => {
    const content = restoreBrackets(inner).trim();
    const mode = transportOf(content);
    if (mode) {
      transportIn ??= mode;
      return ' ';
    }
    /* Nights, day trips and the like stay where `annotate` reads them. */
    if (/^\s*(?:\d|a\s|an\s|one|two|three|four|five|six|seven|eight|nine|ten|day[-\s]?trip)/i.test(content) || content.length === 0) return whole;
    const named = content.replace(/^(?:see|visit|for|incl(?:uding|\.)?|to see)\s+/i, '').split(/\s*(?:,|&|\band\b|\+)\s*/).map((n) => n.trim()).filter((n) => /\p{L}{2,}/u.test(n) && n.length <= 80);
    mustSee.push(...named.slice(0, 8));
    return ' ';
  });
  return { text: text.replace(/\s+/g, ' ').trim(), extras: { fixed, transportIn, mustSee } };
}

function annotate(piece: string): Annotated & StopExtras {
  const { text: stripped, extras } = extractExtras(piece);
  return { ...annotateCore(stripped), ...extras };
}

function annotateCore(piece: string): Annotated {
  let text = cleanPlace(piece);
  let dayTrip = false;
  const trip = /^(?:(?:a|one)\s+)?day[-\s]?trips?\s+(?:to\s+)?(.+)$/i.exec(text) ?? /^(.+?)\s*\(\s*day[-\s]?trip\s*\)$/i.exec(text) ?? /^(.+?)\s+(?:as\s+a\s+)?day[-\s]?trip$/i.exec(text);
  if (trip) {
    dayTrip = true;
    text = cleanPlace(trip[1]!);
  }
  const leading = new RegExp(String.raw`^${NUM}\s*${STAY_UNIT}\b\.?\s*(?:in|at|on|around|of|for)?\s+(.+)$`, 'i').exec(text);
  if (leading && toNumber(leading[1]) !== null) {
    return { label: cleanPlace(leading[3]!), count: toNumber(leading[1]), unit: unitOf(leading[2]), prep: null, dayTrip };
  }
  const paren = new RegExp(String.raw`^(.+?)\s*\(\s*(?:${NUM})\s*${STAY_UNIT}?\s*\)$`, 'i').exec(text);
  if (paren && toNumber(paren[2]) !== null) {
    return { label: cleanPlace(paren[1]!), count: toNumber(paren[2]), unit: unitOf(paren[3]) ?? 'night', prep: null, dayTrip };
  }
  const trailing = new RegExp(String.raw`^(.+?)(?:\s*[-–—:]\s*|\s+)(?:(for|in|over|across|within)\s+)?${NUM}\s*${STAY_UNIT}\b\.?$`, 'i').exec(text);
  if (trailing && toNumber(trailing[3]) !== null) {
    return { label: cleanPlace(trailing[1]!), count: toNumber(trailing[3]), unit: unitOf(trailing[4]), prep: trailing[2]?.toLowerCase() ?? null, dayTrip };
  }
  const times = /^(.+?)\s*[x×]\s*(\d{1,2})$/i.exec(text);
  if (times) return { label: cleanPlace(times[1]!), count: Number(times[2]), unit: 'night', prep: null, dayTrip };
  return { label: text, count: null, unit: null, prep: null, dayTrip };
}

/** The intent graph's reading of one place label: its kind and the country its own words carry. */
function classify(label: string): { kind: IntentNodeKind; countryCode?: string } {
  const graph = parseDestinationIntent(label);
  const only = graph.children.length === 1 ? graph.children[0]! : null;
  if (only) return { kind: only.kind, ...(only.countryCode ? { countryCode: only.countryCode } : {}) };
  return { kind: 'named_place', ...(graph.countries.length === 1 ? { countryCode: graph.countries[0]! } : {}) };
}

/* Words that are never a place on their own: what is left when a phrase around a place was read out ("for the"). */
const FUNCTION_WORDS = new Set(['for', 'the', 'with', 'and', 'a', 'an', 'of', 'us', 'we', 'me', 'my', 'our', 'in', 'to', 'then', 'also', 'plus', 'just']);
const looksLikePlace = (label: string): boolean => /\p{L}{2,}/u.test(label) && label.length <= 80 && label.split(/\s+/).length <= 8 && !label.toLowerCase().split(/\s+/).every((w) => FUNCTION_WORDS.has(w));

/* ------------------------------------------------------------------------- */
/* The two formats                                                            */
/* ------------------------------------------------------------------------- */

const DAY_LINE = /^\s*(?:days?|d)\s*(\d{1,2})(?:\s*(?:-|–|—|to|&|and)\s*(?:day\s*)?(\d{1,2}))?\s*[:.)\-–—]?\s*(.*)$/i;
const MOVE = /^(.+?)\s+(?:to|→|->|–>|=>|⟶)\s+(.+)$/i;

interface DayListReading {
  stops: { label: string; days: number; mustSee: string[]; fixed: boolean; transportIn: StatedTransportMode | null }[];
  totalDays: number;
}

/** "Day 1-3: Tokyo / Day 4: Tokyo to Kyoto / …": the place slept in each day, in order. */
function readDayList(lines: string[]): DayListReading | null {
  const marked = lines.map((line) => DAY_LINE.exec(line)).filter((m): m is RegExpExecArray => m !== null && m[3]!.trim().length > 0);
  if (marked.length < 2) return null;
  const days: { day: number; place: string; mustSee: string[]; fixed: boolean; transportIn: StatedTransportMode | null }[] = [];
  for (const m of marked) {
    const from = Number(m[1]);
    const to = m[2] ? Math.max(from, Number(m[2])) : from;
    const { text: body, extras } = extractExtras(m[3]!.trim());
    const move = MOVE.exec(body);
    const sleeping = move ? move[2]! : body;
    /* The base is the first named thing on the line; activities after a dash or a colon belong to it. */
    const parts = sleeping.split(/\s+[-–—]\s+|[,:;(]|\s+\+\s+/);
    const place = cleanPlace(parts[0] ?? sleeping);
    if (!looksLikePlace(place)) continue;
    const activities = parts.slice(1).map((a) => cleanPlace(a.replace(/\)$/, ''))).filter((a) => looksLikePlace(a) && a.toLowerCase() !== place.toLowerCase());
    for (let d = from; d <= Math.min(to, 60); d += 1) days.push({ day: d, place, mustSee: d === from ? [...extras.mustSee, ...activities] : [], fixed: extras.fixed, transportIn: d === from && move ? extras.transportIn : null });
  }
  if (days.length === 0) return null;
  days.sort((a, b) => a.day - b.day);
  const stops: DayListReading['stops'] = [];
  for (const { place, mustSee, fixed, transportIn } of days) {
    const last = stops[stops.length - 1];
    if (last && last.label.toLowerCase() === place.toLowerCase()) {
      last.days += 1;
      last.mustSee.push(...mustSee.filter((m) => !last.mustSee.includes(m)));
      last.fixed ||= fixed;
    } else stops.push({ label: place, days: 1, mustSee: [...mustSee], fixed, transportIn });
  }
  return { stops, totalDays: Math.max(...days.map((d) => d.day)) };
}

const SEGMENT = /\r?\n|;|→|->|=>|⟶|\s>\s|\bthen\b|\bafter\s+that\b|\bfollowed\s+by\b/i;
const PIECE = /\s*(?:,|&|\s\+\s|\s\/\s|\band\b)\s*/i;

/* ------------------------------------------------------------------------- */
/* Arrival, departure, who is going, and a stop's own dates                   */
/* ------------------------------------------------------------------------- */

function clockOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && !m[2]) return null;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const EDGE_PLACE = String.raw`([A-ZÀ-ɏ][\p{L}'’.\- ]{1,40}?)`;
const EDGE_TIME = String.raw`(?:\s+(?:at|around|by)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?`;

/** "Fly into Tokyo at 3pm", "fly home from Osaka": the edges, with the place left in the words as a stop. */
function readEdges(text: string): { text: string; arrival: ParsedPlanEdge | null; departure: ParsedPlanEdge | null } {
  let out = text;
  let arrival: ParsedPlanEdge | null = null;
  let departure: ParsedPlanEdge | null = null;
  const arrive = new RegExp(String.raw`\b(?:fly(?:ing)?\s+in(?:to)?|arriv(?:e|ing)\s+(?:in(?:to)?|at)|land(?:ing)?\s+(?:in|at))\s+${EDGE_PLACE}${EDGE_TIME}(?=\s*(?:[,.;:\n]|\bthen\b|$))`, 'iu').exec(out);
  if (arrive) {
    arrival = { place: arrive[1]!.trim(), time: clockOf(arrive[2]) };
    out = `${out.slice(0, arrive.index)}${arrive[1]!.trim()}${out.slice(arrive.index + arrive[0].length)}`;
  }
  const depart = new RegExp(String.raw`\b(?:fly(?:ing)?\s+(?:home\s+|back\s+)?(?:out\s+of|from)|depart(?:ing)?\s+(?:from\s+)?|leav(?:e|ing)\s+from)\s+${EDGE_PLACE}${EDGE_TIME}(?=\s*(?:[,.;:\n]|$))`, 'iu').exec(out);
  if (depart) {
    departure = { place: depart[1]!.trim(), time: clockOf(depart[2]) };
    out = `${out.slice(0, depart.index)}${depart[1]!.trim()}${out.slice(depart.index + depart[0].length)}`;
  }
  return { text: out, arrival, departure };
}

const PARTY_PHRASES: readonly RegExp[] = [
  /\b(?:(?:for|with)\s+)?(?:just\s+)?(?:the\s+)?two\s+of\s+us\b|\bas\s+a\s+couple\b|\b(?:for\s+)?our\s+honeymoon\b/gi,
  /\b(?:for|with)?\s*(?:my|our|the)?\s*family\s+of\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
  /\b(?:with|and|plus)\s+(?:my|our|the)?\s*(?:\d{1,2}|one|two|three|four|five|six)?\s*(?:kids|children|little ones|toddlers?|teens|teenagers)\b/gi,
  /\b(?:travell?ing\s+)?(?:solo|by myself|on my own|just me)\b/gi,
  /\b(?:for\s+(?:the\s+)?)?(?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of us|people|persons|adults|friends|travell?ers)\b/gi,
  /\b(?:with\s+)?my\s+(?:partner|wife|husband|girlfriend|boyfriend|fianc[ée]e?)\b/gi,
];

/** Who is going is not a place: their words about the party come out before the list is read. */
function stripParty(text: string): string {
  let out = text;
  for (const re of PARTY_PHRASES) out = out.replace(re, ' ');
  return out;
}

/** A date range written against one stop ("Kyoto 3–6 April"), taken out of its words. */
function readStopDates(piece: string, now: Date): { text: string; dates: { start: string; end: string } | null } {
  const span: Span = { text: piece };
  const read = readDates(span, now);
  if (read.startDate && read.endDate) return { text: span.text, dates: { start: read.startDate, end: read.endDate } };
  return { text: piece, dates: null };
}

/* ------------------------------------------------------------------------- */
/* The reading                                                                */
/* ------------------------------------------------------------------------- */

export function parsePlanText(raw: string, now: Date = new Date()): ParsedPlan {
  const text = String(raw ?? '').slice(0, PLAN_TEXT_MAX).replace(/\u00a0/g, ' ');
  const { body: asked, question } = splitQuestion(text);
  const party = readPartyFromText(text);
  const edges = readEdges(stripParty(asked));
  /* A full stop between sentences ends a segment ("Fly into Rome. 3 nights in Rome…"); "St. Moritz" does not. */
  const body = protectBrackets(edges.text).replace(/(?<!\b(?:St|Mt|Ste|Ft|Pt|Mr|Dr|no))\.\s+(?=[A-Z0-9])/g, '\n');
  /* Two or more stops carrying their own date ranges: the dates are per stop, and the trip runs from the first to the last. */
  const perStopDates = body.split(SEGMENT).flatMap((seg) => seg.split(PIECE)).filter((piece) => readStopDates(piece, now).dates !== null).length >= 2;
  const span: Span = { text: body };
  const dates = perStopDates ? { startDate: null, endDate: null, month: null } : readDates(span, now);
  const length = readUnambiguousLength(span);
  const notes: string[] = [];
  const contextCountries = new Set<string>();
  if (length.context) for (const hit of countriesInText(length.context)) contextCountries.add(hit.facts.code);

  let totalNights: number | null = null;
  let totalBasis: PlanTotalBasis | null = null;
  if (dates.startDate && dates.endDate) {
    totalNights = nightsBetween(dates.startDate, dates.endDate);
    totalBasis = totalNights !== null ? 'dates' : null;
  }
  if (totalNights === null && length.totalNights !== null) {
    totalNights = length.totalNights;
    totalBasis = length.totalBasis;
  }

  const cleaned = stripFiller(span.text);
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dayList = readDayList(lines);

  let stops: ParsedPlanStop[] = [];
  let format: ParsedPlan['format'] = 'list';

  if (dayList) {
    format = 'day_list';
    stops = dayList.stops.map((stop, index) => {
      const last = index === dayList.stops.length - 1;
      /* A day you wake up in a place is a night there, except the last day, which is the day you leave. */
      const nights = last ? Math.max(0, stop.days - 1) : stop.days;
      return { label: stop.label, nights, nightsBasis: 'day_list' as const, dayTrip: false, ...classify(stop.label), fixed: stop.fixed, mustSee: stop.mustSee.slice(0, 8), transportIn: stop.transportIn, dates: null };
    });
    if (totalNights === null) {
      totalNights = Math.max(0, dayList.totalDays - 1);
      totalBasis = 'day_list';
    }
  } else {
    const annotated: (Annotated & StopExtras & { dates: { start: string; end: string } | null })[] = [];
    for (const segment of cleaned.split(SEGMENT)) {
      for (const rawPiece of segment.split(PIECE)) {
        if (!rawPiece.trim()) continue;
        const stopDates = readStopDates(rawPiece, now);
        const reading = { ...annotate(stopDates.text), dates: stopDates.dates };
        if (stopDates.dates && reading.count === null && !reading.dayTrip) {
          reading.count = nightsBetween(stopDates.dates.start, stopDates.dates.end);
          reading.unit = 'night';
        }
        if (!reading.label && reading.count !== null && totalNights === null) {
          /* "…, 10 days" on its own: the trip's length, not a place. */
          totalNights = reading.unit === 'day' ? Math.max(0, reading.count - 1) : reading.count;
          totalBasis = reading.unit === 'day' ? 'days' : 'nights';
          continue;
        }
        if (looksLikePlace(reading.label)) annotated.push(reading);
      }
    }
    /*
     * "…, Osaka and Hokkaido in 10 days": a single trailing count with "in" or
     * "for" on the last place, and no other place counted, is the trip's length.
     */
    const counted = annotated.filter((a) => a.count !== null);
    const last = annotated[annotated.length - 1];
    if (annotated.length > 1 && counted.length === 1 && last && last.count !== null && last.prep && totalNights === null) {
      totalNights = last.unit === 'day' ? Math.max(0, last.count - 1) : last.count;
      totalBasis = last.unit === 'day' ? 'days' : 'nights';
      last.count = null;
      last.unit = null;
    }
    const places = annotated.map((a) => ({ ...a, ...classify(a.label) }));
    const nonCountry = places.filter((p) => p.kind !== 'country');
    for (const place of places) {
      /* A country beside cities is the list's context ("…, Japan"); a list of countries is the trip. */
      if (place.kind === 'country' && nonCountry.length > 0) {
        if (place.countryCode) contextCountries.add(place.countryCode);
        continue;
      }
      stops.push({
        label: place.label,
        nights: place.dayTrip ? 0 : place.count,
        nightsBasis: place.dayTrip ? 'stated' : place.count === null ? null : place.unit === 'day' ? 'days_stated' : 'stated',
        dayTrip: place.dayTrip,
        kind: place.kind,
        ...(place.countryCode ? { countryCode: place.countryCode } : {}),
        fixed: place.fixed,
        mustSee: place.mustSee,
        transportIn: place.transportIn,
        dates: place.dates,
      });
    }
  }

  /* The same place twice in a row is one stay. */
  const merged: ParsedPlanStop[] = [];
  for (const stop of stops) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.dayTrip && !stop.dayTrip && prev.label.toLowerCase() === stop.label.toLowerCase()) {
      prev.nights = prev.nights === null && stop.nights === null ? null : (prev.nights ?? 0) + (stop.nights ?? 0);
      prev.nightsBasis ??= stop.nightsBasis;
      prev.transportIn ??= stop.transportIn;
      prev.fixed ||= stop.fixed;
      prev.mustSee = [...new Set([...prev.mustSee, ...stop.mustSee])].slice(0, 8);
      continue;
    }
    merged.push({ ...stop, mustSee: [...stop.mustSee] });
  }
  stops = merged.slice(0, PLAN_MAX_STOPS);
  if (merged.length > PLAN_MAX_STOPS) notes.push(`Only the first ${PLAN_MAX_STOPS} places were read; a plan longer than that is easier to check in parts.`);

  for (const stop of stops) if (!stop.countryCode && contextCountries.size === 1) stop.countryCode = [...contextCountries][0]!;

  /* ---- reconcile the trip's length with the nights per place ---- */
  const beds = stops.filter((s) => !s.dayTrip);
  const stated = beds.filter((s) => s.nights !== null);
  const statedSum = stated.reduce((n, s) => n + (s.nights ?? 0), 0);
  if (totalNights === null && beds.length > 0 && stated.length === beds.length) {
    totalNights = statedSum;
    totalBasis = 'sum_of_stops';
  } else if (totalNights !== null && stated.length < beds.length) {
    const open = beds.filter((s) => s.nights === null);
    const remaining = totalNights - statedSum;
    if (remaining >= open.length) {
      const each = Math.floor(remaining / open.length);
      let extra = remaining - each * open.length;
      for (const stop of open) {
        stop.nights = each + (extra > 0 ? 1 : 0);
        extra -= 1;
        stop.nightsBasis = 'spread';
      }
    } else {
      notes.push(`The nights you gave already fill ${statedSum} of ${totalNights} nights, which leaves less than one each for ${open.map((s) => s.label).join(', ')}.`);
    }
  } else if (totalNights !== null && stated.length === beds.length && statedSum !== totalNights && totalBasis !== 'day_list') {
    notes.push(`Your places add up to ${statedSum} night${statedSum === 1 ? '' : 's'}, but the trip is ${totalNights} night${totalNights === 1 ? '' : 's'}.`);
  }

  /* Per-stop dates make the trip's own: first arrival to last departure. */
  let startDate = dates.startDate;
  let endDate = dates.endDate;
  if (perStopDates) {
    const dated = stops.filter((s) => s.dates);
    const first = dated[0]?.dates?.start ?? null;
    const last = dated[dated.length - 1]?.dates?.end ?? null;
    if (first && last && nightsBetween(first, last)) {
      startDate = first;
      endDate = last;
      if (totalBasis !== 'dates') {
        totalNights = nightsBetween(first, last);
        totalBasis = 'dates';
      }
    }
  }

  /* How much was understood: every place counts, and a place with nights of its own counts twice. */
  const bedsRead = stops.filter((s) => !s.dayTrip);
  const own = bedsRead.filter((s) => s.nightsBasis !== null && s.nightsBasis !== 'spread').length;
  const confidence = stops.length === 0 ? 0 : Math.max(0.2, Math.min(1, 0.4 + (bedsRead.length > 0 ? 0.5 * (own / bedsRead.length) : 0.3) + (totalNights !== null ? 0.1 : 0) - 0.1 * notes.length));

  for (const stop of stops) stop.mustSee = stop.mustSee.map((m) => restoreBrackets(m));

  return {
    stops,
    totalNights,
    totalBasis,
    startDate,
    endDate,
    month: dates.month,
    contextCountries: [...contextCountries],
    question,
    format,
    notes,
    arrival: edges.arrival,
    departure: edges.departure,
    party,
    confidence: Math.round(confidence * 100) / 100,
  };
}
