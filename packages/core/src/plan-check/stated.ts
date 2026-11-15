import { STATED_ITINERARY_VERSION, type StatedItinerary, type StatedProvenance } from '../contract/stated-itinerary';
import type { PlanChange, ProposalStop } from './critique';
import type { ParsedPlanEdge, StopNightsBasis } from './parse';

/**
 * A CHECKED PLAN, AS THE TRAVELLER WILL PLAN IT, INTO THE CANONICAL RECORD.
 *
 * The version they pressed "Plan this" on — the original with the changes they
 * accepted — becomes a `StatedItinerary` (`contract/stated-itinerary.ts`).
 * Provenance follows who decided each number: their own words are `stated`,
 * their structure (a day list) is `parsed`, Sidequest's even split or a safe
 * change applied on their behalf is `assumed`, and a major change they
 * explicitly ticked is theirs now — `stated`.
 */

function provenanceOfBasis(basis: StopNightsBasis | null): StatedProvenance {
  if (basis === 'stated' || basis === 'days_stated') return 'stated';
  if (basis === 'day_list') return 'parsed';
  return 'assumed';
}

export interface StatedFromPlanInput {
  version: readonly ProposalStop[];
  original: readonly ProposalStop[];
  changes: readonly PlanChange[];
  accepted: ReadonlySet<string>;
  placed?: readonly { label: string; placedName: string | null; point: { lat: number; lng: number } | null; countryCode: string | null }[];
  arrival?: ParsedPlanEdge | null;
  departure?: ParsedPlanEdge | null;
  parseConfidence: number;
  now: Date;
}

export function statedItineraryFromPlan(input: StatedFromPlanInput): StatedItinerary {
  const byId = new Map(input.changes.map((c) => [c.id, c] as const));
  const originalOf = new Map(input.original.map((s) => [s.label, s] as const));
  const placedOf = new Map((input.placed ?? []).map((p) => [p.label, p] as const));
  const accepted = input.changes.filter((c) => input.accepted.has(c.id));
  const stops = input.version.slice(0, 12).map((stop, i) => {
    const original = originalOf.get(stop.label);
    const touching = stop.changedBy.map((id) => byId.get(id)).filter((c): c is PlanChange => Boolean(c) && input.accepted.has(c!.id));
    const nightsChanged = original ? original.nights !== stop.nights || original.dayTrip !== stop.dayTrip : true;
    const nightsProvenance: StatedProvenance = !nightsChanged
      ? provenanceOfBasis(stop.nightsBasis)
      : touching.some((c) => c.class === 'major' && c.op.kind !== 'reorder' && c.op.kind !== 'transport')
        ? 'stated'
        : 'assumed';
    const transportChanged = (original?.transportIn ?? null) !== stop.transportIn;
    const transportBy = touching.find((c) => c.op.kind === 'transport');
    const placed = placedOf.get(stop.label);
    return {
      id: `s${i + 1}`,
      label: stop.label.slice(0, 80),
      ...(placed ? { placedName: placed.placedName?.slice(0, 120) ?? null, point: placed.point, countryCode: placed.countryCode } : {}),
      nights: stop.dayTrip ? 0 : Math.max(0, Math.min(60, stop.nights)),
      nightsProvenance,
      dates: !nightsChanged ? stop.dates : null,
      dayTrip: stop.dayTrip,
      fixed: stop.fixed,
      mustSee: stop.mustSee.slice(0, 8).map((m) => m.slice(0, 80)),
      transportIn: stop.transportIn ? { mode: stop.transportIn, provenance: (!transportChanged ? 'stated' : transportBy?.class === 'major' ? 'stated' : 'assumed') as StatedProvenance } : null,
    };
  });
  const edge = (e: ParsedPlanEdge | null | undefined) => (e && (e.place || e.time) ? { place: e.place?.slice(0, 80) ?? null, time: e.time, provenance: 'stated' as const } : null);
  return {
    version: STATED_ITINERARY_VERSION,
    source: 'plan_check',
    stops,
    arrival: edge(input.arrival),
    departure: edge(input.departure),
    parseConfidence: Math.max(0, Math.min(1, input.parseConfidence)),
    acceptedChanges: accepted.slice(0, 24).map((c) => ({ id: c.id.slice(0, 60), kind: c.kind, sentence: c.sentence.slice(0, 400) })),
    recordedAt: input.now.toISOString(),
  };
}
