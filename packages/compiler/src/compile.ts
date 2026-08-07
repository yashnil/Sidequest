import {
  COMPILED_REGION_VERSION,
  FOOD_DATASET_VERSION,
  OPERATING_HOURS_DATASET_VERSION,
  assessCandidateQuality,
  breadthRank,
  checkRegionIntegrity,
  requiredAttributions,
  EVIDENCE_STORE_VERSION,
  extractionContract,
  factSetKeyFor,
  resolutionKey,
  shelfLifeFor,
  scopeFingerprint,
  selectBases,
  subjectKeyFor,
  travelTimeMatrixSchema,
  type AccessDataset,
  type BaseCandidate,
  COMPILATION_OPERATIONAL_VERSION,
  type CompilationErrorCode,
  type CompilationOperational,
  type CompilationStage,
  type CompiledRegion,
  type DataLicence,
  type DisplayName,
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
  type EvidenceClaimRecord,
  type ResolvedFact,
  type SatelliteCandidate,
  type SourceFact,
  type StageRecord,
  type ReconcileOutcome,
  type RemovalStage,
  type Subregion,
  type TravelerProfile,
  type WorkPlanEntry,
} from '@sidequest/core';
import { BudgetLedger, budgetFor, type CompilerBudget } from './budget';
import { buildCoverageReport } from './coverage';
import { dedupeCandidates } from './dedupe';
import { buildProvisionalBoard } from './provisional';
import type { ProvisionalBoard, ResearchPriorityHints } from '@sidequest/core';
import {
  EXTRACTION_SCHEMA_VERSION,
  buildEvidence,
  prioritiseSubjects,
} from './enrich';
import { claimCoverage, factsFromClaims, shareableResolution, toClaimRecords } from './claims';
import type { RegionPackOutcome } from './backbone/pack';
import { partitionScope, scopeBounds } from './backbone/partition';
import type {
  CompilerProviders,
  DiscoveryQuery,
  ProviderGap,
  DiscoveryResult,
  ResearchSubject,
  RoutingMatrixResult,
  TripIncludedArea,
} from './providers';
import {
  assignToClusters,
  routeHierarchically,
  type HierarchicalRoutingResult,
} from './routing';

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
  /**
   * Where this build records work it decided *not* to do.
   *
   * The shared evidence layer reports its own reuse, but it can only report on
   * calls it received. When durable claims answer a subject outright, discovery,
   * retrieval and extraction are never called at all — so the stage that saved
   * the most money would be the one stage the traveller could not see. These
   * notes come from the compiler because the compiler is what took the decision.
   */
  onWorkPlanNote?: (entry: WorkPlanEntry) => void;
  /**
   * The board as it stands at the cut, before anything is bought.
   *
   * Emitted exactly once, synchronously, and never awaited: a compilation must
   * not become slower or able to fail because somebody is watching it. Modelled
   * on `onWorkPlanNote` — the compiler reports, the caller decides whether to
   * persist.
   */
  onProvisionalBoard?: (board: ProvisionalBoard) => void;
  /**
   * What the traveller marked on a previous provisional board.
   *
   * A **priority signal, never a promise**. It reorders who gets the research
   * subjects the budget already allows; it cannot buy an extra one. So pinning
   * a hundred places changes which twenty-four are looked up and changes the
   * spend not at all — which is the property that keeps a button from being a
   * meter.
   *
   * And it cannot make a closed museum open: a pinned place still has to
   * survive evidence, access and routing exactly as an unpinned one does.
   */
  priorityHints?: ResearchPriorityHints;
}

/**
 * WHY SOMETHING THAT WAS ON THE EARLY BOARD IS NOT ON THE FINISHED ONE.
 *
 * One entry per place the provisional cut showed and the artifact does not, in
 * the words of the stage that removed it.
 *
 * It travels on the **result**, never on the `CompiledRegion`. A removal is a
 * fact about this run — two builds of the same destination a month apart remove
 * different things for different reasons — and folding it into the artifact
 * would make an immutable record of the region depend on what happened to be
 * shut the week somebody compiled it.
 *
 * Without this the reconciliation panel resolved every removal to
 * `removed_insufficient_support`, which is honest and nearly useless: a traveller
 * whose pinned pass was gated until June, and one whose pinned lake had no
 * measurable road to it, were told the same sentence.
 */
export interface PlaceRemoval {
  placeId: string;
  outcome: ReconcileOutcome;
  /** The specific sentence, where a stage produced one. Never invented here. */
  detail?: string;
  /**
   * Which stage produced that sentence.
   *
   * Without it, the account downstream attaches any gap for a subject to any
   * removal of that subject — so a note from the evidence stage could replace the
   * outcome sentence for a routing failure, explaining the wrong thing in a more
   * convincing voice than the generic copy it displaced.
   */
  detailStage?: RemovalStage;
}

/**
 * The envelope. The artifact, what happened to the board, and what it cost.
 *
 * `operational` travels here for exactly the reason `removals` does, and the
 * boundary is written out in full in `schemas/compiled-region.ts`: a semantic
 * artifact must not change because one run had a cache hit and another had a
 * cache miss. Everything that does — the ledger's spend, the ceilings, the
 * reuse counters, the provider call counts, which stages ran — is a fact about
 * *this run* and is persisted as the job's operational diagnostics.
 *
 * It is present on the **failure** branch too. A build that failed at the last
 * gate has already paid for every search, page and model call before it, and
 * "we do not know what the failures cost" is the shape of an unbounded bill.
 */
export type CompileResult =
  | {
      ok: true;
      region: CompiledRegion;
      partial: boolean;
      removals: PlaceRemoval[];
      operational: CompilationOperational;
    }
  | {
      ok: false;
      code: CompilationErrorCode;
      message: string;
      operational: CompilationOperational;
    };

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
/**
 * Gap reasons that mean something went wrong, as opposed to something was not
 * there.
 *
 * `not_found`, `no_official_source` and `insufficient_evidence` are ordinary
 * outcomes of looking: nobody publishes this, and the coverage report says so.
 * These three are the pipeline itself struggling, and a run that hit one is not
 * comparable to one that did not — which is what `degraded` is for.
 */
const DEGRADING_GAP_REASONS: ReadonlySet<ProviderGap['reason']> = new Set([
  'provider_error',
  'rate_limited',
  'budget_exhausted',
]);

/**
 * A claim past its own shelf life does not count as coverage.
 *
 * Judged from the **content** clock: a claim read six months ago is six months
 * old however many times the page has been revalidated since. That asymmetry is
 * the rule the whole phase turns on, and it is why coverage is decided here
 * rather than by asking whether we happen to hold a row.
 */
function claimIsFresh(claim: EvidenceClaimRecord, now: Date): boolean {
  const observed = Date.parse(claim.contentObservedAt);
  if (Number.isNaN(observed)) return false;
  const ageDays = (now.getTime() - observed) / 86_400_000;
  return ageDays <= shelfLifeFor(claim.factPath);
}

/**
 * One claim id is one claim, however many places it arrived from.
 *
 * A held claim and a freshly-observed one can be byte-identical — that is the
 * point of a deterministic id — and counting it twice would look like
 * corroboration to anything counting rows.
 */
function dedupeClaims(claims: readonly EvidenceClaimRecord[]): EvidenceClaimRecord[] {
  const byId = new Map<string, EvidenceClaimRecord>();
  for (const claim of claims) byId.set(claim.id, claim);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function compileRegion(input: CompileInput): Promise<CompileResult> {
  let sharedResolutionsReused = 0;
  const startedAtMs = input.now.getTime();
  const limits = budgetFor({
    nights: input.scope.nights,
    breadthRank: breadthRank(input.scope.breadth),
    ...(input.budget ? { base: input.budget } : {}),
  });
  const ledger = new BudgetLedger(limits, startedAtMs);

  const stages: StageRecord[] = [];
  /**
   * Which stages ran, in the order they ran. Never how long they took, and no
   * longer on the artifact.
   *
   * This used to be `{ stage, ms: 1 }` — the injected clock's step size,
   * hard-coded, presented as a measurement. Real durations are observed on a
   * real clock and persisted per run in `stage_observations`. The *sequence*
   * moved out of the artifact too: which stages a build runs depends on which
   * providers it was configured with, so it is a fact about the run.
   */
  const timings: { stage: string }[] = [];
  const gaps: ProviderGap[] = [];
  const facts: SourceFact[] = [];
  /**
   * THE RETRIEVAL LOG. What this run downloaded, and what refused it.
   *
   * Operational, and no longer what the artifact carries. It used to be
   * `sourceManifest.pages` directly, which meant a warm build — one that
   * answers most of its subjects from durable claims and never calls retrieval
   * for them — listed nine pages where a cold build of the same region listed
   * thirty-three. That was not a smaller region; it was a smaller bill, and the
   * warm artifact then understated what it rests on.
   *
   * The artifact's page list is derived from its retained facts instead (see
   * `provenancePages` below), so it names the same pages either way. Bytes,
   * titles-as-fetched and refusals stay here, where they are true.
   *
   * Bodies are deliberately not kept, on either side.
   */
  const pages: RetrievedPage[] = [];
  const promptVersions: Record<string, string> = {};
  /** Unioned from whatever the providers declared. Never assumed. */
  const licences = new Map<string, DataLicence>();
  const warnings: string[] = [];
  let elapsed = 0;

  /** Records a decision this build took to skip work it would otherwise buy. */
  const noteWork = (entry: WorkPlanEntry): void => {
    input.onWorkPlanNote?.(entry);
  };

  /**
   * ONE STAGE, AGAINST TWO CLOCKS.
   *
   * The artifact is timed against the *injected* clock, advanced one step per
   * stage, so that two runs of the same inputs return byte-identical bytes.
   * `compiler.test.ts` asserts exactly that, and it is worth keeping: a compiler
   * whose pure output wobbles is one nobody can diff.
   *
   * But that ordinal was also the only timing anybody had, and it was being read
   * as a duration. Every stage reported one millisecond, so the per-phase elapsed
   * figure was always zero and the remaining-time estimate — computed from a
   * one-millisecond median — told a traveller their four-minute build had
   * "roughly 0s–0s to go". A progress screen that confidently reports nothing is
   * worse than one that reports nothing.
   *
   * So there is a second clock, and it goes exactly one place: **the callback**.
   * `observedMs` and the observed timestamps are attached only to the record
   * handed to `onStage`, never to `stages` and never to `timings`. The artifact
   * therefore contains no real clock reading on any path — which makes the
   * determinism guarantee stronger than it was, because it is now structural
   * rather than incidental — and the job row, which is what the progress screen
   * actually reads, carries the truth.
   */
  /**
   * The stage currently in flight, so a failure can name it.
   *
   * Without it, a compilation that stopped had no record of the stage it
   * stopped in: the last `running` record was the last thing written, and
   * `groupStages` computes a phase's elapsed time as `now − start` for as long
   * as anything in it is running. A build that died eleven minutes ago read
   * "Verifying what matters — 11m" and kept counting, for ever.
   */
  let inFlight: CompilationStage | null = null;

  const runStage = async <T,>(
    stage: CompilationStage,
    work: () => Promise<{
      value: T;
      outcome: string;
      note?: string;
      skipped?: boolean;
      /** Items processed, where this stage has a natural unit. */
      workUnits?: number;
      /** Times this stage had to ask again. Absent where it never retries. */
      retries?: number;
    }>,
  ): Promise<T> => {
    const startedAt = new Date(startedAtMs + elapsed).toISOString();
    const wallStartedAt = new Date();
    inFlight = stage;
    /*
     * Watched from here, so "did anything go wrong during this stage" is a
     * measurement rather than a guess made afterwards from totals.
     */
    const gapsBefore = gaps.length;
    const exhaustedBefore = ledger.exhausted().length;
    input.onStage?.({
      stage,
      status: 'running',
      startedAt,
      observedStartedAt: wallStartedAt.toISOString(),
    });
    const result = await work();
    elapsed += 1;
    inFlight = null;
    const finishedAt = new Date(startedAtMs + elapsed).toISOString();

    /*
     * Degraded is not the same as failed, and the difference is what the
     * progress screen shows.
     *
     * A stage that read eighteen of twenty pages because a publisher
     * rate-limited us is `done` — it produced its result — and it is *not*
     * comparable to a stage that read all twenty, which is what the estimator
     * needs to know. `status: 'failed'` stays reserved for a stage that could
     * not do its job at all, because `groupStages` turns one of those into a
     * failed phase.
     */
    const degraded =
      gaps.slice(gapsBefore).some((gap) => DEGRADING_GAP_REASONS.has(gap.reason)) ||
      ledger.exhausted().length > exhaustedBefore;

    const record: StageRecord = {
      stage,
      status: result.skipped ? 'skipped' : 'done',
      startedAt,
      finishedAt,
      outcome: result.outcome,
      ...(result.note ? { note: result.note } : {}),
      ...(result.workUnits === undefined ? {} : { workUnits: result.workUnits }),
      ...(result.retries === undefined ? {} : { retries: result.retries }),
      ...(degraded ? { degraded: true } : {}),
    };
    stages.push(record);
    timings.push({ stage });
    input.onStage?.({
      ...record,
      observedStartedAt: wallStartedAt.toISOString(),
      observedFinishedAt: new Date().toISOString(),
    });
    return result.value;
  };

  /**
   * WHAT THIS RUN COST, ASSEMBLED WHENEVER IT ENDS.
   *
   * Built at the exit rather than accumulated, because every input is already
   * held: the ledger, the gaps, the stage sequence and the claim counters. It
   * is returned on the success branch and on every failure branch — a build
   * that stopped at the last gate has already paid for everything before it.
   */
  const operationalNow = (
    counters: {
      claimsHeld?: number;
      claimsObserved?: number;
      claimsSuperseded?: number;
      subjectsAnsweredFromClaims?: number;
    } = {},
  ): CompilationOperational => {
    const snapshot = ledger.snapshot();
    const degradedReasons = [
      ...new Set([
        ...snapshot.exhausted.map((counter) => `budget_exhausted:${counter}`),
        ...gaps
          .filter((gap) => DEGRADING_GAP_REASONS.has(gap.reason))
          .map((gap) => `provider:${gap.reason}`),
        ...(stages.some((record) => record.status === 'failed') ? ['stage_failed'] : []),
      ]),
    ].sort();

    return {
      schemaVersion: COMPILATION_OPERATIONAL_VERSION,
      budget: snapshot,
      stages: [...timings],
      providers: providerCallCounts(),
      sharedEvidence: {
        claimsHeld: counters.claimsHeld ?? 0,
        claimsObserved: counters.claimsObserved ?? 0,
        claimsSuperseded: counters.claimsSuperseded ?? 0,
        subjectsAnsweredFromClaims: counters.subjectsAnsweredFromClaims ?? 0,
        sharedResolutionsReused,
      },
      retrieval: {
        pagesRead: pages.filter((page) => page.contentBytes > 0).length,
        pagesRefused: pages.filter((page) => page.contentBytes === 0).length,
        bytesRead: pages.reduce((total, page) => total + page.contentBytes, 0),
      },
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  };

  /**
   * The pages the artifact's facts rest on, from the facts themselves.
   *
   * One entry per distinct page a retained fact cites, carrying the page's own
   * content hash and the moment its **content** was observed — which a fact
   * rebuilt from a durable claim inherits from the claim, so a page held for
   * six months is honestly six months old rather than freshly stamped.
   *
   * `robotsAllowed` is true by construction: a fact exists only because the
   * page was read, and a page that robots refused produced no fact. Bytes and
   * the title as fetched are absent, because a page answered from a claim was
   * not fetched this time and nobody measured either.
   *
   * Sorted, so two builds serialise identically.
   */
  type ArtifactPage = CompiledRegion['sourceManifest']['pages'][number];
  const provenancePages = (): ArtifactPage[] => {
    const byKey = new Map<string, ArtifactPage>();
    for (const fact of facts) {
      if (!fact.sourceUrl) continue;
      const key = `${fact.sourceUrl}\u0000${fact.contentHash ?? ''}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        url: fact.sourceUrl,
        retrievedAt: fact.retrievedAt,
        ...(fact.contentHash ? { contentHash: fact.contentHash } : {}),
        robotsAllowed: true,
      });
    }
    return [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, page]) => page);
  };

  /** Provider call counts. Off the artifact, because a warm store changes them. */
  const providerCallCounts = (): CompilationOperational['providers'] => [
    {
      name: input.providers.expansion.name,
      version: '1',
      calls: ledger.spent('maxModelCalls'),
      failures: 0,
    },
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
  ];

  /**
   * Stop, having said which stage stopped and why.
   *
   * Every `ok: false` goes through here. Before it existed, no code path in the
   * whole compiler emitted a `StageRecord` with `status: 'failed'` — so
   * `PhaseStatus` could never be `failed`, every degraded run was written into
   * the estimator's healthy bucket, and the stage that was in flight when a
   * build died stayed `running` for as long as the row existed.
   */
  const fail = (
    code: CompilationErrorCode,
    message: string,
    counters?: Parameters<typeof operationalNow>[0],
  ): CompileResult => {
    /*
     * The stage that was running, or — when the compilation stopped *between*
     * stages — the one whose result is the reason it cannot continue. Both are
     * the honest answer to "where did this stop": `expanding_region` finishing
     * with no base at all is that stage failing to do its job, whatever its
     * outcome line said.
     */
    const stage = inFlight ?? stages[stages.length - 1]?.stage;
    if (stage) {
      const previous = stages.findIndex((entry) => entry.stage === stage);
      const stamp = new Date(startedAtMs + elapsed).toISOString();
      const wall = new Date().toISOString();
      const record: StageRecord = {
        stage,
        status: 'failed',
        startedAt: previous >= 0 ? (stages[previous]!.startedAt ?? stamp) : stamp,
        finishedAt: stamp,
        outcome: message,
        note: message,
        degraded: true,
      };
      if (previous >= 0) stages[previous] = record;
      else stages.push(record);
      input.onStage?.({ ...record, observedStartedAt: wall, observedFinishedAt: wall });
    }
    inFlight = null;
    return { ok: false, code, message, operational: operationalNow(counters) };
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
          workUnits: merged + unresolved,
        };
      });
    } else {
      /**
       * NO BACKBONE PROVIDER, AND FOUR STAGES THAT MUST STILL SAY SO.
       *
       * The comment above this branch has promised since the backbone landed
       * that "a build with no backbone provider records all four as skipped".
       * It did not. Nothing was recorded at all, so `displayStages` synthesised
       * four `waiting` rows, `groupStages` saw a *shaping* phase with stages
       * that never finished, and the phase read "Working" for the whole
       * compilation and then for ever afterwards on a finished job.
       *
       * A skipped stage with a reason is a visible, explicable state. A stage
       * that never reports is indistinguishable from one that hung.
       */
      const noProvider =
        'No regional place data is configured for this build, so the map layer was not read.';
      for (const stage of [
        'partitioning_scope',
        'building_region_pack',
        'resolving_source_release',
        'linking_sources',
      ] as const) {
        await runStage(stage, async () => ({
          value: null,
          outcome: 'no regional place data configured',
          note: noProvider,
          skipped: true,
        }));
      }
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
        workUnits: value.bases.length + value.subregions.length,
      };
    });

    if (expansion.bases.length === 0) {
      return fail(
        'no_plausible_base',
        'We could not find anywhere sensible to stay inside that region.',
      );
    }

    // ---- Stage: discover candidates -----------------------------------------
    /*
     * The supply account, captured beside the stage rather than inside its
     * value. The stage returns the candidate list; what the board needs is the
     * shape of what was *not* in it.
     */
    let boardSupply: DiscoveryResult['boardSupply'];
    const discovered = await runStage('discovering_candidates', async () => {
      const queries = buildQueries(input.scope, input.profile, ledger.remaining('maxCoarseCandidates'));
      /*
       * THE EXPANSION'S AREAS, HANDED TO THE CONTAINMENT GATE.
       *
       * This is the ordering CS-8 turned on. A satellite and a regional
       * expansion member are the only relationships that admit a record outside
       * the destination's own boundary, and both require that something asked
       * for the area. The expansion is what asks, it has just run, and this is
       * the first moment its answer and the candidate set exist together.
       *
       * A base is `included` — the trip is staying there. A subregion is
       * `optional` — it was proposed and stays labelled until something takes it
       * up. Nothing here is derived from a distance.
       */
      const includedAreas: TripIncludedArea[] = [
        ...expansion.bases.map((base) => ({
          id: base.id,
          name: base.name,
          reason: 'expansion_base' as const,
          status: 'included' as const,
          center: base.coordinates,
        })),
        ...expansion.subregions.map((subregion) => ({
          id: subregion.id,
          name: subregion.name,
          reason: 'expansion_subregion' as const,
          status: 'optional' as const,
          center: subregion.center,
          radiusKm: subregion.radiusKm,
        })),
      ];
      const value = await input.providers.places.discover({
        scope: input.scope,
        queries,
        includedAreas,
        ...(input.profile ? { profile: input.profile } : {}),
        ...(pack ? { pack } : {}),
      });
      ledger.record('maxModelCalls', value.calls);
      boardSupply = value.boardSupply;
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
        /*
         * A supply shortage outranks a density cap.
         *
         * The inventory pushes "there is not enough here to plan around" as
         * `not_found` and "we already have enough of this kind" as
         * `budget_exhausted`, twenty lines apart. With the cap ranked higher, a
         * genuinely thin region explained itself as though it were a rich one
         * we had trimmed — which is the opposite of what happened and the
         * opposite of what a traveller should do about it.
         */
        'not_found',
        'budget_exhausted',
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
        workUnits: kept.length,
        ...(note ? { note } : {}),
      };
    });

    // ---- Stage: deduplicate --------------------------------------------------
    const deduped = await runStage('deduplicating', async () => {
      const value = dedupeCandidates(discovered);
      return {
        value: value.candidates,
        outcome: `${value.candidates.length} distinct places, ${value.mergedCount} duplicates merged`,
        workUnits: value.candidates.length,
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
        workUnits: kept.length,
        ...(dropped > 0 ? { note: `${dropped} did not make the shortlist for this trip's length.` } : {}),
      };
    });

    if (shortlisted.length === 0) {
      return fail(
        'coverage_insufficient',
        'We could not find anything here we could describe well enough to plan around.',
      );
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
        workUnits: kept.length + dropped.length,
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
      return fail(
        'coverage_insufficient',
        'Everything we found here is a name on a map with nothing published about it.',
      );
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
        workUnits: value.accessRules.length + value.calendars.length,
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
      return fail(
        'coverage_insufficient',
        'We could not establish how to reach anything here, so there is nothing we would put in a plan.',
      );
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
        workUnits: value.venues.length,
        skipped: value.venues.length === 0,
      };
    });

    /**
     * ---- THE CUT -------------------------------------------------------------
     *
     * Everything above this line is deterministic or map-derived. The next stage
     * begins the research funnel, and `discovering_sources` below it is the
     * first call anybody pays for. So this is the last moment at which a board
     * can be shown having spent nothing — and the last moment at which nothing
     * on it has been verified.
     *
     * `AVAILABILITY_AFTER.finding` has promised "a provisional board — nothing
     * on it is verified yet" since Phase 11 and there has never been one. This
     * is it.
     *
     * The emission is synchronous, cannot throw into the pipeline, and carries
     * no `Place` — see `provisional.ts` for why handing one out would put six
     * unmeasured defaults on a card, of which `travelFromBase: {0, 0}` is only
     * the most dangerous.
     */
    if (input.onProvisionalBoard) {
      try {
        input.onProvisionalBoard(
          buildProvisionalBoard({
            boardId: `provisional-${input.compilationId}`,
            tripId: input.scope.destinationCandidateId,
            jobId: input.compilationId,
            scopeFingerprint: scopeFingerprint(input.scope),
            version: 1,
            candidates: qualityFiltered.filter((candidate) =>
              places.some((place) => place.id === candidate.place.id),
            ),
            bases,
            ...(input.profile ? { profile: input.profile } : {}),
            calendarSubjectIds: new Set(
              research.calendars.map((calendar) => calendar.placeId),
            ),
            counts: {
              discovered: discovered.length,
              deduped: deduped.length,
              shortlisted: shortlisted.length,
              retained: places.length,
              droppedThin: shortlisted.length - qualityFiltered.length,
              droppedNoAccessRule: droppedForAccess,
            },
            now: input.now,
          }),
        );
      } catch (error) {
        /*
         * A board nobody could build is a board nobody sees. It is not a reason
         * to fail a compilation that is otherwise going fine, so it is a warning
         * rather than a throw.
         */
        warnings.push('We could not put together an early look at what we found.');
        void error;
      }
    }

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
          fitScore: withPriority(place.id, roughFit(place, input.profile), input.priorityHints),
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
        workUnits: value.length,
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

    /**
     * WHAT WE ALREADY KNOW, BEFORE ANYTHING IS BOUGHT.
     *
     * Durable claims are facts about places, so a second trip past the same
     * museum reads the first trip's research instead of paying for it again. A
     * subject whose every question is answered by a claim still inside its own
     * shelf life is removed from the funnel entirely — no search, no fetch, no
     * model call.
     *
     * Freshness is the claim's own, judged from the **content** clock. A claim
     * read six months ago is six months old however many times the page has been
     * revalidated since, which is the rule the whole phase turns on.
     */
    const subjectKeys = new Map<string, string>(
      subjects.map((subject) => [
        subject.id,
        subjectKeyFor({ name: subject.name, coordinates: subject.coordinates }),
      ]),
    );
    const subjectIdsByKey = new Map<string, string>(
      [...subjectKeys.entries()].map(([id, key]) => [key, id]),
    );

    /**
     * The contract a research attempt is remembered under.
     *
     * Changing the prompt, the schema, the model or the parser means the answer
     * could genuinely differ, so a remembered attempt under the old contract does
     * not excuse asking again. Read from the provider rather than guessed, so the
     * key is the same on the way in as on the way out.
     */
    const researchContract = extractionContract({
      promptVersion: input.providers.extraction.promptVersion,
      schemaVersion: input.providers.extraction.schemaVersion,
      modelId: input.providers.extraction.modelId ?? 'none',
      parserVersion: EXTRACTION_SCHEMA_VERSION,
    });

    let heldClaims: EvidenceClaimRecord[] = [];
    const outstanding = await runStage('reusing_shared_claims', async () => {
      const store = input.providers.claims;
      if (!store || subjects.length === 0) {
        return {
          value: subjects,
          outcome: 'nothing held yet',
          skipped: true,
          ...(store ? {} : { note: 'This build has nowhere to keep durable evidence.' }),
        };
      }

      const byKey = store.load([...subjectKeys.values()]);
      heldClaims = [...byKey.values()].flat();

      const coverage = claimCoverage({
        subjects,
        subjectKeys,
        claimsBySubjectKey: byKey,
        isFresh: (claim) => claimIsFresh(claim, input.now),
        attempts: store.loadAttempts([...subjectKeys.values()]),
        contract: researchContract,
        now: input.now,
      });

      if (coverage.covered.length > 0) {
        noteWork({
          step: 'reusing_shared_claims',
          decision: 'reusable',
          reason:
            `${coverage.covered.length} of ${subjects.length} were already researched, so ` +
            `${coverage.pathsCovered} facts came from evidence this trip did not pay for.`,
          items: coverage.covered.length,
        });
      }

      return {
        value: coverage.outstanding,
        outcome: `${coverage.covered.length} of ${subjects.length} already answered, ${coverage.pathsCovered} facts reused`,
        workUnits: subjects.length,
        ...(coverage.outstanding.length > 0
          ? { note: `${coverage.outstanding.length} still need looking up.` }
          : {}),
      };
    });

    const references = await runStage('discovering_sources', async () => {
      if (outstanding.length === 0) {
        noteWork(
          subjects.length > 0
            ? {
                step: 'discovering_sources',
                decision: 'reusable',
                reason: 'Every subject was already answered, so no searches were bought.',
                items: subjects.length,
              }
            : {
                step: 'discovering_sources',
                decision: 'unavailable',
                reason: 'Nothing on this trip needed a publisher looking up.',
                items: 0,
              },
        );
        return {
          value: [],
          outcome:
            subjects.length > 0 ? 'every subject was already answered' : 'nothing to look up',
          skipped: true,
        };
      }
      const budgetLeft = ledger.remaining('maxSourceSearches');
      const result = await input.providers.sourceDiscovery.discover({
        scope: input.scope,
        subjects: outstanding,
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
        workUnits: result.references.length,
        ...(fromStructured > 0
          ? { note: `${fromStructured} came from the map data or an open database and cost nothing.` }
          : {}),
      };
    });

    const documents = await runStage('retrieving_pages', async () => {
      if (references.length === 0) {
        noteWork({
          step: 'retrieving_pages',
          decision: outstanding.length === 0 ? 'reusable' : 'unavailable',
          reason:
            outstanding.length === 0
              ? 'No page needed reading: the facts were already held from an earlier read.'
              : 'There was no official page to read for what was still missing.',
          items: 0,
        });
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
      /**
       * Charged for what was actually asked for, not for what came back.
       *
       * Once evidence is shared, a warm build returns pages it already held and
       * requested from nobody. Charging those to the page budget would report a
       * cost that was never paid — and, on a long shortlist, would exhaust a
       * counter on reuse and then refuse to read the pages that genuinely needed
       * reading.
       */
      ledger.take(
        'maxPagesFetched',
        (result.requested ?? result.documents.length) + result.rejected.length,
      );
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
        workUnits: result.documents.length + result.rejected.length,
        ...(result.rejected.length > 0
          ? { note: result.rejected[0]!.detail }
          : {}),
      };
    });

    const extraction = await runStage('extracting_facts', async () => {
      if (documents.length === 0) {
        noteWork({
          step: 'extracting_facts',
          decision: outstanding.length === 0 ? 'reusable' : 'unavailable',
          reason:
            outstanding.length === 0
              ? 'Nothing was read into facts again: the same pages had already been read under this contract.'
              : 'There was nothing to read facts out of.',
          items: 0,
        });
        return {
          value: {
            records: [] as EvidenceClaimRecord[],
            supersededIds: [] as string[],
            discarded: 0,
          },
          outcome:
            outstanding.length === 0 ? 'everything was already known' : 'nothing to read facts out of',
          skipped: true,
        };
      }
      const allowedCalls = ledger.remaining('maxExtractionCalls');
      const result = await input.providers.extraction.extract({
        subjects: outstanding,
        documents,
        dates: input.dates,
        maxCalls: allowedCalls,
      });
      ledger.take('maxExtractionCalls', result.calls);
      ledger.record('maxModelCalls', result.calls);
      gaps.push(...result.gaps);
      promptVersions.extractFacts = result.promptVersion;
      promptVersions.extractionSchema = EXTRACTION_SCHEMA_VERSION;

      /**
       * Extraction produces **claims**, not facts.
       *
       * A claim is durable and traveller-independent; a fact is this
       * compilation's reading of it. Building the claim first is what lets the
       * next trip past this museum skip everything above.
       */
      const converted = toClaimRecords({
        claims: result.claims,
        documents,
        subjectKeys,
        promptVersion: result.promptVersion,
        schemaVersion: result.schemaVersion,
        modelId: result.modelId ?? 'none',
        parserVersion: EXTRACTION_SCHEMA_VERSION,
        existing: heldClaims,
        now: input.now,
      });

      input.providers.claims?.save({
        records: converted.records,
        supersededIds: converted.supersededIds,
        now: input.now,
      });

      /**
       * That we asked, recorded whatever came back.
       *
       * Including — especially — the subjects that yielded nothing. A silence
       * remembered is a search not bought again next week, and a silence
       * forgotten is the single largest avoidable cost in this pipeline.
       */
      input.providers.claims?.saveAttempts({
        now: input.now,
        attempts: outstanding.flatMap((subject) => {
          const subjectKey = subjectKeys.get(subject.id);
          if (!subjectKey) return [];
          return [
            {
              schemaVersion: EVIDENCE_STORE_VERSION,
              subjectKey,
              contract: researchContract,
              wantedPaths: [...subject.wantedPaths].sort(),
              attemptedAt: input.now.toISOString(),
              claimsFound: converted.records.filter((record) => record.subjectKey === subjectKey)
                .length,
            },
          ];
        }),
      });

      return {
        value: converted,
        outcome: `${converted.records.length} facts from ${documents.length} pages`,
        workUnits: documents.length,
        ...(converted.discarded > 0
          ? {
              note: `${converted.discarded} claims were thrown away for having no quotable basis or a shape we could not read.`,
            }
          : {}),
      };
    });

    /**
     * Everything durable we hold about these subjects, old and new together.
     *
     * The held claims and the ones just observed are the same kind of thing and
     * are resolved as one body of evidence — which is what makes a warm
     * compilation produce the *same* answers as a cold one rather than a thinner
     * set. Superseded claims are dropped here; the store keeps them so an older
     * artifact stays explicable.
     */
    /**
     * What the shared claim layer saved this run — on the envelope, never here.
     *
     * These five were folded into `diagnostics.budget.consumed` from inside the
     * compiler, which is precisely how a warm store changed an artifact's bytes:
     * `claimsHeld` is zero on a cold build and non-zero on a warm one for the
     * same region, same sources, same dates. They are counts of operations and
     * they say nothing about how certain anything is, so nothing on a card, in a
     * coverage level or in a verification state reads them.
     */
    const claimCounters = {
      claimsHeld: heldClaims.length,
      claimsObserved: extraction.records.length,
      claimsSuperseded: extraction.supersededIds.length,
      subjectsAnsweredFromClaims: subjects.length - outstanding.length,
    };

    const supersededNow = new Set(extraction.supersededIds);
    const allClaims = [
      ...heldClaims.filter((claim) => !claim.superseded && !supersededNow.has(claim.id)),
      ...extraction.records,
    ];
    const projected = factsFromClaims({ claims: dedupeClaims(allClaims), subjectIds: subjectIdsByKey });
    facts.push(...projected.facts);

    const reconciled = await runStage('reconciling_facts', async () => {
      /**
       * Shared answers, for the questions whose answer is the same for
       * everybody.
       *
       * Where a museum's official site is, what it charges, whether it needs
       * booking — one answer, resolved once, keyed on the exact claim set behind
       * it. Whether it is *open on the fourteenth* is not in here and never will
       * be: `shareableResolution` is the gate, and a shared cache that answered a
       * dated question would be the most dangerous thing this store could hold.
       */
      const store = input.providers.claims;
      const wantedPairs = subjects.flatMap((subject) =>
        subject.wantedPaths.map((factPath) => ({ subject, factPath })),
      );
      const claimsByPair = new Map<string, string[]>();
      for (const fact of projected.facts) {
        if (!fact.factPath) continue;
        const key = resolutionKey(fact.subjectId, fact.factPath);
        claimsByPair.set(key, [...(claimsByPair.get(key) ?? []), fact.id]);
      }

      const setKeys = new Map<string, string>();
      for (const { subject, factPath } of wantedPairs) {
        if (!shareableResolution(factPath)) continue;
        const key = resolutionKey(subject.id, factPath);
        const subjectKey = subjectKeys.get(subject.id);
        if (!subjectKey) continue;
        setKeys.set(
          key,
          factSetKeyFor({
            subjectKey,
            factPath,
            claimIds: claimsByPair.get(key) ?? [],
            resolverVersion: store?.resolverVersion ?? 'none',
          }),
        );
      }

      const held = store ? store.loadFactSets([...setKeys.values()]) : new Map<string, ResolvedFact>();
      const preresolved = new Map<string, ResolvedFact>();
      for (const [key, setKey] of setKeys) {
        const entry = held.get(setKey);
        if (entry) preresolved.set(key, entry);
      }

      const value = buildEvidence({
        subjects,
        facts: projected.facts,
        payloads: projected.payloads,
        knownOfficialUrls,
        dates: input.dates,
        preresolved,
        now: input.now,
      });

      if (store) {
        const entries: { key: string; subjectKey: string; resolved: ResolvedFact }[] = [];
        for (const [key, setKey] of setKeys) {
          if (held.has(setKey)) continue;
          const resolved = value.byKey.get(key);
          const subjectKey = subjectKeys.get(resolved?.subjectId ?? '');
          if (resolved && subjectKey) entries.push({ key: setKey, subjectKey, resolved });
        }
        if (entries.length > 0) store.saveFactSets({ entries, now: input.now });
        sharedResolutionsReused = value.reusedResolutions;
      }
      const conflicted = value.resolved.filter((entry) => entry.state === 'conflicted').length;
      const known = value.resolved.filter(
        (entry) => entry.state !== 'unknown' && entry.state !== 'unavailable',
      ).length;
      return {
        value,
        outcome: `${known} of ${value.resolved.length} questions answered`,
        workUnits: value.resolved.length,
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
      return fail(
        'coverage_insufficient',
        'Everything we found here is closed on the dates you are travelling.',
      );
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

    /**
     * ---- Stage: travel times, hierarchically ---------------------------------
     *
     * The flat all-pairs matrix that used to live here is what made a
     * country-scale trip impossible. 126 points became 15,750 ordered pairs
     * against a 2,500-pair budget; 85% of the matrix was marked failed without
     * being requested, densification peeled it to 17 usable points, and the
     * compile failed for want of travel times it had decided not to buy.
     *
     * Now: places are assigned to the base they will actually be visited from,
     * one small matrix connects the bases, and one bounded matrix serves each
     * cluster. `planRouting` computes the whole cost *before* a request is made,
     * so exceeding a budget is a visible reduction rather than a silent collapse.
     */
    let routingDiagnostics: {
      plannedPairs: number;
      flatPairs: number;
      requestedPairs: number;
      composedPairs: number;
      providerCalls: number;
      clusters: number;
      reductions: string[];
      failedClusters: { clusterId: string; name: string; reason: string }[];
    } | null = null;
    /*
     * A holder rather than a `let`.
     *
     * Both of these are written inside the stage closure and read after it.
     * TypeScript's control-flow analysis cannot see across the callback, so a
     * plain `let` narrows to `null` at every read site and the code stops
     * compiling for a reason that has nothing to do with what it does.
     */
    const routed: { interCluster: RoutingMatrixResult | null } = { interCluster: null };

    const matrix = await runStage('computing_travel_times', async () => {
      const foodForRouting = [...foodPoints.values()].map((point) => ({
        routingId: point.id,
        coordinates: { lat: point.lat, lng: point.lng },
      }));
      const clusters = assignToClusters({ bases, places: openPlaces, food: foodForRouting });

      const run = async (mode: 'car' | 'foot'): Promise<HierarchicalRoutingResult> =>
        routeHierarchically({
          clusters,
          places: openPlaces,
          food: foodForRouting,
          routing: input.providers.routing,
          mode,
          maxElements: ledger.remaining('maxRouteElements'),
          fitOf: (placeId) => {
            const place = openPlaces.find((entry) => entry.id === placeId);
            return place ? roughFit(place, input.profile) : 0;
          },
        });

      let outcome = await run(primaryMode);
      /**
       * The one genuine retry in the pipeline, counted where it happens.
       *
       * Everything else here is deliberately one-shot — the map and retrieval
       * layers pass `retries: 0` at every fetch site, because a traveller
       * waiting five minutes for a service to change its mind is worse served
       * than one told the region came back thin. So this is the only place a
       * stage can honestly report having asked twice, and the observation
       * records what happened rather than a hard-coded zero.
       */
      let retries = 0;

      /**
       * One retry on the road network when the footpath network has nothing.
       *
       * Every non-driving mode a scope allows — bus, rail, shuttle, rideshare,
       * ferry — travels on roads, and there is no continuous pedestrian graph
       * across a national park or an island. The road matrix is then the closest
       * honest measurement available. It is recorded as what it is: `mode`
       * travels on the artifact, and nothing here claims the traveller drives.
       */
      if (primaryMode !== 'car' && outcome.matrix.ids.length < 2) {
        retries += 1;
        const fallback = await run('car');
        if (fallback.matrix.ids.length > outcome.matrix.ids.length) {
          outcome = fallback;
          measuredMode = 'car';
          warnings.push(
            'Travel times here are measured along roads, because there is no continuous walking network across this region. How you actually travel each leg is in the transport notes.',
          );
        }
      }

      ledger.record('maxRouteElements', outcome.requestedPairs);
      for (const entry of outcome.matrix.licences ?? []) licences.set(entry.id, entry);
      routed.interCluster = outcome.interCluster;
      routingDiagnostics = {
        plannedPairs: outcome.plan.totalPairs,
        flatPairs: outcome.plan.flatPairs,
        requestedPairs: outcome.requestedPairs,
        composedPairs: outcome.composedPairs,
        providerCalls: outcome.providerCalls,
        clusters: clusters.length,
        reductions: outcome.plan.reductions.map((entry) => entry.reason),
        failedClusters: outcome.failedClusters,
      };

      for (const failure of outcome.failedClusters) {
        gaps.push({ subjectId: failure.clusterId, reason: 'provider_error', detail: failure.reason });
      }

      const saved = outcome.plan.flatPairs - outcome.plan.totalPairs;
      const note =
        outcome.failedClusters.length > 0
          ? `${outcome.failedClusters.map((entry) => entry.name).join(', ')} could not be connected, so ${outcome.failedClusters.length === 1 ? 'it was' : 'they were'} left out.`
          : outcome.plan.reductions.length > 0
            ? outcome.plan.reductions[0]!.reason
            : undefined;

      return {
        value: outcome.matrix,
        outcome: `${outcome.matrix.ids.length} points across ${clusters.length} ${clusters.length === 1 ? 'area' : 'areas'}, ${outcome.requestedPairs} legs measured${saved > 0 ? ` (${saved} skipped as unusable)` : ''}`,
        ...(note ? { note } : {}),
        workUnits: outcome.requestedPairs,
        retries,
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
    /**
     * The drive from the base this place is actually visited from.
     *
     * It used to be `bases[0]` for every place in the region — which is right
     * for a one-base trip and badly wrong for a multi-base one: a stop beside
     * the third base was rendered, scored and filtered as though the traveller
     * drove to it from the first, six hours away. Every consumer of
     * `travelFromBase` read that number: the board, the quality assessor, the
     * regional-expansion helper and the planner's reach filter.
     *
     * Now each place is measured from its own cluster's base, which is the
     * journey that will actually appear on a day.
     */
    const baseOfPlace = new Map<string, string>();
    for (const cluster of assignToClusters({
      bases,
      places: openPlaces,
      food: [],
    })) {
      for (const placeId of cluster.placeIds) baseOfPlace.set(placeId, cluster.base.routingId);
    }
    const legFromBase = (placeId: string): { minutes: number; km: number } | null =>
      legBetween(baseOfPlace.get(placeId) ?? bases[0]?.routingId ?? '', placeId);

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

    /**
     * The base portfolio: which base, in what order, for how many nights.
     *
     * Derived from the *measured* inter-cluster matrix, never from straight
     * lines and never from a model. When there is no inter-cluster matrix — one
     * cluster, or a routing failure — this collapses to a single base, which is
     * the honest shape of a trip whose regions could not be connected.
     */
    /*
     * Only the bases the matrix can actually answer for.
     *
     * A base the routing layer lost is a base no day can start from, and
     * `checkRegionIntegrity` rightly refuses an artifact containing one. Losing
     * it here — where it becomes a smaller portfolio and a reported cluster —
     * is the salvage story; carrying it forward is a compile that fails at the
     * last gate having done all the work.
     */
    const matrixBases = bases.filter((base) => routable.has(base.routingId));
    const usableBases = matrixBases.length > 0 ? matrixBases : bases.slice(0, 1);

    const routedClusters = assignToClusters({
      bases: usableBases,
      places: plannable,
      food: [...foodPoints.values()].map((point) => ({
        routingId: point.id,
        coordinates: { lat: point.lat, lng: point.lng },
      })),
    });
    const portfolio = selectBases({
      clusters: routedClusters.map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        base: { id: cluster.base.routingId, coordinates: cluster.base.coordinates, role: 'base' as const },
        representative: {
          id: cluster.base.routingId,
          coordinates: cluster.base.coordinates,
          role: 'base' as const,
        },
        activities: [],
        food: [],
      })),
      interCluster: routed.interCluster
        ? {
            mode: measuredMode,
            ids: routed.interCluster.ids,
            minutes: routed.interCluster.minutes,
            km: routed.interCluster.km,
            provenance: routed.interCluster.provenance,
          }
        : null,
      nights: Math.max(1, input.dates.length - 1),
      maxBaseChanges: input.scope.maxBaseChanges,
      startDate: input.dates[0] ?? '',
      /*
       * Cluster value is the plannable supply inside it, so a shorter trip keeps
       * the regions with the most to do rather than the ones that sorted first.
       */
      clusterValue: (clusterId) =>
        routedClusters.find((cluster) => cluster.id === clusterId)?.placeIds.length ?? 0,
    });

    await runStage('validating_routes', async () => {
      /*
       * Counted from the matrix itself, not from the request history.
       *
       * The version this replaces divided `failedPairs.length` — which
       * accumulates across every batch the provider was asked, including points
       * that were later dropped — by the pair count of the *final* id set. The
       * two have different populations, and a live country-scale run put
       * "-13116 of 272 legs measured" on a traveller's screen.
       *
       * A leg is measured when the matrix holds a finite number for it. That is
       * directly observable, it is the thing the planner will actually read, and
       * it cannot go negative.
       */
      let total = 0;
      let measured = 0;
      for (let from = 0; from < matrix.ids.length; from += 1) {
        for (let to = 0; to < matrix.ids.length; to += 1) {
          if (from === to) continue;
          total += 1;
          const minutes = matrix.minutes[from]?.[to];
          if (typeof minutes === 'number' && Number.isFinite(minutes)) measured += 1;
        }
      }
      const missing = total - measured;
      const shape =
        portfolio.bases.length > 1
          ? `, ${portfolio.bases.length} bases and ${portfolio.transferDays} transfer ${portfolio.transferDays === 1 ? 'day' : 'days'}`
          : '';
      return {
        value: null,
        outcome: `${measured} of ${total} legs measured${shape}`,
        ...(missing > 0
          ? {
              note: `${missing} pair${missing === 1 ? '' : 's'} the routing engine could not answer for. A leg it cannot measure is not a distance of zero, so the places behind those legs were dropped rather than guessed at.`,
            }
          : {}),
      };
    });

    if (plannable.length === 0 || !bases.some((base) => routable.has(base.routingId))) {
      return fail(
        'route_matrix_incomplete',
        'We could not work out travel times across this region, so we will not guess at a plan.',
      );
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
      /*
       * Only bases the matrix can answer for reach the artifact.
       *
       * `checkRegionIntegrity` refuses a region containing a base with no
       * travel-time row, and it is right to — a base is where every day starts.
       * A live country-scale build produced exactly that: routing succeeded, one
       * region's local matrix came back too thin to keep, and the compile failed
       * at the very last gate with all the work done.
       */
      const primary = usableBases[0] ?? bases[0];
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
      const routedBases = usableBases.map((base) => ({
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
        /*
         * Frozen with the artifact, because the board's own account of itself
         * has to survive a refresh and a provider being switched off. A count
         * recomputed at render time from whatever happens to be reachable is a
         * different count, and a board that explains itself differently on the
         * second look is worse than one that does not explain itself at all.
         */
        ...(boardSupply ? { boardSupply } : {}),
        bases: routedBases,
        primaryBaseId: primary.id,
        subregions: buildSubregions(expansion.subregions, usableBases, plannable),
        satellites: buildSatellites(plannable, primary, matrix),
        places: plannable,
        access,
        operatingHours: hours,
        weatherLocations,
        ...(routableFood.length > 0
          ? { food: { version: FOOD_DATASET_VERSION, regionId: access.regionId, venues: routableFood, gaps: [] } as FoodDataset }
          : {}),
        ...(portfolio.bases.length > 0 ? { basePortfolio: portfolio } : {}),
        ...(routingDiagnostics ? { routingDiagnostics } : {}),
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
        /**
         * WHAT THIS RESTS ON — AND NOT WHAT IT COST.
         *
         * Every provider consulted, with the version it answered under, because
         * that is what lets a stored plan say three months later where its
         * facts came from. The call counts that used to sit beside each entry
         * are gone: `calls` was `ledger.spent(...)`, which a warm shared store
         * drives to zero for identical output, so two builds of one region
         * persisted different bytes for the same trip. They are on
         * `CompileResult.operational.providers`.
         */
        sourceManifest: {
          facts,
          pages: provenancePages(),
          providers: [
            { name: input.providers.expansion.name, version: '1' },
            { name: input.providers.routing.name, version: '1' },
            { name: input.providers.sourceDiscovery.name, version: '1' },
            { name: input.providers.retrieval.name, version: '1' },
            { name: input.providers.extraction.name, version: EXTRACTION_SCHEMA_VERSION },
          ],
          attributions: requiredAttributions([...licences.values()]),
        },
        coverage,
        /**
         * What produced this, and what it does not contain.
         *
         * `stageCount`, `stageTimings` and `budget` used to be here and are on
         * the run now — see the boundary table in `schemas/compiled-region.ts`.
         * The clock pair below is the *injected* one, advanced one step per
         * stage, so it is reproducible by construction and is never a duration.
         */
        diagnostics: {
          compilerVersion: COMPILER_VERSION,
          startedAt: input.now.toISOString(),
          finishedAt,
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
      return fail(
        'coverage_insufficient',
        `What we compiled does not hang together: ${issues[0]?.detail ?? 'unknown problem'}`,
        claimCounters,
      );
    }

    /**
     * WHAT LEFT BETWEEN THE EARLY BOARD AND THIS ONE, AND WHY.
     *
     * The provisional board is projected from `places`; the artifact carries
     * `plannable`. Everything in the difference was removed by one of exactly
     * two stages after the cut, and both of them know why:
     *
     * - an official source said it is shut on these dates (`blocked`), or
     * - no route could be measured to it (`routable`).
     *
     * Anything else in the difference is a genuine "we do not know", and says so
     * rather than borrowing one of the two reasons above. `detail` is lifted
     * from the gap the stage recorded, never composed here — a sentence written
     * at this distance from the evidence is a paraphrase of a paraphrase.
     */
    const survived = new Set(plannable.map((place) => place.id));
    const closureBlocked = new Set(reconciled.closureBlockedSubjectIds);
    const safetyBlocked = new Set(reconciled.safetyBlockedSubjectIds);
    /*
     * A gap is a statement from the *evidence* stage. It explains a removal for
     * insufficient support and it explains nothing else — attaching it to a
     * closure or to a routing failure names the wrong cause in a more convincing
     * voice than the generic sentence it would have replaced.
     */
    const gapDetail = new Map<string, string>();
    for (const gap of gaps) {
      if (!gapDetail.has(gap.subjectId)) gapDetail.set(gap.subjectId, gap.detail);
    }
    const removals: PlaceRemoval[] = places
      .filter((place) => !survived.has(place.id))
      .map((place): PlaceRemoval => {
        const blocking = reconciled.blockingStatements.get(place.id);
        if (closureBlocked.has(place.id) && blocking) {
          return {
            placeId: place.id,
            outcome: 'removed_closed',
            detail: blocking.text,
            detailStage: 'availability',
          };
        }
        /*
         * A safety advisory is not a closure, and saying it is tells somebody a
         * place is shut when it is open and dangerous. Different fact, different
         * remedy, different sentence.
         */
        if (safetyBlocked.has(place.id) && blocking) {
          return {
            placeId: place.id,
            outcome: 'removed_safety_blocked',
            detail: blocking.text,
            detailStage: 'safety',
          };
        }
        if (routable.has(place.id)) {
          const detail = gapDetail.get(place.id);
          return {
            placeId: place.id,
            outcome: 'removed_insufficient_support',
            ...(detail ? { detail, detailStage: 'evidence' as const } : {}),
          };
        }
        // No measurable leg. No gap explains that, so nothing is attached.
        return { placeId: place.id, outcome: 'removed_unreachable' };
      })
      .sort((a, b) => a.placeId.localeCompare(b.placeId));

    const exhausted = ledger.exhausted().length > 0;
    return {
      ok: true,
      region,
      partial: exhausted || coverage.blocksItinerary || warnings.length > 0,
      removals,
      operational: operationalNow(claimCounters),
    };
  } catch (error) {
    /*
     * A stage that threw never wrote a record of its own, so the failure helper
     * writes one for the stage that was in flight. Without it the job's last
     * stage stayed `running` and the phase clock counted upward for ever on a
     * build that died minutes ago.
     */
    return fail(
      'internal_error',
      error instanceof Error ? error.message : 'Something went wrong on our side.',
    );
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
    /*
     * `'rare'` was here, and it is not a member of `INTEREST_LEVELS`.
     *
     * The vocabulary is `avoid | low | occasional | frequent | core`, so the
     * branch was dead and `'low'` fell through to zero — scoring an interest
     * somebody said they had a little of exactly as if they had asked us to
     * skip it. This decides which candidates the research funnel spends its
     * budget on, so the effect was that a mild interest bought nothing.
     */
    const value =
      level === 'core' ? 1 : level === 'frequent' ? 0.8 : level === 'occasional' ? 0.5 : level === 'low' ? 0.25 : 0;
    if (value > best) best = value;
  }
  /*
   * And how strongly they said they would rather not.
   *
   * The funnel decides what we *pay to look up*, and it read only what somebody
   * said they liked — so budget went on places they had explicitly named as
   * things they would rather not do, because the refusal had no channel into
   * this function at all. It ranks here rather than filters: a soft refusal must
   * never remove a candidate, and `researchQueries` below is where an interest
   * with a refusing signal stops generating an intent of its own.
   *
   * The magnitude is the same normalised number `scorePlace` reads, from the same
   * vector, so the ranker and the funnel cannot disagree about how strong a
   * preference was. Exclusionary signals are skipped: those are already in
   * `avoidances` and have already removed the place.
   */
  let refused = 0;
  for (const signal of profile.preferenceSignals ?? []) {
    if (signal.polarity !== 'refuses' || signal.exclusionary) continue;
    if (!signal.key.startsWith('avoidance:')) continue;
    if (signal.magnitude > refused) refused = signal.magnitude;
  }

  // Nothing matching is not zero: an unmatched place can still be a good stop,
  // and zeroing it here would make the funnel spend only on confirmations.
  return Math.max(0.2, Math.max(0, best - refused * 0.3));
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
    /** Resolved English-first name, when the adapter produced one. */
    names?: DisplayName;
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
    /*
     * Carried through, never re-derived. The adapter resolved this against the
     * sources it had; the compiler's job is to preserve it, and an artifact
     * whose name changed between compilation and rendering would be a plan that
     * disagrees with itself.
     */
    ...(base.names ? { names: base.names } : {}),
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

/**
 * The traveller's own marks, folded into the ranking the funnel already uses.
 *
 * A nudge on the existing score rather than a separate queue, for two reasons.
 * It keeps one ordering rather than two that can disagree — and it keeps the
 * budget in charge: `maxResearchSubjects` still decides *how many* are looked
 * up, and this only decides *which*.
 *
 * A pin outranks an interest, an interest outranks silence, and something they
 * actively turned down drops below everything they did not — but never to zero,
 * because a place somebody skipped may still be the only food near a base, and
 * the funnel has to be able to reach it.
 */
function withPriority(
  placeId: string,
  fit: number,
  hints: ResearchPriorityHints | undefined,
): number {
  if (!hints) return fit;
  if (hints.pinned.includes(placeId)) return Math.min(1, fit + 0.5);
  if (hints.interested.includes(placeId)) return Math.min(1, fit + 0.2);
  if (hints.suppressed.includes(placeId)) return Math.max(0.05, fit - 0.3);
  return fit;
}
