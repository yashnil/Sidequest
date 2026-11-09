import { cx } from '@/components/ui';

/**
 * WHERE THE ATLAS'S DATA COMES FROM — SHOWN, NOT TUCKED AWAY.
 *
 * Wikivoyage's text is CC BY-SA, which asks for credit and a link to the
 * licence wherever what is derived from it is shown; the rest are named
 * because a reading built on open data should say whose data. One compact
 * line, always visible. Its words are `DATA_ATTRIBUTION` (`advisor-copy.ts`);
 * a test holds the two together.
 */
export function DataAttribution({ className, tone = 'paper' }: { className?: string; tone?: 'paper' | 'night' }) {
  const link = cx('underline underline-offset-2', tone === 'night' ? 'hover:text-bone' : 'hover:text-ink');
  return (
    <p data-testid="advisor-attribution" className={className}>
      Destination data:{' '}
      <a href="https://en.wikivoyage.org/" target="_blank" rel="noopener noreferrer" className={link}>
        Wikivoyage
      </a>{' '}
      (
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer" className={link}>
        CC BY-SA 4.0
      </a>
      ), Wikidata (CC0), CHELSA climate normals, NOAA ETOPO &amp; OISST, OurAirports, World Bank, Natural Earth, GMBA Mountain Inventory v2 (CC BY 4.0, Snethlage et al. 2022). Travel advice from the U.S. Department of State, the UK FCDO (Open Government Licence v3.0) and the Government of Canada (Open Government Licence – Canada).
    </p>
  );
}
