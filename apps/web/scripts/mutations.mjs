#!/usr/bin/env node
/**
 * THE FIFTEEN MUTATIONS OF §30, AS DATA.
 *
 * Kept apart from the runner so the list can be read, argued with and extended
 * without reading a process manager. Each entry says three things and nothing
 * else:
 *
 * - **what regression it introduces**, in the contract's own words;
 * - **the exact edits** that introduce it — a `find` that must appear exactly
 *   once in its file, and what to put there instead;
 * - **which tests are supposed to notice**, as paths handed to vitest.
 *
 * The `find` strings are deliberately whole statements rather than fragments. A
 * fragment matching two places would mutate the wrong one and the run would
 * record a finding about a defect nobody introduced, so the runner refuses
 * anything that does not match exactly once. Source drift then surfaces as a
 * loud "this mutation no longer applies" rather than as a quiet false result.
 *
 * `tests` is a *targeted* selection rather than the whole suite. The point of
 * the exercise is to learn which test defends a behaviour, and a run that
 * always executes everything answers only "some test, somewhere" — which is
 * what the ledger already says.
 *
 * Every replacement is written to stay type-correct. A mutation that fails to
 * compile is caught by every test in the file at once and teaches nothing about
 * which behaviour was defended, so `if (false)` and unreachable statements are
 * avoided in favour of conditions the checker cannot fold away.
 */

export const MUTATIONS = [
  {
    id: 'M01-significance-enrichment-removed',
    contract: 'remove canonical/significance enrichment',
    detail:
      'Experience significance stops reading the kind and the standing and becomes one constant, which is what the score was before enrichment existed.',
    edits: [
      {
        file: 'packages/core/src/quality/significance.ts',
        find: '    score: round(clamp01(kindContribution + evidenceContribution)),',
        replace: '    score: round(clamp01(0.5 + 0 * (kindContribution + evidenceContribution))),',
      },
    ],
    tests: [
      'packages/core/src/quality/significance.test.ts',
      'packages/compiler/src/backbone/significance-ranking.test.ts',
    ],
  },
  {
    id: 'M02-metadata-richness-dominates',
    contract: 'make metadata richness dominate significance again',
    detail:
      'Significance becomes the attribute count again — the "popularity" number the §8.3 rewrite removed from ranking.',
    edits: [
      {
        file: 'packages/core/src/quality/significance.ts',
        find: '    score: round(clamp01(kindContribution + evidenceContribution)),',
        replace: '    score: round(clamp01(standing.evidenceRichness)),',
      },
    ],
    tests: [
      'packages/core/src/quality/significance.test.ts',
      'packages/compiler/src/backbone/significance-ranking.test.ts',
    ],
  },
  {
    id: 'M03-obscure-feature-outranks-anchor',
    contract:
      'allow a raw obscure map feature to outrank a well-established anchor on metadata alone',
    detail:
      'The kind stops mattering: a slope and a museum start from the same base, so anything with a scrap of evidence outranks an unevidenced anchor.',
    edits: [
      {
        /*
         * RE-ANCHORED. This class spent a whole phase matching zero times.
         *
         * `kindContribution` grew a floor — `prior === 0 ? 0 : Math.max(…,
         * SCORE_STEP)` — so that a travel experience of the lightest kind never
         * rounds to the same zero as a thing that is not an experience at all.
         * The old one-term anchor stopped matching the moment that landed, and
         * the harness reported STALE: neither caught nor survived, and quiet
         * enough that the §30 table read as complete. That is the second anchor
         * in this project to go stale across a refactor, which is why the runner
         * now shouts UNMEASURED rather than printing a row.
         *
         * The regression is unchanged against the new shape: strip `prior` from
         * the product and the kind stops mattering, so a slope and a museum
         * start from the same base and anything with a scrap of evidence
         * outranks an unevidenced anchor. The floor and the zero case are left
         * exactly as they are, so the only thing this changes is the one thing
         * the contract line is about.
         */
        file: 'packages/core/src/quality/significance.ts',
        find:
          '  const kindContribution = prior === 0 ? 0 : Math.max(round(prior * KIND_ONLY_SHARE), SCORE_STEP);',
        replace:
          '  const kindContribution = prior === 0 ? 0 : Math.max(round(KIND_ONLY_SHARE), SCORE_STEP);',
      },
    ],
    tests: [
      'packages/core/src/quality/significance.test.ts',
      'packages/compiler/src/backbone/significance-ranking.test.ts',
      /**
       * Added after this class SURVIVED the first honest run.
       *
       * Both existing tests hold for reasons other than the kind factor.
       * `significance.test.ts` never calls `experienceSignificanceOf` at all;
       * `significance-ranking`'s ordering case pits an *evidenced* temple
       * against an unevidenced park, so the evidence channel alone decides it,
       * and its "floors the board" case survives because the museums and the
       * slopes sit in different role pools — the balance layer keeps the seats,
       * not significance.
       *
       * The §29 matrix states the missing case: two records neither of which is
       * established, so the only thing left between them is what kind of thing
       * they are.
       */
      'apps/web/src/lib/iq/product-matrix.test.ts',
    ],
  },
  {
    id: 'M04-whole-area-dropped-after-research',
    contract: "remove an entire user's core-interest category after research",
    detail:
      'The largest area is dropped from the balanced portfolio after acquisition, so a whole slice of what research found never reaches the board.',
    edits: [
      {
        file: 'packages/compiler/src/backbone/balance.ts',
        find: '    .map(([areaId]) => areaId);',
        replace: '    .map(([areaId]) => areaId)\n    .slice(1);',
      },
    ],
    tests: [
      'packages/compiler/src/backbone/role-coverage.test.ts',
      'packages/compiler/src/backbone/coverage-acceptance.test.ts',
    ],
  },
  {
    id: 'M05-recovery-disabled',
    contract: 'disable deficit-directed recovery',
    detail: 'The repair loop is allowed zero passes, so a deficient board is never repaired.',
    edits: [
      {
        /*
         * The loop, not the constant.
         *
         * This class used to set `MAX_RECOVERY_PASSES = 0`, and its only
         * recorded catcher was `recovery.test.ts`'s `expect(MAX_RECOVERY_PASSES)
         * .toBe(2)` — a test that pins the constant and therefore fails for any
         * change to it, whatever the loop does. A guard that fires because a
         * number changed says nothing about whether the repair ever runs, and
         * §30 asks which test defended the *behaviour*.
         *
         * So the constant is left alone and the loop is stopped, which is the
         * regression stated: a deficient board is never repaired.
         */
        file: 'packages/compiler/src/compile.ts',
        find: '      for (let pass = 0; pass < MAX_RECOVERY_PASSES; pass += 1) {',
        replace: '      for (let pass = 0; pass < 0 * MAX_RECOVERY_PASSES; pass += 1) {',
      },
    ],
    tests: [
      'packages/compiler/src/recovery.test.ts',
      'packages/compiler/src/backbone/coverage-acceptance.test.ts',
      'apps/web/src/lib/iq/travel-iq.test.ts',
    ],
  },
  {
    id: 'M06-category-only-descriptions',
    contract: 'replace a candidate description with category-only text',
    detail:
      'Every description collapses to "A lake." — the exact primary description §8.7 bans.',
    edits: [
      {
        /*
         * Re-anchored when `describe()` was rewritten to compose an opening
         * clause with sourced facts. Dropping the facts is the same regression
         * against the new shape: every description collapses to the bare
         * category form §8.7 bans.
         *
         * Re-anchored again when `describedFacts` lost its `standing` argument
         * — the witness fallback it fed was removed, because a sentence naming
         * where the record came from is not a description of the place. The
         * mutation is unchanged in meaning: drop the sourced facts and every
         * description is its opening clause, including the records that have a
         * designation, an operator or an extent to state.
         */
        file: 'packages/compiler/src/backbone/inventory.ts',
        find: "  return [opening, ...describedFacts(record, names)].join(' ').slice(0, 280);",
        replace: "  return [opening].join(' ').slice(0, 280);",
      },
    ],
    tests: [
      'packages/compiler/src/backbone/taxonomy.test.ts',
      'packages/compiler/src/backbone/backbone.test.ts',
      /**
       * Added after this class SURVIVED the first honest run.
       *
       * Neither backbone test says anything about what a description *contains*
       * — they check classification and linking — so collapsing every
       * description to its opening clause ("A museum in Harbour City.") passed
       * both. The §29 matrix asserts the property directly, on a compiled
       * region, in the scenario the contract files it under: §29 A's "useful
       * names/descriptions".
       */
      'apps/web/src/lib/iq/product-matrix.test.ts',
    ],
  },
  {
    id: 'M07-every-card-is-a-top-pick',
    contract: 'label every candidate "Top pick"',
    detail:
      'The band-distribution guard is skipped, so an over-subscribed top band keeps every member and the label stops meaning anything.',
    edits: [
      {
        file: 'packages/core/src/discovery/board.ts',
        find: 'const calibrated = calibrateBandDistribution(rawFits);',
        replace: 'const calibrated = rawFits.map((entry) => entry);',
      },
    ],
    tests: [
      /*
       * `discovery.test.ts`, not `board.test.ts`. The latter has not existed for
       * some time and vitest says nothing about a filter that matches no file,
       * so this class was being judged on half the selection it declared.
       */
      'packages/core/src/discovery/discovery.test.ts',
      'packages/core/src/scoring/fit.test.ts',
    ],
  },
  {
    id: 'M08-hours-warning-on-every-feature',
    contract: 'treat missing hours as a problem for every geographic feature',
    detail:
      'Every place is marked as plausibly gated, so a river and a mountain collect the same "check its opening hours" warning a museum does.',
    edits: [
      {
        file: 'packages/compiler/src/backbone/inventory.ts',
        find:
          "      taxonomy.plausiblyGated || record.attributes.fee === 'yes' ? 'gated' : 'open_ground',",
        replace:
          "      taxonomy.plausiblyGated || record.attributes.fee !== 'certainly-not' ? 'gated' : 'open_ground',",
      },
    ],
    tests: [
      'packages/compiler/src/hours-semantics.test.ts',
      'packages/compiler/src/backbone/taxonomy.test.ts',
    ],
  },
  {
    id: 'M09-localised-name-preference-removed',
    contract: 'remove localized/English name preference',
    detail:
      'No language is ever recognised as English, so the display name stops preferring a recognised or romanised form.',
    edits: [
      {
        file: 'packages/core/src/naming/display-name.ts',
        find: 'export function isEnglish(language: string | undefined): boolean {',
        replace:
          'export function isEnglish(language: string | undefined): boolean {\n  if (language !== null) return false;',
      },
    ],
    tests: ['packages/core/src/naming/naming.test.ts'],
  },
  {
    id: 'M10-duplicate-under-two-identities',
    contract: 'duplicate a place under two source identities',
    detail:
      'The linker never compares a record with its neighbour, so the same place arrives twice under two source ids.',
    edits: [
      {
        file: 'packages/compiler/src/backbone/link.ts',
        find: '      if (neighbour.id === record.id) continue;',
        replace: '      if (neighbour.id === record.id || neighbour.id !== record.id) continue;',
      },
    ],
    tests: [
      'packages/compiler/src/backbone/backbone.test.ts',
      'packages/compiler/src/backbone/eligibility.test.ts',
    ],
  },
  {
    id: 'M11-planner-ignores-rejections',
    contract: 'ignore user rejection feedback during auto-pick',
    detail:
      'A board exclusion is where a rejection actually binds — the planner drops excluded selections here. Mutated, a place the traveller passed on is planned anyway.',
    edits: [
      {
        file: 'packages/planner/src/candidates.ts',
        find: "    if (!selection || selection.status === 'excluded') continue;",
        replace: '    if (!selection) continue;',
      },
    ],
    tests: [
      'packages/planner/src/planner.test.ts',
      /* The auto-selection suite lives in `discovery.test.ts`; there is no
         `autoselect.test.ts` and there has not been one. */
      'packages/core/src/discovery/discovery.test.ts',
      'packages/core/src/discovery/autoselect-portfolio.test.ts',
    ],
  },
  {
    id: 'M12-interest-frequency-limits-ignored',
    contract: 'ignore interest-frequency limits',
    detail:
      'Both places the allowance binds: auto-pick stops refusing on frequency, and the planner stops charging an interest at all.',
    edits: [
      {
        file: 'packages/core/src/discovery/autoselect.ts',
        find: "      return { ok: false, reason: 'frequency' };",
        replace: '      void interest;',
      },
      /**
       * Re-anchored after the planner's three frequency ledgers were unified.
       *
       * The old anchor sat in `plan.ts`, where the packer used to charge
       * `place.interests[0]` itself; that arithmetic now lives in
       * `frequency.ts#frequencyCostOf`, which the packer, the overflow pass and
       * the validator all share. Charging nothing there is the same regression
       * against a smaller surface, and it is where the contract's "stops
       * charging an interest at all" is now true or false.
       */
      /*
       * Re-anchored a second time, for the same reason as the first: the
       * shared ledger moved up into core (`scoring/frequency.ts`) so the
       * auto-pick, the packer and the validator all read one definition.
       * Charging nothing at the push is "stops charging an interest at all"
       * against the whole product at once.
       */
      {
        file: 'packages/core/src/scoring/frequency.ts',
        find: '      costs.push([interest, 1]);',
        replace: '      void interest;',
      },
    ],
    tests: [
      'packages/planner/src/frequency-budget.test.ts',
      'packages/planner/src/frequency.test.ts',
      /* The auto-selection suite lives in `discovery.test.ts`; there is no
         `autoselect.test.ts` and there has not been one. */
      'packages/core/src/discovery/discovery.test.ts',
      'packages/core/src/discovery/autoselect-portfolio.test.ts',
    ],
  },
  {
    id: 'M13-edit-rebuilds-every-day',
    contract: 're-run an expensive full compile for a tiny itinerary edit',
    detail:
      'A local edit stops preserving the days it did not touch, which is the observable half of "do not redo unrelated work".',
    edits: [
      {
        file: 'packages/planner/src/edit.ts',
        find: 'export function removeStopFromDay(',
        replace: 'export function removeStopFromDay(',
        rewriteDays: true,
      },
    ],
    tests: ['packages/planner/src/edit.test.ts'],
    /**
     * Declared unanchored rather than faked.
     *
     * The cheap-edit property lives in which *inputs* the edit path assembles,
     * not in one statement inside `edit.ts`, so there is no single-token change
     * that introduces the regression honestly. Left listed so the class is not
     * silently dropped, and reported as `unanchored` rather than as a pass.
     */
    unanchored:
      'No single-statement edit introduces "recompile on edit" faithfully; the property is which inputs the edit path assembles.',
  },
  {
    id: 'M14-labs-open-to-anyone',
    contract: 'let an unauthenticated labs request trigger unlimited paid work',
    detail: 'The labs token check stops refusing, so /labs is reachable with no secret at all.',
    edits: [
      {
        /*
         * Re-anchored when the predicate moved out of `middleware.ts`. A review
         * proved a path matcher cannot guard a server action — Next dispatches
         * those by id, whatever URL they were POSTed to — so the decision now
         * lives in `lib/net/billable-surface` and is asked by both the
         * middleware and every labs action. Mutating it here is therefore the
         * whole gate rather than one of its two doors.
         */
        file: 'apps/web/src/lib/net/billable-surface.ts',
        find: '  if (!offered || !secretsMatch(offered, expected)) {',
        replace: '  if (offered !== offered) {',
      },
    ],
    tests: [
      'apps/web/src/middleware.test.ts',
      'apps/web/src/app/labs/actions.architecture.test.ts',
    ],
  },
  {
    id: 'M15-road-matrix-proves-transit',
    contract: 'restore a known multimodal transport substitution',
    detail:
      'A road matrix starts answering as rail, which is the exact substitution the whole transport-truth layer exists to prevent.',
    edits: [
      {
        file: 'packages/core/src/travel/reach.ts',
        find: "  if (matrix.mode === 'car') return 'drive';",
        replace: "  if (matrix.mode === 'car') return 'rail';",
      },
    ],
    tests: [
      'apps/web/src/lib/iq/multimodal-iq.test.ts',
      'packages/planner/src/transport.test.ts',
    ],
  },

  /* ------------------------------------------------------------------ *
   * THE WIRING CLASSES.
   *
   * §30's own fifteen are drawn almost entirely from `packages/*` pure logic,
   * and a fresh adversary showed that is not where the remaining risk lives:
   * it removed nine load-bearing guarantees inside `apps/web` **at once** —
   * every rate limit on the paid actions, the labs matcher, the two
   * per-compilation ceilings, the heartbeat pulse and four more — and the full
   * suite reported 4122/4122 passing. Each one is a call site: the module was
   * proven and the call was not.
   *
   * These five mutate the *call sites* rather than the modules, because that
   * is the class of defect. Their anchors are single statements in the web
   * app, and each is expected to be caught by a test that drives the surface
   * the browser actually reaches rather than the function underneath it.
   * ------------------------------------------------------------------ */

  {
    id: 'M16-labs-gate-never-runs',
    contract: 'let an unauthenticated labs request trigger unlimited paid work (the wiring half)',
    detail:
      'The matcher is pointed at a route that does not exist, so Next never invokes the gate for /labs. M14 mutates the predicate; this mutates whether the predicate is ever consulted, which is the half that was undefended.',
    edits: [
      {
        file: 'apps/web/src/middleware.ts',
        find: "  matcher: ['/labs/:path*'],",
        replace: "  matcher: ['/never-a-real-route/:path*'],",
      },
    ],
    tests: ['apps/web/src/middleware.test.ts'],
  },
  {
    id: 'M17-rate-limits-never-refuse',
    contract: 'let a script drive the money-spending actions as fast as it likes',
    detail:
      'The rate guard keeps taking tokens and stops refusing, which deletes every rate limit on every guarded action at once — compile starts, destination resolution and the preflight.',
    edits: [
      {
        /*
         * The shared guard rather than one action's call site. Every guarded
         * action — the compile start, destination resolution, the preflight and
         * the questionnaire's billed reading — goes through this one function,
         * so neutering it here is the whole class in one edit, which is what the
         * adversary did.
         */
        file: 'apps/web/src/lib/net/caller.ts',
        find: '  if (decision.allowed) return null;',
        replace: '  if (decision.allowed || !decision.allowed) return null;',
      },
    ],
    tests: [
      'apps/web/src/app/(product)/trips/[id]/plan/actions.rate-limit.test.ts',
      'apps/web/src/lib/net/rate-limit.test.ts',
    ],
  },
  {
    id: 'M18-model-call-ceiling-unwired',
    contract: 'give one compilation an unbounded model-call budget',
    detail:
      'The live transport is handed an effectively infinite ceiling. The module that resolves the ceiling is untouched and its own tests still pass; only the number the enforcer receives changes.',
    edits: [
      {
        file: 'apps/web/src/lib/compiler/providers.ts',
        find: '    const resolved = createOpenProviders({ maxModelCalls: modelCallCeiling() });',
        replace:
          '    const resolved = createOpenProviders({ maxModelCalls: Number.MAX_SAFE_INTEGER });',
      },
    ],
    tests: ['apps/web/src/lib/compiler/limits.wiring.test.ts'],
  },
  {
    id: 'M19-compile-deadline-unwired',
    contract: 'let one compilation run without a wall clock',
    detail:
      'The compiler is handed an effectively infinite deadline, so the between-stage check can never degrade a wedged build to an honest partial and the ledger prints a limit nothing enforces.',
    edits: [
      {
        file: 'apps/web/src/lib/compiler/runner.ts',
        find: '        maxDurationMs: compileDeadlineMs(),',
        replace: '        maxDurationMs: Number.MAX_SAFE_INTEGER,',
      },
    ],
    tests: ['apps/web/src/lib/compiler/limits.wiring.test.ts'],
  },
  {
    id: 'M20-heartbeat-pulse-not-started',
    contract: 'report every healthy long build as dead, and let a cancelled one keep spending',
    detail:
      'The pulse is never installed around the compile call — the exact "exported with a rationale and zero callers" defect it was built to fix. Heartbeats fall back to stage boundaries, so a stage longer than the abandonment threshold looks like a dead process and the screen offers a second paid build; and nothing reads `cancel_requested` mid-flight.',
    edits: [
      {
        file: 'apps/web/src/lib/compiler/runner.ts',
        find: `  const stopPulse = startCompilationPulse({
    jobId: input.jobId,
    haltOnCancel: input.haltOnCancel === true,
    onCancelled: () => {
      saveOperationalDiagnostics(input.jobId, {
        counters: operationalCounters(live, evidence),
      });
    },
  });`,
        replace: '  const stopPulse = (): void => {};',
      },
    ],
    tests: [
      'apps/web/src/lib/compiler/runner.pulse-wiring.test.ts',
      'apps/web/src/lib/compiler/runner.pulse.test.ts',
    ],
  },
  {
    id: 'M21-locks-ignored-on-rebuild',
    contract: 'let a rebuild move a stop the traveller pinned (§11.2)',
    detail:
      'The planner reads no locks at all. The one test that claimed to guard this passed with `locks: []` — its perturbation never moved the stop — so the property had no guard until the scenario carried its own negative control.',
    edits: [
      {
        file: 'packages/planner/src/plan.ts',
        find:
          '  const lockedDayByPlace = new Map((input.locks ?? []).map((lock) => [lock.placeId, lock.dayNumber]));',
        replace:
          '  const lockedDayByPlace = new Map((input.locks ?? []).filter(() => false).map((lock) => [lock.placeId, lock.dayNumber]));',
      },
    ],
    tests: ['packages/planner/src/edit.test.ts'],
  },
  {
    id: 'M22-compilation-runs-on-the-request-loop',
    contract: 'put compile work back on the request-serving event loop (PR-REL-01)',
    detail:
      'Isolation defaults to `inline`, so an unconfigured deployment runs the build in the web process and every route freezes for its length. The worker tests spawn the bootstrap themselves and hold either way.',
    edits: [
      {
        file: 'apps/web/src/lib/compiler/worker/launch.ts',
        find: "    : 'process';",
        replace: "    : 'inline';",
      },
    ],
    tests: [
      'apps/web/src/lib/compiler/worker/worker.test.ts',
      'apps/web/src/app/(product)/trips/[id]/plan/actions.rate-limit.test.ts',
    ],
  },
  {
    id: 'M24-category-weight-caps-significance',
    contract:
      'restore the multiplicative category ceiling, so evidence can never lift a place past the best its kind is allowed to score (§16B, §8.3)',
    detail:
      "Significance goes back to `f(categoryWeight) × g(evidence)`: the evidence contribution is scaled by the kind's own weight, which is what makes the weight a ceiling rather than a prior. A famous instance of a modest kind — an encyclopaedically documented urban park — falls below an anonymous record filed under a heavier word, which is the absence a §16 reviewer measured on a live Osaka board.",
    edits: [
      {
        file: 'packages/core/src/quality/significance.ts',
        find: '  const openEvidenceContribution = round(established * ESTABLISHED_SHARE * evidenceAdmission);',
        replace:
          '  const openEvidenceContribution = round(prior * established * ESTABLISHED_SHARE * evidenceAdmission);',
      },
    ],
    tests: [
      'packages/core/src/quality/significance.test.ts',
      'packages/compiler/src/backbone/significance-ranking.test.ts',
    ],
  },
  {
    id: 'M25-shortlist-discards-by-a-round-index',
    contract:
      'let the shortlist silently discard records the quotas had already chosen — the DROP direction of `interleaveByRole`\'s "a permutation of its input, by construction"',
    detail:
      'The round loop stops one record short, which is the phase\'s own defect in its own shape: on the live Tokyo pack a round index discarded 59 records the quotas had already selected, four of the six canonical attractions among them. The old assertions covered the other direction — no duplicates, never over the ceiling — and a drop is invisible to both.',
    edits: [
      {
        /*
         * A round index rather than a filter, deliberately. The bug was not a
         * predicate that rejected something; it was arithmetic about when the
         * loop had emitted enough, and the record it lost was one nothing had
         * any opinion about. That is what makes the loss silent, and it is the
         * shape a guard has to be sensitive to.
         */
        file: 'packages/compiler/src/backbone/inventory.ts',
        find: '  for (let round = 0; ordered.length < records.length; round += 1) {\n    let progressed = false;\n    for (const bucket of buckets) {\n      const next = bucket[round];\n      if (!next) continue;\n      ordered.push(next);\n      progressed = true;\n    }\n    if (!progressed) break;\n  }\n  return ordered;\n}\n\n/**\n * The order records are considered in, and it is not a fit score.',
        replace:
          '  for (let round = 0; ordered.length + 1 < records.length; round += 1) {\n    let progressed = false;\n    for (const bucket of buckets) {\n      const next = bucket[round];\n      if (!next) continue;\n      ordered.push(next);\n      progressed = true;\n    }\n    if (!progressed) break;\n  }\n  return ordered;\n}\n\n/**\n * The order records are considered in, and it is not a fit score.',
      },
    ],
    tests: ['packages/compiler/src/backbone/backbone.test.ts'],
  },
  {
    id: 'M26-board-priority-escapes-its-band',
    contract:
      'let a lower-banded card outrank a higher-banded one in the planner (§16B presentation/planning agreement)',
    detail:
      '`boardPriorityOf` stops normalising `withinBand` against its own width before folding it into the band rank. The comparator is untouched and every board still renders in the right order; only the scalar the planner sorts on changes, so the trip comes out in a different order from the board it was built from.',
    edits: [
      {
        file: 'packages/core/src/discovery/board.ts',
        find:
          '  const within = Math.min(\n    1,\n    Math.max(0, (ordering.withinBand + WITHIN_BAND_FLOOR) / WITHIN_BAND_WIDTH),\n  );',
        replace: '  const within = ordering.withinBand + WITHIN_BAND_FLOOR;',
      },
    ],
    tests: [
      'packages/core/src/discovery/discovery.test.ts',
      'packages/planner/src/candidates.test.ts',
    ],
  },
  {
    id: 'M27-autopick-forgets-the-travellers-own-choices',
    contract:
      "ignore user rejection feedback during auto-pick — the wiring half (§30 class 11, at the call site)",
    detail:
      'M11 mutates the planner\'s reading of an exclusion. This mutates whether auto-pick is ever *told* what the traveller decided: the action stops assembling `decided`, so the pass spends slots on places the store then refuses to write and reports a selection that did not happen.',
    edits: [
      {
        file: 'apps/web/src/app/(product)/trips/[id]/discover/actions.ts',
        find: "      if (stored.source === 'user') decided[stored.placeId] = stored.status;",
        replace:
          "      if (stored.source === 'user' && stored.source !== 'user') decided[stored.placeId] = stored.status;",
      },
    ],
    tests: [
      'apps/web/src/app/(product)/trips/[id]/discover/actions.autopick.test.ts',
      /* The auto-selection suite lives in `discovery.test.ts`; there is no
         `autoselect.test.ts` and there has not been one. */
      'packages/core/src/discovery/discovery.test.ts',
      'packages/core/src/discovery/autoselect-portfolio.test.ts',
    ],
  },
  {
    id: 'M28-completeness-buys-board-seats',
    contract:
      'give metadata completeness back its quarter-share of the final board cut (§16B stage 8d, §8.3)',
    detail:
      "The candidate quality score swaps its significance term back for `evidenceCompleteness`, which is the arithmetic the 8d fix removed: the classify/shortlist stage ranks the final board cut on this score, so a fully-detailed generic record out-seats a thin-metadata significant one again. Measured on the live Tokyo pack of 2026-08-13: memorial statues carrying a website attribute held shortlist seats at 0.671 while Shinjuku Gyoen (composed significance 0.81) was cut at 0.571. Completeness keeps its verification-label and tie-break jobs either way; only its share of the rank is in question.",
    edits: [
      {
        file: 'packages/core/src/quality/candidate.ts',
        find: '    significance * 0.25 +',
        replace: '    evidenceCompleteness * 0.25 +',
      },
    ],
    tests: [
      'packages/core/src/quality/quality.test.ts',
      'packages/compiler/src/shortlist.test.ts',
    ],
  },
  {
    id: 'M23-weather-silently-off',
    contract: 'switch live weather off while the doctor keeps reporting it live (PR-PROV-01)',
    detail:
      'The default provider becomes `off`, so every day reports that weather was not considered. The doctor prints its own duplicated default and, until the parity assertion, agreed with nobody.',
    edits: [
      {
        file: 'apps/web/src/lib/weather/index.ts',
        find: "  return 'openmeteo';",
        replace: "  return 'off';",
      },
    ],
    tests: ['apps/web/src/lib/providers/doctor.test.ts'],
  },
  {
    id: 'M29-minted-notice-saturates-prominence',
    contract:
      'let presence alone saturate prominence again, so a knowledge-base tag means the same thing for a landmark and for a municipal park (§8.3, §16)',
    detail:
      "The notice-magnitude gate opens fully for every record: the union of the three presence channels is admitted in full whether or not anything says how big the noticed thing is. That is the shape three delivered boards shipped — a municipal sports park at 0.70, a city tower at 0.79, a suburban park twenty kilometres out at 0.79, a famous waterfall at 0.79, indistinguishable — and it is what put a suburban lake and a small municipal beach under \"Classics worth your time\" while a world-famous waterfall rendered under \"Probably skip\". Nothing else about the model moves: the presence channels, the local channels and the composition are untouched.",
    edits: [
      {
        file: 'packages/core/src/quality/significance.ts',
        find:
          '    UNMAGNIFIED_NOTICE_ADMISSION + (1 - UNMAGNIFIED_NOTICE_ADMISSION) * (magnitude ?? 0);',
        replace: '    UNMAGNIFIED_NOTICE_ADMISSION + (1 - UNMAGNIFIED_NOTICE_ADMISSION) * 1;',
      },
    ],
    tests: [
      'packages/core/src/quality/significance.test.ts',
      'packages/core/src/discovery/discovery.test.ts',
    ],
  },
  {
    id: 'M30-missing-tag-reads-as-obscurity',
    contract:
      'read a missing knowledge-base tag as evidence of obscurity again, rather than as a withheld standing (§8.3)',
    detail:
      "`prominenceRead` stops letting the channels that did speak answer, so any record whose own catalogue row carries no identifier is floored — outranking nothing and outranked by everything, whatever the region's authorities, designations and ground established about it. Measured on a delivered board: a metropolis's principal castle read 0.15 with `globalProminence` absent and lost its seat, beneath a municipal sports park at 0.70 whose row happened to carry the tag.",
    edits: [
      {
        /*
         * RE-ANCHORED. The old anchor was the `??` chain this class deleted a
         * term from, and that chain no longer exists: substituting the local
         * union onto the notice axis was itself the narrowed form of the same
         * defect, so `prominenceRead` is now a switch over `prominenceBasisOf`
         * and the withheld case has a band of its own. The regression is
         * unchanged against the new shape — the withheld arm stops answering
         * and falls to the floor — and the observed and unestablished arms are
         * left exactly as they are, so the only thing this changes is the one
         * thing the contract line is about.
         */
        file: 'packages/core/src/quality/significance.ts',
        find: '      return withheldStandingRead(standing.localSignificance!);',
        replace: '      return WITHHELD_PROMINENCE_READ;',
      },
    ],
    tests: [
      'packages/core/src/quality/significance.test.ts',
      'packages/core/src/discovery/discovery.test.ts',
    ],
  },
  {
    /**
     * THE NARROWED FORM OF M30, WHICH THE DELIVERED BOARD STILL SHIPPED.
     *
     * M30's own fix — letting the local channels answer where the notice
     * question was never put — passed its tests while the board still
     * inverted, because a local weight projected onto the notice axis lands
     * *inside* the presence band. So the class needs its own row: this is the
     * shape that shipped, and it must be caught by the production-path tests
     * rather than by a fixture comparison.
     */
    id: 'M31-withheld-read-substituted-onto-the-notice-axis',
    contract:
      'project a withheld standing back onto the notice axis, where notice minted for a whole class already sits above it (§8.3, §16)',
    detail:
      "The withheld band collapses back to the raw local union, so a record whose notice nobody ever observed is ranked on the scale presence bits are minted on. Measured on the boards delivered 2026-08-26: the destination's principal temple, shrine, palace and castle all read 0.35 — one local channel — beneath a ward park at 0.57, a cruise terminal at 0.57, a suburban zoo at 0.60 and a flood-basin park at 0.69, and \"Classics worth your time\" rendered empty on both metro boards because 0.69 was the highest any card reached.",
    edits: [
      {
        file: 'packages/core/src/quality/significance.ts',
        find: '      return withheldStandingRead(standing.localSignificance!);',
        replace: '      return standing.localSignificance!;',
      },
    ],
    tests: [
      'packages/core/src/quality/significance.test.ts',
      'packages/core/src/discovery/discovery.test.ts',
    ],
  },
  {
    /**
     * THE ANCHOR SLOT'S EVIDENCE CONDITION, WHICH NOTHING ASKED FOR AT ALL.
     *
     * A live compile gave a record with no evidence beyond its name and its
     * position a 240-minute block holding 42% of a trip's activity time, and
     * computed the readiness verdict over it. There was no rule to weaken —
     * this class exists so that removing the one there now is caught.
     */
    id: 'M32-anchor-slot-needs-no-evidence',
    contract:
      'let auto-pick build a day around a record nothing whatever is published about (§7, §17 step 8)',
    detail:
      "The anchor slot's evidence condition stops firing, so a record whose own compiled description reads \"Nothing beyond its name and position is published about it\" — no notice observed, no local standing, source confidence 0.41 — is pre-selected into a 240-minute slot exactly as it was on the delivered board.",
    edits: [
      {
        file: 'packages/core/src/discovery/autoselect.ts',
        find: '    nothingIsPublishedAboutIt(candidate.place)',
        replace: '    nothingIsPublishedAboutIt(candidate.place) && false',
      },
    ],
    tests: ['packages/core/src/discovery/discovery.test.ts'],
  },
];
