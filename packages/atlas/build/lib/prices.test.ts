import { describe, expect, it } from 'vitest';

import {
  COUNTRY_CURRENCY,
  createFx,
  normalisePriceText,
  parseLastEditYear,
  parseNumber,
  parsePrice,
  plausibleUsd,
  quantile,
  resolveCurrency,
  round3,
  spearman,
  tierOf,
} from './prices.mjs';

type Section = 'sleep' | 'eat' | 'see' | 'do';
type Expected = {
  status?: string;
  currency?: string;
  low?: number | null;
  high?: number | null;
  bound?: string;
  basis?: string;
  unit?: string;
  statedYear?: number | null;
};

/** Every string below was copied out of the English Wikivoyage dump's `price=` parameters. */
const REAL: [string, Section, string | null, Expected][] = [
  // ── Sleep: currencies and formats ──────────────────────────────────────
  ['B&B double £100', 'sleep', 'GB', { currency: 'GBP', low: 100, high: 100, bound: 'exact', basis: 'double', unit: 'room_night' }],
  ['Doubles, €70-88', 'sleep', 'FR', { currency: 'EUR', low: 70, high: 88, bound: 'range', basis: 'double' }],
  ['Apartment for two persons: {{HUF|8000}}', 'sleep', 'HU', { currency: 'HUF', low: 8000, basis: 'double' }],
  ['1,300,000-3,000,000 dong', 'sleep', 'VN', { currency: 'VND', low: 1300000, high: 3000000, bound: 'range', basis: 'room' }],
  ['From £45', 'sleep', 'GB', { currency: 'GBP', low: 45, high: null, bound: 'from' }],
  ['Prices from €57/night', 'sleep', 'GR', { currency: 'EUR', low: 57, bound: 'from', unit: 'room_night' }],
  ['₦25,000 - ₦55,000', 'sleep', 'NG', { currency: 'NGN', low: 25000, high: 55000, bound: 'range' }],
  ['$60–80', 'sleep', 'US', { currency: 'USD', low: 60, high: 80 }],
  ['From {{EUR|9}}/night', 'sleep', 'RO', { currency: 'EUR', low: 9, bound: 'from' }],
  ['From ₱850', 'sleep', 'PH', { currency: 'PHP', low: 850, bound: 'from' }],
  ['From $249', 'sleep', 'NZ', { currency: 'NZD', low: 249, bound: 'from' }],
  ['Doubles from around $800', 'sleep', 'HK', { currency: 'HKD', low: 800, bound: 'from', basis: 'double' }],
  ['169 manat', 'sleep', 'AZ', { currency: 'AZN', low: 169 }],
  ['M$1100', 'sleep', 'MX', { currency: 'MXN', low: 1100 }],
  ['140 zł for single room', 'sleep', 'PL', { currency: 'PLN', low: 140, basis: 'single' }],
  ['Doubles RO 28+ including breakfast, more expensive on weekends and during high season', 'sleep', 'OM', { currency: 'OMR', low: 28, bound: 'from', basis: 'double' }],
  ['Singles ₹2,500, doubles ₹3,000, including breakfast', 'sleep', 'IN', { currency: 'INR', low: 3000, high: 3000, basis: 'double' }],
  ['12,000 kr. double room; 3,500 kr. sleeping bag accommodation', 'sleep', 'IS', { currency: 'ISK', low: 12000, basis: 'double' }],
  ['From Rp 125,000 (includes breakfast)', 'sleep', 'ID', { currency: 'IDR', low: 125000, bound: 'from' }],
  ['{{EUR|48-126}}', 'sleep', 'PT', { currency: 'EUR', low: 48, high: 126, bound: 'range' }],
  ['Single: 950 Kč; double: 1,225 Kč', 'sleep', 'CZ', { currency: 'CZK', low: 1225, basis: 'double' }],
  ['From 600&nbsp;kr/night', 'sleep', 'SE', { currency: 'SEK', low: 600, bound: 'from' }],
  ['Single 36 лв, double 45 лв', 'sleep', 'BG', { currency: 'BGN', low: 45, basis: 'double' }],
  ['₩50,000-80,000', 'sleep', 'KR', { currency: 'KRW', low: 50000, high: 80000 }],
  ['B&B double 200 KM', 'sleep', 'BA', { currency: 'BAM', low: 200, basis: 'double' }],
  ['US$775-1,250 per night', 'sleep', 'ID', { currency: 'USD', low: 775, high: 1250, bound: 'range' }],
  ['B&B double 250 zł', 'sleep', 'PL', { currency: 'PLN', low: 250, basis: 'double' }],
  ['1,800-5,900 baht', 'sleep', 'TH', { currency: 'THB', low: 1800, high: 5900 }],
  ['1500+ baht', 'sleep', 'TH', { currency: 'THB', low: 1500, bound: 'from' }],
  ['From 1 200 kr', 'sleep', 'SE', { currency: 'SEK', low: 1200, bound: 'from' }],
  ['From Ft&nbsp;15 000', 'sleep', 'HU', { currency: 'HUF', low: 15000, bound: 'from' }],
  ['Rp 400.000', 'sleep', 'ID', { currency: 'IDR', low: 400000 }],
  ['NT $2,700 weekday, NT $3,600 weekend', 'sleep', 'TW', { currency: 'TWD', low: 2700, high: 3600 }],
  ['&yen;6400', 'sleep', 'JP', { currency: 'JPY', low: 6400 }],
  ['¥300', 'sleep', 'CN', { currency: 'CNY', low: 300 }],
  ['Double 13,500-25,000 RUR, villa (up to 7 guests) 60,000 RUR', 'sleep', 'RU', { currency: 'RUB', low: 13500, high: 25000, basis: 'double' }],
  ['Single CFA 35-40,000. Double CFA 38-43,000. Breakfast CFA 3-5,000.', 'sleep', 'SN', { currency: 'XOF', low: 38000, high: 43000, basis: 'double' }],
  ['{{currency|ZAR|680}} per room', 'sleep', 'ZA', { currency: 'ZAR', low: 680 }],
  // ── Sleep: what the price is a price of ────────────────────────────────
  ['Dorms $27, privates $70', 'sleep', 'US', { low: 70, basis: 'room', unit: 'room_night' }],
  ['Dorm €14, double (room only) €34', 'sleep', 'ES', { low: 34, basis: 'double' }],
  ['Rates start at around $25 for dorm rooms and around $65 for private rooms (rates vary)', 'sleep', 'US', { low: 65, basis: 'room' }],
  ['From R450pps', 'sleep', 'ZA', { currency: 'ZAR', low: 900, bound: 'from', basis: 'double', unit: 'night_from_per_person_sharing' }],
  ['from ₱549 per person', 'sleep', 'PH', { low: 549, basis: 'per_person', unit: 'person_night' }],
  ['Camping €12 ppn, caravan €25', 'sleep', 'IE', { basis: 'camping', unit: 'pitch_night' }],
  ['From R$180/225 for a single/double', 'sleep', 'BR', { currency: 'BRL', low: 225, basis: 'double' }],
  ['2 bath apartments from $900/week', 'sleep', 'US', { basis: 'larger', unit: 'night_from_week' }],
  ['Two night packages from ₹7,000/₹10,000. (mid/high season)', 'sleep', 'IN', { status: 'excluded' }],
  ['3 nights from £700', 'sleep', 'GB', { status: 'excluded' }],
  // ── Eat ────────────────────────────────────────────────────────────────
  ['Mains 1,500-15,000 dram (Jan 2018)', 'eat', 'AM', { currency: 'AMD', low: 1500, high: 15000, basis: 'main', statedYear: 2018 }],
  ['Starters $11, mains $15-20', 'eat', 'US', { low: 15, high: 20, basis: 'main' }],
  ['Rp12,000-25,000 per dish', 'eat', 'ID', { currency: 'IDR', low: 12000, high: 25000, basis: 'main' }],
  ['Under Ksh 1000', 'eat', 'KE', { currency: 'KES', low: null, high: 1000, bound: 'upto' }],
  ['2000-6000 CFA/main', 'eat', 'BJ', { currency: 'XOF', low: 2000, high: 6000, basis: 'main' }],
  ['¥66（per person on average）', 'eat', 'CN', { currency: 'CNY', low: 66, basis: 'main' }],
  ['Unlimited thali: ₹150', 'eat', 'IN', { currency: 'INR', low: 150, basis: 'main' }],
  ['40-60.000 dong', 'eat', 'VN', { currency: 'VND', low: 40000, high: 60000 }],
  ['KD 3.500', 'eat', 'KW', { currency: 'KWD', low: 3.5 }],
  ['C$500', 'eat', 'NI', { currency: 'NIO', low: 500 }],
  ['AR$20,000', 'eat', 'AR', { currency: 'ARS', low: 20000 }],
  ['Bs. 20', 'eat', 'BO', { currency: 'BOB', low: 20 }],
  ['PHP100-500', 'eat', 'PH', { currency: 'PHP', low: 100, high: 500 }],
  ['€6 (Jan 2020)', 'eat', 'DE', { currency: 'EUR', low: 6, statedYear: 2020 }],
  ['B&B double €150', 'eat', 'IE', { status: 'excluded' }],
  // ── See and Do ─────────────────────────────────────────────────────────
  ['Adult £10, child £6.50, conc £9', 'see', 'GB', { currency: 'GBP', low: 10, high: 10, basis: 'adult', unit: 'adult_entry' }],
  ['Adults $10, seniors (65+) or youth (12-17) $8, child (5-11) $5, under 5 free', 'see', 'CA', { currency: 'CAD', low: 10, basis: 'adult' }],
  ['€4 (adults), €3.60 (Ö1 Club and Vienna Card), €3.50 (seniors), €3 (students/military/disabled)', 'see', 'AT', { low: 4, high: 4, basis: 'adult' }],
  ['₹300 for foreigners and ₹25 for Indians', 'see', 'IN', { currency: 'INR', low: 300, high: 300, basis: 'adult' }],
  ['Rp20,000 for locals, Rp210,000 for foreigners (Rp310,000 on sundays+holidays)', 'see', 'ID', { currency: 'IDR', low: 210000, basis: 'adult' }],
  ['₪28/24/14 adult/student/child', 'see', 'IL', { currency: 'ILS', low: 28, high: 28 }],
  ['Fr.&nbsp;8/3', 'see', 'CH', { currency: 'CHF', low: 8, high: 8 }],
  ['€6 (children €3)', 'see', 'DE', { low: 6, high: 6 }],
  ['8 zł (5 zł reduced)', 'see', 'PL', { currency: 'PLN', low: 8, high: 8 }],
  ['S/152', 'see', 'PE', { currency: 'PEN', low: 152 }],
  ['Adult: $15, concession: $13, child: $9, family (2 adults + 2 children or 1 adult + 3 children): $39.50', 'see', 'AU', { currency: 'AUD', low: 15, high: 15 }],
  ['Adult €29-€45 (online) discounts for residents, children, students & seniors. demand led pricing.', 'see', 'ES', { low: 29, high: 45, basis: 'adult' }],
  ['Free', 'see', 'GB', { status: 'free' }],
  ['No admission; by donation', 'see', 'CA', { status: 'free' }],
  ['Free, guided tour adult £5, conc £3.75', 'see', 'GB', { status: 'free' }],
  ['Free admission', 'do', 'US', { status: 'free' }],
  ['$6 per vehicle', 'do', 'US', { status: 'excluded' }],
  ['Parking is $6 for non-members', 'do', 'US', { status: 'excluded' }],
  ['$15 /car', 'do', 'US', { status: 'excluded' }],
  // ── Refused rather than guessed ────────────────────────────────────────
  ['$5', 'see', 'MX', { status: 'ambiguous_currency' }],
  ['Double $100', 'sleep', 'AR', { status: 'ambiguous_currency' }],
  ['Adult $20, child $10', 'see', 'BB', { status: 'ambiguous_currency' }],
  ['M$1100', 'sleep', 'MY', { status: 'ambiguous_currency' }],
  ['400', 'sleep', 'IN', { status: 'no_currency' }],
  ['50-100', 'sleep', 'GR', { status: 'no_currency' }],
  ['€€€', 'eat', 'FI', { status: 'no_number' }],
  ['Phone for rates and availability.', 'sleep', 'AU', { status: 'no_number' }],
  ['varies', 'do', 'US', { status: 'no_number' }],
];

describe('parsePrice on strings from the dump', () => {
  it('holds at least 60 real strings', () => {
    expect(REAL.length).toBeGreaterThanOrEqual(60);
  });

  it.each(REAL)('%s (%s, %s)', (raw, section, iso, expected) => {
    const reading = parsePrice(raw, { section, iso, fx: FX });
    expect(reading).toMatchObject({ status: 'ok', ...expected });
  });
});

describe('what a heading says about a price', () => {
  it('reads an unlabelled price under Hostels as a bed', () => {
    expect(parsePrice('€25', { section: 'sleep', iso: 'DE', headings: ['Hostels'], fx: FX })).toMatchObject({ basis: 'dorm', unit: 'bed_night' });
  });
  it('reads an unlabelled price under Camping as a pitch', () => {
    expect(parsePrice('$30', { section: 'sleep', iso: 'US', headings: ['Campgrounds'], fx: FX })).toMatchObject({ basis: 'camping', unit: 'pitch_night' });
  });
  it('keeps a labelled private room under Hostels a room', () => {
    expect(parsePrice('Private room €60', { section: 'sleep', iso: 'DE', headings: ['Hostels'], fx: FX })).toMatchObject({ basis: 'room' });
  });
});

describe('tierOf', () => {
  it('reads the standard headings', () => {
    expect(tierOf(['Budget'])).toBe('budget');
    expect(tierOf(['Mid-range'])).toBe('mid');
    expect(tierOf(['Mid range'])).toBe('mid');
    expect(tierOf(['Midrange'])).toBe('mid');
    expect(tierOf(['Splurge'])).toBe('splurge');
  });
  it('takes the innermost heading that names a tier', () => {
    expect(tierOf(['Old town', 'Budget'])).toBe('budget');
  });
  it('refuses a heading that names two tiers, and one that names none', () => {
    expect(tierOf(['Mid-range and splurge'])).toBeNull();
    expect(tierOf(['Hotels'])).toBeNull();
  });
});

describe('resolveCurrency', () => {
  const dollar = { family: 'dollar' };
  it('reads "$" as the local dollar where the country has one', () => {
    expect(resolveCurrency(dollar, 'AU')).toMatchObject({ code: 'AUD', basis: 'country' });
    expect(resolveCurrency(dollar, 'CA')).toMatchObject({ code: 'CAD' });
    expect(resolveCurrency(dollar, 'HK')).toMatchObject({ code: 'HKD' });
  });
  it('reads "$" as US dollars where the country has no dollar of its own', () => {
    expect(resolveCurrency(dollar, 'KH')).toMatchObject({ code: 'USD', basis: 'convention' });
  });
  it('drops "$" where a local "$" and the US dollar are both quoted, or the country is unknown', () => {
    for (const iso of ['MX', 'AR', 'CO', 'BB', 'JM', 'FJ', 'TW']) expect(resolveCurrency(dollar, iso)).toEqual({ reason: 'ambiguous_currency' });
    expect(resolveCurrency(dollar, null)).toEqual({ reason: 'ambiguous_currency' });
  });
  it('reads "¥" by country and refuses it elsewhere', () => {
    expect(resolveCurrency({ family: 'yen' }, 'JP')).toMatchObject({ code: 'JPY' });
    expect(resolveCurrency({ family: 'yen' }, 'CN')).toMatchObject({ code: 'CNY' });
    expect(resolveCurrency({ family: 'yen' }, 'KR')).toEqual({ reason: 'ambiguous_currency' });
  });
  it('knows the euro members and the CFA zones', () => {
    expect(COUNTRY_CURRENCY.get('HR')).toBe('EUR');
    expect(COUNTRY_CURRENCY.get('SN')).toBe('XOF');
    expect(COUNTRY_CURRENCY.get('CM')).toBe('XAF');
  });
});

describe('parseNumber', () => {
  it('reads separators', () => {
    expect(parseNumber('1,300,000')).toBe(1300000);
    expect(parseNumber('1.300.000')).toBe(1300000);
    expect(parseNumber('12 500')).toBe(12500);
    expect(parseNumber('1,234.56')).toBeCloseTo(1234.56);
    expect(parseNumber('1.234,56')).toBeCloseTo(1234.56);
    expect(parseNumber('27,50')).toBeCloseTo(27.5);
  });
  it('settles a lone ".000" by the size of the currency', () => {
    expect(parseNumber('3.500', { dotThousands: true })).toBe(3500);
    expect(parseNumber('3.500', { dotThousands: false })).toBeCloseTo(3.5);
  });
});

describe('parseLastEditYear', () => {
  it('reads the forms the dump holds', () => {
    expect(parseLastEditYear('2024-07-17')).toBe(2024);
    expect(parseLastEditYear('2023-01')).toBe(2023);
    expect(parseLastEditYear('31-08-2023')).toBe(2023);
    expect(parseLastEditYear('2022/08/01')).toBe(2022);
    expect(parseLastEditYear('October 2019')).toBe(2019);
  });
  it('refuses nonsense', () => {
    expect(parseLastEditYear('0202-01-01')).toBeNull();
    expect(parseLastEditYear('')).toBeNull();
    expect(parseLastEditYear(undefined)).toBeNull();
  });
});

describe('normalisePriceText', () => {
  it('renders currency templates and decodes entities', () => {
    expect(normalisePriceText('{{HUF|12,505}}')).toBe('HUF 12,505');
    expect(normalisePriceText('{{currency|ZAR|680}}')).toBe('ZAR 680');
    expect(normalisePriceText('600&nbsp;kr')).toBe('600 kr');
    expect(normalisePriceText('$60–80')).toBe('$60-80');
  });
});

/** A small table with round numbers, so each conversion can be checked by hand. */
const FX = createFx({
  baseYear: 2024,
  fx: {
    AUD: { 2020: 1.5, 2024: 1.5 }, AZN: { 2020: 1.7, 2024: 1.7 }, ARS: { 2020: 70, 2024: 900 }, AMD: { 2018: 480, 2024: 400 },
    BAM: { 2020: 1.7, 2024: 1.8 }, BGN: { 2020: 1.7, 2024: 1.8 }, BOB: { 2020: 6.9, 2024: 6.9 }, BRL: { 2020: 5, 2024: 5 },
    BYN: { 2015: 1.6, 2024: 3.2 }, CAD: { 2020: 1.3, 2024: 1.4 }, CHF: { 2020: 0.9, 2024: 0.9 }, CNY: { 2020: 7, 2024: 7 },
    CZK: { 2020: 23, 2024: 23 }, EUR: { 2015: 0.9, 2020: 0.9, 2024: 0.9 }, GBP: { 2020: 0.8, 2024: 0.8 }, HKD: { 2020: 7.8, 2024: 7.8 },
    HUF: { 2020: 300, 2024: 360 }, IDR: { 2020: 14500, 2024: 15900 }, ILS: { 2020: 3.4, 2024: 3.7 }, INR: { 2020: 74, 2024: 84 },
    ISK: { 2020: 135, 2024: 138 }, JPY: { 2020: 107, 2024: 150 }, KES: { 2020: 106, 2024: 130 }, KRW: { 2020: 1180, 2024: 1360 },
    KWD: { 2020: 0.3, 2024: 0.3 }, MXN: { 2020: 21, 2024: 18 }, NGN: { 2020: 360, 2024: 1480 }, NIO: { 2020: 34, 2024: 36 },
    NZD: { 2020: 1.5, 2024: 1.6 }, OMR: { 2020: 0.38, 2024: 0.38 }, PEN: { 2020: 3.5, 2024: 3.8 }, PHP: { 2020: 50, 2024: 57 },
    PLN: { 2020: 3.9, 2024: 4 }, RUB: { 2020: 72, 2024: 92 }, SEK: { 2020: 9.2, 2024: 10.5 }, THB: { 2020: 31, 2024: 35 },
    TWD: { 2020: 29.5, 2024: 32 }, VND: { 2020: 23200, 2024: 24200 }, XOF: { 2020: 575, 2024: 606 }, ZAR: { 2020: 16, 2024: 18 },
  },
  cpi: {
    US: { 2015: 100, 2020: 110, 2024: 130 },
    DE: { 2015: 100, 2024: 125 },
    TR: { 2020: 100, 2024: 500 },
  },
});

describe('createFx', () => {
  it('converts at the observation year and falls back to the nearest year, saying how far', () => {
    expect(FX.convert(90, 'EUR', 2020, 'DE')).toMatchObject({ usd: 100, fxGap: 0 });
    expect(FX.convert(90, 'EUR', 2019, 'DE')).toMatchObject({ usd: 100, fxGap: 1 });
  });
  it('inflates with the issuing economy, then converts at the base year', () => {
    const r = FX.convert(90, 'EUR', 2015, 'DE');
    expect(r?.realBasis).toBe('currency_cpi');
    expect(r?.usdBase).toBeCloseTo((90 * 1.25) / 0.9);
  });
  it('falls back to the US index where the local one is missing', () => {
    const r = FX.convert(5, 'BRL', 2020, 'BR');
    expect(r?.realBasis).toBe('us_cpi_fallback');
    expect(r?.usd).toBeCloseTo(1);
    expect(r?.usdBase).toBeCloseTo(130 / 110);
  });
  it('scales the rate back for a price written before a redenomination', () => {
    expect(FX.rate('BYN', 2015)?.value).toBeCloseTo(16000);
    expect(FX.rate('BYN', 2024)?.value).toBeCloseTo(3.2);
  });
  it('returns nothing for a currency with no series', () => {
    expect(FX.convert(10, 'CUP', 2020, 'CU')).toBeNull();
  });
  it('flags a year in which the official rate was not the street rate', () => {
    expect(FX.convert(1000, 'NGN', 2020, 'NG')?.fxCaveat).toBe(true);
    expect(FX.convert(90, 'EUR', 2020, 'DE')?.fxCaveat).toBe(false);
  });
});

describe('summary helpers', () => {
  it('computes quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });
  it('rounds to three significant figures', () => {
    expect(round3(1234)).toBe(1230);
    expect(round3(0.01234)).toBeCloseTo(0.0123);
  });
  it('computes a rank correlation with ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1);
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });
  it('holds the plausibility envelope', () => {
    expect(plausibleUsd('sleep', 80)).toBe(true);
    expect(plausibleUsd('sleep', 0.5)).toBe(false);
    expect(plausibleUsd('sleep', 9000)).toBe(false);
    expect(plausibleUsd('eat', 15)).toBe(true);
  });
});
