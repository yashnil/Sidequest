import {
  countTripDays,
  FEATURE_TYPE_BREADTH,
  FEATURE_TYPE_ENTITY,
  interestOffer,
  screenDestination,
  tripMonths,
  type CompiledRegion,
  type DestinationClassSignal,
  type DestinationIndexEntry,
  type DestinationQuestionContext,
  type Interest,
  type InterviewContext,
  type QuestionnaireAnswers,
  type Region,
  type ScreeningSignals,
  type Trip,
  type TripComposerAnswers,
} from '@sidequest/core';
import type { TripIntentRecord } from '@/lib/db/compiler-repository';
import type { RegionContext } from '@/lib/region';
import { buildTravelReality, withTravelReality, type TravelReality } from '@sidequest/core';
import { capability } from '@/lib/providers/registry';

/**
 * DESTINATION SCREENING FOR ONE TRIP — FROM WHAT IS ALREADY ON DISK.
 *
 * The questionnaire renders before any research runs for most trips, so the
 * screening has to work from what the intake already stored: the destination
 * the traveller pointed at (or the resolver's leading candidate), the
 * geographic scope when one was confirmed, the preflight's climate normals,
 * the compiled region when a build has finished, and the seeded region for an
 * authored destination. Every one of those is a synchronous read of stored
 * state; nothing here reaches a provider, and the whole function is bounded
 * by how fast `screenDestination` runs (microseconds).
 *
 * Unavailable evidence lowers `evidence` on the result and hides traits; it
 * never blocks the questionnaire.
 */

export interface ScreeningInputs {
  trip: Trip;
  intent: TripIntentRecord | null;
  region: RegionContext | null;
  /** The authored region when the trip is against one (the seeded Eastern Sierra today). */
  seeded?: Region | null;
  /**
   * DESTINATION-AWARE INTERVIEW GLOBALITY — the destination index row behind a
   * composer pick, when the page could read it. The pick itself carries only a
   * feature type and a centre; the row carries the population, extent and
   * prominence that tell a seven-million-person city from a village. Read by
   * the page (one synchronous SQLite lookup), never fetched here.
   */
  indexEntry?: DestinationIndexEntry | null;
}

export function screeningSignalsFor(input: ScreeningInputs): ScreeningSignals {
  const { trip, intent, region } = input;
  const tripDays = countTripDays(trip.basics.startDate, trip.basics.endDate);
  const composer = intent?.composer ?? null;
  const selected = intent?.selectedDestination ?? null;
  const candidate = intent?.resolution
    ? (intent.resolution.candidates.find((c) => c.id === (intent.selectedCandidateId ?? intent.resolution?.unambiguousCandidateId)) ?? intent.resolution.candidates[0] ?? null)
    : null;
  const scope = intent?.scope ?? null;
  const compiled = region?.compiled ?? null;

  const signals: ScreeningSignals = {
    name: selected?.displayName ?? candidate?.displayName ?? region?.region.baseName ?? trip.basics.destinationInput,
    tripDays,
    startDate: trip.basics.startDate,
    months: tripMonths(trip.basics.startDate, trip.basics.endDate),
    travelerNeeds: trip.basics.travelerNeeds,
    adults: trip.basics.adults,
    children: trip.basics.children,
  };
  const seededCopy = input.seeded?.questionnaireCopy ?? region?.region.questionnaireCopy;
  if (seededCopy?.proseName) signals.proseName = seededCopy.proseName;

  // --- identity -----------------------------------------------------------------
  // The composer's pick is an identity too: a city chosen from the destination
  // index used to reach the screening as nothing but a name, which is how a
  // seven-million-person city was interviewed about hot springs and hire cars.
  const pickedEntity = selected ? FEATURE_TYPE_ENTITY[selected.featureType] : undefined;
  const pickedBreadth = selected ? FEATURE_TYPE_BREADTH[selected.featureType] : undefined;
  const entityType = scope?.destinationEntityType ?? candidate?.entityType ?? (pickedEntity && pickedEntity !== 'unknown' ? pickedEntity : undefined);
  if (entityType) signals.entityType = entityType;
  const breadth = scope?.breadth ?? candidate?.breadth ?? (pickedEntity && pickedEntity !== 'unknown' ? pickedBreadth : undefined);
  if (breadth) signals.breadth = breadth;
  if (selected?.featureType) signals.featureType = selected.featureType;
  const countryCode = scope?.countryCode ?? candidate?.countryCode ?? selected?.countryCode;
  if (countryCode) signals.countryCode = countryCode;
  const center = scope?.center ?? candidate?.center ?? selected?.center ?? region?.region.baseCoordinates;
  if (center) signals.center = center;
  const entry = input.indexEntry && selected && input.indexEntry.id === selected.entryId ? input.indexEntry : null;
  const bounds = scope?.administrativeBoundary ?? scope?.bounds ?? candidate?.bounds ?? selected?.bounds ?? entry?.bounds;
  if (bounds) signals.bounds = bounds;
  if (entry?.population !== undefined) signals.population = entry.population;
  if (entry?.prominence !== undefined) signals.prominence = entry.prominence;

  // --- the scope's own transport reading ----------------------------------------------
  if (scope) {
    signals.scopeTransport = {
      primaryMode: scope.transport.primaryMode,
      allowedModes: scope.transport.allowedModes,
      carAvailable: scope.transport.carAvailable,
      acceptsWaterOrAirTransfers: scope.transport.acceptsWaterOrAirTransfers,
      basis: scope.transport.basis,
    };
    signals.gatewayKinds = scope.gateways.map((gateway) => gateway.kind);
    signals.maxBaseChanges = scope.maxBaseChanges;
  }
  if (composer?.shape) signals.composerShape = composer.shape;
  if (composer?.transport) signals.composerTransport = composer.transport;

  // --- V7 §2: the intent graph — several countries, a described part of one, a landscape ------------
  const graph = intent?.destinationIntent?.graph ?? null;
  if (graph) {
    if (graph.countries.length > 0) signals.countries = [...graph.countries];
    if (!signals.countryCode && graph.countries.length === 1) signals.countryCode = graph.countries[0]!;
    signals.intent = { parts: graph.children.length, crossBorder: graph.crossBorder, kinds: graph.children.map((c) => c.kind), relationship: graph.relationship };
    if (!signals.center && graph.envelope) signals.center = graph.envelope.center;
    if (!signals.bounds && graph.envelope?.bounds) signals.bounds = graph.envelope.bounds;
  }
  /* --- V8.1: the semantic reading — what kind of thing, at what scale, from the gate ------------- */
  const semantics = intent?.destinationIntent?.semantics ?? null;
  if (semantics) {
    const landscape = semantics.landscape ?? graph?.children.find((c) => c.landscape)?.landscape;
    signals.semantic = { type: semantics.type, scale: semantics.scale, ...(landscape ? { landscape } : {}), ...(semantics.extent ? { extentSource: semantics.extent.source } : {}), gateways: semantics.gateways.length };
    if (!signals.center && semantics.center) signals.center = semantics.center;
    if (!signals.bounds && semantics.extent) signals.bounds = semantics.extent.bounds;
    if (semantics.countries.length > 0) signals.countries = [...new Set([...(signals.countries ?? []), ...semantics.countries])];
    if (!signals.countryCode && semantics.countries.length === 1) signals.countryCode = semantics.countries[0]!;
    /* A concept the gate read as a landscape is one, whatever a same-named row was typed as. */
    if (semantics.type === 'mountain_region' || semantics.type === 'natural_region' || semantics.type === 'coast') {
      signals.entityType = 'natural_region';
      if (!signals.breadth || signals.breadth === 'local' || signals.breadth === 'city') signals.breadth = semantics.scale === 'continental' || semantics.scale === 'country' ? 'country' : semantics.scale === 'region' || semantics.scale === 'subregion' ? 'region' : 'subregion';
    }
  }

  // --- climate for the dates, from the preflight when it looked ------------------------
  const climate = climateFor(intent?.preflight?.dates ?? null, trip.basics.startDate);
  if (climate) signals.climate = climate;

  // --- what a compiled region measured ---------------------------------------------------
  if (compiled && region) {
    signals.compiled = compiledSignals(compiled, region);
  } else if (input.seeded) {
    signals.seededClass = seededClassOf(input.seeded, region);
  }
  if (region && !signals.compiled) {
    const offer = region.region.interestOffer ?? interestOffer({ places: region.places });
    if (offer.classes.length > 0) signals.offerClasses = offer.classes as DestinationClassSignal[];
  }
  return signals;
}

function climateFor(dates: NonNullable<TripIntentRecord['preflight']>['dates'] | null, startDate: string): { high?: number; low?: number } | undefined {
  if (!dates || dates.kind !== 'recommended') return undefined;
  const month = Number(startDate.slice(5, 7));
  const window = dates.windows.find((w) => w.month === month) ?? dates.windows[0];
  if (!window) return undefined;
  return { high: window.climate.temperature.high, low: window.climate.temperature.low };
}

const NON_DRIVE = new Set(['walk', 'public_bus', 'rail', 'shuttle', 'ferry', 'bicycle']);

function compiledSignals(compiled: CompiledRegion, region: RegionContext): NonNullable<ScreeningSignals['compiled']> {
  const places = region.places;
  let carOnly = 0;
  const ferryPlaces = new Set<string>();
  for (const place of places) {
    const modes = region.access.rules.filter((rule) => rule.placeIds.includes(place.id)).map((rule) => rule.approachMode);
    if (modes.length > 0 && modes.every((mode) => !NON_DRIVE.has(mode))) carOnly += 1;
    if (modes.includes('ferry')) ferryPlaces.add(place.id);
  }
  const offer = region.region.interestOffer ?? interestOffer({ places, foodVenueCount: region.food?.venues.length ?? 0 });
  const maxElevation = Math.max(0, ...region.weather.locations.map((location) => location.elevationMetres));
  const furthest = Math.max(0, ...places.map((place) => (place.travelFromBase.measured ? place.travelFromBase.driveMinutes : 0)));
  return {
    placeCount: places.length,
    ...(places.length > 0 ? { carOnlyShare: Math.round((carOnly / places.length) * 100) / 100 } : {}),
    ferryPlaces: ferryPlaces.size,
    transitMeasured: compiled.transitEvidence?.measured ?? 0,
    hasScheduledNetwork: region.scheduledNetwork !== null,
    matrixMode: compiled.travelTimes.mode,
    classes: offer.classes as DestinationClassSignal[],
    subregionCount: compiled.subregions.length,
    baseCount: compiled.bases.length,
    foodVenueCount: region.food?.venues.length ?? 0,
    ...(maxElevation > 0 ? { maxElevationMetres: maxElevation } : {}),
    ...(furthest > 0 ? { furthestSatelliteMinutes: furthest } : {}),
  };
}

function seededClassOf(seeded: Region, region: RegionContext | null): DestinationClassSignal {
  const offer = seeded.interestOffer ?? (region ? interestOffer({ places: region.places }) : null);
  const classes = (offer?.classes ?? []) as DestinationClassSignal[];
  if (classes.includes('mountain')) return 'mountain';
  if (classes.includes('urban')) return 'urban';
  if (classes.includes('coastal')) return 'coastal';
  return 'countryside';
}

export function destinationContextFor(input: ScreeningInputs, extra: { party?: InterviewContext['traveller']['party']; willDrive?: boolean } = {}): DestinationQuestionContext {
  const signals = screeningSignalsFor(input);
  const screened = screenDestination(signals);
  return withTravelReality(screened, travelRealityFor({ signals, screened, intent: input.intent, ...extra }));
}

/**
 * V7 §3 — THE REALITY FOR THIS TRIP, FROM WHAT IS ALREADY ON DISK.
 *
 * Countries from the intent graph (or the resolved candidate), the screening's
 * traits, the party's drivers, what this deployment can measure. A pure
 * function; the same inputs on the questionnaire page and in the build give
 * the same reality, which is what lets the interview's promise and the plan's
 * transport agree.
 */
export function travelRealityFor(input: { signals: ScreeningSignals; screened: DestinationQuestionContext; intent: TripIntentRecord | null; party?: InterviewContext['traveller']['party']; willDrive?: boolean }): TravelReality {
  const graph = input.intent?.destinationIntent?.graph ?? null;
  const countries = graph?.countries.length ? graph.countries : input.signals.countryCode ? [input.signals.countryCode] : [];
  return buildTravelReality({
    label: input.screened.name,
    countries,
    crossBorder: graph?.crossBorder ?? countries.length > 1,
    ...(input.signals.entityType ? { entityType: input.signals.entityType } : {}),
    traits: input.screened.traits,
    ...(graph ? { intentKinds: graph.children.map((c) => c.kind) } : {}),
    tripDays: input.signals.tripDays,
    ...(input.party ? { party: { size: input.party.members, drivers: input.party.drivers } } : {}),
    capabilities: { roadRouting: Boolean(capability('routing.drive')?.configured), transit: Boolean(capability('routing.transit')?.configured) },
    ...(input.willDrive !== undefined ? { willDrive: input.willDrive } : {}),
  });
}

/** The composer fields the interview treats as already answered, by question field name. */
export function carriedFieldsFor(composer: TripComposerAnswers | null, carried: readonly string[]): string[] {
  const fields = new Set<string>(carried);
  if (composer?.shape && composer.shape !== 'undecided') fields.add('shape');
  if (composer?.foodImportance) fields.add('foodImportance');
  if (composer?.freeTime) fields.add('freeTime');
  return [...fields];
}

export function interviewContextFor(input: ScreeningInputs & { offeredInterests: readonly Interest[]; carried: readonly string[]; answers?: QuestionnaireAnswers; party?: InterviewContext['traveller']['party'] }): InterviewContext {
  const composer = input.intent?.composer ?? null;
  return {
    destination: destinationContextFor(input, { ...(input.party ? { party: input.party } : {}), ...(input.answers?.provenance.transport_mode?.source === 'explicit' ? { willDrive: input.answers.willDrive } : {}) }),
    traveller: {
      ...(input.party ? { party: input.party } : {}),
      travelerNeeds: input.trip.basics.travelerNeeds,
      tripDays: countTripDays(input.trip.basics.startDate, input.trip.basics.endDate),
      adults: input.trip.basics.adults,
      children: input.trip.basics.children,
      offeredInterests: input.offeredInterests,
      ...(composer?.themes && composer.themes.length > 0 ? { composerThemes: composer.themes } : {}),
      carried: carriedFieldsFor(composer, input.carried),
      composerNamedPlaces: Boolean(composer?.mustDo || composer?.avoid),
    },
  };
}


/**
 * V7 §3 — the reality for a trip, from the same inputs the questionnaire page
 * reads, for the build. One function, two callers, one answer.
 */
export function realityForTrip(input: ScreeningInputs & { party?: InterviewContext['traveller']['party']; willDrive?: boolean }): TravelReality {
  const signals = screeningSignalsFor(input);
  const screened = screenDestination(signals);
  return travelRealityFor({ signals, screened, intent: input.intent, ...(input.party ? { party: input.party } : {}), ...(input.willDrive !== undefined ? { willDrive: input.willDrive } : {}) });
}
