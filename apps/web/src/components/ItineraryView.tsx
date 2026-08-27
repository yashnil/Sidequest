import Link from 'next/link';
import {
  BOOKING_KIND_LABELS,
  DIETARY_EVIDENCE_COPY,
  DIETARY_NEED_LABELS,
  FOOD_SERVICE_TYPE_LABELS,
  formatMinuteOfDay,
  ITINERARY_STATUS_COPY,
  MEAL_SLOT_LABELS,
  PRICE_BAND_LABELS,
  PRICE_BAND_WORDS,
  PRICE_EVIDENCE_COPY,
  RESERVATION_LABELS,
  TRANSPORT_MODE_LABELS,
  type DailyWindow,
  type FoodPlan,
  type FoodStopKind,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type ScheduledFood,
  type TransportStrategy,
  type TravelSegment,
  PREPARATION_KIND_COPY,
  groupPreparation,
  imageryFallbackFor,
  type DestinationImage as ImageRecord,
  type PlaceCategory,
  type PreparationItem,
  type DisplayName,
} from '@sidequest/core';
import { Badge, PLATE_HUE, Panel, buttonClass, cx, type BadgeTone, PlaceName } from './ui';
import { DestinationImage, ImageCredit } from './DestinationImage';
import { DayMap } from './DayMap';
import { formatMinutes } from '@/lib/format';
import { dayRouteLinks, mapModeFor } from '@/lib/maps';
import { PrintButton } from './PrintButton';
/*
 * The editing controls live beside the server actions they call, in the
 * itinerary route directory, rather than in the shared component folder: they
 * are meaningless anywhere but on this page.
 */
import {
  EaseDayButton,
  PrintExpand,
  StopEditMenu,
} from '@/app/(product)/trips/[id]/itinerary/edit-controls';
import { ShareControl } from '@/app/(product)/trips/[id]/itinerary/share-controls';
import {
  isMachineWeatherLabel,
  roundedDuration,
  roundedMinuteOfDay,
  travellerVoice,
  type ClockEdge,
} from './plan-language';

/**
 * A clock time as this page prints it: five-minute precision, in the direction
 * that cannot make a claim false. See `plan-language.ts` for why.
 */
function clock(minute: number, edge: ClockEdge): string {
  return formatMinuteOfDay(roundedMinuteOfDay(minute, edge));
}

/** A span as this page prints it: rounded down, so it never overstates. */
function span(minutes: number): string {
  return formatMinutes(roundedDuration(minutes));
}

/**
 * "Wed 12 Aug" — a date a person reads, from the ISO one a machine stores.
 *
 * The day headings printed `Day 1` immediately followed by `2026-08-12` with no
 * separator, so the accessible name of every day was "Day 12026-08-12" — a
 * screen reader read the day number and the year as one number. The `<time>`
 * element keeps the machine-readable value where a machine can still find it.
 */
function humanDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

const STATUS_TONE: Record<Itinerary['status'], BadgeTone> = {
  ready: 'pine',
  ready_with_cautions: 'amber',
  needs_decision: 'clay',
};

const KIND_STYLE: Record<ItineraryItem['kind'], { rail: string; label: string }> = {
  activity: { rail: 'bg-pine', label: '' },
  travel: { rail: 'bg-slate-blue', label: '' },
  meal: { rail: 'bg-amber', label: 'Meal' },
  rest: { rail: 'bg-amber', label: 'Rest' },
  free_time: { rail: 'bg-rule', label: 'Free' },
};

/**
 * What a food block actually is, said in the row's own eyebrow.
 *
 * A packed lunch is not a restaurant visit and a shop is not a meal, and using
 * one word for all three is how a plan reads as though it has booked something
 * it has not.
 */
const FOOD_STOP_LABEL: Record<FoodStopKind, string> = {
  venue: '',
  grocery: 'Supplies',
  packed: 'Carried',
  unplanned: 'Time held',
};

/**
 * Two scales that run in opposite directions. High stress is a caution; high
 * convenience is the best outcome there is, and sharing one map painted it amber.
 */
const STRESS_TONE: Record<TransportStrategy['stress'], BadgeTone> = {
  low: 'pine',
  moderate: 'blue',
  high: 'amber',
};

const CONVENIENCE_TONE: Record<TransportStrategy['convenience'], BadgeTone> = {
  low: 'amber',
  moderate: 'blue',
  high: 'pine',
};

const STRESS_LABELS: Record<TransportStrategy['stress'], string> = {
  low: 'Easy-going days',
  moderate: 'Some long legs',
  high: 'Demanding days',
};

const CONVENIENCE_LABELS: Record<TransportStrategy['convenience'], string> = {
  low: 'Hands-on logistics',
  moderate: 'Some legwork',
  high: 'Easy logistics',
};

/**
 * When "on foot" is worth a chip.
 *
 * Under half an hour it is the walk between a car park and a gate, which is not
 * a property of the day. Over it, it is the day.
 */
const WALKING_DAY_MINUTES = 30;

/**
 * WHAT THE PAGE KNOWS ABOUT A SCHEDULED STOP THAT THE STORED PLAN DOES NOT.
 *
 * A stored itinerary is immutable and records what to do and when. Everything
 * here is re-derived at render time from the compiled region the plan was built
 * against — the same board the traveller chose from — and it exists because the
 * plan's own per-stop `reason` is one template with an interest name substituted
 * into it, so eleven stops on a real plan read "Matches your interest in X" and
 * the product's stated differentiator is invisible on its only deliverable.
 *
 * Nothing here is invented and nothing overrides the plan: where the region no
 * longer holds a card for a stop, the row falls back to the plan's own sentence
 * exactly as before.
 */
export interface StopRationale {
  /**
   * The place's name as the board showed it — English or romanised where a
   * source published one, with the native form beside it.
   *
   * The planner materialises `ItineraryItem.title` as a plain string at plan
   * time, so the naming work that landed on the board never reached the plan:
   * a traveller picked "Sumida River" on the board and the document they take
   * on holiday said 隅田川, on a page declaring `lang="en"`. Re-resolved here
   * because a stored plan is immutable and rewriting one to fix a heading would
   * be editing somebody's trip.
   *
   * Presentation only, and only for the *place* rows. A travel leg's title is a
   * composed sentence and stays exactly as the planner wrote it.
   */
  name?: string;
  /** The fit model's own sentence about this place, in the traveller's words. */
  why?: string;
  /** What kind of place it is. Sets the day's colour and nothing else. */
  category?: PlaceCategory;
  /**
   * Short facts that differ between stops — "quiet find", "sheltered if it
   * rains", "18 min from your base". At most two are rendered.
   */
  facets?: readonly string[];
}

const INTENSITY_TONE: Record<ItineraryDay['intensity'], BadgeTone> = {
  light: 'blue',
  moderate: 'pine',
  intense: 'amber',
};

export function ItineraryView({
  itinerary,
  preparation,
  tripId,
  dateLabel,
  renderedAt,
  baseNames,
  timeZone,
  attributions = [],
  coordinates = {},
  lockedPlaceIds = [],
  worthSkipping = [],
  lodgingAreas = [],
  images = {},
  rationale = {},
}: {
  itinerary: Itinerary;
  /**
   * ODbL attribution strings, verbatim, from the compiled region's licences.
   *
   * Required on this page: the plan is made of OpenStreetMap-derived records and
   * this is the surface a traveller prints. Passed as the licence's own text so
   * no component here can paraphrase it into non-compliance.
   */
  attributions?: readonly string[];
  /**
   * Where each place is, keyed by the id the timeline already carries.
   *
   * Only used to build a map link. A place missing from this map simply does not
   * appear in the link, and the link says how many stops it carries.
   */
  coordinates?: Record<string, { lat: number; lng: number }>;
  /**
   * Derived on the server from this plan and the evidence it was built on.
   *
   * Empty is the common case and is not a failure: a region with no researched
   * evidence has nothing to prepare for beyond what the days already say.
   */
  preparation: PreparationItem[];
  /**
   * The trip's id — or nothing, and the absence is the read-only mode.
   *
   * Every owner surface is addressed by this id: the board, the questionnaire,
   * the calendar export, the per-stop edits. The share page therefore does not
   * pass it, and everything owner-only below is gated on its presence — so the
   * shared document *cannot* contain the key to the owner surfaces, rather
   * than merely choosing not to show it. A separate `readOnly` flag would be
   * a second thing to keep true; the id's absence is the fact itself.
   */
  tripId?: string;
  dateLabel: string;
  /**
   * The base's resolved name, read from the compiled region at render time.
   *
   * Deliberately *not* stored on the itinerary. A stored plan is immutable, and
   * migrating one to change how a heading reads would be rewriting somebody's
   * trip to fix a presentation bug. The compiled region is the artifact that
   * owns names; this reads it, and an old region without one falls back to the
   * plain `baseName` exactly as before.
   */
  baseNames?: DisplayName;
  /**
   * When the server rendered this page, as epoch milliseconds.
   *
   * Passed in rather than read here so every day on the page judges the same
   * forecast against the same instant, and so the check is a pure function of
   * its props — a component that reads the clock during render can show two
   * different answers for one plan.
   */
  renderedAt: number;
  /**
   * The IANA zone the trip's base sits in, read from the compiled region.
   *
   * Threaded rather than assumed. This used to be `America/Los_Angeles`, hard
   * coded, on every itinerary in the world — a leftover from the phase when
   * there was one region, and one that printed the wrong hour for every
   * traveller outside California without anything on screen looking wrong.
   *
   * Absent is a real state: an artifact compiled before bases carried a zone has
   * none, and the honest answer then is UTC with the offset named, rather than a
   * local-looking time in somebody else's day.
   */
  timeZone?: string;
  /**
   * Stops the traveller has pinned to their day. Display state only — the
   * pins themselves live in the database and are read by the rebuild.
   */
  lockedPlaceIds?: readonly string[];
  /**
   * Board supply the fit model marked "probably skip", from the same compiled
   * region this plan drew on. Empty when the board holds none, and the
   * section then simply does not render — never fabricated to fill space.
   */
  worthSkipping?: readonly { name: string; reason: string }[];
  /**
   * Where to stay, and why — but only for bases whose lodging is *sourced*.
   *
   * The caller filters on that, and the filter is the point: a base is a
   * geographic recommendation, and a region that knows a town exists does not
   * thereby know anybody rents rooms in it. Omitting the section is the honest
   * treatment of unknown; an empty list renders nothing rather than a heading
   * over a shrug.
   */
  lodgingAreas?: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[];
  /**
   * Licensed photographs by place id, read from the same table the board reads.
   *
   * A row lookup and never a resolution: the identity of every one of these was
   * established while the traveller was choosing on the board, and this page
   * only draws what is already on disk. Empty is the ordinary state for a
   * destination nothing licensable was found for, and the day headers then carry
   * no photograph rather than a stand-in.
   */
  images?: Record<string, ImageRecord>;
  /** What the fit model says about each scheduled stop. See `StopRationale`. */
  rationale?: Record<string, StopRationale>;
}) {
  const baseEntity = {
    name: itinerary.baseName,
    ...(baseNames ? { names: baseNames } : {}),
  };
  const status = ITINERARY_STATUS_COPY[itinerary.status];
  const conflicts = itinerary.unscheduled.filter((entry) => entry.wasManual);
  const dropped = itinerary.unscheduled.filter((entry) => !entry.wasManual);
  const openIssues = itinerary.issues.filter((issue) => issue.severity !== 'info');

  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="border-b border-rule pb-8">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">
          {tripId ? 'Your trip' : 'Shared with you'}
        </p>
        <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-5xl">
          <PlaceName entity={baseEntity} />
        </h1>
        <p className="mt-3 text-ink-muted">
          {dateLabel} · {itinerary.days.length} days · based in{' '}
          <PlaceName entity={baseEntity} showLocal={false} />
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Badge tone={STATUS_TONE[itinerary.status]}>{status.label}</Badge>
          <span className="text-sm text-ink-muted">{status.blurb}</span>
        </div>

        <p className="mt-4 text-sm text-ink-muted">{itinerary.summary}</p>

        <div className="mt-6 flex flex-wrap gap-2 print:hidden">
          <PrintButton />
          {tripId ? (
            <>
              {/*
                A plain download link, not an action: the route builds the file on
                request and the browser saves it. Calendar apps open .ics natively.
              */}
              <a
                href={`/trips/${tripId}/itinerary/calendar`}
                download
                className={buttonClass('secondary', 'sm')}
              >
                Calendar file (.ics)
              </a>
              <Link href={`/trips/${tripId}/discover`} className={buttonClass('secondary', 'sm')}>
                Back to the board
              </Link>
              <ShareControl tripId={tripId} />
            </>
          ) : null}
        </div>
        {/* Opens every collapsed disclosure for print, closes them after. */}
        <PrintExpand />
      </header>

      <BeforeYouGo items={preparation} />

      {conflicts.length > 0 ? (
        <Panel className="mt-8 border-clay p-5">
          <h2 className="font-display text-lg text-clay">
            {conflicts.length === 1 ? 'One thing you picked' : `${conflicts.length} things you picked`} could not be scheduled
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            We would rather tell you than quietly drop it or break a limit you set.
          </p>
          <ul className="mt-4 space-y-3">
            {conflicts.map((entry) => (
              <li key={entry.placeId} className="text-sm">
                <span className="font-medium text-ink">{entry.name}</span>
                <span className="block text-ink-muted">{entry.reason}</span>
                {entry.suggestedRemedy ? (
                  <span className="mt-0.5 block text-ink-faint">
                    Smallest fix: {entry.suggestedRemedy}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {/*
            Every route here goes somewhere that can actually resolve it — so
            on the shared, read-only copy there is nowhere to send anybody, and
            the list stands on its own as the honest account of what is not in
            the plan.
          */}
          {tripId ? (
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href={`/trips/${tripId}/discover`} className={buttonClass('secondary', 'sm')}>
                Change what is on the board
              </Link>
              <Link
                href={`/trips/${tripId}/questionnaire`}
                className={buttonClass('secondary', 'sm')}
              >
                Change how you are getting around
              </Link>
            </div>
          ) : null}
        </Panel>
      ) : null}

      <TransportPlan strategy={itinerary.transportStrategy} />

      <WeatherPlan itinerary={itinerary} {...(timeZone ? { timeZone } : {})} />

      <FoodPlanPanel plan={itinerary.foodPlan} />

      <DayRail days={itinerary.days} />

      <ol className="space-y-12">
        {itinerary.days.map((day) => (
          <li key={day.dayNumber} className="break-inside-avoid">
            <DayCard
              day={day}
              renderedAt={renderedAt}
              coordinates={coordinates}
              tripId={tripId}
              lockedPlaceIds={new Set(lockedPlaceIds)}
              images={images}
              rationale={rationale}
              isFirst={day.dayNumber === itinerary.days[0]?.dayNumber}
              isLast={day.dayNumber === itinerary.days[itinerary.days.length - 1]?.dayNumber}
            />
          </li>
        ))}
      </ol>

      <KeepFlexible itinerary={itinerary} />

      {worthSkipping.length > 0 ? (
        <section className="mt-14 border-t border-rule pt-8">
          <h2 className="font-display text-xl text-ink">Worth skipping</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Popular or nearby, and still a poor match for how you said you travel. Skipping them
            is a decision, not an oversight.
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {worthSkipping.map((entry) => (
              <li key={entry.name} className="rounded-lg border border-rule p-3 text-sm">
                <span className="font-medium text-ink">{entry.name}</span>
                <span className="mt-0.5 block text-ink-muted">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {lodgingAreas.length > 0 ? (
        <section className="mt-14 border-t border-rule pt-8">
          <h2 className="font-display text-xl text-ink">Where to stay</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Areas, not hotels. Which part of the map puts you closest to the days above.
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {lodgingAreas.map((area) => (
              <li key={area.name} className="rounded-lg border border-rule p-3 text-sm">
                <span className="font-medium text-ink">{area.name}</span>
                <span className="mt-0.5 block text-ink-muted">{area.rationale}</span>
                {area.tradeoffs.length > 0 ? (
                  <span className="mt-1.5 block text-ink-muted">
                    {area.tradeoffs.join(' · ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {dropped.length > 0 ? (
        <section className="mt-14 border-t border-rule pt-8">
          <h2 className="font-display text-xl text-ink">Left off for room</h2>
          <p className="mt-1 text-sm text-ink-muted">
            These were on your board but there were not the hours for them. Nothing is hidden.
          </p>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {dropped.map((entry) => (
              <li key={entry.placeId} className="rounded-lg border border-rule p-3 text-sm">
                <span className="font-medium text-ink">{entry.name}</span>
                <span className="mt-0.5 block text-ink-muted">{entry.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {openIssues.length > 0 ? (
        <section className="mt-14 border-t border-rule pt-8">
          <h2 className="font-display text-xl text-ink">Worth reading</h2>
          <ul className="mt-4 space-y-2">
            {openIssues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="flex gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className={cx(issue.severity === 'error' ? 'text-clay' : 'text-amber')}
                >
                  ▲
                </span>
                <span className="text-ink-muted">
                  {issue.message}
                  {issue.wasResolvedByRemoval ? (
                    /*
                     * The finding is real and the hazard is gone. Without this
                     * sentence "the place we chose cannot meet your dietary
                     * requirement" reads as a live problem about a venue that
                     * appears nowhere in the plan.
                     */
                    <span className="text-ink-faint">
                      {' '}
                      We took it off the plan rather than leave it in — nothing above depends on it.
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        Where the numbers came from is stated once, in the transport section that
        owns them. Repeating it here made the same disclosure appear twice on one
        page, which reads as boilerplate and gets skipped. What is left is the
        thing nothing else says: what the planner changed while building.
      */}
      {itinerary.diagnostics.revisions.length > 0 ? (
        <footer className="mt-14 border-t border-rule pt-6 text-xs leading-relaxed text-ink-faint">
          Adjusted {itinerary.diagnostics.revisions.length}{' '}
          {itinerary.diagnostics.revisions.length === 1 ? 'time' : 'times'} while planning:{' '}
          {itinerary.diagnostics.revisions.map((revision) => revision.description).join(' ')}
        </footer>
      ) : null}

      {attributions.length > 0 ? (
        /**
         * The licence text, verbatim, on the page a traveller takes with them.
         *
         * Not `print:hidden` — this is the one part of the page furniture that
         * has to survive into the printed copy, because the obligation follows
         * the data rather than the screen.
         */
        <p
          data-testid="itinerary-attribution"
          className="mt-10 border-t border-rule pt-6 text-[11px] leading-relaxed text-ink-faint"
        >
          {attributions.join(' · ')}. Place data is normalised from these sources; the plan,
          the timings and the reasoning are ours.
        </p>
      ) : null}
    </div>
  );
}


/**
 * GETTING TO A DAY ON AN EIGHT-THOUSAND-PIXEL PAGE.
 *
 * The finished plan had no navigation at all: reaching day 3 meant scrolling
 * past two complete days, and checking one thing on day 1 while reading day 4
 * meant scrolling back and then finding your place again. This is the one
 * structure a printed itinerary has that a web page was missing — a contents.
 *
 * Anchors, not JavaScript. `href="#day-3"` works with no client bundle, survives
 * a page that has not hydrated, is a real browser history entry, and lands in the
 * tab order for free. The days carry `scroll-mt` so the sticky chrome and this
 * rail do not cover the heading they just jumped to.
 *
 * Hidden in print, where the page numbers do this job and a row of links is
 * furniture.
 */
function DayRail({ days }: { days: readonly ItineraryDay[] }) {
  // One day is not a journey through a document.
  if (days.length < 2) return null;

  return (
    <nav
      aria-label="Jump to a day"
      data-testid="day-rail"
      className="sticky top-[var(--chrome-height)] z-20 -mx-5 mt-10 mb-6 border-y border-rule bg-paper px-5 py-2 print:hidden sm:-mx-8 sm:px-8"
    >
      <ol className="flex gap-2 overflow-x-auto">
        {days.map((day) => (
          <li key={day.dayNumber} className="shrink-0">
            <a
              href={`#day-${day.dayNumber}`}
              className="flex min-h-11 w-40 flex-col justify-center rounded-lg border border-rule px-3 py-1.5 transition-colors hover:border-ink-faint hover:bg-paper-sunk"
            >
              <span className="flex items-baseline gap-1.5">
                <span className="font-display text-sm text-ink">Day {day.dayNumber}</span>
                <time dateTime={day.date} className="text-[11px] text-ink-muted">
                  {humanDate(day.date)}
                </time>
              </span>
              <span className="truncate text-[11px] text-ink-muted">{day.theme}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The trip's transportation position.
 *
 * Reads as an editorial page rather than a dashboard: a recommendation, the
 * reasoning behind it, what it costs, and what to check. The numbers are
 * deliberately coarse and the disclosure is not tucked away, because a modelled
 * drive time presented with a dashboard's confidence is worse than no number.
 */
/**
 * The trip's weather position, in one panel.
 *
 * Its only real job is to name the kind of knowledge behind the plan before the
 * traveller reads a single number. A trip planned three days out and one planned
 * six months out are both perfectly useful and they are not the same product:
 * the first can say Thursday is the day for the ridge, the second can only say
 * what Augusts here are like. Rendering them identically would make the second
 * one a lie.
 */
function WeatherPlan({ itinerary, timeZone }: { itinerary: Itinerary; timeZone?: string }) {
  const days = itinerary.days;
  const kinds = [...new Set(days.map((day) => day.weather.evidence))];
  /*
   * AN ATTRIBUTION BELONGS TO A SOURCE, NOT TO A DAY.
   *
   * This took the first day carrying *any* attribution, which on almost every
   * trip is day 1 — the arrival day, usually `evidence: 'unavailable'`, whose
   * attribution is the sentence "nothing here has been checked against the
   * weather". So a plan that had just listed three things the forecast moved
   * printed "Nothing here has been checked against the weather" directly
   * underneath them.
   *
   * The distinct attributions of the days that were actually checked, joined;
   * and the not-checked sentence only when no day was checked at all, which is
   * the one case where it is true.
   */
  const checked = days.filter((day) => day.weather.evidence !== 'unavailable');
  const attributions = [
    ...new Set(
      (checked.length > 0 ? checked : days)
        .map((day) => day.weather.attribution)
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  const attribution = attributions.length > 0 ? attributions.join(' · ') : undefined;
  const points = [
    ...new Set(days.map((day) => day.weather.locationLabel).filter(Boolean)),
  ] as string[];
  const fetchedAt = days.find((day) => day.weather.fetchedAt)?.weather.fetchedAt;
  const decisions = days.flatMap((day) => day.weather.decisions);
  const label =
    kinds.length > 1
      ? 'Mixed evidence'
      : kinds[0] === 'forecast'
        ? 'Forecast'
        : kinds[0] === 'historical_pattern'
          ? 'Historical pattern'
          : 'No weather data';

  return (
    <Panel className="mt-6 p-6" as="section">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="font-display text-xl text-ink">Weather</h2>
        <Badge tone={kinds.includes('forecast') ? 'blue' : 'neutral'}>{label}</Badge>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        {/*
          Branching on what is actually mixed, not merely on there being more
          than one kind. A five-day trip wholly inside the horizon with one date
          the provider skipped is `['forecast','unavailable']` — and telling that
          traveller "part of this trip is beyond the forecast window" is untrue
          and, worse, hides the real problem, which is a missing day.
        */}
        {kinds.includes('historical_pattern') && kinds.includes('forecast')
          ? 'Part of this trip is inside the forecast window and part of it is not. The days that have a forecast are marked as such; the rest carry what this time of year usually does, which is not the same thing.'
          : kinds.length > 1 && kinds.includes('unavailable')
            ? 'We could not get weather for every day of this trip. The days we could are marked; the rest have not been checked against anything, and we have not guessed.'
            : kinds[0] === 'forecast'
            ? 'Your dates are inside the forecast window, so the days below were placed against an actual forecast for each one.'
            : kinds[0] === 'historical_pattern'
              ? 'Your dates are too far out for a forecast. The days below carry what this period has historically done here — useful for what to pack and what to have in reserve, and no help at all in telling one of your days from another. We have not moved anything on the strength of it.'
              : 'We could not reach a weather source for your dates, so nothing in this plan has been placed against one. Rebuild closer to the time.'}
      </p>

      {/*
        Only where there is weather to explain. With none, this paragraph is a
        lecture about elevation attached to four days of "we do not know".
      */}
      {points.length > 0 && kinds.some((kind) => kind !== 'unavailable') ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          {/*
            The count is real information — the region was not treated as one
            number — and it stays. The *names* are only printed when they name
            something: the forecast layer mints "Forecast point 3", an index a
            traveller cannot put on a map, and a live plan listed two of them
            here verbatim. See `isMachineWeatherLabel`.
          */}
          Taken at {points.length === 1 ? 'one point' : `${points.length} separate points`}
          {(() => {
            const named = points.filter((point) => !isMachineWeatherLabel(point));
            return named.length > 0 ? `: ${named.join(', ')}` : ' across the area';
          })()}
          . Somewhere that spans a range of elevations or a coastline
          can differ by several degrees across it, so one number for the whole region would
          be wrong at both ends.
        </p>
      ) : null}

      {decisions.length > 0 ? (
        <div className="mt-5 rounded-lg bg-paper-sunk p-4">
          <p className="text-xs font-medium text-ink">What the weather changed</p>
          <ul className="mt-1 space-y-1 text-sm leading-relaxed text-ink-muted">
            {decisions.map((decision) => (
              <li key={decision}>{decision}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-5 text-[11px] leading-relaxed text-ink-faint">
        {travellerVoice(attribution ?? 'No weather source was reached for this trip.')}
        {fetchedAt ? ` Read ${formatReadAt(fetchedAt, timeZone)}.` : ''} Conditions change; we
        have not checked today.
      </p>
    </Panel>
  );
}

/**
 * When the forecast was read, in the wall-clock time of the place it describes.
 *
 * `toUTCString()` printed "Thu, 30 Jul 2026 22:12:00 GMT" on a product whose
 * entire time model is wall-clock where you are standing — but the fix for that
 * was a hard-coded Californian zone, which is the same defect pointed the other
 * way. The zone comes from the trip's own base now, and a trip whose artifact
 * predates that says UTC rather than pretending.
 */
function formatReadAt(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: timeZone ?? 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TransportPlan({ strategy }: { strategy: TransportStrategy }) {
  const { totals } = strategy;

  return (
    /*
      ONE RULE, NOT TWO.

      The trip header already closes with `border-b`, and this section opened
      with `border-t` 36 pixels below it — two hairlines with nothing between
      them but whitespace, on screen and on paper. A rule is punctuation; two in
      a row is a stammer. The header's rule is the one that stays, because it is
      the one that belongs to a thing (the header) rather than to a gap.
    */
    <section className="mt-10" aria-labelledby="transport-plan">
      <h2 id="transport-plan" className="font-display text-xl text-ink">
        Getting around
      </h2>
      <p className="mt-2 max-w-2xl text-ink-muted">{strategy.headline}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Badge tone="pine">{TRANSPORT_MODE_LABELS[strategy.primaryMode]}</Badge>
        {strategy.secondaryMode ? (
          <Badge tone="blue">plus {TRANSPORT_MODE_LABELS[strategy.secondaryMode].toLowerCase()}</Badge>
        ) : (
          <Badge>no practical alternative</Badge>
        )}
        {/*
          Words, not enum values. "low stress" happened to read as English;
          "low convenience" read as a verdict delivered in machine, about a plan
          the traveller was just handed, with nothing to act on. Each label says
          what the value means for their days.
        */}
        <Badge tone={STRESS_TONE[strategy.stress]}>{STRESS_LABELS[strategy.stress]}</Badge>
        <Badge tone={CONVENIENCE_TONE[strategy.convenience]}>
          {CONVENIENCE_LABELS[strategy.convenience]}
        </Badge>
      </div>

      {/*
        A METRIC ONLY WHERE THERE IS SOMETHING TO MEASURE.

        These four used to render unconditionally, so a traveller who told us
        they had no car opened their finished plan and read "At the wheel: 0 min"
        and "Road distance: 0 km" — two confident measurements of a mode they
        explicitly declined, in a row that reads as a dashboard. `formatMinutes(0)`
        returns "0 min", which is a number, and a number is a claim.

        The rule is the one the progress screen already follows: a figure nobody
        measured is absent, not zero.
      */}
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        {totals.driveMinutes > 0 ? (
          <Metric label="At the wheel">{span(totals.driveMinutes)}</Metric>
        ) : null}
        {totals.transitMinutes + totals.waitMinutes > 0 ? (
          <Metric label="Riding & waiting">
            {span(totals.transitMinutes + totals.waitMinutes)}
          </Metric>
        ) : null}
        {totals.walkMinutes > 0 ? (
          <Metric label="On foot to reach things">{span(totals.walkMinutes)}</Metric>
        ) : null}
        {/*
          THE MINUTES THAT BELONG TO NO MODE.

          This panel read "ON FOOT TO REACH THINGS 6 hr 10 min" on a trip whose
          long legs were every one of them a walking figure standing in for a
          train nobody could time — the same total the day headers, the split
          line and the trip summary all repeated, to a traveller who had said
          they would walk twenty-five minutes. Those minutes are real and the
          plan holds them, so they are still measured here; what they are not is
          a mode, and this is the row that says so instead of the one above.
        */}
        {totals.unverifiedMinutes > 0 ? (
          <Metric label="Held for unverified journeys">{span(totals.unverifiedMinutes)}</Metric>
        ) : null}
        {totals.driveKm >= 0.5 ? (
          <Metric label="Road distance">{Math.round(totals.driveKm)} km</Metric>
        ) : null}
      </dl>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-ink">Why this way</h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {strategy.rationale.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        {strategy.tradeoffs.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium text-ink">What it costs you</h3>
            <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
              {strategy.tradeoffs.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <dl className="mt-6 space-y-3 text-sm">
        <Detail label="Parking">{strategy.parkingSummary}</Detail>
        <Detail label="Public transport">{strategy.transitSummary}</Detail>
        {strategy.withoutPrimary ? (
          <Detail label="Without a car">{strategy.withoutPrimary}</Detail>
        ) : null}
      </dl>

      {strategy.seasonalWarnings.length > 0 ? (
        <div className="mt-5 rounded-lg bg-amber-soft p-4">
          <h3 className="text-sm font-medium text-ink">Seasonal limits</h3>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-muted">
            {strategy.seasonalWarnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {strategy.verifyBeforeTravel.length > 0 ? (
        <div className="mt-3 rounded-lg border border-clay p-4">
          <h3 className="text-sm font-medium text-clay">Check these before you book</h3>
          <p className="mt-1 text-xs text-ink-faint">
            These change year to year. We have not checked today&rsquo;s conditions.
          </p>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
            {strategy.verifyBeforeTravel.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The same disclosure, addressed to the traveller rather than to whoever
        maintains the routing layer. `travellerVoice` never removes a caveat —
        see `plan-language.ts`.
      */}
      <p className="mt-4 text-xs leading-relaxed text-ink-faint">
        {travellerVoice(strategy.dataDisclosure)}
      </p>
    </section>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * What to say about where a leg's duration came from.
 *
 * One sentence per provenance, and the important one is the last. "Estimated
 * travel time" was previously printed against a constant that no source stood
 * behind, and a traveller cannot tell that apart from "roughly measured" — so a
 * leg nobody timed now says nobody timed it, and says what would fix that.
 */
function travelProvenanceLabel(travel: TravelSegment): string {
  /*
   * Asked before the provenance, because on this one leg the provenance is
   * about the wrong journey. "Modelled travel time" is true of the walk and
   * says nothing about the scheduled route the walk stands in for — and the
   * walking figure is the one real number on the row, so what it needs is the
   * question it answers, not the confidence behind it.
   */
  if (travel.unverifiedScheduled) {
    return 'route not verified — the walking time shown is the upper bound we hold for it';
  }
  switch (travel.provenance) {
    case 'measured':
      return 'measured travel time';
    case 'official':
      return 'published timetable';
    case 'modelled':
      return 'modelled travel time';
    case 'estimated':
      return 'estimated travel time';
    case 'unmeasured':
      switch (travel.unmeasuredReason) {
        case 'mode_not_routed':
          return 'travel time not measured — we have no route data for this way of travelling';
        case 'no_route_found':
          return 'travel time not measured — no route was found between these two points';
        case 'operator_unpublished':
          return 'travel time not measured — the operator does not publish one';
        default:
          return 'travel time not measured';
      }
  }
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sm:flex sm:gap-4">
      <dt className="shrink-0 text-ink-faint sm:w-40">{label}</dt>
      <dd className="text-ink-muted">{children}</dd>
    </div>
  );
}

/**
 * The day's transport as a sequence, not a table.
 *
 * "Drive → park → shuttle → walk → back" is the thing a traveller actually has
 * to execute, and reading it as one line is worth more than four accurate
 * numbers. The numbers sit underneath for anyone who wants them.
 */
function DayTransport({ day }: { day: ItineraryDay }) {
  const sequence = accessSequence(day);
  const { totals, transport } = day;
  const split = [
    totals.driveMinutes > 0 ? `${span(totals.driveMinutes)} driving` : null,
    totals.transitMinutes > 0 ? `${span(totals.transitMinutes)} riding` : null,
    totals.walkMinutes > 0 ? `${span(totals.walkMinutes)} walking there` : null,
    totals.waitMinutes > 0 ? `${span(totals.waitMinutes)} waiting` : null,
    /*
     * Its own clause, in the day's own breakdown, because the breakdown is
     * where a reader goes to find out what the travelling figure above is made
     * of. A day that held two hours for journeys nobody could price read "2 hr
     * walking there" here, which is the one thing those minutes are not.
     */
    totals.unverifiedMinutes > 0
      ? `${span(totals.unverifiedMinutes)} held for journeys we could not verify`
      : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <div className="mt-2">
      {/*
        A real list, so a screen reader announces "list, 6 items" and reads them
        one at a time. As bare spans with an aria-hidden arrow between them the
        steps ran together into a single unpunctuated phrase.
      */}
      {sequence.length > 1 ? (
        <ol
          aria-label={`How this day moves: ${sequence.join(', then ')}`}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-muted"
        >
          {sequence.map((step, index) => (
            <li key={`${step}-${index}`} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden="true" className="text-ink-faint">
                  →
                </span>
              ) : null}
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {/*
        The split, as a sentence rather than four more chips.

        The day header now promotes one travel figure; this is the breakdown of
        it, and a breakdown is reference material. Four badges here made the
        header's own two badges indistinguishable from them.
      */}
      {split.length > 0 ? <p className="mt-1 text-xs text-ink-muted">{split.join(' · ')}</p> : null}

      {transport.lastReturnNote ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{transport.lastReturnNote}</p>
      ) : null}
      {transport.parkingNotes.map((note) => (
        <p key={note} className="mt-1 text-xs leading-relaxed text-ink-faint">
          {travellerVoice(note)}
        </p>
      ))}
      {/*
        The rules' own prose — fares, boarding points, the exceptions that let you
        drive in. Folded away because it is long and only some of it applies on
        any given day, but present, because it is the part a traveller reads on
        the morning itself.
      */}
      {transport.accessNotes.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ink-faint hover:text-ink">
            How the access works ({transport.accessNotes.length})
          </summary>
          <ul className="mt-2 space-y-1 leading-relaxed text-ink-muted">
            {transport.accessNotes.map((note) => (
              <li key={note}>{travellerVoice(note)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {transport.verifyBeforeTravel.length > 0 ? (
        <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
          {/*
            Through `travellerVoice`, because these sentences are stored on the
            artifact in the data layer's own words — a live plan printed "We
            know a routing engine can reach this" here. The translation keeps
            every claim and re-addresses it to the person travelling.
          */}
          Check before you go:{' '}
          {transport.verifyBeforeTravel.map((note) => travellerVoice(note)).join(' ')}
        </p>
      ) : null}
    </div>
  );
}

/** Collapses the day's legs into the shape of the journey, without repeats. */
function accessSequence(day: ItineraryDay): string[] {
  const steps: string[] = [];
  const push = (label: string) => {
    if (steps[steps.length - 1] !== label) steps.push(label);
  };

  for (const item of day.items) {
    if (item.kind === 'activity') {
      push('visit');
      continue;
    }
    if (item.kind !== 'travel' || !item.travel) continue;
    const { mode, role } = item.travel;
    /*
     * A leg whose mode is a stand-in has no step name in the mode vocabulary,
     * so it takes the mode-free one. The strip is read as the thing to execute
     * — "walk → visit → walk back" told somebody to set off on foot for a
     * journey the row above it had just said nobody could price.
     */
    if (item.travel.unverifiedScheduled) push(role === 'return' ? 'travel back' : 'travel');
    else if (role === 'wait') push('board');
    else if (role === 'walk') push('walk');
    // "back" comes from the leg's own role, not from whether anything has been
    // visited yet — otherwise every hop between two stops reads as a return.
    else if (role === 'return') push(`${TRANSPORT_MODE_LABELS[mode].toLowerCase()} back`);
    else push(TRANSPORT_MODE_LABELS[mode].toLowerCase());
  }
  return steps;
}

/**
 * What the day's opening hours did to its shape.
 *
 * Renders nothing at all on a day where nothing had a closing time, which is
 * most of them here. When it does render, the anchor comes first: "be at this
 * one by four, everything else can move" is the sentence a traveller can act on,
 * and it beats four rows of times for them to reconcile themselves.
 */
function DayHours({ day }: { day: ItineraryDay }) {
  const { availability } = day;
  /**
   * Only the two things the day as a whole can say that a single stop cannot:
   * which stop fixes its shape, and what has to be arranged before it works.
   *
   * The cautions and the verification notes live on the stops themselves, a few
   * centimetres below. Printing them here as well put the same sentence on the
   * screen twice, which reads as a template rather than as advice — they are
   * still persisted with the plan, for the day an export or a digest needs them
   * without the timeline.
   */
  const hasSomething = availability.anchorNote !== undefined || availability.bookings.length > 0;
  if (!hasSomething) return null;

  return (
    <section className="mt-3 border-t border-rule pt-3" aria-label={`Opening hours on day ${day.dayNumber}`}>
      {availability.anchorNote ? (
        <p className="text-sm leading-relaxed text-ink-muted">{availability.anchorNote}</p>
      ) : null}

      {availability.bookings.length > 0 ? (
        <div className="mt-2 rounded-md border border-clay/40 p-2.5">
          <p className="text-xs font-medium text-clay">
            {availability.bookings.length === 1
              ? 'One thing here needs arranging'
              : `${availability.bookings.length} things here need arranging`}
          </p>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
            {availability.bookings.map((booking) => (
              <li key={booking.placeId}>
                <span className="font-medium text-ink">{booking.name}</span> —{' '}
                {BOOKING_KIND_LABELS[booking.kind].toLowerCase()}. We have not made it for you.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The weather tone map, in the house vocabulary.
 *
 * pine = confirmed good, blue = an alternative worth knowing about, amber =
 * caution, clay = blocking. `workable` earns nothing at all, which is the point:
 * most days most of the time are simply fine, and a badge on every row is a
 * badge nobody reads.
 */
const WEATHER_TONE: Record<string, BadgeTone> = {
  favorable: 'pine',
  poor: 'amber',
  incompatible: 'clay',
  unknown: 'neutral',
  workable: 'neutral',
};

const WEATHER_BADGE: Record<string, string> = {
  favorable: 'Good weather for it',
  poor: 'Weather against it',
  incompatible: 'Not in this weather',
  unknown: 'No weather data',
  workable: '',
};

/**
 * What the weather did to this day, and where else to go if it turns.
 *
 * The evidence label is the load-bearing part and it is never omitted. "Forecast"
 * and "Historical pattern" are different claims — one is about Thursday, the
 * other about Augusts — and a reader who cannot tell which they are looking at
 * has been given a number without its meaning. So the label leads, the numbers
 * follow, and the attribution sits underneath in the same quiet type the
 * transport data disclosure uses.
 */
function DayWeather({ day, renderedAt }: { day: ItineraryDay; renderedAt: number }) {
  const { weather } = day;
  // `renderedAt` rather than `Date.now()`: this is a stored plan being read
  // back, so "how old is the forecast" has to be answered once, on the server,
  // against the same instant for every day — otherwise two days on one page can
  // disagree about whether the same forecast is stale.
  const stale =
    weather.evidence === 'forecast' && weather.fetchedAt
      ? renderedAt - Date.parse(weather.fetchedAt) > (weather.staleAfterMinutes ?? 360) * 60_000
      : false;

  return (
    <section
      className="mt-3 border-t border-rule pt-3"
      aria-label={`Weather on day ${day.dayNumber}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge tone={weather.evidence === 'forecast' ? 'blue' : 'neutral'}>
          {weather.evidence === 'forecast'
            ? 'Forecast'
            : weather.evidence === 'historical_pattern'
              ? 'Historical pattern'
              : 'No weather data'}
        </Badge>
        {/*
          Only a label that names somewhere. "Forecast point 3" is a build
          index — it told a live traveller nothing and read as engineering on
          every day badge, so a machine-minted label renders as silence.
        */}
        {weather.locationLabel && !isMachineWeatherLabel(weather.locationLabel) ? (
          <span className="text-xs text-ink-faint">{weather.locationLabel}</span>
        ) : null}
        {stale ? <Badge tone="amber">Read a while ago</Badge> : null}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ink-muted">{weather.summary}</p>

      {weather.sunriseMinute !== undefined && weather.sunsetMinute !== undefined ? (
        <p className="mt-1 text-xs text-ink-faint">
          Light from {clock(weather.sunriseMinute, 'later')} to{' '}
          {clock(weather.sunsetMinute, 'earlier')}.
        </p>
      ) : null}

      {weather.decisions.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
          {weather.decisions.map((decision) => (
            <li key={decision}>{decision}</li>
          ))}
        </ul>
      ) : null}

      {weather.backups.length > 0 ? (
        <div className="mt-2 rounded-md border border-slate-blue/40 p-2.5">
          <p className="text-xs font-medium text-slate-blue">
            {weather.backups.length === 1 ? 'If it turns' : 'If it turns, either of these'}
          </p>
          <ul className="mt-1 space-y-1.5 text-xs leading-relaxed text-ink-muted">
            {weather.backups.map((backup) => (
              <li key={backup.placeId}>
                <span className="font-medium text-ink">{backup.name}</span> — {backup.why}{' '}
                {backup.openingSummary} {backup.accessSummary}
                {backup.caution ? <span className="text-ink-faint"> {backup.caution}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {weather.noBackupReason ? (
        <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">No strong fallback for this one.</span>{' '}
          {weather.noBackupReason}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        {travellerVoice(weather.attribution)}
        {weather.evidence === 'historical_pattern'
          ? ' These are patterns from past years, not a forecast for your dates.'
          : ''}
      </p>
    </section>
  );
}

function DayCard({
  day,
  renderedAt,
  coordinates,
  tripId,
  lockedPlaceIds,
  images,
  rationale,
  isFirst,
  isLast,
}: {
  day: ItineraryDay;
  renderedAt: number;
  coordinates: Record<string, { lat: number; lng: number }>;
  /** Absent on the shared, read-only copy. See `ItineraryView`. */
  tripId?: string;
  lockedPlaceIds: ReadonlySet<string>;
  /** Licensed photographs by place id, read from a table by the page. */
  images: Record<string, ImageRecord>;
  /** What the fit model said about each stop, by place id. See `StopRationale`. */
  rationale: Record<string, StopRationale>;
  /** Whether this is the arrival or the departure day, for the empty-day copy. */
  isFirst: boolean;
  isLast: boolean;
}) {
  const isEmpty = day.totals.activityMinutes === 0;

  /**
   * The day's stops, in the order the plan puts them, for a map link.
   *
   * Built from the timeline rather than from the candidate list, so the link
   * follows the route that was actually scheduled. A stop whose coordinates the
   * compiled region does not carry is left out — and `dayRouteLinks` reports how
   * many, so the label can say the link is short rather than imply it is whole.
   */
  const stops = day.items
    .filter((item) => item.kind === 'activity' && item.placeId !== undefined)
    .map((item) => {
      const point = coordinates[item.placeId!];
      /*
       * The resolved name in the map link too. A link labelled in a script the
       * traveller cannot read is a link they cannot check.
       */
      const name = rationale[item.placeId!]?.name ?? item.title;
      return point ? { id: item.placeId!, name, ...point } : null;
    })
    .filter((stop): stop is { id: string; name: string; lat: number; lng: number } => stop !== null);

  /*
   * A day holding a journey nobody could price asks the map for transit.
   *
   * `day.transport.modes` carries no mode for such a leg — there is none to
   * carry — and the fallback below is walking, which would hand the traveller
   * an hour of walking directions for the exact journey this page has just told
   * them we could not time. A map app can price that route live, which is the
   * one thing this build could not do; asking it for the network we believe is
   * there beats asking it to route somebody on foot around it.
   */
  const links = dayRouteLinks(
    stops,
    day.totals.unverifiedMinutes > 0 ? 'transit' : mapModeFor(day.transport.modes),
  );

  /*
   * Everything the day needs in order to look like itself rather than like the
   * day above it. All of it derived from what is already scheduled — nothing is
   * fetched, nothing is invented, and a day with none of it renders none of it.
   */
  const identity = dayIdentity(day, images, rationale);
  const placedStops = stops.map((stop) => ({
    id: stop.id,
    name: stop.name,
    coordinates: { lat: stop.lat, lng: stop.lng },
  }));
  const scheduledStopCount = day.items.filter(
    (item) => item.kind === 'activity' && item.placeId !== undefined,
  ).length;
  /*
   * The number on the map, by place. Numbered over the *placed* stops rather
   * than over every activity, because a drawing that skips a stop it cannot
   * position must not also skip a number — "1, 2, 4" on a map is a reader
   * hunting for a mark that was never drawn.
   */
  const mapNumbers: Record<string, number> = {};
  placedStops.forEach((stop, index) => {
    mapNumbers[stop.id] = index + 1;
  });

  return (
    <Panel className="overflow-hidden">
      {/*
        THE DAY'S OWN COLOUR, ACROSS THE TOP OF IT.

        Eight days of identical cream panels is the §18 pattern applied to the
        one artifact a traveller actually carries. The hue is not decoration and
        is not a hash: it is `PLATE_HUE` for whatever kind of place the day is
        mostly made of, the same table the board's plates use — so a day of lakes
        is the colour lakes are on the board, and two days that are genuinely the
        same kind of day look the same on purpose. A day with nothing scheduled
        has no dominant anything and gets the rule colour.
      */}
      <div
        aria-hidden="true"
        className="h-1.5 w-full"
        style={
          identity.hue === null
            ? { background: 'var(--color-rule)' }
            : { background: `linear-gradient(90deg, hsl(${identity.hue} 30% 42%), hsl(${identity.hue} 24% 66%))` }
        }
      />
      {/*
        The anchor the day rail jumps to, with room above it for the two sticky
        elements — the product chrome and the rail itself — so a jump lands on
        the heading rather than under it.
      */}
      <div
        id={`day-${day.dayNumber}`}
        className="scroll-mt-[calc(var(--chrome-height)+4.5rem)] border-b border-rule bg-paper-sunk p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {/*
            A separator that is part of the accessible name, not decoration.

            `Day 1` followed by `2026-08-12` with only a margin between them
            announced as "Day 12026-08-12". The middle dot is real text for
            exactly that reason, and the ISO value lives on the `<time>` where a
            machine can still read it.
          */}
          <h2 className="font-display text-2xl text-ink">
            Day {day.dayNumber}
            {/*
              Real spaces around the dot, not margin.

              Margin is invisible to the accessibility tree, so `Day 1` + `·` +
              the date still concatenated into "Day 1·Wed 12 Aug" when read
              aloud. The separator has to be text on both sides to be a
              separator in both renderings.
            */}
            <span className="font-normal text-ink-faint">{' · '}</span>
            <time dateTime={day.date} className="text-base font-normal text-ink-muted">
              {humanDate(day.date)}
            </time>
          </h2>
          <span className="text-sm tabular-nums text-ink-muted">
            {clock(day.window.startMinute, 'later')} – {clock(day.window.endMinute, 'earlier')}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {/*
            The theme *and where you are sleeping*. On a multi-base trip the base
            is the single most consequential fact about a day and it appeared
            nowhere on the day — only in the trip header, which claims one base
            for the whole plan.
          */}
          <p className="text-ink-muted">
            {day.theme}
            <span className="text-ink-faint"> · based in {day.baseName}</span>
          </p>
          {/*
            One honest verb, only on days it can act on. A light day offered
            "make this easier" is a button that can only apologise.
          */}
          {tripId && day.intensity !== 'light' && day.totals.activityMinutes > 0 ? (
            <EaseDayButton tripId={tripId} dayNumber={day.dayNumber} />
          ) : null}
        </div>

        {/*
          TWO FACTS PROMOTED, THE REST DEMOTED.

          The header carried three stacked rows of identical grey pills — the
          day's intensity, its hours at stops, its free hours, the shape of its
          journey and its per-mode splits, all at the same weight. Six or seven
          pills of equal emphasis is a list, and a list has no answer in it.

          What a traveller decides on when they look at a day is: how hard is it,
          and how much of it is spent moving. Those two get chips. Everything
          else is still here, one line down, in text — legible, ordered, and no
          longer competing.
        */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone={INTENSITY_TONE[day.intensity]}>{day.intensity} day</Badge>
          {day.totals.travelMinutes > 0 ? (
            <Badge tone="blue">{span(day.totals.travelMinutes)} travelling</Badge>
          ) : null}
          {/*
            The one chip that differs between two days of the same shape: how
            much of this one is on your feet. Eight days badged only "moderate
            day · 1 hr travelling" are eight days a reader cannot tell apart, and
            walking is the fact somebody with a knee, a pushchair or a long
            flight behind them is actually scanning for.
          */}
          {day.totals.walkMinutes >= WALKING_DAY_MINUTES ? (
            <Badge tone="neutral">{span(day.totals.walkMinutes)} on foot</Badge>
          ) : null}
        </div>

        {day.totals.activityMinutes > 0 || day.totals.freeMinutes > 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            {[
              day.totals.activityMinutes > 0 ? `${span(day.totals.activityMinutes)} at stops` : null,
              day.totals.freeMinutes > 0 ? `${span(day.totals.freeMinutes)} free` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}

        {day.totals.travelMinutes > 0 ? <DayTransport day={day} /> : null}
        <DayHours day={day} />
        <DayWeather day={day} renderedAt={renderedAt} />
        <DayFood day={day} />

        {day.window.note ? (
          <p className="mt-3 text-sm text-ink-faint">{day.window.note}</p>
        ) : null}

        {/*
          THE PICTURE AND THE MAP, SIDE BY SIDE AT THE HEAD OF THE DAY.

          A fresh designer's summary of this page was "1440x6280 of 11px gray
          text: no photograph, no map, no day hero". Both halves of that are
          fixed from material the product already had and was not using — a
          licensed photograph of one of the day's own stops, read from the same
          table the board reads, and a drawing built from the coordinates that
          were already threaded into this component to make a Google Maps link.

          Neither is decoration and neither is fabricated: the photograph is of a
          place on this day or there is no photograph, and the map draws only
          stops whose position a source published.
        */}
        {identity.hero || placedStops.length > 0 ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {identity.hero ? (
              <div>
                <DestinationImage
                  image={identity.hero.image}
                  fallback={imageryFallbackFor({
                    kind: 'candidate',
                    id: identity.hero.placeId,
                    name: identity.hero.name,
                  })}
                  ratio="natural"
                  credit="none"
                  {...(identity.hero.category ? { category: identity.hero.category } : {})}
                />
                <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
                  {identity.hero.name}, on this day. <ImageCredit image={identity.hero.image} as="span" className="mt-0 inline" />
                </p>
              </div>
            ) : null}
            {placedStops.length > 0 ? (
              <DayMap
                base={coordinates[day.baseId] ?? null}
                stops={placedStops}
                omitted={scheduledStopCount - placedStops.length}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {isEmpty ? (
        /*
          AN EMPTY DAY IS EXPLAINED BY WHICH DAY IT IS.

          This sentence was unconditional, so a completely blank Saturday in the
          middle of a five-day trip was captioned "on an arrival or departure day
          that is usually the honest answer" — a false statement about the day it
          was printed on, directly under a `window.note` that already gives the
          true arrival/departure sentence when it applies. A mid-trip blank is a
          different fact and deserves a different sentence, and the one thing it
          must not do is claim to be something it is not.
        */
        <p className="p-5 text-sm text-ink-muted">
          {isFirst || isLast
            ? 'Nothing scheduled. On an arrival or departure day that is usually the honest answer.'
            : 'Nothing scheduled, and this is not an arrival or departure day. Everything you picked fitted better on another day or could not be reached on this one — the hours are yours. What was left off, and why, is at the foot of this plan.'}
        </p>
      ) : (
        <ol className="divide-y divide-rule">
          {day.items.map((item) => (
            <li key={item.id}>
              <TimelineRow
                item={item}
                window={day.window}
                stopNumber={item.placeId ? (mapNumbers[item.placeId] ?? null) : null}
                {...(item.placeId && rationale[item.placeId]
                  ? { rationale: rationale[item.placeId]! }
                  : {})}
                menu={
                  tripId && item.kind === 'activity' && item.placeId ? (
                    <StopEditMenu
                      tripId={tripId}
                      dayNumber={day.dayNumber}
                      placeId={item.placeId}
                      title={item.title}
                      locked={lockedPlaceIds.has(item.placeId)}
                    />
                  ) : undefined
                }
              />
            </li>
          ))}
        </ol>
      )}

      {day.warnings.length > 0 ? (
        <ul className="border-t border-rule bg-amber-soft/40 p-4 text-xs leading-relaxed text-ink-muted">
          {day.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {links ? (
        <div className="border-t border-rule p-4 print:hidden">
          <a
            href={links.google}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonClass('secondary', 'sm')}
            data-testid={`day-route-${day.dayNumber}`}
          >
            Open day {day.dayNumber} in Google Maps
          </a>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            {links.omitted > 0
              ? `The link carries the first ${links.included} stops of this day — a maps URL will not hold more. The remaining ${links.omitted} are on the plan above.`
              : `${links.included} of the day's places to visit, in order. Meals and stops without a location are not in the link.`}{' '}
            <a href={links.apple} target="_blank" rel="noreferrer noopener" className="underline">
              Apple Maps
            </a>{' '}
            takes one destination at a time, so that link runs from the first stop straight to the
            last and skips what is in between.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * WHAT MAKES ONE DAY LOOK LIKE ITSELF.
 *
 * Two things, both read off what is already scheduled:
 *
 *   - the **hue**, from the kind of place the day is mostly made of, taken from
 *     the same `PLATE_HUE` table the board's plates use so a lakes day is the
 *     colour lakes are throughout the product;
 *   - the **hero**, the first stop on the day for which a licensed photograph
 *     has already been resolved and stored. First rather than best: the day runs
 *     in an order and the morning is what a reader is looking at.
 *
 * Both are null on a day that has neither, and the header then simply renders
 * neither. A generated stand-in for a day would be a picture of nowhere.
 */
function dayIdentity(
  day: ItineraryDay,
  images: Record<string, ImageRecord>,
  rationale: Record<string, StopRationale>,
): {
  hue: number | null;
  hero: { placeId: string; name: string; image: ImageRecord; category?: PlaceCategory } | null;
} {
  const stops = day.items.filter((item) => item.kind === 'activity' && item.placeId !== undefined);

  const counts = new Map<PlaceCategory, number>();
  for (const stop of stops) {
    const category = rationale[stop.placeId!]?.category;
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  let hue: number | null = null;
  let best = 0;
  for (const [category, count] of counts) {
    if (count > best) {
      best = count;
      hue = PLATE_HUE[category];
    }
  }

  let hero: ReturnType<typeof dayIdentity>['hero'] = null;
  for (const stop of stops) {
    const image = images[stop.placeId!];
    /*
     * The same gate the board applies: a `weak` subject match is a file found by
     * searching a name, and a picture of a different waterfall in the same
     * valley is a claim, and it is wrong.
     */
    if (!image || image.subjectConfidence === 'weak') continue;
    const category = rationale[stop.placeId!]?.category;
    hero = {
      placeId: stop.placeId!,
      name: rationale[stop.placeId!]?.name ?? stop.title,
      image,
      ...(category ? { category } : {}),
    };
    break;
  }

  return { hue, hero };
}

/**
 * What is worth saying about a meal that the row above it has not said already.
 *
 * The rule the hours block already lives by: only what bears on this decision.
 * A venue's opening window is printed when the meal sits near an edge of it and
 * not when it does not; a dietary line appears only for something the traveller
 * actually told us about; and the alternatives are two names, not a menu.
 *
 * Nothing here claims a venue is safe, and nothing implies a booking exists.
 */
function FoodDetail({ food }: { food: ScheduledFood }) {
  const supported = food.dietary.filter((claim) => claim.evidence !== 'unknown');
  // A twenty-minute shop is not a meal. Asking a supermarket to confirm how it
  // handles an allergy — in the one place a traveller can read every label
  // themselves — is the kind of caution that teaches people to skip cautions.
  const isShop = food.stopKind === 'grocery';
  return (
    <>
      {food.hours ? (
        <p className="mt-1 text-xs tabular-nums text-ink-faint">
          Open {clock(food.hours.openMinute, 'later')}–
          {clock(food.hours.closeMinute, 'earlier')}
          {food.hours.periodLabel ? ` · ${food.hours.periodLabel}` : ''}
          {food.hours.confidence !== 'published' ? ' · closing time is ours, not theirs' : ''}
        </p>
      ) : null}

      {/*
        The line that stands where an opening window would, and says the one
        thing there is to say instead. No clock on it, because there is no clock
        to put there — the hour on the row is the meal's, not the venue's.
      */}
      {food.hoursUnknown ? (
        <p className="mt-1 text-xs text-ink-faint">
          Nobody publishes hours for this that we could read. Check before you go.
        </p>
      ) : null}

      {food.cuisineLabel ? (
        <p className="mt-1 text-xs text-ink-faint">{food.cuisineLabel}</p>
      ) : null}

      {supported.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
          {supported.map((claim) => (
            <li key={claim.need}>
              <span className="font-medium text-ink">{DIETARY_NEED_LABELS[claim.need]}</span>{' '}
              <span className="text-ink-faint">
                — {DIETARY_EVIDENCE_COPY[claim.evidence]}.
              </span>{' '}
              {claim.note}
              {claim.sourceUrl ? (
                <>
                  {' '}
                  <a
                    className="underline underline-offset-2"
                    href={claim.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    their page
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {food.dietaryUnverified.length > 0 && !isShop ? (
        <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">Nobody has confirmed this either way.</span>{' '}
          {food.venueName ?? 'This place'} has nothing on record about{' '}
          {food.dietaryUnverified.map((need) => DIETARY_NEED_LABELS[need].toLowerCase()).join(', ')}.
          Ring them before you count on it.
        </p>
      ) : null}

      {food.reservation &&
      (food.reservation.requirement === 'required' ||
        food.reservation.requirement === 'recommended') ? (
        <p className="mt-2 rounded-md border border-clay/40 p-2.5 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-clay">You have to book this yourself.</span>{' '}
          {food.reservation.note ?? 'We have not booked anything.'}
          {food.reservation.bookingUrl ? (
            <>
              {' '}
              <a
                className="underline underline-offset-2"
                href={food.reservation.bookingUrl}
                target="_blank"
                rel="noreferrer"
              >
                Their booking page
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}

      {food.alternatives.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink-faint">
            Other options here ({food.alternatives.length})
          </summary>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
            {food.alternatives.map((option) => (
              <li key={option.venueId}>
                <span className="font-medium text-ink">{option.name}</span> — {option.tradeoff}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {food.hours ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          {food.hours.sourceKind === 'official' ? 'Hours from' : 'Hours written from'}{' '}
          {food.hours.sourceUrl ? (
            <a
              className="underline underline-offset-2"
              href={food.hours.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {food.hours.sourceName}
            </a>
          ) : (
            food.hours.sourceName
          )}
          {food.hours.lastVerified ? `, read ${food.hours.lastVerified}` : ''}. We have not checked
          today.
        </p>
      ) : null}
    </>
  );
}

/**
 * What this day's food plan is, as a day rather than as a list of meals.
 *
 * Renders nothing at all on an ordinary day, which is most of them: everything a
 * meal row can say for itself, it says for itself. What is left is what only a
 * day can say — that lunch has to be carried, that the shopping happened this
 * morning for tomorrow, that a table needs booking.
 */
function DayFood({ day }: { day: ItineraryDay }) {
  const { food } = day;
  if (food.notes.length === 0 && food.reservations.length === 0) return null;

  return (
    <section
      className="mt-3 border-t border-rule pt-3"
      aria-label={`Food on day ${day.dayNumber}`}
    >
      <h4 className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">Eating</h4>
      {food.notes.length > 0 ? (
        <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
          {food.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {food.reservations.length > 0 ? (
        <p className="mt-2 rounded-md border border-clay/40 p-2.5 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-clay">
            {food.reservations.length === 1
              ? 'One table to book'
              : `${food.reservations.length} tables to book`}
            .
          </span>{' '}
          {food.reservations.map((entry) => entry.venueName).join(', ')}. We have not booked
          anything.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The trip's food position.
 *
 * Deliberately short, and deliberately without a total. Four venues in this
 * whole region publish prices, so a trip food cost would be a guess with a
 * currency symbol on it — and the one number everybody would then plan around.
 */
function FoodPlanPanel({ plan }: { plan: FoodPlan }) {
  const facts: { label: string; value: string }[] = [];
  if (plan.specialMealBudget > 0) {
    facts.push({
      label: 'Meals meant to be an event',
      value: `${plan.specialMealsPlanned} of ${plan.specialMealBudget}`,
    });
  }
  if (plan.groceryDayNumbers.length > 0) {
    facts.push({ label: 'Shopping days', value: plan.groceryDayNumbers.join(', ') });
  }
  if (plan.packedDayNumbers.length > 0) {
    facts.push({ label: 'Carrying lunch', value: `Day ${plan.packedDayNumbers.join(', ')}` });
  }
  if (plan.daysWithoutVerifiedOption.length > 0) {
    facts.push({
      label: 'Days you pick yourself',
      value: plan.daysWithoutVerifiedOption.join(', '),
    });
  }

  return (
    <Panel as="section" className="mt-8 p-5 sm:p-6" labelledBy="food-plan">
      <h2 className="font-display text-xl text-ink" id="food-plan">
        Eating
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{plan.headline}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{plan.style}</p>

      {facts.length > 0 ? (
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                {fact.label}
              </dt>
              <dd className="mt-0.5 text-sm text-ink tabular-nums">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {plan.localSpecialties.length > 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          Worth ordering:{' '}
          <span className="text-ink">{plan.localSpecialties.join(', ')}</span>.
        </p>
      ) : null}

      {plan.dietaryDisclosure ? (
        <p className="mt-4 rounded-md bg-amber-soft p-3 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">
            {plan.dietaryNeeds.map((need) => DIETARY_NEED_LABELS[need]).join(', ')}.
          </span>{' '}
          {plan.dietaryDisclosure}
        </p>
      ) : null}

      {plan.unusedChoices.length > 0 ? (
        <div className="mt-4 rounded-md border border-clay/40 p-3">
          <p className="text-xs font-medium text-clay">
            {plan.unusedChoices.length === 1
              ? 'One place you asked for is not on the plan'
              : `${plan.unusedChoices.length} places you asked for are not on the plan`}
          </p>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
            {plan.unusedChoices.map((choice) => (
              <li key={choice.venueId}>
                <span className="font-medium text-ink">{choice.name}</span> — {choice.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
        {travellerVoice(plan.dataDisclosure)}
      </p>
    </Panel>
  );
}

function TimelineRow({
  item,
  window,
  menu,
  stopNumber = null,
  rationale,
}: {
  item: ItineraryItem;
  window: DailyWindow;
  /** The quiet per-stop edit control, supplied only where editing applies. */
  menu?: React.ReactNode;
  /** Which mark on the day's map this row is. Null on anything not drawn. */
  stopNumber?: number | null;
  /** What the fit model says about this stop. See `StopRationale`. */
  rationale?: StopRationale;
}) {
  const style = KIND_STYLE[item.kind];
  /**
   * Hours are shown only when they bear on this day. A site posted 06:00 to
   * 22:00 on a day that runs 07:30 to 19:00 has constrained nothing, and saying
   * so on every stop is how a traveller learns to skip the line that matters.
   */
  const hours =
    item.hours &&
    (item.hours.openMinute > window.startMinute ||
      item.hours.closeMinute < window.endMinute ||
      item.hours.lastAdmissionMinute !== undefined)
      ? item.hours
      : undefined;

  return (
    <div className="flex gap-3 p-4 sm:gap-4 sm:p-5">
      <div className="w-14 shrink-0 pt-0.5 text-right sm:w-16">
        <time className="block text-sm tabular-nums text-ink">
          {clock(item.startMinute, 'later')}
        </time>
        <span className="mt-0.5 block text-[11px] tabular-nums text-ink-faint">
          {span(item.durationMinutes)}
        </span>
      </div>

      {/*
        The rail, or the map's own number where this row is drawn on it.

        Two surfaces showing the same day have to be tied together or they are
        two documents about one thing: a numbered mark on the drawing above
        answers "where is that" only if the row says which number it is.
      */}
      {stopNumber === null ? (
        <span aria-hidden="true" className={cx('mt-1.5 w-1 shrink-0 rounded-full', style.rail)} />
      ) : (
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-pine text-[11px] font-semibold text-paper"
        >
          {stopNumber}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3
            className={cx(
              'text-ink',
              item.kind === 'activity' ? 'font-display text-lg' : 'text-sm font-medium',
            )}
          >
            {/* See `StopRationale.name`: the plan stores a string, so the name
                is re-resolved at render for place rows and left alone for the
                composed titles of travel and food blocks. */}
            {rationale?.name ?? item.title}
          </h3>
          {item.travel ? (
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              {/*
                THE CHIP THAT CONTRADICTED THE TITLE BESIDE IT.

                The row already reads "Travel to X" rather than "Walk to X",
                because the mode on a proxy leg is a stand-in for a scheduled
                journey nobody could price. This chip read the raw mode and put
                WALK a centimetre to its right — the reviewer read it off the
                screen. A leg with no known mode gets the product's existing
                phrase for that state instead of a mode it does not have.
              */}
              {item.travel.unverifiedScheduled
                ? 'Journey not verified'
                : TRANSPORT_MODE_LABELS[item.travel.mode]}
            </span>
          ) : item.food ? (
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              {[MEAL_SLOT_LABELS[item.food.slot], FOOD_STOP_LABEL[item.food.stopKind]]
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : style.label ? (
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
              {style.label}
            </span>
          ) : null}
          {item.food?.serviceType && item.food.stopKind === 'venue' ? (
            <Badge>{FOOD_SERVICE_TYPE_LABELS[item.food.serviceType]}</Badge>
          ) : null}
          {item.food?.priceBand ? (
            <Badge title={`${PRICE_BAND_WORDS[item.food.priceBand]} — ${item.food.priceEvidence ? PRICE_EVIDENCE_COPY[item.food.priceEvidence] : ''}`}>
              {PRICE_BAND_LABELS[item.food.priceBand]}
            </Badge>
          ) : null}
          {item.food?.isSpecialMeal ? <Badge tone="pine">Your one big one</Badge> : null}
          {item.food?.reservation &&
          (item.food.reservation.requirement === 'required' ||
            item.food.reservation.requirement === 'recommended') ? (
            <Badge tone="amber">{RESERVATION_LABELS[item.food.reservation.requirement]}</Badge>
          ) : null}
          {item.physicalIntensity && item.physicalIntensity !== 'none' ? (
            <Badge>{item.physicalIntensity}</Badge>
          ) : null}
          {item.weather && item.weather.suitability !== 'workable' ? (
            <Badge tone={WEATHER_TONE[item.weather.suitability]}>
              {WEATHER_BADGE[item.weather.suitability]}
            </Badge>
          ) : null}
          {item.booking ? (
            <Badge tone="amber">{BOOKING_KIND_LABELS[item.booking.kind]}</Badge>
          ) : null}
        </div>

        {hours ? (
          <p className="mt-1 text-xs tabular-nums text-ink-faint">
            Open {clock(hours.openMinute, 'later')}–{clock(hours.closeMinute, 'earlier')}
            {hours.lastAdmissionMinute !== undefined
              ? ` · arrive before ${clock(hours.lastAdmissionMinute, 'earlier')}`
              : ''}
            {hours.periodLabel ? ` · ${hours.periodLabel}` : ''}
          </p>
        ) : null}

        {/*
          WHY THIS STOP IS ON THIS DAY.

          The plan stores one sentence per stop and it is a template with an
          interest name substituted in, so a real itinerary read "Matches your
          interest in food & mountain towns" under eleven consecutive rows — and
          under a car wash, on the only finished plan in the database. That is
          the product's stated differentiator rendered as boilerplate.

          The fit model already computed a specific sentence for every one of
          these places, on the board the traveller chose from, and the page
          re-reads it. Where it has one, it leads; the plan's own sentence stays
          underneath, in the smaller voice, because it says something the fit
          sentence does not — which interest this stop was scheduled *against*.
          Where the region no longer holds a card, nothing changes at all.
        */}
        {rationale?.why ? (
          <p className="mt-1 text-sm leading-relaxed text-ink-muted" data-testid="stop-why">
            {rationale.why}
          </p>
        ) : null}
        <p
          className={cx(
            'mt-1 leading-relaxed',
            rationale?.why ? 'text-xs text-ink-faint' : 'text-sm text-ink-muted',
          )}
        >
          {item.reason}
        </p>
        {/*
          The facts that differ between two stops that fit for the same reason:
          how far out it is, whether it is a quiet find, whether it holds up in
          bad weather. Two at most — a row wearing five is a row nobody reads.
        */}
        {rationale?.facets && rationale.facets.length > 0 ? (
          <p className="mt-1 text-xs text-ink-faint" data-testid="stop-facets">
            {rationale.facets.slice(0, 2).join(' · ')}
          </p>
        ) : null}

        {item.food ? <FoodDetail food={item.food} /> : null}

        {item.travel ? (
          <p className="mt-1 text-xs text-ink-faint">
            {item.travel.fromName} → {item.travel.toName}
            {item.travel.km !== null && item.travel.km > 0
              ? ` · ${Math.round(item.travel.km)} km`
              : ''}{' '}
            · {travelProvenanceLabel(item.travel)}
          </p>
        ) : null}

        {item.accessWarning ? (
          <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            {item.accessWarning}
          </p>
        ) : null}

        {item.seasonalNote && item.seasonalNote !== item.accessWarning ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">{item.seasonalNote}</p>
        ) : null}

        {item.booking ? (
          <p className="mt-2 rounded-md border border-clay/40 p-2.5 text-xs leading-relaxed text-ink-muted">
            <span className="font-medium text-clay">You have to arrange this yourself.</span>{' '}
            {item.booking.note ?? 'We have not booked anything.'}
            {item.booking.url ? (
              <>
                {' '}
                <a
                  className="underline underline-offset-2"
                  href={item.booking.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Book with the operator
                </a>
                .
              </>
            ) : null}
          </p>
        ) : null}

        {item.daylightOnly ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Signed for daylight use only.{' '}
            {item.daylight
              ? `Placed inside ${clock(item.daylight.sunriseMinute, 'later')}–${clock(
                  item.daylight.sunsetMinute,
                  'earlier',
                )} for this date.`
              : 'We could not work out sunrise and sunset for this one, so check the light yourself.'}
          </p>
        ) : null}

        {item.verifyBeforeTravel ? (
          <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            <span className="font-medium text-ink">Check its hours.</span>{' '}
            {item.verifyBeforeTravel}
          </p>
        ) : null}

        {hours ? (
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            {hours.sourceKind === 'official' ? 'Hours from' : 'Hours written from'}{' '}
            {hours.sourceUrl ? (
              <a
                className="underline underline-offset-2"
                href={hours.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {hours.sourceName}
              </a>
            ) : (
              hours.sourceName
            )}
            {hours.lastVerified ? `, read ${hours.lastVerified}` : ', not checked against a source'}
            . We have not checked today.
          </p>
        ) : null}
      </div>

      {menu ? <div className="shrink-0 self-start">{menu}</div> : null}
    </div>
  );
}


/**
 * WHAT TO KEEP FLEXIBLE (§17), DERIVED FROM THE PLAN'S OWN EVIDENCE.
 *
 * Nothing is invented for this list: a stop appears because the plan itself
 * records a reason to hold it loosely — the weather bears on it, its details
 * change without notice, or somebody still has to book it. A plan with nothing
 * volatile in it renders no section, which is the honest empty state.
 */
function KeepFlexible({ itinerary }: { itinerary: Itinerary }) {
  const entries: { key: string; name: string; day: number; why: string }[] = [];
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      const why = item.weatherSensitive
        ? 'the weather on that day works against it — have the backup in mind'
        : item.verifyBeforeTravel
          ? `check before travel: ${item.verifyBeforeTravel}`
          : item.booking
            ? 'it needs a booking you have to make yourself'
            : null;
      if (!why) continue;
      entries.push({
        key: `${day.dayNumber}-${item.placeId}`,
        name: item.title,
        day: day.dayNumber,
        why,
      });
    }
  }
  if (entries.length === 0) return null;

  return (
    <section className="mt-14 border-t border-rule pt-8">
      <h2 className="font-display text-xl text-ink">Keep these flexible</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Each of these carries something the plan cannot promise — weather, unverified details, or
        a booking still in your hands. Hold them loosely and the trip bends instead of breaking.
      </p>
      <ul className="mt-4 space-y-2">
        {entries.map((entry) => (
          <li key={entry.key} className="text-sm">
            <span className="font-medium text-ink">{entry.name}</span>
            <span className="text-ink-faint"> · day {entry.day} — </span>
            <span className="text-ink-muted">{entry.why}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * BEFORE YOU GO.
 *
 * High on the page, above the days, because everything in it has a deadline that
 * the days do not: a permit sold out, a ticket that has to be bought online, a
 * phone call that is free today and impossible on the morning.
 *
 * Grouped by what the traveller has to *do* rather than by which place it came
 * from — somebody packing a bag wants one list of things to bring, not four
 * lists of one thing each. Every line carries how well established it is and,
 * where it exists, the page to do it on. Nothing here is generated prose: each
 * item is a sentence a source published or a statement that nobody published
 * one.
 */
function BeforeYouGo({ items }: { items: readonly PreparationItem[] }) {
  if (items.length === 0) return null;
  const groups = groupPreparation(items);

  return (
    <section
      aria-labelledby="before-you-go"
      data-testid="before-you-go"
      className="mt-8"
    >
      <Panel className="p-5">
        <h2 id="before-you-go" className="font-display text-xl text-ink">
          Before you go
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {items.length} {items.length === 1 ? 'thing' : 'things'} worth doing while you still can,
          taken from what the places themselves publish.
        </p>

        <div className="mt-5 space-y-6">
          {groups.map((group) => (
            <div key={group.kind}>
              <h3 className="text-sm font-medium text-ink">
                {PREPARATION_KIND_COPY[group.kind].title}
              </h3>
              <p className="mt-0.5 text-xs text-ink-faint">
                {PREPARATION_KIND_COPY[group.kind].blurb}
              </p>
              <ul className="mt-2.5 space-y-2">
                {group.items.map((item, index) => (
                  <li key={`${item.subjectId}-${index}`} className="text-sm leading-relaxed">
                    <span className="font-medium text-ink">{item.subjectName}</span>
                    <span className="text-ink-muted"> — {item.text}</span>
                    {item.url ? (
                      <>
                        {' '}
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer nofollow"
                          className="underline underline-offset-2 hover:text-ink"
                        >
                          official page
                        </a>
                      </>
                    ) : null}
                    {item.confidence ? (
                      <span className="ml-1 text-xs text-ink-faint">({item.confidence})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}
