import {
  benchmarkPlanSchema,
  type BenchmarkPlan,
  type EvidenceRef,
  type PlaceRef,
  type PlanBlock,
  type PlanDay,
} from '@sidequest/bench';
import type { BaselineGeneration } from './generate';
import { placeAt, sourceAt, type ResearchPacket } from './packet-types';

/**
 * FROM WHAT THE MODEL SAID TO WHAT EVERYBODY GRADES.
 *
 * The conversion is where a plan stops being one system's idiom and becomes the
 * neutral artifact the validators and the blind renderer see. Two rules govern
 * every line of it.
 *
 * **An index that addresses nothing degrades; it never crashes and never
 * disappears.** A model that returns `placeIndex: 400` for a packet holding
 * ninety places has made a mistake, and there are three things this code could
 * do about it. Throwing would turn one bad integer into a failed run and lose
 * the other six days. Dropping the block silently would hide the mistake from
 * the very validators built to find it — and would flatter the baseline, because
 * a plan with its worst block quietly removed scores better than one with it
 * left in. So the reference becomes an explicit unknown place, the block stays
 * where the model put it, and the block records why. The neutral plan schema has
 * a representation for exactly this: `entityId: null` on a `placeRef`, which
 * every downstream check reads as "not in the inventory" and answers `unknown`
 * rather than treating as a defect it can prove.
 *
 * **Nothing is invented on the way through.** No default duration, no inferred
 * coordinate, no travel time filled in because the block looked like it needed
 * one. Where the model said nothing, the plan says nothing, and `null` survives
 * to the validators as the absence it is.
 */

export const UNKNOWN_PLACE_NAME = 'A place the plan did not identify';

export interface ConversionResult {
  plan: BenchmarkPlan;
  /** Every index that addressed nothing, so a reviewer can count them. */
  danglingReferences: number;
}

export interface ConvertInput {
  planId: string;
  requestId: string;
  output: BaselineGeneration;
  packet: ResearchPacket;
  /** Kept from the request rather than recomputed, so the two cannot disagree. */
  startDate: string;
  endDate: string;
  generationState: 'complete' | 'partial';
  failureKind: BenchmarkPlan['failureKind'];
  failureDetail: string | null;
  /** Sentences the harness wants on the plan: repair outcomes, provider gaps. */
  extraWarnings?: readonly string[];
  extraUnknowns?: readonly string[];
}

export function toBenchmarkPlan(input: ConvertInput): ConversionResult {
  const { packet, output } = input;
  let danglingReferences = 0;

  const resolve = (index: number | null): PlaceRef | null => {
    if (index === null) return null;
    const place = placeAt(packet, index);
    if (!place) {
      danglingReferences += 1;
      return {
        entityId: null,
        name: UNKNOWN_PLACE_NAME,
        latitude: null,
        longitude: null,
      };
    }
    return {
      entityId: place.entityId,
      name: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
    };
  };

  const evidence = (index: number | null, factPath?: string): EvidenceRef[] => {
    if (index === null) return [];
    if (!sourceAt(packet, index)) {
      // A source index nobody can resolve is dropped rather than passed on: an
      // evidence pointer into nothing would let a plan look sourced while
      // citing a page that does not exist in its own source list.
      danglingReferences += 1;
      return [];
    }
    return [factPath === undefined ? { sourceIndex: index } : { sourceIndex: index, factPath }];
  };

  const dayByNumber = new Map(output.days.map((day) => [day.dayNumber, day]));
  const knownDayNumbers = new Set(packet.days.map((day) => day.dayNumber));
  const strayDays = output.days.filter((day) => !knownDayNumbers.has(day.dayNumber));

  const days: PlanDay[] = packet.days.map((packetDay) => {
    const modelDay = dayByNumber.get(packetDay.dayNumber);
    if (!modelDay) {
      return {
        dayNumber: packetDay.dayNumber,
        date: packetDay.date,
        baseId: null,
        theme: '',
        blocks: [],
        statedTotals: { travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false },
        alternatives: [],
        warnings: ['The plan did not cover this day.'],
      };
    }

    const blocks: PlanBlock[] = modelDay.blocks.map((block) => {
      const uncertainty = [...block.uncertainty];
      const place = resolve(block.placeIndex);
      if (block.placeIndex !== null && place?.entityId === null) {
        uncertainty.push('The plan referred to a place that is not in the research packet.');
      }
      /*
       * A timetable claim the packet cannot check is kept and labelled.
       *
       * Dropping the number would make a scheduled ferry indistinguishable from
       * an unmeasured drive, and keeping it silently would let a plan look
       * sourced on evidence this packet does not hold — the packet's own legs
       * are all `measured` and it carries no timetable at all. So the number
       * stands, the provenance stands, and the block says out loud that nobody
       * here could verify it.
       */
      if (
        block.travel?.provenance === 'published_timetable' &&
        !sourceAt(packet, block.sourceIndex)
      ) {
        uncertainty.push(
          'The plan states this journey time from a timetable the research packet does not hold, so nothing here could check it.',
        );
      }

      return {
        kind: block.kind,
        title: block.title,
        startMinute: block.startMinute,
        endMinute: block.endMinute,
        place,
        travel: block.travel
          ? {
              mode: block.travel.mode,
              from: resolve(block.travel.fromPlaceIndex),
              to: resolve(block.travel.toPlaceIndex),
              /*
               * A time is kept only where the plan claims somebody published
               * it — a routing engine measured it, or a timetable states it. A
               * stated number with `unknown` provenance is a guess wearing a
               * measurement's clothes, and the neutral checks are specifically
               * looking for it — so the honest conversion is to keep the
               * provenance and drop the number.
               */
              minutes: block.travel.provenance === 'unknown' ? null : block.travel.minutes,
              km: null,
              provenance: block.travel.provenance,
            }
          : null,
        meal: block.meal
          ? {
              slot: block.meal.slot,
              stopKind: block.meal.stopKind,
              venue: resolve(block.meal.venuePlaceIndex),
              detourMinutes: block.meal.detourMinutes,
            }
          : null,
        opening: block.opening
          ? {
              openMinute: block.opening.openMinute,
              closeMinute: block.opening.closeMinute,
              // Omitted rather than nulled: the neutral field is optional, and
              // an absent last admission is "nobody published one" rather than
              // "admission closes at minute zero".
              ...(block.opening.lastAdmissionMinute === null
                ? {}
                : { lastAdmissionMinute: block.opening.lastAdmissionMinute }),
              ...(sourceAt(packet, block.opening.sourceIndex)
                ? { evidence: { sourceIndex: block.opening.sourceIndex as number, factPath: 'hours.weekly' } }
                : {}),
            }
          : null,
        note: block.note,
        uncertainty: uncertainty.slice(0, 10),
        evidence: evidence(block.sourceIndex),
      };
    });

    return {
      dayNumber: packetDay.dayNumber,
      date: packetDay.date,
      baseId: modelDay.baseId,
      theme: modelDay.theme,
      blocks: blocks.slice(0, 60),
      /*
       * Carried through, never computed.
       *
       * `statedTotals` exists so a validator can catch a plan that disagrees
       * with its own timeline. Deriving it here from the blocks would make the
       * two agree by construction and the check would pass for ever without
       * examining anything — so the model states what it thinks the day adds up
       * to and this copies the claim across unaltered, including the nulls,
       * which mean it declined to total something rather than that the day had
       * none of it.
       */
      statedTotals: {
        travelMinutes: modelDay.statedTotals.travelMinutes,
        driveMinutes: modelDay.statedTotals.driveMinutes,
        freeMinutes: modelDay.statedTotals.freeMinutes,
        // Stated by the model, not summed from the blocks. See the note above.
        derived: false,
      },
      alternatives: modelDay.alternatives.flatMap((alternative) => {
        const place = resolve(alternative.placeIndex);
        return place ? [{ place, trigger: alternative.trigger, why: alternative.why }] : [];
      }),
      warnings: modelDay.warnings.slice(0, 20),
    };
  });

  const bases = output.bases.map((base) => {
    const resolved = resolve(base.placeIndex);
    return {
      id: base.id,
      /*
       * The model's own name is the fallback rather than an error.
       *
       * A base is frequently a town the packet holds no *place* for — the
       * inventory lists viewpoints and museums, not the settlement around them —
       * so a null index here is the normal case, not a mistake. The reference
       * then carries `entityId: null`, which every downstream check reads as
       * "not in the inventory" and answers `unknown` rather than as a defect.
       */
      place: resolved ?? {
        entityId: null,
        name: base.name,
        latitude: null,
        longitude: null,
      },
      nights: base.nights,
      fromDate: null,
      toDate: null,
      why: base.why,
    };
  });

  const warnings = [
    ...output.warnings,
    ...(input.extraWarnings ?? []),
    ...(strayDays.length > 0
      ? [`The plan described ${strayDays.length} day(s) that are not part of this trip; they were left out.`]
      : []),
  ];

  const unknowns = [...output.unknowns, ...(input.extraUnknowns ?? [])];
  if (danglingReferences > 0) {
    unknowns.push(
      `${danglingReferences} reference(s) in the plan pointed at a place or a source that the research packet does not hold.`,
    );
  }

  const candidate: BenchmarkPlan = {
    schemaVersion: 1,
    planId: input.planId,
    requestId: input.requestId,
    producedBy: 'baseline',
    generationState: input.generationState,
    failureKind: input.failureKind,
    failureDetail: input.failureDetail,
    summary: output.summary,
    destination: {
      entityId: packet.destination.entityId,
      name: packet.destination.displayName,
      latitude: packet.destination.latitude,
      longitude: packet.destination.longitude,
    },
    scopeNote: output.scopeNote,
    startDate: input.startDate,
    endDate: input.endDate,
    bases: bases.slice(0, 20),
    days: days.slice(0, 40),
    exclusions: output.exclusions.flatMap((exclusion) => {
      const place = resolve(exclusion.placeIndex);
      // Written by the system rather than swept up from a reject pile; see
      // `derived` on the plan schema for why the distinction is recorded.
      return place ? [{ place, reason: exclusion.reason, derived: false }] : [];
    }),
    unknowns: dedupe(unknowns).slice(0, 60),
    preparation: dedupe(output.preparation).slice(0, 60),
    warnings: dedupe(warnings).slice(0, 60),
    sources: packet.sources.map((source) => ({
      host: source.host,
      ...(source.title === null ? {} : { title: source.title }),
      ...(source.url === null ? {} : { url: source.url }),
      ...(source.retrievedAt === null ? {} : { retrievedAt: source.retrievedAt }),
    })),
  };

  /*
   * Parsed on the way out, not asserted.
   *
   * Everything above is constructed to satisfy the schema, and the parse is
   * still here because "constructed to satisfy" is a claim about today's code.
   * The schema strips nothing and normalises the defaults, so what the caller
   * receives is what the store will hold and what the validators will read.
   */
  return { plan: benchmarkPlanSchema.parse(candidate), danglingReferences };
}

/**
 * A plan for a run that produced nothing, which is a result rather than a gap.
 *
 * A benchmark that dropped its failures would report a hundred per cent success
 * for whichever system fell over most often, so every terminal state writes a
 * row — with the destination it managed to resolve, the dates it was given, and
 * the failure named in words that identify no provider and no model.
 */
export function failedPlan(input: {
  planId: string;
  requestId: string;
  destination: PlaceRef;
  startDate: string;
  endDate: string;
  failureKind: NonNullable<BenchmarkPlan['failureKind']>;
  failureDetail: string;
  unknowns?: readonly string[];
  warnings?: readonly string[];
}): BenchmarkPlan {
  return benchmarkPlanSchema.parse({
    schemaVersion: 1,
    planId: input.planId,
    requestId: input.requestId,
    producedBy: 'baseline',
    generationState: 'failed',
    failureKind: input.failureKind,
    failureDetail: input.failureDetail,
    summary: '',
    destination: input.destination,
    scopeNote: '',
    startDate: input.startDate,
    endDate: input.endDate,
    bases: [],
    days: [],
    exclusions: [],
    unknowns: dedupe([...(input.unknowns ?? [])]).slice(0, 60),
    preparation: [],
    warnings: dedupe([...(input.warnings ?? [])]).slice(0, 60),
    sources: [],
  });
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
