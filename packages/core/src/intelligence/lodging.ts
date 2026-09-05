import { z } from 'zod';
import type { Itinerary, TripPackage } from '../schemas/itinerary';
import type { TravelerProfile } from '../schemas/profile';
import type { BookedPlanItem } from './booking';

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
    if (primaryMode === 'drive') advantages.push('Parking at the door is worth more than a central address on this plan.');
    if (primaryMode === 'rail' || primaryMode === 'public_bus') advantages.push('Stay within a few minutes of the station or main stop; every day starts and ends there.');
    if (primaryMode === 'walk') advantages.push('Stay inside the walking radius of the days here — a bed on the edge costs an hour a day.');
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
      style: kind,
      styleLabel: pkgBase?.style ?? LODGING_KIND_LABELS[kind],
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
  const moves = Math.max(0, bases.length - 1);
  const tolerance = profile.interview.baseMoveTolerance;
  const hotelChangeNote =
    moves === 0
      ? 'One base for the whole trip: unpack once.'
      : tolerance === 'stay_put'
        ? `${moves} ${moves === 1 ? 'hotel change' : 'hotel changes'} on a plan for someone who asked to stay put — the route needed it; each move is on a day marked as a transfer.`
        : `${moves} ${moves === 1 ? 'hotel change' : 'hotel changes'}, within what you said you would accept.`;
  return lodgingIntelligenceSchema.parse({
    bases,
    shortlist: properties.map((p) => ({ baseId: p.baseId, name: p.name, why: p.why, priceTier: p.priceTier, source: p.source })),
    shortlistBasis: properties.length > 0 ? 'Ranked by fit to this plan, not by review score. Availability and price are not live.' : 'No accommodation provider is configured, so Sidequest recommends areas rather than properties. Availability and prices are unknown until you look.',
    hotelChangeNote,
  });
}
