import {
  COMPILED_REGION_VERSION,
  FOOD_DATASET_VERSION,
  OPERATING_HOURS_DATASET_VERSION,
  assessCandidateQuality,
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
  type FactPath,
  type FoodDataset,
  type FoodVenue,
  type GeographicScope,
  type Interest,
  type OperatingCalendar,
  type OperatingHoursDataset,
  type Place,
  type Region,
  type RegionEvidence,
  type RegionPack,
  type RetrievedPage,
  type SatelliteCandidate,
  type SourceFact,
  type StageRecord,
  type Subregion,
  type TravelerProfile,
} from '@sidequest/core';
import { BudgetLedger, budgetFor, type CompilerBudget } from './budget';
import { buildCoverageReport } from './coverage';
import { dedupeCandidates } from './dedupe';
import {
  EXTRACTION_SCHEMA_VERSION,
  buildEvidence,
  claimsToFacts,
  prioritiseSubjects,
} from './enrich';
import type { RegionPackOutcome } from './backbone/pack';
import { partitionScope, scopeBounds } from './backbone/partition';
import type {
  CompilerProviders,
  DiscoveryQuery,
  ProviderGap,
  ResearchSubject,
  RoutingMatrixResult,
} from './providers';

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
  /** Pages actually read, kept for audit. Bodies deliberately are not. */
  const pages: RetrievedPage[] = [];
  const promptVersions: Record<string, string> = {};
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
    /**
     * ---- The place backbone ---------------------------------------------------
     *
     * Four stages that run before anything is expanded, researched or bought.
     * The pack they produce is traveller-independent geography, so two trips to
     * the same ground share it — which is most of why a warm compilation is
     * cheap, and all of why a destination no longer fails because one shared
     * query service was busy.
     *
     * A build with no backbone provider records all four as skipped and carries
     * on through the discovery provider's own queries. That is a visible state
     * on the progress screen rather than a silent branch.
     */
    let pack: RegionPack | undefined;
    let packNote: string | undefined;
    let packReused = false;

    if (input.providers.regionPack) {
      const provider = input.providers.regionPack;

      /**
       * The partition is computed here as well as inside the provider, and that
       * is deliberate rather than duplicated work: `partitionScope` is pure and
       * costs microseconds, and running it in the compiler is what lets this
       * stage report a real number *before* the expensive stage starts rather
       * than a sentence about what is about to happen.
       */
      const plan = partitionScope(input.scope);
      await runStage('partitioning_scope', async () => ({
        value: null,
        outcome: `${plan.cells.length} ${plan.cells.length === 1 ? 'area' : 'areas'} to read`,
        ...(plan.droppedCells > 0
          ? {
              note: `${plan.droppedCells} outlying areas are beyond what one build reads, and were left out.`,
            }
          : {}),
      }));

      const outcome = await runStage<RegionPackOutcome>('building_region_pack', async () => {
        const result = await provider.getPack({ scope: input.scope, now: input.now });
        if (result.kind === 'unavailable') {
          return {
            value: result,
            outcome: 'no regional place data',
            note: result.message,
            skipped: true,
          };
        }
        const built = result.pack;
        const releaseId = built.releases[0]?.releaseId ?? 'unknown';
        const retained = built.diagnostics.featuresRetained;
        const source = result.kind === 'ready' ? result.source : result.kind;
        return {
          value: result,
          outcome: `${retained} records from release ${releaseId}${source === 'cache' ? ', already held' : ''}`,
          ...(result.kind === 'stale' || result.kind === 'partial' ? { note: result.reason } : {}),
        };
      });

      if (outcome.kind === 'unavailable') {
        packNote = outcome.message;
        gaps.push({
          subjectId: input.scope.destinationCandidateId,
          reason: 'provider_error',
          detail: outcome.message,
        });
      } else {
        pack = outcome.pack;
        packReused = outcome.kind === 'ready' && outcome.source === 'cache';
        for (const entry of pack.licences) licences.set(entry.id, entry);
        if (outcome.kind === 'stale') {
          warnings.push(
            `The regional place data for this trip is from an older release than the current one. ${outcome.reason}`,
          );
        }
        if (outcome.kind === 'partial') {
          warnings.push(`Some regional place data could not be read. ${outcome.reason}`);
        }
      }

      /**
       * Recorded after the build, because before it there is nothing true to
       * say: the release is resolved *inside* the provider, and a stage claiming
       * to have "read the catalogue" before anything read it is the kind of
       * progress theatre this product does not do. The progress screen orders
       * stages by the canonical list, so it still reads in the right order.
       */
      await runStage('resolving_source_release', async () => {
        const release = pack?.releases[0];
        if (!release) {
          return {
            value: null,
            outcome: 'no release could be pinned',
            skipped: true,
            ...(packNote ? { note: packNote } : {}),
          };
        }
        return {
          value: null,
          outcome: `${release.catalog} release ${release.releaseId}`,
          ...(release.schemaVersion ? { note: `Schema ${release.schemaVersion}.` } : {}),
        };
      });

      await runStage('linking_sources', async () => {
        if (!pack) return { value: null, outcome: 'nothing to match', skipped: true };
        const merged = pack.links.filter(
          (link) => link.kind === 'same_entity' || link.kind === 'probable_same_entity',
        ).length;
        const unresolved = pack.links.filter(
          (link) => link.kind === 'possible_duplicate' || link.kind === 'unresolved',
        ).length;
        return {
          value: null,
          outcome: `${merged} records matched across sources`,
          ...(unresolved > 0
            ? {
                note: `${unresolved} pairs look alike and could not be confirmed as the same place, so both were kept.`,
              }
            : {}),
        };
      });
    }

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
        ...(pack ? { pack } : {}),
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
      /**
       * The gap that explains the emptiness, not the first one recorded.
       *
       * A live evaluation reported "0 candidates from 6 searches" with a note
       * about way geometry, because a caveat pushed early outranked the
       * classification failure pushed later. The note is the only thing a
       * traveller reads about why a region came back empty; it has to be the
       * reason rather than whatever happened to be first.
       */
      const EXPLANATORY: readonly ProviderGap['reason'][] = [
        'provider_error',
        'rate_limited',
        'budget_exhausted',
        'not_found',
      ];
      // Ordered by how much the reason explains, not by which was pushed first.
      const explanatory = [...value.gaps]
        .filter((gap) => EXPLANATORY.includes(gap.reason))
        .sort((a, b) => EXPLANATORY.indexOf(a.reason) - EXPLANATORY.indexOf(b.reason))[0];
      const note =
        dropped > 0
          ? `${dropped} more were found than this trip's budget allows, and were not looked at.`
          : ((explanatory ?? value.gaps[0])?.detail ??
            // When the backbone could not be built, that is the reason the
            // discovery stage is thin — and it is a truer sentence than
            // anything the fallback provider can say about itself.
            (kept.length === 0 ? packNote : undefined));

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
       * Ranked by evidence and fit, through the same assessor the board uses.
       *
       * The version this replaces added `hiddenGemScore` to a corroboration
       * score — and `hiddenGemScore` is computed as the *inverse* of how richly
       * a place is tagged, so the two terms cancelled and the shortlist was very
       * nearly arbitrary. A live New York compilation shortlisted thirty-six of
       * ninety-six candidates and thirty-three of those had nothing published
       * about them at all, while described museums sat below the cut.
       *
       * Using the quality assessor here also means one definition of "worth
       * looking at" rather than two that can drift apart.
       */
      const tolerance = detourTolerance(input.profile);
      const ranked = [...deduped]
        .map((candidate) => ({
          candidate,
          score: assessCandidateQuality({
            place: candidate.place,
            fitScore: roughFit(candidate.place, input.profile),
            detourMinutes: candidate.place.travelFromBase.driveMinutes,
            categoryCount: 0,
            supersededByParent: false,
            duplicate: false,
            usableOnTripDates: true,
            openingUncertain: true,
            detourToleranceMinutes: tolerance,
          }).score,
        }))
        // Corroboration is still a tiebreak: two providers finding the same
        // place is real evidence, it is simply not the whole ranking.
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.candidate.providerRefs.length - a.candidate.providerRefs.length ||
            a.candidate.place.id.localeCompare(b.candidate.place.id),
        )
        .map((entry) => entry.candidate);
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

    /**
     * ---- Stage: drop the thin records ---------------------------------------
     *
     * Runs before a penny is spent on research, and that ordering is the whole
     * economy of the funnel: a mapped object with a name and nothing else costs
     * a search to confirm it is a mapped object with a name and nothing else.
     *
     * Quality here is judged on the *pre-research* evidence — description,
     * feature scale, fit, detour — so it is a filter on obvious noise rather
     * than a verdict. The real verdict comes after enrichment, when there is
     * something to judge.
     */
    const qualityFiltered = await runStage('filtering_quality', async () => {
      const categoryCounts = new Map<string, number>();
      const kept: typeof shortlisted = [];
      const dropped: { name: string; reason: string }[] = [];

      for (const candidate of shortlisted) {
        const category = candidate.place.category;
        const seen = categoryCounts.get(category) ?? 0;
        const assessment = assessCandidateQuality({
          place: candidate.place,
          fitScore: roughFit(candidate.place, input.profile),
          detourMinutes: candidate.place.travelFromBase.driveMinutes,
          categoryCount: seen,
          supersededByParent: false,
          duplicate: false,
          usableOnTripDates: true,
          openingUncertain: true,
          detourToleranceMinutes: detourTolerance(input.profile),
        });
        /**
         * Only the two outcomes that mean "there is nothing here" remove a
         * candidate at this stage. A poor fit is the traveller's call and shows
         * up on the board under "probably skip"; an empty record is ours.
         */
        if (assessment.outcome === 'insufficient_evidence') {
          dropped.push({ name: candidate.place.name, reason: assessment.reason });
          gaps.push({
            subjectId: candidate.place.id,
            reason: 'insufficient_evidence',
            detail: assessment.reason,
          });
          continue;
        }
        categoryCounts.set(category, seen + 1);
        kept.push(candidate);
      }

      return {
        value: kept,
        outcome: `${kept.length} kept, ${dropped.length} dropped as too thin`,
        ...(dropped.length > 0
          ? {
              note: `Dropped because nothing is published about them beyond a name and a position — for example ${dropped
                .slice(0, 2)
                .map((entry) => entry.name)
                .join(' and ')}.`,
            }
          : {}),
      };
    });

    if (qualityFiltered.length === 0) {
      return {
        ok: false,
        code: 'coverage_insufficient',
        message: 'Everything we found here is a name on a map with nothing published about it.',
      };
    }

    // ---- Stage: research official constraints --------------------------------
    const research = await runStage('researching_official_constraints', async () => {
      const subjects = qualityFiltered.map((candidate) => candidate.place);
      /**
       * Bounded by the shortlist rather than by the research budget.
       *
       * This stage reads what the map data already carries — no search, no
       * fetch, no model — so charging it to `maxResearchSubjects` spent the
       * enrichment funnel's entire allowance before the funnel started, and left
       * every compilation reporting "0 of 30 worth looking up".
       */
      const allowed = subjects.length;
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
    const places: Place[] = qualityFiltered
      .map((candidate) => candidate.place)
      .filter((place) => covered.has(place.id));
    const droppedForAccess = qualityFiltered.length - places.length;
    if (droppedForAccess > 0) {
      warnings.push(
        `${droppedForAccess} places were dropped because nobody publishes how to reach them, and we will not assume a road exists.`,
      );
      for (const candidate of qualityFiltered) {
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
        ...(pack ? { pack } : {}),
      });
      ledger.take('maxFoodVenues', value.venues.length);
      gaps.push(...value.gaps);
      return {
        value: value.venues,
        outcome: value.venues.length > 0 ? `${value.venues.length} venues` : 'none',
        skipped: value.venues.length === 0,
      };
    });

    /**
     * ---- The research funnel -------------------------------------------------
     *
     * Five stages rather than one "researching", because they fail
     * independently and a traveller watching this screen is owed the difference
     * between "nobody publishes this" and "we found the page and could not read
     * it". Each spends against its own counter and each stops when that counter
     * runs out, leaving the artifact partial rather than late.
     */
    const subjects = await runStage('enriching_priority_candidates', async () => {
      const candidates: {
        id: string;
        name: string;
        kind: string;
        locality: string;
        coordinates: { lat: number; lng: number };
        knownOfficialUrl?: string;
        fitScore: number;
        gated: boolean;
        hoursUnknown: boolean;
        isFood?: boolean;
      }[] = [
        ...places.map((place) => ({
          id: place.id,
          name: place.name,
          kind: place.category,
          locality: place.locality,
          coordinates: place.coordinates,
          ...(officialUrlOf(place) ? { knownOfficialUrl: officialUrlOf(place)! } : {}),
          fitScore: roughFit(place, input.profile),
          gated: isPlausiblyGated(place),
          hoursUnknown: !research.calendars.some((calendar) => calendar.placeId === place.id),
        })),
        ...food.map((venue) => ({
          id: venue.id,
          name: venue.name,
          kind: venue.serviceType,
          locality: venue.locality,
          coordinates: venue.coordinates,
          fitScore: 0.5,
          gated: true,
          hoursUnknown: venue.hours.kind === 'unknown',
          isFood: true,
        })),
      ];

      const allowed = ledger.take('maxResearchSubjects', candidates.length);
      const chosen = new Set(
        prioritiseSubjects({ candidates, maxSubjects: allowed }).map((entry) => entry.id),
      );
      const value: ResearchSubject[] = candidates
        .filter((candidate) => chosen.has(candidate.id))
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          kind: candidate.kind,
          locality: candidate.locality,
          coordinates: candidate.coordinates,
          ...(candidate.knownOfficialUrl ? { knownOfficialUrl: candidate.knownOfficialUrl } : {}),
          wantedPaths: wantedPathsFor(
            candidate.id,
            food,
            places.find((place) => place.id === candidate.id),
          ),
        }));

      const skipped = candidates.length - value.length;
      return {
        value,
        outcome: `${value.length} of ${candidates.length} worth looking up`,
        ...(skipped > 0
          ? { note: `${skipped} were left at what the map data says, to keep this trip's research inside its budget.` }
          : {}),
      };
    });

    const knownOfficialUrls = new Map<string, { url: string; authority: string; name: string }>();
    for (const place of places) {
      const url = officialUrlOf(place);
      if (url) {
        knownOfficialUrls.set(place.id, {
          url,
          authority: 'open_structured_database',
          name: place.source.name,
        });
      }
    }

    const references = await runStage('discovering_sources', async () => {
      if (subjects.length === 0) {
        return { value: [], outcome: 'nothing to look up', skipped: true };
      }
      const budgetLeft = ledger.remaining('maxSourceSearches');
      const result = await input.providers.sourceDiscovery.discover({
        scope: input.scope,
        subjects,
        maxSearches: budgetLeft,
        maxReferencesPerSubject: ledger.limits.maxPagesPerSubject,
      });
      ledger.take('maxSourceSearches', result.searches);
      ledger.record('maxModelCalls', result.calls);
      gaps.push(...result.gaps);
      const fromStructured = result.references.filter(
        (reference) => reference.discoveredVia !== 'search',
      ).length;
      return {
        value: result.references,
        outcome: `${result.references.length} pages worth reading, ${result.searches} searches`,
        ...(fromStructured > 0
          ? { note: `${fromStructured} came from the map data or an open database and cost nothing.` }
          : {}),
      };
    });

    const documents = await runStage('retrieving_pages', async () => {
      if (references.length === 0) {
        return { value: [], outcome: 'nothing to read', skipped: true };
      }
      const allowed = ledger.remaining('maxPagesFetched');
      const result = await input.providers.retrieval.retrieve({
        references: references.slice(0, allowed),
        maxPages: allowed,
        maxBytes: ledger.remaining('maxRetrievalBytes'),
        /**
         * Measured from when reading starts, not from when the compilation did.
         *
         * `startedAtMs` is the injected clock the artifact's diagnostics are
         * stamped from, so two runs of one input produce identical bytes. Using
         * it as a wall-clock deadline meant a destination whose discovery took
         * two minutes had already spent the whole reading budget before the
         * first page was requested — a live New York compile refused all
         * thirty-three of its pages that way, and reported it as running out of
         * time rather than as the off-by-a-stage it was.
         */
        deadlineMs: Date.now() + limits.maxEnrichmentMs,
      });
      ledger.take('maxPagesFetched', result.documents.length + result.rejected.length);
      ledger.take('maxRetrievalBytes', result.bytes);
      gaps.push(...result.gaps);
      for (const rejection of result.rejected) {
        pages.push({
          url: rejection.url,
          retrievedAt: new Date(startedAtMs + elapsed).toISOString(),
          contentBytes: 0,
          robotsAllowed: rejection.reason !== 'rejected_unsafe_source',
        });
      }
      for (const document of result.documents) {
        pages.push({
          url: document.url,
          ...(document.title ? { title: document.title } : {}),
          retrievedAt: document.retrievedAt,
          contentBytes: document.contentBytes,
          contentHash: document.contentHash,
          robotsAllowed: document.robotsAllowed,
        });
      }
      return {
        value: result.documents,
        outcome: `${result.documents.length} read, ${result.rejected.length} refused`,
        ...(result.rejected.length > 0
          ? { note: result.rejected[0]!.detail }
          : {}),
      };
    });

    const extraction = await runStage('extracting_facts', async () => {
      if (documents.length === 0) {
        return {
          value: { facts: [] as SourceFact[], payloads: new Map<string, unknown>(), discarded: 0 },
          outcome: 'nothing to read facts out of',
          skipped: true,
        };
      }
      const allowedCalls = ledger.remaining('maxExtractionCalls');
      const result = await input.providers.extraction.extract({
        subjects,
        documents,
        dates: input.dates,
        maxCalls: allowedCalls,
      });
      ledger.take('maxExtractionCalls', result.calls);
      ledger.record('maxModelCalls', result.calls);
      gaps.push(...result.gaps);
      promptVersions.extractFacts = result.promptVersion;
      promptVersions.extractionSchema = EXTRACTION_SCHEMA_VERSION;

      const converted = claimsToFacts({
        claims: result.claims,
        documents,
        promptVersion: result.promptVersion,
        schemaVersion: result.schemaVersion,
        ...(result.modelId ? { modelId: result.modelId } : {}),
        now: input.now,
      });
      return {
        value: converted,
        outcome: `${converted.facts.length} facts from ${documents.length} pages`,
        ...(converted.discarded > 0
          ? {
              note: `${converted.discarded} claims were thrown away for having no quotable basis or a shape we could not read.`,
            }
          : {}),
      };
    });

    facts.push(...extraction.facts);

    const reconciled = await runStage('reconciling_facts', async () => {
      const value = buildEvidence({
        subjects,
        facts: extraction.facts,
        payloads: extraction.payloads,
        knownOfficialUrls,
        now: input.now,
      });
      const conflicted = value.resolved.filter((entry) => entry.state === 'conflicted').length;
      const known = value.resolved.filter(
        (entry) => entry.state !== 'unknown' && entry.state !== 'unavailable',
      ).length;
      return {
        value,
        outcome: `${known} of ${value.resolved.length} questions answered`,
        ...(conflicted > 0
          ? { note: `${conflicted} answers came back with sources disagreeing. Both are kept and shown.` }
          : {}),
      };
    });

    const evidence: RegionEvidence = reconciled.evidence;
    const blocked = new Set(reconciled.blockedSubjectIds);

    const sourcedCalendars = await runStage('resolving_hours_and_access', async () => {
      const value = reconciled.calendars;
      return {
        value,
        outcome:
          value.length > 0
            ? `${value.length} published calendars`
            : 'nothing published that we could turn into a calendar',
        skipped: value.length === 0,
      };
    });

    await runStage('resolving_costs', async () => {
      const priced = evidence.places.filter((entry) => entry.costs.length > 0).length;
      return {
        value: null,
        outcome: priced > 0 ? `${priced} with published prices` : 'no published prices',
        skipped: priced === 0,
      };
    });

    await runStage('resolving_safety', async () => {
      const cautions = evidence.places.reduce((total, entry) => total + entry.safety.length, 0);
      const closures = evidence.places.reduce((total, entry) => total + entry.closures.length, 0);
      return {
        value: null,
        outcome:
          cautions + closures > 0
            ? `${closures} closures and ${cautions} cautions, each with a date and a source`
            : 'nothing official flagged',
        skipped: cautions + closures === 0,
      };
    });

    /**
     * Food, with whatever the research found folded back in.
     *
     * The food planner refuses to schedule a venue whose hours nobody confirmed,
     * which is correct and which is why live regions produced no named meals at
     * all. This is where that changes: a venue whose hours came back from its own
     * page becomes schedulable, and one whose did not stays honestly unknown.
     */
    const enrichedFood = await runStage('enriching_food', async () => {
      const byId = new Map(sourcedCalendars.map((calendar) => [calendar.placeId, calendar]));
      let named = 0;
      const value = food
        .filter((venue) => !blocked.has(venue.id))
        .map((venue) => {
          const calendar = byId.get(venue.id);
          if (!calendar || calendar.kind !== 'scheduled') return venue;
          named += 1;
          return {
            ...venue,
            hours: {
              kind: 'scheduled' as const,
              hoursConfidence: 'published' as const,
              periods: calendar.periods,
              closedAnnualDates: calendar.closedAnnualDates,
              provenance: calendar.provenance,
            },
          } satisfies FoodVenue;
        });
      return {
        value,
        outcome:
          named > 0
            ? `${named} venues with hours we can actually plan around`
            : 'no venue hours could be confirmed',
        skipped: named === 0,
      };
    });

    // ---- Stage: travel times --------------------------------------------------
    /**
     * A subject an official source says is shut leaves before the matrix.
     *
     * Not demoted, not cautioned: removed. Measuring travel times to a closed
     * gate would spend route elements on a leg nobody will drive, and leaving it
     * schedulable would waste a day. This is the one place where evidence
     * subtracts from the plan rather than annotating it.
     */
    const openPlaces = places.filter((place) => !blocked.has(place.id));
    if (openPlaces.length < places.length) {
      warnings.push(
        `${places.length - openPlaces.length} places were left out because an official source says they are shut on your dates.`,
      );
    }
    if (openPlaces.length === 0) {
      return {
        ok: false,
        code: 'coverage_insufficient',
        message: 'Everything we found here is closed on the dates you are travelling.',
      };
    }

    /**
     * Routing nodes for food, minus the ones already in the matrix.
     *
     * Several venues share one node — a corridor model cannot tell one end of a
     * main street from the other — and a venue may legitimately share a node
     * with the base or the place it sits beside. What must not happen is that
     * node being *added twice*: the matrix schema refuses duplicate ids, and a
     * live compilation ended with "we do not have usable travel times for this
     * region" for exactly that reason. Same physical point, one row.
     */
    const existingRoutingIds = new Set([
      ...bases.map((base) => base.routingId),
      ...openPlaces.map((place) => place.id),
    ]);
    const foodPoints = new Map<string, { id: string; lat: number; lng: number }>();
    for (const venue of enrichedFood) {
      if (existingRoutingIds.has(venue.routingId)) continue;
      if (!foodPoints.has(venue.routingId)) {
        foodPoints.set(venue.routingId, { id: venue.routingId, ...venue.coordinates });
      }
    }

    const primaryMode = matrixModeFor(input.scope);
    /** The mode the matrix was actually measured in. Recorded on the artifact. */
    let measuredMode = primaryMode;
    const matrix = await runStage('computing_travel_times', async () => {
      const points = [
        ...bases.map((base) => ({ id: base.routingId, ...base.coordinates })),
        ...openPlaces.map((place) => ({ id: place.id, ...place.coordinates })),
        ...foodPoints.values(),
      ];
      const maxElements = ledger.remaining('maxRouteElements');
      let value = await input.providers.routing.matrix({
        points,
        mode: primaryMode,
        maxElements,
      });

      /**
       * One retry on the road network when the footpath network has nothing.
       *
       * A live Denali build and a live Bali build both ended with "we could not
       * work out travel times across this region" — not because the router was
       * down, but because there is no continuous pedestrian graph across a
       * national park or an island, and the scope's primary mode was `walk`.
       *
       * Every non-driving mode a scope allows — bus, rail, shuttle, rideshare,
       * ferry — travels on roads. So when the walking matrix comes back with
       * nothing usable, the road matrix is the closest honest measurement
       * available. It is recorded as what it is: `mode` travels on the artifact,
       * the transport layer still says what the traveller can actually take, and
       * nothing here claims they will drive it.
       */
      if (primaryMode !== 'car' && value.ids.length < 2) {
        const fallback = await input.providers.routing.matrix({
          points,
          mode: 'car',
          maxElements,
        });
        if (fallback.ids.length > value.ids.length) {
          value = fallback;
          measuredMode = 'car';
          warnings.push(
            'Travel times here are measured along roads, because there is no continuous walking network across this region. How you actually travel each leg is in the transport notes.',
          );
        }
      }

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
    /**
     * Every surviving place, with the drive from base written onto it.
     *
     * `travelFromBase` was left at zero on every compiled place, and the matrix
     * was the only thing that knew better. That is not a cosmetic gap: the
     * candidate-quality assessor scores route feasibility from this field, the
     * regional-expansion helper reads it to decide what is a day trip, and the
     * board renders it. With it at zero, every place in a compiled region looked
     * like a stop with no drive at all.
     *
     * A live Bali build is what it costs. The board offered nine places as
     * zero-minute hops, auto-pick took all nine, and the planner then refused
     * every one of them because the round trip was a hundred and sixty minutes
     * against a hundred-and-fifty-minute daily limit. The board and the planner
     * were reading different worlds, and only one of them had the travel times.
     */
    const legBetween = (fromId: string, toId: string): { minutes: number; km: number } | null => {
      const from = matrix.ids.indexOf(fromId);
      const to = matrix.ids.indexOf(toId);
      if (from < 0 || to < 0) return null;
      const minutes = matrix.minutes[from]?.[to];
      const km = matrix.km[from]?.[to];
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return null;
      return { minutes, km: typeof km === 'number' && Number.isFinite(km) ? km : 0 };
    };
    const legFromBase = (placeId: string): { minutes: number; km: number } | null =>
      legBetween(bases[0]?.routingId ?? '', placeId);

    const plannable = openPlaces
      .filter((place) => routable.has(place.id))
      .map((place) => {
        const leg = legFromBase(place.id);
        if (!leg) return place;
        return {
          ...place,
          travelFromBase: {
            ...place.travelFromBase,
            distanceKm: Math.round(leg.km * 10) / 10,
            driveMinutes: Math.round(leg.minutes),
          },
        } satisfies Place;
      });

    await runStage('validating_routes', async () => {
      const measured = Math.max(0, matrix.ids.length * matrix.ids.length - matrix.ids.length);
      const failed = matrix.failedPairs.length;
      return {
        value: null,
        outcome: `${measured - failed} of ${measured} legs measured`,
        ...(failed > 0
          ? {
              note: 'A routing engine that cannot answer for a pair is not a distance of zero, so the places behind those legs were dropped rather than guessed at.',
            }
          : {}),
      };
    });

    if (plannable.length === 0 || !bases.some((base) => routable.has(base.routingId))) {
      return {
        ok: false,
        code: 'route_matrix_incomplete',
        message: 'We could not work out travel times across this region, so we will not guess at a plan.',
      };
    }
    if (plannable.length < openPlaces.length) {
      warnings.push(
        `${openPlaces.length - plannable.length} places have no measurable travel time and were left out.`,
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
    const routableFood = enrichedFood.filter((venue) => routable.has(venue.routingId));
    if (routableFood.length < enrichedFood.length) {
      warnings.push(
        `${enrichedFood.length - routableFood.length} food venues have no measurable travel time and were left out.`,
      );
    }

    // ---- Stage: coverage --------------------------------------------------------
    /**
     * Sourced calendars first, map-derived ones second, `unknown` last.
     *
     * The order is the precedence: a calendar an operator published beats one we
     * parsed out of a mapper's tag, and both beat the honest blank.
     */
    const hours = buildHours(input.scope, plannable, [
      ...sourcedCalendars,
      ...research.calendars,
    ]);
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
        foodVenues: routableFood,
        evidence,
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

      /**
       * The bases, with their reach corrected to what the matrix actually
       * measured.
       *
       * `buildBases` runs before the matrix exists, so its first answer is
       * necessarily every place the compiler was holding at the time. By here
       * the unroutable ones have gone, and the claim can be true.
       */
      const routedBases = bases.map((base) => ({
        ...base,
        placesWithinReach: plannable
          .filter((place) => legBetween(base.routingId, place.id) !== null)
          .map((place) => place.id),
      }));

      const candidate: CompiledRegion = {
        schemaVersion: COMPILED_REGION_VERSION,
        id: input.compilationId,
        compilerVersion: COMPILER_VERSION,
        region: buildRegion(input.scope, primary, plannable),
        scope: input.scope,
        scopeFingerprint: scopeFingerprint(input.scope),
        bases: routedBases,
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
          mode: measuredMode,
          ids: matrix.ids,
          minutes: matrix.minutes,
          km: matrix.km,
          provenance: matrix.provenance,
        }),
        /**
         * Evidence is kept for every subject we researched, including the ones
         * that came back empty. A place with an all-`unknown` evidence record is
         * a place we asked about and got nothing for, and the board says so —
         * which is a different message from a place nobody looked at.
         */
        evidence,
        ...(pack
          ? {
              regionPack: {
                packId: pack.id,
                scopeHash: pack.scopeHash,
                contentHash: pack.contentHash,
                state: pack.state,
                catalog: pack.releases[0]?.catalog ?? 'unknown',
                releaseId: pack.releases[0]?.releaseId ?? 'unknown',
                recordCount: pack.diagnostics.featuresRetained,
                builtAt: pack.createdAt,
                reused: packReused,
              },
            }
          : {}),
        licences: [...licences.values()],
        sourceManifest: {
          facts,
          pages,
          providers: [
            { name: input.providers.expansion.name, version: '1', calls: ledger.spent('maxModelCalls'), failures: 0 },
            { name: input.providers.routing.name, version: '1', calls: 1, failures: matrix.failedPairs.length },
            {
              name: input.providers.sourceDiscovery.name,
              version: '1',
              calls: ledger.spent('maxSourceSearches'),
              failures: 0,
            },
            {
              name: input.providers.retrieval.name,
              version: '1',
              calls: pages.length,
              failures: pages.filter((page) => page.contentBytes === 0).length,
            },
            {
              name: input.providers.extraction.name,
              version: EXTRACTION_SCHEMA_VERSION,
              calls: ledger.spent('maxExtractionCalls'),
              failures: 0,
            },
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
          promptVersions,
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

/**
 * A first-pass fit, from interests alone.
 *
 * Deliberately not `scorePlace` — that needs an access assessment, an hours
 * assessment and a weather assessment, none of which exist this early, and
 * inventing them to get a number would make the number meaningless. What this
 * answers is narrower and honestly so: does this look like the kind of thing
 * they said they came for? That is enough to decide what to spend money
 * researching, and the real scorer runs later on the board.
 */
function roughFit(place: Place, profile: TravelerProfile | undefined): number {
  if (!profile) return 0.5;
  const levels = profile.interests as Partial<Record<Interest, string>>;
  let best = 0;
  for (const interest of place.interests) {
    const level = levels[interest];
    const value =
      level === 'core' ? 1 : level === 'frequent' ? 0.8 : level === 'occasional' ? 0.5 : level === 'rare' ? 0.25 : 0;
    if (value > best) best = value;
  }
  // Nothing matching is not zero: an unmatched place can still be a good stop,
  // and zeroing it here would make the funnel spend only on confirmations.
  return Math.max(0.2, best);
}

function detourTolerance(profile: TravelerProfile | undefined): number {
  return Math.max(20, profile?.detourToleranceMinutes ?? 90);
}

/** The operator's own domain, where the map data already carried one. */
function officialUrlOf(place: Place): string | undefined {
  const url = place.source.element?.url ?? place.source.url;
  if (!url) return undefined;
  // The element URL points back at the map database, not at the operator. Only
  // a URL that is neither is worth calling official.
  if (/openstreetmap\.org|wikidata\.org|wikipedia\.org/i.test(url)) return undefined;
  return url;
}

/**
 * Whether not knowing this one's hours would change a plan.
 *
 * A trailhead has no hours to find, and searching for them burns the most
 * expensive counter in the compiler to learn nothing. A museum's hours decide
 * whether the day works. The split is by category rather than by name, so it is
 * the same judgement in every country.
 */
function isPlausiblyGated(place: Place): boolean {
  return (
    place.category === 'museum' ||
    place.category === 'historic_site' ||
    place.category === 'gondola_or_tram' ||
    place.category === 'national_monument' ||
    place.category === 'hot_spring' ||
    place.category === 'town_and_food' ||
    place.category === 'wildlife_area'
  );
}

/**
 * Which questions to ask about a subject.
 *
 * Asking every path about every subject would multiply the extraction prompt by
 * twenty-one for no gain — a restaurant has no permit and a trailhead has no
 * timed entry. Asking the wrong ones is worse than expensive: an extractor
 * pressed for a fact a page does not contain is an extractor being invited to
 * infer one.
 */
function wantedPathsFor(
  subjectId: string,
  food: readonly FoodVenue[],
  place?: Place,
): FactPath[] {
  /**
   * `identity.officialSite` is deliberately absent from both lists.
   *
   * It is answered by a structured source — an OSM `website` tag or a Wikidata
   * P856 claim — and never by extraction, because a model naming somebody's
   * official domain is exactly the thing this architecture refuses. Asking for
   * it here would add one guaranteed `unknown` per subject to the coverage
   * count and describe a gap that is not one.
   */
  const isFood = food.some((venue) => venue.id === subjectId);
  if (isFood) {
    return ['food.hours', 'food.price', 'food.reservation', 'food.dietary'];
  }

  /**
   * Everything, but only for the kinds of place that gate.
   *
   * A live New York build asked eleven questions of twenty-four subjects and got
   * ten answers out of two hundred and nine — because most of the subjects were
   * public parks, and a public park has no timed entry, no permit and no
   * admission price to find. Those were not gaps: they were questions with no
   * answer, and asking a model for one is precisely the invitation to infer that
   * this architecture refuses.
   *
   * Split on the *category*, so it is the same judgement in every country.
   */
  const shared: FactPath[] = [
    'hours.closure',
    'safety.caution',
    'safety.requirement',
    'duration.typical',
  ];
  if (place && !isPlausiblyGated(place)) {
    return [...shared, 'hours.weekly', 'cost.parking'];
  }
  return [
    ...shared,
    'hours.weekly',
    'booking.required',
    'booking.timedEntry',
    'booking.leadTime',
    'access.permit',
    'cost.admission',
    'cost.parking',
  ];
}

/**
 * Which network the travel-time matrix is measured on.
 *
 * `foot` only when the traveller is walking **and** the ground is walkable. Every
 * other mode a scope allows — a bus, a train, a shuttle, a rideshare, a ferry
 * approach — moves along roads, so a road matrix is the closest honest
 * measurement of how long a leg takes. A walking matrix over a national park is
 * not a conservative answer; it is no answer, and a live evaluation had two
 * destinations fail outright on exactly that.
 *
 * The threshold is the same reach the scope derivation uses for a walking trip,
 * so the two cannot disagree about what "walkable" means.
 */
const WALKABLE_SPAN_KM = 12;

export function matrixModeFor(scope: GeographicScope): 'car' | 'foot' {
  if (scope.transport.primaryMode === 'drive') return 'car';
  const bounds = scopeBounds(scope);
  const latKm = (bounds.northEast.lat - bounds.southWest.lat) * 111;
  const lngKm =
    (bounds.northEast.lng - bounds.southWest.lng) *
    111 *
    Math.max(0.1, Math.cos((scope.center.lat * Math.PI) / 180));
  return Math.max(latKm, lngKm) <= WALKABLE_SPAN_KM ? 'foot' : 'car';
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
  /**
   * `placesWithinReach` is a claim, and it has to be one that survives checking.
   *
   * It was every place the compiler happened to be holding when the bases were
   * built — which is *before* the matrix drops the unroutable ones, so a live
   * artifact claimed forty-three places within reach of a base that ended up
   * with thirty-seven in the region at all, none of them actually within the
   * traveller's daily drive.
   */
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
  // First wins, so the caller's ordering is the precedence. `new Map(...)` over
  // the same list would have let the weakest source overwrite the strongest.
  const byPlace = new Map<string, OperatingCalendar>();
  for (const calendar of calendars) {
    if (!byPlace.has(calendar.placeId)) byPlace.set(calendar.placeId, calendar);
  }
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
