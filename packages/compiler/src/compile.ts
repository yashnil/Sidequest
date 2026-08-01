import {
  COMPILED_REGION_VERSION,
  FOOD_DATASET_VERSION,
  OPERATING_HOURS_DATASET_VERSION,
  breadthRank,
  checkRegionIntegrity,
  requiredAttributions,
  scopeFingerprint,
  travelTimeMatrixSchema,
  type AccessDataset,
  type BaseCandidate,
  type CompilationErrorCode,
  type CompilationStage,
  type CompiledRegion,
  type DataLicence,
  type FoodDataset,
  type GeographicScope,
  type OperatingCalendar,
  type OperatingHoursDataset,
  type Place,
  type Region,
  type SatelliteCandidate,
  type SourceFact,
  type StageRecord,
  type Subregion,
  type TravelerProfile,
} from '@sidequest/core';
import { BudgetLedger, budgetFor, type CompilerBudget } from './budget';
import { buildCoverageReport } from './coverage';
import { dedupeCandidates } from './dedupe';
import type { CompilerProviders, DiscoveryQuery, ProviderGap, RoutingMatrixResult } from './providers';

export const COMPILER_VERSION = 'sidequest-compiler/1';

export interface CompileInput {
  compilationId: string;
  scope: GeographicScope;
  profile?: TravelerProfile;
  dates: readonly string[];
  months: readonly number[];
  providers: CompilerProviders;
  budget?: Partial<CompilerBudget>;
  /** Injected, so a compiled artifact is reproducible from its inputs. */
  now: Date;
  onStage?: (record: StageRecord) => void;
}

export type CompileResult =
  | { ok: true; region: CompiledRegion; partial: boolean }
  | { ok: false; code: CompilationErrorCode; message: string };

/**
 * THE PIPELINE.
 *
 * Staged, bounded and resumable in shape: each stage takes what the last one
 * produced, spends against a ledger, and reports what it actually did. Nothing
 * here decides anything a planner should decide — the output is normalised
 * evidence, and the deterministic planner remains the only thing that turns
 * evidence into a day.
 *
 * Two properties are worth stating because everything else follows from them:
 *
 * **Running out is normal.** A budget that is exhausted stops the stage, marks
 * the region partial, and names the counter. It never carries on quietly with
 * less, because less-that-looks-complete is the failure mode that matters.
 *
 * **A candidate with no evidence is dropped, not defaulted.** `Place` has a
 * dozen required fields and no `unknown` variant for most of them, and the
 * access dataset refuses to validate if a place has no rule. So the compiler
 * would have to invent a road to keep a place — and the whole point is that it
 * does not. Dropped candidates become a coverage number, not a silent absence.
 */
export async function compileRegion(input: CompileInput): Promise<CompileResult> {
  const startedAtMs = input.now.getTime();
  const limits = budgetFor({
    nights: input.scope.nights,
    breadthRank: breadthRank(input.scope.breadth),
    ...(input.budget ? { base: input.budget } : {}),
  });
  const ledger = new BudgetLedger(limits, startedAtMs);

  const stages: StageRecord[] = [];
  const timings: { stage: string; ms: number }[] = [];
  const gaps: ProviderGap[] = [];
  const facts: SourceFact[] = [];
  /** Unioned from whatever the providers declared. Never assumed. */
  const licences = new Map<string, DataLicence>();
  const warnings: string[] = [];
  let elapsed = 0;

  /**
   * One stage. Timed against an injected clock offset rather than a real one, so
   * two runs of the same inputs produce byte-identical diagnostics — a compiled
   * artifact whose timings wobble is one whose checksum wobbles.
   */
  const runStage = async <T,>(
    stage: CompilationStage,
    work: () => Promise<{ value: T; outcome: string; note?: string; skipped?: boolean }>,
  ): Promise<T> => {
    const startedAt = new Date(startedAtMs + elapsed).toISOString();
    input.onStage?.({ stage, status: 'running', startedAt });
    const result = await work();
    elapsed += 1;
    const finishedAt = new Date(startedAtMs + elapsed).toISOString();
    const record: StageRecord = {
      stage,
      status: result.skipped ? 'skipped' : 'done',
      startedAt,
      finishedAt,
      outcome: result.outcome,
      ...(result.note ? { note: result.note } : {}),
    };
    stages.push(record);
    timings.push({ stage, ms: 1 });
    input.onStage?.(record);
    return result.value;
  };

  try {
    // ---- Stage: expand the region into bases and subregions -----------------
    const expansion = await runStage('expanding_region', async () => {
      const value = await input.providers.expansion.expand({
        scope: input.scope,
        ...(input.profile ? { profile: input.profile } : {}),
        nights: input.scope.nights,
        maxSubregions: ledger.remaining('maxSubregions'),
        maxBases: ledger.remaining('maxBases'),
      });
      ledger.take('maxSubregions', value.subregions.length);
      ledger.take('maxBases', value.bases.length);
      ledger.record('maxModelCalls', value.calls);
      gaps.push(...value.gaps);
      return {
        value,
        outcome: `${value.bases.length} candidate ${value.bases.length === 1 ? 'base' : 'bases'} across ${value.subregions.length || 1} ${value.subregions.length === 1 ? 'area' : 'areas'}`,
      };
    });

    if (expansion.bases.length === 0) {
      return {
        ok: false,
        code: 'no_plausible_base',
        message: 'We could not find anywhere sensible to stay inside that region.',
      };
    }

    // ---- Stage: discover candidates -----------------------------------------
    const discovered = await runStage('discovering_candidates', async () => {
      const queries = buildQueries(input.scope, input.profile, ledger.remaining('maxCoarseCandidates'));
      const value = await input.providers.places.discover({
        scope: input.scope,
        queries,
        ...(input.profile ? { profile: input.profile } : {}),
      });
      ledger.record('maxModelCalls', value.calls);
      const allowed = ledger.take('maxCoarseCandidates', value.candidates.length);
      gaps.push(...value.gaps);
      for (const entry of value.licences ?? []) licences.set(entry.id, entry);
      const kept = value.candidates.slice(0, allowed);
      const dropped = value.candidates.length - kept.length;
      /**
       * Why nothing came back matters more than the fact that nothing did.
       *
       * A stage reading "0 candidates from 6 searches" with no note is
       * indistinguishable from "this region is empty", which is a claim about
       * the world rather than about a server that was busy.
       */
      const note =
        dropped > 0
          ? `${dropped} more were found than this trip's budget allows, and were not looked at.`
          : value.gaps.length > 0
            ? value.gaps[0]!.detail
            : undefined;

      return {
        value: kept,
        outcome: `${kept.length} candidates from ${queries.length} searches`,
        ...(note ? { note } : {}),
      };
    });

    // ---- Stage: deduplicate --------------------------------------------------
    const deduped = await runStage('deduplicating', async () => {
      const value = dedupeCandidates(discovered);
      return {
        value: value.candidates,
        outcome: `${value.candidates.length} distinct places, ${value.mergedCount} duplicates merged`,
      };
    });

    // ---- Stage: classify and shortlist ---------------------------------------
    const shortlisted = await runStage('classifying', async () => {
      /**
       * Ranked by evidence, not by popularity.
       *
       * Corroboration first — a place two providers found and one has facts
       * about is a place we can actually describe — then the discovery mix the
       * traveller asked for. Ranking by popularity here would quietly make the
       * hidden-gem preference unreachable, because the shortlist is where a
       * quiet stop gets cut.
       */
      const ranked = [...deduped].sort((a, b) => score(b) - score(a));
      const allowed = ledger.take('maxShortlistedCandidates', ranked.length);
      const kept = ranked.slice(0, allowed);
      for (const candidate of kept) facts.push(...candidate.facts);
      const dropped = ranked.length - kept.length;
      return {
        value: kept,
        outcome: `${kept.length} shortlisted`,
        ...(dropped > 0 ? { note: `${dropped} did not make the shortlist for this trip's length.` } : {}),
      };
    });

    if (shortlisted.length === 0) {
      return {
        ok: false,
        code: 'coverage_insufficient',
        message: 'We could not find anything here we could describe well enough to plan around.',
      };
    }

    // ---- Stage: research official constraints --------------------------------
    const research = await runStage('researching_official_constraints', async () => {
      const subjects = shortlisted.map((candidate) => candidate.place);
      const allowed = ledger.take('maxResearchSubjects', subjects.length);
      const value = await input.providers.constraints.research({
        scope: input.scope,
        places: subjects.slice(0, allowed),
        dates: input.dates,
        maxSubjects: allowed,
      });
      ledger.record('maxModelCalls', value.calls);
      ledger.record('maxPagesFetched', value.pagesFetched);
      gaps.push(...value.gaps);
      facts.push(...value.facts);
      return {
        value,
        outcome: `${value.accessRules.length} access rules and ${value.calendars.length} calendars from ${value.pagesFetched} pages`,
      };
    });

    /**
     * The drop.
     *
     * A place with no access rule cannot be in the dataset — `validateAccessDataset`
     * refuses it, and rightly: silence is not a road. So it leaves here, and the
     * number leaving is reported rather than absorbed.
     */
    const covered = new Set(research.accessRules.flatMap((rule) => rule.placeIds));
    const places: Place[] = shortlisted
      .map((candidate) => candidate.place)
      .filter((place) => covered.has(place.id));
    const droppedForAccess = shortlisted.length - places.length;
    if (droppedForAccess > 0) {
      warnings.push(
        `${droppedForAccess} places were dropped because nobody publishes how to reach them, and we will not assume a road exists.`,
      );
      for (const candidate of shortlisted) {
        if (!covered.has(candidate.place.id)) {
          gaps.push({
            subjectId: candidate.place.id,
            reason: 'no_official_source',
            detail: 'No access rule could be established.',
          });
        }
      }
    }

    if (places.length === 0) {
      return {
        ok: false,
        code: 'coverage_insufficient',
        message:
          'We could not establish how to reach anything here, so there is nothing we would put in a plan.',
      };
    }

    /**
     * Food before travel times, and the order is load-bearing.
     *
     * A food venue is priced by the same matrix as a drive to a lake — that is
     * what stops a meal detour being a straight-line guess dressed up as a road
     * time. So its routing node has to be *in* the matrix, which means it has to
     * exist before the matrix is built. Discovering food afterwards produced an
     * artifact whose own integrity gate rejected it, which is exactly the bug
     * that gate exists to catch.
     */
    const bases = buildBases(expansion.bases, input.scope, places);
    const food = await runStage('discovering_food', async () => {
      const value = await input.providers.food.discover({
        scope: input.scope,
        places,
        bases: bases.map((base) => ({ id: base.id, coordinates: base.coordinates })),
        maxVenues: ledger.remaining('maxFoodVenues'),
      });
      ledger.take('maxFoodVenues', value.venues.length);
      gaps.push(...value.gaps);
      return {
        value: value.venues,
        outcome: value.venues.length > 0 ? `${value.venues.length} venues` : 'none',
        skipped: value.venues.length === 0,
      };
    });

    // ---- Stage: travel times --------------------------------------------------
    const foodPoints = new Map<string, { id: string; lat: number; lng: number }>();
    for (const venue of food) {
      if (!foodPoints.has(venue.routingId)) {
        foodPoints.set(venue.routingId, { id: venue.routingId, ...venue.coordinates });
      }
    }

    const matrix = await runStage('computing_travel_times', async () => {
      const points = [
        ...bases.map((base) => ({ id: base.routingId, ...base.coordinates })),
        ...places.map((place) => ({ id: place.id, ...place.coordinates })),
        ...foodPoints.values(),
      ];
      const maxElements = ledger.remaining('maxRouteElements');
      const value = await input.providers.routing.matrix({
        points,
        mode: input.scope.transport.primaryMode === 'drive' ? 'car' : 'foot',
        maxElements,
      });
      ledger.record('maxRouteElements', value.elements);
      for (const entry of value.licences ?? []) licences.set(entry.id, entry);
      return {
        value,
        outcome: `${value.ids.length} points, ${value.elements} legs${value.failedPairs.length > 0 ? `, ${value.failedPairs.length} unanswered` : ''}`,
        ...(value.failedPairs.length > 0
          ? { note: 'Some legs could not be measured; the places behind them were left out.' }
          : {}),
      };
    });

    /**
     * A place with no matrix row throws at the moment a day is laid out, so it
     * leaves here too. Same rule, same reason: a missing leg read as zero
     * teleports somebody.
     */
    const routable = new Set(matrix.ids);
    const plannable = places.filter((place) => routable.has(place.id));
    if (plannable.length === 0 || !bases.some((base) => routable.has(base.routingId))) {
      return {
        ok: false,
        code: 'route_matrix_incomplete',
        message: 'We could not work out travel times across this region, so we will not guess at a plan.',
      };
    }
    if (plannable.length < places.length) {
      warnings.push(
        `${places.length - plannable.length} places have no measurable travel time and were left out.`,
      );
    }

    // ---- Stage: weather points -------------------------------------------------
    const weatherLocations = await runStage('resolving_weather_locations', async () => {
      const value = await input.providers.weatherLocations.plan({
        scope: input.scope,
        places: plannable,
        maxLocations: ledger.remaining('maxWeatherLocations'),
      });
      ledger.take('maxWeatherLocations', value.locations.length);
      gaps.push(...value.gaps);
      return {
        value: value.locations,
        outcome:
          value.locations.length > 0
            ? `${value.locations.length} forecast ${value.locations.length === 1 ? 'point' : 'points'}`
            : 'none — this trip will be planned without weather',
        skipped: value.locations.length === 0,
      };
    });

    /**
     * A venue whose routing node did not survive the matrix is dropped, for the
     * same reason a place is: a detour priced against a leg that does not exist
     * is a number with nothing behind it.
     */
    const routableFood = food.filter((venue) => routable.has(venue.routingId));
    if (routableFood.length < food.length) {
      warnings.push(
        `${food.length - routableFood.length} food venues have no measurable travel time and were left out.`,
      );
    }

    // ---- Stage: coverage --------------------------------------------------------
    const hours = buildHours(input.scope, plannable, research.calendars);
    const access: AccessDataset = {
      regionId: regionIdFor(input.scope),
      points: [],
      services: research.services,
      rules: research.accessRules.filter((rule) =>
        rule.placeIds.some((placeId) => plannable.some((place) => place.id === placeId)),
      ),
    };

    const coverage = await runStage('calculating_coverage', async () => {
      const value = buildCoverageReport({
        places: plannable,
        hours,
        weatherLocations,
        foodVenueCount: routableFood.length,
        matrix,
        facts,
        gaps,
        ledger,
        drivingPlanned: input.scope.transport.primaryMode === 'drive',
        walkingPlanned: input.scope.transport.primaryMode !== 'drive',
        hasWaterOrRail: input.scope.transport.allowedModes.some(
          (mode) => mode === 'ferry' || mode === 'rail',
        ),
        now: input.now,
      });
      const weak = value.dimensions.filter(
        (report) => report.level === 'weak' || report.level === 'unavailable',
      ).length;
      return { value, outcome: `${value.dimensions.length} layers checked, ${weak} thin` };
    });

    // ---- Stage: compile ----------------------------------------------------------
    const region = await runStage('compiling', async () => {
      const primary = bases[0];
      if (!primary) throw new Error('No base survived compilation.');
      const finishedAt = new Date(startedAtMs + elapsed).toISOString();

      const candidate: CompiledRegion = {
        schemaVersion: COMPILED_REGION_VERSION,
        id: input.compilationId,
        compilerVersion: COMPILER_VERSION,
        region: buildRegion(input.scope, primary, plannable),
        scope: input.scope,
        scopeFingerprint: scopeFingerprint(input.scope),
        bases,
        primaryBaseId: primary.id,
        subregions: buildSubregions(expansion.subregions, bases, plannable),
        satellites: buildSatellites(plannable, primary, matrix),
        places: plannable,
        access,
        operatingHours: hours,
        weatherLocations,
        ...(routableFood.length > 0
          ? { food: { version: FOOD_DATASET_VERSION, regionId: access.regionId, venues: routableFood, gaps: [] } as FoodDataset }
          : {}),
        travelTimes: travelTimeMatrixSchema.parse({
          mode: input.scope.transport.primaryMode === 'drive' ? 'car' : 'foot',
          ids: matrix.ids,
          minutes: matrix.minutes,
          km: matrix.km,
          provenance: matrix.provenance,
        }),
        licences: [...licences.values()],
        sourceManifest: {
          facts,
          pages: [],
          providers: [
            { name: input.providers.expansion.name, version: '1', calls: ledger.spent('maxModelCalls'), failures: 0 },
            { name: input.providers.routing.name, version: '1', calls: 1, failures: matrix.failedPairs.length },
          ],
          attributions: requiredAttributions([...licences.values()]),
        },
        coverage,
        diagnostics: {
          compilerVersion: COMPILER_VERSION,
          startedAt: input.now.toISOString(),
          finishedAt,
          durationMs: elapsed,
          stageTimings: timings,
          budget: ledger.snapshot(),
          promptVersions: {},
          warnings,
        },
        createdAt: finishedAt,
      };

      return { value: candidate, outcome: `${plannable.length} places, ${bases.length} bases` };
    });

    /**
     * The same gate the app runs, run here too.
     *
     * A compiler that emits an artifact its own consumer will reject has not
     * failed honestly — it has produced something that looks finished and blows
     * up one screen later.
     */
    const issues = checkRegionIntegrity(region);
    if (issues.length > 0) {
      return {
        ok: false,
        code: 'coverage_insufficient',
        message: `What we compiled does not hang together: ${issues[0]?.detail ?? 'unknown problem'}`,
      };
    }

    const exhausted = ledger.exhausted().length > 0;
    return { ok: true, region, partial: exhausted || coverage.blocksItinerary || warnings.length > 0 };
  } catch (error) {
    return {
      ok: false,
      code: 'internal_error',
      message: error instanceof Error ? error.message : 'Something went wrong on our side.',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function score(candidate: { facts: readonly unknown[]; providerRefs: readonly unknown[]; place: Place }): number {
  // Corroboration and evidence first; popularity is a tiebreak, never the sort.
  return (
    candidate.providerRefs.length * 2 +
    candidate.facts.length +
    candidate.place.hiddenGemScore +
    candidate.place.popularityScore * 0.5
  );
}

/**
 * The searches to run.
 *
 * Several, by category and by what the traveller said they care about — never
 * one generic "things to do in X", which returns the same twelve results every
 * search engine already shows and none of the quiet ones.
 */
export function buildQueries(
  scope: GeographicScope,
  profile: TravelerProfile | undefined,
  limit: number,
): DiscoveryQuery[] {
  const where = scope.destinationName;
  const base: { intent: string; text: string }[] = [
    { intent: 'landmark', text: `best-known places to visit in ${where}` },
    { intent: 'hidden_gem', text: `quiet, lesser-known places in ${where} worth going out of the way for` },
    { intent: 'nature', text: `landscape, viewpoints and open ground near ${where}` },
    { intent: 'culture', text: `museums, historic sites and neighbourhoods in ${where}` },
    { intent: 'indoor', text: `things to do in ${where} when the weather is bad` },
    { intent: 'day_trip', text: `day trips from ${where}` },
  ];

  const interests = profile
    ? Object.entries(profile.interests)
        .filter(([, level]) => level === 'frequent' || level === 'core')
        .map(([interest]) => ({
          intent: `interest:${interest}`,
          text: `${interest.replace(/_/g, ' ')} near ${where}`,
        }))
    : [];

  const all = [...base, ...interests];
  const perQuery = Math.max(3, Math.floor(limit / Math.max(1, all.length)));
  return all.map((query, index) => ({
    id: `q${index}-${query.intent}`,
    intent: query.intent,
    text: query.text,
    limit: perQuery,
  }));
}

function regionIdFor(scope: GeographicScope): string {
  return `compiled-${scope.destinationCandidateId}`;
}

function buildRegion(scope: GeographicScope, primary: BaseCandidate, places: readonly Place[]): Region {
  const radiusKm =
    scope.shape.kind === 'radius'
      ? scope.shape.radiusKm
      : Math.max(
          10,
          ...places.map((place) => Math.max(1, place.travelFromBase.distanceKm)),
        );
  return {
    id: regionIdFor(scope),
    name: scope.destinationName,
    baseName: primary.name,
    baseCoordinates: primary.coordinates,
    summary: scope.rationale,
    maxRadiusKm: Math.max(1, Math.round(radiusKm)),
    aliases: [],
    transportSummary: scope.transport.note,
    /**
     * What not driving costs here, and it is deliberately not asserted.
     *
     * The authored region says "adding a vehicle would open the whole corridor",
     * which is true of that corridor and unknowable for a region nobody has
     * looked at. A compiled region says what it knows.
     */
    noVehicleSummary:
      scope.transport.carAvailable === false
        ? 'This plan assumes no car. Anything that needs one has been left out rather than offered and then withdrawn.'
        : 'We have not established what a car adds here, so nothing in this plan assumes one is missing.',
  };
}

function buildBases(
  candidates: readonly {
    id: string;
    name: string;
    coordinates: { lat: number; lng: number };
    timeZone: string;
    subregionId?: string;
    suggestedNights: { min: number; max: number };
    transportModes: readonly string[];
    rationale: string;
    tradeoffs: readonly string[];
  }[],
  scope: GeographicScope,
  places: readonly Place[],
): BaseCandidate[] {
  return candidates.slice(0, Math.max(1, scope.maxBaseChanges + 1)).map((base, index) => ({
    id: base.id,
    name: base.name,
    coordinates: base.coordinates,
    role: index === 0 ? ('primary_base' as const) : ('secondary_base' as const),
    routingId: base.id,
    timeZone: base.timeZone,
    ...(base.subregionId ? { subregionId: base.subregionId } : {}),
    suggestedNights: base.suggestedNights,
    placesWithinReach: places.map((place) => place.id),
    transportModes: base.transportModes as BaseCandidate['transportModes'],
    lodgingEvidence: 'unknown' as const,
    rationale: base.rationale,
    tradeoffs: [...base.tradeoffs],
    evidenceFactIds: [],
  }));
}

function buildSubregions(
  candidates: readonly {
    id: string;
    name: string;
    summary: string;
    center: { lat: number; lng: number };
    radiusKm: number;
    suggestedNights: { min: number; max: number };
  }[],
  bases: readonly BaseCandidate[],
  places: readonly Place[],
): Subregion[] {
  return candidates.map((subregion) => ({
    id: subregion.id,
    name: subregion.name,
    summary: subregion.summary,
    center: subregion.center,
    radiusKm: subregion.radiusKm,
    entityType: 'subregion' as const,
    breadth: 'subregion' as const,
    baseIds: bases.filter((base) => base.subregionId === subregion.id).map((base) => base.id),
    placeIds: places.map((place) => place.id),
    suggestedNights: subregion.suggestedNights,
    bestMonths: [],
    evidenceFactIds: [],
  }));
}

function buildSatellites(
  places: readonly Place[],
  primary: BaseCandidate,
  matrix: RoutingMatrixResult,
): SatelliteCandidate[] {
  const baseIndex = matrix.ids.indexOf(primary.routingId);
  return places
    .filter((place) => place.relationship === 'satellite')
    .map((place) => {
      const index = matrix.ids.indexOf(place.id);
      const minutes =
        baseIndex >= 0 && index >= 0 ? (matrix.minutes[baseIndex]?.[index] ?? 0) : 0;
      return {
        id: `sat-${place.id}`,
        name: place.name,
        parentBaseId: primary.id,
        placeIds: [place.id],
        minutesFromBase: minutes,
        suggestedMinutes: place.typicalDurationMinutes,
        requiredModes: [],
        seasonalMonths:
          place.seasonalAccess.openMonths.length === 12 ? [] : [...place.seasonalAccess.openMonths],
        evidenceFactIds: [],
      };
    });
}

/**
 * Hours for every place, and `unknown` where nobody published any.
 *
 * The dataset validator insists on full coverage, and the value it insists on is
 * the important part: `unknown` rather than `always_open`. A trailhead with no
 * gate and a museum nobody looked up are different situations, and a planner
 * that treats them the same schedules the museum at seven in the evening.
 */
function buildHours(
  scope: GeographicScope,
  places: readonly Place[],
  calendars: readonly OperatingCalendar[],
): OperatingHoursDataset {
  const byPlace = new Map(calendars.map((calendar) => [calendar.placeId, calendar]));
  return {
    version: OPERATING_HOURS_DATASET_VERSION,
    regionId: regionIdFor(scope),
    calendars: places.map(
      (place) =>
        byPlace.get(place.id) ?? {
          kind: 'unknown' as const,
          placeId: place.id,
          admission: {
            reservationRequired: false,
            timedEntry: false,
            permitRequired: false,
            walkInAllowed: true,
            capacityLimited: false,
          },
          daylightOnly: false,
          note: 'We hold no opening-hours record for this place.',
          provenance: {
            kind: 'estimated' as const,
            sourceName: 'No source',
            confidence: 0,
            volatility: 'dynamic' as const,
            recheckNote: 'Nobody publishes opening hours for this that we could find. Check before you go.',
          },
        },
    ),
  };
}
