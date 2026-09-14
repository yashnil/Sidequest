import type { Metadata } from 'next';
import Link from 'next/link';
import { TRIP_THEME_LABELS, type TripTheme } from '@sidequest/core';

export const metadata: Metadata = {
  title: 'Explore — Sidequest',
};

/**
 * V11 §B2 — EXPLORE IS INSPIRATION. /DECIDE OWNS THE RECOMMENDATION.
 *
 * "Explore" pointed at `/decide`, which is the personalised ranker. Two names
 * for one screen is how a product comes to have two answers to "where should I
 * go" — and it left the browsing question, the one somebody has before they are
 * ready to answer anything, with nowhere to go at all.
 *
 * So this page browses and hands off. Every card here is a **posture**, not a
 * destination: a set of intake answers, named in the traveller's words, that
 * opens `/decide` with those answers already given. That is the whole design
 * rule, and it is what keeps this page honest.
 *
 * **Nothing on this page names a place.** Not one. A browse page that listed
 * "the ten best islands" would be Sidequest asserting a ranking it did not
 * compute, for a traveller it has never met — which is exactly the
 * rank-by-popularity product the whole thing exists not to be. What a card can
 * truthfully say is what *kind* of trip it is asking for, and then let the
 * ranker answer with real places against real climate records.
 *
 * A consequence worth stating: this page needs no index, no provider and no
 * model, and it renders identically on a deployment with an empty catalogue.
 * The screen it hands off to is the one that has to be honest about coverage.
 */

interface Posture {
  /** What the traveller would call it. Never a place name. */
  title: string;
  line: string;
  themes: readonly TripTheme[];
  climate?: 'warm' | 'mild' | 'cold';
  nights?: number;
  intensity?: 'gentle' | 'moderate' | 'strenuous';
  surprise?: 'familiar' | 'open' | 'surprise_me';
  crowds?: 'avoid' | 'tolerate' | 'unbothered';
  shape?: 'one_base' | 'two_bases' | 'circuit';
}

interface Collection {
  id: string;
  title: string;
  note: string;
  postures: readonly Posture[];
}

const COLLECTIONS: readonly Collection[] = [
  {
    id: 'season',
    title: 'By the time of year',
    note: 'The season is the strongest thing we can rank on, so it is the first thing worth choosing by.',
    postures: [
      { title: 'Somewhere warm in winter', line: 'Long days and short sleeves while it is dark at home.', themes: ['water', 'outdoors'], climate: 'warm', nights: 10 },
      { title: 'Snow and clear cold', line: 'High country in its own season, not in spite of it.', themes: ['mountains'], climate: 'cold', nights: 7, intensity: 'moderate' },
      { title: 'Shoulder season, empty streets', line: 'The same places, a month either side of everybody else.', themes: ['culture', 'food'], crowds: 'avoid', nights: 8 },
      { title: 'High summer, outdoors all day', line: 'Fifteen hours of daylight and nothing shut.', themes: ['outdoors', 'mountains'], climate: 'mild', nights: 12, intensity: 'strenuous' },
    ],
  },
  {
    id: 'archetype',
    title: 'By the shape of the trip',
    note: 'How often you change beds decides more about a trip than where it is.',
    postures: [
      { title: 'One base, days out from it', line: 'Unpack once. Everything within an hour or two.', themes: ['outdoors', 'food'], shape: 'one_base', nights: 7 },
      { title: 'A road trip with a route', line: 'Somewhere new most nights, and the driving is part of it.', themes: ['outdoors', 'mountains'], shape: 'circuit', nights: 12 },
      { title: 'Two cities, split down the middle', line: 'Half and half, one journey in the middle.', themes: ['cities', 'culture'], shape: 'two_bases', nights: 9 },
      { title: 'A short escape', line: 'Three or four nights, one flight, nothing complicated.', themes: ['food', 'cities'], shape: 'one_base', nights: 3 },
    ],
  },
  {
    id: 'landscape',
    title: 'Extraordinary landscapes',
    note: 'Where the ground itself is the reason to go.',
    postures: [
      { title: 'Mountains you walk into', line: 'Passes, huts and days that end higher than they started.', themes: ['mountains', 'outdoors'], intensity: 'strenuous', nights: 11 },
      { title: 'Coast and islands', line: 'Water on three sides and a ferry timetable.', themes: ['water', 'quiet'], climate: 'warm', nights: 10 },
      { title: 'Wide empty country', line: 'Desert, steppe or tundra — somewhere with nobody in it.', themes: ['quiet', 'outdoors'], crowds: 'avoid', nights: 10 },
      { title: 'Wildlife on its own terms', line: 'Built around when and where the animals actually are.', themes: ['wildlife', 'outdoors'], nights: 9 },
    ],
  },
  {
    id: 'appetite',
    title: 'By what you are hungry for',
    note: 'Not a category of place — a reason to leave.',
    postures: [
      { title: 'Eat your way through it', line: 'Markets, dinners worth booking, and one meal you will still talk about.', themes: ['food', 'cities'], nights: 8 },
      { title: 'History you can walk around', line: 'Old streets, museums that are worth the queue, and the sense of the place.', themes: ['culture', 'cities'], nights: 8 },
      { title: 'Unusual adventures', line: 'Something you would struggle to book from home, and a guide who knows it.', themes: ['outdoors', 'wildlife'], intensity: 'strenuous', surprise: 'surprise_me', nights: 12 },
      { title: 'Nothing at all, on purpose', line: 'Gentle days, somewhere quiet, no alarm.', themes: ['quiet', 'water'], intensity: 'gentle', crowds: 'avoid', nights: 7 },
    ],
  },
];

/**
 * A posture as a URL.
 *
 * Every parameter names a field `/decide` already holds, so the intake reads
 * them as answers a person gave rather than as a special mode — and the ladder
 * then asks only what is still missing. Nothing is hidden in a session: the link
 * is the whole state, so it can be shared, bookmarked and read.
 */
function hrefFor(posture: Posture): string {
  const params = new URLSearchParams();
  params.set('themes', posture.themes.join(','));
  if (posture.nights) params.set('nights', String(posture.nights));
  if (posture.climate) params.set('climate', posture.climate);
  if (posture.intensity) params.set('intensity', posture.intensity);
  if (posture.surprise) params.set('surprise', posture.surprise);
  if (posture.crowds) params.set('crowds', posture.crowds);
  if (posture.shape) params.set('shape', posture.shape);
  return `/decide?${params.toString()}`;
}

export default function ExplorePage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">Explore</p>
      <h1 className="display-xl mt-3 text-ink">Start from a kind of trip, not a place.</h1>
      <p className="measure mt-4 type-body text-lg text-ink-muted">
        Nothing here is a list of the best anywhere. Each one is a way of travelling — pick the one
        that sounds like you and we will rank real places against it, with your own dates.
      </p>

      <div className="mt-12 space-y-14">
        {COLLECTIONS.map((collection) => (
          <section key={collection.id} aria-labelledby={`collection-${collection.id}`}>
            <h2 id={`collection-${collection.id}`} className="type-section text-ink">
              {collection.title}
            </h2>
            <p className="measure mt-1.5 type-small text-ink-muted">{collection.note}</p>

            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {collection.postures.map((posture) => (
                <li key={posture.title} className="min-w-0">
                  <Link
                    href={hrefFor(posture)}
                    data-testid="explore-posture"
                    className="card lift pressable group flex h-full min-w-0 flex-col rounded-[var(--radius-panel)] p-5 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                  >
                    <span className="block font-display text-lg leading-tight text-ink group-hover:text-pine">
                      {posture.title}
                    </span>
                    <span className="mt-1.5 block type-small text-ink-muted">{posture.line}</span>
                    {/*
                      What pressing this actually sets, in the traveller's own
                      vocabulary. A card that quietly filled in five answers
                      would be a card that answered for them.
                    */}
                    <span className="mt-auto block pt-4 type-meta text-ink-faint">
                      {[
                        ...posture.themes.map((theme) => TRIP_THEME_LABELS[theme].toLowerCase()),
                        posture.nights ? `${posture.nights} nights` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-16 rule-top pt-6 type-small text-ink-muted">
        Already know where you are going?{' '}
        <Link href="/trips/new" className="underline underline-offset-4 hover:text-pine">
          Start from a destination instead.
        </Link>
      </p>
    </div>
  );
}
