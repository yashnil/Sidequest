import type { DestinationAffordanceProfile } from '../destinations/affordances';
import { modeStatusFor } from '../reality/schema';
import type { TravelReality } from '../reality/schema';
import type { TransportMode } from '../schemas/access';

/**
 * V12 §17 — A MODE NEEDS THE WORLD TO SUPPORT IT, NOT THE TRAVELLER TO ACCEPT IT.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * The V11 §S live acceptance produced three **ferry** legs inside the Canadian
 * Rockies — Canmore to Moraine Lake, Consolation Lakes to Lake Louise, and Lake
 * Louise to its own lakeshore — each holding sixty to a hundred and twenty
 * minutes and each reported, accurately, as *"a journey Sidequest's road router
 * cannot measure"*. The draft had hinted `boat`; the reconciler translated the
 * hint faithfully; nothing asked whether there was any water.
 *
 * The only gate on that path was `permittedModesFor(profile)`, which returns
 * `walk`, `rail` and `ferry` **for everybody, unconditionally**. It answers
 * *"what modes will this traveller accept?"* — a preference question — and was
 * standing where the question is *"what modes does this trip actually use?"* — a
 * question about the world. A traveller who is happy to take a ferry does not
 * put water between Lake Louise and its own shore.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Most modes need no evidence: a car, a walk, a taxi, a shuttle or an arranged
 * transfer can be organised almost anywhere, and refusing one would invent a
 * constraint. Two do need it, because they depend on infrastructure that either
 * exists at a place or does not — **water** and **rail**.
 *
 * And the evidence has to be *affirmative*. This is the same rule V9.1 applies
 * to routing silences and V11 applies to refused measurements: `unknown` is not
 * `no`, and it is not `yes` either. A country that says nothing about ferries
 * removes nothing; a destination nobody could screen refuses nothing. What is
 * withdrawn is only the mode that the world, having been asked, does not support.
 *
 * Pure: no provider, no clock, no model.
 */

/** Where the belief that this trip really uses a mode came from. */
export const MODE_EVIDENCE_KINDS = [
  /** The destination screening found the ground itself supports it. */
  'destination_trait',
  /** The country's own travel reality lists the mode as something other than unavailable. */
  'country_mode',
  /** A multi-day experience on this trip moves this way. */
  'episode',
  /** A day's own stated move says so — the trip declaring how it gets between two bases. */
  'day_move',
] as const;
export type ModeEvidenceKind = (typeof MODE_EVIDENCE_KINDS)[number];

export interface ModeEvidence {
  kind: ModeEvidenceKind;
  /** One sentence a person can check. Never a field name. */
  note: string;
}

export interface ModeWorldInput {
  affordances?: DestinationAffordanceProfile | null | undefined;
  reality?: TravelReality | null | undefined;
  /** How the multi-day experiences on this trip move (`episode.mode`). */
  episodeModes?: readonly string[] | undefined;
  /** What the days' own `move.how` values say, where a day declares one. */
  dayMoveModes?: readonly string[] | undefined;
}

/** The transport modes whose existence is a fact about the world rather than an arrangement. */
const NEEDS_WORLD_EVIDENCE: ReadonlySet<TransportMode> = new Set<TransportMode>(['ferry', 'rail']);

export function modeNeedsWorldEvidence(mode: TransportMode): boolean {
  return NEEDS_WORLD_EVIDENCE.has(mode);
}

const WATER_WORDS = new Set(['ferry', 'boat', 'cruise', 'speedboat', 'seaplane']);
const RAIL_WORDS = new Set(['rail', 'train', 'metro', 'high_speed_rail', 'subway']);

function stated(values: readonly string[] | undefined, words: ReadonlySet<string>): boolean {
  return (values ?? []).some((value) => words.has(String(value).toLowerCase()));
}

/** Every reason to believe this trip really crosses water. Empty means nothing said so. */
export function waterEvidence(input: ModeWorldInput): ModeEvidence[] {
  const out: ModeEvidence[] = [];
  const affordances = input.affordances;
  if (affordances && !affordances.unknown) {
    const trait = affordances.operationalTraits.find((entry) => entry.trait === 'water_transfer_dependency');
    if (trait) out.push({ kind: 'destination_trait', note: trait.basis || 'Getting around here depends on crossing water.' });
    else if (affordances.affordances.some((entry) => entry.style === 'island_hopping' && entry.strength !== 'weak')) {
      out.push({ kind: 'destination_trait', note: 'This is a place people move between by boat.' });
    }
  }
  if (input.reality) {
    const ferry = modeStatusFor(input.reality, 'ferry');
    /*
     * `unknown` is deliberately not evidence. A country row that has never been
     * asked about ferries is silent, and silence is what this whole module
     * refuses to read as an answer — in either direction.
     */
    if (ferry === 'recommended' || ferry === 'viable') out.push({ kind: 'country_mode', note: 'Ferries are a normal way to travel in this country.' });
  }
  if (stated(input.episodeModes, WATER_WORDS)) out.push({ kind: 'episode', note: 'Part of this trip is a journey by boat.' });
  if (stated(input.dayMoveModes, WATER_WORDS)) out.push({ kind: 'day_move', note: 'A day on this trip moves between bases by boat.' });
  return out;
}

/** Every reason to believe this trip really uses trains. */
export function railEvidence(input: ModeWorldInput): ModeEvidence[] {
  const out: ModeEvidence[] = [];
  const affordances = input.affordances;
  if (affordances && !affordances.unknown) {
    const dense = affordances.operationalTraits.find((entry) => entry.trait === 'dense_transit');
    if (dense) out.push({ kind: 'destination_trait', note: dense.basis || 'There is a dense public-transport network here.' });
  }
  if (input.reality) {
    for (const mode of ['intercity_train', 'high_speed_rail', 'metro'] as const) {
      const status = modeStatusFor(input.reality, mode);
      if (status === 'recommended' || status === 'viable') {
        out.push({ kind: 'country_mode', note: 'Trains are a normal way to travel in this country.' });
        break;
      }
    }
  }
  if (stated(input.episodeModes, RAIL_WORDS)) out.push({ kind: 'episode', note: 'Part of this trip is a rail journey.' });
  if (stated(input.dayMoveModes, RAIL_WORDS)) out.push({ kind: 'day_move', note: 'A day on this trip moves between bases by train.' });
  return out;
}

export interface ModeConsistencyVerdict {
  /** Whether the trip may carry a leg in this mode. */
  ok: boolean;
  /** What made it believable. Empty on a refusal. */
  evidence: ModeEvidence[];
  /**
   * Why it was refused, as one traveller-readable sentence, or null when it was
   * not refused. Never a field name (§19).
   */
  refusal: string | null;
}

/**
 * Whether a leg in this mode is consistent with the world this trip happens in.
 *
 * A mode that needs no world evidence is always consistent: refusing a hired car
 * or an arranged transfer because nothing mentioned one would invent a limit.
 */
export function assessModeConsistency(mode: TransportMode, world: ModeWorldInput): ModeConsistencyVerdict {
  if (!modeNeedsWorldEvidence(mode)) return { ok: true, evidence: [], refusal: null };
  const evidence = mode === 'ferry' ? waterEvidence(world) : railEvidence(world);
  if (evidence.length > 0) return { ok: true, evidence, refusal: null };
  /*
   * NOTHING KNOWN IS NOT A REFUSAL.
   *
   * The first version of this function refused a mode whenever it found no
   * evidence, which made silence a verdict — the exact mistake this module was
   * written to stop, committed one layer up. A destination that was never
   * screened and a country that was never asked say *nothing*, and a plan is
   * entitled to its own hint when nothing contradicts it. It is only where the
   * world **was** consulted and came back without water, or without rail, that a
   * leg in that mode is a journey nobody can take.
   *
   * The Canadian Rockies were consulted: screened as a mountain road-trip region
   * that depends on a car, with no water among the traits. That is what makes
   * the refusal there honest, and it is why a city nobody screened keeps its ferry.
   */
  const consulted = Boolean((world.affordances && !world.affordances.unknown) || world.reality);
  if (!consulted) return { ok: true, evidence: [], refusal: null };
  return {
    ok: false,
    evidence: [],
    refusal:
      mode === 'ferry'
        ? 'Nothing about this place or this trip says it crosses water, so a boat leg here would be a journey nobody can take.'
        : 'Nothing about this place or this trip says it uses trains, so a rail leg here would be a journey nobody can take.',
  };
}
