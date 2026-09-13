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
  /** V7 §14 — how much to trust the band: an estimate, or a category Sidequest knows exists but cannot price (the band is a placeholder and says so). */
  precision: z.enum(['estimated', 'unknown']).default('estimated'),
  /** V7 §14 — lodging and transport bought as one thing (a cruise cabin, a safari camp with drives). */
  bundle: z.boolean().optional(),
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
/* V7 §14 — the transport a plan with a hired driver, regional trains or a cruise actually buys. Bands, never quotes. */
const RAIL_LEG: [number, number] = [15, 120];
const DRIVER_DAY: Record<Style, [number, number]> = { budget: [40, 90], midrange: [60, 140], premium: [100, 220], luxury: [160, 400] };
const CRUISE_NIGHT: Record<Style, [number, number]> = { budget: [90, 180], midrange: [150, 320], premium: [260, 520], luxury: [450, 1000] };
/**
 * V11 §36 — A SUPPORTED MULTI-DAY EXPERIENCE, PER PERSON PER DAY.
 *
 * The founder's Kyrgyzstan trip carried a three-day guided trek with camp
 * support and a two-day yurt-and-horse expedition, and priced the pair at
 * **nothing**: the `guides_tours` line said "3 days with a hired car and driver,
 * 180–420 for the party", and the two operated experiences its own Book-first
 * page called trip-critical had no cost line at all. A packaged multi-day
 * experience is a guide, a bed, meals and often animals or a vehicle bought as
 * one product; it is not a guide day, and it is emphatically not an "activity
 * entry".
 *
 * Wide on purpose, and carried at `precision: 'unknown'` like the cruise band
 * above, because the spread between a shared group departure and a private one
 * is genuinely this large and Sidequest has not looked up a single price.
 */
const OPERATED_EXPERIENCE_DAY: Record<Style, [number, number]> = { budget: [60, 150], midrange: [110, 280], premium: [220, 520], luxury: [420, 1100] };

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
  /**
   * §18 — whether the TRAVELLER is at the wheel of a car they are responsible
   * for. Undefined for a draft that states no arrangement, where the old
   * inference from the primary mode stands.
   */
  selfDrives?: boolean;
  /** V7 §14 — the draft's driving arrangement, so a hired driver is priced as a driver and never as a rental. */
  driving?: string;
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

  /*
   * V7 §14 — a night on a cruise is a bundle (cabin, meals, excursions), not a
   * hotel night: it comes off the lodging count and gets its own line.
   */
  const cruiseEpisodes = (input.pkg?.episodes ?? []).filter((e) => e.kind === 'cruise' || e.kind === 'expedition_boat');
  const cruiseNights = cruiseEpisodes.reduce((n, e) => n + Math.max(0, e.dayNumbers.length - 1), 0);
  /*
   * V11 §36 — every OTHER operator-run multi-day experience is a bundle too.
   *
   * The cruise case above had the reasoning right and the scope too narrow: a
   * trek with camp support, a yurt-and-horse expedition, a safari and a
   * hut-to-hut are all one product covering the guide, the bed and usually the
   * food. Their nights come off the hotel count for the same reason a cabin
   * does, and they get a line of their own instead of vanishing.
   */
  const operatedEpisodes = (input.pkg?.episodes ?? []).filter((e) => e.timing === 'operator' && e.dayNumbers.length >= 2 && e.kind !== 'cruise' && e.kind !== 'expedition_boat');
  const operatedNights = operatedEpisodes.reduce((n, e) => n + Math.max(0, e.dayNumbers.length - 1), 0);
  const operatedDays = operatedEpisodes.reduce((n, e) => n + e.dayNumbers.length, 0);
  const bundledNights = cruiseNights + operatedNights;
  const hotelNights = Math.max(0, nights - bundledNights);
  /* A cabin is "on board"; a trek camp is "priced with the experience". Both are bundles; only one of them is a ship. */
  const bundledNote =
    bundledNights === 0
      ? ''
      : operatedNights === 0
        ? ` (${cruiseNights} on board ${cruiseNights === 1 ? 'is' : 'are'} priced with the cruise)`
        : cruiseNights === 0
          ? ` (${operatedNights} ${operatedNights === 1 ? 'night is' : 'nights are'} priced with the experience ${operatedNights === 1 ? 'that includes it' : 'that includes them'})`
          : ` (${cruiseNights} on board and ${operatedNights} on the guided experiences are priced with those)`;
  push('lodging', LODGING_PER_NIGHT[style], hotelNights, false, `${hotelNights} nights at a ${style} band per room or unit${bundledNote}`, ['Room or unit per night'], ['City taxes, resort fees']);
  if (operatedDays > 0) {
    const mealsIncluded = operatedEpisodes.every((e) => e.meals === 'included');
    lines.push(
      budgetLineSchema.parse({
        category: 'guides_tours',
        currency,
        low: Math.round(OPERATED_EXPERIENCE_DAY[style][0] * operatedDays),
        high: Math.round(OPERATED_EXPERIENCE_DAY[style][1] * operatedDays),
        perPerson: true,
        basis: `${operatedEpisodes.map((e) => `${e.name} (${e.dayNumbers.length} day${e.dayNumbers.length === 1 ? '' : 's'})`).join(', ')}: run by an operator as one booking. Prices vary widely between a shared departure and a private one, and Sidequest has not looked one up.`,
        includes: ['Guiding', ...(operatedNights > 0 ? ['Nights on the experience'] : []), ...(mealsIncluded ? ['Meals on the experience'] : []), 'Pack animals or vehicles where the experience uses them'],
        excludes: ['Tips', 'Personal equipment hire', ...(mealsIncluded ? [] : ['Meals the operator does not provide'])],
        provenance: 'derived_from_plan',
        precision: 'unknown',
        bundle: true,
      }),
    );
  }
  if (cruiseNights > 0) {
    lines.push(budgetLineSchema.parse({ category: 'lodging', currency, low: Math.round(CRUISE_NIGHT[style][0] * cruiseNights), high: Math.round(CRUISE_NIGHT[style][1] * cruiseNights), perPerson: true, basis: `${cruiseEpisodes.map((e) => e.name).join(', ')}: ${cruiseNights} night${cruiseNights === 1 ? '' : 's'} on board, cabin, meals and included excursions as one booking; cruise prices vary widely by cabin and operator`, includes: ['Cabin', 'Meals on board', 'Included shore excursions'], excludes: ['Optional excursions, drinks, tips'], provenance: 'derived_from_plan', precision: 'unknown', bundle: true }));
  }
  push('food', FOOD_PER_DAY[style], days, true, `${days} days at a ${style} band`, ['Three meals, coffee, water'], ['Alcohol beyond a drink with dinner']);
  const paidStops = itinerary.days.reduce((n, day) => n + day.items.filter((i) => i.kind === 'activity' && PAID_CATEGORIES.has(categoryOf(input.pkg, i.placeId, i.id))).length, 0);
  push('activities', PAID_STOP[style], paidStops, true, `${paidStops} stops that usually charge entry`, ['Entry tickets'], ['Optional extras, audio guides']);
  push('permits', PERMIT, input.permitCount, true, `${input.permitCount} permit${input.permitCount === 1 ? '' : 's'} or passes on the plan`, [], [], 'derived_from_plan');
  push('guides_tours', GUIDE_DAY[style], input.guideDays, true, `${input.guideDays} guided day${input.guideDays === 1 ? '' : 's'}`, ['Guide or operator fee'], ['Tips']);

  const primary = itinerary.transportStrategy.primaryMode;
  const driveKm = itinerary.transportStrategy.totals.driveKm;
  /*
   * PRODUCT RECOVERY V1 — fuel follows the evidence. Measured km price fuel
   * exactly; km Sidequest only estimated from map distance price a wide band
   * and say so; when nothing was measured or estimated the line carries the
   * rental alone and says fuel is not included, rather than "fuel for 0 km".
   */
  const estimatedKm = itinerary.days.reduce((sum, day) => sum + day.items.reduce((s, item) => s + (item.kind === 'travel' && item.travel?.provenance === 'estimated' && item.travel.mode === 'drive' ? (item.travel.estimate?.approxKm ?? 0) : 0), 0), 0);
  /*
   * PRODUCTION LOCK V5 §18 — A RENTAL LINE NEEDS A RENTAL.
   *
   * `primary === 'drive'` means a car moves the traveller; it does not mean
   * they hired one. A live Kyrgyzstan build — private driver and 4x4 over the
   * jailoo tracks — billed the traveller for "11 rental days plus fuel" and
   * excluded "tolls, parking, one-way fees, full excess cover" on a car they
   * will never rent. `selfDrives` is the arrangement the draft states; where it
   * states none, the old inference stands.
   */
  if (input.selfDrives !== false && (primary === 'drive' || driveKm > 0)) {
    const fuelBasis = driveKm > 0 ? `fuel for about ${Math.round(driveKm)} km of measured driving` : estimatedKm > 0 ? `fuel for roughly ${Math.round(estimatedKm / 50) * 50} km, estimated from map distance` : 'fuel not included — no leg was measured or estimated';
    const fuelKm = driveKm > 0 ? driveKm : estimatedKm;
    const fuelBand: [number, number] = driveKm > 0 ? FUEL_PER_KM : [FUEL_PER_KM[0] * 0.8, FUEL_PER_KM[1] * 1.3];
    push('car_fuel_tolls_parking', [RENTAL_DAY[style][0] + (fuelBand[0] * fuelKm) / days, RENTAL_DAY[style][1] + (fuelBand[1] * fuelKm) / days], days, false, `${days} rental days plus ${fuelBasis}`, ['Rental, basic insurance', ...(fuelKm > 0 ? ['Fuel'] : [])], ['Tolls, parking, one-way fees, full excess cover', ...(fuelKm > 0 ? [] : ['Fuel'])], fuelKm > 0 && driveKm === 0 ? 'estimate_from_style_bands' : undefined);
  }
  if (primary === 'rail' || primary === 'public_bus' || primary === 'walk' || primary === 'rideshare' || (input.driving === 'private_driver' && primary !== 'drive')) {
    push('local_transport', LOCAL_TRANSIT_DAY, days, true, `${days} days of local transit and short rides`, ['Metro, bus, tram, short ride-hailing hops'], ['Taxis late at night'], 'derived_from_plan');
  }
  /* V7 §14 — a hired driver is priced by the day, for the days the plan actually uses one. */
  if (input.driving === 'private_driver') {
    const driverDays = new Set(input.legs.filter((l) => (l.mode === 'private_transfer' || l.mode === 'car' || l.mode === 'four_wheel_drive') && l.role !== 'terminal' && l.dayNumber).map((l) => l.dayNumber!)).size;
    if (driverDays > 0) push('guides_tours', DRIVER_DAY[style], driverDays, false, `${driverDays} day${driverDays === 1 ? '' : 's'} with a hired car and driver`, ['Car and driver for the day'], ['Tolls, the driver’s meals, tips'], 'derived_from_plan');
  }
  const countedLegs = input.legs.filter((l) => l.episode === undefined || l.role === 'base_move' || l.role === 'transfer');
  const flights = countedLegs.filter((l) => l.mode === 'flight').length;
  const ferries = countedLegs.filter((l) => l.mode === 'ferry' || l.mode === 'boat').length;
  const trains = countedLegs.filter((l) => l.mode === 'rail' && (l.role === 'base_move' || l.role === 'transfer' || (l.durationMinutes ?? 0) >= 90)).length;
  if (flights > 0 || ferries > 0 || trains > 0) {
    lines.push(budgetLineSchema.parse({ category: 'long_distance_transport', currency, low: flights * FLIGHT_LEG[0] + ferries * FERRY_LEG[0] + trains * RAIL_LEG[0], high: flights * FLIGHT_LEG[1] + ferries * FERRY_LEG[1] + trains * RAIL_LEG[1], perPerson: true, basis: `${flights} internal flight${flights === 1 ? '' : 's'}, ${trains} train leg${trains === 1 ? '' : 's'}, ${ferries} ferry or boat leg${ferries === 1 ? '' : 's'}`, includes: ['Standard fares'], excludes: ['Flights to and from the destination'], provenance: 'derived_from_plan' }));
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
    const complete = line.category === 'lodging' ? bookedLodgingNights >= nights : line.category === 'long_distance_transport' ? flights + ferries + trains > 0 && actual.items >= flights + ferries + trains : false;
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
    precisionNote: lines.some((l) => l.precision === 'unknown') ? 'Ranges, not quotes. Sidequest did not look up a single price for this trip; the bands come from your spending style and the shape of the plan, and the lines marked as unknown are placeholders for things whose price varies too much to band.' : 'Ranges, not quotes. Sidequest did not look up a single price for this trip; the bands come from your spending style and the shape of the plan.',
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
