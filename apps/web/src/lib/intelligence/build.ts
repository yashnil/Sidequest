import {
  type FxRate,
  accessStateFor,
  buildBudgetIntelligence,
  buildChecklist,
  buildFoodIntelligence,
  buildLodgingIntelligence,
  buildPackingIntelligence,
  buildPlanCritique,
  buildReadinessPacket,
  buildRegret,
  buildResilience,
  buildSafety,
  buildTerminalPlan,
  buildWeatherIntelligence,
  claim,
  deriveBookings,
  itineraryStructureFingerprint,
  legFromSegment,
  legModeFromHint,
  MODE_TRAITS,
  needsRecheckBeforeDeparture,
  TRAVEL_INTELLIGENCE_VERSION,
  travelIntelligenceSchema,
  type AccessStateEntry,
  type BookedPlanItem,
  type DraftTransportHint,
  type Itinerary,
  type ItineraryItem,
  type LegMode,
  type SourceClaim,
  type TransportLeg,
  type TransportOption,
  type TravelIntelligence,
  type TravelReadinessProfile,
  type TravelerProfile,
  type TripBasics,
  type TripComposerAnswers,
} from '@sidequest/core';
/** The only part of the draft the intelligence reads: anchor names and the model's transport hints. */
export interface DraftHints {
  days: readonly { anchors: readonly { name: string; transport?: string }[] }[];
}

/**
 * BUILD THE INTELLIGENCE, DETERMINISTICALLY.
 *
 * A pure function of persisted inputs. It makes no provider call and no
 * model call: every volatile fact it needs was gathered by the reconciler,
 * and everything it cannot establish it marks as such. That is why it can run
 * on every render of the trip hub, why an outage cannot break it, and why the
 * deadline never touches it.
 */
export interface BuildIntelligenceInput {
  tripId: string;
  itinerary: Itinerary;
  draft?: DraftHints | null;
  profile: TravelerProfile;
  basics: TripBasics;
  destination: { name: string; countryCode?: string; timeZone?: string };
  composer?: TripComposerAnswers | null;
  booked: readonly BookedPlanItem[];
  readinessProfile?: TravelReadinessProfile | null;
  sourcedAreas?: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[];
  worthSkipping?: readonly { name: string; reason: string }[];
  /** Places the traveller named themselves (Mode 3, or must-dos). */
  userPlaces?: readonly string[];
  bookedHonored?: readonly string[];
  bookedConflicts?: readonly string[];
  now: Date;
  providerTrafficAware?: boolean;
  /** LIVE WORLD V1 — a reference rate persisted at plan time; null when no FX provider is configured. */
  fx?: FxRate | null;
  displayCurrency?: string;
}

function normalise(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function daysUntil(startDate: string, now: Date): number {
  return Math.round((Date.parse(`${startDate}T00:00:00Z`) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
}

export function buildTravelIntelligence(input: BuildIntelligenceInput): TravelIntelligence {
  const { itinerary, profile, now } = input;
  const pkg = itinerary.package;
  const checkedAt = now.toISOString();
  const claims: SourceClaim[] = [];

  // Categories and transport hints, from the package and the draft ---------------------------
  const categoryByPlace = new Map<string, string>();
  const categoryByItem = new Map<string, string>();
  const categoryByName = new Map<string, string>();
  for (const anchor of pkg?.anchors ?? []) {
    if (anchor.placeId) categoryByPlace.set(anchor.placeId, anchor.category);
    categoryByItem.set(anchor.id, anchor.category);
    categoryByName.set(normalise(anchor.name), anchor.category);
  }
  const hintByName = new Map<string, DraftTransportHint>();
  for (const day of input.draft?.days ?? []) for (const anchor of day.anchors) if (anchor.transport) hintByName.set(normalise(anchor.name), anchor.transport as DraftTransportHint);
  const rawCategoryOf = (item: ItineraryItem): string => (item.placeId ? categoryByPlace.get(item.placeId) : undefined) ?? categoryByItem.get(item.id) ?? categoryByName.get(normalise(item.title)) ?? (item.kind === 'activity' ? 'other' : item.kind);
  // A "nature" anchor the model called a hike or a trail is a hike for packing, food and access purposes.
  const categoryOf = (item: ItineraryItem): string => {
    const raw = rawCategoryOf(item);
    return raw === 'nature' && /\b(hike|hiking|trail|trek|summit|ridge)\b/i.test(item.title) ? 'hike' : raw;
  };
  const categories = itinerary.days.flatMap((d) => d.items.filter((i) => i.kind === 'activity').map(categoryOf));

  // Legs -----------------------------------------------------------------------------------------
  const legs: TransportLeg[] = [];
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (!item.travel) continue;
      const hint = hintByName.get(normalise(item.travel.toName)) ?? hintByName.get(normalise(item.title.replace(/^(travel|drive|walk|ride|take the \w+) to /i, '')));
      const departAt = new Date(`${day.date}T00:00:00Z`);
      departAt.setUTCMinutes(item.startMinute);
      const isBaseMove = item.travel.role === 'transfer' || /relocat|check in|check-in/i.test(item.title);
      legs.push(
        legFromSegment({
          id: `leg:${day.dayNumber}:${item.id}`,
          dayNumber: day.dayNumber,
          segment: item.travel,
          ...(hint ? { hint } : {}),
          departMinute: item.startMinute,
          arriveMinute: item.endMinute,
          ...(isBaseMove ? { role: 'base_move' as const } : {}),
          departAt,
          now,
          providerTrafficAware: input.providerTrafficAware ?? false,
        }),
      );
    }
  }
  // Hints the model wrote that the reconciler could not express as a segment still name a mode.
  const hintedModes = new Set<LegMode>();
  for (const hint of hintByName.values()) {
    const mode = legModeFromHint(hint);
    if (mode) hintedModes.add(mode);
  }
  const legModes = new Set<LegMode>([...legs.map((l) => l.mode), ...hintedModes]);
  const drives = itinerary.transportStrategy.primaryMode === 'drive' || legs.some((l) => l.mode === 'car' || l.mode === 'four_wheel_drive');

  // Country and calendar ----------------------------------------------------------------------------
  const home = new Set([input.readinessProfile?.citizenship, input.readinessProfile?.residence].filter(Boolean) as string[]);
  const international: 'yes' | 'no' | 'unknown' = !input.destination.countryCode || home.size === 0 ? 'unknown' : home.has(input.destination.countryCode) ? 'no' : 'yes';
  const tripDays = itinerary.days.length;
  const daysUntilTrip = daysUntil(itinerary.startDate, now);

  // Lodging first (it needs only bookings), then food with the remote hints lodging and the legs provide -----------
  const lodging = buildLodgingIntelligence({ itinerary, pkg, profile, sourcedAreas: input.sourcedAreas ?? [], booked: input.booked });
  const remoteDayHints = new Set<number>();
  for (const leg of legs) if (leg.dayNumber && (leg.mode === 'boat' || leg.mode === 'guide_transfer' || leg.mode === 'lodge_transfer' || leg.mode === 'four_wheel_drive')) remoteDayHints.add(leg.dayNumber);
  for (const base of lodging.bases) if (base.style === 'lodge' || base.style === 'camp' || base.style === 'hut' || base.style === 'homestay') for (const d of base.dayNumbers) remoteDayHints.add(d);
  const food = buildFoodIntelligence({ itinerary, profile, categoryByPlace, categoryByItem, remoteDayHints });
  const remoteBaseIds = new Set(lodging.bases.filter((b) => b.dayNumbers.some((d) => food.remoteDayNumbers.includes(d))).map((b) => b.baseId));
  const remote = food.remoteDayNumbers.length > 0 || legModes.has('lodge_transfer') || legModes.has('guide_transfer') || legModes.has('four_wheel_drive');
  const strenuous = itinerary.days.some((d) => d.totals.strenuousCount > 0 || d.intensity === 'intense') || categories.includes('hike');
  const water = categories.some((c) => c === 'water' || c === 'beach') || legModes.has('boat') || legModes.has('ferry');

  // Terminal logistics ------------------------------------------------------------------------------------
  const terminal = buildTerminalPlan({
    international,
    arrivalTime: input.basics.arrivalTime,
    departureTime: input.basics.departureTime,
    ...(input.composer?.arrival?.precision ? { arrivalPrecision: input.composer.arrival.precision } : {}),
    ...(input.composer?.departure?.precision ? { departurePrecision: input.composer.departure.precision } : {}),
    drives,
    firstDay: itinerary.days[0]!,
    lastDay: itinerary.days[tripDays - 1]!,
    booked: input.booked,
    ...(input.destination.timeZone ? { timeZone: input.destination.timeZone } : {}),
  });
  legs.unshift({
    id: 'leg:arrival',
    dayNumber: 1,
    mode: drives ? 'car' : 'unknown_local',
    originId: 'terminal:arrival',
    originName: 'Arrival airport, station or port',
    destinationId: itinerary.days[0]!.baseId,
    destinationName: itinerary.days[0]!.baseName,
    durationMinutes: null,
    km: null,
    durationBasis: 'unmeasured',
    trafficState: 'unknown',
    plausibility: 'plausible',
    unmeasuredReason: 'provider_unavailable',
    bookingRequired: drives ? 'required' : 'unknown',
    role: 'terminal',
    notes: [terminal.arrival.transferLabel],
  });
  legs.push({
    id: 'leg:departure',
    dayNumber: tripDays,
    mode: drives ? 'car' : 'unknown_local',
    originId: itinerary.days[tripDays - 1]!.baseId,
    originName: itinerary.days[tripDays - 1]!.baseName,
    destinationId: 'terminal:departure',
    destinationName: 'Departure airport, station or port',
    durationMinutes: null,
    km: null,
    durationBasis: 'unmeasured',
    trafficState: 'unknown',
    plausibility: 'plausible',
    unmeasuredReason: 'provider_unavailable',
    bookingRequired: 'unknown',
    role: 'terminal',
    notes: [terminal.departure.transferLabel],
  });

  // Readiness ---------------------------------------------------------------------------------------------
  const readiness = buildReadinessPacket({
    ...(input.destination.countryCode ? { destinationCountry: input.destination.countryCode } : {}),
    destinationName: input.destination.name,
    tripStart: itinerary.startDate,
    tripEnd: itinerary.endDate,
    profile: input.readinessProfile ?? null,
    drives,
    remote,
    strenuous,
    water,
    now,
  });
  claims.push(...readiness.claims);

  // Bookings, budget --------------------------------------------------------------------------------------------
  const bookings = deriveBookings({ itinerary, pkg, profile, legs, booked: input.booked, daysUntilTrip, remoteBaseIds });
  const guideDays = new Set(bookings.filter((b) => b.kind === 'tour_guide').map((b) => b.dayNumber)).size;
  const permitCount = bookings.filter((b) => b.kind === 'permit' || b.kind === 'park_entry').length;
  const budget = buildBudgetIntelligence({ itinerary, pkg, profile, travellers: input.basics.adults + input.basics.children, legs, booked: input.booked, permitCount, guideDays, international, ...(input.fx ? { fx: input.fx } : {}), ...(input.displayCurrency ? { displayCurrency: input.displayCurrency } : {}) });

  // Weather, access, safety, packing ------------------------------------------------------------------------
  const weather = buildWeatherIntelligence({ itinerary, categoryOf, packageBackups: pkg?.backups ?? [] });
  const access: AccessStateEntry[] = itinerary.days.flatMap((day) => day.items.filter((i) => i.kind === 'activity').map((i) => accessStateFor(i, day, categoryOf(i))));
  const safety = buildSafety({ itinerary, readiness: readiness.packet, remote });
  const packing = buildPackingIntelligence({
    itinerary,
    profile,
    categories,
    international,
    drives,
    remote,
    lodgingKinds: lodging.bases.map((b) => b.style),
    legModes: [...legModes],
    weatherBasis: weather.packingBasis,
    children: input.basics.children > 0,
    strenuous,
    modelPacking: pkg?.packing ?? [],
  });

  // Claims from the plan's own evidence ------------------------------------------------------------------------
  for (const anchor of pkg?.anchors ?? []) {
    claims.push(
      claim({
        id: `claim:identity:${anchor.id}`,
        kind: 'place_identity',
        subject: anchor.placeId ?? anchor.id,
        claim: anchor.verification === 'verified' ? `${anchor.name} is a real place at a known position.` : anchor.verification === 'partially_verified' ? `${anchor.name} was found by name; its details were not all confirmed.` : `${anchor.name} was proposed by the model and could not be confirmed independently.`,
        authority: anchor.verification === 'unverified' ? 'model_proposal' : 'open_structured',
        sourceName: anchor.verification === 'unverified' ? 'Composing model' : 'Place data',
        state: anchor.verification === 'verified' ? 'confirmed' : 'unverified',
        checkedAt,
      }),
    );
  }
  for (const leg of legs) {
    if (leg.role === 'terminal') continue;
    claims.push(
      claim({
        id: `claim:${leg.id}`,
        kind: leg.durationBasis === 'scheduled_transit' ? 'transport_schedule' : 'routing_duration',
        subject: leg.id,
        claim: leg.durationMinutes === null ? `${leg.originName} → ${leg.destinationName} by ${leg.mode.replace(/_/g, ' ')}: not timed.` : `${leg.originName} → ${leg.destinationName}: about ${leg.durationMinutes} min by ${leg.mode.replace(/_/g, ' ')}.`,
        authority: leg.durationBasis === 'measured_static' ? 'open_structured' : leg.durationBasis === 'scheduled_transit' ? 'official_current' : 'model_proposal',
        sourceName: leg.durationBasis === 'measured_static' ? 'Road routing' : leg.durationBasis === 'scheduled_transit' ? 'Published timetable' : 'Estimate',
        state: leg.durationBasis === 'measured_static' || leg.durationBasis === 'scheduled_transit' ? 'confirmed' : 'unverified',
        checkedAt,
      }),
    );
  }
  for (const entry of access) {
    if (entry.state === 'open_access') continue;
    claims.push(
      claim({
        id: `claim:access:${entry.itemId}`,
        kind: entry.state === 'permit_required' ? 'permit' : entry.state === 'seasonal_unknown' ? 'seasonal_access' : 'opening_hours',
        subject: entry.placeId ?? entry.itemId,
        claim: `${entry.title}: ${entry.note}`,
        // A places provider's regular schedule is authoritative structured data, not an official current source.
        authority: entry.attribution ? 'authoritative_structured' : entry.state === 'confirmed_open' || entry.state === 'permit_required' || entry.state === 'reservation_required' ? 'official_current' : entry.state === 'hours_known' ? 'authoritative_structured' : 'model_proposal',
        sourceName: entry.attribution ? `${entry.sourceName ?? 'Places provider'} (${entry.attribution})` : (entry.sourceName ?? (entry.state === 'hours_unknown' || entry.state === 'access_unknown' ? 'No published source' : 'Place data')),
        ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
        state: entry.state === 'confirmed_open' || entry.state === 'hours_known' || entry.state === 'permit_required' || entry.state === 'reservation_required' ? 'confirmed' : entry.state === 'confirmed_closed' ? 'contradicted' : 'unverified',
        checkedAt: entry.checkedAt ?? checkedAt,
        ...(entry.attribution ? { freshness: 'date_bound' } : {}),
      }),
    );
  }
  for (const day of weather.days) {
    claims.push(
      claim({
        id: `claim:weather:${day.dayNumber}`,
        kind: day.kind === 'forecast' ? 'weather_forecast' : 'climate',
        subject: `day:${day.dayNumber}`,
        claim: `Day ${day.dayNumber}: ${day.summary}`,
        authority: day.kind === 'unavailable' ? 'model_proposal' : 'authoritative_structured',
        sourceName: day.kind === 'unavailable' ? 'No weather provider' : itinerary.days[0]!.weather.provider,
        state: day.kind === 'unavailable' ? 'unverified' : 'confirmed',
        checkedAt,
        notes: [day.horizonNote],
      }),
    );
  }
  for (const item of input.booked) {
    claims.push(claim({ id: `claim:booked:${item.id}`, kind: 'booked_fact', subject: item.id, claim: `${item.title}${item.date ? ` on ${item.date}` : ''}${item.startTime ? ` at ${item.startTime}` : ''} is ${item.status === 'booked' ? 'booked' : item.status === 'soft_hold' ? 'held' : 'an idea'}.`, authority: 'traveller_stated', sourceName: 'Entered by you', state: item.status === 'booked' ? 'confirmed' : 'unverified', checkedAt: item.createdAt }));
  }

  // Backups, regret, checklist ---------------------------------------------------------------------------------
  const backups = buildResilience({ itinerary, pkg, weather: weather.days, access, terminalViolations: terminal.violations });
  const regret = buildRegret({ pkg, itinerary, bookings, access, weather: weather.days, claims, worthSkipping: input.worthSkipping ?? [] });
  const recheck = claims.filter(needsRecheckBeforeDeparture);
  const checklist = buildChecklist({ readiness: readiness.packet, bookings, packing, recheck, daysUntilTrip });

  // Transport options for major legs -------------------------------------------------------------------------------
  const options = transportOptionsFor(legs, profile, legModes);
  const modeNote = describeModes(legModes, itinerary.transportStrategy.primaryMode);

  // Critique (Mode 3) --------------------------------------------------------------------------------------------------
  const critique = input.userPlaces && input.userPlaces.length > 0 ? buildPlanCritique({ itinerary, pkg, profile, userPlaces: input.userPlaces, legs, bookings, bookedConflicts: input.bookedConflicts ?? [] }) : undefined;

  const unresolvedCriticals = [
    ...readiness.packet.entries.filter((e) => e.blocking).map((e) => e.title),
    ...terminal.violations,
    ...(input.bookedConflicts ?? []),
    ...bookings.filter((b) => b.priority === 'book_first' && b.necessity === 'required' && b.status === 'open' && daysUntilTrip >= 0 && daysUntilTrip <= 14).map((b) => `Not yet booked, and the trip is close: ${b.title}`),
  ];

  return travelIntelligenceSchema.parse({
    version: TRAVEL_INTELLIGENCE_VERSION,
    tripId: input.tripId,
    builtAt: checkedAt,
    itineraryFingerprint: itineraryStructureFingerprint(itinerary),
    destinationContext: {
      name: input.destination.name,
      ...(input.destination.countryCode ? { countryCode: input.destination.countryCode } : {}),
      international,
      ...(input.destination.timeZone ? { timeZone: input.destination.timeZone } : {}),
      tripDays,
      daysUntilTrip,
      remote,
      drives,
    },
    verification: {
      anchors: pkg?.verification.anchors ?? 0,
      verified: pkg?.verification.verified ?? 0,
      partiallyVerified: pkg?.verification.partiallyVerified ?? 0,
      unverified: pkg?.verification.unverified ?? 0,
      legsMeasured: pkg?.verification.legsMeasured ?? legs.filter((l) => l.durationBasis === 'measured_static').length,
      legsUnmeasured: pkg?.verification.legsUnmeasured ?? legs.filter((l) => l.durationBasis === 'unmeasured' && l.role !== 'terminal').length,
      deadlineReached: pkg?.verification.deadlineReached ?? false,
    },
    transport: { primaryMode: itinerary.transportStrategy.primaryMode, legs, terminal, options, modeNote },
    lodging,
    food,
    bookings: { items: bookings, booked: [...input.booked], honored: [...(input.bookedHonored ?? [])], conflicts: [...(input.bookedConflicts ?? [])] },
    budget,
    weather,
    access,
    readiness: readiness.packet,
    safety,
    packing,
    backups,
    regret,
    checklist,
    ...(critique ? { critique } : {}),
    sourceRegistry: claims,
    unresolvedCriticals,
    freshness: {
      recheckBeforeDeparture: recheck.map((c) => c.id),
      note: `${recheck.length} of ${claims.length} facts behind this plan can change before you travel: forecasts, hours, seasonal access, timetables and entry rules. They were read on ${checkedAt.slice(0, 10)}.`,
    },
  });
}

function transportOptionsFor(legs: readonly TransportLeg[], profile: TravelerProfile, legModes: ReadonlySet<LegMode>): TransportOption[] {
  const major = legs.filter((l) => l.role === 'base_move' || (l.km ?? 0) >= 80 || l.mode === 'flight' || l.mode === 'ferry');
  const priority = profile.transport.priority as string;
  const options: TransportOption[] = [];
  for (const leg of major.slice(0, 6)) {
    const alternatives: LegMode[] = [];
    if (leg.mode === 'car' && profile.interview.internalFlights === 'fine' && (leg.km ?? 0) >= 300) alternatives.push('flight');
    if (leg.mode === 'car' && (legModes.has('rail') || legModes.has('bus'))) alternatives.push(legModes.has('rail') ? 'rail' : 'bus');
    if ((leg.mode === 'rail' || leg.mode === 'bus') && profile.transport.willDrive) alternatives.push('car');
    if (leg.mode === 'flight' && (leg.km === null || leg.km < 600) && profile.transport.willDrive) alternatives.push('car');
    if (leg.mode === 'car' && profile.interview.privateTransfers !== 'avoid') alternatives.push('private_transfer');
    const candidates: LegMode[] = [leg.mode, ...alternatives.filter((m) => m !== leg.mode)];
    const scored = candidates.map((mode) => {
      const traits = MODE_TRAITS[mode];
      return { mode, traits, score: preferenceScore(priority, traits, mode === leg.mode) };
    });
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    for (const entry of scored) {
      options.push({
        legId: leg.id,
        legLabel: `${leg.originName} → ${leg.destinationName}`,
        mode: entry.mode,
        durationMinutes: entry.mode === leg.mode ? leg.durationMinutes : null,
        durationBasis: entry.mode === leg.mode ? leg.durationBasis : 'unmeasured',
        costBand: entry.traits.costBand,
        transferBurden: entry.traits.transferBurden,
        scenic: entry.traits.scenic,
        hotelDisruption: leg.role === 'base_move' ? 'some' : 'none',
        ease: entry.traits.ease,
        recommended: entry.mode === best.mode,
        why: entry.mode === leg.mode ? (entry.mode === best.mode ? `Kept: it is the ${priorityWord(priority)} option on what is known, and it is the only one with a measured time.` : `The plan uses this; an alternative may suit "${priorityWord(priority)}" better, but its timing was not measured.`) : entry.mode === best.mode ? `Worth comparing: ${priorityWord(priority)} on general traits; not timed or priced for this leg.` : `An alternative that exists for this kind of leg; not timed or priced.`,
      });
    }
  }
  return options;
}

function priorityWord(priority: string): string {
  return priority === 'cheapest' ? 'cheapest' : priority === 'fastest' ? 'fastest' : priority === 'most_scenic' ? 'most scenic' : priority === 'least_stressful' || priority === 'least_stress' ? 'least stressful' : 'best value';
}

function preferenceScore(priority: string, traits: (typeof MODE_TRAITS)[LegMode], isCurrent: boolean): number {
  const band = (v: string) => (v === 'low' ? 0 : v === 'medium' ? 1 : v === 'high' ? 2 : 1);
  const ease = traits.ease === 'easy' ? 2 : traits.ease === 'moderate' ? 1 : traits.ease === 'demanding' ? 0 : 1;
  let score = isCurrent ? 1.5 : 0;
  if (priority === 'cheapest') score += 2 - band(traits.costBand);
  else if (priority === 'fastest') score += traits.transferBurden === 'low' ? 1 : 0;
  else if (priority === 'most_scenic') score += band(traits.scenic);
  else if (priority === 'least_stressful' || priority === 'least_stress') score += ease + (2 - band(traits.transferBurden));
  else score += (2 - band(traits.costBand)) * 0.5 + ease * 0.5;
  return score;
}

function describeModes(modes: ReadonlySet<LegMode>, primary: string): string {
  const words = [...modes].filter((m) => m !== 'unknown_local').map((m) => m.replace(/_/g, ' '));
  if (words.length === 0) return `Getting around by ${primary.replace(/_/g, ' ')}.`;
  return `This plan moves by ${words.join(', ')}. Modes the road router cannot time (flights, boats, guide transfers) are kept as plausible legs with no measured duration, never marked impossible.`;
}
