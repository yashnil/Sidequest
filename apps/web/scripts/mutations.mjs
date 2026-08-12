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
        find: 'return round(clamp01(clamp01(input.categoryWeight) * (0.3 + 0.7 * (established ?? 0))));',
        replace: 'return round(clamp01(0.5 * (established === undefined ? 1 : 1)));',
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
        find: 'return round(clamp01(clamp01(input.categoryWeight) * (0.3 + 0.7 * (established ?? 0))));',
        replace: 'return round(clamp01(input.standing.evidenceRichness ?? (established ?? 0)));',
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
        file: 'packages/core/src/quality/significance.ts',
        find: 'return round(clamp01(clamp01(input.categoryWeight) * (0.3 + 0.7 * (established ?? 0))));',
        replace: 'return round(clamp01(0.3 + 0.7 * (established ?? 0)));',
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
         */
        file: 'packages/compiler/src/backbone/inventory.ts',
        find:
          "  return [opening, ...describedFacts(record, names, standing)].join(' ').slice(0, 280);",
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
    tests: ['packages/core/src/discovery/board.test.ts', 'packages/core/src/scoring/fit.test.ts'],
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
      'packages/core/src/discovery/autoselect.test.ts',
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
      {
        file: 'packages/planner/src/frequency.ts',
        find: "  if (primary === undefined || typeof caps[primary] !== 'number') return [];",
        replace: "  if (primary === undefined || typeof caps[primary] === 'number') return [];",
      },
    ],
    tests: [
      'packages/planner/src/frequency-budget.test.ts',
      'packages/core/src/discovery/autoselect.test.ts',
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
];
