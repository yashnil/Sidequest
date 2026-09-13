import { z } from 'zod';
import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';
import type { BookedPlanItem } from './booking';
import { normalizeStays } from '../experience/chapters';

/**
 * WHERE TO SLEEP, IN TWO DECISIONS.
 *
 * The base decision — which town, which side of it, for how many nights, and
 * why — is Sidequest's to make from the itinerary's own geography. The property
 * decision is only ever a small shortlist, and only when structured
 * accommodation evidence exists. Without a booking provider nothing here claims
 * availability or a live price, ever.
 */
export const PRICE_TIERS = ['budget', 'mid-range', 'premium', 'luxury'] as const;
export const priceTierSchema = z.enum(PRICE_TIERS);

export const LODGING_KINDS = ['hotel', 'hostel', 'apartment', 'resort', 'lodge', 'camp', 'guesthouse', 'homestay', 'hut', 'no_preference'] as const;
export const lodgingKindSchema = z.enum(LODGING_KINDS);
export type LodgingKind = z.infer<typeof lodgingKindSchema>;

export const lodgingBaseSchema = z.object({
  baseId: z.string().min(1),
  name: z.string().min(1),
  area: z.string().min(1),
  why: z.string().min(1),
  nights: z.number().int().min(0),
  dayNumbers: z.array(z.number().int().min(1)),
  style: lodgingKindSchema,
  styleLabel: z.string().min(1),
  priceTier: priceTierSchema,
  tradeoffs: z.array(z.string().min(1)).default([]),
  advantages: z.array(z.string().min(1)).default([]),
  alternatives: z.array(z.object({ name: z.string().min(1), why: z.string().min(1) })).default([]),
  /** Where the area recommendation came from. */
  basis: z.enum(['draft', 'sourced_area', 'booked']),
  verification: z.enum(['verified', 'partially_verified', 'unverified']),
  booked: z.object({ id: z.string().min(1), title: z.string().min(1) }).optional(),
  /** Never `available` without a provider. */
  availability: z.literal('unknown'),
});
export type LodgingBase = z.infer<typeof lodgingBaseSchema>;

export const lodgingIntelligenceSchema = z.object({
  bases: z.array(lodgingBaseSchema),
  shortlist: z.array(z.object({ baseId: z.string().min(1), name: z.string().min(1), why: z.string().min(1), priceTier: priceTierSchema, source: z.string().min(1) })).default([]),
  shortlistBasis: z.string().min(1),
  hotelChangeNote: z.string().min(1),
  /** PRODUCT RECOVERY V1 — the hotel-churn facts behind the note; never a universal score. */
  churn: z.object({ level: z.enum(['settled', 'moderate', 'aggressive']), hotelChanges: z.number().int().min(0), nights: z.number().int().min(0), baseCount: z.number().int().min(0), oneNightStays: z.array(z.string().min(1)), averageNightsPerBase: z.number().min(0), simplerRoute: z.array(z.string().min(1)) }).optional(),
});
export type LodgingIntelligence = z.infer<typeof lodgingIntelligenceSchema>;

export const LODGING_KIND_LABELS: Record<LodgingKind, string> = {
  hotel: 'Hotel',
  hostel: 'Hostel',
  apartment: 'Apartment',
  resort: 'Resort',
  lodge: 'Lodge',
  camp: 'Camp',
  guesthouse: 'Guesthouse',
  homestay: 'Homestay',
  hut: 'Hut',
  no_preference: 'Whatever fits',
};

function kindFromProfile(profile: TravelerProfile): LodgingKind {
  const style = profile.interview.lodgingStyle as string;
  switch (style) {
    case 'hostel':
      return 'hostel';
    case 'basic_hotel':
    case 'boutique_hotel':
    case 'luxury_hotel':
      return 'hotel';
    case 'apartment':
    case 'airbnb':
      return 'apartment';
    case 'resort':
      return 'resort';
    case 'nature_lodge':
    case 'lodge':
      return 'lodge';
    case 'unique_stay':
      return 'guesthouse';
    default:
      return 'no_preference';
  }
}

function kindFromDraftStyle(style: string | undefined): LodgingKind | null {
  if (!style) return null;
  const s = style.toLowerCase();
  if (/hostel/.test(s)) return 'hostel';
  if (/apartment|flat|airbnb/.test(s)) return 'apartment';
  if (/resort/.test(s)) return 'resort';
  if (/lodge/.test(s)) return 'lodge';
  if (/camp|tent/.test(s)) return 'camp';
  if (/guesthouse|guest house|b&b|bed and breakfast|inn/.test(s)) return 'guesthouse';
  if (/homestay|ryokan|family/.test(s)) return 'homestay';
  if (/hut|refuge|cabin/.test(s)) return 'hut';
  if (/hotel/.test(s)) return 'hotel';
  return null;
}

/**
 * WHICH DAYS BELONG TO WHICH BASE.
 *
 * The package's base ids are the draft's; the days carry the resolved place
 * id. Names match, and bases run in order, so the spans are read by walking
 * the days once: each base takes the consecutive days that carry its name
 * from where the previous base stopped. The last base takes whatever is left.
 */
export function baseDaySpans(itinerary: Itinerary, pkg: TripPackage | undefined): { baseId: string; name: string; dayNumbers: number[] }[] {
  const bases = pkg ? pkg.bases.map((b) => ({ id: b.id, name: b.name })) : [...new Set(itinerary.days.map((d) => d.baseId))].map((id) => ({ id, name: itinerary.days.find((d) => d.baseId === id)!.baseName }));
  const spans: { baseId: string; name: string; dayNumbers: number[] }[] = [];
  let cursor = 0;
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  bases.forEach((base, index) => {
    const dayNumbers: number[] = [];
    const last = index === bases.length - 1;
    while (cursor < itinerary.days.length) {
      const day = itinerary.days[cursor]!;
      const matches = same(day.baseName, base.name) || day.baseId === base.id;
      const nextBase = bases[index + 1];
      const nextMatches = nextBase ? same(day.baseName, nextBase.name) || day.baseId === nextBase.id : false;
      if (matches || last || (!nextMatches && dayNumbers.length === 0)) {
        dayNumbers.push(day.dayNumber);
        cursor += 1;
        if (!last && nextBase && cursor < itinerary.days.length) {
          const upcoming = itinerary.days[cursor]!;
          if ((same(upcoming.baseName, nextBase.name) || upcoming.baseId === nextBase.id) && !same(nextBase.name, base.name)) break;
          if (same(upcoming.baseName, nextBase.name) && same(nextBase.name, base.name) && dayNumbers.length >= Math.max(1, (pkg?.bases[index]?.nights ?? 1))) break;
        }
      } else break;
    }
    spans.push({ baseId: base.id, name: base.name, dayNumbers });
  });
  return spans;
}

export function priceTierFor(profile: TravelerProfile): (typeof PRICE_TIERS)[number] {
  switch (profile.budgetStyle) {
    case 'budget':
      return 'budget';
    case 'midrange':
      return 'mid-range';
    case 'premium':
      return 'premium';
    case 'luxury':
      return 'luxury';
  }
}

export interface LodgingInput {
  itinerary: Itinerary;
  pkg: TripPackage | undefined;
  profile: TravelerProfile;
  /** Sourced lodging areas from the compiled region, when it has any. */
  sourcedAreas: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[];
  booked: readonly BookedPlanItem[];
  /** Property candidates from an accommodation provider. None is configured; kept as the seam. */
  properties?: readonly { baseId: string; name: string; why: string; priceTier: (typeof PRICE_TIERS)[number]; source: string }[];
  /** V7 §14 — whether the traveller drives a car they park; a hired driver or transit produces no parking advice. */
  selfDrives?: boolean;
}

export function buildLodgingIntelligence(input: LodgingInput): LodgingIntelligence {
  const { itinerary, pkg, profile } = input;
  const tier = priceTierFor(profile);
  const profileKind = kindFromProfile(profile);
  const primaryMode = itinerary.transportStrategy.primaryMode;
  const spans = baseDaySpans(itinerary, pkg);
  const baseIds = spans.map((s) => s.baseId);
  const bases = spans.map((span, index) => {
    const baseId = span.baseId;
    const pkgBase = pkg?.bases.find((b) => b.id === baseId);
    const days = itinerary.days.filter((d) => span.dayNumbers.includes(d.dayNumber));
    const name = pkgBase?.name ?? days[0]?.baseName ?? baseId;
    const bookedHere = input.booked.find((b) => b.type === 'lodging' && b.status === 'booked' && (b.baseId === baseId || (b.date && days.some((d) => d.date === b.date)) || days.some((d) => d.baseName.toLowerCase() === (b.location ?? '').toLowerCase())));
    const sourced = input.sourcedAreas.find((a) => a.name.toLowerCase() === name.toLowerCase());
    const kind = kindFromDraftStyle(pkgBase?.style) ?? profileKind;
    const tradeoffs: string[] = [];
    const advantages: string[] = [];
    const earliest = Math.min(...days.map((d) => d.window.startMinute));
    const latest = Math.max(...days.map((d) => d.window.endMinute));
    if (Number.isFinite(earliest) && earliest <= 7 * 60) tradeoffs.push('Early starts from this base — breakfast before the usual hour matters.');
    if (Number.isFinite(latest) && latest >= 21 * 60) tradeoffs.push('Late returns some evenings — somewhere that is easy to get back to after dark.');
    const relocations = days.filter((d) => d.totals.driveMinutes > 150 || d.totals.transitMinutes > 150).length;
    if (relocations > 0) tradeoffs.push(`${relocations} ${relocations === 1 ? 'day' : 'days'} here carries a long transfer.`);
    const vessel = pkgBase?.baseKind === 'vessel';
    if (vessel) advantages.push('The cabin is booked with the cruise; there is nothing to arrange here beyond the boat itself.');
    else if (primaryMode === 'drive' && (input.selfDrives ?? true)) advantages.push('Parking at the door is worth more than a central address on this plan.');
    if (!vessel && (primaryMode === 'rail' || primaryMode === 'public_bus')) advantages.push('Stay within a few minutes of the station or main stop; every day starts and ends there.');
    if (!vessel && primaryMode === 'walk') advantages.push('Stay inside the walking radius of the days here — a bed on the edge costs an hour a day.');
    if (sourced) advantages.push(sourced.rationale);
    if (sourced) tradeoffs.push(...sourced.tradeoffs);
    if (pkgBase?.verification === 'unverified') tradeoffs.push('Sidequest could not confirm this place on the map; the area advice still stands.');
    const alternatives = input.sourcedAreas
      .filter((a) => a.name.toLowerCase() !== name.toLowerCase())
      .slice(0, 2)
      .map((a) => ({ name: a.name, why: a.rationale }));
    return lodgingBaseSchema.parse({
      baseId,
      name,
      area: pkgBase?.area ?? sourced?.name ?? name,
      why: pkgBase?.why ?? `Base ${index + 1} of the plan.`,
      nights: pkgBase?.nights ?? Math.max(0, days.length - (index === baseIds.length - 1 ? 1 : 0)),
      dayNumbers: days.map((d) => d.dayNumber),
      style: vessel ? 'no_preference' : kind,
      styleLabel: vessel ? 'On board' : (pkgBase?.style ?? LODGING_KIND_LABELS[kind]),
      priceTier: tier,
      tradeoffs,
      advantages,
      alternatives,
      basis: bookedHere ? 'booked' : sourced ? 'sourced_area' : 'draft',
      verification: pkgBase?.verification ?? 'unverified',
      ...(bookedHere ? { booked: { id: bookedHere.id, title: bookedHere.title } } : {}),
      availability: 'unknown',
    });
  });
  const properties = input.properties ?? [];
  const tolerance = profile.interview.baseMoveTolerance;
  /*
   * V11 §5 — CHURN IS COUNTED ON THE STAY SEQUENCE, NOT THE BASE LIST.
   *
   * The founder's Kyrgyzstan trip counted **six** hotel changes in ten nights.
   * Two of them were nights inside an operated trek — the operator moved the
   * traveller and there was no second bed to find — and one was Karakol
   * following Karakol, which is not a move at all. The honest figure is three,
   * and the difference is not cosmetic: "fast-moving route" triggered an
   * alternative that read *"Karakol could be a day trip from Ala-Kul trek
   * (camp)"*, which is a day trip to a town from a tent over a 3,900 m pass.
   */
  const structure = normalizeStays({
    bases: (pkg?.bases ?? []).map((base) => ({
      id: base.id,
      name: base.name,
      nights: base.nights,
      ...(base.displayName ? { displayName: base.displayName } : {}),
      ...(base.canonicalName ? { canonicalName: base.canonicalName } : {}),
      ...(base.locality ? { locality: base.locality } : {}),
      ...(base.baseKind ? { baseKind: base.baseKind } : {}),
      ...(base.coordinates ? { coordinates: base.coordinates } : {}),
      ...(base.episode ? { episode: base.episode } : {}),
    })),
    episodes: (pkg?.episodes ?? []).map((episode) => ({ name: episode.name, kind: episode.kind, dayNumbers: episode.dayNumbers, baseIds: episode.baseIds, timing: episode.timing })),
  });
  /* A trip with no package bases still has to be counted; fall back to the spans this function already built. */
  const stays = structure.stays.length > 0 ? structure.stays : bases.map((base) => ({ id: base.baseId, baseIds: [base.baseId], name: base.name, nights: base.nights, countsAsHotelChange: false }));
  const moves = structure.stays.length > 0 ? structure.hotelChanges : Math.max(0, bases.length - 1);
  /* Somewhere the traveller has to find a bed themselves — never a night an operator owns. */
  const ownStays = stays.filter((stay) => !('withinExperience' in stay && stay.withinExperience));
  /*
   * PRODUCT RECOVERY V1 — hotel churn is named, not excused. Six changes in
   * nine nights is a fast-moving route whatever the traveller ticked; the note
   * says so and the numbers travel with it. No fake score, and no invented
   * "simpler route": a simpler alternative is offered only where the plan
   * itself holds one (a one-night base between two longer stays that could
   * be folded — named, never fabricated).
   */
  const totalNights = stays.reduce((n, b) => n + b.nights, 0);
  /* A one-night stay only counts as churn when it is a bed the traveller chose. */
  const oneNightStays = ownStays.filter((b) => b.nights === 1).map((b) => b.name);
  const averageNightsPerBase = ownStays.length > 0 ? Math.round((totalNights / ownStays.length) * 10) / 10 : totalNights;
  const churn: 'settled' | 'moderate' | 'aggressive' = moves === 0 ? 'settled' : totalNights > 0 && moves / totalNights >= 0.5 || (oneNightStays.length >= 3 && moves >= 4) ? 'aggressive' : 'moderate';
  /*
   * A simpler alternative may only be built out of stays the traveller controls.
   * Folding a one-night town stop into a *trek camp* is not a simplification,
   * it is a sentence that cannot be acted on.
   */
  const simplerRoute =
    churn === 'aggressive'
      ? ownStays
          .map((stay, i) => {
            if (stay.nights !== 1 || i === 0 || i === ownStays.length - 1) return null;
            const before = ownStays[i - 1]!;
            const after = ownStays[i + 1]!;
            const host = before.nights >= 2 ? before : after.nights >= 2 ? after : null;
            return host ? `${stay.name} could be a day trip from ${host.name} instead of a one-night stop` : null;
          })
          .filter((line): line is string => line !== null)
      : [];
  const hotelChangeNote =
    moves === 0
      ? 'One base for the whole trip: unpack once.'
      : churn === 'aggressive'
        ? `This is a fast-moving route: ${moves} hotel changes in ${totalNights} nights, ${oneNightStays.length} of them one-night stays (${oneNightStays.join(', ')}).${tolerance === 'stay_put' ? ' You asked to stay put; the route needed the moves and each is on a transfer day.' : tolerance === 'move_freely' ? ' You said you would move as often as the route wants.' : ''}${simplerRoute.length > 0 ? ` Simpler: ${simplerRoute[0]}.` : ''}`
        : tolerance === 'stay_put'
          ? `${moves} ${moves === 1 ? 'hotel change' : 'hotel changes'} on a plan for someone who asked to stay put — the route needed it; each move is on a day marked as a transfer.`
          : `${moves} ${moves === 1 ? 'hotel change' : 'hotel changes'} over ${totalNights} nights, about ${averageNightsPerBase} nights per base.`;
  return lodgingIntelligenceSchema.parse({
    bases,
    shortlist: properties.map((p) => ({ baseId: p.baseId, name: p.name, why: p.why, priceTier: p.priceTier, source: p.source })),
    shortlistBasis: properties.length > 0 ? 'Ranked by fit to this plan, not by review score. Availability and price are not live.' : 'Sidequest recommends the area to stay in rather than a named hotel. Prices and availability are yours to check.',
    hotelChangeNote,
    churn: { level: churn, hotelChanges: moves, nights: totalNights, baseCount: ownStays.length, oneNightStays, averageNightsPerBase, simplerRoute },
  });
}
