/**
 * PRACTICAL COUNTRY METADATA — BUNDLED REFERENCE DATA, NEVER THE MODEL.
 *
 * Stable, slow-changing facts a traveller needs before they go: currency,
 * languages, which side of the road, the emergency number, plug types and
 * voltage, the calling code, time zones. These change on the order of years
 * and are public reference facts, so they ship with the app rather than
 * costing a runtime dependency or a provider call.
 *
 * Provenance: compiled from public reference sources — ISO 3166 / ISO 4217
 * code lists, the IEC world plugs list (iec.ch/world-plugs), ITU country
 * calling codes, and Wikipedia's "Left- and right-hand traffic" and
 * "List of emergency telephone numbers" reference tables — as of 2026-09.
 * Facts, not creative content; no licence text travels with them. Everything
 * here is *reference*: the readiness layer labels it as such and still points
 * at the official source for anything regulatory. Unknown country ⇒ null, and
 * the product says so rather than guessing.
 */
export interface CountryFacts {
  code: string;
  name: string;
  currency: string;
  /** ISO 639-1 codes, most widely used first. */
  languages: string[];
  drivingSide: 'left' | 'right';
  /** The general emergency number to dial; secondary numbers in `emergencyNotes`. */
  emergency: string;
  emergencyNotes?: string;
  /** IEC plug letters. */
  plugs: string[];
  voltage: number;
  callingCode: string;
  /** IANA zone for the main populated area. */
  timeZone: string;
}

const C = (code: string, name: string, currency: string, languages: string[], drivingSide: 'left' | 'right', emergency: string, plugs: string[], voltage: number, callingCode: string, timeZone: string, emergencyNotes?: string): CountryFacts => ({ code, name, currency, languages, drivingSide, emergency, plugs, voltage, callingCode, timeZone, ...(emergencyNotes ? { emergencyNotes } : {}) });

export const COUNTRY_FACTS: readonly CountryFacts[] = [
  C('IE', 'Ireland', 'EUR', ['en', 'ga'], 'left', '112', ['G'], 230, '+353', 'Europe/Dublin', '999 also works'),
  C('GB', 'United Kingdom', 'GBP', ['en'], 'left', '999', ['G'], 230, '+44', 'Europe/London', '112 also works'),
  C('US', 'United States', 'USD', ['en', 'es'], 'right', '911', ['A', 'B'], 120, '+1', 'America/New_York'),
  C('CA', 'Canada', 'CAD', ['en', 'fr'], 'right', '911', ['A', 'B'], 120, '+1', 'America/Toronto'),
  C('MX', 'Mexico', 'MXN', ['es'], 'right', '911', ['A', 'B'], 127, '+52', 'America/Mexico_City'),
  C('FR', 'France', 'EUR', ['fr'], 'right', '112', ['C', 'E'], 230, '+33', 'Europe/Paris'),
  C('DE', 'Germany', 'EUR', ['de'], 'right', '112', ['C', 'F'], 230, '+49', 'Europe/Berlin'),
  C('ES', 'Spain', 'EUR', ['es', 'ca', 'gl', 'eu'], 'right', '112', ['C', 'F'], 230, '+34', 'Europe/Madrid'),
  C('PT', 'Portugal', 'EUR', ['pt'], 'right', '112', ['C', 'F'], 230, '+351', 'Europe/Lisbon'),
  C('IT', 'Italy', 'EUR', ['it'], 'right', '112', ['C', 'F', 'L'], 230, '+39', 'Europe/Rome'),
  C('NL', 'Netherlands', 'EUR', ['nl'], 'right', '112', ['C', 'F'], 230, '+31', 'Europe/Amsterdam'),
  C('BE', 'Belgium', 'EUR', ['nl', 'fr', 'de'], 'right', '112', ['C', 'E'], 230, '+32', 'Europe/Brussels'),
  C('AT', 'Austria', 'EUR', ['de'], 'right', '112', ['C', 'F'], 230, '+43', 'Europe/Vienna'),
  C('CH', 'Switzerland', 'CHF', ['de', 'fr', 'it', 'rm'], 'right', '112', ['C', 'J'], 230, '+41', 'Europe/Zurich'),
  C('GR', 'Greece', 'EUR', ['el'], 'right', '112', ['C', 'F'], 230, '+30', 'Europe/Athens'),
  C('HR', 'Croatia', 'EUR', ['hr'], 'right', '112', ['C', 'F'], 230, '+385', 'Europe/Zagreb'),
  C('SI', 'Slovenia', 'EUR', ['sl'], 'right', '112', ['C', 'F'], 230, '+386', 'Europe/Ljubljana'),
  C('CZ', 'Czechia', 'CZK', ['cs'], 'right', '112', ['C', 'E'], 230, '+420', 'Europe/Prague'),
  C('PL', 'Poland', 'PLN', ['pl'], 'right', '112', ['C', 'E'], 230, '+48', 'Europe/Warsaw'),
  C('HU', 'Hungary', 'HUF', ['hu'], 'right', '112', ['C', 'F'], 230, '+36', 'Europe/Budapest'),
  C('IS', 'Iceland', 'ISK', ['is'], 'right', '112', ['C', 'F'], 230, '+354', 'Atlantic/Reykjavik'),
  C('NO', 'Norway', 'NOK', ['no'], 'right', '112', ['C', 'F'], 230, '+47', 'Europe/Oslo', '113 ambulance, 110 fire'),
  C('SE', 'Sweden', 'SEK', ['sv'], 'right', '112', ['C', 'F'], 230, '+46', 'Europe/Stockholm'),
  C('DK', 'Denmark', 'DKK', ['da'], 'right', '112', ['C', 'K', 'E'], 230, '+45', 'Europe/Copenhagen'),
  C('FI', 'Finland', 'EUR', ['fi', 'sv'], 'right', '112', ['C', 'F'], 230, '+358', 'Europe/Helsinki'),
  C('EE', 'Estonia', 'EUR', ['et'], 'right', '112', ['C', 'F'], 230, '+372', 'Europe/Tallinn'),
  C('TR', 'Türkiye', 'TRY', ['tr'], 'right', '112', ['C', 'F'], 230, '+90', 'Europe/Istanbul'),
  C('MA', 'Morocco', 'MAD', ['ar', 'fr'], 'right', '19', ['C', 'E'], 220, '+212', 'Africa/Casablanca', '15 ambulance and fire'),
  C('EG', 'Egypt', 'EGP', ['ar'], 'right', '122', ['C', 'F'], 220, '+20', 'Africa/Cairo', '123 ambulance'),
  C('ZA', 'South Africa', 'ZAR', ['en', 'zu', 'xh', 'af'], 'left', '10111', ['M', 'C', 'N'], 230, '+27', 'Africa/Johannesburg', '112 from mobiles'),
  C('KE', 'Kenya', 'KES', ['sw', 'en'], 'left', '999', ['G'], 240, '+254', 'Africa/Nairobi', '112 also works'),
  C('TZ', 'Tanzania', 'TZS', ['sw', 'en'], 'left', '112', ['D', 'G'], 230, '+255', 'Africa/Dar_es_Salaam'),
  C('NA', 'Namibia', 'NAD', ['en', 'af', 'de'], 'left', '10111', ['D', 'M'], 220, '+264', 'Africa/Windhoek'),
  C('BW', 'Botswana', 'BWP', ['en', 'tn'], 'left', '999', ['D', 'G', 'M'], 230, '+267', 'Africa/Gaborone'),
  C('RW', 'Rwanda', 'RWF', ['rw', 'en', 'fr'], 'right', '112', ['C', 'J'], 230, '+250', 'Africa/Kigali'),
  C('UG', 'Uganda', 'UGX', ['en', 'sw'], 'left', '999', ['G'], 240, '+256', 'Africa/Kampala', '112 from mobiles'),
  C('KG', 'Kyrgyzstan', 'KGS', ['ky', 'ru'], 'right', '112', ['C', 'F'], 220, '+996', 'Asia/Bishkek', '103 ambulance'),
  C('JP', 'Japan', 'JPY', ['ja'], 'left', '110', ['A', 'B'], 100, '+81', 'Asia/Tokyo', '119 ambulance and fire'),
  C('KR', 'South Korea', 'KRW', ['ko'], 'right', '112', ['C', 'F'], 220, '+82', 'Asia/Seoul', '119 ambulance and fire'),
  C('CN', 'China', 'CNY', ['zh'], 'right', '110', ['A', 'C', 'I'], 220, '+86', 'Asia/Shanghai', '120 ambulance, 119 fire'),
  C('TW', 'Taiwan', 'TWD', ['zh'], 'right', '110', ['A', 'B'], 110, '+886', 'Asia/Taipei', '119 ambulance and fire'),
  C('HK', 'Hong Kong', 'HKD', ['zh', 'en'], 'left', '999', ['G'], 220, '+852', 'Asia/Hong_Kong'),
  C('SG', 'Singapore', 'SGD', ['en', 'ms', 'zh', 'ta'], 'left', '999', ['G'], 230, '+65', 'Asia/Singapore', '995 ambulance and fire'),
  C('MY', 'Malaysia', 'MYR', ['ms', 'en'], 'left', '999', ['G'], 240, '+60', 'Asia/Kuala_Lumpur'),
  C('TH', 'Thailand', 'THB', ['th'], 'left', '191', ['A', 'B', 'C', 'O'], 220, '+66', 'Asia/Bangkok', '1669 ambulance, 1155 tourist police'),
  C('VN', 'Vietnam', 'VND', ['vi'], 'right', '113', ['A', 'C', 'G'], 220, '+84', 'Asia/Ho_Chi_Minh', '115 ambulance, 114 fire'),
  C('KH', 'Cambodia', 'KHR', ['km'], 'right', '117', ['A', 'C', 'G'], 230, '+855', 'Asia/Phnom_Penh', '119 ambulance'),
  C('ID', 'Indonesia', 'IDR', ['id'], 'left', '112', ['C', 'F'], 230, '+62', 'Asia/Jakarta'),
  C('PH', 'Philippines', 'PHP', ['fil', 'en'], 'right', '911', ['A', 'B', 'C'], 220, '+63', 'Asia/Manila'),
  C('IN', 'India', 'INR', ['hi', 'en'], 'left', '112', ['C', 'D', 'M'], 230, '+91', 'Asia/Kolkata'),
  C('LK', 'Sri Lanka', 'LKR', ['si', 'ta', 'en'], 'left', '119', ['D', 'G'], 230, '+94', 'Asia/Colombo', '1990 ambulance'),
  C('NP', 'Nepal', 'NPR', ['ne'], 'left', '100', ['C', 'D', 'M'], 230, '+977', 'Asia/Kathmandu', '102 ambulance'),
  C('AE', 'United Arab Emirates', 'AED', ['ar', 'en'], 'right', '999', ['G'], 230, '+971', 'Asia/Dubai', '998 ambulance'),
  C('JO', 'Jordan', 'JOD', ['ar'], 'right', '911', ['C', 'D', 'F', 'G', 'J'], 230, '+962', 'Asia/Amman'),
  C('IL', 'Israel', 'ILS', ['he', 'ar'], 'right', '100', ['C', 'H'], 230, '+972', 'Asia/Jerusalem', '101 ambulance'),
  C('AU', 'Australia', 'AUD', ['en'], 'left', '000', ['I'], 230, '+61', 'Australia/Sydney', '112 from mobiles'),
  C('NZ', 'New Zealand', 'NZD', ['en', 'mi'], 'left', '111', ['I'], 230, '+64', 'Pacific/Auckland'),
  C('FJ', 'Fiji', 'FJD', ['en', 'fj'], 'left', '911', ['I'], 240, '+679', 'Pacific/Fiji'),
  C('BR', 'Brazil', 'BRL', ['pt'], 'right', '190', ['C', 'N'], 127, '+55', 'America/Sao_Paulo', '192 ambulance; 220 V in some states'),
  C('AR', 'Argentina', 'ARS', ['es'], 'right', '911', ['C', 'I'], 220, '+54', 'America/Argentina/Buenos_Aires', '107 ambulance'),
  C('CL', 'Chile', 'CLP', ['es'], 'right', '133', ['C', 'L'], 220, '+56', 'America/Santiago', '131 ambulance'),
  C('PE', 'Peru', 'PEN', ['es', 'qu'], 'right', '105', ['A', 'B', 'C'], 220, '+51', 'America/Lima', '116 ambulance'),
  C('CO', 'Colombia', 'COP', ['es'], 'right', '123', ['A', 'B'], 110, '+57', 'America/Bogota'),
  C('EC', 'Ecuador', 'USD', ['es'], 'right', '911', ['A', 'B'], 120, '+593', 'America/Guayaquil'),
  C('CR', 'Costa Rica', 'CRC', ['es'], 'right', '911', ['A', 'B'], 120, '+506', 'America/Costa_Rica'),
  C('PA', 'Panama', 'USD', ['es'], 'right', '911', ['A', 'B'], 120, '+507', 'America/Panama'),
  C('CU', 'Cuba', 'CUP', ['es'], 'right', '106', ['A', 'B', 'C', 'L'], 110, '+53', 'America/Havana', '104 ambulance'),
  C('DO', 'Dominican Republic', 'DOP', ['es'], 'right', '911', ['A', 'B'], 120, '+1', 'America/Santo_Domingo'),
  C('JM', 'Jamaica', 'JMD', ['en'], 'left', '119', ['A', 'B'], 110, '+1', 'America/Jamaica', '110 ambulance and fire'),
];

const BY_CODE = new Map(COUNTRY_FACTS.map((c) => [c.code, c] as const));

export function countryFacts(code: string | undefined | null): CountryFacts | null {
  if (!code) return null;
  return BY_CODE.get(code.toUpperCase()) ?? null;
}

/** The published reference point for a country code, or null for a country the app holds no point for. */
export function countryPointFor(code: string | undefined | null): CountryPoint | null {
  if (!code) return null;
  return COUNTRY_POINTS[code.toUpperCase()] ?? null;
}

/**
 * WHERE A COUNTRY IS, WELL ENOUGH TO PLACE IT ON A MAP AND READ ITS SEASONS.
 *
 * A separate table from the facts above, and separate on purpose: these are
 * coordinates rather than reference facts, they are used by exactly one code path
 * (placing a typed destination before any provider has been asked), and keeping
 * them apart means the sixty-nine rows above did not have to be edited to add
 * them.
 *
 * **What the point is.** The main populated area — the same basis as `timeZone`
 * in the row above, and for the same reason: a country's geometric centroid is
 * frequently in the sea or in a desert nobody visits, and a climate record read
 * there would describe a place the traveller is not going. So the point is a real
 * city, it is named, and the name travels with it so that anything derived from
 * it can say where it was read.
 *
 * **What it is not.** It is not an extent. A country-scale frame drawn from one
 * point is a display decision made where maps are drawn, not a boundary asserted
 * here. And it is not a substitute for resolution: the moment a geocoder or the
 * destination index answers, its published centre and bounds win, because those
 * are measurements of the destination and this is a landmark inside it.
 *
 * Provenance: city coordinates from public reference tables, rounded to two
 * decimal places (about a kilometre), as of 2026-09. Facts, not creative content.
 */
export interface CountryPoint {
  lat: number;
  lng: number;
  /** The populated place the coordinate names, so a derived answer can say where it was read. */
  place: string;
}

const P = (lat: number, lng: number, place: string): CountryPoint => ({ lat, lng, place });

export const COUNTRY_POINTS: Readonly<Record<string, CountryPoint>> = {
  IE: P(53.35, -6.26, 'Dublin'),
  GB: P(51.51, -0.13, 'London'),
  US: P(40.71, -74.01, 'New York'),
  CA: P(43.65, -79.38, 'Toronto'),
  MX: P(19.43, -99.13, 'Mexico City'),
  FR: P(48.86, 2.35, 'Paris'),
  DE: P(52.52, 13.4, 'Berlin'),
  ES: P(40.42, -3.7, 'Madrid'),
  PT: P(38.72, -9.14, 'Lisbon'),
  IT: P(41.9, 12.5, 'Rome'),
  NL: P(52.37, 4.9, 'Amsterdam'),
  BE: P(50.85, 4.35, 'Brussels'),
  AT: P(48.21, 16.37, 'Vienna'),
  CH: P(47.38, 8.54, 'Zurich'),
  GR: P(37.98, 23.73, 'Athens'),
  HR: P(45.81, 15.98, 'Zagreb'),
  SI: P(46.06, 14.51, 'Ljubljana'),
  CZ: P(50.08, 14.44, 'Prague'),
  PL: P(52.23, 21.01, 'Warsaw'),
  HU: P(47.5, 19.04, 'Budapest'),
  IS: P(64.15, -21.94, 'Reykjavík'),
  NO: P(59.91, 10.75, 'Oslo'),
  SE: P(59.33, 18.07, 'Stockholm'),
  DK: P(55.68, 12.57, 'Copenhagen'),
  FI: P(60.17, 24.94, 'Helsinki'),
  EE: P(59.44, 24.75, 'Tallinn'),
  TR: P(41.01, 28.98, 'Istanbul'),
  MA: P(33.57, -7.59, 'Casablanca'),
  EG: P(30.04, 31.24, 'Cairo'),
  ZA: P(-26.2, 28.05, 'Johannesburg'),
  KE: P(-1.29, 36.82, 'Nairobi'),
  TZ: P(-6.79, 39.21, 'Dar es Salaam'),
  NA: P(-22.56, 17.08, 'Windhoek'),
  BW: P(-24.63, 25.92, 'Gaborone'),
  RW: P(-1.94, 30.06, 'Kigali'),
  UG: P(0.35, 32.58, 'Kampala'),
  KG: P(42.87, 74.6, 'Bishkek'),
  JP: P(35.68, 139.69, 'Tokyo'),
  KR: P(37.57, 126.98, 'Seoul'),
  CN: P(39.9, 116.41, 'Beijing'),
  TW: P(25.03, 121.57, 'Taipei'),
  HK: P(22.32, 114.17, 'Hong Kong'),
  SG: P(1.35, 103.82, 'Singapore'),
  MY: P(3.14, 101.69, 'Kuala Lumpur'),
  TH: P(13.76, 100.5, 'Bangkok'),
  VN: P(21.03, 105.85, 'Hanoi'),
  KH: P(11.56, 104.92, 'Phnom Penh'),
  ID: P(-6.21, 106.85, 'Jakarta'),
  PH: P(14.6, 120.98, 'Manila'),
  IN: P(28.61, 77.21, 'Delhi'),
  LK: P(6.93, 79.86, 'Colombo'),
  NP: P(27.72, 85.32, 'Kathmandu'),
  AE: P(25.2, 55.27, 'Dubai'),
  JO: P(31.95, 35.93, 'Amman'),
  IL: P(32.09, 34.78, 'Tel Aviv'),
  AU: P(-33.87, 151.21, 'Sydney'),
  NZ: P(-36.85, 174.76, 'Auckland'),
  FJ: P(-18.14, 178.44, 'Suva'),
  BR: P(-23.55, -46.63, 'São Paulo'),
  AR: P(-34.6, -58.38, 'Buenos Aires'),
  CL: P(-33.45, -70.67, 'Santiago'),
  PE: P(-12.05, -77.04, 'Lima'),
  CO: P(4.71, -74.07, 'Bogotá'),
  EC: P(-0.18, -78.47, 'Quito'),
  CR: P(9.93, -84.08, 'San José'),
  PA: P(8.98, -79.52, 'Panama City'),
  CU: P(23.11, -82.37, 'Havana'),
  DO: P(18.49, -69.93, 'Santo Domingo'),
  JM: P(17.97, -76.79, 'Kingston'),
};

/**
 * Everyday names for a country that are not the name in the table.
 *
 * Kept small and unambiguous on purpose. Every entry is a name a person would
 * reasonably type for the *whole* country; a constituent nation or a region is
 * not listed here, because placing "Bavaria" on Berlin would be answering a
 * different question from the one asked.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  usa: 'US',
  us: 'US',
  america: 'US',
  'united states of america': 'US',
  uk: 'GB',
  britain: 'GB',
  'great britain': 'GB',
  'united kingdom of great britain and northern ireland': 'GB',
  holland: 'NL',
  'the netherlands': 'NL',
  'czech republic': 'CZ',
  turkey: 'TR',
  korea: 'KR',
  'republic of korea': 'KR',
  uae: 'AE',
  emirates: 'AE',
  'united arab emirates': 'AE',
  'kyrgyz republic': 'KG',
  'hong kong sar': 'HK',
  'the philippines': 'PH',
  'the gambia': 'GM',
  vietnam: 'VN',
  'viet nam': 'VN',
  'peoples republic of china': 'CN',
  'mainland china': 'CN',
  'costa rica': 'CR',
  'south korea': 'KR',
};

function foldPlain(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .toLowerCase()
    .trim();
}

const BY_FOLDED_NAME = new Map<string, string>();
for (const country of COUNTRY_FACTS) BY_FOLDED_NAME.set(foldPlain(country.name), country.code);
for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) BY_FOLDED_NAME.set(foldPlain(alias), code);

/** How many words a phrase may hold before a country name inside it stops being what the phrase is about. */
const MAX_PHRASE_WORDS = 6;

export interface CountryMatch {
  facts: CountryFacts;
  point: CountryPoint;
  /** `name` when the whole string is the country; `phrase` when it was one word inside a longer answer. */
  how: 'name' | 'phrase';
}

/**
 * A country, from whatever a person typed — or null, which is a real answer.
 *
 * Two passes, and the second is why "rural Japan" and "the steppes of
 * Kyrgyzstan" place correctly without either being a case in the code:
 *
 * 1. **The whole string is a country**, by name or by an everyday alias.
 * 2. **A country name appears inside a short phrase**, and exactly one does. Two
 *    matches is an ambiguity, not a resolution, and returns null. A long phrase is
 *    not about a country either — six words is where "the steppes of Kyrgyzstan"
 *    fits and a sentence does not.
 *
 * Nothing here knows a destination. Both passes are the same table lookup, and a
 * country that is not in the table returns null so that the caller falls through
 * to a provider that might know it.
 */
export function countryFromText(text: string | null | undefined): CountryMatch | null {
  if (!text) return null;
  const folded = foldPlain(text);
  if (!folded) return null;

  const direct = BY_FOLDED_NAME.get(folded) ?? BY_FOLDED_NAME.get(folded.replace(/^the /, ''));
  if (direct) {
    const match = built(direct, 'name');
    if (match) return match;
  }

  const words = folded.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > MAX_PHRASE_WORDS) return null;

  /* Every window of the phrase, longest first, so "south korea" beats "korea". */
  const hits = new Set<string>();
  for (let size = Math.min(words.length, 4); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const code = BY_FOLDED_NAME.get(words.slice(start, start + size).join(' '));
      if (code) hits.add(code);
    }
    if (hits.size > 0) break;
  }
  if (hits.size !== 1) return null;
  return built([...hits][0]!, 'phrase');
}

/**
 * V7 — EVERY COUNTRY NAMED IN A PHRASE, IN THE ORDER THEY APPEAR.
 *
 * `countryFromText` answers "which one country is this phrase about" and is
 * right to refuse when two are named. A phrase that names two is not nothing:
 * "Kenya and Tanzania" is a two-country trip, and the destination intent
 * graph needs every hit with the words it occupied, longest window first and
 * never overlapping, so that "south korea" is one hit and not "korea" twice.
 * Pure; the same table lookup as `countryFromText`.
 */
export interface CountryHit extends CountryMatch {
  /** The folded words of the phrase this hit occupies, first index inclusive, last exclusive. */
  wordSpan: [number, number];
}

export function countriesInText(text: string | null | undefined): CountryHit[] {
  if (!text) return [];
  const folded = foldPlain(text);
  if (!folded) return [];
  const words = folded.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > MAX_PHRASE_WORDS * 3) return [];
  const taken = new Array<boolean>(words.length).fill(false);
  const hits: CountryHit[] = [];
  for (let size = Math.min(words.length, 4); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      if (taken.slice(start, start + size).some(Boolean)) continue;
      const window = words.slice(start, start + size).join(' ');
      const code = BY_FOLDED_NAME.get(window) ?? (size > 1 && words[start] === 'the' ? BY_FOLDED_NAME.get(words.slice(start + 1, start + size).join(' ')) : undefined);
      if (!code) continue;
      const match = built(code, size === words.length ? 'name' : 'phrase');
      if (!match) continue;
      for (let i = start; i < start + size; i += 1) taken[i] = true;
      hits.push({ ...match, wordSpan: [start, start + size] });
    }
  }
  return hits.sort((a, b) => a.wordSpan[0] - b.wordSpan[0]);
}

/**
 * NATIONALITY ADJECTIVES → COUNTRY CODES. Reference data beside the country
 * table it points into: "Chilean and Argentine Patagonia" and "Scottish
 * Highlands" attach a country to a landscape without the landscape's own name
 * meaning anything to any code.
 */
export const DEMONYM_COUNTRIES: Readonly<Record<string, string>> = {
  chilean: 'CL', argentine: 'AR', argentinian: 'AR', peruvian: 'PE', brazilian: 'BR', colombian: 'CO', mexican: 'MX', costa: 'CR',
  scottish: 'GB', english: 'GB', welsh: 'GB', british: 'GB', irish: 'IE', french: 'FR', spanish: 'ES', portuguese: 'PT', italian: 'IT', german: 'DE', austrian: 'AT', swiss: 'CH', dutch: 'NL', belgian: 'BE', greek: 'GR', croatian: 'HR', slovenian: 'SI', czech: 'CZ', polish: 'PL', hungarian: 'HU', icelandic: 'IS', norwegian: 'NO', swedish: 'SE', danish: 'DK', finnish: 'FI', turkish: 'TR', moroccan: 'MA', egyptian: 'EG',
  kenyan: 'KE', tanzanian: 'TZ', namibian: 'NA', botswanan: 'BW', rwandan: 'RW', ugandan: 'UG', 'south african': 'ZA',
  japanese: 'JP', korean: 'KR', chinese: 'CN', taiwanese: 'TW', thai: 'TH', vietnamese: 'VN', cambodian: 'KH', indonesian: 'ID', balinese: 'ID', filipino: 'PH', malaysian: 'MY', indian: 'IN', nepalese: 'NP', nepali: 'NP', 'sri lankan': 'LK', jordanian: 'JO', israeli: 'IL', emirati: 'AE', kyrgyz: 'KG',
  australian: 'AU', 'new zealand': 'NZ', kiwi: 'NZ', fijian: 'FJ', american: 'US', canadian: 'CA', alaskan: 'US', hawaiian: 'US', californian: 'US',
};


export function isDemonym(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(DEMONYM_COUNTRIES, word.toLowerCase());
}

/** The country a nationality word in the phrase points at, or null. */
export function countryFromDemonym(text: string): string | null {
  const folded = foldPlain(text);
  for (const [adjective, code] of Object.entries(DEMONYM_COUNTRIES)) {
    if (new RegExp(`\\b${adjective}\\b`).test(folded)) return code;
  }
  return null;
}

/** The folded words of a phrase, exactly as `countriesInText` counts them. */
export function foldedWordsOf(text: string): string[] {
  return foldPlain(text).split(' ').filter(Boolean);
}

function built(code: string, how: 'name' | 'phrase'): CountryMatch | null {
  const facts = BY_CODE.get(code);
  const point = COUNTRY_POINTS[code];
  if (!facts || !point) return null;
  return { facts, point, how };
}

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ga: 'Irish', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ca: 'Catalan', gl: 'Galician', eu: 'Basque', rm: 'Romansh', el: 'Greek', hr: 'Croatian', sl: 'Slovene', cs: 'Czech', pl: 'Polish', hu: 'Hungarian', is: 'Icelandic', no: 'Norwegian', sv: 'Swedish', da: 'Danish', fi: 'Finnish', et: 'Estonian', tr: 'Turkish', ar: 'Arabic', zu: 'Zulu', xh: 'Xhosa', af: 'Afrikaans', sw: 'Swahili', tn: 'Setswana', rw: 'Kinyarwanda', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ms: 'Malay', ta: 'Tamil', th: 'Thai', vi: 'Vietnamese', km: 'Khmer', id: 'Indonesian', fil: 'Filipino', hi: 'Hindi', si: 'Sinhala', ky: 'Kyrgyz', ru: 'Russian', ne: 'Nepali', he: 'Hebrew', mi: 'Māori', fj: 'Fijian', qu: 'Quechua',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

/** True when the traveller shares at least one language with the destination; null when either side is unknown. */
export function sharesLanguage(destination: CountryFacts | null, travellerLanguages: readonly string[] | undefined): boolean | null {
  if (!destination || !travellerLanguages || travellerLanguages.length === 0) return null;
  return destination.languages.some((l) => travellerLanguages.includes(l));
}
