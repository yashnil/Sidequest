import { estimateLegMinutes, haversineKm, type DiscoveryCandidate, type Interest, type TravelerProfile, type Trip, type WeatherDataset } from '@sidequest/core';
import { buildDailyWindows, resolveConfig } from '@sidequest/planner';
import type { DiscoverySelection } from '@sidequest/core';
import type { RegionContext } from '../region';
import type { ScanProposalExtras } from '../db/scan-repository';
import { archetypeFor, planStructure, transportFor, type PlannerBase, type PlannerCandidate, type PlannerDayWeather, type PlannerFoodArea, type PlannerStatus, type StructurePlan, type StructurePlannerInput } from './structure-planner';
import { DRAFT_SOFT_PROSE_CAPS, tripDraftSchema, type AnchorCategory, type DraftAnchor, type DraftDay, type TripDraft } from './trip-draft';

/**
 * V1 CONVERGENCE — THE PLANNER'S DECISIONS, WRITTEN AS THE TRIP DRAFT.
 *
 * `planStructure` decides; this file turns its decisions into the `TripDraft`
 * every downstream layer already reads (contract enforcement, reconciliation,
 * place identity, legs, audits, intelligence, the hub). The structure — which
 * places, which day, what order, which base, where lunch falls, the weather
 * swap — is the planner's. The prose is either deterministic (themes, meals,
 * reasons) or the scan's own per-candidate "why" and practical package, both
 * written before the board and labelled as Sidequest's research, never as a
 * fact somebody checked.
 */

export interface PlannerComposition {
  draft: TripDraft;
  plan: StructurePlan;
  /** How each scheduled stop entered the plan: the traveller's include, Sidequest's pick, a maybe, or a filler. */
  provenance: Record<string, PlannerStatus>;
  poolSize: number;
  /** What the planner was asked, kept so a traveller's own plan can be checked against the same pool, clock and minutes. */
  plannerInput: StructurePlannerInput;
}

const CATEGORY_FOR_PLACE: Record<string, AnchorCategory> = {
  viewpoint: 'viewpoint',
  day_hike: 'hike',
  easy_walk: 'nature',
  lake: 'water',
  scenic_drive: 'scenic_drive',
  geothermal: 'geothermal',
  hot_spring: 'relaxation',
  historic_site: 'historic',
  museum: 'museum',
  town_and_food: 'neighbourhood',
  gondola_or_tram: 'viewpoint',
  national_monument: 'nature',
  wildlife_area: 'wildlife',
};

function clip(text: string, max: number): string {
  const clean = text.replace(/[<>]/g, '').replace(/(?::\/\/|javascript:|data:|vbscript:|file:|mailto:|www\.)/gi, '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function statusOf(selection: DiscoverySelection | undefined): PlannerStatus | 'excluded' {
  if (!selection) return 'candidate';
  if (selection.status === 'excluded' || selection.status === 'dismissed') return 'excluded';
  if (selection.status === 'maybe') return selection.source === 'user' ? 'maybe' : 'candidate';
  if (selection.status === 'included') return selection.source === 'user' ? 'must' : 'recommended';
  return 'candidate';
}

function tagValue(tags: readonly string[], key: string): string | undefined {
  return tags.find((t) => t.startsWith(`${key}:`))?.slice(key.length + 1);
}

/** What a forecast day does to planning. Climate normals never move a stop: they describe a month, not a day. */
export function plannerWeatherFor(dataset: WeatherDataset | null, locationIdForDate: (date: string) => string | null, dates: readonly string[]): PlannerDayWeather[] {
  if (!dataset) return [];
  const out: PlannerDayWeather[] = [];
  for (const date of dates) {
    const locationId = locationIdForDate(date);
    const day = dataset.days.find((d) => d.date === date && d.kind === 'forecast' && (!locationId || d.locationId === locationId)) ?? dataset.days.find((d) => d.date === date && d.kind === 'forecast');
    if (!day || day.kind !== 'forecast') continue;
    const prob = day.precipitationProbabilityPercent ?? 0;
    const severe = day.condition === 'thunderstorm' || day.condition === 'snow' || day.windGustMaxKph >= 75;
    const wet = (day.condition === 'rain' && (prob >= 60 || day.precipitationMm >= 5)) || day.precipitationMm >= 8 || severe;
    const damp = !wet && (day.condition === 'drizzle' || (day.condition === 'rain' && prob >= 40));
    const windy = day.windGustMaxKph >= 55;
    const poorVisibility = day.condition === 'fog' || (day.cloudCoverMeanPercent ?? 0) >= 90;
    const severity = (severe ? 3 : wet ? 2 : damp || windy ? 1 : 0) as 0 | 1 | 2 | 3;
    out.push({ date, severity, wet: wet || damp, windy, poorVisibility, label: severe ? `${day.condition === 'snow' ? 'snow' : day.condition === 'thunderstorm' ? 'thunderstorms' : 'very strong wind'} forecast` : wet ? 'rain forecast' : damp ? 'showers possible' : windy ? 'strong wind forecast' : poorVisibility ? 'low cloud forecast' : 'fair' });
  }
  return out;
}

export interface PlannerComposeInput {
  trip: Trip;
  profile: TravelerProfile;
  region: RegionContext;
  candidates: readonly DiscoveryCandidate[];
  selections: readonly DiscoverySelection[];
  extras: ScanProposalExtras | null;
  destinationName: string;
  carAvailable: boolean;
  maxDailyTravelMinutes: number;
  /** The traveller's daily driving ceiling; on a car trip the day is held to the lower of this and the travel limit, the same ceiling verification enforces. */
  maxDailyDriveMinutes?: number;
  /** Stops the traveller locked to a day on the itinerary; they plan as the traveller's own includes, held to that day. */
  locks?: readonly { placeId: string; dayNumber: number }[];
}

export function composeWithPlanner(input: PlannerComposeInput): PlannerComposition {
  const { trip, profile, region } = input;
  const compiled = region.compiled;
  const selectionById = new Map(input.selections.map((s) => [s.placeId, s]));
  const lockedDay = new Map((input.locks ?? []).map((l) => [l.placeId, l.dayNumber]));
  const months = new Set(region.months);

  // --- bases, in stay order ---------------------------------------------------------
  const portfolio = region.basePortfolio?.bases ?? [];
  const bases: PlannerBase[] = (portfolio.length > 0
    ? portfolio.map((b) => ({ id: compiled.bases.find((c) => c.id === b.baseId)?.routingId ?? b.baseId, baseId: b.baseId, nights: b.nights, fromDate: b.fromDate, toDate: b.toDate, transfer: b.transferMinutesFromPrevious }))
    : [{ id: region.baseId, baseId: compiled.primaryBaseId, nights: Math.max(0, region.dates.length - 1), fromDate: region.dates[0]!, toDate: region.dates[region.dates.length - 1]!, transfer: 0 }]
  ).map((b) => {
    const base = compiled.bases.find((c) => c.id === b.baseId) ?? compiled.bases[0]!;
    return { id: b.id, name: base.name, why: base.rationale, coordinates: base.coordinates, fromDate: b.fromDate, toDate: b.toDate, nights: b.nights, transferMinutesFromPrevious: b.transfer };
  });

  // --- the pool --------------------------------------------------------------------------
  const pool: PlannerCandidate[] = [];
  const provenanceOf = new Map<string, PlannerStatus>();
  for (const board of input.candidates) {
    const place = board.place;
    const selectionStatus = statusOf(selectionById.get(place.id));
    // A lock is the traveller's decision too: it outranks everything but their own skip of the same place.
    const status = selectionStatus === 'excluded' ? 'excluded' : lockedDay.has(place.id) ? 'must' : selectionStatus;
    if (status === 'excluded') continue;
    const fitScore = (board as unknown as { fit?: { score?: number } }).fit?.score ?? 50;
    const primaryInterest = ((board as unknown as { fit?: { primaryInterest?: Interest } }).fit?.primaryInterest ?? place.interests[0] ?? null) as Interest | null;
    const booking = (tagValue(place.tags, 'booking') as PlannerCandidate['booking'] | undefined) ?? 'none';
    const candidate: PlannerCandidate = {
      id: place.id,
      name: place.name,
      locality: place.locality,
      coordinates: place.coordinates,
      durationMinutes: place.typicalDurationMinutes,
      intensity: place.physicalIntensity,
      bestTime: place.bestTimeOfDay,
      exposure: place.weather.exposure === 'indoor' ? 'indoor' : place.weather.exposure === 'exposed_outdoor' ? 'outdoor' : 'mixed',
      visibilityDependent: place.weather.visibilityDependent,
      rainyDayOk: place.weather.poorWeatherBackup || place.weather.exposure === 'indoor',
      interests: place.interests,
      primaryInterest,
      category: CATEGORY_FOR_PLACE[place.category] ?? 'landmark',
      kindLabel: place.displayKind ?? place.category.replace(/_/g, ' '),
      fit: fitScore,
      significance: place.experienceSignificance ?? (place.popularityScore >= 0.7 ? 0.8 : 0.5),
      dayTrip: (place.displayKind === 'Small town' || place.category === 'town_and_food') && place.relationship === 'satellite' && place.travelFromBase.driveMinutes >= 45,
      why: place.shortDescription,
      booking,
      openOnTripDates: [...months].some((m) => place.seasonalAccess.openMonths.includes(m)),
      status,
      ...(tagValue(place.tags, 'zone') ? { zone: tagValue(place.tags, 'zone')! } : {}),
      ...(lockedDay.has(place.id) ? { pinnedDay: lockedDay.get(place.id)! } : {}),
      ...(closedDatesOf(board).length > 0 ? { closedDates: closedDatesOf(board) } : {}),
      ...(board.fit.blockers.length > 0 ? { blocked: board.fit.blockers[0]!.message } : {}),
    };
    pool.push(candidate);
    provenanceOf.set(place.id, status);
  }

  // --- the clock: arrival/departure-aware windows, the same ones reconcile uses ----------------
  const windows = buildDailyWindows(trip.basics, profile, resolveConfig()).map((d) => ({ date: d.date, startMinute: d.window.startMinute, endMinute: d.window.endMinute }));

  // --- travel minutes: the matrix, with transit estimated for a car-free trip --------------------
  const coordinates = new Map<string, { lat: number; lng: number }>();
  for (const c of pool) coordinates.set(c.id, c.coordinates);
  for (const b of bases) coordinates.set(b.id, b.coordinates);
  const matrix = region.matrix as unknown as { ids: string[]; minutes: number[][] };
  const index = new Map(matrix.ids.map((id: string, i: number) => [id, i]));
  const placeToRouting = new Map(compiled.places.map((p) => [p.id, p.id]));
  const minutes = (from: string, to: string): number | null => {
    if (from === to) return 0;
    const a = index.get(placeToRouting.get(from) ?? from);
    const b = index.get(placeToRouting.get(to) ?? to);
    const measured = a !== undefined && b !== undefined ? matrix.minutes[a]?.[b] : undefined;
    const pa = coordinates.get(from);
    const pb = coordinates.get(to);
    if (input.carAvailable) {
      if (typeof measured === 'number' && Number.isFinite(measured)) return measured;
      return pa && pb ? estimateLegMinutes({ from: pa, to: pb, mode: 'drive' })?.minutes ?? null : null;
    }
    // Car-free: a short walk is a walk; anything longer is public transport, estimated, never an impossible walk.
    if (pa && pb && haversineKm(pa, pb) <= 1.6) return typeof measured === 'number' && Number.isFinite(measured) ? measured : estimateLegMinutes({ from: pa, to: pb, mode: 'walk' })?.minutes ?? null;
    return pa && pb ? estimateLegMinutes({ from: pa, to: pb, mode: 'rail' })?.minutes ?? null : null;
  };

  // --- weather per day, at the base where that night is spent --------------------------------
  const weatherLocationFor = (date: string): string | null => {
    const base = bases.find((b) => date >= b.fromDate && date < b.toDate) ?? bases[bases.length - 1];
    if (!base) return null;
    const anyPlace = compiled.places.find((p) => (p.travelFromBase.driveMinutes ?? 999) <= 30);
    const location = compiled.weatherLocations.find((l) => l.label === base.name) ?? compiled.weatherLocations.find((l) => anyPlace && l.placeIds.includes(anyPlace.id));
    return location?.id ?? null;
  };
  const weather = plannerWeatherFor(region.weather ?? null, weatherLocationFor, region.dates);

  const foodAreas: PlannerFoodArea[] = (input.extras?.foodAreas ?? []).map((f) => ({ name: f.name, locality: f.locality, specialty: f.specialty }));

  const plannerInput: StructurePlannerInput = {
    destinationName: input.destinationName,
    windows,
    bases,
    candidates: pool,
    minutes,
    pace: profile.pace,
    maxStopsPerDay: Math.max(1, Math.round(profile.derived.activitySlotsPerDay)),
    carAvailable: input.carAvailable,
    maxDailyTravelMinutes: input.carAvailable && input.maxDailyDriveMinutes ? Math.min(input.maxDailyTravelMinutes, input.maxDailyDriveMinutes) : input.maxDailyTravelMinutes,
    maxPhysicalIntensity: profile.derived.maxPhysicalIntensity,
    frequencyCaps: profile.derived.frequencyCaps,
    weather,
    foodAreas,
  };
  const plan = planStructure(plannerInput);

  const seasonalNotes = new Map(compiled.places.filter((p) => p.seasonalAccess.closureRisk !== 'none' && p.seasonalAccess.note).map((p) => [p.id, p.seasonalAccess.note!] as const));
  const draft = draftFromPlan({ plan, bases, input, poolSize: pool.length, minutes, coordinates, seasonalNotes });
  return { draft, plan, provenance: Object.fromEntries(provenanceOf), poolSize: pool.length, plannerInput };
}

function themeFor(day: StructurePlan['days'][number], baseName: string, isFirst: boolean, isLast: boolean): string {
  const daytime = day.stops.filter((s) => s.slot === 'day').map((s) => s.candidate.name);
  const evening = day.stops.find((s) => s.slot === 'sunset' || s.slot === 'night');
  const lead = daytime.slice(0, 2).join(' & ');
  const tail = evening ? `${lead ? ', ' : ''}${evening.candidate.name} ${evening.slot === 'sunset' ? 'at sunset' : 'after dark'}` : '';
  const body = `${lead}${tail}`;
  if (day.relocation) return clip(`On to ${baseName}${body ? `: ${body}` : ''}`, DRAFT_SOFT_PROSE_CAPS.dayTheme);
  if (isFirst) return clip(body ? `Arrive and settle in — ${body}` : 'Arrive and settle in', DRAFT_SOFT_PROSE_CAPS.dayTheme);
  if (isLast) return clip(body ? `A last look — ${body} — then departure` : 'Departure day', DRAFT_SOFT_PROSE_CAPS.dayTheme);
  return clip(body || `A slower day around ${baseName}`, DRAFT_SOFT_PROSE_CAPS.dayTheme);
}

function draftFromPlan(args: {
  plan: StructurePlan;
  bases: readonly PlannerBase[];
  input: PlannerComposeInput;
  poolSize: number;
  minutes: (a: string, b: string) => number | null;
  coordinates: Map<string, { lat: number; lng: number }>;
  seasonalNotes: ReadonlyMap<string, string>;
}): TripDraft {
  const { plan, bases, input } = args;
  const extras = input.extras;
  const draftBaseId = new Map(bases.map((b, i) => [b.id, `base-${i + 1}`]));
  const baseName = new Map(bases.map((b) => [b.id, b.name]));
  const days: DraftDay[] = plan.days.map((day, i) => {
    const isFirst = i === 0;
    const isLast = i === plan.days.length - 1;
    let previous = day.baseId;
    const anchors: DraftAnchor[] = day.stops.slice(0, 5).map((stop, order) => {
      const c = stop.candidate;
      const from = args.coordinates.get(previous);
      const km = from ? haversineKm(from, c.coordinates) : null;
      const transport = transportFor(input.carAvailable, args.minutes(previous, c.id), km, c.category);
      previous = c.id;
      return {
        name: clip(c.name, 60),
        locality: clip(c.locality, 40),
        category: c.category,
        // The traveller's picks and the destination's defining places are core: verification trims an over-full day from the edges, never from these.
        role: c.status === 'must' || order === 0 || (c.significance >= 0.75 && c.status !== 'candidate') ? 'core' : c.status === 'recommended' || c.status === 'maybe' ? 'secondary' : 'optional',
        estimatedDurationMinutes: Math.max(10, Math.min(600, c.durationMinutes)),
        transport,
        ...(stop.slot !== 'day' ? { timeOfDay: stop.slot } : {}),
        why: clip(c.why, DRAFT_SOFT_PROSE_CAPS.anchorWhy),
      } as DraftAnchor;
    });
    const name = baseName.get(day.baseId) ?? input.destinationName;
    const outdoorHeavy = day.stops.some((s) => s.candidate.exposure === 'outdoor' && s.candidate.intensity !== 'none' && (args.minutes(day.baseId, s.candidate.id) ?? 0) > 45);
    const early = day.stops.some((s) => s.slot === 'sunrise' || s.candidate.intensity === 'strenuous');
    const lunch = day.lunchFoodArea
      ? `Lunch around ${day.lunchFoodArea.name}${day.lunchFoodArea.specialty ? ` — ${day.lunchFoodArea.specialty}` : ''}`
      : outdoorHeavy
        ? `Pack a lunch — food is thin out near ${(day.lunchNear ?? 'the trail').replace(/^near\s+/i, '')}`
        : day.lunchNear
          ? `Casual lunch in ${day.lunchNear.replace(/^near\s+/i, '')}, near the midday stop`
          : undefined;
    const weatherNote = (() => {
      const moved = plan.weatherMoves.filter((m) => m.chosenDate === day.date);
      if (moved.length > 0) return `Scheduled here for the better forecast: ${moved.map((m) => m.name).join(', ')}.`;
      if (day.weather && day.weather.severity >= 2) return `The forecast says ${day.weather.label}; the backup below is close by.`;
      return undefined;
    })();
    const lead = day.stops.find((s) => s.slot === 'day') ?? day.stops[0];
    return {
      dayNumber: day.dayNumber,
      baseId: draftBaseId.get(day.baseId) ?? 'base-1',
      theme: themeFor(day, name, isFirst, isLast),
      intensity: day.intensity,
      ...(day.relocation ? { relocation: true } : {}),
      anchors,
      meals: {
        ...(!isFirst && early ? { breakfast: clip(`Early breakfast in ${name} before heading out`, DRAFT_SOFT_PROSE_CAPS.meal) } : {}),
        ...(lunch ? { lunch: clip(lunch, DRAFT_SOFT_PROSE_CAPS.meal) } : {}),
        ...(!isLast ? { dinner: clip(`Dinner in ${name}`, DRAFT_SOFT_PROSE_CAPS.meal) } : {}),
        ...(day.lunchFoodArea ? { area: clip(day.lunchFoodArea.name, DRAFT_SOFT_PROSE_CAPS.lodgingArea) } : {}),
      },
      ...(weatherNote ? { note: clip(weatherNote, DRAFT_SOFT_PROSE_CAPS.dayNote) } : {}),
      ...(lead ? { whyItFits: clip(lead.candidate.why, DRAFT_SOFT_PROSE_CAPS.whyItFits) } : {}),
    };
  });

  const scheduled = plan.days.flatMap((d) => d.stops.map((s) => s.candidate));
  const topInterests = [...new Set(scheduled.map((c) => c.primaryInterest).filter((i): i is Interest => i !== null))].slice(0, 3).map((i) => i.replace(/_/g, ' '));
  const offered = new Set<string>();
  const backups = plan.days
    .filter((d) => d.backup && (d.weather?.wet || !offered.has(d.backup.id)) && offered.add(d.backup.id))
    .slice(0, 6)
    .map((d) => ({
      trigger: clip(d.weather && d.weather.severity >= 1 ? `If the ${d.weather.label} holds on day ${d.dayNumber}` : `Rain or strong wind on day ${d.dayNumber}`, DRAFT_SOFT_PROSE_CAPS.backupTrigger),
      alternative: clip(`${d.backup!.name} (${d.backup!.kindLabel.toLowerCase()}), close to where you are staying`, DRAFT_SOFT_PROSE_CAPS.backupAlternative),
      day: d.dayNumber,
    }));
  const leftOut = plan.dropped
    .filter((d) => d.reason !== 'excluded' && (d.candidate.status !== 'candidate' || d.candidate.fit >= 70))
    .sort((a, b) => b.candidate.fit - a.candidate.fit)
    .slice(0, 6)
    .map((d) => ({ name: clip(d.candidate.name, 60), reason: clip(d.detail, DRAFT_SOFT_PROSE_CAPS.omissionReason) }));
  const deliberate = (extras?.skipped ?? []).slice(0, Math.max(0, 8 - leftOut.length)).map((s) => ({ name: clip(s.name, 60), reason: clip(`Sidequest's research: ${s.reason}`, DRAFT_SOFT_PROSE_CAPS.omissionReason) }));
  const bookingLines = scheduled.filter((c) => c.booking === 'required').map((c) => `Book ${c.name} ahead — entry needs a reservation.`);
  const signatures = scheduled.filter((c) => c.status === 'must' || c.status === 'recommended').sort((a, b) => b.fit - a.fit).slice(0, 3).map((c) => clip(c.name, 60));
  const urban = !input.carAvailable || bases.length === 1 && scheduled.every((c) => (args.minutes(bases[0]!.id, c.id) ?? 0) <= 45);

  const draft = {
    archetype: archetypeFor({ bases: bases.length, carAvailable: input.carAvailable, urban }),
    purpose: clip(`${plan.days.length} days in ${input.destinationName}${topInterests.length > 0 ? ` built around ${topInterests.join(', ')}` : ''} — ${scheduled.length} places chosen from the ${args.poolSize} on your board.`, DRAFT_SOFT_PROSE_CAPS.purpose),
    routeRationale: clip(
      bases.length > 1
        ? `${bases.map((b) => `${b.name} (${b.nights} night${b.nights === 1 ? '' : 's'})`).join(', then ')} — in the order that keeps the drive between them shortest, with each day's stops grouped around where you sleep.`
        : `One base in ${bases[0]?.name ?? input.destinationName}; each day's stops are grouped so you are not crossing back and forth.`,
      DRAFT_SOFT_PROSE_CAPS.routeRationale,
    ),
    assumptions: [
      clip('Opening hours and access are checked when the plan is built where a provider has them; check the rest before you go.', DRAFT_SOFT_PROSE_CAPS.assumption),
      ...(input.carAvailable ? [] : [clip('Public transport times are estimates; no timetable was consulted.', DRAFT_SOFT_PROSE_CAPS.assumption)]),
    ],
    tradeoffs: plan.dropped
      .filter((d) => d.reason === 'capacity' && d.candidate.status !== 'candidate')
      .slice(0, 3)
      .map((d) => clip(`Left out ${d.candidate.name} to keep the days at your pace.`, DRAFT_SOFT_PROSE_CAPS.tradeoff)),
    bases: bases.map((b, i) => ({
      id: draftBaseId.get(b.id) ?? `base-${i + 1}`,
      name: clip(b.name, 100),
      nights: b.nights,
      why: clip(b.why, DRAFT_SOFT_PROSE_CAPS.baseWhy),
    })),
    days,
    omissions: [...leftOut, ...deliberate].slice(0, 8),
    unresolved: plan.mustConflicts.slice(0, 8).map((m) => clip(`${m.name}: you asked for it, and it did not fit — ${m.detail}`, DRAFT_SOFT_PROSE_CAPS.unresolvedItem)),
    bookingPriorities: [...bookingLines, ...(extras?.package.bookingPriorities ?? [])].slice(0, 8).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.bookingPriority)),
    ...(signatures.length > 0 ? { signatures } : {}),
    driving: input.carAvailable ? 'rental_self_drive' : 'none',
    package: {
      foodStrategy: (extras?.package.foodStrategy ?? []).slice(0, 8).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.foodStrategy)),
      transport: (() => {
        const derived = transportStrategyFor({ plan, bases, carAvailable: input.carAvailable, maxDailyTravelMinutes: input.carAvailable && input.maxDailyDriveMinutes ? Math.min(input.maxDailyTravelMinutes, input.maxDailyDriveMinutes) : input.maxDailyTravelMinutes, minutes: args.minutes, coordinates: args.coordinates });
        return {
          summary: clip(derived.summary, DRAFT_SOFT_PROSE_CAPS.transportSummary),
          notes: [...derived.notes, ...(extras?.package.transportNotes ?? [])].slice(0, 6).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.transportNote)),
        };
      })(),
      beforeYouGo: dedupeLines([...beforeYouGoFor({ scheduled, carAvailable: input.carAvailable, seasonal: args.seasonalNotes }), ...(extras?.package.beforeYouGo ?? [])]).slice(0, 10).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.beforeYouGo)),
      packing: (extras?.package.packing ?? []).slice(0, 15).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.packing)),
      backups,
    },
  };
  return tripDraftSchema.parse(draft);
}

/** What the package records about how the planner built this trip. */
export function planningRecordOf(composed: PlannerComposition): {
  mode: 'planner';
  poolSize: number;
  scheduled: { traveller: number; sidequest: number; maybe: number; filler: number };
  weatherMoves: { name: string; avoidedDate: string; chosenDate: string }[];
  mustConflicts: { name: string; detail: string }[];
} {
  const scheduled = { traveller: 0, sidequest: 0, maybe: 0, filler: 0 };
  for (const day of composed.plan.days) {
    for (const stop of day.stops) {
      const status = stop.candidate.status;
      if (status === 'must') scheduled.traveller += 1;
      else if (status === 'recommended') scheduled.sidequest += 1;
      else if (status === 'maybe') scheduled.maybe += 1;
      else scheduled.filler += 1;
    }
  }
  return {
    mode: 'planner',
    poolSize: composed.poolSize,
    scheduled,
    weatherMoves: composed.plan.weatherMoves.map((m) => ({ name: m.name, avoidedDate: m.avoidedDate, chosenDate: m.chosenDate })),
    mustConflicts: composed.plan.mustConflicts.map((m) => ({ name: m.name, detail: m.detail })),
  };
}

/**
 * V1 — THE TRANSPORT RECOMMENDATION, FROM THE PLAN'S OWN SHAPE.
 *
 * Master prompt §12: transport is a decision, not prose. Read off what the
 * planner actually built — how far the stops sit from where you sleep, how much
 * of each day is travel against the limit the traveller set, how many hops are
 * a walk, how many hotel moves — and said as a recommendation with its reasons.
 * Transit is never claimed as timed: no timetable is consulted.
 */
export function transportStrategyFor(input: {
  plan: StructurePlan;
  bases: readonly PlannerBase[];
  carAvailable: boolean;
  maxDailyTravelMinutes: number;
  minutes: (a: string, b: string) => number | null;
  coordinates: Map<string, { lat: number; lng: number }>;
}): { summary: string; notes: string[] } {
  const hops: number[] = [];
  let furthest = 0;
  for (const day of input.plan.days) {
    let previous = day.baseId;
    for (const stop of day.stops) {
      const a = input.coordinates.get(previous);
      if (a) hops.push(haversineKm(a, stop.candidate.coordinates));
      furthest = Math.max(furthest, input.minutes(day.baseId, stop.candidate.id) ?? 0);
      previous = stop.candidate.id;
    }
  }
  const walkable = hops.length > 0 ? hops.filter((km) => km <= 1.5).length / hops.length : 0;
  const busy = input.plan.days.filter((d) => d.stops.length > 0);
  const typical = busy.length > 0 ? Math.round(busy.map((d) => d.travelMinutes).sort((a, b) => a - b)[Math.floor(busy.length / 2)]!) : 0;
  const moves = Math.max(0, input.bases.length - 1);
  const notes: string[] = [];
  let summary: string;
  if (input.carAvailable) {
    if (walkable >= 0.6 && furthest <= 30) {
      summary = `A car is optional here: ${Math.round(walkable * 100)}% of the hops between stops are walks, and nothing is more than ${Math.round(furthest)} minutes from where you sleep.`;
      notes.push('Consider leaving the car parked for town days; parking near busy sights is rarely worth the circling.');
    } else {
      summary = `A car: stops sit up to ${Math.round(furthest)} minutes from where you sleep, and a typical day has about ${typical} minutes of driving against your ${input.maxDailyTravelMinutes}-minute limit.`;
    }
  } else if (walkable >= 0.5) {
    summary = `On foot and by public transport: ${Math.round(walkable * 100)}% of the hops between stops are walks; the longer ones are public-transport rides, estimated rather than timed.`;
  } else {
    summary = `Public transport first: most hops between stops are rides rather than walks; a typical day has about ${typical} minutes of travel, estimated from distance — no timetable was consulted.`;
    if (furthest > 75) notes.push(`The furthest stop is about ${Math.round(furthest)} minutes away by public transport; a car or tour would shorten that day.`);
  }
  if (moves > 0) notes.unshift(`${moves} hotel move${moves === 1 ? '' : 's'}, in the order that keeps the journeys between bases shortest.`);
  return { summary, notes };
}

/**
 * V1 — WHAT TO DO BEFORE LEAVING, FROM THE PLAN'S OWN FACTS.
 *
 * Every line names something on this trip: a stop to book, a seasonal access
 * to recheck, hours nobody confirmed, the car. Entry requirements are always
 * worth checking against an official source and are said as a check, never as
 * a rule. The scan's research lines follow these and are de-duplicated.
 */
export function beforeYouGoFor(input: { scheduled: readonly PlannerCandidate[]; carAvailable: boolean; seasonal: ReadonlyMap<string, string> }): string[] {
  const lines: string[] = ['Check the official entry requirements for your nationality before you book anything.'];
  const book = input.scheduled.filter((c) => c.booking === 'required').map((c) => c.name);
  const recommended = input.scheduled.filter((c) => c.booking === 'recommended').map((c) => c.name);
  if (book.length > 0) lines.push(`Book ahead — entry needs a reservation: ${book.slice(0, 4).join(', ')}.`);
  if (recommended.length > 0) lines.push(`Worth booking ahead: ${recommended.slice(0, 4).join(', ')}.`);
  for (const c of input.scheduled) {
    const note = input.seasonal.get(c.id);
    if (note) lines.push(`${c.name}: ${note}`);
  }
  if (input.carAvailable) lines.push('Reserve the hire car for the whole trip; pick-up and return times shape the first and last day.');
  return lines;
}

function dedupeLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 48);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Trip dates the board's operating assessment says are closed. `unknown` is never closed. */
function closedDatesOf(board: DiscoveryCandidate): string[] {
  return (board.operating?.byDate ?? []).filter((d) => d.status === 'closed').map((d) => d.date);
}
