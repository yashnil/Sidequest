import type { ItineraryDay } from '../schemas/itinerary';

/**
 * V9 §17 — A SPLIT DAY, AS A STRUCTURE.
 *
 * The compact wire carries a split as one sentence ("Who: what; rejoin
 * where"). Surfaces need it as parts: the groups, what each does, where and
 * when everyone meets again, and what it means for transport and bookings.
 * Parsed deterministically from the sentence and the day; when the sentence
 * does not follow the shape, the parts are the sentence itself, honestly.
 */
export interface SplitGroup {
  who: string;
  does: string;
}

export interface SplitPlan {
  dayNumber: number;
  groups: SplitGroup[];
  rejoin: string | null;
  /** The plan's own transport reading for the day, so a split says whether one car serves both halves. */
  transportNote: string;
  bookingsNote: string | null;
}

export function splitPlanFor(day: ItineraryDay, options: { bookingsOnDay?: readonly string[] } = {}): SplitPlan | null {
  if (!day.split) return null;
  const groups: SplitGroup[] = [];
  const doesParts = day.split.does.split(/;\s*(?:the (?:others|rest)|everyone else|others)\s*:?\s*/i);
  const whoParts = day.split.who.split(/\s*(?:;|\band\b(?= the (?:others|rest)))\s*/i);
  if (doesParts.length === 2 && whoParts.length >= 1) {
    groups.push({ who: whoParts[0]!.trim(), does: doesParts[0]!.trim() });
    groups.push({ who: whoParts[1]?.trim() || 'The others', does: doesParts[1]!.trim() });
  } else {
    groups.push({ who: day.split.who.trim(), does: day.split.does.trim() });
    groups.push({ who: 'The others', does: `The day as written: ${day.theme}` });
  }
  const modes = day.transport.modes.map((m) => m.replace(/_/g, ' '));
  const drives = day.transport.modes.includes('drive');
  const transportNote = drives ? 'The day moves by car: one car cannot serve both halves, so the second group needs its own way or the rejoin point is where the car is.' : modes.length > 0 ? `The day moves by ${modes.join(' and ')}, so each half can travel on its own.` : 'No transport was measured for this day.';
  const bookingsNote = options.bookingsOnDay && options.bookingsOnDay.length > 0 ? `Booked today: ${options.bookingsOnDay.join(', ')} — say which half it belongs to.` : null;
  return { dayNumber: day.dayNumber, groups, rejoin: day.split.rejoin ?? null, transportNote, bookingsNote };
}
