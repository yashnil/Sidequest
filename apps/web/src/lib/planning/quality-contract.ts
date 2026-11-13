import {
  buildTripQualityContract,
  evaluateTripQualityContract,
  SCAN_KINDS,
  type DiscoveryCandidate,
  type Itinerary,
  type ScanKind,
  type TravelerProfile,
  type TripComposerAnswers,
  type TripQualityContract,
  type TripQualityEvaluation,
} from '@sidequest/core';

/**
 * The trip-quality contract for one build (`quality/trip-quality-contract.ts`):
 * built before the planner from what the traveller said and what the board
 * holds, used to mark which candidates the plan must be built around, and
 * checked against the finished itinerary. Pure; no provider, no model.
 */

const KIND_SET = new Set<string>(SCAN_KINDS);
const kindOf = (tags: readonly string[]): ScanKind | null => {
  const raw = tags.find((t) => t.startsWith('kind:'))?.slice(5);
  return raw && KIND_SET.has(raw) ? (raw as ScanKind) : null;
};

export interface QualityContractContext {
  destinationPhrase: string;
  composer: TripComposerAnswers | null;
  profile: TravelerProfile;
  semanticType?: string | null;
  routeKind?: string | null;
  namedParts: readonly string[];
  tripDays: number;
  carAvailable: boolean;
  maxDailyTravelMinutes: number | null;
  mustDos: readonly string[];
  avoidances: readonly string[];
  board: readonly DiscoveryCandidate[];
  /** The destination's pillars for this trip, from the scan (structured defining experiences). */
  pillars?: readonly { name: string; tier: 'essential' | 'recommended' | 'optional'; why: string; placeIds: readonly string[] }[];
}

export function qualityContractFor(context: QualityContractContext): TripQualityContract {
  const { composer, profile } = context;
  const restfulWeight = (composer?.discovery?.concept ?? []).filter((c) => c.key === 'restoration' || c.key === 'wellness' || c.key === 'family_bonding').reduce((sum, c) => sum + c.weight, 0);
  const ownWords = [context.destinationPhrase, composer?.discovery?.request, composer?.mustDo, ...(composer?.themes ?? [])].filter(Boolean).join(' · ');
  const mustDoNames = new Set(context.mustDos.map((m) => m.trim().toLowerCase()));
  return buildTripQualityContract({
    ownWords,
    semanticType: context.semanticType ?? null,
    routeKind: context.routeKind ?? null,
    tripDays: context.tripDays,
    pace: profile.pace,
    intensity: profile.dailyIntensity,
    restfulWeight,
    carAvailable: context.carAvailable,
    statedMode: composer?.transport === 'public_transport' ? 'public_transport' : composer?.transport === 'drive' ? 'drive' : null,
    maxDailyTravelMinutes: context.maxDailyTravelMinutes,
    preferredStartMinute: null,
    namedParts: context.namedParts,
    ...(context.pillars ? { pillars: context.pillars } : {}),
    mustDos: context.mustDos,
    avoidances: context.avoidances,
    candidates: context.board.map((c) => ({
      id: c.place.id,
      name: c.place.name,
      kind: kindOf(c.place.tags),
      defining: c.place.tags.includes('defining'),
      blocked: c.fit.blockers.length > 0,
      mustDo: mustDoNames.has(c.place.name.trim().toLowerCase()),
    })),
  });
}

/**
 * The board candidates the plan must be built around: every usable one the
 * proposal marked defining, and — for each essential the contract states by
 * kind — the best-fitting usable candidates of that kind, as many as it needs.
 */
export function essentialIdsFor(contract: TripQualityContract, board: readonly DiscoveryCandidate[]): Set<string> {
  const ids = new Set<string>();
  const usable = board.filter((c) => c.fit.blockers.length === 0);
  for (const essential of contract.essentials) {
    if (essential.requirement !== 'requirement') continue;
    if (essential.placeIds) {
      /* A pillar's candidates substitute for one another: the plan is built around the best-fitting one. */
      const usableHere = usable.filter((c) => essential.placeIds!.includes(c.place.id)).sort((a, b) => (b.fit.score ?? 0) - (a.fit.score ?? 0));
      for (const c of essential.id.startsWith('pillar:') ? usableHere.slice(0, 1) : usableHere) ids.add(c.place.id);
      continue;
    }
    const kinds = new Set<string>(essential.kinds ?? []);
    const terms = (essential.nameTerms ?? []).map((t) => new RegExp(`\\b${t}\\b`, 'i'));
    const matching = usable
      .filter((c) => (kinds.size > 0 && kinds.has(kindOf(c.place.tags) ?? '')) || terms.some((t) => t.test(c.place.name)))
      .sort((a, b) => (b.fit.score ?? 0) - (a.fit.score ?? 0));
    for (const c of matching.slice(0, essential.minCount)) ids.add(c.place.id);
  }
  return ids;
}

/** Whether the plan asks for a self-drive hire car anywhere a traveller would act on it. */
export function asksForHireCar(itinerary: Pick<Itinerary, 'transportStrategy'>): boolean {
  const strategy = itinerary.transportStrategy;
  const text = [strategy.headline, ...strategy.rationale, ...(strategy.tradeoffs ?? [])].join(' ');
  return /\b(?:rental|hire)[ -]car\b|\bcar hire\b|\brent(?:ing)? a car\b/i.test(text);
}

export function evaluateQualityContract(contract: TripQualityContract, itinerary: Pick<Itinerary, 'days' | 'transportStrategy'>, board: readonly DiscoveryCandidate[], pickedIds: ReadonlySet<string>, extraSelfDrive = false): TripQualityEvaluation {
  const tagsById = new Map(board.map((c) => [c.place.id, c.place.tags] as const));
  return evaluateTripQualityContract(contract, {
    days: itinerary.days.map((day) => {
      const activities = day.items.filter((item) => item.kind === 'activity');
      const stops = activities.map((item) => {
        const placeId = 'placeId' in item ? (item.placeId as string | undefined) : undefined;
        return {
          ...(placeId ? { placeId } : {}),
          name: item.title,
          kind: placeId ? kindOf(tagsById.get(placeId) ?? []) : null,
          startMinute: item.startMinute,
          pickedByTraveller: placeId ? pickedIds.has(placeId) : false,
        };
      });
      const travelMinutes = day.items.filter((item) => item.kind === 'travel').reduce((sum, item) => sum + (item.durationMinutes ?? 0), 0);
      return { dayNumber: day.dayNumber, firstStartMinute: stops[0]?.startMinute ?? null, stops, travelMinutes };
    }),
    board: board.map((c) => ({ id: c.place.id, name: c.place.name, kind: kindOf(c.place.tags) })),
    selfDriveRequested: extraSelfDrive || asksForHireCar(itinerary),
  });
}
