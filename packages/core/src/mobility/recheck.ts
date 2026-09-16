import type { Journey } from './journey';
import { TRAVEL_MODE_LABELS } from './vocabulary';

/**
 * V12.1 §24 (finishing V12 §27) — WHAT IS WORTH CHECKING AGAIN, AND WHEN.
 *
 * ── THE TWO FAILURE MODES, AND WHY THE SECOND IS WORSE ─────────────────────
 *
 * A plan can go stale — a ferry drops to a winter timetable, a park road closes,
 * a shuttle stops running in October — and a product that never re-checks sends
 * somebody to a pier that has no sailings.
 *
 * The other failure mode is a checklist with thirty rows on it, and it is worse,
 * because it is the one people learn to ignore. §24 says so in as many words:
 * *"Do not create checklist spam. Only create Prepare action where stale
 * information could materially break the trip."*
 *
 * So three gates, all of which must pass:
 *
 *   1. the journey is **route-critical** — the shape of the trip rests on it
 *   2. its evidence is **perishable** — seasonal, date-bound or volatile; a road
 *      geometry measured in March is still true in August
 *   3. somebody **other than us** owns the answer — a timetable, an operator, a
 *      park authority. A journey we simply could not route is our unfinished
 *      work and never becomes a traveller's task (§22, V11 §`owner`).
 *
 * ── AND THE WINDOW IS PART OF THE ANSWER ────────────────────────────────────
 *
 * "Check the ferry" nine months out is not useful; the winter timetable is not
 * published yet. Each freshness class carries the horizon at which checking
 * starts to mean something, so a trip booked a year ahead shows nothing and the
 * same trip three weeks out shows the two things that matter.
 *
 * Pure: the clock is passed in.
 */

export const RECHECK_URGENCIES = ['now', 'before_you_go', 'closer_to_the_time'] as const;
export type RecheckUrgency = (typeof RECHECK_URGENCIES)[number];

export interface JourneyRecheck {
  journey: Pick<Journey, 'origin' | 'destination' | 'mode' | 'truth'>;
  urgency: RecheckUrgency;
  /** The earliest date on which checking is worth the trouble, `YYYY-MM-DD`. */
  usefulFrom: string;
  /** What to check, in one sentence a person can act on. Never a field name. */
  detail: string;
  /** Always `traveler` here: a recheck that is ours to do is not a recheck we show. */
  owner: 'traveler';
}

/**
 * How far ahead of departure each kind of perishable fact becomes checkable.
 *
 * Days. The numbers are horizons rather than guesses about reliability: a
 * seasonal timetable is usually published a month or two out, an operator
 * confirms a pickup in the week before, and a flight's own times settle a day
 * ahead.
 */
const HORIZON_DAYS: Record<NonNullable<Journey['evidence']['freshness']>, number> = {
  stable: 0,
  seasonal: 60,
  date_bound: 21,
  volatile: 3,
  unknown: 30,
};

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / 86_400_000);
}

/**
 * Whether this journey's facts are somebody else's to keep current.
 *
 * A measured road leg is ours and stays ours. A timetable, an operator's timing
 * and a corridor we know exists but have not read a schedule for are all facts
 * a traveller can go and check, which is what makes them worth showing.
 */
function perishable(journey: Journey): boolean {
  if (journey.evidence.freshness === 'stable') return false;
  if (journey.truth === 'timetabled' || journey.truth === 'operator_set') return true;
  /* An unknown journey qualifies only where a schedule exists to be read. */
  return journey.truth === 'unknown' && (journey.control === 'timetable_controlled' || journey.control === 'operator_controlled' || journey.control === 'air');
}

function detailFor(journey: Journey): string {
  const mode = TRAVEL_MODE_LABELS[journey.mode].toLowerCase();
  const where = `${journey.origin.name} to ${journey.destination.name}`;
  if (journey.control === 'operator_controlled') return `Confirm the ${mode} from ${where} with whoever is running it${journey.operator ? ` (${journey.operator})` : ''} — the time is theirs to set.`;
  if (journey.control === 'air') return `Check the flight from ${where} closer to the day: times move.`;
  return `Check the ${mode} timetable for ${where} on your dates — services change with the season.`;
}

export interface RecheckInput {
  journeys: readonly Journey[];
  /** The trip's first day, `YYYY-MM-DD`. */
  departureDate: string;
  now: Date;
  /**
   * The most rows this may ever produce.
   *
   * Three. A ceiling rather than a filter: the journeys are ordered by how soon
   * checking matters, so what survives is the ones whose window is closest. §24's
   * whole point is that a fourth row costs more attention than it earns.
   */
  limit?: number;
}

/**
 * What is worth checking again before this trip, soonest first.
 *
 * An empty list is the normal answer for a trip that is all roads and walks, and
 * for any trip far enough out that nothing has been published yet.
 */
export function journeyRechecks(input: RecheckInput): JourneyRecheck[] {
  const candidates = input.journeys.filter((journey) => journey.routeCritical && perishable(journey));
  const out: JourneyRecheck[] = [];
  for (const journey of candidates) {
    const horizon = HORIZON_DAYS[journey.evidence.freshness];
    const usefulFrom = addDays(input.departureDate, horizon);
    const daysUntilUseful = daysBetween(input.now, usefulFrom);
    /* Too early to be worth asking: the timetable it would check is not published. */
    if (daysUntilUseful > 0) continue;
    const daysUntilTrip = daysBetween(input.now, input.departureDate);
    out.push({
      journey: { origin: journey.origin, destination: journey.destination, mode: journey.mode, truth: journey.truth },
      urgency: daysUntilTrip <= 3 ? 'now' : daysUntilTrip <= 14 ? 'before_you_go' : 'closer_to_the_time',
      usefulFrom,
      detail: detailFor(journey),
      owner: 'traveler',
    });
  }
  const order: Record<RecheckUrgency, number> = { now: 0, before_you_go: 1, closer_to_the_time: 2 };
  out.sort((a, b) => order[a.urgency] - order[b.urgency] || a.journey.origin.name.localeCompare(b.journey.origin.name));
  /* De-duplicated by corridor: two legs on the same ferry route are one thing to check. */
  const seen = new Set<string>();
  const unique = out.filter((entry) => {
    const key = `${entry.journey.mode}|${entry.journey.origin.name}|${entry.journey.destination.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.slice(0, input.limit ?? 3);
}
