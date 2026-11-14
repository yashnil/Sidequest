import { boundedLegMinutes, estimateLegMinutes, haversineKm, highSpeedRailBackbone, lowerBoundFrom, publicTransportNetwork, matrixFeasibility, verifiedLookup, type Itinerary, type StayDecision, type DiscoveryCandidate, type Interest, type TravelerProfile, type Trip, type UnscheduledPlace, type UnscheduledReasonCode, type WeatherDataset, trailClock, trailHours, type TrailRecord } from '@sidequest/core';
import { buildDailyWindows, resolveConfig } from '@sidequest/planner';
import type { DiscoverySelection } from '@sidequest/core';
import type { RegionContext } from '../region';
import type { ScanProposalExtras } from '../db/scan-repository';
import { matchNamedMustDos } from '../discovery-scan/match';
import { archetypeFor, planStructure, transportFor, type DropReason, type PlannerBase, type PlannerCandidate, type PlannerDayWeather, type PlannerDayWindow, type PlannerFoodArea, type PlannerStatus, type StructurePlan, type StructurePlannerInput } from './structure-planner';
import { classifyDayDensity, densityNote, discoveryLossesOf, type TripDensity } from './day-density';
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
  /** Why the trip sleeps where it does, when the region's bases were chosen by the stay objective. */
  stay?: StayDecision;
  /** One sentence naming a base this scan proposed that would reach the traveller's picks, when one exists. */
  baseSuggestion?: string;
  /** Why each light day is light — pace, one long experience, nothing in reach, or a discovery gap (`day-density.ts`). */
  density?: TripDensity;
  /** The sentences those classes put on their days, in the shape of `plan.dayNotes`. */
  densityNotes?: { dayNumber: number; code: string; note: string }[];
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

/** Categories where food really is thin on the ground (`outdoorHeavy`). */
const WILD_GROUND: ReadonlySet<AnchorCategory> = new Set(['hike', 'nature', 'water', 'scenic_drive', 'viewpoint', 'geothermal']);

/** Whose choice a left-out place was, for the order the omissions are told in. */
const OWNERSHIP_RANK: Record<PlannerStatus, number> = { must: 0, maybe: 1, recommended: 2, candidate: 3 };

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
  /** Places the trip-quality contract needs in the plan (`quality/trip-quality-contract.ts`); the proposal's own `defining` marks count too. */
  essentialIds?: ReadonlySet<string>;
  /**
   * How the trip's ground travel is arranged, from the trip-quality contract:
   * an operator-run trip (a safari's driver-guide and 4x4) is never written as
   * a self-drive rental just because the traveller could drive.
   */
  groundArrangement?: 'operator' | 'self_drive' | 'public_transport' | 'undecided';
}

/**
 * The planner's improvement phase (`structure-improve.ts`) is on unless
 * `SIDEQUEST_PLANNER_IMPROVE=off`, which returns greedy construction exactly —
 * for comparing the two on the same board, never a traveller-facing choice.
 */
export function plannerImproveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SIDEQUEST_PLANNER_IMPROVE?.trim().toLowerCase() !== 'off';
}

/** A one-way walk's end, from the scan's tags (`scan/assemble.ts#walkTags`). */
export function walkEndOf(tags: readonly string[]): { walkEnd?: { lat: number; lng: number; name?: string } } {
  const at = tags.find((tag) => tag.startsWith('walk-end:'))?.slice('walk-end:'.length);
  if (!at) return {};
  const [lat, lng] = at.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return {};
  const name = tags.find((tag) => tag.startsWith('walk-end-name:'))?.slice('walk-end-name:'.length);
  return { walkEnd: { lat: lat!, lng: lng!, ...(name ? { name } : {}) } };
}

/** Within this of a bed, a walk that ends there needs no return: that night is spent at its end. */
const WALK_ENDS_AT_BED_KM = 3;

/**
 * What a one-way walk leaves the traveller to arrange, said on its day
 * (2026-11). Ending beside that night's bed on a move day: the bags must go
 * ahead. Ending anywhere else: the way back — to the car, or to the bed — with
 * an estimated time and the honest instruction to check the last departure.
 * Never a timetable or a promise: Sidequest has none to give.
 */
export function walkNotes(args: { plan: StructurePlan; bases: readonly PlannerBase[]; carAvailable: boolean }): { dayNumber: number; code: 'walk_return' | 'walk_luggage'; note: string }[] {
  /* A trail stage on its own move day ends at tonight's bed by construction (`scan/trail-stages.ts`), within the stage-end reach rather than this file's three kilometres. */
  const notes: { dayNumber: number; code: 'walk_return' | 'walk_luggage'; note: string }[] = [];
  for (const day of args.plan.days) {
    const bed = args.bases.find((b) => b.id === day.baseId);
    for (const stop of day.stops) {
      const c = stop.candidate;
      if (!c.walkEnd) continue;
      const endName = c.walkEnd.name ?? 'the end of the walk';
      const toBed = bed ? haversineKm(c.walkEnd, bed.coordinates) : null;
      if (toBed !== null && (toBed <= WALK_ENDS_AT_BED_KM || (c.trailStage && day.relocation)) && !args.carAvailable) {
        notes.push({
          dayNumber: day.dayNumber,
          code: 'walk_luggage',
          note: day.relocation
            ? `${c.name} ends at ${endName}, by tonight's bed in ${bed!.name}: send your bags ahead from the last place you stayed, booked in advance — luggage services need notice and do not run everywhere every day.`
            : `${c.name} ends at ${endName}, close to your bed in ${bed!.name} — no transfer back needed.`,
        });
        continue;
      }
      const back = args.carAvailable
        ? estimateLegMinutes({ from: c.walkEnd, to: c.coordinates, mode: 'drive' })?.minutes
        : bed
          ? estimateLegMinutes({ from: c.walkEnd, to: bed.coordinates, mode: 'rail' })?.minutes
          : undefined;
      const time = back !== undefined ? ` (about ${Math.max(10, Math.round(back / 5) * 5)} min by road, estimated)` : '';
      notes.push({
        dayNumber: day.dayNumber,
        code: 'walk_return',
        note: args.carAvailable
          ? `${c.name} is one-way: it ends at ${endName}, away from where you park at the start. Arrange a taxi or bus back to the car${time}, and check the last departure before you set off.`
          : `${c.name} is one-way: it ends at ${endName}. Take the bus or a taxi back to ${bed?.name ?? 'your base'}${time}; check the last departure before you start walking.`,
      });
    }
  }
  return notes;
}

/**
 * 2026-11 (point-to-point trekking) — what a followed trail writes on its
 * days: each stage's figures and where they came from, the latest start that
 * still arrives before dusk, a stage covered the usual other way, one still
 * unresolved, the rest day, and the way home from the trail's end. Every
 * sentence is a figure Sidequest has, labelled as measured or estimated.
 */
export type TrailNoteCode = 'trail_stage' | 'trail_alternative' | 'trail_unresolved' | 'trail_rest' | 'trail_return' | 'trail_gap';
export function trailNotes(args: { trail: TrailRecord; plan: StructurePlan; bases: readonly PlannerBase[] }): { dayNumber: number; code: TrailNoteCode; note: string }[] {
  const { trail, plan } = args;
  const notes: { dayNumber: number; code: TrailNoteCode; note: string }[] = [];
  if (!trail.followed) {
    if (trail.gap) notes.push({ dayNumber: 1, code: 'trail_gap', note: trail.gap });
    return notes;
  }
  const scheduled = new Set(plan.days.flatMap((d) => d.stops.map((s) => s.candidate.id)));
  const total = trail.stages.length;
  for (const stage of trail.stages) {
    if (stage.dayNumber === undefined) continue;
    const route = stage.fromName && stage.toName ? `${stage.fromName} → ${stage.toName}` : stage.name;
    if (stage.resolution === 'alternative') {
      notes.push({ dayNumber: stage.dayNumber, code: 'trail_alternative', note: `${route}: ${stage.note ?? 'covered the usual other way, not walked.'}` });
      continue;
    }
    if (!scheduled.has(stage.placeId)) continue;
    const figures = [stage.km !== null ? `${stage.km} km` : null, stage.ascentM !== null ? `${Math.round(stage.ascentM)} m of climbing` : null].filter(Boolean).join(' and ');
    const basis = stage.distanceBasis === 'measured' ? 'measured on the trail by openrouteservice' : stage.distanceBasis === 'proposal' ? "Sidequest's research, not measured" : 'from the time the walk usually takes, not measured';
    const timing = stage.latestStartMinute !== undefined && stage.duskMinute !== undefined ? `; set off by ${trailClock(Math.floor(stage.latestStartMinute / 15) * 15)} to reach ${stage.toName ?? 'the next bed'} at least an hour before dusk (about ${trailClock(stage.duskMinute)})` : '';
    notes.push({ dayNumber: stage.dayNumber, code: 'trail_stage', note: `Stage ${stage.order} of ${total}: ${route}${figures ? `, ${figures}` : ''} (${basis}) — about ${trailHours(stage.walkMinutes)} of walking${timing}.${stage.resolution === 'split' && stage.note ? ` ${stage.note}` : ''}` });
    if (stage.resolution === 'unresolved' && stage.note) notes.push({ dayNumber: stage.dayNumber, code: 'trail_unresolved', note: `${route} is a long day for this party: ${stage.note}` });
  }
  for (const baseId of trail.restBaseIds) {
    const day = plan.days.find((d, i) => d.baseId === baseId && !d.relocation && i > 0 && i < plan.days.length - 1);
    const name = args.bases.find((b) => b.id === baseId)?.name;
    if (day && name) notes.push({ dayNumber: day.dayNumber, code: 'trail_rest', note: `A rest day in ${name}: no stage today, and a hot spring close by.` });
  }
  if (trail.returnLeg && plan.days.length > 0) {
    notes.push({ dayNumber: plan.days[plan.days.length - 1]!.dayNumber, code: 'trail_return', note: `The trail ends in ${trail.returnLeg.fromName}: from there to where you leave is about ${trailHours(trail.returnLeg.minutes)} by bus or train (estimated; no timetable was consulted) — check the last departure.` });
  }
  return notes;
}

export function composeWithPlanner(rawInput: PlannerComposeInput): PlannerComposition {
  /*
   * A trail followed inn to inn is walked, with public transport for the gaps
   * and the bags sent ahead: no hire car, whatever the traveller could drive.
   */
  const trail = rawInput.region.basePortfolio?.decision?.trail;
  const trailFollowed = trail?.followed === true;
  const input: PlannerComposeInput = trailFollowed ? { ...rawInput, carAvailable: false, groundArrangement: 'public_transport' } : rawInput;
  const stageById = new Map((trailFollowed ? trail!.stages : []).filter((s) => s.dayNumber !== undefined).map((s) => [s.placeId, s] as const));
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
  /* A move a trail stage walks costs no transfer: the walker walks it and the bags go by luggage service (the stage is the day). */
  for (const stage of stageById.values()) {
    if (stage.resolution === 'alternative' || !input.candidates.some((c) => c.place.id === stage.placeId)) continue;
    const date = region.dates[stage.dayNumber! - 1];
    const at = bases.findIndex((b, i) => i > 0 && b.fromDate === date && b.id === stage.toBaseId && bases[i - 1]!.id === stage.fromBaseId);
    if (at > 0) bases[at] = { ...bases[at]!, transferMinutesFromPrevious: 0 };
  }

  // --- the pool --------------------------------------------------------------------------
  const pool: PlannerCandidate[] = [];
  const provenanceOf = new Map<string, PlannerStatus>();
  for (const board of input.candidates) {
    const place = board.place;
    const selectionStatus = statusOf(selectionById.get(place.id));
    // A lock is the traveller's decision too: it outranks everything but their own skip of the same place.
    const stage = stageById.get(place.id);
    const walked = stage !== undefined && stage.resolution !== 'alternative';
    /* A stage the trail is walked on is Sidequest's pick for its move day unless the traveller already chose it. */
    const status = selectionStatus === 'excluded' ? 'excluded' : lockedDay.has(place.id) ? 'must' : walked && selectionStatus === 'candidate' ? 'recommended' : selectionStatus;
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
      ...(board.fit.blockers.length > 0 ? { blocked: board.fit.blockers[0]!.message, blockedCode: board.fit.blockers[0]!.code } : {}),
      ...walkEndOf(place.tags),
      ...(place.tags.includes('defining') || input.essentialIds?.has(place.id) ? { essential: true } : {}),
      /*
       * A walked stage: pinned to its move day, essential, timed for any hour
       * of the day, and outside the interest caps (it is the trip, not one more
       * hike). A stage covered the usual other way is not workable as a walk,
       * with the reason the day also states.
       */
      ...(walked ? { trailStage: true, essential: true, pinnedDay: lockedDay.get(place.id) ?? stage.dayNumber!, bestTime: 'any' as const, primaryInterest: null } : {}),
      ...(stage && !walked ? { blocked: stage.note ?? 'Not walked on this trip.', blockedCode: 'too_strenuous' } : {}),
    };
    pool.push(candidate);
    provenanceOf.set(place.id, status);
  }

  // --- the clock: arrival/departure-aware windows, the same ones reconcile uses ----------------
  const windows = buildDailyWindows(trip.basics, profile, resolveConfig()).map((d) => ({ date: d.date, startMinute: d.window.startMinute, endMinute: d.window.endMinute }));

  // --- travel minutes: the matrix, with transit estimated for a car-free trip --------------------
  const coordinates = new Map<string, { lat: number; lng: number }>();
  for (const c of pool) coordinates.set(c.id, c.coordinates);
  const walkEnds = new Map(pool.filter((c) => c.walkEnd).map((c) => [c.id, c.walkEnd!] as const));
  for (const b of bases) coordinates.set(b.id, b.coordinates);
  const matrix = region.matrix as unknown as { mode?: string; ids: string[]; minutes: number[][]; feasibility?: string[][] };
  const index = new Map(matrix.ids.map((id: string, i: number) => [id, i]));
  /*
   * Eval v3 — a road figure nobody measured is raised to the floor the
   * measured legs prove (`@sidequest/core` `travel/feasibility.ts`), so two
   * stops either side of a cliff are never a short drive apart because they
   * are close on a map. Cells of a bounded scan matrix already carry it; this
   * covers a pair the matrix does not hold.
   */
  const verified = verifiedLookup(matrix);
  const roadMatrix = matrix.mode === undefined || matrix.mode === 'car';
  const placeToRouting = new Map(compiled.places.map((p) => [p.id, p.id]));
  /*
   * Out of a one-way walk, the traveller is at its end, not its start. Without
   * a car the next leg starts there; with one, they first get back to the car
   * at the start (a taxi or bus, estimated by road) and drive on from there.
   * Unknown is never zero: an end with no estimate falls back to the start's
   * leg plus nothing only when no estimate exists at all.
   */
  const minutes = (from: string, to: string): number | null => {
    const end = walkEnds.get(from);
    if (end && from !== to) {
      const startPoint = coordinates.get(from);
      const target = coordinates.get(to);
      if (startPoint && target) {
        if (input.carAvailable) {
          const back = estimateLegMinutes({ from: end, to: startPoint, mode: 'drive' })?.minutes;
          const onward = baseMinutes(from, to);
          return back !== undefined && onward !== null ? back + onward : onward;
        }
        return haversineKm(end, target) <= 1.6 ? estimateLegMinutes({ from: end, to: target, mode: 'walk' })?.minutes ?? null : estimateLegMinutes({ from: end, to: target, mode: 'rail' })?.minutes ?? null;
      }
    }
    return baseMinutes(from, to);
  };
  const baseMinutes = (from: string, to: string): number | null => {
    if (from === to) return 0;
    const a = index.get(placeToRouting.get(from) ?? from);
    const b = index.get(placeToRouting.get(to) ?? to);
    const measured = a !== undefined && b !== undefined ? matrix.minutes[a]?.[b] : undefined;
    const pa = coordinates.get(from);
    const pb = coordinates.get(to);
    if (input.carAvailable) {
      if (typeof measured === 'number' && Number.isFinite(measured)) return measured;
      const estimate = pa && pb ? estimateLegMinutes({ from: pa, to: pb, mode: 'drive' })?.minutes ?? null : null;
      if (!roadMatrix || verified.pivots.length === 0) return estimate;
      const bound = lowerBoundFrom({ pivots: verified.pivots, measured: (x, y) => verified.measured(placeToRouting.get(x) ?? x, placeToRouting.get(y) ?? y), fromId: placeToRouting.get(from) ?? from, toId: placeToRouting.get(to) ?? to });
      return boundedLegMinutes({ estimate, bound })?.minutes ?? estimate;
    }
    // Car-free: a short walk is a walk; anything longer is public transport, estimated, never an impossible walk.
    if (pa && pb && haversineKm(pa, pb) <= 1.6) return typeof measured === 'number' && Number.isFinite(measured) ? measured : estimateLegMinutes({ from: pa, to: pb, mode: 'walk' })?.minutes ?? null;
    return pa && pb ? estimateLegMinutes({ from: pa, to: pb, mode: 'rail', highSpeedRail: highSpeedRailBackbone(compiled.scope.countryCode) })?.minutes ?? null : null;
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

  /* V1 — the arrival and departure transfers, from the destination's own centre (where a scan region says the trip is anchored) to the first and last base. */
  function edgeTransfersFor(): { edgeTransfers?: { arrivalMinutes: number; departureMinutes: number } } {
    /* Only a scanned city is anchored where the traveller arrives; an authored or regional destination's centre is not an arrival point. */
    const scope = (compiled as unknown as { compilerVersion?: string; scope?: { center?: { lat: number; lng: number }; destinationEntityType?: string } }).scope;
    const scanned = String((compiled as unknown as { compilerVersion?: string }).compilerVersion ?? '').startsWith('discovery-scan');
    const cityLike = scope?.destinationEntityType === 'city' || scope?.destinationEntityType === 'municipality' || scope?.destinationEntityType === 'neighbourhood';
    const anchor = scanned && cityLike ? scope?.center : undefined;
    const first = bases[0];
    const last = bases[bases.length - 1];
    if (!anchor || !first || !last) return {};
    const leg = (to: { lat: number; lng: number }) => {
      const km = haversineKm(anchor, to);
      if (km <= 3) return 0;
      return Math.round(estimateLegMinutes({ from: anchor, to, mode: input.carAvailable ? 'drive' : 'rail' })?.minutes ?? 0);
    };
    return { edgeTransfers: { arrivalMinutes: leg(first.coordinates), departureMinutes: leg(last.coordinates) } };
  }

  const foodAreas: PlannerFoodArea[] = (input.extras?.foodAreas ?? []).map((f) => ({ name: f.name, locality: f.locality, specialty: f.specialty }));

  const plannerInput: StructurePlannerInput = {
    destinationName: input.destinationName,
    windows,
    bases,
    candidates: pool,
    minutes,
    /* Eval v3 — a pair a router affirmatively found no road between is never one day's drive. Car trips only: a foot matrix's no-route says nothing about a bus. */
    ...(input.carAvailable && roadMatrix && matrix.feasibility ? { disconnected: (a: string, b: string) => matrixFeasibility(matrix, placeToRouting.get(a) ?? a, placeToRouting.get(b) ?? b) === 'disconnected' } : {}),
    pace: profile.pace,
    maxStopsPerDay: Math.max(1, Math.round(profile.derived.activitySlotsPerDay)),
    carAvailable: input.carAvailable,
    maxDailyTravelMinutes: input.carAvailable && input.maxDailyDriveMinutes ? Math.min(input.maxDailyTravelMinutes, input.maxDailyDriveMinutes) : input.maxDailyTravelMinutes,
    maxPhysicalIntensity: profile.derived.maxPhysicalIntensity,
    dailyIntensity: profile.dailyIntensity,
    frequencyCaps: profile.derived.frequencyCaps,
    weather,
    foodAreas,
    ...edgeTransfersFor(),
    improve: plannerImproveEnabled(),
  };
  const plan = planStructure(plannerInput);
  plan.dayNotes.push(...walkNotes({ plan, bases, carAvailable: input.carAvailable }));
  if (trail) plan.dayNotes.push(...trailNotes({ trail, plan, bases }));

  const seasonalNotes = new Map(compiled.places.filter((p) => p.seasonalAccess.closureRisk !== 'none' && p.seasonalAccess.note).map((p) => [p.id, p.seasonalAccess.note!] as const));
  const draft = draftFromPlan({ plan, bases, input, windows, poolSize: pool.length, minutes, coordinates, seasonalNotes });
  if (trailFollowed && draft.package) {
    /* The two things a walk from inn to inn stands on, said before anything else the traveller books. */
    const prep = clip('Book a bed at every stage end, and a luggage transfer for each walking day — both need notice, and the inns can often arrange the bags.', DRAFT_SOFT_PROSE_CAPS.beforeYouGo);
    draft.package.beforeYouGo = dedupeLines([draft.package.beforeYouGo[0] ?? prep, prep, ...draft.package.beforeYouGo.slice(1)]).slice(0, 10);
  }
  const stay = region.basePortfolio?.decision;
  const baseSuggestion = suggestBaseForPicks({
    plan,
    bases,
    allBases: compiled.bases.map((b) => ({ id: b.routingId ?? b.id, name: b.name })),
    pool,
    minutes,
    limit: plannerInput.maxDailyTravelMinutes,
    mayMove: profile.interview.baseMoveTolerance !== 'stay_put' && (profile.interview.baseMoveTolerance !== 'move_once' || bases.length < 2),
  });
  const density = classifyDayDensity({ plan, planner: plannerInput, freeTimeHeavy: profile.freeTime === 'lots', losses: discoveryLossesOf(input.extras?.diagnostics) });
  const baseNameOf = new Map(bases.map((b) => [b.id, b.name] as const));
  const firstGap = density.days.find((d) => d.class === 'discovery_gap')?.dayNumber;
  const densityNotes = density.days.flatMap((d) => {
    const day = plan.days.find((p) => p.dayNumber === d.dayNumber)!;
    /* The full sentence once; a later light day points back to it rather than repeating it. */
    const note = d.class === 'discovery_gap' && firstGap !== undefined && d.dayNumber !== firstGap
      ? `A light day for the same reason as day ${firstGap}: Sidequest could not place everything it found for this trip. Nothing for you to do.`
      : densityNote(d, density, { baseName: baseNameOf.get(day.baseId) ?? input.destinationName, maxDailyTravelMinutes: plannerInput.maxDailyTravelMinutes, isEmpty: day.stops.length === 0 });
    return note ? [{ dayNumber: d.dayNumber, code: `density_${d.class}`, note }] : [];
  });
  return { draft, plan, provenance: Object.fromEntries(provenanceOf), poolSize: pool.length, plannerInput, ...(stay ? { stay } : {}), ...(baseSuggestion ? { baseSuggestion } : {}), density, ...(densityNotes.length > 0 ? { densityNotes } : {}) };
}

/**
 * THE TRAVELLER'S PICKS, AND A PLACE TO SLEEP THAT WOULD REACH THEM.
 *
 * Bases are chosen when the scan is assembled, before anybody has been to the
 * board, so a pick made there cannot change them. This does not change them
 * either: moving a hotel is the traveller's call. It says so, once, when a base
 * this scan already proposed would bring within reach a pick that this plan
 * either could not place or could only place as a long day out.
 */
export function suggestBaseForPicks(input: {
  plan: StructurePlan;
  bases: readonly PlannerBase[];
  allBases: readonly { id: string; name: string }[];
  pool: readonly PlannerCandidate[];
  minutes: (from: string, to: string) => number | null;
  limit: number;
  mayMove: boolean;
}): string | null {
  const reach = Math.max(45, Math.floor(input.limit / 2));
  const stayingAt = new Set(input.bases.map((b) => b.id));
  const nearest = (id: string) => Math.min(...input.bases.map((b) => input.minutes(b.id, id) ?? Infinity));
  const unreached = new Set(input.plan.mustConflicts.map((m) => m.candidateId));
  const placedFar = input.plan.days.flatMap((d) => d.stops.filter((s) => s.candidate.status === 'must' && nearest(s.candidate.id) > reach).map((s) => s.candidate.id));
  const wanted = [...new Set([...unreached, ...placedFar])].filter((id) => nearest(id) > reach && input.pool.some((c) => c.id === id));
  if (wanted.length === 0) return null;
  const options = input.allBases
    .filter((b) => !stayingAt.has(b.id))
    .map((b) => ({ base: b, covers: wanted.filter((id) => { const m = input.minutes(b.id, id); return m !== null && m <= reach; }) }))
    .filter((o) => o.covers.length > 0)
    .sort((a, b) => b.covers.length - a.covers.length || a.base.name.localeCompare(b.base.name));
  const best = options[0];
  if (!best) return null;
  const nameOf = new Map(input.pool.map((c) => [c.id, c.name] as const));
  const names = best.covers.map((id) => nameOf.get(id)!).slice(0, 3);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
  const sleepers = input.bases.map((b) => b.name);
  return `${list} ${names.length === 1 ? 'is' : 'are'} on your list but far from ${sleepers.length === 1 ? sleepers[0]! : 'where this trip sleeps'}. A night or two in ${best.base.name} would bring ${names.length === 1 ? 'it' : 'them'} within reach${input.mayMove ? '' : ', if you would accept another hotel change'}.`;
}

/**
 * A day's title: short, and about the day (2026-11). It joined every stop's
 * name — "Inyo Craters & Panorama Gondola, Minaret Vista at sunset" — so the
 * heading repeated the timeline under it and wrapped three lines on a phone.
 * Now it leads with the day's defining stop, adds a second only while the
 * title stays short, and otherwise says how many more; an evening stop stays
 * in the timeline. Arrival, move and departure days say so first.
 */
function joinAnd(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function themeFor(day: StructurePlan['days'][number], baseName: string, isFirst: boolean, isLast: boolean): string {
  const daytime = day.stops.filter((s) => s.slot === 'day').map((s) => s.candidate);
  const ranked = [...daytime].sort((a, b) => b.significance - a.significance || b.fit - a.fit || daytime.indexOf(a) - daytime.indexOf(b));
  const lead = ranked[0]?.name ?? day.stops[0]?.candidate.name ?? '';
  const second = ranked[1]?.name;
  const rest = Math.max(0, ranked.length - 1);
  const body = !lead ? '' : second && rest === 1 && `${lead} & ${second}`.length <= 38 ? `${lead} & ${second}` : rest > 0 ? `${lead} + ${rest} more` : lead;
  if (day.relocation) return clip(`On to ${baseName}${body ? ` · ${body}` : ''}`, DRAFT_SOFT_PROSE_CAPS.dayTheme);
  if (isFirst) return clip(body ? `Arrive in ${baseName} · ${body}` : `Arrive in ${baseName}`, DRAFT_SOFT_PROSE_CAPS.dayTheme);
  if (isLast) return clip(body ? `Departure · ${body} first` : 'Departure', DRAFT_SOFT_PROSE_CAPS.dayTheme);
  return clip(body || `A slower day around ${baseName}`, DRAFT_SOFT_PROSE_CAPS.dayTheme);
}

/** How a car-free move between two beds is made: a train, high-speed where the country's facts make it the backbone and the hop is long; nothing for a hop across town. */
export function carFreeMoveFor(
  from: { lat: number; lng: number } | undefined,
  to: { lat: number; lng: number } | undefined,
  countryCode: string | null | undefined,
): { how: 'rail' | 'high_speed_rail' | 'bus'; when: 'start' } | null {
  if (!from || !to) return null;
  const km = haversineKm(from, to);
  if (km <= 1.5) return null;
  if (km >= 100 && highSpeedRailBackbone(countryCode)) return { how: 'high_speed_rail', when: 'start' };
  /* A train only where the country's facts say trains run between towns; otherwise the bus that does. */
  return { how: publicTransportNetwork(countryCode).intercityRail ? 'rail' : 'bus', when: 'start' };
}

function draftFromPlan(args: {
  windows: readonly PlannerDayWindow[];
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
  /* What public transport the country has, so a car-free leg never names a train that does not run. */
  /* A metro serves cities: on a regional, rural or trail trip a short hop is a bus even where the country has a metro somewhere. */
  const countryNetwork = publicTransportNetwork(input.region.compiled.scope.countryCode);
  const cityScale = input.region.compiled.scope.breadth === 'city' || input.region.compiled.scope.breadth === 'local';
  const network = { ...countryNetwork, metro: countryNetwork.metro && cityScale };
  const days: DraftDay[] = plan.days.map((day, i) => {
    const isFirst = i === 0;
    const isLast = i === plan.days.length - 1;
    let previous = day.baseId;
    const anchors: DraftAnchor[] = day.stops.slice(0, 5).map((stop, order) => {
      const c = stop.candidate;
      const from = args.coordinates.get(previous);
      const km = from ? haversineKm(from, c.coordinates) : null;
      const transport = transportFor(input.carAvailable, args.minutes(previous, c.id), km, c.category, { ...(input.groundArrangement ? { arrangement: input.groundArrangement } : {}), ...network });
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
    /*
     * "Pack a lunch — food is thin out there" is advice for wild ground: a
     * trailhead, a lake, a scenic drive. Production pass — a 30-trip evaluation
     * printed it on a car-free Tokyo day because Ueno Zoo is outdoors and more
     * than 45 minutes by train from the base; a zoo, a park or a shrine in a
     * city has food at the gate.
     */
    const outdoorHeavy = day.stops.some((s) => WILD_GROUND.has(s.candidate.category) && s.candidate.exposure === 'outdoor' && s.candidate.intensity !== 'none' && (args.minutes(day.baseId, s.candidate.id) ?? 0) > 45);
    const early = day.stops.some((s) => s.slot === 'sunrise' || s.candidate.intensity === 'strenuous');
    const windowForDay = args.windows.find((w) => w.date === day.date);
    const lunchFits = !windowForDay || (windowForDay.startMinute <= 13 * 60 + 30 && windowForDay.endMinute >= 12 * 60);
    const lunch = !lunchFits
      ? undefined
      : day.lunchFoodArea
      ? `Lunch around ${day.lunchFoodArea.name}${day.lunchFoodArea.specialty ? ` — ${day.lunchFoodArea.specialty}` : ''}`
      : outdoorHeavy
        ? `Pack a lunch — food is thin out near ${(day.lunchNear ?? 'the trail').replace(/^near\s+/i, '')}`
        : day.lunchNear
          ? `Casual lunch in ${day.lunchNear.replace(/^near\s+/i, '')}, near the midday stop`
          : undefined;
    const weatherNote = (() => {
      /* What could not be repaired is written on the day from `package.planning.dayNotes`, in full; a draft note is too short to carry it. */
      const moved = plan.weatherMoves.filter((m) => m.chosenDate === day.date);
      const forecast = moved.length > 0 ? `Scheduled here for the better forecast: ${moved.map((m) => m.name).join(', ')}.` : day.weather && day.weather.severity >= 2 ? `The forecast says ${day.weather.label}; the backup below is close by.` : null;
      return forecast;
    })();
    const lead = day.stops.find((s) => s.slot === 'day') ?? day.stops[0];
    return {
      dayNumber: day.dayNumber,
      baseId: draftBaseId.get(day.baseId) ?? 'base-1',
      theme: themeFor(day, name, isFirst, isLast),
      intensity: day.intensity,
      ...(day.relocation ? { relocation: true } : {}),
      /*
       * A car-free move says it is a train. Without it the leg that leaves the
       * old base fell through to the reconciler's default and a live Tokyo → Kyoto
       * day printed "≈9 hr 15 min bus". High-speed only where the country's facts
       * make it the backbone and the hop is long enough to be one.
       */
      ...(day.relocation && !input.carAvailable
        ? ((move) => (move ? { move } : {}))(carFreeMoveFor(args.coordinates.get(plan.days[i - 1]?.baseId ?? ''), args.coordinates.get(day.baseId), input.region.compiled.scope.countryCode))
        : {}),
      anchors,
      meals: {
        /* On a moving day the traveller wakes where they slept last night, not where they sleep tonight. */
        ...(!isFirst && (early || day.relocation) ? { breakfast: clip(`${early ? 'Early breakfast' : 'Breakfast'} in ${day.relocation ? baseName.get(plan.days[day.dayNumber - 2]?.baseId ?? '') ?? name : name} before heading out`, DRAFT_SOFT_PROSE_CAPS.meal) } : {}),
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
    /*
     * The traveller's own picks first, then Sidequest's, then by fit. Sorting
     * by fit alone let six high-fit places a car-free trip cannot reach push a
     * hand-picked, equally unreachable stop off the end of the list — and an
     * include that is neither scheduled nor explained is the silent loss the
     * preservation rules forbid.
     */
    .sort((a, b) => OWNERSHIP_RANK[a.candidate.status] - OWNERSHIP_RANK[b.candidate.status] || b.candidate.fit - a.candidate.fit)
    .slice(0, 6)
    .map((d) => ({ name: clip(d.candidate.name, 60), reason: clip(d.detail, DRAFT_SOFT_PROSE_CAPS.omissionReason) }));
  const deliberate = (extras?.skipped ?? []).slice(0, Math.max(0, 8 - leftOut.length)).map((s) => ({ name: clip(s.name, 60), reason: clip(`Sidequest's research: ${s.reason}`, DRAFT_SOFT_PROSE_CAPS.omissionReason) }));
  const bookingLines = scheduled.filter((c) => c.booking === 'required').map((c) => `Book ${c.name} ahead — entry needs a reservation.`);
  const signatures = scheduled.filter((c) => c.status === 'must' || c.status === 'recommended').sort((a, b) => b.fit - a.fit).slice(0, 3).map((c) => clip(c.name, 60));
  const urban = !input.carAvailable || bases.length === 1 && scheduled.every((c) => (args.minutes(bases[0]!.id, c.id) ?? 0) <= 45);

  const draft = {
    archetype: archetypeFor({ bases: bases.length, carAvailable: input.carAvailable, urban }),
    /* About the trip, not about Sidequest's working: how many board places were weighed is the page's business, not the headline's. */
    purpose: clip(`${plan.days.length} days in ${input.destinationName}${topInterests.length > 0 ? `, built around ${joinAnd(topInterests)}` : ''}.`, DRAFT_SOFT_PROSE_CAPS.purpose),
    routeRationale: clip(
      bases.length > 1
        ? `${bases.map((b) => `${b.name} (${b.nights} night${b.nights === 1 ? '' : 's'})`).join(', then ')}, with each day's stops grouped around where you sleep.`
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
    driving: input.groundArrangement === 'operator' ? 'operator_transfer' : input.carAvailable ? 'rental_self_drive' : 'none',
    package: {
      foodStrategy: (extras?.package.foodStrategy ?? []).slice(0, 8).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.foodStrategy)),
      transport: (() => {
        const derived = transportStrategyFor({ plan, bases, carAvailable: input.carAvailable, maxDailyTravelMinutes: input.carAvailable && input.maxDailyDriveMinutes ? Math.min(input.maxDailyTravelMinutes, input.maxDailyDriveMinutes) : input.maxDailyTravelMinutes, minutes: args.minutes, coordinates: args.coordinates });
        if (input.groundArrangement === 'operator') {
          return {
            summary: clip('An operator’s driver-guide and vehicle run the game drives and the roads between stays; nobody needs to hire or drive a car.', DRAFT_SOFT_PROSE_CAPS.transportSummary),
            notes: ['Book the operator early: the driver-guide, the vehicle and park fees are usually one package.', ...(extras?.package.transportNotes ?? [])].slice(0, 6).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.transportNote)),
          };
        }
        return {
          summary: clip(derived.summary, DRAFT_SOFT_PROSE_CAPS.transportSummary),
          notes: [...derived.notes, ...(extras?.package.transportNotes ?? [])].slice(0, 6).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.transportNote)),
        };
      })(),
      beforeYouGo: dedupeLines([...beforeYouGoFor({ scheduled, carAvailable: input.carAvailable && input.groundArrangement !== 'operator', seasonal: args.seasonalNotes }), ...(extras?.package.beforeYouGo ?? [])]).slice(0, 10).map((line) => clip(line, DRAFT_SOFT_PROSE_CAPS.beforeYouGo)),
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
  stay?: StayDecision;
  dayRepairs: { dayNumber: number; code: string; note: string }[];
  dayNotes: { dayNumber: number; code: string; note: string }[];
  density?: TripDensity;
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
    ...(composed.stay ? { stay: composed.stay } : {}),
    ...(composed.baseSuggestion ? { baseSuggestion: composed.baseSuggestion } : {}),
    dayRepairs: composed.plan.repairs.map((r) => ({ ...r })),
    /* A discovery gap leads its day — on an empty day the first note is the one the day shows. */
    dayNotes: [...(composed.densityNotes ?? []).filter((n) => n.code === 'density_discovery_gap'), ...composed.plan.dayNotes.map((n) => ({ ...n })), ...(composed.densityNotes ?? []).filter((n) => n.code !== 'density_discovery_gap')],
    ...(composed.density ? { density: composed.density } : {}),
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

export type PlannerFallbackReason = 'insufficient_candidates' | 'insufficient_placed_candidates' | 'no_feasible_day_assignment' | 'required_user_places_unplaceable';

/**
 * Why a planner attempt cannot ship, or null when it can. A day between arrival
 * and departure left empty is the only refusal: the planner already relaxed its
 * own fit floor and frequency preferences to fill it, never the traveller's
 * limits, so what remains is a fact about the pool or the constraints.
 */
/** Under this much free time a day holds no stop, so its emptiness is not a shortage of candidates. */
const MIN_STOP_WINDOW_MINUTES = 60;

export function plannerFallbackReasonOf(composed: PlannerComposition): PlannerFallbackReason | null {
  /*
   * A day the journey itself fills — a base move that leaves no window for a
   * stop (Lisbon to the Azores) — is a travel day, not a thin board: its empty
   * stop list is the honest plan, and falling back to composition for it
   * replaced a working plan with a failed one whenever the model was away.
   */
  const interior = composed.plan.days.slice(1, -1).filter((day) => day.capacityMinutes >= MIN_STOP_WINDOW_MINUTES && !day.relocation);
  if (!interior.some((day) => day.stops.length === 0)) return null;
  if (composed.poolSize === 0) return 'insufficient_placed_candidates';
  /* Everything plannable was either scheduled or left out for a reason other than the day being full: nothing remains to put on the empty day. */
  const spare = composed.plan.dropped.filter((d) => d.reason !== 'excluded' && d.reason !== 'out_of_season' && d.reason !== 'closed' && d.reason !== 'not_workable');
  if (spare.length === 0) return 'insufficient_candidates';
  if (composed.plan.mustConflicts.length > 0 && spare.every((d) => d.candidate.status === 'must')) return 'required_user_places_unplaceable';
  return 'no_feasible_day_assignment';
}

/**
 * A THING THE TRAVELLER TYPED AS A MUST-DO THAT NOBODY COULD FIND.
 *
 * Named on the plan or named here: "Booked, fixed, or would regret missing" was
 * read by the scan as a hint and then forgotten, so a typed place that was
 * neither on the board nor matched left no trace anywhere on the finished trip
 * while the review had promised to keep it. A typed must-do is matched by name
 * against the scheduled stops and against what is already unscheduled; whatever
 * is left is listed under "Could not be scheduled" with the smallest fix.
 */
export function plannerUnplacedMustDos(mustDos: readonly string[], itinerary: Pick<Itinerary, 'days' | 'unscheduled'>): UnscheduledPlace[] {
  const pool = [
    ...itinerary.days.flatMap((day) => day.items).filter((item) => item.kind === 'activity').map((item) => ({ id: item.placeId ?? item.id, name: item.title })),
    ...itinerary.unscheduled.map((entry) => ({ id: entry.placeId, name: entry.name })),
  ];
  const out: UnscheduledPlace[] = [];
  for (const raw of mustDos) {
    const name = raw.trim();
    if (name.length === 0 || matchNamedMustDos([name], pool).length > 0) continue;
    out.push({
      placeId: `must-do:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      name,
      wasManual: true,
      reasonCode: 'selection_not_on_board',
      reason: 'You said you would regret missing this, and it is not on the plan: nothing the board found matches that name.',
      suggestedRemedy: 'Add it to a day as a stop of your own, or re-scan the board.',
    });
  }
  return out;
}

/**
 * PRODUCTION PASS — THE TRAVELLER'S PICKS THE PLANNER COULD NOT PLACE, AS UNSCHEDULED PLACES.
 *
 * The reconciler builds `itinerary.unscheduled` from the draft's anchors, and
 * the planner never makes an anchor of a pick it cannot place (a car-free trip
 * and a trailhead only a car reaches), so on the planner path such a pick
 * reached the draft's `unresolved` prose and nowhere a traveller acts on — the
 * "Could not be scheduled" list, with its "Change how you are getting around"
 * remedy, stayed empty. Every include either appears on a day or appears here.
 */
export function plannerUnscheduledPicks(composition: Pick<PlannerComposition, 'plan'>): UnscheduledPlace[] {
  const byId = new Map(composition.plan.dropped.map((d) => [d.candidate.id, d.candidate]));
  return composition.plan.mustConflicts.map((conflict) => {
    const candidate = byId.get(conflict.candidateId);
    const reasonCode = unscheduledCodeFor(conflict.reason, candidate?.blockedCode);
    const transport = reasonCode === 'transport_mode_unavailable';
    return {
      placeId: conflict.candidateId,
      name: conflict.name,
      wasManual: true,
      reasonCode,
      reason: conflict.reason === 'not_workable' ? `You chose this, but it is not workable on this trip as you are travelling: ${conflict.detail}` : `You chose this, and it did not fit: ${conflict.detail}`,
      suggestedRemedy: transport ? 'Change how you are getting around, or what is on the board, and build again.' : 'Change the dates or what is on the board, and build again.',
    };
  });
}

function unscheduledCodeFor(reason: DropReason, blockedCode: string | undefined): UnscheduledReasonCode {
  if (reason === 'not_workable') {
    switch (blockedCode) {
      case 'needs_car':
      case 'mode_declined':
        return 'transport_mode_unavailable';
      case 'service_unavailable':
        return 'service_not_operating';
      case 'closed_on_your_dates':
        return 'closed_on_trip_dates';
      case 'no_open_hours':
        return 'hours_do_not_fit';
      case 'exceeds_daily_travel':
        return 'exceeds_daily_travel';
      case 'too_strenuous':
      case 'mobility':
        return 'exceeds_intensity';
      case 'no_way_in':
        return 'access_unavailable';
      default:
        return 'not_feasible';
    }
  }
  switch (reason) {
    case 'out_of_season':
      return 'seasonally_closed';
    case 'closed':
      return 'closed_on_trip_dates';
    case 'too_strenuous':
      return 'exceeds_intensity';
    case 'too_far':
      return 'exceeds_daily_travel';
    case 'frequency':
      return 'frequency_reached';
    case 'weather':
      return 'weather_incompatible';
    default:
      return 'no_time_left';
  }
}
