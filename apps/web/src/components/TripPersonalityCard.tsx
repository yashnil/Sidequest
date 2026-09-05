import { INTEREST_LABELS, personalityBars, tripPersonality, type TravelerProfile } from '@sidequest/core';
import { Badge, Panel, cx } from './ui';

/**
 * THE TRIP, AS A SHAPE — QUALITATIVE, NEVER A SCORE.
 *
 * The card used to print "Outdoors 93" beside a bar, which reads as a
 * measurement of somebody's psychology. What the profile actually holds is
 * how big a role each kind of thing plays, in four words the traveller chose
 * themselves — so that is what is drawn: a four-step strength, labelled with
 * the phrase it stands for.
 */
export function TripPersonalityCard({
  profile,
  tripDays,
  headline,
}: {
  profile: TravelerProfile;
  tripDays: number;
  /** Overrides the derived headline when the caller has a better sentence. */
  headline?: string;
}) {
  const personality = tripPersonality(profile, tripDays);
  const bars = personalityBars(profile);
  return (
    <Panel className="p-5 sm:p-6" testId="trip-personality">
      <p className="font-display text-xl leading-snug text-ink">{headline ?? personality.headline}</p>

      <ul className="mt-5 space-y-2.5" aria-label="How big a role each kind of thing plays">
        {bars.map((bar) => (
          <li key={bar.id} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-xs text-ink-muted sm:w-36">{bar.label}</span>
            <span className="flex flex-1 gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={cx(
                    'h-1.5 flex-1 rounded-full',
                    step <= ['off', 'low', 'medium', 'high'].indexOf(bar.level) + (bar.level === 'off' ? 0 : 1) ? 'bg-pine' : 'bg-rule',
                  )}
                />
              ))}
            </span>
            <span className="w-32 shrink-0 text-right text-xs text-ink-faint">{bar.hint}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-6 grid gap-x-6 gap-y-3 border-t border-rule pt-5 sm:grid-cols-2">
        {personality.traits.map((trait) => (
          <div key={trait.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">{trait.label}</dt>
            <dd className="text-right text-sm text-ink">{trait.value}</dd>
          </div>
        ))}
      </dl>

      {personality.topInterests.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-1.5 border-t border-rule pt-5">
          {personality.topInterests.map((interest) => (
            <Badge key={interest} tone="pine">
              {INTEREST_LABELS[interest]}
            </Badge>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
