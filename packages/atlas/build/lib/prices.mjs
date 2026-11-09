/**
 * Price strings from Wikivoyage listings → structured, convertible observations.
 *
 * Pure: no filesystem beyond loading the bundled `fx-rates.json` table, no
 * network, no clock. Every function can be tested on a string copied out of
 * the dump (`prices.test.ts`).
 *
 * What a `price=` parameter is
 * ----------------------------
 * Free text written by a traveller: "B&B double £100", "From Rp 125,000
 * (includes breakfast)", "Adults $10, children $5", "1,300,000-3,000,000 dong",
 * "€€€", "Phone for rates". The reading here is deliberately conservative —
 * **a price that cannot be read with confidence is dropped with a reason, never
 * guessed**:
 *
 *   - a number with no currency beside it is not a price;
 *   - a currency sign that several currencies share ("$", "kr", "Rs", "peso",
 *     "¥") is resolved from the page's country, and dropped where the country
 *     does not settle it ("$" in Mexico is pesos or dollars — nobody can tell);
 *   - what the number is a price *of* is read from the words beside it: a dorm
 *     bed, a campsite, a week, a child's ticket, a beer or a parking fee is not
 *     a room night, an adult ticket or a meal, and is excluded or normalised
 *     with the fact recorded (`basis`, `unit`).
 *
 * An observation is **historical**: it was true when somebody wrote it. The
 * stage that calls this (`12-prices.mjs`) attaches the year and converts with
 * that year's exchange rate. Nothing here is ever a current price.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decodeHtmlEntities, parseTemplate, scanTemplates } from './wikitext.mjs';

/* ------------------------------------------------------------------------ */
/* Countries and their currencies                                            */
/* ------------------------------------------------------------------------ */

/** ISO 4217 code → the ISO 3166-1 countries and territories that use it as their own money. */
const CURRENCY_COUNTRIES = {
  USD: 'US PR VI GU MP AS UM EC SV PA TL FM MH PW BQ TC VG ZW IO',
  EUR: 'AT BE CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES HR AD MC SM VA ME XK AX GP MQ GF RE YT PM BL MF TF',
  GBP: 'GB IM JE GG GI FK SH GS',
  AUD: 'AU NF CX CC KI NR TV HM',
  NZD: 'NZ CK NU TK PN',
  CAD: 'CA', CHF: 'CH LI', DKK: 'DK FO GL', NOK: 'NO SJ BV', SEK: 'SE', ISK: 'IS',
  JPY: 'JP', CNY: 'CN', HKD: 'HK', MOP: 'MO', TWD: 'TW', KRW: 'KR', KPW: 'KP', MNT: 'MN',
  INR: 'IN', BTN: 'BT', NPR: 'NP', LKR: 'LK', PKR: 'PK', BDT: 'BD', MVR: 'MV', AFN: 'AF',
  THB: 'TH', VND: 'VN', LAK: 'LA', KHR: 'KH', MMK: 'MM', MYR: 'MY', SGD: 'SG', IDR: 'ID', PHP: 'PH', BND: 'BN',
  AED: 'AE', SAR: 'SA', QAR: 'QA', OMR: 'OM', KWD: 'KW', BHD: 'BH', JOD: 'JO', ILS: 'IL PS', LBP: 'LB', SYP: 'SY',
  IQD: 'IQ', IRR: 'IR', YER: 'YE', TRY: 'TR',
  EGP: 'EG', MAD: 'MA EH', DZD: 'DZ', TND: 'TN', LYD: 'LY', SDG: 'SD', SSP: 'SS',
  ZAR: 'ZA', NAD: 'NA', BWP: 'BW', LSL: 'LS', SZL: 'SZ', ZMW: 'ZM', MWK: 'MW', MZN: 'MZ', AOA: 'AO', MGA: 'MG',
  MUR: 'MU', SCR: 'SC', KMF: 'KM',
  KES: 'KE', TZS: 'TZ', UGX: 'UG', RWF: 'RW', BIF: 'BI', ETB: 'ET', ERN: 'ER', DJF: 'DJ', SOS: 'SO',
  XOF: 'SN ML BF NE CI TG BJ GW', XAF: 'CM GA CG TD CF GQ',
  NGN: 'NG', GHS: 'GH', GMD: 'GM', GNF: 'GN', SLE: 'SL', LRD: 'LR', CVE: 'CV', STN: 'ST', MRU: 'MR', CDF: 'CD',
  MXN: 'MX', GTQ: 'GT', BZD: 'BZ', HNL: 'HN', NIO: 'NI', CRC: 'CR', CUP: 'CU', DOP: 'DO', HTG: 'HT', JMD: 'JM',
  BSD: 'BS', BBD: 'BB', TTD: 'TT', XCD: 'AG DM GD KN LC VC AI MS', KYD: 'KY', BMD: 'BM', AWG: 'AW', ANG: 'CW SX',
  COP: 'CO', VES: 'VE', GYD: 'GY', SRD: 'SR', BRL: 'BR', PEN: 'PE', BOB: 'BO', CLP: 'CL', ARS: 'AR', UYU: 'UY', PYG: 'PY',
  PLN: 'PL', CZK: 'CZ', HUF: 'HU', RON: 'RO', BGN: 'BG', MDL: 'MD', UAH: 'UA', BYN: 'BY', RUB: 'RU', RSD: 'RS',
  BAM: 'BA', MKD: 'MK', ALL: 'AL', GEL: 'GE', AMD: 'AM', AZN: 'AZ', KZT: 'KZ', KGS: 'KG', UZS: 'UZ', TJS: 'TJ', TMT: 'TM',
  FJD: 'FJ', PGK: 'PG', SBD: 'SB', VUV: 'VU', WST: 'WS', TOP: 'TO', XPF: 'PF NC WF',
};

/** ISO 3166-1 alpha-2 → the country's own ISO 4217 currency. */
export const COUNTRY_CURRENCY = new Map();
for (const [code, countries] of Object.entries(CURRENCY_COUNTRIES)) for (const iso of countries.split(' ')) COUNTRY_CURRENCY.set(iso, code);

/**
 * Currencies that no longer circulate but still stand in old listings. Kept so
 * the string is read as what it says and converted at a rate from when the
 * currency existed (the FX table holds them up to their last year).
 */
const LEGACY_HOME = { HRK: 'HR', LTL: 'LT', LVL: 'LV', EEK: 'EE' };

/** The economy whose price index deflates a currency quoted outside its own country. */
export function currencyHome(code) {
  if (code === 'EUR') return 'DE';
  if (LEGACY_HOME[code]) return LEGACY_HOME[code];
  const countries = CURRENCY_COUNTRIES[code];
  return countries ? countries.split(' ')[0] : null;
}

/* ------------------------------------------------------------------------ */
/* Currency tokens                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Signs and words that several currencies share. A family token resolves to
 * the page country's own currency when that currency belongs to the family,
 * to `fallback` elsewhere when the convention is firm, and to nothing
 * otherwise.
 */
const FAMILY = {
  /* Bare "$": local where the country's money is a dollar by firm Wikivoyage convention, US dollars where the
     country has no "$" of its own, and unreadable where a local "$" currency and the US dollar are both quoted. */
  dollar: { members: ['USD', 'AUD', 'CAD', 'NZD', 'SGD', 'HKD'], fallback: 'USD' },
  pound: { members: ['GBP', 'EGP', 'LBP', 'SYP', 'SDG', 'SSP'], fallback: 'GBP' },
  yen: { members: ['JPY', 'CNY'], fallback: null },
  yuan: { members: ['CNY'], fallback: null },
  rupee: { members: ['INR', 'PKR', 'LKR', 'NPR', 'MUR', 'SCR'], fallback: null },
  peso: { members: ['MXN', 'ARS', 'CLP', 'COP', 'UYU', 'DOP', 'PHP', 'CUP'], fallback: null },
  franc: { members: ['CHF', 'XOF', 'XAF', 'XPF', 'RWF', 'BIF', 'DJF', 'GNF', 'KMF', 'CDF'], fallback: null },
  cfa: { members: ['XOF', 'XAF'], fallback: null },
  krona: { members: ['SEK', 'NOK', 'DKK', 'ISK'], fallback: null },
  crown: { members: ['SEK', 'NOK', 'DKK', 'ISK', 'CZK'], fallback: null },
  dinar: { members: ['JOD', 'KWD', 'BHD', 'TND', 'DZD', 'IQD', 'LYD', 'RSD'], fallback: null },
  rial: { members: ['IRR', 'OMR', 'QAR', 'SAR', 'YER'], fallback: null },
  shilling: { members: ['KES', 'TZS', 'UGX', 'SOS'], fallback: null },
  ruble: { members: ['RUB', 'BYN'], fallback: null },
  manat: { members: ['AZN', 'TMT'], fallback: null },
  som: { members: ['KGS', 'UZS'], fallback: null },
  leu: { members: ['RON', 'MDL'], fallback: null },
  dirham: { members: ['MAD', 'AED'], fallback: null },
  lira: { members: ['TRY', 'LBP', 'SYP'], fallback: null },
  /* Letters that are a currency only inside one country: "R450" in South Africa, "K5000" in Myanmar, "Q80" in Guatemala. */
  letterR: { members: ['ZAR', 'NAD', 'LSL', 'SZL'], fallback: null },
  letterK: { members: ['MMK', 'ZMW', 'MWK', 'PGK'], fallback: null },
  letterP: { members: ['PHP', 'BWP'], fallback: null },
  letterQ: { members: ['GTQ'], fallback: null },
  letterL: { members: ['HNL'], fallback: null },
  letterN: { members: ['NGN'], fallback: null },
  letterD: { members: ['GMD'], fallback: null },
  letterE: { members: ['SZL'], fallback: null },
  letterM: { members: ['LSL'], fallback: null },
  /* Notations two countries write the same way. */
  dollarM: { members: ['MXN'], fallback: null }, // "M$" — Mexico's house style; once also Malaysia's
  dollarC: { members: ['CAD', 'NIO'], fallback: null }, // "C$" — Canada, and Nicaragua's córdoba
  dollarT: { members: ['TOP', 'TTD'], fallback: null },
  dollarB: { members: ['BND', 'BSD', 'BBD', 'BZD'], fallback: null },
  sr: { members: ['SAR', 'SCR'], fallback: null },
  bs: { members: ['BOB'], fallback: null },
  ft: { members: ['HUF'], fallback: null },
  km: { members: ['BAM'], fallback: null },
  bt: { members: ['THB'], fallback: null },
  br: { members: ['BYN', 'ETB'], fallback: null },
  kwacha: { members: ['ZMW', 'MWK'], fallback: null },
  sol: { members: ['PEN'], fallback: null },
  tw: { members: ['TWD'], fallback: null },
  tenge: { members: ['KZT'], fallback: null },
  le: { members: ['EGP', 'SLE'], fallback: null },
  pence: { members: ['GBP'], fallback: null, scale: 0.01 },
};

/**
 * Countries where a bare "$" cannot be read: the local currency is written
 * with "$" and US-dollar prices are quoted beside it for visitors. Dropped,
 * never guessed. (Par-pegged dollars — Bahamas, Bermuda — are read as USD:
 * the number is the same either way.)
 */
const DOLLAR_UNREADABLE = new Set([
  'MXN', 'ARS', 'CLP', 'COP', 'UYU', 'DOP', 'CUP', 'BZD', 'JMD', 'BBD', 'TTD', 'GYD', 'SRD', 'LRD', 'NAD', 'FJD', 'SBD',
  'KYD', 'XCD', 'BND', 'TWD', 'BRL', 'NIO', 'TOP', 'WST', 'AWG', 'ANG', 'HTG', 'CVE', 'MOP',
]);
const DOLLAR_PAR = new Set(['BSD', 'BMD']);

const fixed = (code, scale = 1) => ({ code, scale });
const family = (name) => ({ family: name });

/**
 * Every notation the parser recognises. `p` — may stand before the number,
 * `s` — may stand after it. Case matters: "Ft" is forints, "ft" is feet;
 * "KM" is convertible marks only in Bosnia.
 */
const TOKEN_ROWS = [
  // US dollar, explicit
  [['US$', 'USD', 'USD$', 'US $', 'U.S.$', 'U$S', 'U$D', '$US', 'US$$', 'usd', 'Usd', 'U$'], fixed('USD'), 'ps'],
  [['$', '＄'], family('dollar'), 'ps'],
  [['dollars', 'dollar', 'bucks'], family('dollar'), 's'],
  [['US dollars', 'US dollar', 'U.S. dollars', 'American dollars'], fixed('USD'), 's'],
  [['A$', 'AU$', 'AUD', 'AUD$', 'AUS$'], fixed('AUD'), 'ps'],
  [['NZ$', 'NZD', 'NZD$'], fixed('NZD'), 'ps'],
  [['CA$', 'CAD', 'CAD$', 'CDN$', 'Can$', 'CAN$'], fixed('CAD'), 'ps'],
  [['C$'], family('dollarC'), 'p'],
  [['S$', 'SGD', 'SG$'], fixed('SGD'), 'ps'],
  [['HK$', 'HKD'], fixed('HKD'), 'ps'],
  [['NT$', 'NT $', 'TWD', 'NTD'], fixed('TWD'), 'ps'],
  [['NT'], family('tw'), 'ps'],
  [['M$'], family('dollarM'), 'p'],
  [['MXN', 'MX$', 'Mex$', 'MXN$'], fixed('MXN'), 'ps'],
  [['COP$', 'COP', 'COL$'], fixed('COP'), 'ps'],
  [['AR$', 'ARS', 'ARS$'], fixed('ARS'), 'ps'],
  [['CLP', 'CLP$', 'CL$'], fixed('CLP'), 'ps'],
  [['$U', 'UYU', 'UR$'], fixed('UYU'), 'ps'],
  [['RD$', 'DOP'], fixed('DOP'), 'ps'],
  [['BZ$', 'BZD'], fixed('BZD'), 'ps'],
  [['J$', 'JMD', 'JA$'], fixed('JMD'), 'ps'],
  [['TT$', 'TTD'], fixed('TTD'), 'ps'],
  [['EC$', 'XCD'], fixed('XCD'), 'ps'],
  [['Bds$', 'BBD', 'BDS$'], fixed('BBD'), 'ps'],
  [['N$', 'NAD'], fixed('NAD'), 'ps'],
  [['F$', 'FJ$', 'FJD'], fixed('FJD'), 'ps'],
  [['WS$', 'WST'], fixed('WST'), 'ps'],
  [['tala'], fixed('WST'), 's'],
  [['T$'], family('dollarT'), 'p'],
  [['SI$', 'SBD'], fixed('SBD'), 'ps'],
  [['G$', 'GYD'], fixed('GYD'), 'ps'],
  [['SRD'], fixed('SRD'), 'ps'],
  [['B$'], family('dollarB'), 'p'],
  [['R$', 'BRL'], fixed('BRL'), 'ps'],
  [['reais', 'reals'], fixed('BRL'), 's'],
  // Europe
  [['€', 'EUR', 'eur', 'Eur', 'EURO'], fixed('EUR'), 'ps'],
  [['euros', 'euro', 'Euros', 'Euro'], fixed('EUR'), 's'],
  [['£', '￡'], family('pound'), 'ps'],
  [['GBP', 'UKP', 'UK£', 'GB£'], fixed('GBP'), 'ps'],
  [['pounds', 'pound', 'quid'], family('pound'), 's'],
  [['p'], family('pence'), 's'],
  [['CHF', 'SFr', 'Sfr', 'SFr.', 'Sfr.', 'sFr', 'sFr.', 'SFR'], fixed('CHF'), 'ps'],
  [['Fr.', 'Fr', 'fr.', 'F'], family('franc'), 'p'],
  [['francs', 'franc', 'Fr.', 'Fr', 'frs'], family('franc'), 's'],
  [['kr', 'kr.', 'Kr', 'Kr.', 'KR'], family('krona'), 'ps'],
  [['kroner', 'kronor', 'krónur', 'kronur', 'krona', 'krone', 'króna'], family('krona'), 's'],
  [['crowns', 'crown', 'korun', 'koruna'], family('crown'), 's'],
  [['DKK', 'Dkr', 'DKr', 'dkk'], fixed('DKK'), 'ps'],
  [['NOK', 'Nkr', 'NKr', 'nok'], fixed('NOK'), 'ps'],
  [['SEK', 'Skr', 'SKr', 'sek'], fixed('SEK'), 'ps'],
  [['ISK', 'Ikr', 'IKr', 'isk'], fixed('ISK'), 'ps'],
  [['zł', 'zl', 'PLN', 'złoty', 'zloty', 'zlotych', 'złotych', 'zł.', 'pln'], fixed('PLN'), 'ps'],
  [['Kč', 'Kc', 'CZK', 'kč', 'czk', 'Kč.'], fixed('CZK'), 'ps'],
  [['Ft', 'Ft.'], family('ft'), 'ps'],
  [['HUF', 'forint', 'forints', 'huf'], fixed('HUF'), 'ps'],
  [['kn', 'HRK', 'kuna', 'kunas', 'Kn'], fixed('HRK'), 'ps'],
  [['KM'], family('km'), 'ps'],
  [['BAM', 'marka', 'maraka'], fixed('BAM'), 'ps'],
  [['RSD', 'rsd'], fixed('RSD'), 'ps'],
  [['din', 'din.', 'dinars', 'dinar', 'dinara', 'Din'], family('dinar'), 's'],
  [['MKD', 'denars', 'denar', 'ден', 'den'], fixed('MKD'), 'ps'],
  [['lek', 'lekë', 'leke', 'Lek', 'lekë.'], fixed('ALL'), 's'],
  [['lei', 'leu', 'Lei', 'LEI'], family('leu'), 's'],
  [['RON', 'ron'], fixed('RON'), 'ps'],
  [['MDL'], fixed('MDL'), 'ps'],
  [['лв', 'лв.', 'lv', 'lv.', 'leva', 'lev', 'BGN', 'bgn'], fixed('BGN'), 'ps'],
  [['грн', 'грн.', 'UAH', 'hryvnia', 'hryvnias', 'hryvnya', 'hrivnas', '₴', 'hrn', 'uah', 'гривень'], fixed('UAH'), 'ps'],
  [['руб', 'руб.', 'р.', 'rubles', 'roubles', 'ruble', 'rouble', 'rub'], family('ruble'), 's'],
  [['RUB', 'RUR', '₽', 'rur'], fixed('RUB'), 'ps'],
  [['BYN'], fixed('BYN'), 'ps'],
  [['Br'], family('br'), 'ps'],
  [['TL', '₺', 'TRY', 'YTL', 'tl', 'Tl'], fixed('TRY'), 'ps'],
  [['lira', 'liras'], family('lira'), 's'],
  [['LTL', 'Lt'], fixed('LTL'), 'ps'],
  [['LVL', 'Ls'], fixed('LVL'), 'ps'],
  [['EEK'], fixed('EEK'), 'ps'],
  // Caucasus and Central Asia
  [['lari', 'GEL', '₾', 'gel', 'laris'], fixed('GEL'), 'ps'],
  [['dram', 'drams', 'AMD', '֏'], fixed('AMD'), 'ps'],
  [['manat', 'manats', '₼'], family('manat'), 'ps'],
  [['AZN'], fixed('AZN'), 'ps'],
  [['tenge', 'KZT', '₸', 'тг'], fixed('KZT'), 'ps'],
  [['tg'], family('tenge'), 's'],
  [['som', 'сом', 'soms'], family('som'), 's'],
  [['KGS'], fixed('KGS'), 'ps'],
  [['UZS', 'sum', 'soum', "so'm", 'сум', 'sums'], fixed('UZS'), 'ps'],
  [['somoni', 'TJS', 'somonis'], fixed('TJS'), 'ps'],
  [['₮', 'MNT', 'tögrög', 'tugrik', 'tugriks', 'tugrug', 'төгрөг'], fixed('MNT'), 'ps'],
  // Middle East and North Africa
  [['₪', 'NIS', 'ILS', 'shekels', 'shekel', 'sheqel', 'sheqels', 'nis'], fixed('ILS'), 'ps'],
  [['JD', 'JOD', 'JD.'], fixed('JOD'), 'ps'],
  [['LE', 'L.E.', 'E£', 'EGP', 'LE.', '£E', 'egp'], fixed('EGP'), 'ps'],
  [['LL', 'LBP', 'L.L.'], fixed('LBP'), 'ps'],
  [['KD', 'KWD'], fixed('KWD'), 'ps'],
  [['BD', 'BHD'], fixed('BHD'), 'ps'],
  [['QR', 'QAR', 'QR.'], fixed('QAR'), 'ps'],
  [['SR'], family('sr'), 'ps'],
  [['SAR'], fixed('SAR'), 'ps'],
  [['AED', 'Dhs', 'dhs', 'DHS', 'Dhs.'], family('dirham'), 'ps'],
  [['dirham', 'dirhams', 'Dh', 'DH', 'dh', 'Dirham', 'Dirhams', 'dh.', 'Dh.'], family('dirham'), 'ps'],
  [['MAD'], fixed('MAD'), 'ps'],
  [['RO', 'OMR', 'R.O.'], fixed('OMR'), 'ps'],
  [['rials', 'rial', 'riyals', 'riyal', 'Rials', 'Rls'], family('rial'), 's'],
  [['IRR'], fixed('IRR'), 'ps'],
  [['tomans', 'toman', 'Tomans', 'Toman'], fixed('IRR', 10), 's'],
  [['DA', 'DZD'], fixed('DZD'), 'ps'],
  [['DT', 'TND', 'TD'], fixed('TND'), 'ps'],
  [['IQD'], fixed('IQD'), 'ps'],
  // Africa
  [['ZAR', 'rand', 'Rand', 'rands'], fixed('ZAR'), 'ps'],
  [['R'], family('letterR'), 'p'],
  [['pula', 'BWP'], fixed('BWP'), 'ps'],
  [['kwacha', 'MK'], family('kwacha'), 'ps'],
  [['ZMW', 'ZMK'], fixed('ZMW'), 'ps'],
  [['MWK'], fixed('MWK'), 'ps'],
  [['K'], family('letterK'), 'p'],
  [['MT', 'MZN', 'meticais', 'metical', 'Mt', 'MTn'], fixed('MZN'), 'ps'],
  [['Kz', 'AOA', 'kwanza', 'kwanzas'], fixed('AOA'), 'ps'],
  [['Ar', 'MGA', 'ariary', 'Ariary'], fixed('MGA'), 'ps'],
  [['MUR'], fixed('MUR'), 'ps'],
  [['SCR'], fixed('SCR'), 'ps'],
  [['KSh', 'Ksh', 'KES', 'KSH', 'Kshs', 'KShs', 'ksh', 'Ksh.', 'KSh.'], fixed('KES'), 'ps'],
  [['TSh', 'Tsh', 'TZS', 'TSH', 'Tshs', 'TShs', 'Tsh.'], fixed('TZS'), 'ps'],
  [['USh', 'Ush', 'UGX', 'USH', 'Ushs', 'UShs', 'ugx'], fixed('UGX'), 'ps'],
  [['shillings', 'shilling', 'Sh', 'sh', 'Shs', '/=', '/-'], family('shilling'), 'ps'],
  [['FRw', 'RWF', 'Rwf', 'RF', 'Frw'], fixed('RWF'), 'ps'],
  [['FBu', 'BIF'], fixed('BIF'), 'ps'],
  [['birr', 'ETB', 'Birr'], fixed('ETB'), 'ps'],
  [['CFA', 'FCFA', 'F CFA', 'CFA francs', 'CFAF', 'XOF', 'XAF', 'cfa', 'CFA franc', 'F.CFA'], family('cfa'), 'ps'],
  [['CFP', 'XPF', 'F CFP', 'FCFP'], fixed('XPF'), 'ps'],
  [['₦', 'NGN', 'naira', 'Naira'], fixed('NGN'), 'ps'],
  [['N'], family('letterN'), 'p'],
  [['GH₵', 'GHS', 'GHC', 'GH¢', 'cedis', 'cedi', '₵', 'GHc'], fixed('GHS'), 'ps'],
  [['dalasi', 'dalasis', 'GMD'], fixed('GMD'), 'ps'],
  [['D'], family('letterD'), 'p'],
  [['E'], family('letterE'), 'p'],
  [['M'], family('letterM'), 'p'],
  [['GNF'], fixed('GNF'), 'ps'],
  [['CVE', 'escudos'], fixed('CVE'), 'ps'],
  [['UM', 'MRU', 'ouguiya'], fixed('MRU'), 'ps'],
  [['FC', 'CDF'], fixed('CDF'), 'ps'],
  [['DJF', 'FDJ'], fixed('DJF'), 'ps'],
  // South and East Asia
  [['₹', 'INR', 'inr', 'INR.'], fixed('INR'), 'ps'],
  [['Rs', 'Rs.', 'rupees', 'rupee', '₨', 'RS', 'Rs:', 'rs', 'rs.', 'Rupees'], family('rupee'), 'ps'],
  [['NPR', 'NRs', 'NRs.', 'NRS', 'Nrs', 'NRs:'], fixed('NPR'), 'ps'],
  [['LKR', 'SLR', 'SLRs'], fixed('LKR'), 'ps'],
  [['PKR', 'PRs'], fixed('PKR'), 'ps'],
  [['Tk', '৳', 'BDT', 'taka', 'Tk.', 'Taka'], fixed('BDT'), 'ps'],
  [['Nu', 'Nu.', 'BTN', 'ngultrum'], fixed('BTN'), 'ps'],
  [['Rf', 'MVR', 'rufiyaa', 'Rf.'], fixed('MVR'), 'ps'],
  [['afghanis', 'afghani', 'AFN', 'Afs'], fixed('AFN'), 'ps'],
  [['¥', '￥'], family('yen'), 'ps'],
  [['yen', '円', 'JPY', 'Yen', 'JP¥'], fixed('JPY'), 'ps'],
  [['yuan', 'RMB', 'CNY', 'kuai', 'Yuan', 'rmb', 'CN¥', 'renminbi'], fixed('CNY'), 'ps'],
  [['元'], family('yuan'), 's'],
  [['₩', '￦', 'KRW', 'won', 'Won', 'krw'], fixed('KRW'), 'ps'],
  [['MOP', 'patacas', 'pataca', 'MOP$'], fixed('MOP'), 'ps'],
  [['baht', '฿', 'THB', 'Baht', 'bht', 'thb', 'Bht', 'BHT'], fixed('THB'), 'ps'],
  [['bt', 'Bt', 'B', 'B.', 'baths', 'bath'], family('bt'), 's'],
  [['dong', '₫', 'VND', 'vnd', 'đ', 'Dong', 'VNĐ', 'đồng', 'dongs'], fixed('VND'), 'ps'],
  [['kip', '₭', 'LAK', 'Kip', 'kips'], fixed('LAK'), 'ps'],
  [['riel', '៛', 'KHR', 'riels', 'Riel'], fixed('KHR'), 'ps'],
  [['kyat', 'kyats', 'MMK', 'Ks', 'Kyat', 'Ks.'], fixed('MMK'), 'ps'],
  [['RM', 'MYR', 'ringgit', 'Ringgit', 'rm'], fixed('MYR'), 'ps'],
  [['Rp', 'Rp.', 'IDR', 'rupiah', 'Rupiah', 'rp', 'RP', 'idr'], fixed('IDR'), 'ps'],
  [['₱', 'PHP', 'Php', 'PhP', 'php', 'Php.'], fixed('PHP'), 'ps'],
  [['P'], family('letterP'), 'p'],
  [['pesos', 'peso', 'Pesos'], family('peso'), 's'],
  // Latin America
  [['S/', 'S/.', 'S./', 'soles', 'sol'], family('sol'), 'ps'],
  [['PEN'], fixed('PEN'), 'ps'],
  [['Bs', 'Bs.', 'bolivianos', 'boliviano', 'Bs:'], family('bs'), 'ps'],
  [['BOB'], fixed('BOB'), 'ps'],
  [['Q', 'Q.'], family('letterQ'), 'p'],
  [['GTQ', 'quetzales', 'quetzal', 'Quetzales'], fixed('GTQ'), 'ps'],
  [['₡', 'CRC', 'colones', 'colón', 'colon'], fixed('CRC'), 'ps'],
  [['L', 'L.', 'Lps', 'Lps.', 'Lp'], family('letterL'), 'p'],
  [['HNL', 'lempiras', 'lempira', 'Lempiras'], fixed('HNL'), 'ps'],
  [['NIO', 'córdobas', 'cordobas', 'córdoba'], fixed('NIO'), 'ps'],
  [['B/.', 'PAB', 'balboas'], fixed('USD'), 'ps'],
  [['₲', 'PYG', 'Gs', 'Gs.', 'guaraníes', 'guaranies'], fixed('PYG'), 'ps'],
  // Pacific
  [['VT', 'vatu', 'VUV', 'Vt'], fixed('VUV'), 'ps'],
  [['PGK', 'kina', 'Kina'], fixed('PGK'), 'ps'],
];

/**
 * Codes read wherever they stand. Every other lettered notation ("TOP 10",
 * "2 bath", "COP", "5 som") is a currency only on a page in the country whose
 * money it is: abbreviations collide with English, and outside the dollar, the
 * euro and the pound a foreign currency in a listing is rare enough to give up.
 */
const READ_ANYWHERE = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'CHF', 'JPY', 'CNY', 'SGD', 'HKD']);
/** Currencies that circulate, at par or by habit, beside a neighbour's own. */
const ALSO_AT_HOME_IN = { INR: 'NP BT', ZAR: 'NA LS SZ', THB: 'LA', TRY: 'CY' };
const LETTERED = /^[\p{L}. ']+$/u;

const PREFIX_TOKENS = new Map();
const SUFFIX_TOKENS = new Map();
for (const [tokens, meaning, where] of TOKEN_ROWS) {
  for (const token of tokens) {
    const homeOnly = Boolean(meaning.code) && !READ_ANYWHERE.has(meaning.code) && LETTERED.test(token);
    const entry = homeOnly ? { ...meaning, homeOnly } : meaning;
    if (where.includes('p') && !PREFIX_TOKENS.has(token)) PREFIX_TOKENS.set(token, entry);
    if (where.includes('s') && !SUFFIX_TOKENS.has(token)) SUFFIX_TOKENS.set(token, entry);
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const alternation = (map) => [...map.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRegExp).join('|');
const startsWithLetter = (token) => /^\p{L}/u.test(token);
const endsWithLetter = (token) => /\p{L}$/u.test(token);

/** A prefix token directly before a number: "US$", "Rp ", "Rs. ", "R". */
const PREFIX_AT_END = new RegExp(`(${alternation(PREFIX_TOKENS)})[ ]?$`, 'u');
/** A suffix token directly after a number: " baht", "kr", "€", " zł". */
const SUFFIX_AT_START = new RegExp(`^\\+?[ ]?(${alternation(SUFFIX_TOKENS)})`, 'u');

/**
 * What a token means on a page in `iso`.
 * @returns {{ code: string, scale: number, basis: 'explicit' | 'country' | 'convention' } | { reason: string }}
 */
export function resolveCurrency(meaning, iso) {
  const own = iso ? COUNTRY_CURRENCY.get(iso) ?? null : null;
  if (meaning.code) {
    const atHome = own === meaning.code || LEGACY_HOME[meaning.code] === iso || (iso && (ALSO_AT_HOME_IN[meaning.code] ?? '').split(' ').includes(iso));
    if (meaning.homeOnly && !atHome) return { reason: 'ambiguous_currency' };
    return { code: meaning.code, scale: meaning.scale ?? 1, basis: 'explicit' };
  }
  const group = FAMILY[meaning.family];
  const scale = group.scale ?? 1;
  if (own && group.members.includes(own)) return { code: own, scale, basis: 'country' };
  if (meaning.family === 'dollar') {
    if (!own) return { reason: 'ambiguous_currency' };
    if (DOLLAR_PAR.has(own)) return { code: 'USD', scale, basis: 'country' };
    if (DOLLAR_UNREADABLE.has(own)) return { reason: 'ambiguous_currency' };
    return { code: 'USD', scale, basis: 'convention' };
  }
  if (meaning.family === 'pound') {
    if (!own) return { reason: 'ambiguous_currency' };
    return { code: 'GBP', scale, basis: 'convention' };
  }
  return { reason: 'ambiguous_currency' };
}

/* ------------------------------------------------------------------------ */
/* Exchange rates and price indices                                          */
/* ------------------------------------------------------------------------ */

/**
 * Redenominations since listings began to carry dates. The World Bank series
 * is expressed in today's unit throughout, so a price written before the
 * change is in the old unit and the rate must be scaled back. (A listing dated
 * after the change that still quotes the old unit converts to an absurd
 * figure and is refused by the plausibility envelope.)
 */
const REDENOMINATED = { BYN: [2016, 10000], MRU: [2018, 10], STN: [2018, 1000], SLE: [2022, 1000], ZMW: [2013, 1000] };

/**
 * Countries and years where the official rate was not the rate a visitor
 * paid: dual or parallel markets, hard pegs held far from the street rate. An
 * editorial table, deliberately broad; an observation that falls in it is
 * converted like any other and flagged `fxCaveat`, so a consumer can widen the
 * range or leave it out. `[from, to]` inclusive.
 */
const OFFICIAL_RATE_CAVEAT = {
  IRR: [2000, 2100], VES: [2000, 2100], SYP: [2012, 2100], LBP: [2020, 2023], ARS: [2012, 2023], NGN: [2016, 2023],
  ETB: [2018, 2024], MMK: [2021, 2100], SDG: [2011, 2021], SSP: [2015, 2100], CUP: [2000, 2100], EGP: [2022, 2024],
  LYD: [2015, 2100], YER: [2015, 2100], UZS: [2000, 2017], TMT: [2015, 2100], AOA: [2015, 2019], BOB: [2023, 2100],
  LAK: [2022, 2024], MWK: [2021, 2100], BIF: [2016, 2100], DZD: [2015, 2100], ZWL: [2000, 2100],
};

/**
 * Wrap the bundled table (`fx-rates.json`) in the three conversions the stage needs.
 *
 * @param {{ baseYear: number, fx: Record<string, Record<string, number>>, cpi: Record<string, Record<string, number>> }} table
 */
export function createFx(table) {
  const base = table.baseYear;

  /** The nearest year a series has, and how far away it is. */
  function nearest(series, year) {
    if (!series) return null;
    if (series[year] !== undefined) return { value: series[year], gap: 0 };
    let best = null;
    for (const key in series) {
      const gap = Math.abs(Number(key) - year);
      if (best === null || gap < best.gap || (gap === best.gap && Number(key) < year)) best = { value: series[key], gap };
    }
    return best;
  }

  /** Local currency units per US dollar in `year`, annual average. */
  function rate(code, year) {
    if (code === 'USD') return { value: 1, gap: 0 };
    const found = nearest(table.fx[code], year);
    if (!found) return null;
    const change = REDENOMINATED[code];
    return change && year < change[0] ? { value: found.value * change[1], gap: found.gap } : found;
  }

  /** A typical recent rate, for deciding whether "3.500" is three thousand five hundred. */
  function magnitude(code) {
    return code === 'USD' ? 1 : nearest(table.fx[code], base)?.value ?? null;
  }

  /**
   * @returns {null | { usd: number, usdBase: number, fxGap: number, realBasis: 'currency_cpi' | 'us_cpi_fallback', cpiFactor: number, fxCaveat: boolean }}
   *   `usd` — at the observation year's rate (nominal; the nearest year the
   *   series has when that year is missing, `fxGap` years away). `usdBase` — in
   *   constant base-year dollars: the amount inflated with the consumer price
   *   index of the economy whose currency it is (the page's country when the
   *   price is in its own money, the issuer otherwise) and converted at the base
   *   year's rate; where that index is missing or more than two years from the
   *   observation, the nominal dollar figure moved with the US index. A price
   *   newer than the base year is deflated back to it; a price newer than the
   *   last published index uses that index's final year.
   */
  function convert(amount, code, year, iso) {
    const then = rate(code, year);
    if (!then || !(then.value > 0)) return null;
    const usd = amount / then.value;
    const local = iso && COUNTRY_CURRENCY.get(iso) === code ? iso : currencyHome(code);
    const index = local ? table.cpi[local] : null;
    const now = rate(code, base);
    const indexThen = index ? nearest(index, year) : null;
    let usdBase;
    let realBasis;
    let cpiFactor;
    if (index && index[base] !== undefined && indexThen && indexThen.gap <= 2 && now && now.gap === 0) {
      cpiFactor = index[base] / indexThen.value;
      usdBase = (amount * cpiFactor) / now.value;
      realBasis = 'currency_cpi';
    } else {
      const us = table.cpi.US;
      cpiFactor = us[base] / nearest(us, year).value;
      usdBase = usd * cpiFactor;
      realBasis = 'us_cpi_fallback';
    }
    const caveat = OFFICIAL_RATE_CAVEAT[code];
    return { usd, usdBase, fxGap: then.gap, realBasis, cpiFactor, fxCaveat: Boolean(caveat && year >= caveat[0] && year <= caveat[1]) };
  }

  return { baseYear: base, rate, magnitude, convert, has: (code) => code === 'USD' || Boolean(table.fx[code]) };
}

let bundled = null;
/** The table shipped beside this file. Loaded once, on first use. */
export function bundledFx() {
  if (!bundled) {
    const file = fileURLToPath(new URL('./fx-rates.json', import.meta.url));
    bundled = createFx(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return bundled;
}

/* ------------------------------------------------------------------------ */
/* Text                                                                      */
/* ------------------------------------------------------------------------ */

const FULLWIDTH = /[！-～]/g;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const YEAR = '((?:19|20)\\d{2})';
/** "(Jan 2018)", "as of March 2019", "prices per Dec 2011", "2023 rates", "in 2019", "(2022)". */
const AFTER_YEAR = '(?=\\s*(?:[),.;:]|$))';
const STATED_DATES = [
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTH}\\.?,? ${YEAR}\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\.?,? ${YEAR}\\b`, 'gi'),
  // "from 2000" is a price far more often than a year: a bare year counts only where the clause ends on it.
  new RegExp(`\\b(?:as of|as at|as in|in|since|during|per|updated|checked|valid|rates?|prices?|season) ${YEAR}${AFTER_YEAR}`, 'gi'),
  new RegExp(`\\b${YEAR}(?:[/-]\\d{2,4})? (?:rates?|prices?|season|fees?|tariffs?)\\b`, 'gi'),
  new RegExp(`\\((?:c\\. ?|ca\\. ?)?${YEAR}\\)`, 'g'),
  new RegExp(`\\b\\d{1,2}[./-]\\d{1,2}[./-]${YEAR}\\b`, 'g'),
  new RegExp(`\\b${YEAR}-\\d{2}(?:-\\d{2})?\\b`, 'g'),
];

/**
 * A `price=` value as plain text: currency templates rendered as "CODE
 * amount", other templates and markup removed, entities decoded, every dash a
 * hyphen, full-width forms folded.
 */
export function normalisePriceText(raw) {
  if (!raw) return '';
  let s = String(raw);
  if (s.indexOf('<') >= 0) s = s.replace(/<ref\b[^<>]*?(?:\/>|>[\s\S]*?<\/ref\s*>)/gi, ' ').replace(/<br\s*\/?>/gi, '; ').replace(/<\/?[a-zA-Z][^<>]*>/g, ' ');
  if (s.indexOf('{{') >= 0) {
    const templates = scanTemplates(s).filter((t) => t.depth === 0);
    let out = '';
    let at = 0;
    for (const t of templates) {
      out += s.slice(at, t.start);
      const p = parseTemplate(t.inner);
      const name = p.name.toUpperCase();
      if (/^[A-Z]{3}$/.test(name) && (name === 'USD' || CURRENCY_COUNTRIES[name] || LEGACY_HOME[name]) && p.positional.length > 0) {
        out += `${name} ${p.positional.join('-')}`;
      } else if (p.name === 'currency' && p.positional.length >= 2) {
        const [a, b] = p.positional;
        out += /^[A-Za-z]{3}$/.test(a.trim()) ? `${a.trim().toUpperCase()} ${b}` : /^[A-Za-z]{3}$/.test(b.trim()) ? `${b.trim().toUpperCase()} ${a}` : ' ';
      } else if (p.name === '€' && p.positional.length > 0) {
        out += `EUR ${p.positional[0]}`;
      } else if (p.name === 'nowrap' || p.name === 'nobr') {
        out += p.positional[0] ?? '';
      } else {
        out += ' ';
      }
      at = t.end;
    }
    s = out + s.slice(at);
  }
  s = s
    .replace(/\[\[(?:[^[\]|]*\|)?([^[\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+ ?([^\]]*)\]/g, '$1')
    .replace(/(?:https?:)?\/\/[^\s)\]]+/g, ' ');
  s = decodeHtmlEntities(s);
  s = s
    .replace(FULLWIDTH, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[  -​  　]/g, ' ')
    .replace(/[‐‑‒–—―−﹣－〜～]/g, '-')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，、]/g, ', ')
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** Take date annotations out of the text (so "2018" is never read as an amount) and report the latest year stated. */
function extractStatedYear(text) {
  let year = null;
  let out = text;
  for (const pattern of STATED_DATES) {
    out = out.replace(pattern, (whole, y) => {
      const n = Number(y);
      if (n >= 1995 && n <= 2100 && (year === null || n > year)) year = n;
      return ' ';
    });
  }
  return { text: out.replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim(), year };
}

/** `lastedit=` as a year, or null. Accepts the forms the dump actually holds. */
export function parseLastEditYear(raw, { min = 2003, max = 2100 } = {}) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = /^((?:19|20)\d{2})(?:\D|$)/.exec(s) ?? /(?:^|\D)((?:19|20)\d{2})$/.exec(s) ?? /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= min && year <= max ? year : null;
}

/* ------------------------------------------------------------------------ */
/* Numbers                                                                   */
/* ------------------------------------------------------------------------ */

const GROUPED = String.raw`\d{1,3}(?:[,.']\d{3})+(?:[.,]\d{1,2})?(?!\d)`;
const SPACED = String.raw`\d{1,3}(?: \d{3})+(?!\d)`;
const PLAIN = String.raw`\d+(?:[.,]\d+)?`;
const MULTIPLIER = String.raw`(?: ?(k|K|thousand|million|mil|mln|mn|juta|jt|ribu|rb)(?![\p{L}]))?`;
const NUMBER_WITH_SPACES = new RegExp(`(?<![\\d.,])(${SPACED}|${GROUPED}|${PLAIN})${MULTIPLIER}`, 'uy');
const NUMBER_NO_SPACES = new RegExp(`(?<![\\d.,])(${GROUPED}|${PLAIN})${MULTIPLIER}`, 'uy');
const MULTIPLY = { k: 1e3, K: 1e3, thousand: 1e3, ribu: 1e3, rb: 1e3, million: 1e6, mil: 1e6, mln: 1e6, mn: 1e6, juta: 1e6, jt: 1e6 };

/**
 * A written number as a value. `dotThousands` settles "3.500": three thousand
 * five hundred in rupiah, three and a half in Kuwaiti dinars.
 */
export function parseNumber(written, { dotThousands = false } = {}) {
  const s = written.replace(/[ ']/g, '');
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let normal = null;
  if (commas === 0 && dots === 0) normal = s;
  else if (commas > 0 && dots > 0) {
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const tail = s.length - 1 - s.lastIndexOf(decimal);
    const group = decimal === ',' ? /\./g : /,/g;
    normal = tail <= 2 && (decimal === ',' ? commas : dots) === 1 ? s.replace(group, '').replace(decimal, '.') : s.replace(/[.,]/g, '');
  } else if (commas > 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) normal = s.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(s)) normal = s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) normal = s.replace(/\./g, '');
  else if (/^\d{1,3}\.\d{3}$/.test(s)) normal = dotThousands ? s.replace('.', '') : s;
  else if (/^\d+\.\d+$/.test(s)) normal = s;
  if (normal === null) return null;
  const value = Number(normal);
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------------ */
/* What the words beside a number say                                        */
/* ------------------------------------------------------------------------ */

const W = (words) => new RegExp(`(?<![\\p{L}])(?:${words})(?![\\p{L}])`, 'iu');

const FROM_BEFORE = W('from|starting|starts?|start at|begin\\w*|min|minimum|as low as|as little as|upwards of|lowest');
const FROM_AFTER = /^\s*(?:\+|and up|and above|and upwards?|upwards?|onwards|or more|and more|and over|and higher|\/night and up|up\b)/i;
const UPTO_BEFORE = /(?<![\p{L}])(?:under|below|less than|up to|upto|max|maximum|as high as|as much as|no more than)(?![\p{L}])[^\d]*$|<\s*$/i;

const SLEEP = {
  dorm: W('dorms?|dormitor(?:y|ies)|bunks?|dorm ?beds?|shared rooms?|per bed|bed in|beds? in (?:a )?(?:dorm|shared)\\w*|capsules?|bunkhouse|\\/bed|a bed'),
  camping: W('camp(?:ing|site|sites|ground|grounds|er|ers)?|tents?|tent sites?|pitch(?:es)?|caravans?|rvs?|motorhomes?|hook-?ups?|unpowered|powered|hammocks?|sleeping[- ]bags?|swags?|trailers?|own tent'),
  single: W('singles?|sgl|one person|1 person|1 pers|solo|single occupancy|einzelzimmer'),
  double: W('doubles?|dbl|twins?|couples?|2 (?:persons?|people|adults|pax|pers)|two (?:persons?|people|adults)|for two|for 2|double occupancy|queen|king|en-?suite doubles?|doppelzimmer|matrimonial'),
  larger: W('triples?|quads?|quadruples?|famil(?:y|ies)|suites?|apartments?|apts?|villas?|penthouses?|houses?|[3-9][- ](?:persons?|people|guests|beds?|bed|bedrooms?|pax)|(?:two|three|four|five|six)[- ](?:bed|bedroom)s?|sleeps|bedrooms?|four bed|whole|entire|up to \\d+ (?:persons?|people|guests)'),
  perPerson: /(?<![\p{L}])(?:pp|pppn|ppn|p\.p\.?|per person|\/ ?person|person\/night|\/ ?pers|per pers|per head|per pax|\/ ?pax|per adult|\/ ?adult|per guest|each|\/ ?p|a person|per bed)(?![\p{L}])/i,
  sharing: /(?<![\p{L}])(?:pps|ppsharing|sharing)(?![\p{L}])/i,
  week: W('week|weekly|wk|per week|a week'),
  month: W('months?|monthly|pcm|long[- ]term|per month'),
  hour: W('hours?|hrs?|hourly|short[- ]time|day use'),
  package: /(?<![\p{L}])(?:(?:\d+|two|three|four|five|six|seven)[- ]nights?|packages?|per stay|all[- ]inclusive packages?|for the weekend)(?![\p{L}])/i,
};
const EXTRA_BEFORE = /(?<![\p{L}])(?:breakfasts?|parking|extra(?: bed| person| guest)?|additional(?: person| guest)?|add|plus|surcharge|supplement|deposit|tax(?:es)?|fees?|wi-?fi|internet|pets?|dogs?|dinners?|lunch(?:es)?|tours?|sauna|bikes?|bicycles?|rentals?|laundry|shuttle|transfers?|pick-?up|discount|cleaning|linen|towels?|heating|upgrade|late check-?out|cancell?ation|kayaks?|canoes?|massage|firewood|showers?|electricity|key|cot|crib)(?![\p{L}])[\s:=-]*(?:is|are|costs?|for|at|of|about|around|only)?[\s:]*(?:an?\s+)?(?:extra|additional)?\s*$/i;
const EXTRA_AFTER = /^\s*(?:\/|per|for|each|an?)?\s*(?:extra|additional|deposit|for (?:breakfast|parking|dinner|wifi|internet|pets?|linen|a?n? ?extra)|surcharge|supplement|more(?![\p{L}])|less(?![\p{L}])|off(?![\p{L}])|discount|cheaper|tax(?![\p{L}])|resort fee|cleaning)/i;
const INCLUDED_BEFORE = /(?:incl\w*|with|w\/|and|&|plus)\s+$/i;

const ENTRY = {
  adult: W('adults?|adultos?|general admission|general|standard|regular|normal|full[- ]price|full fare|full ticket|everyone else|erwachsene'),
  reducedStrong: W('child(?:ren)?|kids?|youths?|juniors?|students?|seniors?|pensioners?|oaps?|concessions?|conc|concs|reduced|discount(?:ed)?|famil(?:y|ies)|groups?|military|veterans?|disabled|residents?|locals?|nationals?|citizens?|members?|school\\w*|infants?|toddlers?|bab(?:y|ies)|teens?|teenagers?|elderly|retired|retirees?|unemployed|indians?|thais?|saarc|natives?|domestic|carers?|pupils?|minors?|under[- ]?\\d+s?|over[- ]?\\d+s?|seniors? citizens?|niños|enfants?|kinder|locals'),
  reducedWeak: /(?<![\p{L}])(?:ages?|aged|years?|yrs?|yo|y\/o)(?![\p{L}])|\d\s*-\s*\d|\d\+/i,
  other: W('parking|vehicles?|cars?|motorcycles?|motorbikes?|bus(?:es)?|coach(?:es)?|cameras?|video|photo(?:graphy|s)?|audio[- ]?guides?|guidebooks?|lockers?|deposit|donations?|combi(?:ned|nation)?|combo|joint|multi[- ]?\\w+|pass(?:es)?|annual|yearly|season tickets?|memberships?|per kg|kg|souvenirs?|program(?:me)?s?|lodging|night|bikes?|bicycles?|boats?|trailers?|rv|horses?|skates?|rental|hire|parties|party'),
  tour: W('tours?|guided|guides?|cruises?|rides?|shows?|lessons?|class(?:es)?|courses?|workshops?|tasting|trips?|excursions?|dives?|flights?|charters?'),
};
const FREE_START = /^[\s"'(*]*(?:free(?![\p{L}])|gratis|no (?:entrance|entry|admission|cover)(?: (?:fee|charge))?(?![\p{L}])|no (?:charge|fee)(?![\p{L}])|admission(?: is)?:? free|entrance(?: is)?:? free|entry(?: is)?:? free|by donation|donations?(?![\p{L}]))/i;
const FREE_ANY = /(?<![\p{L}-])(?:free|gratis|no charge|by donation|donations? (?:welcome|accepted|appreciated|requested|suggested|encouraged))(?![\p{L}])/i;

const EAT = {
  main: W('mains?|main courses?|main dish(?:es)?|entr[ée]es?|dish(?:es)?|meals?|lunch(?:es)?|dinners?|buffets?|set (?:menu|meal|lunch|dinner)s?|menus?|men[uú] del d[ií]a|plat du jour|thalis?|plates?|pizzas?|burgers?|pasta|steaks?|per person|pp|\\/ ?person|per head|a head|\\/ ?head|average|typical|prix fixe|all you can eat|ayce|platters?|combos?|curr(?:y|ies)|noodles?|ramen|sushi|bowls?|portions?|specials?|per pax|\\/ ?pax|person|pers'),
  light: W('starters?|appeti[sz]ers?|sides?|snacks?|desserts?|breakfasts?|sandwich(?:es)?|soups?|salads?|tapas|pastr(?:y|ies)|cakes?|sweets?|small plates?|kebabs?|tacos?|slices?|pies?|bagels?|cr[eê]pes?|waffles?|ice[- ]?cream|gelato|scoops?|street food|hot dogs?|dumplings?|skewers?|samosas?|rolls?|pieces?|each|buns?|donuts?|doughnuts?|cookies?'),
  drink: W('beers?|pints?|lagers?|ales?|wines?|cocktails?|coffees?|espresso|cappuccino|lattes?|teas?|juices?|drinks?|shots?|spirits?|bottles?|glass(?:es)?|soft drinks?|sodas?|water|smoothies?|shakes?|lassi|cover(?: charge)?|corkage|delivery|service charge|tips?|minimum(?: order| spend)?|draft|draught|pitchers?|sake|whisk(?:e)?y|cl|ml|litres?|liters?|kg|per kg|\\/ ?kg|100 ?g'),
  tasting: W('tasting menus?|degustation|omakase|kaiseki|chef\'s menu|(?:[3-9]|\\d\\d|three|four|five|six|seven|eight|nine|ten)[- ]courses?'),
  forTwo: W('for two|for 2|for a couple|two people|2 people|2 persons|per couple'),
};

const SECTION_ENVELOPE_USD = { sleep: [1.5, 5000], dorm: [1, 300], camping: [0.5, 500], eat: [0.3, 600], see: [0.05, 500], do: [0.1, 5000] };

/** The plausible range, in US dollars at the observation year, for one priced thing. Outside it the reading is refused. */
export function plausibleUsd(kind, usd) {
  const range = SECTION_ENVELOPE_USD[kind];
  return Boolean(range) && usd >= range[0] && usd <= range[1];
}

/* ------------------------------------------------------------------------ */
/* Mentions                                                                  */
/* ------------------------------------------------------------------------ */

const RANGE_SEPARATOR = /^ ?(?:-|to|until|thru|through|up to|upto|~) ?$/i;

/**
 * Every number in the text with the currency notation attached to it.
 * A number is left bare when nothing beside it names a currency.
 */
function scanNumbers(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) {
      i += 1;
      continue;
    }
    let token = null;
    const prefix = readPrefix(text, i);
    for (const pattern of [NUMBER_WITH_SPACES, NUMBER_NO_SPACES]) {
      pattern.lastIndex = i;
      const m = pattern.exec(text);
      if (!m) continue;
      const end = m.index + m[0].length;
      const suffix = readSuffix(text, end);
      if (m[1].includes(' ')) {
        // "€50 100 m from the station" is not fifty thousand. A spaced group counts when a currency follows it, when it
        // opens a range, or when a currency (or the "/" of a list) leads it and the clause stops right after.
        const rest = text.slice(end, end + 6);
        const led = (prefix && !prefix.unknown) || text[i - 1] === '/' || text[i - 1] === '-';
        if (!suffix && !/^ ?(?:-|to) ?\d/.test(rest) && !(led && /^(?:$|[/,;).]|-\d| ?\()/.test(rest))) continue;
      }
      token = { written: m[1], multiplier: m[2] ? MULTIPLY[m[2]] ?? 1 : 1, start: m.index, end, suffix };
      break;
    }
    if (!token) {
      // Digits glued to something unreadable: skip the whole run.
      while (i < text.length && /[\d.,]/.test(text[i])) i += 1;
      continue;
    }
    token.prefix = prefix;
    found.push(token);
    i = token.suffix ? token.suffix.end : token.end;
  }
  return found;
}

function readPrefix(text, at) {
  const before = text.slice(Math.max(0, at - 14), at);
  const m = PREFIX_AT_END.exec(before);
  if (!m) return null;
  const token = m[1];
  const tokenStart = at - (before.length - m.index);
  const previous = tokenStart > 0 ? text[tokenStart - 1] : '';
  // A lettered token must stand alone: "Rp" in "Rp100", never the "R" in "PER100".
  if (startsWithLetter(token) && /\p{L}/u.test(previous)) return null;
  // "Bds$", "TT$" and other dollar notations this table does not know are not US dollars.
  if (!startsWithLetter(token) && /\p{Lu}/u.test(previous)) return { unknown: true, start: tokenStart };
  // A one-letter currency is written against its number: "R450", not "R 450".
  if (token.length === 1 && startsWithLetter(token) && text[at - 1] === ' ') return null;
  return { meaning: PREFIX_TOKENS.get(token), token, start: tokenStart };
}

function readSuffix(text, at) {
  const m = SUFFIX_AT_START.exec(text.slice(at, at + 16));
  if (!m) return null;
  const token = m[1];
  const end = at + m[0].length;
  if (endsWithLetter(token) && /\p{L}/u.test(text[end] ?? '')) return null;
  // "$" after a number opens the next price ("15 $20") far more often than it closes this one.
  if ((token === '$' || token === '€' || token === '£' || token === '¥') && /\d/.test(text[end] ?? '')) return null;
  // "50p" is pence; "50 p" is a stray letter.
  if (token === 'p' && m[0].length > 1) return null;
  // "1500+ baht": the plus is part of the price, and says it is a floor.
  if (m[0].startsWith('+')) return { meaning: SUFFIX_TOKENS.get(token), token, end, plus: true };
  return { meaning: SUFFIX_TOKENS.get(token), token, end };
}

/** The currency a number carries, resolved for the page's country. */
function currencyOfToken(token, iso) {
  if (token.prefix?.unknown) return { reason: 'unknown_currency' };
  const candidates = [token.prefix, token.suffix].filter(Boolean).map((side) => resolveCurrency(side.meaning, iso));
  if (candidates.length === 0) return null;
  const explicit = candidates.find((c) => c.code && c.basis === 'explicit');
  if (explicit) return explicit;
  return candidates.find((c) => c.code) ?? candidates[0];
}

/**
 * Split the words between two prices into what trails the first and what
 * leads the second: "Adult £10, child £6.50" gives "child" to the second;
 * "$10 adults; $8 children" gives "adults" to the first; "€6 (children €3)"
 * gives "children" to the second; "€9 (adults), €8" gives "adults" to the first.
 */
function splitBetween(between, labelsLead) {
  let rest = between;
  let after = '';
  const closed = /^\s*\([^()]*\)/.exec(rest);
  if (closed) {
    after = closed[0];
    rest = rest.slice(closed[0].length);
  }
  // "Super Executive room (₦30,000) and Presidential Suite (₦45,000)": a bracket that opens on the price leaves its label outside.
  const opens = /\(\s*$/.exec(rest);
  if (opens) rest = rest.slice(0, opens.index);
  const hard = /[;,(]|\. |: (?=\S)/.exec(rest);
  if (hard) {
    // "single: 950" — the colon belongs with the label that leads the next price.
    const cut = hard[0].startsWith(':') ? 0 : hard.index;
    if (hard[0].startsWith(':')) return { after, before: rest };
    return { after: after + rest.slice(0, cut), before: rest.slice(cut + 1) };
  }
  const soft = /(?<![\p{L}])(?:and|or|plus|&|\/|\+)(?![\p{L}])/iu.exec(rest);
  if (soft) return { after: after + rest.slice(0, soft.index), before: rest.slice(soft.index + soft[0].length) };
  return labelsLead ? { after, before: rest } : { after: after + rest, before: '' };
}

/* ------------------------------------------------------------------------ */
/* Tier headings                                                             */
/* ------------------------------------------------------------------------ */

const TIER = {
  budget: /^(?:budget|cheap|low[- ]budget|economy|inexpensive|shoestring|low[- ]cost|low[- ]end)(?![\p{L}])/iu,
  mid: /^(?:mid[- ]?range|moderate|medium|mid[- ]?priced?|mid[- ]?scale|mid[- ]?level|middle)(?![\p{L}])/iu,
  splurge: /^(?:splurge|top[- ]end|high[- ]end|upscale|luxury|expensive|up[- ]?market|fine dining|deluxe|upper[- ]?end)(?![\p{L}])/iu,
};
const ANY_TIER = /(?<![\p{L}])(?:budget|mid[- ]?range|moderate|splurge|top[- ]end|high[- ]end|upscale|luxury)(?![\p{L}])/giu;

/**
 * The Budget / Mid-range / Splurge tier a listing sits under, from its
 * enclosing headings, innermost first. A heading that names two tiers
 * ("Mid-range and splurge") names none.
 */
export function tierOf(headings) {
  for (const heading of headings) {
    const h = String(heading).trim();
    for (const tier of ['budget', 'mid', 'splurge']) {
      if (!TIER[tier].test(h)) continue;
      const named = new Set((h.match(ANY_TIER) ?? []).map((w) => w.toLowerCase().replace(/[- ]/g, '')));
      return named.size > 1 ? null : tier;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* One price string                                                          */
/* ------------------------------------------------------------------------ */

const HOSTEL_CONTEXT = W('hostels?|backpackers?|dorms?|dormitor(?:y|ies)|albergues?|youth hostels?|jugendherberge');
const CAMPING_CONTEXT = W('camping|campgrounds?|campsites?|camp sites?|caravan parks?|rv parks?|holiday parks?|backcountry|huts?|refuges?|shelters?|refugios?|bivouac');

/**
 * Read one `price=` value.
 *
 * @param {string} raw
 * @param {{ section: 'sleep' | 'eat' | 'see' | 'do', iso?: string | null, headings?: string[], name?: string, fx?: ReturnType<typeof createFx> }} context
 * @returns {{
 *   status: 'ok' | 'free' | 'empty' | 'no_number' | 'no_currency' | 'ambiguous_currency' | 'unknown_currency' | 'unsupported_currency' | 'excluded' | 'unreadable_number',
 *   currency?: string, currencyBasis?: 'explicit' | 'country' | 'convention',
 *   low?: number | null, high?: number | null, value?: number,
 *   bound?: 'exact' | 'range' | 'from' | 'upto',
 *   basis?: string, unit?: string, statedYear?: number | null, mentions?: number, excluded?: string[], text: string,
 * }}
 *   `low`/`high` are in `currency`, already normalised to `unit` (a week
 *   divided by seven, a per-person-sharing rate doubled). `value` is the one
 *   figure a median is taken over: the geometric middle of a range, or the
 *   single bound a "from"/"under" price gives.
 */
export function parsePrice(raw, context) {
  const fx = context.fx ?? bundledFx();
  const section = context.section;
  const iso = context.iso ?? null;
  const dated = extractStatedYear(normalisePriceText(raw));
  const text = dated.text;
  const statedYear = dated.year;
  const base = { text, statedYear };
  if (!text) return { status: 'empty', ...base };

  const priced = section === 'see' || section === 'do';
  if (priced && FREE_START.test(text)) return { status: 'free', ...base };

  const numbers = scanNumbers(text);
  if (numbers.length === 0) return priced && FREE_ANY.test(text) ? { status: 'free', ...base } : { status: 'no_number', ...base };

  /* Ranges and slash lists: "$70-$90", "1,300,000-3,000,000 dong", "₪28/24/14". */
  const mentions = [];
  const failures = new Set();
  for (let k = 0; k < numbers.length; k += 1) {
    const first = numbers[k];
    const group = [first];
    let kind = 'single';
    for (;;) {
      const last = group[group.length - 1];
      const next = numbers[k + 1];
      if (!next) break;
      const between = text.slice(last.suffix ? last.suffix.end : last.end, next.prefix && !next.prefix.unknown ? next.prefix.start : next.start);
      if (kind !== 'slash' && group.length === 1 && RANGE_SEPARATOR.test(between)) kind = 'range';
      else if (kind !== 'range' && between === '/') kind = 'slash';
      else break;
      group.push(next);
      k += 1;
      if (kind === 'range') break;
    }
    const carriers = group.map((token) => currencyOfToken(token, iso)).filter(Boolean);
    const start = first.prefix && !first.prefix.unknown ? first.prefix.start : first.start;
    const lastToken = group[group.length - 1];
    const end = lastToken.suffix ? lastToken.suffix.end : lastToken.end;
    if (carriers.length === 0) {
      mentions.push({ bare: true, group, kind, start, end });
      continue;
    }
    const failed = carriers.find((c) => c.reason);
    const resolved = carriers.find((c) => c.code);
    if (!resolved) {
      failures.add(failed.reason);
      continue;
    }
    if (carriers.some((c) => c.code && c.code !== resolved.code)) {
      // "100 baht-$5": two currencies in one range is not a range.
      failures.add('mixed_currency');
      continue;
    }
    mentions.push({ bare: false, group, kind, start, end, currency: resolved });
  }

  /* A bare number takes the currency of the price before it only when a label says what it is: "single 1100 kr, twin 1300". */
  const LABELLED = section === 'sleep' ? W('singles?|doubles?|twins?|triples?|quads?|suites?|dorms?|standard|superior|deluxe') : W('adults?|child(?:ren)?|seniors?|students?|concessions?|conc|kids?');
  let previousCurrency = null;
  const kept = [];
  for (const mention of mentions) {
    if (!mention.bare) {
      previousCurrency = mention.currency;
      kept.push(mention);
      continue;
    }
    const lead = text.slice(Math.max(0, mention.start - 24), mention.start);
    if (previousCurrency && new RegExp(`${LABELLED.source}[\\s:]*(?:rooms?|standard|from)?[\\s:]*$`, 'iu').test(lead) && mention.kind !== 'slash') {
      kept.push({ ...mention, bare: false, currency: previousCurrency, inherited: true });
    }
  }
  if (kept.length === 0) {
    if (priced && FREE_ANY.test(text)) return { status: 'free', ...base };
    if (failures.size > 0) return { status: failures.has('unknown_currency') && failures.size === 1 ? 'unknown_currency' : 'ambiguous_currency', ...base };
    return { status: 'no_currency', ...base };
  }

  /* Amounts. */
  for (const mention of kept) {
    const code = mention.currency.code;
    const magnitude = fx.magnitude(code);
    const values = mention.group.map((token) => {
      const n = parseNumber(token.written, { dotThousands: magnitude !== null && magnitude >= 20 });
      return n === null ? null : n * token.multiplier * mention.currency.scale;
    });
    // "150-200k": the multiplier belongs to both ends.
    if (mention.kind === 'range' && values[0] !== null && values[1] !== null && mention.group[0].multiplier === 1 && mention.group[1].multiplier > 1 && values[0] * mention.group[1].multiplier <= values[1]) {
      values[0] *= mention.group[1].multiplier;
    }
    // "40-60.000 dong", "10/15/18/25,000 kyat": the thousands are written once, on the last figure.
    const lastToken = mention.group[mention.group.length - 1];
    const lastValue = values[values.length - 1];
    if (values.length > 1 && lastValue !== null && lastValue >= 1000 && /[.,' ]\d{3}$/.test(lastToken.written)) {
      for (let k = 0; k < values.length - 1; k += 1) {
        if (values[k] !== null && values[k] < 1000 && mention.group[k].multiplier === 1 && values[k] * 1000 <= lastValue) values[k] *= 1000;
      }
    }
    mention.values = values;
    mention.supported = fx.has(code);
  }
  const readable = kept.filter((m) => m.values.every((v) => v !== null && v > 0));
  if (readable.length === 0) return { status: 'unreadable_number', ...base };
  if (!readable.some((m) => m.supported)) return { status: 'unsupported_currency', currency: readable[0].currency.code, ...base };

  /* Words beside each price. */
  const leadText = text.slice(0, readable[0].start);
  const leadWords = leadText.replace(/(?:(?<![\p{L}])(?:from|around|about|approx\w*|only|just|rates?|prices?|starting|start|at|is|are|c|ca|for|costs?|approximately|roughly)[\s:.~]*)+$/giu, '').trim();
  const labelsLead = /\p{L}{3,}[\s:]*$/u.test(leadWords);
  for (let k = 0; k < readable.length; k += 1) {
    const mention = readable[k];
    if (k === 0) mention.before = leadText;
    const next = readable[k + 1];
    if (next) {
      const split = splitBetween(text.slice(mention.end, next.start), labelsLead);
      mention.after = split.after;
      next.before = split.before;
    } else {
      mention.after = text.slice(mention.end);
    }
  }
  // The last price keeps only its own clause: "…, $8 children. Parking is $9 extra" must not make the $8 a parking fee.
  for (const mention of readable) {
    const stop = /[;]|\. /.exec(mention.after);
    mention.own = stop ? mention.after.slice(0, stop.index) : mention.after;
    mention.trailing = /^(?:\s*\([^()]*\))?[^,;(]*/.exec(mention.own)[0];
  }

  const headingText = [...(context.headings ?? []), context.name ?? ''].join(' | ');
  const chosen = section === 'sleep' ? chooseSleep(readable, headingText) : section === 'eat' ? chooseEat(readable) : chooseEntry(readable, section, text);
  if (chosen.status) return { ...chosen, ...base, mentions: readable.length };

  /* One currency: the first the chosen prices carry. "₹1500 (US$20)" is one price said twice. */
  const usable = chosen.picked.filter((m) => m.supported);
  if (usable.length === 0) return { status: 'unsupported_currency', currency: chosen.picked[0].currency.code, ...base };
  const currency = usable[0].currency;
  const same = usable.filter((m) => m.currency.code === currency.code);
  let low = Infinity;
  let high = -Infinity;
  let from = false;
  let upto = false;
  for (const mention of same) {
    let values = mention.kind === 'slash' && section !== 'sleep' && section !== 'eat' ? [mention.values[0]] : mention.values;
    if (mention.kind === 'slash' && section === 'sleep') {
      // "R$180/225 for a single/double": the label list says which figure is the double.
      const labels = /(?<![\p{L}])((?:s|d|t|q|sgl|dbl|singles?|doubles?|twins?|triples?|quads?)(?:\s?\/\s?(?:s|d|t|q|sgl|dbl|singles?|doubles?|twins?|triples?|quads?))+)(?![\p{L}])/i.exec(`${mention.before ?? ''} | ${mention.trailing}`);
      const names = labels ? labels[1].toLowerCase().split('/').map((l) => l.trim()) : [];
      const at = names.findIndex((l) => /^(?:d|dbl|doubles?|twins?)$/.test(l));
      if (names.length === mention.values.length && at >= 0) values = [mention.values[at]];
    }
    for (const value of values) {
      const v = value * (mention.factor ?? 1);
      if (v < low) low = v;
      if (v > high) high = v;
    }
    if (FROM_BEFORE.test(mention.before ?? '') || FROM_AFTER.test(mention.after ?? '') || mention.group.some((t) => t.suffix?.plus)) from = true;
    if (UPTO_BEFORE.test(mention.before ?? '')) upto = true;
  }
  let bound = 'exact';
  let value = low;
  if (high > low * 1.0001) {
    bound = 'range';
    value = Math.sqrt(low * high);
  } else if (from && !upto) {
    bound = 'from';
    high = null;
  } else if (upto && !from) {
    bound = 'upto';
    value = high;
    low = null;
  }
  return {
    status: 'ok',
    currency: currency.code,
    currencyBasis: currency.basis,
    low,
    high,
    value,
    bound,
    basis: chosen.basis,
    unit: chosen.unit,
    mentions: readable.length,
    excluded: chosen.excluded,
    ...base,
  };
}

const EXPLICIT_ROOM = W('privates?|private rooms?|rooms?|en-?suites?|ensuite|bungalows?|cabins?|chalets?|cottages?|studios?|huts?|rondavels?|tents?');
const NOT_A_PRICE_AFTER = /^\s*(?:\/|per|for|each|an?)?\s*(?:discount|off(?![\p{L}])|more(?![\p{L}])|less(?![\p{L}])|extra|surcharge|deposit|cheaper|supplement)/i;

/** Which prices in a Sleep listing are a room for a night, and of what kind. */
function chooseSleep(mentions, headingText) {
  const groups = { double: [], room: [], single: [], larger: [], dorm: [], camping: [], per_person: [] };
  const excluded = [];
  let explicitRoom = false;
  for (const mention of mentions) {
    const before = mention.before ?? '';
    const near = `${before} | ${mention.trailing}`.replace(/en[- ]?suite/gi, ' ');
    if ((EXTRA_BEFORE.test(before) && !INCLUDED_BEFORE.test(before.replace(EXTRA_BEFORE, ''))) || EXTRA_AFTER.test(mention.after ?? '')) {
      excluded.push('extra');
      continue;
    }
    if (SLEEP.month.test(near)) {
      excluded.push('month');
      continue;
    }
    if (SLEEP.hour.test(near)) {
      excluded.push('hourly');
      continue;
    }
    if (SLEEP.package.test(near)) {
      excluded.push('package');
      continue;
    }
    if (SLEEP.week.test(near)) {
      mention.factor = 1 / 7;
      mention.weekly = true;
    }
    if (SLEEP.dorm.test(near)) groups.dorm.push(mention);
    else if (SLEEP.sharing.test(near)) {
      mention.factor = (mention.factor ?? 1) * 2;
      mention.shared = true;
      groups.double.push(mention);
    } else if (SLEEP.perPerson.test(near)) groups.per_person.push(mention);
    else if (SLEEP.double.test(near)) groups.double.push(mention);
    else if (SLEEP.larger.test(near)) groups.larger.push(mention);
    else if (SLEEP.single.test(near)) groups.single.push(mention);
    else if (SLEEP.camping.test(near)) groups.camping.push(mention);
    else {
      if (EXPLICIT_ROOM.test(near)) explicitRoom = true;
      groups.room.push(mention);
    }
  }
  for (const basis of ['double', 'room', 'single', 'larger', 'dorm', 'camping', 'per_person']) {
    const picked = groups[basis];
    if (picked.length === 0) continue;
    let finalBasis = basis;
    // An unlabelled price under "Hostels" or "Camping" is a bed or a pitch, not a double room —
    // unless the listing prices its dorms separately, in which case this is the private room.
    if (basis === 'room' && !explicitRoom && groups.dorm.length === 0 && groups.camping.length === 0) {
      if (CAMPING_CONTEXT.test(headingText)) finalBasis = 'camping';
      else if (HOSTEL_CONTEXT.test(headingText)) finalBasis = 'dorm';
    }
    const unit = picked.some((m) => m.shared)
      ? 'night_from_per_person_sharing'
      : picked.some((m) => m.weekly)
        ? 'night_from_week'
        : finalBasis === 'dorm'
          ? 'bed_night'
          : finalBasis === 'camping'
            ? 'pitch_night'
            : finalBasis === 'per_person'
              ? 'person_night'
              : 'room_night';
    return { picked, basis: finalBasis, unit, excluded };
  }
  return { status: 'excluded', excluded };
}

const NOT_A_MEAL = W('b&b|doubles?|singles?|twins?|rooms?|nights?|dorms?|child(?:ren)?|kids?|seniors?|students?|under[- ]?\\d+|parking|entry|admission|entrance|tours?|class(?:es)?|lessons?');

/** Which prices in an Eat listing are a meal. */
function chooseEat(mentions) {
  const groups = { main: [], plain: [], light: [], tasting: [] };
  const excluded = [];
  for (const mention of mentions) {
    const near = `${mention.before ?? ''} | ${mention.trailing}`;
    if (NOT_A_PRICE_AFTER.test(mention.after ?? '')) {
      excluded.push('extra');
      continue;
    }
    if (NOT_A_MEAL.test(near)) {
      excluded.push('not_a_meal');
      continue;
    }
    if (EAT.forTwo.test(near)) mention.factor = 0.5;
    if (EAT.tasting.test(near)) groups.tasting.push(mention);
    else if (EAT.main.test(near)) groups.main.push(mention);
    else if (EAT.drink.test(near)) excluded.push('drink');
    else if (EAT.light.test(near)) groups.light.push(mention);
    else groups.plain.push(mention);
  }
  for (const basis of ['main', 'plain', 'light', 'tasting']) {
    if (groups[basis].length > 0) return { picked: groups[basis], basis, unit: 'meal', excluded };
  }
  return { status: 'excluded', excluded };
}

const FOREIGN_VISITOR = /(?<![\p{L}])(?:foreign(?:ers?)?|tourists?|non-?residents?|non-?locals?|non-?citizens?|non-?nationals?|non-?indians?|international(?: visitors?)?|overseas)(?![\p{L}])/i;
const RESIDENT = W('residents?|locals?|nationals?|citizens?|indians?|thais?|saarc|natives?|domestic|east africans?|egyptians?|kenyans?|sri lankans?|nepalis?|members?');
const CHILD = W('child(?:ren)?|kids?|youths?|juniors?|students?|seniors?|pensioners?|infants?|teens?');
const PARTY = W('famil(?:y|ies)|groups?|couples?|per (?:car|vehicle|group|boat)|\\d (?:adults|people|persons)');
const RENTAL = W('rentals?|hire|bikes?|bicycles?|boats?|horses?|skates?|kayaks?|canoes?');

/** Which prices in a See or Do listing are what one adult visitor pays. */
function chooseEntry(mentions, section, text) {
  const groups = { adult: [], plain: [], tour: [] };
  const excluded = [];
  for (const mention of mentions) {
    // "Adult €29-45 (online), discounts for residents": a label that leads the price settles what it is.
    const lead = mention.before ?? '';
    const led = ENTRY.adult.test(lead) || ENTRY.reducedStrong.test(lead) || FOREIGN_VISITOR.test(lead) || RESIDENT.test(lead) || PARTY.test(lead);
    const near = led ? lead : `${lead} | ${mention.trailing}`;
    if (NOT_A_PRICE_AFTER.test(mention.after ?? '')) {
      excluded.push('extra');
      continue;
    }
    const foreign = FOREIGN_VISITOR.test(near);
    const cleaned = near.replace(new RegExp(FOREIGN_VISITOR.source, 'gi'), ' ');
    const adult = ENTRY.adult.test(near);
    if (PARTY.test(cleaned)) {
      excluded.push('reduced');
      continue;
    }
    if (ENTRY.other.test(cleaned) && !(section === 'do' && RENTAL.test(cleaned) && !/parking|deposit/i.test(cleaned))) {
      excluded.push('other');
      continue;
    }
    if (foreign && !(CHILD.test(cleaned) && !/adults?/i.test(cleaned))) {
      groups.adult.push(mention);
      continue;
    }
    if (RESIDENT.test(cleaned)) {
      excluded.push('resident');
      continue;
    }
    if (adult) {
      groups.adult.push(mention);
      continue;
    }
    if (ENTRY.reducedStrong.test(cleaned) || ENTRY.reducedWeak.test(cleaned)) {
      excluded.push('reduced');
      continue;
    }
    if (section === 'see' && ENTRY.tour.test(cleaned)) groups.tour.push(mention);
    else groups.plain.push(mention);
  }
  for (const basis of ['adult', 'plain', 'tour']) {
    if (groups[basis].length > 0) return { picked: groups[basis], basis, unit: section === 'see' ? 'adult_entry' : 'adult_activity', excluded };
  }
  if (FREE_ANY.test(text)) return { status: 'free', excluded };
  return { status: 'excluded', excluded };
}

/* ------------------------------------------------------------------------ */
/* Summaries                                                                 */
/* ------------------------------------------------------------------------ */

/** Linear-interpolated quantile of an ascending array. */
export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Three significant figures: a median of historical prices is not known to the cent. */
export function round3(value) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toPrecision(3));
}

/** Spearman rank correlation with average ranks for ties. Null under three pairs. */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j += 1;
      for (let k = i; k <= j; k += 1) ranks[order[k][1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mean = (n + 1) / 2;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (rx[i] - mean) * (ry[i] - mean);
    sxx += (rx[i] - mean) ** 2;
    syy += (ry[i] - mean) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
