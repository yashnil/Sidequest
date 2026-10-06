import type { TripPackage } from '@sidequest/core';

/**
 * V1 CONVERGENCE — HOW THIS TRIP WAS BUILT, IN ONE TRUTHFUL LINE.
 *
 * Read from `package.planning` and nothing else. A planner-built trip says how
 * many board places the planner had and where the scheduled ones came from; a
 * model-composed trip says plainly that its structure was not optimised. A plan
 * stored before the record existed says nothing — silence is the honest
 * rendering of a fact nobody recorded.
 */
export interface PlanningLine {
  summary: string;
  /** Weather moves and must-do conflicts, one sentence each. */
  notes: string[];
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-08-13` → `Thursday 13 Aug`. A calendar date, so it is read in UTC and never shifted by the server's zone. */
export function planningDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return iso;
  return `${WEEKDAY[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH[date.getUTCMonth()]}`;
}

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function joinParts(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export function planningLineFor(planning: TripPackage['planning'] | undefined): PlanningLine | null {
  if (!planning) return null;
  if (planning.mode === 'model_composed') {
    return {
      summary: 'Composed by Sidequest’s model without a Discovery Board — places are checked, but the plan’s structure was not optimised.',
      notes: [],
    };
  }
  const pool = planning.poolSize;
  const from = pool !== undefined && pool > 0 ? `from ${pool} ${pool === 1 ? 'place' : 'places'} on your Discovery Board` : 'from your Discovery Board';
  const parts: string[] = [];
  const s = planning.scheduled;
  if (s) {
    if (s.traveller > 0) parts.push(`${s.traveller} you chose`);
    if (s.maybe > 0) parts.push(`${s.maybe} you marked maybe`);
    if (s.sidequest > 0) parts.push(`${s.sidequest} Sidequest picked`);
    if (s.filler > 0) parts.push(`${s.filler} added to fill the days`);
  }
  const summary = parts.length > 0 ? `Planned by Sidequest ${from} — ${joinParts(parts)}.` : `Planned by Sidequest ${from}.`;
  const notes: string[] = [];
  for (const move of planning.weatherMoves ?? []) {
    notes.push(`Moved ${move.name} to ${planningDate(move.chosenDate)} for a better forecast than ${planningDate(move.avoidedDate)}.`);
  }
  for (const conflict of planning.mustConflicts ?? []) {
    notes.push(`You asked for ${conflict.name}; it didn’t fit: ${sentence(conflict.detail)}`);
  }
  return { summary, notes };
}
