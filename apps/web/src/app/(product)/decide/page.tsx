import type { Metadata } from 'next';
import Link from 'next/link';
import { TRIP_THEMES, type TripTheme } from '@sidequest/core';
import { destinationCatalog } from '@sidequest/core';
import { AdvisorStart } from '@/components/advisor/AdvisorStart';
import { WorldDots } from '@/components/advisor/WorldDots';
import type { DecisionAnswersInput } from '@/lib/destinations/decision-answers';
import { seedDestinationIndexIfRequested } from '@/lib/destinations/seed';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Help me decide where to go — Sidequest',
};

/**
 * WHERE SHOULD I GO.
 *
 * The other half of the product, and until now the half that did not exist: the
 * mode has been in the schema since Phase 7 with no code path behind it, and a
 * traveller with two free weeks and no idea had nowhere to start.
 *
 * The screen asks the smallest set of questions that can rank anywhere — when,
 * how long, what for, how much moving — and nothing else. Everything the
 * known-destination composer asks *after* that point is asked after a
 * destination exists, because until then most of it cannot change the answer.
 */
/**
 * V11 §B2 — A POSTURE ARRIVES AS A QUERY, AND IS READ AS ANSWERS.
 *
 * `/explore` hands off here with the answers its card names already given. They
 * are parsed strictly against the same vocabularies the intake uses — an
 * unrecognised value is dropped rather than carried, because a query parameter
 * is untrusted input and a silently accepted one would put a word nobody
 * defined into a stored trip record.
 *
 * Nothing about the arriving traveller is special afterwards: the ladder reads
 * these as answers and asks only what is still missing, which is exactly what it
 * does for somebody who typed them.
 */
function prefillFrom(params: Record<string, string | string[] | undefined>): Partial<DecisionAnswersInput> {
  const one = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const within = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const value = one(key);
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
  };

  const themes = (one('themes') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is TripTheme => (TRIP_THEMES as readonly string[]).includes(entry));
  const nights = Number(one('nights'));

  return {
    ...(themes.length > 0 ? { themes } : {}),
    ...(Number.isInteger(nights) && nights >= 1 && nights <= 30 ? { nights } : {}),
    ...(within('climate', ['warm', 'mild', 'cold', 'any'] as const) ? { climatePreference: within('climate', ['warm', 'mild', 'cold', 'any'] as const) } : {}),
    ...(within('intensity', ['gentle', 'moderate', 'strenuous'] as const) ? { outdoorIntensity: within('intensity', ['gentle', 'moderate', 'strenuous'] as const)! } : {}),
    ...(within('surprise', ['familiar', 'open', 'surprise_me'] as const) ? { surpriseAppetite: within('surprise', ['familiar', 'open', 'surprise_me'] as const) } : {}),
    ...(within('crowds', ['avoid', 'tolerate', 'unbothered'] as const) ? { crowdTolerance: within('crowds', ['avoid', 'tolerate', 'unbothered'] as const) } : {}),
    ...(within('shape', ['one_base', 'two_bases', 'circuit', 'undecided'] as const) ? { shape: within('shape', ['one_base', 'two_bases', 'circuit', 'undecided'] as const)! } : {}),
  };
}

export default async function DecidePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /*
   * Opt-in, idempotent, and a no-op everywhere it is not configured. The
   * advisor no longer reads the place index, but the browser suites still seed
   * their synthetic index through this page's render (`lib/destinations/seed`).
   */
  seedDestinationIndexIfRequested();
  const initial = prefillFrom(await searchParams);
  /*
   * The destination advisor reads its own catalog of travel destinations (see
   * `@sidequest/core` → `advisor/catalog`), not the place index, so this screen
   * no longer depends on an index having been built.
   */
  const catalog = destinationCatalog();
  const regions = new Set(catalog.map((entry) => entry.worldRegion)).size;
  const points = catalog.map((entry) => ({ id: entry.id, lat: entry.center.lat, lng: entry.center.lng }));

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-start lg:gap-14">
        <div className="min-w-0">
          <p className="sheet-label inline-flex items-center gap-2 text-accent">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
            Help me choose
          </p>
          <h1 className="mt-3 max-w-[18ch] font-display text-[clamp(2.4rem,1.5rem+3vw,4.4rem)] leading-[0.98] font-[340] tracking-[-0.035em] text-balance text-ink">
            Not sure where? <span className="text-ink-muted italic">Tell us what you’re after.</span>
          </h1>
          <p className="measure mt-4 type-body text-ink-muted">We’ll ask a few questions that actually change the answer, then show three different places that fit, and say why.</p>
          <div className="mt-10">
            <AdvisorStart prefill={initial} />
          </div>
        </div>
        <figure className="survey-night rounded-[var(--radius-card)] p-4 text-bone lg:mt-8">
          <WorldDots points={points} highlighted={[]} tone="night" className="h-auto w-full" label={`World map of the ${catalog.length} destinations Sidequest compares`} />
          <figcaption className="mt-3 text-sm text-bone/75">
            {catalog.length} destinations across {regions} parts of the world — parks, ranges, coasts and islands people really travel to, each with a season, places to sleep and things to do.
          </figcaption>
          <p className="mt-2 text-[0.7rem] text-bone/45">Land: Natural Earth. Each dot is a real destination centre.</p>
        </figure>
      </div>

      <p className="mt-14 rule-top pt-6 type-small text-ink-muted">
        Already know where you are going?{' '}
        <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
          Start from a destination instead.
        </Link>
      </p>
    </div>
  );
}
