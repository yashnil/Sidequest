'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  ARRIVAL_PLANNING_MINUTES,
  DEPARTURE_PLANNING_MINUTES,
  REFINEMENTS,
  adoptionWindow,
  datesInWindow,
  destinationCatalog,
  emptyAdvisorAnswers,
  emptyComposerAnswers,
  parseTravelRequest,
  tripBasicsSchema,
  tripComposerAnswersSchema,
  type AdvisorAnswers,
  type Refinement,
  type TripComposerAnswers,
} from '@sidequest/core';
import {
  createDecisionSession,
  getDecisionSession,
  resolveDecisionSession,
  saveDecisionAnswers,
  saveDecisionAnswersAndShortlist,
  saveDecisionShortlist,
} from '@/lib/db/decision-repository';
import { createTrip } from '@/lib/db/repository';
import { guardAction, sessionToken } from '@/lib/net/caller';
import { currentUserId } from '@/lib/auth/session';
import { decisionAccessRefusal } from '@/lib/net/decision-access';
import { saveComposerAnswers, saveDestinationQuery } from '@/lib/db/compiler-repository';
import { adviseFor } from '@/lib/destinations/advisor';
import { advisorImageSubjects } from '@/lib/destinations/advisor-images';
import { decisionAnswersSchema, decisionAnswersToComposer, emptyDecisionAnswers, type DecisionAnswersInput } from '@/lib/destinations/decision-answers';
import { DYNAMIC_REGION_ID } from '@/lib/region';
import { imageryCache } from '@/lib/db/imagery-repository';
import { resolveImageryForSubjects } from '@/lib/providers/wikimedia';

/**
 * THE ACTIONS BEHIND THE DESTINATION ADVISOR ("HELP ME CHOOSE", 2026-10).
 *
 * The same rules the previous ranker held, kept: **no model on this path** —
 * the interview, the ranking and the shortlist are deterministic functions of
 * the stored answers and the catalog — and **choosing produces an ordinary
 * trip**, from the same `TripComposerAnswers`, landing on the same plan page.
 * Every action writes before it returns, so a refresh, a closed laptop or a
 * back button costs nothing.
 */

export interface AdvisorResult {
  ok: boolean;
  error?: string;
}

/** Start from what they typed (which may be nothing) and go to the interview. */
export async function startAdvisorAction(input: { text: string; prefill?: Partial<DecisionAnswersInput> }): Promise<AdvisorResult> {
  const limited = await guardAction('decide_start');
  if (limited) return { ok: false, error: limited };
  const now = new Date();
  const text = String(input?.text ?? '').slice(0, 600);
  /*
   * `/explore` hands over a posture as already-given answers. They are read
   * through the same strict conversion the old intake used, so an unrecognised
   * value is dropped rather than stored.
   */
  const prefill = input?.prefill ? decisionAnswersSchema.safeParse({ ...emptyDecisionAnswers(), ...input.prefill }) : null;
  const prefilled = prefill?.success ? decisionAnswersToComposer(prefill.data, now) : null;
  const base: TripComposerAnswers = prefilled
    ? { ...prefilled, discovery: emptyAdvisorAnswers() }
    : { ...emptyComposerAnswers('help_me_decide', now), dates: { mode: 'month', wantsRecommendation: false }, discovery: emptyAdvisorAnswers() };
  const { answers } = parseTravelRequest(text, base);
  const owner = await sessionToken({ mint: true });
  const id = createDecisionSession({ ...answers, updatedAt: now.toISOString() }, owner, now);
  redirect(`/decide/${id}`);
}

/**
 * The browser runs the interview (it is a pure function of the answers and the
 * catalog) and saves after every answer. The server parses strictly and keeps
 * the parts a browser must not change: the mode, the absence of a destination.
 */
export async function saveAdvisorAnswersAction(id: string, raw: unknown): Promise<AdvisorResult> {
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const session = getDecisionSession(id);
  if (!session) return { ok: false, error: 'We could not find that.' };
  if (session.resolvedTripId) return { ok: false, error: 'You have already picked a destination for this one.' };
  const parsed = tripComposerAnswersSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Some of those answers did not make sense.' };
  const { destination: _destination, destinationQuery: _query, ...rest } = parsed.data;
  saveDecisionAnswers(id, { ...rest, mode: 'help_me_decide', updatedAt: new Date().toISOString() }, new Date());
  return { ok: true };
}

/** Rank against the stored answers and store the result. */
export async function buildAdvisorShortlistAction(id: string): Promise<AdvisorResult> {
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const limited = await guardAction('decide_shortlist');
  if (limited) return { ok: false, error: limited };
  const session = getDecisionSession(id);
  if (!session) return { ok: false, error: 'We could not find that.' };
  try {
    const shortlist = await adviseFor(session.answers, new Date(), null);
    saveDecisionShortlist(id, shortlist, new Date());
    console.warn('advisor shortlist', { ms: shortlist.elapsedMs, eligible: shortlist.stats.eligible, climateChecked: shortlist.stats.climateChecked });
  } catch (error) {
    console.error('Advisor shortlist failed', { id, error });
    return { ok: false, error: 'We could not put a list together just then. Nothing was lost — try again.' };
  }
  revalidatePath(`/decide/${id}`);
  return { ok: true };
}

export type RefineInput =
  | { refinement: Refinement }
  | { similarTo: string }
  | { setAside: string }
  | { different: true }
  | { reset: true };

/**
 * One tap of refinement: change the answers, re-rank, and say what changed —
 * without restarting the interview and without losing anything already said.
 */
export async function refineAdvisorAction(id: string, input: RefineInput): Promise<AdvisorResult> {
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const limited = await guardAction('decide_shortlist');
  if (limited) return { ok: false, error: limited };
  const session = getDecisionSession(id);
  if (!session) return { ok: false, error: 'We could not find that.' };
  if (session.resolvedTripId) return { ok: false, error: 'You have already chosen for this one.' };

  const catalogIds = new Set(destinationCatalog().map((entry) => entry.id));
  const discovery: AdvisorAnswers = session.answers.discovery ?? emptyAdvisorAnswers();
  let next: AdvisorAnswers = discovery;
  if ('refinement' in input) {
    if (!(REFINEMENTS as readonly string[]).includes(input.refinement)) return { ok: false, error: 'That is not a change we know how to make.' };
    next = { ...discovery, refinements: [...discovery.refinements, input.refinement].slice(-20) };
  } else if ('similarTo' in input) {
    if (!catalogIds.has(input.similarTo)) return { ok: false, error: 'We do not hold that destination.' };
    next = { ...discovery, similarTo: input.similarTo };
  } else if ('setAside' in input) {
    if (!catalogIds.has(input.setAside)) return { ok: false, error: 'We do not hold that destination.' };
    next = { ...discovery, excluded: [...new Set([...discovery.excluded, input.setAside])].slice(-60) };
  } else if ('different' in input) {
    const shown = [...(session.advisor?.picks ?? []), ...(session.advisor?.alternates ?? [])].map((pick) => pick.id);
    next = { ...discovery, excluded: [...new Set([...discovery.excluded, ...shown])].slice(-60), similarTo: undefined };
  } else if ('reset' in input) {
    next = { ...discovery, refinements: [], excluded: [], similarTo: undefined };
  }
  const answers: TripComposerAnswers = { ...session.answers, discovery: next, updatedAt: new Date().toISOString() };
  try {
    const shortlist = await adviseFor(answers, new Date(), session.advisor);
    saveDecisionAnswersAndShortlist(id, answers, shortlist, new Date());
  } catch (error) {
    console.error('Advisor refinement failed', { id, error });
    return { ok: false, error: 'We could not change the list just then. Nothing was lost — try again.' };
  }
  revalidatePath(`/decide/${id}`);
  return { ok: true };
}

/** Photographs for the destinations on screen, after the list is already showing. */
export async function resolveAdvisorImageryAction(id: string): Promise<AdvisorResult> {
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const limited = await guardAction('decide_shortlist');
  if (limited) return { ok: false };
  const session = getDecisionSession(id);
  if (!session?.advisor) return { ok: false };
  try {
    await resolveImageryForSubjects(advisorImageSubjects(session.advisor), { cache: imageryCache(new Date()) });
  } catch (error) {
    console.error('Advisor imagery failed', { id, error });
    return { ok: false };
  }
  revalidatePath(`/decide/${id}`);
  return { ok: true };
}

/**
 * Plan one of the destinations we offered.
 *
 * The destination enters planning as the phrase a traveller would have typed
 * (`resolveAs`, e.g. "Lofoten, Norway"), so it goes through the same semantic
 * gate and resolution ladder as any typed destination (V8.1) rather than a
 * second, advisor-only identity path. The answers are spread, never rebuilt:
 * every preference travels into the trip.
 */
export async function adoptAdvisorPickAction(id: string, pickId: string): Promise<AdvisorResult> {
  const foreign = await decisionAccessRefusal(id);
  if (foreign) return { ok: false, error: foreign };
  const session = getDecisionSession(id);
  if (!session) return { ok: false, error: 'We could not find that.' };
  if (session.resolvedTripId) return { ok: false, error: 'You have already chosen for this one.' };
  const pick = [...(session.advisor?.picks ?? []), ...(session.advisor?.alternates ?? [])].find((entry) => entry.id === pickId);
  if (!pick) return { ok: false, error: 'That is not one of the destinations we offered.' };

  const now = new Date();
  const dates = session.answers.dates;
  const chosen = adoptionWindow(session.answers, pick, now);
  const window =
    dates.startDate && dates.endDate ? { startDate: dates.startDate, endDate: dates.endDate } : datesInWindow({ month: chosen.month, year: chosen.year }, chosen.nights);

  const answers: TripComposerAnswers = {
    ...session.answers,
    mode: 'known_destination',
    destinationQuery: pick.resolveAs,
    dates: { ...dates, startDate: window.startDate, endDate: window.endDate },
    duration: { ...session.answers.duration, mode: 'fixed', nights: chosen.nights },
    updatedAt: now.toISOString(),
  };

  const basics = tripBasicsSchema.safeParse({
    mode: 'known_destination',
    destinationInput: pick.resolveAs,
    regionId: DYNAMIC_REGION_ID,
    startDate: window.startDate,
    endDate: window.endDate,
    arrivalTime: minutesToTime(ARRIVAL_PLANNING_MINUTES.afternoon ?? 16 * 60),
    departureTime: minutesToTime(DEPARTURE_PLANNING_MINUTES.morning ?? 9 * 60),
    adults: session.answers.adults,
    children: session.answers.children,
    travelerNeeds: session.answers.travelerNeeds,
  });
  if (!basics.success) return { ok: false, error: 'We could not turn that into a trip. Try adjusting your dates.' };

  let tripId: string;
  try {
    tripId = createTrip(basics.data, await sessionToken({ mint: true }), await currentUserId()).id;
    saveComposerAnswers(tripId, answers);
    saveDestinationQuery(tripId, 'known_destination', pick.resolveAs);
    if (!resolveDecisionSession(id, tripId, now)) return { ok: false, error: 'You have already chosen for this one.' };
  } catch (error) {
    console.error('Could not adopt an advisor pick', { id, pickId, error });
    return { ok: false, error: 'We could not save that. Nothing was lost — try again.' };
  }
  redirect(`/trips/${tripId}/plan`);
}

function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
