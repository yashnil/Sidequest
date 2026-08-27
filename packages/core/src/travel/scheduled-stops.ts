/**
 * COUNTING THE SCHEDULED-NETWORK STOPS A REGION PACK ACTUALLY RECORDS.
 *
 * `ScheduledNetworkPresence` (./reach.ts) is explicit that only the party who
 * compiled or loaded the destination can say whether its ground records a
 * scheduled-transport network — the value "arrives as data and is never
 * inferred". This module is that party's pencil. It runs over the pack layers
 * the compiler already holds, counts the records whose own category names a
 * scheduled stop, and returns the observation in a shape the artifact persists
 * (`CompiledRegion.scheduledStops`) so the live path can read it later without
 * the pack.
 *
 * Why kinds and not the gateway headcount that already existed: the artifact's
 * gateway numbers count *ways in and out* — airports, harbours, marinas,
 * stations, all as one figure. A hundred and fifty of those says nothing about
 * whether a timetable-bound network serves the ground; two airports and a
 * ferry pier produce the same kind of number as a metropolis of rail stations.
 * The verdict `transitBlindWalk` turns on needs the kind, so the kind is what
 * is counted and what is kept.
 *
 * THE ENUMERATION, AND WHAT WAS DELIBERATELY LEFT OUT.
 *
 * The kinds below are the source vocabulary's scheduled-stop words as the
 * taxonomy (`packages/compiler/src/backbone/taxonomy.ts`) actually knows them —
 * category words from global catalogues, never a name and never a place. The
 * compiler-side test asserts each one still classifies as a gateway there, so
 * the two tables cannot drift apart silently.
 *
 *   - `railway_station` and `train_station` are the same thing in two
 *     catalogues' spellings, and both are kept: the counts are per source
 *     vocabulary, and collapsing them here would repaint the evidence.
 *   - `bus_station` is a coach terminal — a stop of a scheduled road network.
 *   - `ferry_terminal` is a scheduled stop the same way a rail station is;
 *     reach.ts names ferry terminals in its own definition of the observation.
 *
 * Left out, each for a stated reason rather than by omission:
 *
 *   - `airport` / `international_airport`: scheduled, but not the ground
 *     network this observation describes. An airport must never make a walking
 *     verdict soft — that is precisely the airport-as-attraction mistake in a
 *     new costume.
 *   - `harbor` / `marina` / `ferry`: water gateways and services with no stop
 *     implied. A marina full of private boats says nothing about timetables.
 *   - `bus_stop`: street furniture in the taxonomy, and rightly — a roadside
 *     pole is not a station, and counting poles would make one bus route read
 *     as a network.
 *   - `subway_line` / `tram_line`: infrastructure — a line is not somewhere a
 *     person boards, and the vocabulary carries no subway or tram *station*
 *     leaf today. The day a catalogue publishes one, it is added here and the
 *     version below moves.
 *   - `funicular` / gondolas: scenic rides in the taxonomy, not network stops.
 */

import type { PackLayer } from '../schemas/region-pack';
import {
  SCHEDULED_STOP_OBSERVATION_VERSION,
  type ScheduledStopObservation,
} from '../schemas/compiled-region';
import type { ScheduledNetworkPresence } from './reach';

/** The scheduled-stop kinds the source vocabulary actually has. See header. */
export const SCHEDULED_STOP_KINDS = [
  'bus_station',
  'ferry_terminal',
  'railway_station',
  'train_station',
] as const;
export type ScheduledStopKind = (typeof SCHEDULED_STOP_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(SCHEDULED_STOP_KINDS);

/**
 * The same spelling rule the taxonomy applies before it looks a category up,
 * duplicated by value because the taxonomy lives in the compiler package and
 * this module must stay importable by anything that can read an artifact. The
 * enumeration test pins the two rules to the same output.
 */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Which scheduled-stop kind a record is, or null.
 *
 * Resolution order mirrors `classifySourceCategory`: the leaf first, then the
 * published category path walked innermost-first — so a record filed under an
 * unrecognised local leaf whose own path names a station kind is counted as
 * that kind, exactly as the taxonomy would classify it.
 */
function scheduledStopKindOf(
  category: string,
  path: readonly string[] | undefined,
): string | null {
  const leaf = normalise(category);
  if (KIND_SET.has(leaf)) return leaf;
  for (let index = (path?.length ?? 0) - 1; index >= 0; index -= 1) {
    const segment = normalise(path![index]!);
    if (KIND_SET.has(segment)) return segment;
  }
  return null;
}

/**
 * Count the scheduled-network stops across a pack's layers, by kind.
 *
 * Total across every layer rather than a chosen one, because both real layers
 * legitimately hold stations — a commercial place catalogue and a geographic
 * supplement — and an administrative layer's records (countries, localities)
 * can never match a stop kind, so filtering by layer would be a rule with no
 * witness. A record the source itself marks `closed` is not counted: a station
 * that no longer operates is not evidence of a running network, and one such
 * record must never be what softens a walking verdict.
 *
 * The result is deterministic in its bytes — kinds are written in sorted
 * order whatever order the records arrived in — because the artifact this
 * lands on is held to byte-identity across warm and cold builds.
 */
export function countScheduledStops(layers: readonly PackLayer[]): ScheduledStopObservation {
  const counts = new Map<string, number>();
  let total = 0;
  for (const layer of layers) {
    for (const record of layer.records) {
      if (record.operatingStatus === 'closed') continue;
      const kind = scheduledStopKindOf(record.sourceCategory, record.sourceCategoryPath);
      if (kind === null) continue;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      total += 1;
    }
  }
  const byKind: Record<string, number> = {};
  for (const kind of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    byKind[kind] = counts.get(kind)!;
  }
  return { version: SCHEDULED_STOP_OBSERVATION_VERSION, byKind, total };
}

/**
 * Read a persisted observation into the value `travelKnowledgeFor` takes.
 *
 * Three honest answers and no fourth:
 *
 *   - **absent** (an artifact compiled before the field existed, or a build
 *     with no pack to read): null — "nobody said", which opens no gate;
 *   - **counted zero**: 'not_observed' — the evidence was read and records no
 *     scheduled stop, so a long walk really is the story;
 *   - **any counted stop**: 'observed'.
 *
 * A version this reader does not know is treated as absent rather than
 * reinterpreted: counts written under a different counting rule are a
 * different claim, and "nobody said" is the only sentence that stays true.
 */
export function scheduledNetworkFrom(
  observation: ScheduledStopObservation | null | undefined,
): ScheduledNetworkPresence | null {
  if (!observation) return null;
  if (observation.version !== SCHEDULED_STOP_OBSERVATION_VERSION) return null;
  return observation.total > 0 ? 'observed' : 'not_observed';
}
