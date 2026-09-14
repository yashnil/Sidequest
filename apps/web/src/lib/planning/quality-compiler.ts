import {
  centreIsStandIn,
  compilerBlockers,
  definingSetIsWeak,
  degradedToCountry,
  describeAccess,
  doubleCounted,
  evaluateAccess,
  gatewayInfeasible,
  jurisdictionPhrase,
  placementBlocksReady,
  qualityCompilerReportSchema,
  phraseSemanticType,
  requiredAccess,
  routeCriticalRate,
  scoreExperienceValue,
  transportBetweenStops,
  unplacedCritical,
  QUALITY_COMPILER_CHECKS,
  QUALITY_COMPILER_VERSION,
  type AccessConstraint,
  type DestinationConcept,
  type ExperienceGraph,
  type GatewayPlan,
  type Itinerary,
  type PlacementReport,
  type QualityCompilerCheck,
  type QualityCompilerIssue,
  type QualityCompilerReport,
  type SpatialOrderReport,
  type TravelerProfile,
  type Trip,
} from '@sidequest/core';
import { parseDestinationIntent, calendarConflicts, type CalendarFact } from '@sidequest/core';
import type { TripDraft } from './trip-draft';

/**
 * V10 §16 — THE QUALITY COMPILER, AFTER COMPOSITION.
 *
 * The deterministic audit (`quality-audit.ts`) asks whether the plan is
 * structurally sound: do the dates add up, do the stops overlap, did the drive
 * cap hold. This asks the questions V10 added, which are about whether the plan
 * is *true*: does its order follow the ground, are its route-critical legs
 * measured, does it give a currency to a region, do its gateways work, is a
 * shuttle-only lake represented as a shuttle, is a closed attraction on it, is
 * one connected experience counted twice, is what it claims about itself so.
 *
 * Three rules, all of them the difference between this and a repair model:
 *
 * 1. **It corrects only what is safely derivable, and says when it did.** The
 *    day-order correction happens earlier, inside the reconciler, because
 *    reordering after the legs are built would leave measured durations for
 *    pairs the plan no longer drives; what this does is *verify* it. Prose that
 *    contradicts the plan's own geometry is rewritten here, because the correct
 *    sentence is derivable from the geometry.
 * 2. **Everything else it leaves alone and names precisely.** It never deletes a
 *    stop, never rewrites an itinerary, never calls a model.
 * 3. **An unrun check is not a pass.** A check it could not run is `skipped`
 *    with its reason, so a green report is evidence rather than an absence —
 *    which is exactly how the founder's day-3 reversal survived a build.
 */

export interface QualityCompilerInput {
  itinerary: Itinerary;
  draft: TripDraft;
  trip: Trip;
  profile: TravelerProfile;
  /** V10 §2 — the canonical destination object the build ran against. */
  concept?: DestinationConcept | null;
  placement?: PlacementReport | null;
  dayOrders?: readonly { dayNumber: number; report: SpatialOrderReport; corrected: boolean }[];
  gateway?: GatewayPlan | null;
  experiences?: ExperienceGraph | null;
  accessConstraints?: readonly AccessConstraint[];
  /**
   * V12 §22 §24 §26 — date-sensitive facts that can invalidate a planned day.
   *
   * A weekly market, a seasonal ferry, a permit window. Empty by default, so a
   * build with nothing recorded behaves exactly as it did before V12: the check
   * is *skipped*, which this compiler already distinguishes from passing.
   */
  calendarFacts?: readonly CalendarFact[];
  /** Prose the compiler may rewrite when the geometry contradicts it. Mutated in place by the caller's own copy. */
  claims?: { routeRationale?: string };
}

export interface QualityCompilerResult {
  report: QualityCompilerReport;
  /** Prose the compiler derived to replace a claim the plan contradicts. Applied by the caller. */
  corrections: { routeRationale?: string; transportDisclosure?: string };
}

/**
 * Why a leg may honestly be unmeasured without the plan being defective.
 *
 * V9.1's doctrine, unchanged: a flight, ferry, boat or guided transfer is not a
 * road question, and an operator's own ride time is nobody's to publish. A leg
 * the router *evaluated and refused* is evidence about the ground rather than a
 * gap in Sidequest's work. What §6 is about is the remaining case —
 * `provider_unavailable`, where nobody was asked because an endpoint had no
 * coordinate — which is Sidequest's work and not the traveller's problem.
 */
const EXCUSED_UNMEASURED = new Set(['mode_not_routed', 'operator_unpublished', 'no_route_found', 'not_remeasured_after_edit']);

/** The fraction of legs a measurement actually reached, and the day totals that depend on it. */
function legStats(itinerary: Itinerary): { measured: number; estimated: number; unmeasured: number; total: number; transfersUnmeasured: number; transfersUnexcused: number } {
  let measured = 0;
  let estimated = 0;
  let unmeasured = 0;
  let transfersUnmeasured = 0;
  let transfersUnexcused = 0;
  for (const day of itinerary.days) {
    for (const item of day.items) {
      const travel = item.travel;
      if (!travel || travel.fromId === travel.toId) continue;
      if (travel.provenance === 'measured') measured += 1;
      else if (travel.provenance === 'estimated') estimated += 1;
      else {
        unmeasured += 1;
        if (travel.role === 'transfer') {
          transfersUnmeasured += 1;
          if (!EXCUSED_UNMEASURED.has(travel.unmeasuredReason ?? '')) transfersUnexcused += 1;
        }
      }
    }
  }
  return { measured, estimated, unmeasured, total: measured + estimated + unmeasured, transfersUnmeasured, transfersUnexcused };
}

const CLAIM_OF_NO_BACKTRACKING = /\b(avoids? backtracking|no backtracking|without backtracking|never doubles? back|no day doubles? back|does not double back|one direction of travel|follows the natural direction)\b/i;

/** Words that give a jurisdiction's property to whatever they follow. */
const JURISDICTION_CLAIMS = /\b(uses|currency is|accepts?|requires a visa|visa-free|drives? on the|speed limits?|legal tender)\b/i;

export function compileQuality(input: QualityCompilerInput): QualityCompilerResult {
  const { itinerary, draft, trip, profile } = input;
  const issues: QualityCompilerIssue[] = [];
  const clean: QualityCompilerCheck[] = [];
  const skipped: { check: QualityCompilerCheck; reason: string }[] = [];
  const corrections: QualityCompilerResult['corrections'] = {};
  /*
   * V10 §16 — A DIAGNOSTIC MAY NOT BREAK A PLAN.
   *
   * `detail` and `travellerNote` are free prose with caps, and one findings
   * sentence longer than its cap threw out of `qualityCompilerReportSchema.parse`
   * and failed a whole build — a compiler whose job is to protect a plan
   * destroying one. Prose is clipped here, deterministically, at the same caps
   * the schema states, following the hard/soft line V9.1 settled: free prose is
   * trimmed, and a hard field (a check id, a severity, a day number) would still
   * throw because a wrong one of those is a bug and not a long sentence.
   */
  const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
  const add = (issue: Omit<QualityCompilerIssue, 'corrected'> & { corrected?: boolean }) =>
    issues.push({
      corrected: false,
      ...issue,
      detail: clip(issue.detail, 400),
      ...(issue.travellerNote ? { travellerNote: clip(issue.travellerNote, 240) } : {}),
    });
  const ran = new Set<QualityCompilerCheck>();
  const mark = (check: QualityCompilerCheck) => ran.add(check);

  // --- §2 a destination region may not become its containing country ----------
  mark('destination_not_country');
  if (input.concept) {
    const phraseType = phraseSemanticType(parseDestinationIntent(input.concept.rawText).children);
    if (degradedToCountry({ phraseType, type: input.concept.type, scale: input.concept.scale, centerBasis: input.concept.centerBasis })) {
      add({
        check: 'destination_not_country',
        severity: 'blocker',
        detail: `"${input.concept.rawText}" reads as ${phraseType.replace(/_/g, ' ')} and the concept came out as ${input.concept.type} at ${input.concept.scale} scale, centred by ${input.concept.centerBasis.replace(/_/g, ' ')}.`,
        travellerNote: `Sidequest has not pinned down where ${input.concept.label} is yet, so the map is showing the country around it.`,
      });
    } else if (centreIsStandIn(input.concept.centerBasis) && !input.concept.extent) {
      add({
        check: 'destination_not_country',
        severity: 'caution',
        detail: `"${input.concept.rawText}" has no extent and its centre is only a ${input.concept.centerBasis.replace(/_/g, ' ')}.`,
        travellerNote: `Sidequest is still locating ${input.concept.label} precisely.`,
      });
    }
  } else {
    skipped.push({ check: 'destination_not_country', reason: 'the build did not carry a destination concept' });
    ran.delete('destination_not_country');
  }

  // --- §5 route-critical placement --------------------------------------------
  mark('route_critical_placed');
  if (input.placement) {
    const unplaced = unplacedCritical(input.placement);
    if (unplaced.length > 0) {
      /* A blocker only when a provider answered and the answer was unusable; Sidequest's own gaps are issues (§19). */
      const blocking = placementBlocksReady(input.placement);
      add({
        check: 'route_critical_placed',
        severity: blocking ? 'blocker' : 'issue',
        detail: `${unplaced.length} of ${input.placement.placements.length} route-critical names unplaced (rate ${routeCriticalRate(input.placement)}): ${unplaced.map((p) => `${p.name} [${p.kind}/${p.outcome}]`).join(', ')}.`,
        travellerNote: unplaced
          .filter((p) => p.travellerNote)
          .slice(0, 2)
          .map((p) => p.travellerNote!)
          .join(' ') || undefined,
      });
    }
  } else {
    skipped.push({ check: 'route_critical_placed', reason: 'the build did not carry a placement report' });
    ran.delete('route_critical_placed');
  }

  // --- §7 order coherence, and the claim about it -----------------------------
  mark('route_order_coherent');
  mark('no_backtracking_claim');
  const orders = input.dayOrders ?? [];
  if (orders.length === 0) {
    skipped.push({ check: 'route_order_coherent', reason: 'the build did not carry day-order verdicts' });
    ran.delete('route_order_coherent');
  } else {
    for (const { dayNumber, report, corrected } of orders) {
      if (report.verdict === 'violation') {
        add({
          check: 'route_order_coherent',
          severity: corrected ? 'caution' : 'blocker',
          dayNumber,
          detail: `Day ${dayNumber} ${corrected ? 'was reordered' : 'doubles back'}: ${Math.round(report.plannedKm)} km planned against ${Math.round(report.bestKm)} km best (${Math.round(report.excessFraction * 100)}% excess). ${report.violations.map((v) => v.detail).join(' ')}`,
          ...(corrected || !report.violations[0] ? {} : { travellerNote: `Day ${dayNumber} doubles back on itself: ${report.violations[0].detail}` }),
          corrected,
        });
      } else if (report.verdict === 'unplaceable') {
        add({
          check: 'route_order_coherent',
          severity: 'issue',
          dayNumber,
          detail: `Day ${dayNumber}'s order could not be judged: ${report.unplaced.join(', ')} unplaced.`,
        });
      }
    }
  }
  /*
   * A claim the plan's own geometry contradicts is corrected, because the
   * correct sentence is derivable: the geometry says which days double back.
   */
  const rationale = input.claims?.routeRationale ?? itinerary.package?.routeRationale ?? '';
  const doublingBack = orders.filter((o) => o.report.verdict === 'violation');
  if (CLAIM_OF_NO_BACKTRACKING.test(rationale) && doublingBack.length > 0) {
    const uncorrected = doublingBack.filter((o) => !o.corrected);
    if (uncorrected.length > 0) {
      corrections.routeRationale = `${rationale.replace(CLAIM_OF_NO_BACKTRACKING, 'follows the bases in order').trim()} Day${uncorrected.length === 1 ? '' : 's'} ${uncorrected.map((o) => o.dayNumber).join(', ')} still double${uncorrected.length === 1 ? 's' : ''} back within the day.`;
      add({
        check: 'no_backtracking_claim',
        severity: 'issue',
        detail: `The route rationale claimed the plan does not double back, and day${uncorrected.length === 1 ? '' : 's'} ${uncorrected.map((o) => o.dayNumber).join(', ')} do.`,
        corrected: true,
      });
    }
  }

  // --- §6 route completeness, and precision that outruns it -------------------
  mark('route_completeness');
  const legs = legStats(itinerary);
  if (legs.total > 0) {
    const rate = legs.measured / legs.total;
    if (legs.transfersUnexcused > 0) {
      /* Sidequest's own gap: nobody was asked, because an endpoint had no coordinate. */
      add({
        check: 'route_completeness',
        severity: 'blocker',
        detail: `${legs.transfersUnexcused} base transfer${legs.transfersUnexcused === 1 ? '' : 's'} unmeasured with no honest reason; ${legs.measured} of ${legs.total} legs measured overall.`,
        travellerNote: `${legs.transfersUnexcused === 1 ? 'One move between bases has' : `${legs.transfersUnexcused} moves between bases have`} not been timed yet, so those days show parts of the day rather than clock times.`,
      });
    } else if (legs.transfersUnmeasured > 0) {
      /*
       * A flight, ferry or guided transfer nobody road-routes is plausible, never
       * impossible, and never a defect — V9.1's doctrine. It is still said out
       * loud, because a day timed from an operator's schedule reads differently.
       */
      add({
        check: 'route_completeness',
        severity: 'caution',
        detail: `${legs.transfersUnmeasured} base transfer${legs.transfersUnmeasured === 1 ? '' : 's'} not road-routable or refused by the router; ${legs.measured} of ${legs.total} legs measured overall.`,
        travellerNote: `${legs.transfersUnmeasured === 1 ? 'One move between bases is' : `${legs.transfersUnmeasured} moves between bases are`} timed by the operator rather than by a road router, so those days show parts of the day.`,
      });
    }
    /*
     * §6 — "No 'Travel per day 3h44m' style precision may be shown when the
     * underlying route is predominantly unmeasured." The figure is not deleted;
     * the disclosure that goes with it is made to say what it rests on.
     */
    if (rate < 0.5) {
      corrections.transportDisclosure = `${legs.measured} of ${legs.total} travel legs were measured. Because most were not, the daily travel figures on this plan are a range rather than a time, and the days they sit on are shown in parts of the day.`;
      add({
        check: 'route_completeness',
        severity: 'issue',
        detail: `Only ${legs.measured} of ${legs.total} legs measured (${Math.round(rate * 100)}%); a single daily travel figure would overstate what is known.`,
        corrected: true,
      });
    }
  } else {
    skipped.push({ check: 'route_completeness', reason: 'the plan holds no travel legs' });
    ran.delete('route_completeness');
  }

  // --- §2 jurisdiction language -----------------------------------------------
  mark('jurisdiction_language');
  if (input.concept && input.concept.jurisdictions.length > 0) {
    const label = input.concept.label;
    const country = jurisdictionPhrase(input.concept.jurisdictions);
    const prose = [itinerary.summary, itinerary.package?.purpose, itinerary.package?.routeRationale, ...(itinerary.package?.beforeYouGo ?? [])].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (label.toLowerCase() !== country.toLowerCase()) {
      for (const sentence of prose) {
        const pattern = new RegExp(`${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+(?:\\w+\\s+){0,2}?(${JURISDICTION_CLAIMS.source})`, 'i');
        if (pattern.test(sentence)) {
          add({
            check: 'jurisdiction_language',
            severity: 'issue',
            detail: `A sentence gives a jurisdiction's property to the destination: "${sentence.slice(0, 140)}". The jurisdiction is ${country}.`,
            travellerNote: `Currency, visas and driving rules belong to ${country}, not to ${label}.`,
          });
          break;
        }
      }
    }
  } else {
    skipped.push({ check: 'jurisdiction_language', reason: 'no jurisdictions were resolved for this destination' });
    ran.delete('jurisdiction_language');
  }

  // --- §8 gateways ------------------------------------------------------------
  mark('gateway_feasible');
  if (input.gateway) {
    if (gatewayInfeasible(input.gateway)) {
      add({
        check: 'gateway_feasible',
        severity: 'blocker',
        detail: `Gateway feasibility: arrival ${input.gateway.arrivalFeasibility}, departure ${input.gateway.departureFeasibility}. ${input.gateway.notes.join(' ')}`,
        travellerNote: input.gateway.notes[0],
      });
    } else if (input.gateway.arrivalFeasibility === 'unmeasured' || input.gateway.departureFeasibility === 'unmeasured') {
      add({
        check: 'gateway_feasible',
        severity: 'issue',
        detail: `A gateway transfer was never timed: arrival ${input.gateway.arrivalFeasibility}, departure ${input.gateway.departureFeasibility}.`,
        travellerNote: input.gateway.notes[0],
      });
    }
  } else {
    skipped.push({ check: 'gateway_feasible', reason: 'the build did not carry a gateway plan' });
    ran.delete('gateway_feasible');
  }

  // --- §9 access: closures, and required modes --------------------------------
  mark('no_closed_stop');
  mark('access_requirements_represented');
  const constraints = input.accessConstraints ?? [];
  if (constraints.length === 0) {
    skipped.push({ check: 'no_closed_stop', reason: 'no access constraints were loaded for this destination' });
    skipped.push({ check: 'access_requirements_represented', reason: 'no access constraints were loaded for this destination' });
    ran.delete('no_closed_stop');
    ran.delete('access_requirements_represented');
  } else {
    /* Every stop is evaluated against its own day, never against the trip window: "closed in September" is a fact about September. */
    for (const day of itinerary.days) {
      for (const item of day.items) {
        if (item.kind !== 'activity') continue;
        const verdict = evaluateAccess({ constraints, placeName: item.title, ...(item.placeId ? { placeRef: item.placeId } : {}), dates: [day.date] });
        if (verdict.blocking) {
          add({
            check: 'no_closed_stop',
            severity: 'blocker',
            dayNumber: day.dayNumber,
            detail: `${item.title} is ${verdict.status.replace(/_/g, ' ')} on ${day.date} per ${verdict.basis[0]?.sourceName ?? 'an official source'}, and is scheduled as an ordinary stop.`,
            travellerNote: describeAccess(item.title, verdict) ?? undefined,
          });
        } else if (verdict.dependency) {
          /* A dependency is only a defect when the plan does not carry it. */
          const carried = (item.accessWarning ?? '').length > 0 || (day.warnings ?? []).some((w) => w.includes(item.title));
          add({
            check: 'access_requirements_represented',
            severity: carried ? 'caution' : 'blocker',
            dayNumber: day.dayNumber,
            detail: `${item.title} needs ${verdict.requiredMode ?? 'a reservation'}${carried ? ', and the day says so' : ', and nothing on the day says so'}.`,
            travellerNote: describeAccess(item.title, verdict) ?? undefined,
          });
        }
        if (verdict.status === 'unknown' && verdict.travellerNote) {
          add({
            check: 'no_closed_stop',
            severity: 'caution',
            dayNumber: day.dayNumber,
            detail: `${item.title}: an unofficial source raised an access question, which is not a verdict. ${verdict.travellerNote}`,
          });
        }
      }
    }
  }

  // --- §4 §13 experiences: double counting and transport semantics ------------
  mark('no_duplicate_experience');
  mark('transport_semantics');
  if (input.experiences && input.experiences.experiences.length > 0) {
    const stopRefs = itinerary.days.flatMap((day) => day.items.filter((i) => i.kind === 'activity').map((i) => i.placeId ?? i.id));
    for (const duplicate of doubleCounted({ graph: input.experiences, stopRefs })) {
      add({
        check: 'no_duplicate_experience',
        severity: 'blocker',
        detail: `${duplicate.experienceName} is counted ${duplicate.refs.length} times as separate stops (${duplicate.refs.join(', ')}).`,
        travellerNote: `${duplicate.experienceName} is one thing to do, and the plan lists it more than once.`,
      });
    }
    for (const day of itinerary.days) {
      for (const item of day.items) {
        const travel = item.travel;
        if (!travel || travel.fromId === travel.toId) continue;
        const verdict = transportBetweenStops({ graph: input.experiences, fromRef: travel.fromId, toRef: travel.toId });
        if (!verdict.isTransport) {
          add({
            check: 'transport_semantics',
            severity: 'blocker',
            dayNumber: day.dayNumber,
            detail: `A travel leg was drawn from ${travel.fromName} to ${travel.toName}, but ${verdict.reason}.`,
            travellerNote: `${verdict.containedBy?.experienceName ?? 'One experience'} is one thing, and the plan puts travel inside it.`,
          });
        }
      }
    }
  } else {
    skipped.push({ check: 'no_duplicate_experience', reason: 'the build did not carry an experience graph' });
    skipped.push({ check: 'transport_semantics', reason: 'the build did not carry an experience graph' });
    ran.delete('no_duplicate_experience');
    ran.delete('transport_semantics');
  }

  // --- §22 a required mode is never generic car travel ------------------------
  if (input.experiences) {
    for (const { experience, access } of requiredAccess(input.experiences)) {
      const day = itinerary.days.find((d) => d.dayNumber === experience.dayNumber);
      const leg = day?.items.find((i) => i.travel && i.travel.toId === (experience.anchorId ?? experience.id));
      const mode = leg?.travel?.mode;
      if (mode && mode === 'drive' && access.mode !== 'drive') {
        add({
          check: 'access_requirements_represented',
          severity: 'blocker',
          ...(experience.dayNumber ? { dayNumber: experience.dayNumber } : {}),
          detail: `${experience.name} is reached only by ${access.mode.replace(/_/g, ' ')} and the plan's leg to it is a drive.`,
          travellerNote: `${experience.name} cannot be driven to — ${access.mode === 'shuttle' ? 'it is the shuttle or nothing' : `it is reached by ${access.mode.replace(/_/g, ' ')}`}.`,
        });
      }
    }
  }

  // --- §16 time-of-day intent, and day duration -------------------------------
  mark('time_of_day_respected');
  mark('day_duration_plausible');
  for (const day of itinerary.days) {
    const draftDay = draft.days.find((d) => d.dayNumber === day.dayNumber);
    for (const anchor of draftDay?.anchors ?? []) {
      if (anchor.timeOfDay !== 'sunrise' && anchor.timeOfDay !== 'sunset') continue;
      const item = day.items.find((i) => i.kind === 'activity' && i.title === anchor.name);
      if (!item) continue;
      const hour = Math.floor(item.startMinute / 60);
      const wrong = anchor.timeOfDay === 'sunrise' ? hour > 10 : hour < 15;
      if (wrong) {
        add({
          check: 'time_of_day_respected',
          severity: 'issue',
          dayNumber: day.dayNumber,
          detail: `${anchor.name} is written for ${anchor.timeOfDay} and is scheduled at ${String(hour).padStart(2, '0')}:${String(item.startMinute % 60).padStart(2, '0')}.`,
          travellerNote: `${anchor.name} is best at ${anchor.timeOfDay} and the plan has it in the ${hour < 12 ? 'morning' : 'afternoon'}.`,
        });
      }
    }
    const busy = day.totals.activityMinutes + day.totals.driveMinutes + day.totals.transitMinutes + day.totals.walkMinutes;
    if (busy > day.window.usableMinutes + 120) {
      add({
        check: 'day_duration_plausible',
        severity: 'issue',
        dayNumber: day.dayNumber,
        detail: `Day ${day.dayNumber} holds ${busy} minutes of content and measured travel against a ${day.window.usableMinutes}-minute window.`,
      });
    }
  }

  // --- V12 §24 §26 date-specific calendars -----------------------------------
  /*
   * A stop planned on a day its own calendar disagrees with.
   *
   * The V11 live Kyrgyzstan build put a Sunday market on a Sunday and nothing
   * checked it: the model happened to be right. This is the check that was
   * missing. It reports and never repairs — §26 forbids a second model call,
   * and a deterministic reorder is only safe where the evidence is affirmative,
   * so a `questionable` verdict raises a caution and an `unavailable` one an
   * error, and both name the day that would work instead where one does.
   */
  if ((input.calendarFacts ?? []).length === 0) {
    skipped.push({ check: 'date_specific_calendar', reason: 'no date-specific calendar facts were loaded for this destination' });
  } else {
    mark('date_specific_calendar');
    const tripDates = itinerary.days.map((day) => day.date);
    const conflicts = calendarConflicts({
      facts: input.calendarFacts ?? [],
      tripDates,
      items: itinerary.days.flatMap((day) =>
        day.items.filter((item) => item.kind === 'activity').map((item) => ({ subject: item.title, date: day.date, dayNumber: day.dayNumber })),
      ),
    });
    for (const conflict of conflicts) {
      add({
        check: 'date_specific_calendar',
        /*
         * `issue`, not `blocker`: a stop on a day its calendar refuses is wrong
         * and fixable by moving it, which is a decision the traveller or a
         * deterministic reorder makes — not a reason to refuse the whole trip.
         */
        severity: conflict.status === 'unavailable' ? 'issue' : 'caution',
        detail: `${conflict.subject} is planned for day ${conflict.dayNumber}, which its own calendar does not support${conflict.moveTo ? `; ${conflict.moveTo} would work` : ' and no day of this trip does'}.`,
        travellerNote: conflict.note,
      });
    }
  }

  // --- §10 seasonal feasibility ----------------------------------------------
  mark('seasonal_feasibility');
  const seasonalWarnings = itinerary.transportStrategy.seasonalWarnings ?? [];
  /*
   * Only the closures that actually touch this trip's window. A road that shuts in
   * January is not a caution on a September trip, and warning about it would train
   * the traveller to ignore the warnings that matter.
   */
  const closedBySeason = constraints.filter((c) => {
    if (c.status !== 'seasonal_closure' && c.requiredMode === undefined) return false;
    const from = c.validFrom ?? '0000-01-01';
    const until = c.validUntil ?? '9999-12-31';
    return c.status === 'seasonal_closure' && trip.basics.endDate >= from && trip.basics.startDate <= until;
  });
  if (closedBySeason.length > 0 && seasonalWarnings.length === 0) {
    add({
      check: 'seasonal_feasibility',
      severity: 'caution',
      detail: `${closedBySeason.length} seasonal closure${closedBySeason.length === 1 ? '' : 's'} fall inside ${trip.basics.startDate}–${trip.basics.endDate} and the plan states no seasonal warning.`,
      travellerNote: closedBySeason[0]!.travellerNote,
    });
  }

  // --- §11 §12 signature quality ---------------------------------------------
  mark('signature_quality');
  /* The draft names what the trip is built around; the profile says what the traveller ranked. */
  const signatures = draft.signatures ?? [];
  const RANK: Record<string, number> = { core: 0, frequent: 1, occasional: 2 };
  const interests = (Object.keys(profile.interests) as (keyof typeof profile.interests)[])
    .filter((key) => RANK[profile.interests[key] ?? 'low'] !== undefined)
    .sort((a, b) => (RANK[profile.interests[a] ?? 'low'] ?? 9) - (RANK[profile.interests[b] ?? 'low'] ?? 9));
  if (signatures.length > 0 && interests.length > 0) {
    const values = signatures.map((name: string) => {
      const anchor = itinerary.package?.anchors.find((a) => a.name === name || name.includes(a.name));
      return scoreExperienceValue({
        name,
        tags: anchor?.category ? [anchor.category] : [],
        travellerInterests: interests,
        avoidances: profile.avoidances,
        ...(anchor?.verification ? { verification: anchor.verification } : {}),
      });
    });
    const verdict = definingSetIsWeak({ values });
    if (verdict.weak) {
      add({
        check: 'signature_quality',
        severity: 'caution',
        detail: `Signature set looks weak for this traveller: ${verdict.detail}`,
      });
    }
  } else {
    skipped.push({ check: 'signature_quality', reason: signatures.length === 0 ? 'the plan names no signature experiences' : 'the traveller ranked no interests' });
    ran.delete('signature_quality');
  }

  for (const check of QUALITY_COMPILER_CHECKS) {
    if (ran.has(check) && !issues.some((i) => i.check === check)) clean.push(check);
  }
  const report = qualityCompilerReportSchema.parse({
    version: QUALITY_COMPILER_VERSION,
    passed: issues.every((i) => i.severity !== 'blocker'),
    clean,
    issues: issues.slice(0, 120),
    skipped,
  });
  return { report, corrections };
}

/** The blockers, for the feasibility verdict and the operator log. */
export function qualityBlockers(report: QualityCompilerReport): readonly QualityCompilerIssue[] {
  return compilerBlockers(report);
}

/**
 * V10 §16 — THE COMPILER MAY NEVER FAIL A BUILD.
 *
 * `compileQuality` is a diagnostic, and a diagnostic that throws takes a finished
 * plan down with it. That is not a hypothetical: a findings sentence nineteen
 * characters over its cap failed a whole generation through
 * `qualityCompilerReportSchema.parse`, and the traveller was shown "Sidequest
 * couldn't finish this build" for a trip that was already composed and
 * reconciled.
 *
 * So the canonical path calls this instead. A throw becomes a report that says,
 * in its own vocabulary, that the compiler could not run — every check
 * `skipped`, nothing `clean`, and `passed` true, because an unrun check is not a
 * failed check and the plan is not the compiler's to condemn. The operator gets
 * the throw in the log; the traveller gets their trip.
 */
export function compileQualitySafely(input: QualityCompilerInput): QualityCompilerResult {
  try {
    return compileQuality(input);
  } catch (error) {
    console.error('The quality compiler could not run; the plan stands and every check is recorded as unrun', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message.slice(0, 400) : undefined,
    });
    return {
      report: qualityCompilerReportSchema.parse({
        version: QUALITY_COMPILER_VERSION,
        passed: true,
        clean: [],
        issues: [],
        skipped: QUALITY_COMPILER_CHECKS.map((check) => ({ check, reason: 'the quality compiler could not run on this build' })),
      }),
      corrections: {},
    };
  }
}
