import Link from 'next/link';
import { DecisionComposer } from '@/components/DecisionComposer';
import { destinationIndexRelease } from '@/lib/db/destination-index-repository';
import { isClimateEnabled } from '@/lib/providers/switches';
import { seedDestinationIndexIfRequested } from '@/lib/destinations/seed';
import { Panel } from '@/components/ui';

export const dynamic = 'force-dynamic';

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
export default function DecidePage() {
  /*
   * Opt-in, idempotent, and a no-op everywhere it is not configured. See
   * `lib/destinations/seed` for why an environment without a catalogue needs
   * this at all — in short, a shortlist with no index can only be tested for
   * how honestly it fails.
   */
  seedDestinationIndexIfRequested();
  const release = destinationIndexRelease();

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">Where should I go</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        Tell us when and what for. We will tell you where.
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">
        Four questions. We rank real places against climate records, how much ground each one
        covers, and how much there is to do — then show you what each choice costs you.
      </p>

      {/*
        The honest failure, before anybody spends four answers on it.

        A deployment with no index cannot rank anything, and finding that out at
        the end — as an empty list — would read as "nowhere suits you", which is
        a claim about the world rather than about this build.
      */}
      {!release ? (
        <Panel className="mt-8 bg-paper-sunk p-5">
          <p className="text-sm leading-relaxed text-ink">
            This build has no place index, so there is nothing for us to rank. That is a gap in us
            rather than a statement about anywhere.{' '}
            <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
              You can still plan a destination you already have in mind.
            </Link>
          </p>
        </Panel>
      ) : null}

      <div className="mt-10">
        <DecisionComposer climateEnabled={isClimateEnabled()} indexReady={release !== null} />
      </div>

      <p className="mt-14 border-t border-rule pt-6 text-sm text-ink-faint">
        Already know where you are going?{' '}
        <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
          Start from a destination instead.
        </Link>
      </p>
    </div>
  );
}
