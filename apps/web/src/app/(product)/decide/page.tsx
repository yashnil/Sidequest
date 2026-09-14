import type { Metadata } from 'next';
import Link from 'next/link';
import { TRIP_THEMES, type TripTheme } from '@sidequest/core';
import { DecisionComposer } from '@/components/DecisionComposer';
import type { DecisionAnswersInput } from '@/lib/destinations/decision-answers';
import { destinationIndexRelease } from '@/lib/db/destination-index-repository';
import { isClimateEnabled } from '@/lib/providers/switches';
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
   * Opt-in, idempotent, and a no-op everywhere it is not configured. See
   * `lib/destinations/seed` for why an environment without a catalogue needs
   * this at all — in short, a shortlist with no index can only be tested for
   * how honestly it fails.
   */
  seedDestinationIndexIfRequested();
  const release = destinationIndexRelease();
  const initial = prefillFrom(await searchParams);

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">Where should I go</p>
      <h1 className="display-xl mt-3 text-ink">
        Tell us when and what for. We will tell you where.
      </h1>
      {/*
        Two sentences, because at 360 px the four-line version pushed the first
        question below the fold on the screen whose whole point is that there is
        only one question on it.
      */}
      <p className="measure mt-4 type-body text-lg text-ink-muted">
        One question at a time, and we stop as soon as we can rank honestly. Real places against
        climate records and what is actually there — then what each choice costs you.
      </p>

      {/*
        The honest failure, before anybody spends four answers on it.

        A deployment with no index cannot rank anything, and finding that out at
        the end — as an empty list — would read as "nowhere suits you", which is
        a claim about the world rather than about this build.
      */}
      {!release ? (
        <div className="card mt-8 p-5">
          <p className="type-body text-ink">
            This build has no place index, so there is nothing for us to rank. That is a gap in us
            rather than a statement about anywhere.{' '}
            <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
              You can still plan a destination you already have in mind.
            </Link>
          </p>
        </div>
      ) : null}

      <div className="mt-10">
        <DecisionComposer climateEnabled={isClimateEnabled()} indexReady={release !== null} initial={initial} />
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
