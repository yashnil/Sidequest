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
      'apps/web/src/proxy.test.ts',
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
        file: 'apps/web/src/proxy.ts',
        find: "  matcher: ['/labs/:path*'],",
        replace: "  matcher: ['/never-a-real-route/:path*'],",
      },
    ],
    tests: ['apps/web/src/proxy.test.ts'],
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
  {
    id: 'M33-proxy-walk-priced-as-a-distance',
    contract:
      'let a walk that only stands in for an unpriceable scheduled journey be read out as this traveller’s distance (§12, §17 step 6)',
    detail:
      'The worth-the-detour verdict goes back to reading `detourClass` alone, so a proxy walk long enough to bust the day budget is filed `too_far` first and the card asserts "too far for this trip" about a journey nobody measured — over a landmark a quarter of an hour away by train.',
    edits: [
      {
        file: 'packages/core/src/region/expansion.ts',
        find: "  if (journeyProxy) return 'reach_unverified';",
        replace: "  if (journeyProxy && false) return 'reach_unverified';",
      },
    ],
    tests: ['packages/core/src/region/expansion.test.ts'],
  },
  {
    id: 'M34-card-quotes-a-walking-clock-for-a-train',
    contract:
      'let the rendered card re-derive the proxy fact from the budget class again (§9.1, §26)',
    detail:
      'The travel phrase reads `detourClass === "unknown"` rather than the carried fact, so the moment the budget rule answers first the card prints "2 hr 17 min on foot from base" directly above its own sentence saying no route could be confirmed.',
    edits: [
      {
        file: 'apps/web/src/components/DiscoveryBoardView.tsx',
        find: '  if (candidate.journeyProxy) {',
        replace: "  if (candidate.detourClass === 'unknown' && candidate.reach.mode === 'walk') {",
      },
    ],
    tests: ['apps/web/src/components/DiscoveryBoardView.test.ts'],
  },
  {
    id: 'M35-feasible-reported-as-complete',
    contract:
      'report a plan holding a fraction of the traveller’s own paced volume as ready (§17 step 8, §20.1)',
    detail:
      'The completeness clause stops governing the verdict, so every feasibility gate passing is enough — which is how three delivered trips holding 42%, 56% and 58% of their paced volume, one with an empty day, all read "Ready".',
    edits: [
      {
        file: 'packages/planner/src/readiness.ts',
        find: "  if (coverage?.incomplete) return 'partial';",
        replace: "  if (coverage?.incomplete && false) return 'partial';",
      },
    ],
    tests: [
      'apps/web/src/lib/iq/closure-invariants.test.ts',
      'packages/planner/src/readiness.test.ts',
    ],
  },
  {
    id: 'M36-held-meal-names-somewhere-else',
    contract:
      'let a held meal name the base’s municipality on a day that goes elsewhere (§10, §20.11)',
    detail:
      'The fallback area is resolved at the base rather than at the anchor the traveller is standing on, so a lunch laid at a reserve sixty kilometres up the coast is titled "around <the base>" — which is what a delivered road journey printed, under a sentence admitting none of our venues worked from where the day actually is.',
    edits: [
      {
        file: 'packages/planner/src/schedule.ts',
        find: '    const anchorName = input.at?.name ?? atName;',
        replace: '    const anchorName = baseName;',
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M37-yielded-day-loses-the-whole-food-layer',
    contract:
      'let a day whose venues would not fit report that the region has no food data (§10)',
    detail:
      'The area falls back to the day’s food *plan* rather than the region’s food *dataset*, so a day that lost its named venues renders bare blocks headed "Lunch" and "Dinner" — in a metropolis whose own index holds fourteen venues.',
    edits: [
      {
        file: 'packages/planner/src/schedule.ts',
        find: '      context.foodDataset !== null',
        replace: '      context.foodDataset !== null && context.food !== null && foodPlan !== null',
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M38-daylight-judged-by-its-first-minute',
    contract:
      'judge whether a stop happens in daylight from the minute it starts (§13)',
    detail:
      'A visit that begins three minutes before sunset and runs sixty-seven past it says nothing at all — which is what a delivered arrival evening did, using a sunset time held on that same day’s own record.',
    edits: [
      {
        file: 'packages/planner/src/validate-weather.ts',
        find: '      mostlyAfterDark(item, {\n        sunriseMinute: day.weather.sunriseMinute,\n        sunsetMinute: day.weather.sunsetMinute,\n      })',
        replace: '      item.startMinute >= day.weather.sunsetMinute',
      },
    ],
    tests: ['packages/planner/src/schedule-quality.test.ts'],
  },
  {
    id: 'M39-verification-caveat-replaces-what-a-place-is',
    contract:
      'route every thin-evidence card away from its content heading (§9.1, §20.6)',
    detail:
      'The evidence-gap route is tested ahead of the content headings again, so twenty of twenty-four cards on a metropolitan board sit under "Promising — check before you go" — the destination’s principal temple, shrine and palace among them — and the classics group renders on no board at all.',
    edits: [
      {
        file: 'packages/core/src/discovery/board.ts',
        find: '    standsAsEstablishedName(place)\n  ) {',
        replace: '    standsAsEstablishedName(place) &&\n    reasonBasis !== \'evidence_gap\'\n  ) {',
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M40-a-drawn-boundary-buys-the-classics-caption',
    contract:
      'let a conferred designation alone assert that the world knows a place (§8.3, §9.1)',
    detail:
      'The classics bar sits one hundredth above the ceiling presence alone reaches, so passing it and passing the magnitude gate become the same event — and a designated suburban lake is the only card under "Classics worth your time" while the destination’s famous waterfall renders under "Probably skip".',
    edits: [
      {
        file: 'packages/core/src/quality/significance.ts',
        find: "  if (place.noticeMagnitude === 'designation') return false;",
        replace: "  if (place.noticeMagnitude === 'designation' && false) return false;",
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M41-caller-mints-its-own-spending-allowance',
    contract:
      'let a caller mint the identity its own spending allowance is charged against (§34 cost controls)',
    detail:
      'The budget identity is minted rather than read, so a caller that simply discards the Set-Cookie is handed a fresh *signed* identity — and therefore a fresh personal allowance — on every request. Measured against a twenty-build ceiling with a per-caller share of two: twenty-one distinct signed identities, twenty builds allowed, the per-caller fence never firing.',
    edits: [
      {
        file: 'apps/web/src/lib/net/caller.ts',
        find: '  const presented = await presentedSessionToken();\n  if (presented === null) return null;',
        replace: '  const presented = await sessionToken({ mint: true });\n  if (presented === null) return null;',
      },
    ],
    tests: ['apps/web/src/lib/net/session-identity.test.ts'],
  },
  {
    id: 'M42-an-unspent-build-still-costs-a-build',
    contract:
      'keep the reserve of a build that never reached a provider (§34 cost controls)',
    detail:
      'A build that fails on a rejected credential still spends one of the six a browser gets in a day — and on a deployment with a dead key every build fails that way, so a traveller is locked out for a day by a product that did no work for them.',
    edits: [
      {
        file: 'apps/web/src/lib/compiler/daily-ceiling.ts',
        find: '    give.run(day, \'live_compilations\');',
        replace: "    if (String(caller) === '\\u0000') give.run(day, 'live_compilations');",
      },
    ],
    tests: ['apps/web/src/lib/compiler/unspent-build.test.ts'],
  },
  {
    id: 'M43-the-resolved-clock-never-reaches-the-screen',
    contract:
      'leave the stored scope on a longitude guess after the build resolved the zone (§13)',
    detail:
      'The plan screen reads the stored intent, so a finished build prints "About UTC−1 — estimated from where this is on the map, because we could not confirm the local time zone" while its own artifact holds the resolved zone.',
    edits: [
      {
        file: 'apps/web/src/lib/db/compiler-repository.ts',
        find: '  if (artifactRank <= storedRank) return null;',
        replace: '  if (artifactRank <= storedRank || true) return null;',
      },
    ],
    tests: ['apps/web/src/lib/compiler/scope-timezone.test.ts'],
  },
  {
    id: 'M44-a-square-is-sold-as-somewhere-to-eat',
    contract:
      'let an archetype’s convenience become a claim about a day (§8.3, §20.8)',
    detail:
      'A public square goes back to offering the food-and-towns interest, so a day made of three adjoining squares five hundred metres apart is headed "Food & local eating".',
    edits: [
      {
        file: 'packages/compiler/src/backbone/taxonomy.ts',
        find: "  plaza: { ...TOWN, category: 'historic_site', interests: ['history_and_culture', 'scenic_viewpoints'],",
        replace: '  plaza: { ...TOWN,',
      },
    ],
    tests: ['packages/compiler/src/backbone/taxonomy.test.ts'],
  },
  {
    id: 'M45-a-card-describes-our-record-instead-of-the-place',
    contract:
      'print the record’s own metadata in the one line reserved for what a place is (§8.7)',
    detail:
      'The local name, the managing body and a sentence naming the map data come back, and together they push a bare stub past the length floor that exists to catch it.',
    edits: [
      {
        file: 'packages/core/src/scoring/fit.ts',
        find: "  for (const pattern of RECORD_CLAUSES) text = text.replace(pattern, '');",
        replace: '  for (const pattern of RECORD_CLAUSES) void pattern;',
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M46-an-outage-reported-as-an-empty-sky',
    contract:
      'report a weather source that refused as a source that answered and had nothing (§13)',
    detail:
      'Every empty dataset reads as "we asked and got nothing usable for your dates" again, so a rate-limited free tier reports a successful fetch with nothing in it — on the one panel whose job is to say whether pressing the button again would help. Measured live: three regions built back to back, two of them 429, both trips weather-blind and reported as successful.',
    edits: [
      {
        file: 'apps/web/src/lib/weather/refresh.ts',
        find: "    const refused = dataset.days.some(\n      (day) => day.kind === 'unavailable' && day.reason === 'provider_error',\n    );",
        replace: '    const refused = false;',
      },
    ],
    tests: ['apps/web/src/lib/weather/refresh.test.ts'],
  },
  {
    id: 'M47-everything-picked-means-finished',
    contract:
      'let "every place they picked landed" waive the completeness bar and the floor (§17 step 8, §20.1)',
    detail:
      'Auto-pick scales its target to the region’s supply, so `scheduled === selected` is the ordinary case, and one activity a day satisfies the distribution clause — together they read five stops on a six-day metropolitan trip as `ready`, with the spacious sentence telling the traveller the empty afternoons were the pace they asked for.',
    edits: [
      {
        file: 'packages/planner/src/readiness.ts',
        find: '    incomplete: scheduled < expected,',
        replace:
          '    incomplete:\n      scheduled < expected &&\n      !(everyDayAnchored && input.funnel.selected > 0 && scheduled >= input.funnel.selected),',
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M48-a-held-meal-counts-somewhere-it-does-not-name',
    contract:
      'let the name and the count on one meal row come from two different anchors (§10, §20.11)',
    detail:
      'The layout writes "where the traveller is" into two variables that are not updated together, so a meal laid mid-unit is titled after the gateway and measured at the previous unit’s exit. A delivered day printed "3 places we hold within reach of <the museum> serve lunch" over three counted from a square four kilometres away.',
    edits: [
      {
        file: 'packages/planner/src/schedule.ts',
        find: '    const anchorId = input.at?.routingId ?? atRoutingId;',
        replace: '    const anchorId = atRoutingId;',
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M49-the-car-follows-a-traveller-who-walked',
    contract:
      'move the vehicle on the access rule’s declared mode rather than the mode the leg was laid in (§12)',
    detail:
      'A shorter measured walk can win an approach, and the car was then recorded as having driven there. A delivered day walked to two city squares and "drove" from the second, with no leg back to the vehicle anywhere in it — not executable as printed, and short by the walk nobody booked.',
    edits: [
      {
        file: 'packages/planner/src/schedule.ts',
        find: "    if (!option.service && vehicleAt === option.gatewayRoutingId) vehicleAt = exitedFrom;",
        replace: "    if (!option.service && option.approachMode === 'drive') vehicleAt = exitedFrom;",
      },
    ],
    tests: ['packages/planner/src/short-leg-mode.test.ts', 'packages/planner/src/planner.test.ts'],
  },
  {
    id: 'M50-a-walking-clock-quoted-as-a-journey-on-the-first-screen',
    contract:
      'quote the matrix’s minutes at the traveller whatever mode they were measured in (§12, §26)',
    detail:
      '`travelFromBase.driveMinutes` holds a walking proxy on a car-free compile, and the questionnaire printed it bare — "13 of the strongest options sit 275 minutes or so away, one way", about places twelve kilometres from a metropolitan base, to press the traveller into raising a transport limit.',
    edits: [
      {
        file: 'packages/core/src/interests/decisions.ts',
        find: "  return travel.mode === 'car' && carAvailable !== false;",
        replace: '  return true;',
      },
    ],
    tests: ['packages/core/src/interests/decisions.test.ts'],
  },
  {
    id: 'M51-a-car-free-verdict-that-ignores-the-plans-own-legs',
    contract:
      'compute the without-a-car consequence from access rules alone (§12, §20.5)',
    detail:
      'A walk needs no access rule, so a delivered itinerary announced "9 of the 9 stops on this plan become unreachable" on a page whose own day cards walked to three of them from the base the same sentence offered as what survives.',
    edits: [
      {
        file: 'packages/planner/src/strategy.ts',
        find: '    (id) => !reachableWithoutCar.has(id) && !reachedWithoutACar.has(id),',
        replace: '    (id) => !reachableWithoutCar.has(id),',
      },
    ],
    tests: ['packages/planner/src/short-leg-mode.test.ts'],
  },
  {
    id: 'M52-a-stop-card-restates-the-figure-the-page-just-qualified',
    contract:
      'print an unqualified walking figure for a journey the same page has called unverified (§12, §26)',
    detail:
      'The board’s travel phrase was corrected and the itinerary stop card was not, so a delivered plan printed three claims about one journey on one screen: "journey not verified", "the walking time shown is the upper bound we hold for it", and — between them, unqualified — "57 min on foot from your base".',
    edits: [
      {
        file: 'apps/web/src/app/(product)/trips/[id]/itinerary/view-model.ts',
        find: '    !candidate.journeyProxy\n  ) {',
        replace: '    true\n  ) {',
      },
    ],
    tests: ['apps/web/src/components/ItineraryView.unverified-journey.test.ts'],
  },
  {
    id: 'M53-open-ground-vouches-for-a-place-somebody-runs',
    contract:
      'assert walk-in entry for a commercial venue because its archetype is open ground (§13, §20.8)',
    detail:
      'A booking-only, timed-entry thermal spa shares a taxonomy leaf with a hot spring in a river bed, and `plausiblyGated: false` puts both on the open-ground branch — which writes `walkInAllowed: true`, `reservationRequired: false`, no badge and no caution. A delivered plan drove fifty-three kilometres to a door the traveller would be refused at.',
    edits: [
      {
        file: 'packages/compiler/src/backbone/taxonomy.ts',
        find: '  plausiblyGated: true,\n};\n\nconst SCENIC_ROUTE: Rule = {',
        replace: '  plausiblyGated: false,\n};\n\nconst SCENIC_ROUTE: Rule = {',
      },
    ],
    tests: ['packages/compiler/src/admission-evidence.test.ts'],
  },
  {
    id: 'M54-a-timetable-claimed-for-a-plan-that-rides-none',
    contract:
      'state a timetable provenance for service times the plan has none of (§12, §20.5)',
    detail:
      'All three delivered journeys carried `serviceIds: []` on every one of their twenty-two days, and the transport panel printed "we cannot check timetables, so the times shown are on foot" three lines above "Service times come from the operators\' published timetables".',
    edits: [
      {
        file: 'packages/planner/src/strategy.ts',
        find: "${scheduledServiceLegs(days) > 0 ? \" Service times come from the operators' published timetables on the dates recorded against each one, and are not checked live.\" : ''}",
        replace: "${\" Service times come from the operators' published timetables on the dates recorded against each one, and are not checked live.\"}",
      },
    ],
    tests: ['packages/planner/src/transport.test.ts'],
  },
  {
    id: 'M55-an-empty-day-that-books-a-dinner',
    contract:
      'call a day empty from its activity count rather than from its timeline (§20.8)',
    detail:
      'Meals and the travel to reach them are laid out after the activities are counted, so a delivered arrival evening printed "Nothing is scheduled on this day … the hours are yours" immediately beneath a booked drive and a ninety-five-minute named dinner.',
    edits: [
      {
        file: 'packages/planner/src/schedule.ts',
        find: '  } else if (accepted.length === 0 && !layout.items.some(isSomethingOnTheDay)) {',
        replace: '  } else if (accepted.length === 0) {',
      },
    ],
    tests: ['apps/web/src/lib/iq/closure-invariants.test.ts'],
  },
  {
    id: 'M56-the-rendered-heading-claims-a-distance-nobody-measured',
    contract:
      'let the board heading a traveller reads claim nearness for untimed journeys (§9.1)',
    detail:
      'The near group is the fallthrough, so a card whose journey nobody could time lands in it. The property was guarded on the compiler vocabulary that no surface renders while the rendered heading carried "Inside the distance you said you would travel" over exactly that population.',
    edits: [
      {
        file: 'apps/web/src/components/BoardCopy.ts',
        find: "    blurb: 'Not further out than you said you would go — each card says what it costs a day.',",
        replace: "    blurb: 'Inside the distance you said you would travel — each card says how long it takes.',",
      },
    ],
    tests: ['apps/web/src/components/board-copy.test.ts'],
  },
  {
    id: 'M57-one-area-confirmed-over-the-whole-of-it',
    contract:
      'confirm a narrowing that never resolved which part, so the compile searches the container (§11, §24)',
    detail:
      'A live Tokyo build answered "One area, done properly" with no destination index behind it, so the preflight portfolio was null and no part reached the derivation. The scope confirmed at high confidence reading "A single part of Tokyo, about 12 km out, from one base" over the whole metropolis extent — 20.2°N to 35.9°N — and all 24 compiled places were on the Izu and Ogasawara islands, 176 to 1,225 km from the base it named. Nothing routed and the traveller got no plan.',
    edits: [
      {
        file: 'packages/compiler/src/scope.ts',
        find: '  if (scope.narrowedWithoutPart) {',
        replace: '  if (false && scope.narrowedWithoutPart) {',
      },
    ],
    tests: ['packages/compiler/src/scope-narrowing.test.ts'],
  },
  {
    id: 'M58-a-journey-printed-shorter-than-it-is',
    contract:
      'round a travel span down, so the schedule column understates the leg beside it (§20.5)',
    detail:
      'Every span on the itinerary floored to five minutes, which is right for free time and time at stops and inverted for travel. A delivered day printed "11:00  10 min  Walk back to Osaka" directly above "14 min back to Osaka" — the same leg, forty per cent apart, with the smaller figure in the column a traveller budgets from.',
    edits: [
      {
        file: 'apps/web/src/components/plan-language.ts',
        find: 'export function roundedTravel(minutes: number): number {\n  if (minutes < STEP) return minutes;\n  return Math.ceil(minutes / STEP) * STEP;',
        replace: 'export function roundedTravel(minutes: number): number {\n  if (minutes < STEP) return minutes;\n  return Math.floor(minutes / STEP) * STEP;',
      },
    ],
    tests: ['apps/web/src/components/ItineraryView.travel-span.test.ts'],
  },
  {
    id: 'M59-left-off-for-room-over-a-reason-that-is-not-room',
    contract:
      'name one cause in the heading while every card under it names another (§20.8)',
    detail:
      'A delivered Tokyo plan headed the section "Left off for room / there were not the hours for them" over two cards both reading "We have no travel time recorded to this place". The day was not full; the way there could not be measured, and the traveller was told the opposite about their own trip.',
    edits: [
      {
        file: 'apps/web/src/components/ItineraryView.tsx',
        find: "  return allAboutRoom(dropped) ? 'Left off for room' : 'Left off, and why';",
        replace: "  return 'Left off for room';",
      },
    ],
    tests: ['apps/web/src/components/ItineraryView.dropped-heading.test.ts'],
  },
  {
    id: 'M60-a-day-heading-that-names-nowhere',
    contract:
      'print an absent locality into the day heading a traveller reads (§20.8)',
    detail:
      'The day area is the farthest stop\'s locality once that stop is over twenty minutes out, and `locality` is optional on a place. A rendered four-day plan carried "History & culture around undefined" as the heading of two of its days.',
    edits: [
      {
        file: 'packages/planner/src/schedule.ts',
        find: '    farthest && farthest.travelMinutesFromBase > 20 && farAreaName ? farAreaName : baseName;',
        replace: '    farthest && farthest.travelMinutesFromBase > 20 ? farthest.place.locality! : baseName;',
      },
    ],
    tests: ['packages/planner/src/schedule-quality.test.ts'],
  },
  {
    id: 'M61-pick-more-from-a-board-that-scheduled-nothing',
    contract:
      'offer the board as a remedy on a plan where nothing could be laid out (§20.7)',
    detail:
      'A live eight-day Iceland build had all thirteen selections refused for `missing_travel_data` — the routing service refuses any pair over 400 km — so nothing was scheduled. The panel still marked picking more from the board as likely to help, with "there is room in these days for more than is in the plan", beside five remedies it had correctly ruled out. The next pick comes off the same board and the same unmeasured matrix.',
    edits: [
      {
        file: 'packages/planner/src/readiness.ts',
        find: "      (remedy === 'choose_manually' && !nothingFitted && coverageOf(input)?.incomplete === true);",
        replace: "      (remedy === 'choose_manually' && coverageOf(input)?.incomplete === true);",
      },
    ],
    tests: ['packages/planner/src/readiness.test.ts'],
  },
  {
    id: 'M62-two-day-fractions-that-disagree',
    contract:
      'restate the stop count against a second denominator on the same page (§20.8)',
    detail:
      'A delivered Osaka plan opened with "8 stops across 6 of 6 days" and closed with "This plan holds 8 stops across 4 of the 4 days it could fill". Both are true — one counts every day of the trip, the other the days a stop can be built around — and printed in the same shape they read as one sentence giving two answers.',
    edits: [
      {
        file: 'packages/planner/src/plan.ts',
        find: "          ? 'on every day it could build one around'",
        replace: "          ? `across ${coverage.usableDaysWithActivity} of the ${coverage.anchorableDays} days it could fill`",
      },
    ],
    tests: ['packages/planner/src/readiness.test.ts'],
  },
  {
    id: 'M63-a-finished-plan-with-a-blank-day-in-it',
    contract:
      'call a plan ready on volume alone, with a day it could fill holding nothing (§20.7)',
    detail:
      'A ten-day plan for a traveller answering slow pace and lots of free time scheduled eight stops over days 1-6 and left days 7, 8, 9 and 10 completely empty — 585, 585, 553 and 435 free minutes with nothing in them — under the summary "All 8 places you picked are in the plan." Eight stops clears both volume gates, and `everyDayAnchored` was read only from inside `spacious` and `short`, neither of which sits on the path to `ready`.',
    edits: [
      {
        file: 'packages/planner/src/readiness.ts',
        find: "  if (coverage && !coverage.everyDayAnchored) return 'partial';",
        replace: "  if (false && coverage && !coverage.everyDayAnchored) return 'partial';",
      },
    ],
    tests: ['packages/planner/src/readiness.test.ts'],
  },
  {
    id: 'M64-an-interest-claimed-that-the-traveller-ranked-lowest',
    contract:
      'tell a traveller a stop matches an interest they graded "only if it is right there" (§16, §20.8)',
    detail:
      'A delivered metro plan told a traveller who had graded photography and easy nature walks at `low` that a viewpoint "matches your interest in sunrise & sunset photography", and headed a whole day "Easy nature walks around Osaka" — while the board\'s own fit record for both places carried `matchedInterests: []`. `primaryInterest` falls back to a place\'s best-graded interest whatever the grade, and nothing checked the grading before speaking it.',
    edits: [
      {
        file: 'packages/planner/src/candidates.ts',
        find: '  if (!candidate.fit.matchedInterests.includes(primary)) return undefined;',
        replace: '  if (false && !candidate.fit.matchedInterests.includes(primary)) return undefined;',
      },
    ],
    tests: ['packages/planner/src/spoken-interest.test.ts'],
  },
  {
    id: 'M65-the-same-subject-admitted-twice',
    contract:
      'admit a second record for a subject the board already shows (§9, §15)',
    detail:
      'A live metro board carried four cards for two places — one theme park named identically twice, and a second beside a record of itself carrying both readings of its name — over an integrity block reading `offered: 24, admitted: 24, refused: []`. The compiler merges only same-named records within 120 m, deliberately, because a merge deletes a place; a large site is mapped as several features much further apart than that.',
    edits: [
      {
        file: 'packages/core/src/discovery/board.ts',
        find: '    if (keys.some((key) => heldKeys.has(key))) {',
        replace: '    if (false && keys.some((key) => heldKeys.has(key))) {',
      },
    ],
    tests: ['packages/core/src/discovery/board-duplicates.test.ts'],
  },
  {
    id: 'M66-one-door-named-past-the-variety-cap',
    contract:
      'count the variety cap against shortlist heads rather than against what was named (§15)',
    detail:
      'The cap was enforced one phase before layout, against a tally of heads of shortlists, while `chooseFoodStop` re-sorts by legality and real detour — so a runner-up won slots without its tally moving. On the primary fixture with no overrides, a seven-day trip named one deli three times including breakfast and lunch on the same day, and a ten-day trip reached five.',
    edits: [
      {
        file: 'packages/planner/src/plan.ts',
        find: '      if (foodContext) {\n        for (const item of layout.items) {',
        replace: '      if (false && foodContext) {\n        for (const item of layout.items) {',
      },
    ],
    tests: ['packages/planner/src/food-cap.test.ts'],
  },
  {
    id: 'M67-a-stopped-build-with-no-way-to-start-it-again',
    contract:
      'treat a cancellation as a terminal failure and withhold the retry (§20.4)',
    detail:
      'Pressing "Stop this build" left the plan screen on its compiling step forever with no retry control, because the screen read `isRetryable` — which answers whether a *failure* was transient, and a cancellation is not a failure. The trip list meanwhile labelled the same trip "You stopped this" and offered "Pick it up again", pointing at the screen that could not do it.',
    edits: [
      {
        file: 'apps/web/src/lib/compiler/verdict.ts',
        find: "  if (job.errorCode === 'cancelled_by_user') {",
        replace: "  if (false && job.errorCode === 'cancelled_by_user') {",
      },
    ],
    tests: ['apps/web/src/lib/compiler/verdict.test.ts'],
  },
  {
    id: 'M68-an-edited-trip-linked-to-a-not-found-page',
    contract:
      'read "does this trip have a board" from the job row rather than from what the trip adopted (§21)',
    detail:
      'Editing the dates of a trip whose region was already built clears `trip_intents.selected_compiled_region_id` and deliberately leaves `compilation_jobs.compiled_region_id`. The trip list read the job, so the row still said "Places found" and linked to `/discover`, which resolves the adopted region, finds none, and renders "We cannot find that trip" over a trip that was neither old nor removed.',
    edits: [
      {
        file: 'apps/web/src/app/(product)/page.tsx',
        find: '        hasCompiledRegion: adoptedCompiledRegionId(trip.id) !== null,',
        replace: '        hasCompiledRegion: Boolean(job?.compiledRegionId),',
      },
    ],
    tests: ['apps/web/src/lib/db/adopted-region.test.ts'],
  },
  {
    id: 'M69-two-answers-for-one-travel-total',
    contract:
      'compose the trip summary from exact travel minutes while the page rounds the same totals (§20.5)',
    detail:
      'The itinerary hero line and the "Getting around" panel print the same quantities, and one rounded travel up to five while the other did not. A delivered plan read "2 hr 51 min on foot to reach them" above "On foot to reach things 2 hr 55 min", and another "3 hr 38 min" against "3 hr 40 min" — one screen giving a reader two numbers for one journey.',
    edits: [
      {
        file: 'packages/planner/src/plan.ts',
        find: '  const whole = Math.ceil(Math.round(minutes) / TRAVEL_DISPLAY_STEP) * TRAVEL_DISPLAY_STEP;',
        replace: '  const whole = Math.round(minutes);',
      },
    ],
    tests: ['apps/web/src/components/ItineraryView.travel-span.test.ts'],
  },
];
