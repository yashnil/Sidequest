import { z } from 'zod';
import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';
import type { BookedPlanItem } from './booking';
import type { TransportLeg } from './transport';

/**
 * BUDGET AS RANGES WITH A BASIS.
 *
 * Nothing here is a price Sidequest looked up. Every line is a band derived
 * from the traveller's own spending style and the shape of the plan (nights,
 * kilometres, paid stops, guides, permits), labelled as such, with what it
 * includes and excludes. Booked costs the traveller entered are the only
 * actuals, and they are kept apart from the estimates.
 */
export const BUDGET_CATEGORIES = ['lodging', 'long_distance_transport', 'local_transport', 'car_fuel_tolls_parking', 'activities', 'permits', 'food', 'guides_tours', 'insurance', 'miscellaneous'] as const;
export const budgetCategorySchema = z.enum(BUDGET_CATEGORIES);
export type BudgetCategory = z.infer<typeof budgetCategorySchema>;

export const BUDGET_CATEGORY_LABELS: Record<BudgetCategory, string> = {
  lodging: 'Where you sleep',
  long_distance_transport: 'Getting there and between regions',
  local_transport: 'Getting around locally',
  car_fuel_tolls_parking: 'Car: fuel, tolls, parking',
  activities: 'Activities and entry',
  permits: 'Permits and passes',
  food: 'Food',
  guides_tours: 'Guides and tours',
  insurance: 'Insurance',
  miscellaneous: 'Everything else',
};

export const budgetLineSchema = z.object({
  category: budgetCategorySchema,
  currency: z.string().min(1),
  low: z.number().min(0),
  high: z.number().min(0),
  perPerson: z.boolean(),
  basis: z.string().min(1),
  includes: z.array(z.string().min(1)).default([]),
  excludes: z.array(z.string().min(1)).default([]),
  provenance: z.enum(['estimate_from_style_bands', 'derived_from_plan', 'booked']),
  /** What the traveller has actually paid or been quoted in this category, from their booked items. */
  actual: z.object({ amount: z.number().min(0), currency: z.string().min(1), items: z.number().int().min(1), complete: z.boolean() }).optional(),
});
export type BudgetLine = z.infer<typeof budgetLineSchema>;

export const fxRateSchema = z.object({
  base: z.string().min(1),
  quote: z.string().min(1),
  rate: z.number().positive(),
  asOf: z.string().min(1),
  source: z.string().min(1),
});
export type FxRate = z.infer<typeof fxRateSchema>;

export const budgetIntelligenceSchema = z.object({
  currency: z.string().min(1),
  currencyBasis: z.enum(['traveller_envelope', 'assumed_reference']),
  conversionNote: z.string().min(1),
  travellers: z.number().int().min(1),
  lines: z.array(budgetLineSchema),
  total: z.object({ low: z.number().min(0), high: z.number().min(0), perPerson: z.boolean() }),
  envelope: z.object({ amount: z.number().min(0), basis: z.string().min(1), fit: z.enum(['within', 'tight', 'over', 'unknown']) }).optional(),
  strategy: z.object({ saveHere: z.array(z.string().min(1)), spendHere: z.array(z.string().min(1)) }),
  booked: z.array(z.object({ title: z.string().min(1), amount: z.number().min(0), currency: z.string().min(1) })).default([]),
  /** Estimate vs actual, merged: the remaining estimate excludes categories the traveller has fully booked. */
  actualTotal: z.object({ amount: z.number().min(0), currency: z.string().min(1) }).optional(),
  remainingEstimate: z.object({ low: z.number().min(0), high: z.number().min(0) }).optional(),
  fx: fxRateSchema.optional(),
  displayCurrency: z.string().min(1).optional(),
  converted: z.object({ low: z.number().min(0), high: z.number().min(0), note: z.string().min(1) }).optional(),
  precisionNote: z.string().min(1),
});
export type BudgetIntelligence = z.infer<typeof budgetIntelligenceSchema>;

type Style = TravelerProfile['budgetStyle'];

/** Per-person, per-night or per-day bands in a reference currency. Assumptions, not prices. */
const LODGING_PER_NIGHT: Record<Style, [number, number]> = { budget: [35, 90], midrange: [90, 190], premium: [190, 380], luxury: [380, 900] };
const FOOD_PER_DAY: Record<Style, [number, number]> = { budget: [20, 40], midrange: [40, 80], premium: [80, 150], luxury: [150, 320] };
const PAID_STOP: Record<Style, [number, number]> = { budget: [8, 25], midrange: [15, 45], premium: [25, 80], luxury: [40, 150] };
const GUIDE_DAY: Record<Style, [number, number]> = { budget: [60, 150], midrange: [120, 300], premium: [250, 600], luxury: [500, 1500] };
const LOCAL_TRANSIT_DAY: [number, number] = [6, 20];
const RENTAL_DAY: Record<Style, [number, number]> = { budget: [35, 70], midrange: [55, 110], premium: [90, 200], luxury: [150, 400] };
const FUEL_PER_KM: [number, number] = [0.1, 0.2];
const FLIGHT_LEG: [number, number] = [80, 300];
const FERRY_LEG: [number, number] = [10, 90];
const PERMIT: [number, number] = [5, 60];

const PAID_CATEGORIES = new Set(['museum', 'activity', 'historic', 'geothermal', 'wildlife', 'landmark']);

export interface BudgetInput {
  itinerary: Itinerary;
  pkg: TripPackage | undefined;
  profile: TravelerProfile;
  travellers: number;
  legs: readonly TransportLeg[];
  booked: readonly BookedPlanItem[];
  permitCount: number;
  guideDays: number;
  international: 'yes' | 'no' | 'unknown';
  /** A reference rate from the FX provider, when one is configured and the traveller's currency differs. */
  fx?: FxRate | null;
  displayCurrency?: string;
}

export function buildBudgetIntelligence(input: BudgetInput): BudgetIntelligence {
  const { itinerary, profile } = input;
  const style = profile.budgetStyle;
  const envelope = profile.interview.budgetEnvelope as { amount?: number; basis?: string; currency?: string } | undefined;
  const currency = envelope?.currency ?? 'USD';
  const currencyBasis: BudgetIntelligence['currencyBasis'] = envelope?.currency ? 'traveller_envelope' : 'assumed_reference';
  const nights = Math.max(0, itinerary.days.length - 1);
  const days = itinerary.days.length;
  const lines: BudgetLine[] = [];
  const push = (category: BudgetCategory, band: [number, number], multiplier: number, perPerson: boolean, basis: string, includes: string[] = [], excludes: string[] = [], provenance: BudgetLine['provenance'] = 'estimate_from_style_bands') => {
    if (multiplier <= 0) return;
    lines.push(budgetLineSchema.parse({ category, currency, low: Math.round(band[0] * multiplier), high: Math.round(band[1] * multiplier), perPerson, basis, includes, excludes, provenance }));
  };

  push('lodging', LODGING_PER_NIGHT[style], nights, false, `${nights} nights at a ${style} band per room or unit`, ['Room or unit per night'], ['City taxes, resort fees']);
  push('food', FOOD_PER_DAY[style], days, true, `${days} days at a ${style} band`, ['Three meals, coffee, water'], ['Alcohol beyond a drink with dinner']);
  const paidStops = itinerary.days.reduce((n, day) => n + day.items.filter((i) => i.kind === 'activity' && PAID_CATEGORIES.has(categoryOf(input.pkg, i.placeId, i.id))).length, 0);
  push('activities', PAID_STOP[style], paidStops, true, `${paidStops} stops that usually charge entry`, ['Entry tickets'], ['Optional extras, audio guides']);
  push('permits', PERMIT, input.permitCount, true, `${input.permitCount} permit${input.permitCount === 1 ? '' : 's'} or passes on the plan`, [], [], 'derived_from_plan');
  push('guides_tours', GUIDE_DAY[style], input.guideDays, true, `${input.guideDays} guided day${input.guideDays === 1 ? '' : 's'}`, ['Guide or operator fee'], ['Tips']);

  const primary = itinerary.transportStrategy.primaryMode;
  const driveKm = itinerary.transportStrategy.totals.driveKm;
  if (primary === 'drive' || driveKm > 0) {
    push('car_fuel_tolls_parking', RENTAL_DAY[style], days, false, `${days} rental days plus fuel for about ${Math.round(driveKm)} km`, ['Rental, basic insurance, fuel'], ['Tolls, parking, one-way fees, full excess cover']);
    if (driveKm > 0) {
      const fuel = lines[lines.length - 1]!;
      fuel.low += Math.round(FUEL_PER_KM[0] * driveKm);
      fuel.high += Math.round(FUEL_PER_KM[1] * driveKm);
    }
  }
  if (primary === 'rail' || primary === 'public_bus' || primary === 'walk') {
    push('local_transport', LOCAL_TRANSIT_DAY, days, true, `${days} days of local transit`, ['Metro, bus, tram'], ['Taxis late at night'], 'derived_from_plan');
  }
  const flights = input.legs.filter((l) => l.mode === 'flight').length;
  const ferries = input.legs.filter((l) => l.mode === 'ferry' || l.mode === 'boat').length;
  if (flights > 0 || ferries > 0) {
    lines.push(budgetLineSchema.parse({ category: 'long_distance_transport', currency, low: flights * FLIGHT_LEG[0] + ferries * FERRY_LEG[0], high: flights * FLIGHT_LEG[1] + ferries * FERRY_LEG[1], perPerson: true, basis: `${flights} internal flight${flights === 1 ? '' : 's'}, ${ferries} ferry or boat leg${ferries === 1 ? '' : 's'}`, includes: ['Standard fares'], excludes: ['Flights to and from the destination'], provenance: 'derived_from_plan' }));
  }
  if (input.international === 'yes') push('insurance', [3, 10], days, true, `${days} days of travel medical cover`, ['Medical, cancellation'], ['Activity riders'], 'estimate_from_style_bands');
  push('miscellaneous', [5, 15], days, true, 'A small daily allowance for the unplanned', ['Souvenirs, laundry, tips'], []);

  const perPersonTotal = lines.reduce((sum, l) => sum + (l.perPerson ? l.low * input.travellers : l.low), 0);
  const perPersonTotalHigh = lines.reduce((sum, l) => sum + (l.perPerson ? l.high * input.travellers : l.high), 0);
  const total = { low: perPersonTotal, high: perPersonTotalHigh, perPerson: false };

  let envelopeOut: BudgetIntelligence['envelope'];
  if (envelope?.amount) {
    const basis = envelope.basis ?? 'per_person';
    const partyEnvelope = basis.includes('person') ? envelope.amount * input.travellers : envelope.amount;
    const fit: NonNullable<BudgetIntelligence['envelope']>['fit'] = partyEnvelope >= total.high ? 'within' : partyEnvelope >= total.low ? 'tight' : 'over';
    envelopeOut = { amount: envelope.amount, basis, fit };
  }

  const saveHere: string[] = [];
  const spendHere: string[] = [];
  const spend = profile.interview.convenienceSpend;
  if (profile.food.specialMealAppetite !== 'none') {
    saveHere.push('Casual lunches most days');
    spendHere.push(profile.food.specialMealAppetite === 'one' ? 'One dinner worth booking' : 'A few dinners worth booking');
  } else saveHere.push('Simple meals throughout');
  if (spend === 'pay_to_reduce_hassle') spendHere.push('Transfers and tickets that remove queues and logistics');
  if (spend === 'save_money') saveHere.push('Public transport and self-guided days over paid transfers');
  if (input.guideDays > 0) spendHere.push('The guided days — they are the reason for the trip');
  if (style === 'budget' || style === 'midrange') saveHere.push('Lodging: location over luxury');
  if (style === 'premium' || style === 'luxury') spendHere.push('Lodging that makes the base worth returning to');

  const booked = input.booked.filter((b) => b.cost).map((b) => ({ title: b.title, amount: b.cost!.amount, currency: b.cost!.currency }));

  /*
   * ESTIMATE MEETS ACTUAL. A booked cost lands on its category as an `actual`;
   * the category is marked complete when every dependency of that kind is
   * booked, and the remaining estimate drops it.
   */
  const categoryOfBooked = (type: BookedPlanItem['type']): BudgetCategory => (type === 'lodging' ? 'lodging' : type === 'rental_car' ? 'car_fuel_tolls_parking' : type === 'flight' || type === 'train' || type === 'ferry' ? 'long_distance_transport' : type === 'transfer' ? 'local_transport' : type === 'restaurant' ? 'food' : type === 'activity' || type === 'event' ? 'activities' : 'miscellaneous');
  const actualsByCategory = new Map<BudgetCategory, { amount: number; currency: string; items: number }>();
  for (const b of input.booked) {
    if (!b.cost || b.status !== 'booked') continue;
    const cat = categoryOfBooked(b.type);
    const current = actualsByCategory.get(cat);
    if (current && current.currency !== b.cost.currency) continue;
    actualsByCategory.set(cat, { amount: (current?.amount ?? 0) + b.cost.amount, currency: b.cost.currency, items: (current?.items ?? 0) + 1 });
  }
  const bookedLodgingNights = input.booked.filter((b) => b.type === 'lodging' && b.status === 'booked' && b.date && b.endDate).reduce((n, b) => n + Math.max(0, (Date.parse(`${b.endDate}T00:00:00Z`) - Date.parse(`${b.date}T00:00:00Z`)) / 86_400_000), 0);
  for (const line of lines) {
    const actual = actualsByCategory.get(line.category);
    if (!actual) continue;
    const complete = line.category === 'lodging' ? bookedLodgingNights >= nights : line.category === 'long_distance_transport' ? flights + ferries > 0 && actual.items >= flights + ferries : false;
    line.actual = { ...actual, complete };
  }
  const actualTotalAmount = [...actualsByCategory.values()].reduce((n, a) => n + a.amount, 0);
  const actualCurrency = [...actualsByCategory.values()][0]?.currency;
  const remaining = lines.filter((l) => !l.actual?.complete);
  const remainingEstimate = { low: remaining.reduce((sum, l) => sum + (l.perPerson ? l.low * input.travellers : l.low), 0), high: remaining.reduce((sum, l) => sum + (l.perPerson ? l.high * input.travellers : l.high), 0) };

  const fx = input.fx && input.displayCurrency && input.fx.base === currency && input.fx.quote === input.displayCurrency ? input.fx : undefined;
  const converted = fx ? { low: Math.round(total.low * fx.rate), high: Math.round(total.high * fx.rate), note: `≈ ${fx.quote} at the ${fx.source} reference rate of ${fx.asOf}; conversions are approximate and dated.` } : undefined;

  return budgetIntelligenceSchema.parse({
    currency,
    currencyBasis,
    conversionNote: fx ? `Bands in ${currency}; ${fx.quote} figures use the ${fx.source} reference rate of ${fx.asOf} and are approximate.` : currencyBasis === 'traveller_envelope' ? `Bands shown in ${currency} as you set it; no exchange rate was applied.` : 'Bands are reference figures in USD-equivalent; local prices and exchange rates were not looked up.',
    travellers: input.travellers,
    lines,
    total,
    ...(envelopeOut ? { envelope: envelopeOut } : {}),
    strategy: { saveHere, spendHere },
    booked,
    ...(actualsByCategory.size > 0 && actualCurrency ? { actualTotal: { amount: actualTotalAmount, currency: actualCurrency }, remainingEstimate } : {}),
    ...(fx ? { fx, displayCurrency: fx.quote, converted } : {}),
    precisionNote: 'Ranges, not quotes. Sidequest did not look up a single price for this trip; the bands come from your spending style and the shape of the plan.',
  });
}

function categoryOf(pkg: TripPackage | undefined, placeId: string | undefined, itemId: string): string {
  if (!pkg) return 'other';
  const anchor = pkg.anchors.find((a) => (placeId && a.placeId === placeId) || a.id === itemId);
  return anchor?.category ?? 'other';
}

/** ISO-3166 alpha-2 → ISO-4217, for the destinations Sidequest most often plans. Unknown countries return null and the budget stays in the traveller's currency. */
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  US: 'USD', CA: 'CAD', MX: 'MXN', GB: 'GBP', IE: 'EUR', FR: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR', HR: 'EUR', SI: 'EUR', SK: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR',
  IS: 'ISK', NO: 'NOK', SE: 'SEK', DK: 'DKK', CH: 'CHF', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', TR: 'TRY',
  JP: 'JPY', KR: 'KRW', CN: 'CNY', HK: 'HKD', TW: 'TWD', SG: 'SGD', MY: 'MYR', TH: 'THB', VN: 'VND', ID: 'IDR', PH: 'PHP', IN: 'INR', LK: 'LKR', NP: 'NPR', AE: 'AED', IL: 'ILS', JO: 'JOD', EG: 'EGP', MA: 'MAD', ZA: 'ZAR', KE: 'KES', TZ: 'TZS',
  AU: 'AUD', NZ: 'NZD', FJ: 'FJD', BR: 'BRL', AR: 'ARS', CL: 'CLP', PE: 'PEN', CO: 'COP', CR: 'CRC', PA: 'USD', EC: 'USD',
};

export function currencyForCountry(countryCode: string | undefined): string | null {
  if (!countryCode) return null;
  return CURRENCY_BY_COUNTRY[countryCode.toUpperCase()] ?? null;
}
