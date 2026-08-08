import 'server-only';
import {
  benchmarkPlanSchema,
  BENCHMARK_PLAN_VERSION,
  type BenchmarkPlan,
  type EvidenceRef,
  type PlaceRef,
  type PlanBlock,
  type PlanDay,
} from '@sidequest/bench';
import type {
  CompiledRegion,
  Itinerary,
  ItineraryDay,
  ItineraryItem,
  FoodStopKind,
  FoodVenue,
  Place,
  PlannerReadiness,
  TransportMode,
  TravelSegment,
} from '@sidequest/core';
import { saveNativeArtifact } from '../../db/benchmark-repository';

import type { SidequestFailureKind } from './drive';

/**
 * THE PLAN, IN A SHAPE THAT DOES NOT KNOW WHO MADE IT.
 *
 * The conversion is lossy on purpose. Sidequest's `Itinerary` carries evidence
 * blocks, provenance kinds, revision histories and validation codes that the
 * other arm has never heard of, and a neutral schema shaped around those would
 * grade the second system on agreement with the first. So what crosses is what a
 * traveller could act on: where you are, when, how you got there, what it costs
 * in time, and what the plan is unsure about.
 *
 * Three rules hold throughout.
 *
 * **A number nobody measured is `unknown`.** The travel provenance mapping is
 * the load-bearing one and it is deliberately unkind to this arm: `modelled` and
 * `estimated` both become `unknown`, because the neutral vocabulary has no
 * bucket for a figure derived from a road model, and dressing one as `measured`
 * would be exactly the claim the validators exist to catch. Sidequest keeps the
 * distinction internally and loses the credit for it here, which is correct — a
 * competitor cannot be asked to accept a third category invented by its rival.
 *
 * **A failed run still produces a plan row.** With `generationState: 'failed'`,
 * whatever days it managed, and one neutral sentence. A benchmark that dropped
 * its failures would report a hundred per cent success for whichever system fell
 * over most often.
 *
 * **Nothing in the output names the system.** Not the failure detail, not a
 * warning, not a source title. The blind review is only blind if the words are.
 */

export interface ConversionContext {
  planId: string;
  requestId: string;
  /** The artifact the plan was built against. The only place ids come from. */
  compiled: CompiledRegion | null;
  /** What the traveller typed, for the destination reference. */
  destinationName: string;
  generationState: BenchmarkPlan['generationState'];
  failureKind: SidequestFailureKind | null;
  failureDetail: string | null;
  /** Dates to state when there is no plan to read them from. */
  startDate: string;
  endDate: string;
}

/**
 * How a transport mode reads in the neutral vocabulary.
 *
 * `private_transfer` and `rideshare` both become `taxi`: the neutral list has
 * one word for "somebody else drives, and you paid them", and inventing a
 * distinction the other arm cannot express would make a phrasing difference look
 * like a planning difference. `unsupported` is `unknown` rather than dropped,
 * because "we do not model this leg" is a fact worth showing a reviewer.
 */
type NeutralTravelMode = NonNullable<PlanBlock['travel']>['mode'];

const TRAVEL_MODE: Record<TransportMode, NeutralTravelMode> = {
  drive: 'drive',
  walk: 'walk',
  shuttle: 'shuttle',
  public_bus: 'bus',
  rail: 'rail',
  ferry: 'ferry',
  rideshare: 'taxi',
  private_transfer: 'taxi',
  bicycle: 'bicycle',
  unsupported: 'unknown',
};

/**
 * Where a stated travel time came from.
 *
 * The neutral schema has three buckets and this pipeline has four. `official`
 * means a published timetable and says so; `measured` means a routing engine
 * answered; and both of the remaining two mean nobody measured this pair, which
 * is one fact and gets one word.
 */
const TRAVEL_PROVENANCE: Record<
  TravelSegment['provenance'],
  'measured' | 'published_timetable' | 'unknown'
> = {
  measured: 'measured',
  official: 'published_timetable',
  modelled: 'unknown',
  estimated: 'unknown',
};

const MEAL_STOP_KIND: Record<FoodStopKind, 'venue' | 'grocery' | 'packed' | 'unstated'> = {
  venue: 'venue',
  grocery: 'grocery',
  packed: 'packed',
  unplanned: 'unstated',
};

export function toBenchmarkPlan(
  itinerary: Itinerary | null,
  readiness: PlannerReadiness | null,
  context: ConversionContext,
): BenchmarkPlan {
  const places = placeIndex(context.compiled);
  const sources = new SourceLedger();

  const days = (itinerary?.days ?? []).map((day) => toDay(day, places, sources));

  const plan: BenchmarkPlan = {
    schemaVersion: BENCHMARK_PLAN_VERSION,
    planId: context.planId,
    requestId: context.requestId,
    producedBy: 'sidequest',
    generationState: context.generationState,
    failureKind: context.failureKind,
    failureDetail: context.failureDetail,

    summary: itinerary?.summary ?? '',
    destination: destinationRef(context, itinerary, places),
    scopeNote: scopeNote(itinerary, context.compiled),
    startDate: itinerary?.startDate ?? context.startDate,
    endDate: itinerary?.endDate ?? context.endDate,

    bases: toBases(itinerary, context.compiled, places),
    days,

    /*
     * The planner's own account of what it did not schedule, marked as swept up.
     *
     * `unscheduled` is a real artifact and its reasons are the planner's — but it
     * is exhaustive, up to sixty entries, and the other arm's list is only what
     * its model chose to write down. A must-do appearing here is graded as
     * deferred-with-a-reason rather than ignored, so the two arms were graded
     * differently on how a list gets populated. `derived` says which kind of list
     * this is; see the field's note on the plan schema.
     */
    exclusions: (itinerary?.unscheduled ?? []).slice(0, 60).map((entry) => ({
      place: refFor(entry.placeId, entry.name, places),
      reason: clip(entry.suggestedRemedy ? `${entry.reason} ${entry.suggestedRemedy}` : entry.reason, 500),
      derived: true,
    })),
    unknowns: toUnknowns(readiness, context.compiled, itinerary),
    preparation: toPreparation(itinerary),
    warnings: toWarnings(itinerary),
    sources: sources.entries(),
  };

  // Parsed rather than trusted. A plan that will not satisfy the neutral schema
  // is a conversion defect, and finding it here — rather than at the moment a
  // reviewer opens a session — is the whole value of validating at the boundary.
  return benchmarkPlanSchema.parse(plan);
}

/**
 * Keep the native artifact beside the converted one.
 *
 * The conversion above is lossy by design, and somebody will eventually want to
 * know whether a defect was in the plan or in the translation of it. Stored
 * unchanged, never rendered before the reveal: the shape alone would identify
 * the system.
 */
export function preserveNativeItinerary(input: {
  runId: string;
  planId: string | null;
  itinerary: Itinerary;
  now: Date;
}): void {
  saveNativeArtifact({
    runId: input.runId,
    planId: input.planId,
    kind: 'itinerary',
    payload: input.itinerary,
    now: input.now,
  });
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * THE SHARED IDENTITY, AND WHY IT IS THE SOURCE ELEMENT.
 *
 * Both arms draw from the same open inventory, so a stop has to be addressed by
 * something both can produce. That is the source database's own identifier —
 * `node/240109189` — which every compiled place retains on `source.element`.
 *
 * Not the compiled place id: that is minted by this pipeline, and a validator
 * resolving it would be resolving something only one competitor could ever say,
 * which would hand this arm ground-truth coverage the other could not reach.
 *
 * `null` where the inventory linked nothing. The neutral checks score that as
 * `unknown`, which is exactly right — inventing an id would be worse than
 * admitting the gap.
 */
export function entityIdFor(place: Place | undefined): string | null {
  return place?.source.element?.elementId ?? null;
}

interface PlaceIndex {
  byId: Map<string, Place>;
  /**
   * The region's food venues, by their compiled id.
   *
   * Here for the same reason `byId` is: a meal has to be addressable by something
   * both arms can produce, and a food venue carries the same `source.element` a
   * place does. Without it every meal this arm scheduled converted to
   * `entityId: null`, and two *critical* checks — whether the venue is open that
   * day, and whether it can meet a declared dietary need — were structurally
   * undecidable for one arm and decidable for the other. That is a defect in a
   * converter reported as a defect in a planner.
   */
  venueById: Map<string, FoodVenue>;
}

function placeIndex(compiled: CompiledRegion | null): PlaceIndex {
  return {
    byId: new Map((compiled?.places ?? []).map((place) => [place.id, place])),
    venueById: new Map((compiled?.food?.venues ?? []).map((venue) => [venue.id, venue])),
  };
}

/**
 * A meal's venue, addressed by the source element both arms share.
 *
 * `null` where the region linked nothing, exactly as `refFor` does for places:
 * inventing an id would be worse than admitting the gap, and the neutral checks
 * score an admitted gap as `unknown`.
 */
function venueRefFor(
  food: { venueId?: string; venueName?: string },
  places: PlaceIndex,
): PlaceRef | null {
  if (!food.venueName) return null;
  const venue = food.venueId ? places.venueById.get(food.venueId) : undefined;
  return {
    entityId: venue?.source.element?.elementId ?? null,
    name: food.venueName,
    latitude: venue?.coordinates.lat ?? null,
    longitude: venue?.coordinates.lng ?? null,
  };
}

function refFor(id: string | undefined, name: string, places: PlaceIndex): PlaceRef {
  const place = id ? places.byId.get(id) : undefined;
  return {
    entityId: entityIdFor(place),
    name,
    latitude: place?.coordinates.lat ?? null,
    longitude: place?.coordinates.lng ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Days and blocks
 * ------------------------------------------------------------------ */

function toDay(day: ItineraryDay, places: PlaceIndex, sources: SourceLedger): PlanDay {
  return {
    dayNumber: day.dayNumber,
    date: day.date,
    baseId: day.baseId,
    theme: clip(day.theme, 200),
    blocks: day.items.slice(0, 60).map((item) => toBlock(item, places, sources)),
    statedTotals: {
      travelMinutes: day.totals.travelMinutes,
      driveMinutes: day.totals.driveMinutes,
      freeMinutes: day.totals.freeMinutes,
      /*
       * The planner summed these from the same items that become these blocks,
       * so they agree with the timeline by construction. Marked, so the shared
       * check reports it as unknown rather than as a pass this arm cannot fail.
       */
      derived: true,
    },
    /*
     * Backups are alternatives and never blocks. They consume none of the day's
     * capacity and are not scheduled, and a converter that folded them into the
     * timeline would turn an honest contingency into an overfull day.
     */
    alternatives: day.weather.backups.slice(0, 10).map((backup) => ({
      place: refFor(backup.placeId, backup.name, places),
      trigger: clip(backup.trigger, 300),
      why: clip(backup.why, 500),
    })),
    warnings: [...day.warnings, ...day.weather.cautions, ...day.availability.cautions]
      .slice(0, 20)
      .map((entry) => clip(entry, 500)),
  };
}

function toBlock(item: ItineraryItem, places: PlaceIndex, sources: SourceLedger): PlanBlock {
  const evidence: EvidenceRef[] = [];
  const opening = item.hours
    ? {
        openMinute: item.hours.openMinute,
        closeMinute: item.hours.closeMinute,
        ...(item.hours.lastAdmissionMinute === undefined
          ? {}
          : { lastAdmissionMinute: item.hours.lastAdmissionMinute }),
        ...(item.hours.sourceUrl
          ? {
              evidence: sources.refFor(item.hours.sourceUrl, item.hours.sourceName, {
                factPath: 'opening',
                statedValue: `${item.hours.openMinute}-${item.hours.closeMinute}`,
              }),
            }
          : {}),
      }
    : null;
  if (opening?.evidence) evidence.push(opening.evidence);

  return {
    kind: blockKindFor(item),
    title: clip(item.title, 300),
    startMinute: item.startMinute,
    endMinute: item.endMinute,
    place: item.placeId ? refFor(item.placeId, item.title, places) : null,
    travel: item.travel
      ? {
          mode: TRAVEL_MODE[item.travel.mode],
          from: refFor(item.travel.fromId, item.travel.fromName, places),
          to: refFor(item.travel.toId, item.travel.toName, places),
          minutes: item.travel.minutes,
          km: item.travel.km,
          provenance: TRAVEL_PROVENANCE[item.travel.provenance],
        }
      : null,
    meal: item.food
      ? {
          slot: item.food.slot,
          stopKind: MEAL_STOP_KIND[item.food.stopKind],
          venue: venueRefFor(item.food, places),
          detourMinutes: item.food.detourMinutes,
        }
      : null,
    opening,
    note: clip(item.note ? `${item.reason} ${item.note}` : item.reason, 1500),
    /*
     * What the plan itself says it is unsure about, kept apart from the note.
     * A reviewer reads an admitted doubt very differently from a reason, and the
     * validators score the two differently too.
     */
    uncertainty: [item.verifyBeforeTravel, item.accessWarning, item.seasonalNote]
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 10)
      .map((entry) => clip(entry, 300)),
    evidence,
  };
}

/**
 * Which of the six neutral kinds a timeline item is.
 *
 * The one interesting case is a transfer: Sidequest calls it a travel item with
 * `role: 'transfer'`, meaning the leg that moves the traveller and their luggage
 * between bases. That is a different thing from driving to a trailhead — it
 * takes a day rather than an hour, and a reviewer comparing two plans needs to
 * see which one committed to one.
 */
function blockKindFor(item: ItineraryItem): PlanBlock['kind'] {
  if (item.kind === 'travel') return item.travel?.role === 'transfer' ? 'transfer' : 'travel';
  return item.kind;
}

/* ------------------------------------------------------------------ *
 * Bases, scope, and the trip-level lists
 * ------------------------------------------------------------------ */

function toBases(
  itinerary: Itinerary | null,
  compiled: CompiledRegion | null,
  places: PlaceIndex,
): BenchmarkPlan['bases'] {
  const portfolio = compiled?.basePortfolio;
  if (portfolio && portfolio.bases.length > 0) {
    return portfolio.bases.slice(0, 20).map((base) => ({
      id: base.baseId,
      place: baseRef(base.baseId, base.baseName, compiled, places),
      nights: base.nights,
      fromDate: base.fromDate,
      toDate: base.toDate,
      why: '',
    }));
  }
  if (!itinerary) return [];

  /*
   * One base, and the nights counted from the days that actually used it rather
   * than from the trip length. A plan whose last day is a departure has not
   * bought a night for it, and stating otherwise would be a claim about a hotel
   * bill nobody made.
   */
  const nights = new Set(itinerary.days.filter((day) => day.baseId === itinerary.baseId).map((day) => day.date))
    .size;
  return [
    {
      id: itinerary.baseId,
      place: baseRef(itinerary.baseId, itinerary.baseName, compiled, places),
      nights: Math.max(0, nights - 1),
      fromDate: itinerary.startDate,
      toDate: itinerary.endDate,
      why: '',
    },
  ];
}

/**
 * A base is addressed by its own routing node, which is not a place in the
 * inventory — so it resolves to a source element only where the region also
 * holds a place with that id. Where it does not, the reference carries the
 * coordinates the artifact does hold and a null identity.
 */
function baseRef(
  baseId: string,
  name: string,
  compiled: CompiledRegion | null,
  places: PlaceIndex,
): PlaceRef {
  const direct = places.byId.get(baseId);
  if (direct) return refFor(baseId, name, places);
  const candidate = compiled?.bases.find((base) => base.id === baseId || base.routingId === baseId);
  return {
    entityId: null,
    name,
    latitude: candidate?.coordinates.lat ?? null,
    longitude: candidate?.coordinates.lng ?? null,
  };
}

function destinationRef(
  context: ConversionContext,
  itinerary: Itinerary | null,
  places: PlaceIndex,
): PlaceRef {
  if (itinerary) return baseRef(itinerary.baseId, itinerary.baseName, context.compiled, places);
  const primary = context.compiled?.bases.find((base) => base.id === context.compiled?.primaryBaseId);
  return {
    entityId: null,
    name: context.destinationName,
    latitude: primary?.coordinates.lat ?? null,
    longitude: primary?.coordinates.lng ?? null,
  };
}

/** How wide the plan understood the destination to be, in its own words. */
function scopeNote(itinerary: Itinerary | null, compiled: CompiledRegion | null): string {
  const rationale = compiled?.basePortfolio?.rationale ?? '';
  const region = itinerary ? `Planned around ${itinerary.baseName}.` : '';
  return clip([region, rationale].filter(Boolean).join(' '), 1000);
}

/**
 * What the plan says it does not know.
 *
 * Read from the readiness account and the artifact's coverage rather than
 * composed here, because both already count these things and a second count on
 * the way to a reviewer is a second thing that can disagree with the first. A
 * populated list is a good sign and is meant to be.
 */
function toUnknowns(
  readiness: PlannerReadiness | null,
  compiled: CompiledRegion | null,
  itinerary: Itinerary | null,
): string[] {
  const unknowns: string[] = [];
  const unresolved = readiness?.unresolved;
  if (unresolved) {
    if (unresolved.routePairs > 0) {
      unknowns.push(
        `${unresolved.routePairs} pairs of stops have no measured travel time between them.`,
      );
    }
    if (unresolved.criticalHours > 0) {
      unknowns.push(`${unresolved.criticalHours} chosen places publish no opening hours.`);
    }
    if (unresolved.accessRequirements > 0) {
      unknowns.push(`${unresolved.accessRequirements} chosen places have no established way in.`);
    }
    if (unresolved.blockingClosures > 0) {
      unknowns.push(
        `${unresolved.blockingClosures} closures overlap these dates and remove a place outright.`,
      );
    }
    if (unresolved.exhaustedBudgets.length > 0) {
      unknowns.push('Some research ran out of budget before every question had been answered.');
    }
  }

  for (const dimension of compiled?.coverage.dimensions ?? []) {
    if (dimension.level === 'unavailable' || dimension.level === 'weak') {
      unknowns.push(clip(dimension.detail, 500));
    }
  }

  if (itinerary?.diagnostics.weatherEvidence.includes('unavailable')) {
    unknowns.push('No forecast could be obtained for at least one day of this trip.');
  }

  return dedupe(unknowns).slice(0, 60);
}

function toPreparation(itinerary: Itinerary | null): string[] {
  if (!itinerary) return [];
  const preparation: string[] = [];
  for (const day of itinerary.days) {
    for (const booking of day.availability.bookings) {
      preparation.push(`${booking.name}: ${booking.note ?? 'needs arranging before you travel'}.`);
    }
  }
  for (const day of itinerary.days) {
    for (const reservation of day.food.reservations) {
      preparation.push(`${reservation.venueName}: ${reservation.note ?? 'book ahead'}.`);
    }
  }
  preparation.push(...itinerary.transportStrategy.verifyBeforeTravel);
  return dedupe(preparation.map((entry) => clip(entry, 500))).slice(0, 60);
}

function toWarnings(itinerary: Itinerary | null): string[] {
  if (!itinerary) return [];
  return dedupe(
    itinerary.issues
      .filter((issue) => issue.severity !== 'info')
      .map((issue) => clip(issue.message, 500)),
  ).slice(0, 60);
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

/**
 * The plan's own source list, addressed by index.
 *
 * An integer rather than a URL on each claim, and that is a security property
 * rather than a convenience: the competing arm can emit any string it likes, and
 * a string that lands in an `href` is a string an attacker chose. Every URL in
 * here came off a compiled artifact, which came off the provider layer.
 */
class SourceLedger {
  private readonly rows: { host: string; title?: string; url?: string }[] = [];
  private readonly byUrl = new Map<string, number>();

  refFor(
    url: string,
    title: string,
    fact: { factPath: string; statedValue: string },
  ): EvidenceRef {
    const existing = this.byUrl.get(url);
    if (existing !== undefined) {
      return { sourceIndex: existing, factPath: fact.factPath, statedValue: fact.statedValue };
    }
    const index = this.rows.length;
    this.rows.push({ host: hostOf(url), title: clip(title, 200), url });
    this.byUrl.set(url, index);
    return { sourceIndex: index, factPath: fact.factPath, statedValue: fact.statedValue };
  }

  entries(): BenchmarkPlan['sources'] {
    return this.rows.slice(0, 200);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
