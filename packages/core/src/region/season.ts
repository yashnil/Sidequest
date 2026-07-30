import type { Place } from '../schemas/place';

export type SeasonStatus = 'open' | 'partially_open' | 'closed';

export interface SeasonAssessment {
  status: SeasonStatus;
  /** True when a mandatory shuttle replaces private vehicles during the trip. */
  shuttleRequired: boolean;
  /** Months of the trip the place is reachable. */
  openTripMonths: number[];
  note?: string;
}

/**
 * Seasonal access is the single biggest source of a plan that looks great and
 * cannot be executed. Half the Eastern Sierra is behind a snow gate for most of
 * the year, so this is evaluated before anything else and surfaced on the card.
 */
export function assessSeason(place: Place, months: number[]): SeasonAssessment {
  const openTripMonths = months.filter((month) => place.seasonalAccess.openMonths.includes(month));
  const status: SeasonStatus =
    openTripMonths.length === 0
      ? 'closed'
      : openTripMonths.length === months.length
        ? 'open'
        : 'partially_open';

  const shuttleRequired = openTripMonths.some((month) =>
    place.seasonalAccess.shuttleMonths.includes(month),
  );

  return {
    status,
    shuttleRequired,
    openTripMonths,
    ...(place.seasonalAccess.note ? { note: place.seasonalAccess.note } : {}),
  };
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

/** "June to October" style summary of when a place is reachable. */
export function describeOpenSeason(place: Place): string {
  const months = [...place.seasonalAccess.openMonths].sort((a, b) => a - b);
  if (months.length === 12) return 'Open year-round';
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return 'Season unknown';
  const contiguous = months.every((month, index) => month === first + index);
  if (contiguous && months.length > 1) {
    return `Usually open ${monthName(first)} to ${monthName(last)}`;
  }
  return `Usually open in ${months.map(monthName).join(', ')}`;
}
