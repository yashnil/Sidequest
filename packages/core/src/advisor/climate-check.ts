import { monthNormal, type ClimateProfile } from '../schemas/climate';
import { catalogDestinationById } from './catalog/index';
import type { CatalogDestination } from './catalog/schema';
import { monthWord } from './score';
import type { AdvisorPick } from './shortlist-schema';

/**
 * THE ONE PART OF A CATALOG READING THE WORLD CAN CHECK, CHECKED.
 *
 * The catalog states a typical daytime high per month. The climate archive
 * (twenty years of reanalysis at the destination's centre) states one too. When
 * they agree within `TOLERANCE_C` the card says the weather was checked against
 * records; when they do not, it says what the records show instead of quietly
 * keeping the editorial number. A centre point can sit on a mountainside or out
 * at sea, so the tolerance is generous and a disagreement is reported, never
 * used to drop a destination.
 */
export const TOLERANCE_C = 5;

export function checkPickClimate(
  pick: AdvisorPick,
  profile: ClimateProfile | null,
  failed: boolean,
  entry: CatalogDestination | null = catalogDestinationById(pick.id),
): AdvisorPick['climate'] {
  if (!profile) {
    return failed
      ? { status: 'unavailable', note: 'Our climate records did not answer, so the weather is our own reading, unchecked.' }
      : { status: 'not_checked', note: 'Weather not yet checked against records.' };
  }
  const months = pick.window.months.length > 0 ? pick.window.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const comparisons = months
    .map((month) => {
      const normal = monthNormal(profile, month);
      const stated = entry?.highC[month - 1];
      return normal && stated !== undefined ? { month, record: normal.temperature.high, stated, wetDays: normal.wetDays } : null;
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  if (comparisons.length === 0) return { status: 'unavailable', note: 'Our climate records had nothing for those months.' };

  const worst = comparisons.reduce((a, b) => (Math.abs(b.record - b.stated) > Math.abs(a.record - a.stated) ? b : a));
  const first = comparisons[0]!;
  const years = `${profile.sampleYearFrom}–${profile.sampleYearTo}`;
  if (Math.abs(worst.record - worst.stated) <= TOLERANCE_C) {
    return {
      status: 'verified',
      note: `Checked against ${years} weather records: highs around ${Math.round(first.record)} °C in ${monthWord(first.month)}, about ${Math.round(first.wetDays)} wet days.`,
    };
  }
  return {
    status: 'differs',
    note: `Weather records (${years}) show highs near ${Math.round(worst.record)} °C in ${monthWord(worst.month)}, not the ${worst.stated} °C we expected — check before you book.`,
  };
}
