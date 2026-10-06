import { displayNameOf } from '../naming/display-name';
import type { Coordinates } from '../schemas/common';
import type {
  DiscoverySelection,
  SelectionSource,
  SkipReason,
  StoredSelectionStatus,
} from '../schemas/discovery';
import type { Place } from '../schemas/place';
import type { DiscoveryCandidate } from './board';

/**
 * THE ONE OBJECT THAT CROSSES THE DISCOVERY → PLANNING BOUNDARY.
 *
 * Before this existed the board's rows reached the composition as three flat
 * name lists, and every `included` row became "Must include" — including the
 * ones Sidequest itself had pre-selected. So an automatic recommendation was
 * presented to the model as something the traveller marked, the reconciler
 * counted it as a manual choice, and a `.slice(0, 10)` over an unordered query
 * decided which of them the model ever heard about.
 *
 * Here every stored row lands in exactly one of five lists, each in a
 * deterministic order, and each says how many entries a prompt-size cap left
 * out. The traveller's own includes are never capped: they are bounded by the
 * board already, and dropping one would be the silent loss this replaces.
 *
 * Pure. Both the composition path (`production-plan.ts#boardSignalsFor`) and
 * any planner-backed composer read the same object.
 */

/** A candidate as far as this boundary needs one. */
export type DecisionCandidate = Pick<DiscoveryCandidate, 'place'> & {
  fit?: { score: number } | undefined;
} & Partial<Pick<DiscoveryCandidate, 'quality' | 'detourClass'>>;

export interface DiscoveryDecisionEntry {
  placeId: string;
  /** The traveller-facing name (`displayNameOf`). */
  name: string;
  source: SelectionSource;
  status: StoredSelectionStatus;
  /** 0–100 personal fit, when the candidate carried one. */
  fitScore: number | null;
  /** Only on a traveller exclusion that gave one. */
  reason?: SkipReason;
  /** When the row was last decided — the traveller's own order. */
  decidedAt: string;
  category: Place['category'];
  coordinates: Coordinates;
  durationMinutes: number;
  intensity: Place['physicalIntensity'];
  weatherSensitivity: Place['weather'] | undefined;
  /** The board candidate itself, by reference — never a copy. */
  candidate: DecisionCandidate;
}

export interface DiscoveryDecisionList {
  /** In priority order, already cut to the cap. */
  entries: DiscoveryDecisionEntry[];
  /** How many were left out by the cap — never silently. */
  omittedCount: number;
}

export interface DiscoveryDecisions {
  /** `user` + `included`. Never capped. */
  travellerMustIncludes: DiscoveryDecisionList;
  /** `user` + `excluded`, with the reason when one was given. Never scheduled. */
  travellerExclusions: DiscoveryDecisionList;
  /** `user` + `maybe`: preferred if it fits. */
  travellerMaybes: DiscoveryDecisionList;
  /** `auto` + `included`: Sidequest's recommendation, never the traveller's choice. */
  sidequestRecommended: DiscoveryDecisionList;
  /** `user` + `dismissed`: an un-ticked Sidequest pick. Never auto-added again. */
  dismissedAutoPicks: DiscoveryDecisionList;
  /** Rows whose place is not on this board (the region was rebuilt since). */
  notOnBoard: string[];
}

export interface DiscoveryDecisionCaps {
  travellerExclusions?: number;
  travellerMaybes?: number;
  sidequestRecommended?: number;
  dismissedAutoPicks?: number;
}

/** Prompt-size defaults. The traveller's must-includes have no cap. */
export const DEFAULT_DECISION_CAPS: Required<DiscoveryDecisionCaps> = {
  travellerExclusions: 10,
  travellerMaybes: 10,
  sidequestRecommended: 10,
  dismissedAutoPicks: 10,
};

/** Traveller order: when they decided, then fit, then id. */
function byTravellerOrder(a: DiscoveryDecisionEntry, b: DiscoveryDecisionEntry): number {
  if (a.decidedAt !== b.decidedAt) return a.decidedAt < b.decidedAt ? -1 : 1;
  return byFit(a, b);
}

/** Sidequest order: fit descending, then id. */
function byFit(a: DiscoveryDecisionEntry, b: DiscoveryDecisionEntry): number {
  const fa = a.fitScore ?? -1;
  const fb = b.fitScore ?? -1;
  if (fa !== fb) return fb - fa;
  return a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
}

function cut(entries: DiscoveryDecisionEntry[], cap: number | undefined): DiscoveryDecisionList {
  if (cap === undefined || entries.length <= cap) return { entries, omittedCount: 0 };
  return { entries: entries.slice(0, Math.max(0, cap)), omittedCount: entries.length - Math.max(0, cap) };
}

export function buildDiscoveryDecisions(
  candidates: readonly DecisionCandidate[],
  selections: readonly DiscoverySelection[],
  caps: DiscoveryDecisionCaps = DEFAULT_DECISION_CAPS,
): DiscoveryDecisions {
  const byId = new Map(candidates.map((candidate) => [candidate.place.id, candidate] as const));
  const lists = {
    mustIncludes: [] as DiscoveryDecisionEntry[],
    exclusions: [] as DiscoveryDecisionEntry[],
    maybes: [] as DiscoveryDecisionEntry[],
    recommended: [] as DiscoveryDecisionEntry[],
    dismissed: [] as DiscoveryDecisionEntry[],
  };
  const notOnBoard: string[] = [];
  const seen = new Set<string>();

  for (const selection of selections) {
    if (seen.has(selection.placeId)) continue;
    seen.add(selection.placeId);
    const candidate = byId.get(selection.placeId);
    if (!candidate) {
      notOnBoard.push(selection.placeId);
      continue;
    }
    const place = candidate.place;
    const entry: DiscoveryDecisionEntry = {
      placeId: place.id,
      name: displayNameOf(place),
      source: selection.source,
      status: selection.status,
      fitScore: candidate.fit?.score ?? null,
      ...(selection.reason && selection.status === 'excluded' ? { reason: selection.reason } : {}),
      decidedAt: selection.updatedAt,
      category: place.category,
      coordinates: place.coordinates,
      durationMinutes: place.typicalDurationMinutes,
      intensity: place.physicalIntensity,
      weatherSensitivity: place.weather,
      candidate,
    };
    if (selection.source === 'auto') {
      // Sidequest only ever writes includes; anything else from it is not a decision.
      if (selection.status === 'included') lists.recommended.push(entry);
      continue;
    }
    if (selection.status === 'included') lists.mustIncludes.push(entry);
    else if (selection.status === 'excluded') lists.exclusions.push(entry);
    else if (selection.status === 'maybe') lists.maybes.push(entry);
    else lists.dismissed.push(entry);
  }

  return {
    travellerMustIncludes: { entries: lists.mustIncludes.sort(byTravellerOrder), omittedCount: 0 },
    travellerExclusions: cut(lists.exclusions.sort(byTravellerOrder), caps.travellerExclusions),
    travellerMaybes: cut(lists.maybes.sort(byTravellerOrder), caps.travellerMaybes),
    sidequestRecommended: cut(lists.recommended.sort(byFit), caps.sidequestRecommended),
    dismissedAutoPicks: cut(lists.dismissed.sort(byTravellerOrder), caps.dismissedAutoPicks),
    notOnBoard: notOnBoard.sort(),
  };
}

/** True when nothing on the board has been decided by anybody. */
export function decisionsAreEmpty(decisions: DiscoveryDecisions): boolean {
  return (
    decisions.travellerMustIncludes.entries.length +
      decisions.travellerExclusions.entries.length +
      decisions.travellerMaybes.entries.length +
      decisions.sidequestRecommended.entries.length ===
    0
  );
}

/**
 * Every traveller decision as `autoSelect`'s `decided` map.
 *
 * Only `user` rows: an `auto` row is the previous automatic answer, about to be
 * replaced. A `dismissed` row is in here on purpose — that is what stops an
 * un-ticked pick from coming back.
 */
export function travellerDecided(selections: readonly DiscoverySelection[]): Record<string, StoredSelectionStatus> {
  const decided: Record<string, StoredSelectionStatus> = {};
  for (const selection of selections) {
    if (selection.source === 'user') decided[selection.placeId] = selection.status;
  }
  return decided;
}

export interface AutoPickChange {
  changed: boolean;
  added: number;
  removed: number;
  keptTravellerPicks: number;
  /** One sentence for the board, said where the press happened. */
  message: string;
}

/**
 * What a press of "Choose for me" actually changed, in one sentence.
 *
 * A press that changed nothing used to change some borders nowhere — or none
 * at all — and say nothing, so it read as a button that did not work. Now an
 * unchanged board says so, and a changed one says what moved.
 */
export function describeAutoPickChange(input: {
  /** Sidequest's picks before the press. */
  before: readonly string[];
  /** Sidequest's picks after it. */
  after: readonly string[];
  /** The traveller's own includes, untouched by the press. */
  travellerPicks: number;
}): AutoPickChange {
  const before = new Set(input.before);
  const after = new Set(input.after);
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;
  const kept = input.travellerPicks;
  const yours = kept > 0 ? `your ${kept} ${kept === 1 ? 'pick' : 'picks'}` : null;
  if (added === 0 && removed === 0) {
    return {
      changed: false,
      added,
      removed,
      keptTravellerPicks: kept,
      message:
        after.size === 0 && kept === 0
          ? 'Nothing on this board fits well enough for us to pick it for you yet.'
          : `Your board already has the best mix we can find for this trip — nothing changed${yours ? `, and ${yours} stay as they are` : ''}.`,
    };
  }
  const parts: string[] = [];
  if (added > 0) parts.push(`added ${added} ${added === 1 ? 'place' : 'places'}`);
  if (removed > 0) parts.push(`took off ${removed} earlier ${removed === 1 ? 'pick' : 'picks'} of ours`);
  if (yours) parts.push(`kept ${yours}`);
  const sentence = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return {
    changed: true,
    added,
    removed,
    keptTravellerPicks: kept,
    message: `We ${sentence}.`,
  };
}
