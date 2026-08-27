'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  ARRIVAL_PLANNING_MINUTES,
  DEPARTURE_PLANNING_MINUTES,
  TRIP_COMPOSER_VERSION,
  datesInWindow,
  emptyComposerAnswers,
  qualifiedNameFor,
  seasonMonths,
  tripBasicsSchema,
  type DestinationShortlist,
  type ImageSubject,
  type SelectedDestination,
  type TripComposerAnswers,
} from '@sidequest/core';
import {
  createDecisionSession,
  getDecisionSession,
  resolveDecisionSession,
  saveDecisionAnswers,
  saveDecisionShortlist,
} from '@/lib/db/decision-repository';
import { destinationEntryById, destinationIndexRelease } from '@/lib/db/destination-index-repository';
import { createTrip } from '@/lib/db/repository';
import { guardAction, sessionToken } from '@/lib/net/caller';
import { decisionAccessRefusal } from '@/lib/net/decision-access';
import { saveComposerAnswers, saveDestinationQuery, saveSelectedDestination } from '@/lib/db/compiler-repository';
import { recommendDestinations } from '@/lib/destinations/recommend';
import { DYNAMIC_REGION_ID } from '@/lib/region';
import { imageryCache } from '@/lib/db/imagery-repository';
import { resolveImageryForSubjects } from '@/lib/providers/wikimedia';

/**
 * THE ACTIONS BEHIND "HELP ME DECIDE".
 *
 * Every one writes before it returns, because the durable artifact is the row.
 * The whole point of a decision session is that somebody can answer three
 * questions, close the laptop, and come back to the same three answers.
 *
 * Two rules the file exists to hold:
 *
 * **The ranking never sees a model.** `recommendDestinations` reads the index,
 * the climate archive and arithmetic. A model may not add a destination, remove
 * one, or change an order — and the simplest way to guarantee that is for there
 * to be no model call on this path at all.
 *
 * **Choosing a destination produces an ordinary trip.** Not a special one, not a
 * flagged one: the same `TripComposerAnswers` the typed-destination path writes,
 * against the same tables, landing on the same preflight screen. A decision that
 * produced a second-class trip would be a second product.
 */

const answersSchema = z.object({
  dateMode: z.enum(['exact', 'flexible', 'month', 'season', 'undecided']),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  month: z.number().int().min(1).max(12).optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).optional(),
  nights: z.number().int().min(1).max(30).nullable(),
  shape: z.enum(['one_base', 'two_bases', 'circuit', 'undecided']).nullable(),
  transport: z.enum(['drive', 'public_transport', 'mixed', 'undecided']).nullable(),
  pace: z.enum(['slow', 'balanced', 'packed']).nullable(),
  themes: z.array(z.string().min(1)).max(12),
  outdoorIntensity: z.enum(['gentle', 'moderate', 'strenuous']).nullable(),
  budget: z.enum(['budget', 'mid_range', 'premium', 'luxury', 'unstated']).nullable(),
  adults: z.number().int().min(1).max(12),
  children: z.number().int().min(0).max(12),
  avoid: z.string().max(600),
});

export type DecisionAnswersInput = z.infer<typeof answersSchema>;

export interface DecisionResult {
  ok: boolean;
  error?: string;
}

function toComposerAnswers(input: DecisionAnswersInput, now: Date): TripComposerAnswers {
  const base = emptyComposerAnswers('help_me_decide', now);
  /*
   * Themes are validated against the enum here rather than in the input schema,
   * so a value the browser invented is dropped rather than rejecting the whole
   * submission — losing one checkbox is better than losing four screens of
   * answers to a client that sent one bad string.
   */
  const themes = input.themes.filter((theme): theme is TripComposerAnswers['themes'][number] =>
    THEME_VALUES.has(theme),
  );
  return {
    ...base,
    schemaVersion: TRIP_COMPOSER_VERSION,
    dates: {
      mode: input.dateMode,
      ...(input.startDate ? { startDate: input.startDate } : {}),
      ...(input.endDate ? { endDate: input.endDate } : {}),
      ...(input.month ? { month: input.month } : {}),
      ...(input.season ? { season: input.season } : {}),
      year: now.getUTCFullYear(),
      wantsRecommendation: false,
    },
    duration: {
      mode: input.nights === null ? 'unknown' : 'fixed',
      ...(input.nights === null ? {} : { nights: input.nights }),
      wantsRecommendation: input.nights === null,
    },
    adults: input.adults,
    children: input.children,
    ...(input.shape ? { shape: input.shape } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.pace ? { pace: input.pace } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.outdoorIntensity ? { outdoorIntensity: input.outdoorIntensity } : {}),
    themes,
    ...(input.avoid.trim() ? { avoid: input.avoid.trim() } : {}),
    updatedAt: now.toISOString(),
  };
}

const THEME_VALUES = new Set([
  'outdoors',
  'mountains',
  'water',
  'wildlife',
  'food',
  'culture',
  'cities',
  'quiet',
]);

/**
 * Start a session and go to it. The id in the URL is what makes a refresh free.
 *
 * Two guards before the row exists, both absent for one release:
 *
 * - **The rate fence.** This action writes a row per call and sat outside
 *   every fence; two hundred scripted POSTs were two hundred rows with no
 *   refusal at any layer. `decide_start` is a row in the same table every
 *   other guarded action uses.
 * - **The owner stamp.** Minted from the same cookie `createTrip` uses, so the
 *   session belongs to the browser that started it — see
 *   `lib/net/decision-access` for what happens when a different one arrives.
 *
 * Returns a result instead of `never` because a refusal has to reach the
 * screen; on success the redirect throws and nothing is returned.
 */
export async function startDecisionAction(input: DecisionAnswersInput): Promise<DecisionResult> {
  const limited = await guardAction('decide_start');
  if (limited) return { ok: false, error: limited };

  const parsed = answersSchema.parse(input);
  const owner = await sessionToken({ mint: true });
  const id = createDecisionSession(toComposerAnswers(parsed, new Date()), owner, new Date());
  redirect(`/decide/${id}`);
}

export async function saveDecisionAnswersAction(
  id: string,
  input: DecisionAnswersInput,
): Promise<DecisionResult> {
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const session = getDecisionSession(id);
  if (!session) return { ok: false, error: 'We could not find that.' };
  if (session.resolvedTripId) {
    return { ok: false, error: 'You have already picked a destination for this one.' };
  }

  const parsed = answersSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Some of those answers did not make sense.' };

  saveDecisionAnswers(id, toComposerAnswers(parsed.data, new Date()), new Date());
  revalidatePath(`/decide/${id}`);
  return { ok: true };
}

/**
 * Rank the world against these answers, and store the result.
 *
 * Awaited rather than backgrounded like a compilation, because the budget here
 * is seconds rather than minutes: everything except a dozen climate lookups is a
 * local table read and arithmetic, and a job row for five seconds of work would
 * be machinery nobody needs.
 */
export async function buildShortlistAction(id: string): Promise<DecisionResult> {
  /*
   * Ownership first, then the fence. A stranger's press must read as a missing
   * session before it can learn anything — including whether the deployment is
   * busy — and must not drain the owner's bucket while doing it.
   */
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const limited = await guardAction('decide_shortlist');
  if (limited) return { ok: false, error: limited };

  const session = getDecisionSession(id);
  if (!session) return { ok: false, error: 'We could not find that.' };

  try {
    const shortlist = await recommendDestinations({ answers: session.answers, now: new Date() });
    saveDecisionShortlist(id, shortlist, new Date());
  } catch (error) {
    console.error('Shortlist failed', { id, error });
    return { ok: false, error: 'We could not put a list together just then. Nothing was lost — try again.' };
  }

  /**
   * THE RANKING RETURNS THE MOMENT IT EXISTS.
   *
   * This used to `await resolveShortlistImagery(shortlist)` before returning —
   * eight sequential requests to a volunteer-run image service, deliberately
   * unparallelised out of API etiquette. The ranking was already durable on
   * disk; the caller was blocked on the pictures. A live run recorded the
   * shortlist written at 18:01:33 and the screen still reading "Working out
   * where you should go" twenty-five seconds later, because the action had not
   * returned and nothing told the page to look again.
   *
   * The photographs are the least important thing on that screen and every card
   * has a designed coordinate-derived graphic without them. So they are a
   * second, separate action, triggered by the page once the list is on screen —
   * see `resolveShortlistImageryAction` and the component that calls it.
   */
  revalidatePath(`/decide/${id}`);
  return { ok: true };
}

/**
 * Resolve the photographs for a shortlist that already exists.
 *
 * Split out of `buildShortlistAction` so that ranking and imagery fail, retry
 * and — most importantly — *finish* independently. It reads the stored
 * shortlist rather than taking one as an argument, because the browser must not
 * be able to name the subjects an image lookup is performed for.
 *
 * Idempotent by construction: the imagery cache writes both acceptances and
 * refusals through to the table, so calling this again after every subject has
 * an answer performs no requests at all.
 */
export async function resolveShortlistImageryAction(id: string): Promise<DecisionResult> {
  /*
   * The same two guards as the ranking, from the same bucket — the imagery
   * pass is the half of the button press that reaches a volunteer-run
   * service. A rate refusal is returned without a sentence on purpose: the
   * page treats a false result as "no pictures yet", which is the correct
   * traveller experience for both failure and throttling.
   */
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const limited = await guardAction('decide_shortlist');
  if (limited) return { ok: false };

  const session = getDecisionSession(id);
  if (!session?.shortlist) return { ok: false, error: 'There is no list to illustrate.' };

  try {
    await resolveShortlistImagery(session.shortlist);
  } catch (error) {
    // A picture service having a bad afternoon must never surface as an error
    // on the screen where somebody is choosing where to go.
    console.error('Shortlist imagery failed', { id, error });
    return { ok: false };
  }

  revalidatePath(`/decide/${id}`);
  return { ok: true };
}

/**
 * WHERE A DESTINATION'S PHOTOGRAPH IS DECIDED: HERE, ONCE, NOT AT RENDER.
 *
 * This is a server action, which is the only kind of thing on this path allowed
 * to reach outward. The page beside it reads rows and draws them — so a refresh,
 * a back button and a shared link cost nothing, and eight destinations produce
 * eight lookups in total rather than eight per view.
 *
 * Three properties worth stating because each has a failure behind it:
 *
 * **The shortlist is already saved before this runs.** Imagery is the least
 * important thing on the screen and it is resolved last, after the row that
 * matters is durable. A traveller must never lose a ranking because a picture
 * service was slow.
 *
 * **The subject is built from the index row, never from the shortlist.** The
 * shortlist carries a display name; the index carries the Wikidata id and the
 * administrative hierarchy, which are the two things that make a lookup an
 * identifier relationship instead of a search. A destination the index no longer
 * holds is skipped rather than searched for by name.
 *
 * **It is sequential and bounded.** Eight subjects, one at a time. Fanning eight
 * concurrent requests at a volunteer-run service is the pattern their API
 * etiquette explicitly asks clients not to use, and the whole thing is off the
 * critical path anyway.
 */
async function resolveShortlistImagery(shortlist: DestinationShortlist): Promise<void> {
  const subjects = shortlist.picks.flatMap((pick): ImageSubject[] => {
    const entry = destinationEntryById(pick.entryId);
    if (!entry) return [];
    return [
      {
        kind: 'destination',
        id: entry.id,
        name: entry.displayName,
        ...(entry.wikidataId ? { wikidataId: entry.wikidataId } : {}),
        coordinates: entry.center,
        hierarchy: entry.hierarchy,
      },
    ];
  });

  // The cache writes through to the table, so every record — the acceptances and
  // the refusals alike — is on disk by the time the page next renders. The
  // refusals are the half that matters for cost: without them, a second visit
  // pays again for the same "no".
  await resolveImageryForSubjects(subjects, { cache: imageryCache(new Date()) });
}

/**
 * Adopt one of the destinations we offered.
 *
 * Three guards, and each one is load-bearing:
 *
 * - **It must be one we offered.** The browser sends an id, and an id somebody
 *   made up must not become a trip. The stored shortlist is the authority for
 *   what was on screen.
 * - **The row is read back from the index**, never trusted from the client. This
 *   is the same rule `createTripFromComposer` follows, and the only place a
 *   `SelectedDestination` may be minted.
 * - **The answers are spread, never rebuilt.** Every preference they gave — the
 *   dates, the shape, the themes, the group, what they wanted to avoid — travels
 *   into the trip untouched. A freshly-built answers object would silently drop
 *   whatever the new code forgot, which is exactly the kind of loss a traveller
 *   cannot see and cannot report.
 */
export async function adoptDestinationAction(id: string, entryId: string): Promise<DecisionResult> {
  /*
   * The fourth guard, and the one with the irreversible consequence behind it:
   * adoption mints the trip under the *caller's* cookie and resolves the
   * session for good, so a stranger who reached this line would not merely
   * read the answers — they would take the trip and lock the owner out.
   */
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const session = getDecisionSession(id);
  if (!session) return { ok: false, error: 'We could not find that.' };
  if (session.resolvedTripId) return { ok: false, error: 'You have already chosen for this one.' };
  if (!session.shortlist?.picks.some((pick) => pick.entryId === entryId)) {
    return { ok: false, error: 'That is not one of the destinations we offered.' };
  }

  const entry = destinationEntryById(entryId);
  if (!entry) return { ok: false, error: 'We no longer hold that destination.' };

  const now = new Date();
  const destination: SelectedDestination = {
    entryId: entry.id,
    catalog: entry.catalog,
    sourceId: entry.sourceId,
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

  /*
   * Dates, from whatever they settled on — including a season.
   *
   * A month becomes the middle of that month; a season becomes the middle of
   * that season **at this destination's latitude**, which is the half that was
   * missing. `dates.month` is only set for `mode: 'month'`, so a traveller who
   * picked a season fell through to `now + 2 months` — an arbitrary month
   * neither they nor the ranker chose. The ranker had already scored the
   * destination with `seasonMonths(season, lat)`, so a southern-hemisphere
   * recommendation surfaced for *its* summer was then materialised into the
   * northern one, and every layer downstream — weather, closures, opening
   * calendars, the whole compilation — was keyed on dates the destination was
   * never scored for.
   *
   * `dates.mode` is preserved either way, so nothing presents the midpoint as a
   * decision the traveller made.
   */
  const nights = session.answers.duration.nights ?? suggestedNightsFor(session, entryId) ?? 6;
  const dates = session.answers.dates;
  const monthFromSeason =
    dates.season !== undefined ? middleMonthOf(dates.season, entry.center.lat) : null;
  const window =
    dates.startDate && dates.endDate
      ? { startDate: dates.startDate, endDate: dates.endDate }
      : datesInWindow(
          {
            month: dates.month ?? monthFromSeason ?? now.getUTCMonth() + 2,
            year: dates.year ?? now.getUTCFullYear(),
          },
          nights,
        );

  const answers: TripComposerAnswers = {
    ...session.answers,
    mode: 'known_destination',
    destination,
    destinationQuery: entry.displayName,
    dates: { ...dates, startDate: window.startDate, endDate: window.endDate },
    duration: { ...session.answers.duration, mode: 'fixed', nights },
    updatedAt: now.toISOString(),
  };

  const basics = tripBasicsSchema.safeParse({
    mode: 'known_destination',
    destinationInput: destination.displayName,
    regionId: DYNAMIC_REGION_ID,
    startDate: window.startDate,
    endDate: window.endDate,
    arrivalTime: minutesToTime(ARRIVAL_PLANNING_MINUTES.afternoon ?? 16 * 60),
    departureTime: minutesToTime(DEPARTURE_PLANNING_MINUTES.morning ?? 9 * 60),
    adults: session.answers.adults,
    children: session.answers.children,
    travelerNeeds: session.answers.travelerNeeds,
  });
  if (!basics.success) {
    return { ok: false, error: 'We could not turn that into a trip. Try adjusting your dates.' };
  }

  let tripId: string;
  try {
    // The owner, exactly as the composer door records it — the two entrances
    // must produce the same row or one of them makes an unownable trip.
    tripId = createTrip(basics.data, await sessionToken({ mint: true })).id;
    saveComposerAnswers(tripId, answers);
    saveDestinationQuery(tripId, 'known_destination', entry.displayName);
    saveSelectedDestination(tripId, destination);
    /*
     * Marked resolved last, and only once. A double-submitted form cannot
     * produce two trips from one decision, because the second update matches no
     * row — the same duplicate-click discipline the compilation job enforces
     * with its partial unique index.
     */
    if (!resolveDecisionSession(id, tripId, now)) {
      return { ok: false, error: 'You have already chosen for this one.' };
    }
  } catch (error) {
    console.error('Could not adopt a recommended destination', { id, entryId, error });
    return { ok: false, error: 'We could not save that. Nothing was lost — try again.' };
  }

  redirect(`/trips/${tripId}/plan`);
}

function suggestedNightsFor(
  session: NonNullable<ReturnType<typeof getDecisionSession>>,
  entryId: string,
): number | null {
  const pick = session.shortlist?.picks.find((entry) => entry.entryId === entryId);
  return pick?.suggestedNights ?? null;
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * The middle month of a season, at a latitude.
 *
 * `seasonMonths` is the one place that knows a season is a function of where you
 * are: it flips the northern months below the equator and returns all twelve in
 * the tropics, where the word does not pick out a period anybody plans around.
 * Twelve back therefore means "no month is implied", and the caller falls
 * through to its own default rather than this function inventing one.
 */
function middleMonthOf(season: string, latitude: number): number | null {
  const months = seasonMonths(season, latitude);
  if (months.length === 0 || months.length === 12) return null;
  return months[Math.floor(months.length / 2)] ?? null;
}
