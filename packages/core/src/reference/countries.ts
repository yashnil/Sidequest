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

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ga: 'Irish', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ca: 'Catalan', gl: 'Galician', eu: 'Basque', rm: 'Romansh', el: 'Greek', hr: 'Croatian', sl: 'Slovene', cs: 'Czech', pl: 'Polish', hu: 'Hungarian', is: 'Icelandic', no: 'Norwegian', sv: 'Swedish', da: 'Danish', fi: 'Finnish', et: 'Estonian', tr: 'Turkish', ar: 'Arabic', zu: 'Zulu', xh: 'Xhosa', af: 'Afrikaans', sw: 'Swahili', tn: 'Setswana', rw: 'Kinyarwanda', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ms: 'Malay', ta: 'Tamil', th: 'Thai', vi: 'Vietnamese', km: 'Khmer', id: 'Indonesian', fil: 'Filipino', hi: 'Hindi', si: 'Sinhala', ne: 'Nepali', he: 'Hebrew', mi: 'Māori', fj: 'Fijian', qu: 'Quechua',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

/** True when the traveller shares at least one language with the destination; null when either side is unknown. */
export function sharesLanguage(destination: CountryFacts | null, travellerLanguages: readonly string[] | undefined): boolean | null {
  if (!destination || !travellerLanguages || travellerLanguages.length === 0) return null;
  return destination.languages.some((l) => travellerLanguages.includes(l));
}
