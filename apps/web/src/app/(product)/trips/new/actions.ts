'use server';

import { z } from 'zod';
import {
  ARRIVAL_PLANNING_MINUTES,
  ARRIVAL_PRECISIONS,
  BUDGET_BANDS,
  DATE_MODES,
  DEPARTURE_PLANNING_MINUTES,
  TRANSPORT_INTENTS,
  TRAVELER_NEEDS,
  TRIP_COMPOSER_VERSION,
  TRIP_SHAPES,
  TRIP_THEMES,
  buildDestinationIntent,
  qualifiedNameFor,
  seasonMonths,
  tripBasicsSchema,
  type SelectedDestination,
  type TripComposerAnswers,
} from '@sidequest/core';
import { classifyPreferences } from '@sidequest/core';
import { resolveRegion } from '@sidequest/core/data';
import { revalidatePath } from 'next/cache';
import { clearItinerary, createTrip, getTrip, updateTripBasics } from '@/lib/db/repository';
import {
  getActiveJob,
  getIntent,
  invalidateDependentStages,
  saveComposerAnswers,
  saveDestinationIntent,
  saveDestinationQuery,
  saveSelectedDestination,
} from '@/lib/db/compiler-repository';
import { destinationEntryById, destinationIndexRelease } from '@/lib/db/destination-index-repository';
import { DYNAMIC_REGION_ID } from '@/lib/region';
import { guardAction, sessionToken } from '@/lib/net/caller';
import { currentUserId } from '@/lib/auth/session';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * TURNING A COMPOSER INTO A TRIP.
 *
 * Three things happen here and the order matters:
 *
 * 1. **The composer answers are validated and stored whole.** They are the
 *    durable record of what the traveller said, and every later screen reads
 *    them rather than re-deriving from the trip row — which only holds the
 *    subset the old schema had columns for.
 * 2. **A selected index row becomes a `SelectedDestination`.** That is the
 *    signal the plan flow turns on: a destination somebody pointed at needs no
 *    resolution request, no interpretation screen and no confirmation click.
 * 3. **Dates that do not exist are materialised, and marked as materialised.**
 *    A trip row needs two dates because everything downstream is built on a
 *    calendar. Somebody who said "some time in July" has not given us two, so we
 *    take the month's midpoint — and the composer keeps `mode: 'month'`, so no
 *    screen can present that placeholder as a decision they made.
 */

export interface ComposerResult {
  ok: boolean;
  href: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

const inputSchema = z.object({
  destinationText: z.string().trim().min(2, 'Tell us where you are going'),
  destinationEntryId: z.string().nullable(),
  dateMode: z.enum(DATE_MODES),
  startDate: z.string(),
  endDate: z.string(),
  flexDays: z.number().int().min(0).max(14),
  month: z.number().int().min(1).max(12),
  /* MVP V3 — the timing modes that need no date from the traveller. */
  months: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  earliest: z.string().nullable().optional(),
  latest: z.string().nullable().optional(),
  recommendation: z
    .object({
      startDate: z.string(),
      endDate: z.string(),
      label: z.string().max(80),
      month: z.number().int().min(1).max(12),
      year: z.number().int().min(2000).max(2100),
      reasons: z.array(z.string().max(200)).max(6),
      tradeoffs: z.array(z.string().max(200)).max(6),
    })
    .nullable()
    .optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']),
  wantsDateRecommendation: z.boolean(),
  wantsLengthRecommendation: z.boolean(),
  nights: z.number().int().min(1).max(30).nullable(),
  arrivalPrecision: z.enum(ARRIVAL_PRECISIONS),
  departurePrecision: z.enum(ARRIVAL_PRECISIONS),
  adults: z.number().int().min(1).max(12),
  children: z.number().int().min(0).max(12),
  travelerNeeds: z.array(z.enum(TRAVELER_NEEDS)),
  mustDo: z.string().max(600),
  avoid: z.string().max(600),
  existingPlan: z.string().max(2000).optional(),
  origin: z.string().max(120),
  /*
   * QUALITY V1 — the composer form no longer asks these; the interview does.
   * Accepted when a caller still sends them (the labs benchmark adapter and
   * older clients) so a stored answer keeps its meaning, never required.
   */
  shape: z.enum(TRIP_SHAPES).nullable().optional(),
  pace: z.enum(['slow', 'balanced', 'packed']).nullable().optional(),
  transport: z.enum(TRANSPORT_INTENTS).nullable().optional(),
  budget: z.enum(BUDGET_BANDS).nullable().optional(),
  themes: z.array(z.enum(TRIP_THEMES)).optional(),
  crowdTolerance: z.enum(['avoid', 'tolerate', 'unbothered']).nullable().optional(),
  outdoorIntensity: z.enum(['gentle', 'moderate', 'strenuous']).nullable().optional(),
  foodImportance: z.enum(['fuel', 'matters', 'central']).nullable().optional(),
  freeTime: z.enum(['packed', 'balanced', 'lots']).nullable().optional(),
});

export type ComposerInput = z.input<typeof inputSchema>;

/** Nights to assume when the traveller has not decided and has not been advised. */
const PLACEHOLDER_NIGHTS = 6;

/**
 * WHAT THE COMPOSER MEANS, INDEPENDENT OF WHETHER IT IS A NEW TRIP.
 *
 * Extracted so that *editing* a trip and *creating* one cannot drift apart.
 * Before this, there was no edit path at all: every "Change the trip" control
 * in the product linked to a blank composer, so correcting a single answer
 * meant losing the destination, the dates, the party, the must-dos, the
 * questionnaire and any research already paid for. The obvious way to add an
 * edit route is to write a second version of the interpretation below, and the
 * obvious consequence of that is two screens that disagree about what an answer
 * means. One reading, two callers.
 */
type ComposerReading =
  | { ok: false; fieldErrors: Record<string, string> }
  | {
      ok: true;
      input: z.infer<typeof inputSchema>;
      answers: TripComposerAnswers;
      destination: SelectedDestination | null;
      region: ReturnType<typeof resolveRegion>;
      basics: z.infer<typeof tripBasicsSchema>;
    };

function readComposer(raw: ComposerInput, now: Date): ComposerReading {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }
  const input = parsed.data;

  /*
   * The identity, when there is one.
   *
   * Read back from the index rather than trusted from the client: the browser
   * sends an id, and an id somebody made up must not become a destination. This
   * is the only place a `SelectedDestination` is minted.
   */
  let destination: SelectedDestination | null = null;
  if (input.destinationEntryId) {
    const entry = destinationEntryById(input.destinationEntryId);
    if (entry) {
      destination = {
        entryId: entry.id,
        catalog: entry.catalog,
        sourceId: entry.sourceId,
        /*
         * The release the row was actually read from.
         *
         * This was the literal `'pinned'`, which is a provenance claim we cannot
         * support: it says an identity came from a specific catalogue release
         * without naming one, so two trips created a release apart were
         * indistinguishable. `'unknown'` when the index has no release row is the
         * honest fallback — an index nobody built has no release to name.
         */
        releaseId: destinationIndexRelease()?.releaseId ?? 'unknown',
        displayName: entry.displayName,
        ...(entry.localName ? { localName: entry.localName } : {}),
        qualifiedName: qualifiedNameFor(entry),
        featureType: entry.featureType,
        center: entry.center,
        ...(entry.bounds ? { bounds: entry.bounds } : {}),
        ...(entry.countryCode ? { countryCode: entry.countryCode } : {}),
        ...(entry.regionCode ? { regionCode: entry.regionCode } : {}),
        aliases: [...entry.aliases],
        hierarchy: entry.hierarchy,
        selectedAt: now.toISOString(),
      };
    }
  }

  const nights = resolveNights(input);
  const { startDate, endDate } = materialiseDates(input, nights, now, destination?.center.lat ?? null);

  const answers: TripComposerAnswers = {
    schemaVersion: TRIP_COMPOSER_VERSION,
    mode: 'known_destination',
    // Nobody has decided anything about a named must-do yet, and an empty list
    // says that. It is not the same as the field being absent.
    mustDoDecisions: [],
    ...(destination ? { destination } : {}),
    destinationQuery: input.destinationText,
    dates: {
      mode: input.dateMode,
      ...(input.dateMode === 'exact' || input.dateMode === 'flexible'
        ? { startDate: input.startDate, endDate: input.endDate }
        : { startDate, endDate }),
      ...(input.dateMode === 'flexible' ? { flexDays: input.flexDays } : {}),
      ...(input.dateMode === 'month' ? { month: input.month } : {}),
      ...(input.dateMode === 'months' && input.months?.length ? { months: input.months } : {}),
      ...(input.dateMode === 'window' && input.earliest ? { earliest: input.earliest } : {}),
      ...(input.dateMode === 'window' && input.latest ? { latest: input.latest } : {}),
      ...(input.dateMode === 'season' ? { season: input.season } : {}),
      /*
       * MVP V3 — a window Sidequest chose is recorded with the evidence behind
       * it, so every later screen can say the dates were proposed rather than
       * decided. `accepted` is true here because this payload is only written
       * once the traveller has pressed "Use this timing".
       */
      ...(input.recommendation
        ? {
            recommendation: {
              ...input.recommendation,
              unknowns: [],
              basis: 'climate_normals' as const,
              generatedAt: now.toISOString(),
              accepted: true,
              decidedBy: 'traveller' as const,
            },
          }
        : {}),
      year: Number(startDate.slice(0, 4)),
      wantsRecommendation: input.wantsDateRecommendation,
    },
    duration: {
      mode: input.nights !== null ? 'fixed' : 'unknown',
      ...(input.nights !== null ? { nights: input.nights } : {}),
      wantsRecommendation: input.wantsLengthRecommendation,
    },
    arrival: { precision: input.arrivalPrecision },
    departure: { precision: input.departurePrecision },
    ...(input.origin ? { origin: input.origin } : {}),
    adults: input.adults,
    children: input.children,
    travelerNeeds: input.travelerNeeds,
    ...(input.shape ? { shape: input.shape } : {}),
    ...(input.pace ? { pace: input.pace } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    themes: input.themes ?? [],
    ...(input.outdoorIntensity ? { outdoorIntensity: input.outdoorIntensity } : {}),
    ...(input.crowdTolerance ? { crowdTolerance: input.crowdTolerance } : {}),
    ...(input.foodImportance ? { foodImportance: input.foodImportance } : {}),
    ...(input.freeTime ? { freeTime: input.freeTime } : {}),
    ...(input.mustDo ? { mustDo: input.mustDo } : {}),
    ...(input.avoid ? { avoid: input.avoid } : {}),
    ...(input.existingPlan?.trim() ? { existingPlan: input.existingPlan.trim() } : {}),
    /*
     * What we made of that text, proposed and unconfirmed.
     *
     * Classified here rather than later because it is free, deterministic and
     * offline — a table lookup over the traveller's own words, with no model and
     * no network. `confirmedAt` is deliberately absent, so it changes nothing
     * anywhere until somebody accepts it on the next screen.
     *
     * **The deterministic pass runs here and the bounded model fallback does
     * not.** Creating a trip must stay free and instant, and the ordering the
     * fallback depends on — parse first, then the leftovers only — is only
     * possible because this runs to completion before anything else looks at the
     * text. The one reading of whatever the table could not resolve is offered
     * on the next screen, as a button somebody presses; see
     * `readUnresolvedTextAction`. A trip created here has `modelPass` absent,
     * which is exactly "nobody has asked".
     *
     * **The avoid box supplies a direction, not a refusal.** Somebody typing
     * "early starts" under "anything you would rather not do" gets a `dislike`,
     * which lowers what the board offers; only an explicit marker in their own
     * characters — "no early starts" — reaches `hard_avoid`, which removes a
     * category outright. The parser used to synthesise the word "no" onto every
     * clause from this box and then read it back as an explicit refusal, so this
     * one field turned every entry into a hard blocker.
     */
    ...(input.mustDo || input.avoid
      ? {
          interpretation: classifyPreferences({
            ...(input.mustDo ? { mustDo: input.mustDo } : {}),
            ...(input.avoid ? { avoid: input.avoid } : {}),
          }),
        }
      : {}),
    skipped: [],
    updatedAt: now.toISOString(),
  };

  /*
   * The authored region keeps its own door.
   *
   * A string naming a region we already hold in full goes straight to the
   * questionnaire against authored data, exactly as it always has. Everything
   * else goes through the compiler. Preserving this is what keeps every Eastern
   * Sierra journey, fixture and test green through this phase.
   */
  const region = resolveRegion(input.destinationText, { center: destination?.center ?? null });

  const basics = tripBasicsSchema.safeParse({
    mode: 'known_destination',
    destinationInput: destination?.displayName ?? input.destinationText,
    regionId: region?.id ?? DYNAMIC_REGION_ID,
    startDate,
    endDate,
    /*
     * §7 — THE ALLOWANCE AND THE PRECISION TRAVEL TOGETHER.
     *
     * These two times are the minute planning may assume, and for an unknown
     * edge that is still `15:00` / `11:00` — a reasonable arrival to design a
     * first day around. What changed is that the precision travels beside them,
     * so no surface can print them as a fact the traveller stated. Removing the
     * allowance instead would leave day one with no shape at all, which is a
     * worse answer to the same problem.
     */
    arrivalTime: planningTime(input.arrivalPrecision, ARRIVAL_PLANNING_MINUTES, '15:00'),
    departureTime: planningTime(input.departurePrecision, DEPARTURE_PLANNING_MINUTES, '11:00'),
    arrivalPrecision: input.arrivalPrecision,
    departurePrecision: input.departurePrecision,
    adults: input.adults,
    children: input.children,
    travelerNeeds: input.travelerNeeds,
    /*
     * V6 — THE LOCK IS WRITTEN WITH THE DATES.
     *
     * Typed dates and an accepted window are the traveller's decision and
     * travel as `traveler`. Every other mode leaves the two dates above as a
     * placeholder with no lock, which is what tells the composition to choose.
     */
    ...(timingLockFor(input) ? { timingLock: timingLockFor(input) } : {}),
  });
  if (!basics.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of basics.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }

  return { ok: true, input, answers, destination, region, basics: basics.data };
}

export async function createTripFromComposer(raw: ComposerInput): Promise<ComposerResult> {
  const reading = readComposer(raw, new Date());
  if (!reading.ok) return { ok: false, href: '', fieldErrors: reading.fieldErrors };
  const { input, answers, destination, region, basics } = reading;

  /**
   * THE FENCE IN FRONT OF THE ROW, NOT JUST IN FRONT OF THE SPEND.
   *
   * This was the one anonymous write loop outside the rate fences: every call
   * writes a trips row plus composer answers and returns a redirect, nothing
   * refuses at any layer, and nothing ever sweeps trips — a live database was
   * already carrying dozens of ownerless rows no guard will ever list or
   * delete. `decide_start` was fenced for exactly this shape ("two hundred
   * POSTs were two hundred rows"); the trips surface now draws from the same
   * machinery.
   *
   * After validation on purpose: a person correcting form errors resubmits,
   * and a refused *invalid* payload writes nothing anyway — the token is spent
   * where the row would be written.
   */
  const refusal = await guardAction('trip_create');
  if (refusal) return { ok: false, href: '', error: refusal };

  let tripId: string;
  try {
    /*
     * Stamped with the browser that made it, which is the only thing standing
     * between this deployment and a homepage that lists strangers' trips as
     * "your trips". Minted here if there is none yet: an action may set a
     * cookie, and this is the first moment there is anything to own.
     */
    tripId = createTrip(basics, await sessionToken({ mint: true }), await currentUserId()).id;
    saveComposerAnswers(tripId, answers);
    if (!region) {
      saveDestinationQuery(tripId, 'known_destination', input.destinationText);
      saveSelectedDestination(tripId, destination);
      /*
       * MVP V3 — what they meant, recorded once and for the life of the trip.
       * Built from the text alone when that is all there is, which is the
       * ordinary case now that a suggestion is optional. Nothing downstream
       * waits on a resolver to have run.
       */
      saveDestinationIntent(
        tripId,
        buildDestinationIntent({ rawText: input.destinationText, selected: destination, now: new Date() }),
      );
    }
  } catch (error) {
    console.error('Failed to create trip', error);
    return { ok: false, href: '', error: 'We could not save that trip. Nothing was lost — try again.' };
  }

  return {
    ok: true,
    href: region ? `/trips/${tripId}/questionnaire` : `/trips/${tripId}/plan`,
  };
}

/**
 * EDIT AN EXISTING TRIP, INVALIDATING ONLY WHAT THE EDIT ACTUALLY BROKE.
 *
 * The counterpart to `createTripFromComposer`, and the route every "Change the
 * trip" control now points at. Two properties matter more than anything else
 * here:
 *
 * **It never creates a second trip.** The old escape hatch was a link to a
 * blank composer, which produced an orphan trip beside the one the traveller
 * was trying to fix and left the original in whatever broken state sent them
 * looking for the exit.
 *
 * **It invalidates by dependency, not by fear.** `invalidateDependentStages`
 * drops the region reading only when the dates moved, drops the scope only when
 * something the scope was derived from moved, and drops everything geographic
 * only when the destination itself changed. Questionnaire answers, must-do
 * decisions and board selections survive all three, because none of those edits
 * can make a statement about the traveller untrue.
 */
export async function updateTripFromComposer(
  tripId: string,
  raw: ComposerInput,
): Promise<ComposerResult> {
  const existingTrip = getTrip(tripId);
  const existing = getIntent(tripId);
  if (!existingTrip) return { ok: false, href: '', error: 'We could not find that trip.' };
  /*
   * Only the browser that made a trip may rewrite it — the same boundary the
   * delete and share doors hold. See `lib/net/trip-access`.
   */
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, href: '', error: refusal };

  /**
   * NOT WHILE A BUILD IS RUNNING.
   *
   * A compilation started before the edit keeps going, and `completeJob` writes
   * `selected_compiled_region_id` unconditionally when it lands. So editing
   * mid-build produced the worst possible outcome: the invalidation cleared the
   * pointer, the job finished a few seconds later and put it straight back, and
   * the traveller arrived on a finished screen holding a region compiled for
   * the answers they had just changed — with nothing anywhere saying so.
   *
   * Refused rather than raced. Cancelling is already a control on the build
   * screen, so the traveller has a way through that does not depend on us
   * getting a compare-and-set right under a rewrite of the very row the job
   * keys on.
   */
  if (getActiveJob(tripId)) {
    return {
      ok: false,
      href: '',
      error:
        'That trip is being built right now. Stop the build first — then you can change anything you like and start it again.',
    };
  }

  const reading = readComposer(raw, new Date());
  if (!reading.ok) return { ok: false, href: '', fieldErrors: reading.fieldErrors };
  const { input, answers, destination, region, basics } = reading;

  const before = existing?.composer ?? undefined;
  /*
   * Compared on the *resolved* identity where there is one and on the typed
   * string otherwise, because those are the two things that decide which ground
   * gets compiled. Comparing the free-text box alone would miss somebody
   * switching between two index rows whose names differ only by a suffix.
   */
  const destinationChanged =
    (before?.destination?.entryId ?? before?.destinationQuery ?? '') !==
    (destination?.entryId ?? input.destinationText);
  const datesChanged =
    before === undefined ||
    before.dates.mode !== answers.dates.mode ||
    before.dates.startDate !== answers.dates.startDate ||
    before.dates.endDate !== answers.dates.endDate ||
    before.duration.nights !== answers.duration.nights;
  const scopeInputsChanged =
    before === undefined ||
    before.transport !== answers.transport ||
    before.shape !== answers.shape ||
    before.adults !== answers.adults ||
    before.children !== answers.children ||
    before.travelerNeeds.join(',') !== answers.travelerNeeds.join(',');

  try {
    /*
     * The must-do decisions the traveller has already made are carried across
     * rather than reset. They are answers about their own trip, and an edit to
     * the dates is not a reason to ask them again about a place they already
     * withdrew.
     */
    saveComposerAnswers(tripId, {
      ...answers,
      /*
       * Decisions about places survive an edit — unless the edit changed which
       * places there are. A withdrawal of something in the destination they
       * just abandoned is not an answer about the new one, and carrying it
       * across would silently suppress a place in a region the traveller has
       * never seen.
       */
      mustDoDecisions: destinationChanged ? answers.mustDoDecisions : (before?.mustDoDecisions ?? []),
    });
    updateTripBasics(tripId, basics);
    if (!region) {
      saveDestinationQuery(tripId, 'known_destination', input.destinationText);
      saveSelectedDestination(tripId, destination);
      /*
       * MVP V3 — what they meant, recorded once and for the life of the trip.
       * Built from the text alone when that is all there is, which is the
       * ordinary case now that a suggestion is optional. Nothing downstream
       * waits on a resolver to have run.
       */
      saveDestinationIntent(
        tripId,
        buildDestinationIntent({ rawText: input.destinationText, selected: destination, now: new Date() }),
      );
    }
    invalidateDependentStages(tripId, {
      destinationChanged,
      datesChanged,
      scopeInputsChanged,
    });

    /**
     * AN ITINERARY IS A FUNCTION OF THE ANSWERS IT WAS BUILT FROM.
     *
     * The repository says so in as many words, and the edit path was the one
     * caller that did not honour it: `getItinerary` rejects only on schema
     * version, so moving the dates by a week left the plan rendering its old
     * day dates under a trip that now says something else. A plan that
     * contradicts the trip it belongs to is worse than no plan, because the
     * traveller has no way to tell which of the two is current.
     *
     * Cleared only when something the plan actually depends on moved. A
     * traveller correcting a typo in their must-do text keeps their itinerary.
     */
    if (destinationChanged || datesChanged || scopeInputsChanged) {
      clearItinerary(tripId);
    }
  } catch (error) {
    console.error('Failed to update trip', error);
    return {
      ok: false,
      href: '',
      error: 'We could not save that change. Nothing was lost — try again.',
    };
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return {
    ok: true,
    href: region ? `/trips/${tripId}/questionnaire` : `/trips/${tripId}/plan`,
  };
}

function resolveNights(input: z.infer<typeof inputSchema>): number {
  if (input.nights !== null) return input.nights;
  if (input.recommendation) {
    const from = Date.parse(`${input.recommendation.startDate}T00:00:00Z`);
    const to = Date.parse(`${input.recommendation.endDate}T00:00:00Z`);
    if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) return Math.round((to - from) / 86_400_000);
  }
  if (input.dateMode === 'exact' || input.dateMode === 'flexible') {
    const from = Date.parse(`${input.startDate}T00:00:00Z`);
    const to = Date.parse(`${input.endDate}T00:00:00Z`);
    if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) {
      return Math.round((to - from) / 86_400_000);
    }
  }
  return PLACEHOLDER_NIGHTS;
}

/**
 * Two calendar dates, whatever the traveller actually gave us.
 *
 * The trip row needs them because every downstream layer — hours, weather,
 * seasonal access — is keyed on a date. The important part is that the composer
 * *keeps its own mode*, so a screen showing "some time in July" reads that from
 * `dates.mode` rather than from these two values. Nothing may present a
 * materialised date as a decision.
 */
/**
 * V6 — who has decided the dates at this door, if anyone.
 *
 * `exact` and `flexible` carry dates the traveller typed. A `recommendation`
 * in the payload exists only because they pressed "Use this timing". Both are
 * theirs. Everything else is a placeholder that the composition is asked to
 * replace, and must not be locked — locking it would silently make October
 * the answer to "when is best".
 */
function timingLockFor(input: z.infer<typeof inputSchema>): 'traveler' | null {
  if ((input.dateMode === 'exact' || input.dateMode === 'flexible') && input.startDate && input.endDate) return 'traveler';
  if (input.recommendation) return 'traveler';
  return null;
}

function materialiseDates(
  input: z.infer<typeof inputSchema>,
  nights: number,
  now: Date,
  /**
   * The resolved destination's latitude, where one is known.
   *
   * A season is not a month until you know which half of the planet it is in.
   * Without this the table below sent every "summer" trip to July — which is
   * deep winter for a southern-hemisphere destination, so the board then
   * reported half the region shut on the traveller's dates as though that were a
   * property of the place rather than of our arithmetic.
   */
  latitude: number | null,
): { startDate: string; endDate: string } {
  if ((input.dateMode === 'exact' || input.dateMode === 'flexible') && input.startDate && input.endDate) {
    return { startDate: input.startDate, endDate: input.endDate };
  }
  /*
   * A window the traveller accepted is not a materialised placeholder — it is
   * the answer to the question they asked. It wins over every rule below.
   */
  if (input.recommendation) {
    return { startDate: input.recommendation.startDate, endDate: input.recommendation.endDate };
  }

  const year = now.getUTCFullYear();
  const month =
    input.dateMode === 'month'
      ? input.month
      : input.dateMode === 'months' && input.months?.length
        ? input.months[0]!
        : input.dateMode === 'window' && input.earliest
          ? Number(input.earliest.slice(5, 7))
          : input.dateMode === 'season'
            ? seasonMidpoint(input.season, latitude)
            : now.getUTCMonth() + 2;

  // Next year when the month has already gone: a trip cannot start in the past.
  const targetYear = month <= now.getUTCMonth() + 1 ? year + 1 : year;
  const daysInMonth = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const startDay = Math.max(1, Math.min(daysInMonth - nights, Math.round((daysInMonth - nights) / 2)));
  const start = new Date(Date.UTC(targetYear, month - 1, startDay));
  const end = new Date(start.getTime() + nights * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/**
 * THE MIDDLE MONTH OF A SEASON, WHERE THAT SEASON ACTUALLY HAPPENS.
 *
 * `seasonMonths` in core is the one place that knows a season is a function of
 * latitude: it flips the northern months for a southern destination and returns
 * all twelve near the equator, where the word does not pick out a period at all.
 * This reads the middle of what it returns.
 *
 * With no destination resolved yet — a typed query the geocoder has not answered
 * — there is no hemisphere to reason with, and the northern reading is the
 * assumption of last resort rather than a fact. Nothing downstream is stuck with
 * it: the dates are editable and the preflight re-reads them.
 */
const NORTHERN_MIDPOINT: Record<'spring' | 'summer' | 'autumn' | 'winter', number> = {
  spring: 4,
  summer: 7,
  autumn: 10,
  winter: 1,
};

function seasonMidpoint(
  season: 'spring' | 'summer' | 'autumn' | 'winter',
  latitude: number | null,
): number {
  if (latitude === null) return NORTHERN_MIDPOINT[season];
  const months = seasonMonths(season, latitude);
  /*
   * Twelve months back means the tropics, where "summer" does not name a period
   * anybody plans around. Falling back to the northern midpoint there would be
   * inventing a season; the middle of the year is an arbitrary choice openly
   * made rather than a claim about the climate.
   */
  if (months.length === 0 || months.length === 12) return NORTHERN_MIDPOINT[season];
  return months[Math.floor(months.length / 2)] ?? NORTHERN_MIDPOINT[season];
}

function planningTime(
  precision: (typeof ARRIVAL_PRECISIONS)[number],
  table: Record<string, number | null>,
  fallback: string,
): string {
  const minutes = table[precision];
  if (minutes === null || minutes === undefined) return fallback;
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const rest = String(minutes % 60).padStart(2, '0');
  return `${hours}:${rest}`;
}
