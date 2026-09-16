import { railEvidence, waterEvidence, type ModeEvidence, type ModeWorldInput } from '../operating/mode-consistency';
import { modeStatusFor } from '../reality/schema';
import type { MobilityPattern, OperatingPolicy } from '../operating/model';
import { TRAVEL_MODE_CONCEPT_FAMILY, TRAVEL_MODE_LABELS, isWaterMode, type TravelMode } from './vocabulary';

/**
 * V12.1 §6 §7 §17 — WHICH MODES THIS TRIP ACTUALLY USES.
 *
 * ── THE CONCEPTUAL MISTAKE THIS FIXES ───────────────────────────────────────
 *
 * `permittedModesFor(profile)` answers **"what modes will this traveller
 * accept?"** and returns `walk`, `rail` and `ferry` to everybody
 * unconditionally. It was standing where the question is **"what modes make
 * sense here?"**, and three ferry legs inside the Canadian Rockies is what that
 * substitution costs — including one between Lake Louise and its own lakeshore.
 *
 * V12 §17 fixed the water and rail half of it in `operating/mode-consistency.ts`
 * and this extends the same rule to every mode, over the full eighteen-value
 * vocabulary rather than the ten persisted labels. The evidence functions are
 * *reused*, not re-implemented: `waterEvidence` and `railEvidence` stay where
 * V12 put them and this calls them.
 *
 * ── THE PIPELINE (§6) ───────────────────────────────────────────────────────
 *
 *     traveller accepts
 *       ∩ operating policy expects
 *       ∩ the world affords
 *       ∩ geography allows
 *       ∩ the plan itself proposes
 *     = candidate modes
 *
 * and then, separately, verification decides whether one can be *measured*.
 * Those last two are kept apart on purpose: a mode nobody can time is still a
 * mode the trip uses, and collapsing the two is what produced "allowance".
 *
 * ── THE RULE THAT KEEPS IT HONEST ───────────────────────────────────────────
 *
 * **Absence in the world data is never a refusal.** Only affirmative evidence
 * of unavailability may veto. A destination nobody screened refuses nothing; a
 * country nobody asked about ferries removes no ferry. What is withdrawn is
 * only the mode the world, *having been consulted*, does not have. V12 §17 took
 * this exact correction after a city-state acceptance lost a legitimate ferry,
 * and it is restated here because this module widens the surface the mistake
 * could be made on.
 *
 * Pure: no provider, no clock, no model.
 */

export interface ModeScreening {
  mode: TravelMode;
  /** Whether this trip may carry a journey in this mode. */
  ok: boolean;
  /** What made it believable. Empty on a refusal, and empty is also normal for a mode that needs no evidence. */
  evidence: ModeEvidence[];
  /** One traveller-readable sentence, or null. Never a field name (§19). */
  refusal: string | null;
  /** Which stage of the pipeline refused it. For the audit, never for a traveller. */
  refusedBy: 'world' | 'geography' | 'traveler' | 'policy' | null;
}

const OK = (mode: TravelMode, evidence: ModeEvidence[] = []): ModeScreening => ({ mode, ok: true, evidence, refusal: null, refusedBy: null });

/* ────────────────────────────────────────────────────────────────────────────
 * §8 — WHAT EACH OPERATING FAMILY EXPECTS TO MOVE BY
 *
 * Expectations, emphatically not proof. A trip whose policy is `walk_and_transit`
 * expects to walk and ride; that neither creates a metro where there is none nor
 * forbids the one taxi to the airport. The list is used to *prefer*, and — for
 * exactly one pattern — to refuse, which is noted at the refusal.
 * ──────────────────────────────────────────────────────────────────────────── */

export const PATTERN_MODES: Record<MobilityPattern, readonly TravelMode[]> = {
  walk_and_transit: ['walk', 'urban_transit', 'bus', 'rail', 'taxi', 'bike', 'ferry'],
  self_drive: ['drive', 'four_wheel_drive', 'walk', 'ferry', 'cable_car_or_lift'],
  driven: ['private_transfer', 'four_wheel_drive', 'drive', 'walk', 'operator_transfer'],
  scheduled_transport: ['rail', 'bus', 'ferry', 'flight', 'urban_transit', 'walk', 'taxi'],
  operator_transfer: ['operator_transfer', 'private_transfer', 'boat', 'shuttle', 'flight', 'walk'],
  trail: ['trail', 'walk', 'operator_transfer', 'four_wheel_drive', 'horse', 'shuttle'],
  mixed: ['walk', 'drive', 'rail', 'bus', 'urban_transit', 'taxi', 'ferry', 'private_transfer', 'shuttle', 'flight'],
};

/** Whether a mode is what this kind of trip travels by. Never a refusal on its own. */
export function patternExpects(pattern: MobilityPattern, mode: TravelMode): boolean {
  return PATTERN_MODES[pattern].includes(mode);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE WORLD SCREEN
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The modes whose existence is a fact about the ground rather than an
 * arrangement.
 *
 * A car, a walk, a taxi, a hired driver or an arranged transfer can be
 * organised almost anywhere, and refusing one because nothing mentioned it
 * would invent a constraint. These five depend on infrastructure that is
 * either there or is not.
 */
const NEEDS_WORLD_EVIDENCE: ReadonlySet<TravelMode> = new Set<TravelMode>(['ferry', 'boat', 'rail', 'urban_transit', 'flight']);

export function modeNeedsWorld(mode: TravelMode): boolean {
  return NEEDS_WORLD_EVIDENCE.has(mode);
}

/** Whether the world was consulted at all. Nothing may be refused on a silence (V12 §17). */
function consulted(world: ModeWorldInput): boolean {
  return Boolean((world.affordances && !world.affordances.unknown) || world.reality);
}

/**
 * Affirmative evidence that a country says a mode is not available.
 *
 * `unavailable` only. `discouraged` is advice, `unknown` is silence, and
 * neither may remove a journey — the same three-way reading V9.1 applies to a
 * routing silence.
 */
function countryRefuses(world: ModeWorldInput, mode: TravelMode): boolean {
  if (!world.reality) return false;
  const family = TRAVEL_MODE_CONCEPT_FAMILY[mode];
  if (family.length === 0) return false;
  return family.every((concept) => modeStatusFor(world.reality!, concept) === 'unavailable');
}

const REFUSAL_SENTENCE: Partial<Record<TravelMode, string>> = {
  ferry: 'Nothing about this place or this trip says it crosses water, so a boat leg here would be a journey nobody can take.',
  boat: 'Nothing about this place or this trip says it crosses water, so a boat leg here would be a journey nobody can take.',
  rail: 'Nothing about this place or this trip says it uses trains, so a rail leg here would be a journey nobody can take.',
  urban_transit: 'Nothing about this place says it has a metro or a city network, so a transit leg here would be a journey nobody can take.',
  flight: 'Nothing about this trip says it flies between these two points.',
};

/**
 * Whether a journey in this mode is consistent with the world this trip
 * happens in.
 *
 * Water and rail delegate to V12's evidence functions, unchanged. Urban transit
 * reuses the rail evidence, because the thing that establishes both is a screened
 * dense network or a country that runs one. Flight is the only mode whose
 * evidence is the plan's own — no destination trait says "people fly here", and
 * an internal-flight trait or a day that declares a flight is the honest signal.
 */
export function screenModeAgainstWorld(mode: TravelMode, world: ModeWorldInput): ModeScreening {
  if (countryRefuses(world, mode)) {
    return {
      mode,
      ok: false,
      evidence: [],
      refusal: `${TRAVEL_MODE_LABELS[mode]} is not available in this country, so the plan cannot rest on it.`,
      refusedBy: 'world',
    };
  }
  if (!modeNeedsWorld(mode)) return OK(mode);

  const evidence = isWaterMode(mode) ? waterEvidence(world) : mode === 'flight' ? flightEvidence(world) : railEvidence(world);
  if (evidence.length > 0) return OK(mode, evidence);
  if (!consulted(world)) return OK(mode);
  return { mode, ok: false, evidence: [], refusal: REFUSAL_SENTENCE[mode] ?? `Nothing about this place says it supports ${TRAVEL_MODE_LABELS[mode].toLowerCase()}.`, refusedBy: 'world' };
}

/** Reasons to believe this trip really flies between two of its own points. */
export function flightEvidence(world: ModeWorldInput): ModeEvidence[] {
  const out: ModeEvidence[] = [];
  const affordances = world.affordances;
  if (affordances && !affordances.unknown) {
    const trait = affordances.operationalTraits.find((entry) => entry.trait === 'internal_flight_likely');
    if (trait) out.push({ kind: 'destination_trait', note: trait.basis || 'Getting around here usually involves an internal flight.' });
  }
  if (world.reality && modeStatusFor(world.reality, 'flight') !== 'unknown' && modeStatusFor(world.reality, 'flight') !== 'unavailable') {
    out.push({ kind: 'country_mode', note: 'Flying between places is normal in this country.' });
  }
  if ((world.dayMoveModes ?? []).some((value) => String(value).toLowerCase() === 'flight')) out.push({ kind: 'day_move', note: 'A day on this trip moves between bases by air.' });
  if ((world.episodeModes ?? []).some((value) => String(value).toLowerCase() === 'flight')) out.push({ kind: 'episode', note: 'Part of this trip is a flight.' });
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE GEOGRAPHY SCREEN
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How far somebody will plausibly go by each mode, in kilometres.
 *
 * Only the two ends that are genuinely absurd are given bounds. A 90 km walk
 * and a 4 km flight are both journeys nobody makes, and both have shipped: V11
 * §11 corrected a 90 km "walk" from geometry, and this is the same rule stated
 * where every mode can be asked about it rather than only the one that failed.
 *
 * Everything between is left alone, because a 15 km taxi and a 15 km bus are
 * both ordinary and no envelope can tell them apart.
 */
const MODE_KM_BOUNDS: Partial<Record<TravelMode, { min?: number; max?: number }>> = {
  walk: { max: 12 },
  trail: { max: 45 },
  bike: { max: 90 },
  urban_transit: { max: 120 },
  cable_car_or_lift: { max: 30 },
  horse: { max: 60 },
  flight: { min: 80 },
  ferry: { min: 0.5 },
  boat: { min: 0.3 },
};

/**
 * Whether the distance makes this mode absurd.
 *
 * `null` for "no opinion", which is most pairs. A caller with no distance gets
 * no opinion, and that is deliberate: a mode is never refused for a geometry
 * nobody has.
 */
export function screenModeAgainstGeography(mode: TravelMode, straightLineKm: number | null | undefined): ModeScreening {
  if (straightLineKm === null || straightLineKm === undefined || !Number.isFinite(straightLineKm)) return OK(mode);
  const bounds = MODE_KM_BOUNDS[mode];
  if (!bounds) return OK(mode);
  if (bounds.max !== undefined && straightLineKm > bounds.max) {
    return { mode, ok: false, evidence: [], refusal: `${Math.round(straightLineKm)} km is too far to go ${TRAVEL_MODE_LABELS[mode].toLowerCase()}.`, refusedBy: 'geography' };
  }
  if (bounds.min !== undefined && straightLineKm < bounds.min) {
    return { mode, ok: false, evidence: [], refusal: `${straightLineKm < 1 ? 'Under a kilometre' : `${Math.round(straightLineKm)} km`} is too short for ${TRAVEL_MODE_LABELS[mode].toLowerCase()}.`, refusedBy: 'geography' };
  }
  return OK(mode);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE WHOLE PIPELINE
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ModeSelectionInput {
  /** What the traveller said they would use. Absent means they said nothing, which permits everything. */
  accepted?: ReadonlySet<TravelMode> | undefined;
  /** How this kind of trip moves. Absent means no policy was derived. */
  policy?: Pick<OperatingPolicy, 'mobilityPattern'> | undefined;
  world: ModeWorldInput;
  /** The distance this journey covers, where it is known. */
  straightLineKm?: number | null | undefined;
  /** What the plan itself proposed, which always earns a hearing even against the policy's expectations. */
  proposed?: TravelMode | undefined;
}

export interface ModeSelection {
  /** The modes this journey could be, best first. Empty is possible and is an honest answer. */
  candidates: TravelMode[];
  /** Every mode considered and refused, with the stage that refused it. */
  refused: ModeScreening[];
}

/**
 * The candidate modes for one journey.
 *
 * The order is: what the plan proposed first (it is the only party that has seen
 * the trip), then what the policy expects, then everything else that survived.
 * Nothing here decides — a caller picks the first candidate, or keeps the
 * proposal when it survived, which is the same thing.
 */
export function selectModes(input: ModeSelectionInput): ModeSelection {
  const pattern = input.policy?.mobilityPattern;
  const universe: TravelMode[] = input.proposed ? [input.proposed, ...(pattern ? PATTERN_MODES[pattern] : [])] : pattern ? [...PATTERN_MODES[pattern]] : [];
  const considered = [...new Set(universe)];

  const candidates: TravelMode[] = [];
  const refused: ModeScreening[] = [];
  for (const mode of considered) {
    if (input.accepted && !input.accepted.has(mode)) {
      refused.push({ mode, ok: false, evidence: [], refusal: `The traveller said they would not travel ${TRAVEL_MODE_LABELS[mode].toLowerCase()}.`, refusedBy: 'traveler' });
      continue;
    }
    const world = screenModeAgainstWorld(mode, input.world);
    if (!world.ok) {
      refused.push(world);
      continue;
    }
    const geography = screenModeAgainstGeography(mode, input.straightLineKm);
    if (!geography.ok) {
      refused.push(geography);
      continue;
    }
    candidates.push(mode);
  }
  return { candidates, refused };
}

/**
 * Whether the plan's own proposal survives, and what to say if it does not.
 *
 * The narrow question `reconcile.ts` asks at the one place a hint becomes a
 * mode. Separated from `selectModes` because a refusal there has to produce a
 * *replacement*, and the replacement is the caller's business — it depends on
 * what the trip actually uses, which V11 §11's `arrangement` rule already knows.
 */
export function screenProposedMode(mode: TravelMode, input: Omit<ModeSelectionInput, 'proposed'>): ModeScreening {
  if (input.accepted && !input.accepted.has(mode)) {
    return { mode, ok: false, evidence: [], refusal: `The traveller said they would not travel ${TRAVEL_MODE_LABELS[mode].toLowerCase()}.`, refusedBy: 'traveler' };
  }
  const world = screenModeAgainstWorld(mode, input.world);
  if (!world.ok) return world;
  return screenModeAgainstGeography(mode, input.straightLineKm);
}
