'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { bookedPlanItemInputSchema, bookedPlanItemSchema, formatCount, rankVenues, travelReadinessProfileSchema, type BookedPlanItem, type ExtractedConfirmation, type Itinerary, type VenueFit } from '@sidequest/core';
import { addBookedItem, clearReadinessProfile, getTravelIntelligence, listBookedItems, removeBookedItem, saveReadinessProfile, setCheck, updateBookedItem } from '@/lib/db/intelligence-repository';
import { clearBookingResolution, getImport, recordImport, resolveImport, setBookingResolution, type ImportSourceKind } from '@/lib/db/execution-repository';
import { applyBookedFacts } from '@/lib/intelligence/booked-reconcile';
import { describeExtraction, prepareImport, type ImportInput } from '@/lib/execution/import';
import { readConfirmationPhotoWithModel, readConfirmationWithModel } from '@/lib/execution/import-model';
import { BOOKED_TYPE_FOR_KIND } from '@/components/hub/booking-copy';
import {
  easeDay,
  removeStopFromDay,
  swapAlternativesForStop,
  swapStopOnDay,
  type ItineraryEditResult,
  type PlannerInput,
} from '@sidequest/planner';
import { type BuildResult, plannerInputForTrip } from '@/lib/planning/build';
import { buildPreflight } from '@/lib/planning/build-preflight';
import { buildRunView, startBuildRun } from '@/lib/planning/build-runs';
import { callerKey, guardAction } from '@/lib/net/caller';
import { keepsToCarry, regenerationPreview } from './regenerate-summary';
import { addCustomStop, easeReconciledDay, isReconciledItinerary, moveStopToDay, removeStopFromReconciledItinerary, setStopDuration, setStopKeep, shiftStop } from '@/lib/planning/reconciled-edits';
import { repairReconciledDay } from '@/lib/planning/day-repair';
import { discoverFoodNear, discoverStaysNear } from '@/lib/providers/discovery';
import {
  clearItineraryLock,
  ensureShareToken,
  getItinerary,
  getItineraryLocks,
  getProfile,
  getSelections,
  getTrip,
  saveItinerary,
  setItineraryLock,
  setSelection,
} from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';

export type { BuildResult } from '@/lib/planning/build';

/*
 * Every action in this file edits or rebuilds somebody's plan, so every one
 * starts with the same question `deleteTripAction` and `createShareLinkAction`
 * already ask: does the asking browser own this trip? The check lives in
 * `lib/net/trip-access`; the read-only /share/<token> view is the one door
 * that stays open without it.
 */

const buildKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** A key for a press that did not bring one (a caller older than the durable build). */
function serverBuildKey(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * V1 CONVERGENCE — EVERY WHOLE-TRIP BUILD FROM THE ITINERARY IS A DURABLE RUN.
 *
 * "Rebuild my trip" (the stale plan and the board) and "Regenerate" (the plan's
 * own menu) used to await the whole generation inside the server action — up to
 * two minutes with nothing on screen but a relabelled button, and a dropped
 * request lost the traveller's view of a build the server kept running. Both now
 * do what "Build my trip" does: preflight, record a run under an idempotency
 * key, schedule the generation after the response (`startBuildRun`), and send
 * the traveller to `/trips/[id]/build`, which shows progress from the run row
 * and returns to the itinerary when it succeeds. A refusal is typed and comes
 * back as the failure's own sentence before anything is recorded.
 */
async function startWholeTripBuild(tripId: string, buildKey: string, caller: string, before?: () => void): Promise<{ ok: true; buildKey: string } | { ok: false; error: string }> {
  if (!buildKeySchema.safeParse(buildKey).success) return { ok: false, error: 'That build could not be started.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
  /* A run already open is this press arriving twice, or a build already under way: attach, never a second composition. */
  const current = buildRunView(tripId);
  if (current.state === 'running') return { ok: true, buildKey: current.buildKey ?? buildKey };
  const fence = await guardAction('build_start');
  if (fence) return { ok: false, error: fence };
  const who = (await callerKey()) ?? caller;
  /*
   * V1 convergence — the same preflight and the same typed copy as Build: a
   * deployment with no composer used to answer Regenerate with "No model
   * credential is configured, so we cannot compose a first draft yet", a
   * sentence about environment variables shown to a traveller.
   */
  const preflight = buildPreflight(tripId, { caller: who });
  if (!preflight.ok) {
    console.warn('Build refused before it started', { tripId, door: caller, cause: preflight.failure.cause, reason: preflight.operatorReason });
    return { ok: false, error: preflight.failure.message };
  }
  before?.();
  startBuildRun({ tripId, buildKey, caller, mode: 'full' });
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, buildKey };
}

/**
 * "Build my trip" / "Rebuild my trip" from the board and the stale-plan view.
 * Starts the durable run and navigates to the build screen. `buildKey` is the
 * press's idempotency key; a caller that does not send one gets a fresh key.
 */
export async function buildItineraryAction(tripId: string, buildKey?: string): Promise<BuildResult> {
  /* Asked here as well as inside the shared starter, so the guard is visible at the door (`ownership.architecture.test.ts`). */
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const started = await startWholeTripBuild(tripId, buildKey ?? serverBuildKey(), 'itinerary_build_action');
  if (!started.ok) return { ok: false, error: started.error };
  // `redirect` throws, so nothing below it runs; the return satisfies the signature.
  redirect(`/trips/${tripId}/build`);
  return { ok: true };
}

export type RegenerateResult = { ok: true; buildKey: string } | { ok: false; error: string };

/**
 * "Regenerate" on the itinerary — after the traveller has read what it keeps
 * and what it replaces (`regenerate-summary.ts`). Stops marked must-keep or
 * locked that are board places are recorded as the traveller's own includes
 * first, so the plan the confirmation promised is the plan the build reads.
 * Returns the run's key; the client goes to `/trips/[id]/build`.
 */
export async function regenerateItineraryAction(tripId: string, buildKey?: string): Promise<RegenerateResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  return startWholeTripBuild(tripId, buildKey ?? serverBuildKey(), 'itinerary_regenerate_action', () => {
    try {
      const itinerary = getItinerary(tripId);
      if (!itinerary) return;
      const selections = getSelections(tripId);
      const preview = regenerationPreview({ itinerary, locks: getItineraryLocks(tripId), selections, bookings: 0 });
      for (const placeId of keepsToCarry(preview, selections)) setSelection(tripId, placeId, 'included', 'user');
    } catch {
      /* A stale stored plan has no keeps to read; the rebuild itself is what replaces it. */
    }
  });
}

// ---------------------------------------------------------------------------
// Smart editing (§11.1): structured intent → deterministic replan → validation.
// ---------------------------------------------------------------------------

/**
 * Every edit follows one shape: assemble the same planner input a rebuild
 * would use, load the stored plan through the version gate (a stale plan
 * cannot be edited — it renders read-only and rebuilds first), hand both to a
 * deterministic planner edit, and persist only what came back valid. The LLM
 * is nowhere in this file, which is the point of §11.1.
 */
export interface EditActionResult {
  ok: boolean;
  error?: string;
  /** One sentence describing what changed, for the toast. */
  changed?: string;
}

export interface SwapOffer {
  placeId: string;
  name: string;
  reason: string;
}

async function editContext(
  tripId: string,
): Promise<
  | { ok: true; input: PlannerInput | null; itinerary: Itinerary }
  | { ok: false; error: string }
> {
  // The one seam all four edit actions share, so the owner check cannot be
  // forgotten by the next edit verb somebody adds to this file.
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  let itinerary;
  try {
    itinerary = getItinerary(tripId);
  } catch {
    return {
      ok: false,
      error: 'This plan was built by an earlier version — rebuild it before editing.',
    };
  }
  if (!itinerary) return { ok: false, error: 'There is no plan to edit yet. Build the trip first.' };
  /*
   * A reconciled (model-draft) itinerary is edited in place — see
   * `lib/planning/reconciled-edits.ts` — and never needs the legacy planner
   * input, which requires a compiled region a Quick Plan trip may not have.
   */
  if (isReconciledItinerary(itinerary)) return { ok: true, input: null, itinerary };
  const assembled = await plannerInputForTrip(tripId);
  if (!assembled.ok) return { ok: false, error: assembled.error };
  return { ok: true, input: assembled.input, itinerary };
}

function persistEdit(tripId: string, result: ItineraryEditResult | { ok: true; itinerary: Itinerary; changed: string } | { ok: false; message: string }): EditActionResult {
  if (!result.ok) return { ok: false, error: result.message };
  try {
    saveItinerary(result.itinerary);
  } catch (error) {
    console.error('Failed to save edited itinerary', error);
    return { ok: false, error: 'The change was valid but could not be saved. Nothing was lost.' };
  }
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, changed: result.changed };
}

export async function removeStopAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
): Promise<EditActionResult> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  const result = context.input
    ? removeStopFromDay(context.input, context.itinerary, dayNumber, placeId)
    : removeStopFromReconciledItinerary(context.itinerary, dayNumber, placeId);
  const persisted = persistEdit(tripId, result);
  if (persisted.ok) {
    /*
     * The board reflects the decision: a removed stop is an excluded one, so
     * the next full rebuild does not resurrect what the traveller took off.
     * The lock, if any, goes with it — a pin on an excluded place is a
     * contradiction in storage.
     */
    setSelection(tripId, placeId, 'excluded', 'user');
    clearItineraryLock(tripId, placeId);
  }
  return persisted;
}

export async function swapAlternativesAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
): Promise<{ ok: boolean; error?: string; offers?: SwapOffer[] }> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  // A reconciled plan has no board competition to draw swaps from; the honest answer is none, not an invented one.
  if (!context.input) return { ok: true, offers: [] };
  const offers = swapAlternativesForStop(context.input, context.itinerary, dayNumber, placeId);
  return {
    ok: true,
    offers: offers.map((offer) => ({
      placeId: offer.placeId,
      name: offer.name,
      reason: offer.reason,
    })),
  };
}

export async function swapStopAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
  replacementId: string,
): Promise<EditActionResult> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  if (!context.input) return { ok: false, error: 'Swaps come from the Discovery Board, which this plan was not built from. Remove the stop instead, or regenerate.' };
  const result = swapStopOnDay(context.input, context.itinerary, dayNumber, placeId, replacementId);
  const persisted = persistEdit(tripId, result);
  if (persisted.ok) {
    setSelection(tripId, placeId, 'excluded', 'user');
    setSelection(tripId, replacementId, 'included', 'user');
    clearItineraryLock(tripId, placeId);
  }
  return persisted;
}

export async function easeDayAction(tripId: string, dayNumber: number): Promise<EditActionResult> {
  const context = await editContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  return persistEdit(tripId, context.input ? easeDay(context.input, context.itinerary, dayNumber) : easeReconciledDay(context.itinerary, dayNumber));
}

export interface ShareLinkResult {
  ok: boolean;
  error?: string;
  /** The share path — `/share/<token>` — for the client to complete with its origin. */
  path?: string;
}

/**
 * ONLY THE BROWSER THAT MADE A TRIP MAY PUT IT ON A PUBLIC LINK.
 *
 * The same rule, boundary and refusal as `deleteTripAction`, because minting a
 * share link is the other irreversible thing a trip id must not be enough for:
 * this phase ships no revocation, so a link minted for the wrong caller is a
 * permanent public copy of somebody's holiday. A trip with no owner is refused
 * too, and `mint: false` for the same reason as deletion — a request about to
 * be refused should leave nothing behind, not even a cookie.
 *
 * Idempotent by construction: the token is minted once and every later press
 * returns the link already in circulation, so sharing twice cannot quietly
 * break the copy a friend already has.
 */
export async function createShareLinkAction(tripId: string): Promise<ShareLinkResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };

  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const token = ensureShareToken(tripId);
  if (!token) {
    return { ok: false, error: 'We could not make a link just then. Nothing was lost — try again.' };
  }
  return { ok: true, path: `/share/${token}` };
}

/**
 * A lock is persistence plus a promise, not a replan: the plan already has the
 * stop where the traveller wants it. The next rebuild reads the pin.
 */
export async function toggleLockAction(
  tripId: string,
  dayNumber: number,
  placeId: string,
  locked: boolean,
): Promise<EditActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip any more.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (locked) setItineraryLock(tripId, placeId, dayNumber);
  else clearItineraryLock(tripId, placeId);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return {
    ok: true,
    changed: locked
      ? 'Locked. A rebuild will keep this stop on this day.'
      : 'Unlocked. A rebuild is free to move this stop again.',
  };
}

// ---------------------------------------------------------------------------
// Booked facts, readiness profile, checklists
// ---------------------------------------------------------------------------

export interface HubActionResult {
  ok: boolean;
  error?: string;
}

/**
 * A booked fact the traveller typed. Validated by the schema, stored as is,
 * applied to the plan at the next render — see `loadTripIntelligence`.
 */
export async function addBookedItemAction(tripId: string, input: unknown): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = bookedPlanItemInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  addBookedItem(tripId, parsed.data);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

export async function removeBookedItemAction(tripId: string, id: string): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  removeBookedItem(tripId, id);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

export async function saveReadinessProfileAction(tripId: string, input: unknown): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = travelReadinessProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  saveReadinessProfile(tripId, parsed.data);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

export async function clearReadinessProfileAction(tripId: string): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  clearReadinessProfile(tripId);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

export async function setCheckAction(tripId: string, list: 'packing' | 'checklist' | 'preflight', itemId: string, checked: boolean): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  setCheck(tripId, list, itemId, checked);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * LIVE WORLD V1 — day editing, day repair, booking edits, discovery
 * ------------------------------------------------------------------ */

async function reconciledContext(tripId: string): Promise<{ ok: true; itinerary: Itinerary } | { ok: false; error: string }> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const itinerary = getItinerary(tripId);
  if (!itinerary) return { ok: false, error: 'There is no saved plan to edit.' };
  if (!isReconciledItinerary(itinerary)) return { ok: false, error: 'This plan was built by the earlier planner; rebuild it to edit days this way.' };
  return { ok: true, itinerary };
}

export async function moveStopAction(tripId: string, fromDay: number, stopId: string, toDay: number): Promise<EditActionResult> {
  const context = await reconciledContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  return persistEdit(tripId, moveStopToDay(context.itinerary, fromDay, stopId, toDay));
}

export async function shiftStopAction(tripId: string, dayNumber: number, stopId: string, direction: 'earlier' | 'later'): Promise<EditActionResult> {
  const context = await reconciledContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  return persistEdit(tripId, shiftStop(context.itinerary, dayNumber, stopId, direction));
}

export async function setStopDurationAction(tripId: string, dayNumber: number, stopId: string, minutes: number): Promise<EditActionResult> {
  const context = await reconciledContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  return persistEdit(tripId, setStopDuration(context.itinerary, dayNumber, stopId, Number(minutes)));
}

export async function addCustomStopAction(tripId: string, dayNumber: number, input: { title: string; minutes?: number; note?: string }): Promise<EditActionResult> {
  const context = await reconciledContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  return persistEdit(tripId, addCustomStop(context.itinerary, dayNumber, { title: String(input.title ?? ''), ...(input.minutes !== undefined ? { minutes: Number(input.minutes) } : {}), ...(input.note ? { note: String(input.note) } : {}) }));
}

export async function setStopKeepAction(tripId: string, dayNumber: number, stopId: string, keep: 'must_keep' | 'optional'): Promise<EditActionResult> {
  const context = await reconciledContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  return persistEdit(tripId, setStopKeep(context.itinerary, dayNumber, stopId, keep));
}

export async function fixDayAction(tripId: string, dayNumber: number): Promise<EditActionResult & { steps?: string[] }> {
  const context = await reconciledContext(tripId);
  if (!context.ok) return { ok: false, error: context.error };
  const repaired = repairReconciledDay(context.itinerary, dayNumber);
  if (!repaired.ok || !repaired.itinerary) return { ok: false, error: repaired.message };
  const persisted = persistEdit(tripId, { ok: true, itinerary: repaired.itinerary, changed: `${repaired.message} ${repaired.steps.join(' ')}` });
  return persisted.ok ? { ...persisted, steps: repaired.steps } : persisted;
}

/** Status, cost or time edits on a booking the traveller typed. The itinerary is re-verified against it at the next render. */
export async function updateBookedItemAction(tripId: string, id: string, patch: unknown): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = bookedPlanItemInputSchema.partial().safeParse(patch);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const updated = updateBookedItem(tripId, id, parsed.data);
  if (!updated) return { ok: false, error: 'That booking is no longer on the trip.' };
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

export interface DiscoveryActionResult {
  ok: boolean;
  error?: string;
  available?: boolean;
  provider?: string | null;
  attribution?: string;
  reason?: string;
  items?: { name: string; distanceKm: number; priceLevel?: string; rating?: number; ratingCount?: number; reviewCountLabel?: string; mapsUri?: string; website?: string; address?: string; why?: string; caution?: string }[];
}

/**
 * MVP V3, Stages 34 and 35 — the traveller's own fit decides the order.
 *
 * A places provider hands back what it thinks is most relevant, which in
 * practice is most-reviewed, which in practice is the place every visitor
 * already goes to. `rankVenues` reorders on proximity, price fit, character and
 * the rating *as one signal*, and returns the clause that explains each
 * position. A strict dietary need never reorders anything — it attaches a
 * caution, because no ranking makes a kitchen safe.
 */
function forDisplay(result: Awaited<ReturnType<typeof discoverStaysNear>>, fit: VenueFit): DiscoveryActionResult {
  const ranked = rankVenues(result.items, fit);
  return {
    ok: true,
    available: result.available,
    provider: result.provider,
    ...(result.attribution ? { attribution: result.attribution } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    items: ranked.map(({ venue: p, why, caution }) => ({
      name: p.name,
      distanceKm: p.distanceKm,
      ...(p.priceLevel ? { priceLevel: p.priceLevel } : {}),
      ...(p.rating !== undefined ? { rating: p.rating } : {}),
      ...(p.ratingCount !== undefined ? { ratingCount: p.ratingCount, reviewCountLabel: formatCount(p.ratingCount) } : {}),
      ...(p.mapsUri ? { mapsUri: p.mapsUri } : {}),
      ...(p.website ? { website: p.website } : {}),
      ...(p.address ? { address: p.address } : {}),
      why,
      ...(caution ? { caution } : {}),
    })),
  };
}

/**
 * What the traveller said, turned into the fit the ranker reads.
 *
 * Read from the stored profile when there is one; a trip without a profile gets
 * neutral middle values rather than an invented preference.
 */
function venueFitFor(tripId: string): VenueFit {
  const profile = getProfile(tripId);
  if (!profile) return { priceBand: 'moderate', reachKm: 1.5, foodStyle: 'balanced' };
  const walkMinutes = profile.transport.maxAccessWalkMinutes ?? 25;
  return {
    priceBand: profile.food.everydayPriceBand,
    // 5 km/h on foot, and never less than a few streets.
    reachKm: Math.max(0.5, Math.round((walkMinutes / 60) * 5 * 10) / 10),
    foodStyle: profile.food.style,
    ...(profile.food.dietaryStrict && (profile.food.dietaryNeeds.length > 0 || profile.food.dietaryNotes) ? { strictDietary: true } : {}),
  };
}

/** One bounded lookup for display; nothing is stored. Live prices and availability are never part of the answer. */
export async function discoverStaysAction(tripId: string, near: { lat: number; lng: number }, query?: string): Promise<DiscoveryActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!Number.isFinite(near?.lat) || !Number.isFinite(near?.lng)) return { ok: false, error: 'That base has no verified position to search around.' };
  return forDisplay(await discoverStaysNear({ near, ...(query ? { query: query.slice(0, 60) } : {}) }), venueFitFor(tripId));
}

export async function discoverFoodAction(tripId: string, near: { lat: number; lng: number }, query?: string): Promise<DiscoveryActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!Number.isFinite(near?.lat) || !Number.isFinite(near?.lng)) return { ok: false, error: 'That stop has no verified position to search around.' };
  return forDisplay(await discoverFoodNear({ near, ...(query ? { query: query.slice(0, 60) } : {}) }), venueFitFor(tripId));
}

/* ------------------------------------------------------------------ *
 * V9 §5 / §6 — bookings that are objects, confirmation import
 * ------------------------------------------------------------------ */

/**
 * Every action below is the traveller's own act on a booking need or a booked
 * fact: marking a need booked, adding the confirmation to a fact, replacing a
 * suggestion with something else, skipping a need, importing a confirmation.
 * Each starts with the ownership question, validates its input, writes one
 * row, and lets the page re-render from disk. None calls a model except the
 * one explicit "Ask Sidequest to read it" press, which is bounded to one call.
 */
const ISSUE_TEXT = (issues: { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

const bookingNeedIdSchema = z.string().min(1).max(200);

/** What "Mark booked" saves: a booked fact that names the need it satisfies. */
const markBookedInputSchema = bookedPlanItemInputSchema
  .pick({ type: true, title: true, date: true, endDate: true, startTime: true, endTime: true, timeZone: true, location: true, placeId: true, baseId: true, provider: true, confirmationRef: true, url: true, notes: true, cancellationDeadline: true, cost: true, status: true, paid: true, refundable: true })
  .extend({ bookingItemId: bookingNeedIdSchema });
export type MarkBookedInput = z.input<typeof markBookedInputSchema>;

/** What "Add confirmation" adds to a booked fact. Every field optional; nothing else on the fact is touched. */
const confirmationInputSchema = bookedPlanItemInputSchema.pick({ confirmationRef: true, url: true, cost: true, paid: true, refundable: true, cancellationDeadline: true, provider: true, notes: true }).partial();
export type ConfirmationInput = z.input<typeof confirmationInputSchema>;

export interface BookingActionResult extends HubActionResult {
  /** The booked fact's id, when one was created. */
  bookedItemId?: string;
}

/** The need's title from the persisted intelligence snapshot, so "replaces" is the plan's word and not the browser's. */
function needTitle(tripId: string, bookingItemId: string): string | undefined {
  return getTravelIntelligence(tripId)?.bookings.items.find((b) => b.id === bookingItemId)?.title;
}

export async function markBookedAction(tripId: string, input: unknown): Promise<BookingActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = markBookedInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  const item = addBookedItem(tripId, { ...parsed.data, locked: true, source: 'marked' });
  /* A booking outranks an earlier "skip" on the same need; the skip is the traveller's older word. */
  clearBookingResolution(tripId, parsed.data.bookingItemId);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, bookedItemId: item.id };
}

export async function addConfirmationAction(tripId: string, bookedItemId: string, input: unknown): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = confirmationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Add at least one detail — a reference, a link, an amount or the cancellation terms.' };
  const updated = updateBookedItem(tripId, String(bookedItemId), patch);
  if (!updated) return { ok: false, error: 'That booking is no longer on the trip.' };
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

/** "Replace": something else was booked in place of the plan's suggestion. The fact names both the need and what it displaced. */
export async function replaceBookingAction(tripId: string, input: unknown): Promise<BookingActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = markBookedInputSchema.extend({ replaces: z.string().min(1).max(160).optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  const { replaces: replacesInput, ...fact } = parsed.data;
  const replaces = needTitle(tripId, fact.bookingItemId) ?? replacesInput;
  const item = addBookedItem(tripId, { ...fact, locked: true, source: 'marked', ...(replaces ? { replaces } : {}) });
  setBookingResolution(tripId, { bookingItemId: fact.bookingItemId, resolution: 'replaced', bookedItemId: item.id });
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, bookedItemId: item.id };
}

export async function skipBookingAction(tripId: string, bookingItemId: string, note?: string): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = z.object({ bookingItemId: bookingNeedIdSchema, note: z.string().max(300).optional() }).safeParse({ bookingItemId, ...(note ? { note } : {}) });
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  setBookingResolution(tripId, { bookingItemId: parsed.data.bookingItemId, resolution: 'skipped', ...(parsed.data.note?.trim() ? { note: parsed.data.note.trim() } : {}) });
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

export async function unskipBookingAction(tripId: string, bookingItemId: string): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = bookingNeedIdSchema.safeParse(bookingItemId);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  clearBookingResolution(tripId, parsed.data);
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Confirmation import
// ---------------------------------------------------------------------------

/** Base64 of a 4 MB file is ~5.6 M characters; anything past that is refused before it is decoded. */
const importInputSchema = z.object({
  kind: z.enum(['text', 'file']),
  text: z.string().max(700_000).optional(),
  fileBase64: z.string().max(6_000_000).optional(),
  filename: z.string().max(200).optional(),
  subject: z.string().max(300).optional(),
  sender: z.string().max(200).optional(),
});

export interface ImportActionResult {
  ok: boolean;
  error?: string;
  importId?: string;
  sourceKind?: ImportSourceKind;
  extracted?: ExtractedConfirmation;
  /** One sentence for the top of the review. */
  summary?: string;
  /** True when the file was a photo: nothing was read, and only the explicit press can read it. */
  photo?: boolean;
  /** True when the reading came from the explicit model press. */
  modelUsed?: boolean;
}

function tripWindow(tripId: string): { tripStart?: string; tripEnd?: string } {
  const trip = getTrip(tripId);
  return trip ? { tripStart: trip.basics.startDate, tripEnd: trip.basics.endDate } : {};
}

/**
 * Parse → redact → extract → record. The raw document is never stored; the
 * row holds the redacted extraction and its status. Nothing on the trip
 * changes until the traveller confirms.
 *
 * V9.1 §7 — a photo or screenshot: the bytes are sniffed, bounded and stripped
 * of their metadata, a pending import with `source_kind: 'image'`, an empty
 * extraction and a "not read yet" note is recorded, and the bytes are dropped
 * with this call. Only `readImportWithSidequestAction`, on an explicit press,
 * ever reads the photo.
 */
export async function importConfirmationAction(tripId: string, input: unknown): Promise<ImportActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = importInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  const outcome = await prepareImport(parsed.data as ImportInput, tripWindow(tripId));
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const { prepared } = outcome;
  /* The row never holds the image: only the extraction is recorded, and `prepared.image` goes out of scope here. */
  const record = recordImport(tripId, { sourceKind: prepared.sourceKind, extracted: prepared.extracted, modelUsed: false });
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, importId: record.id, sourceKind: prepared.sourceKind, extracted: prepared.extracted, summary: describeExtraction(prepared.extracted), photo: prepared.sourceKind === 'image', modelUsed: false };
}

/**
 * The explicit press. The document is read again from what the traveller
 * sent (the row never held it), redacted again, and only then shown to the
 * model. A reading that comes back replaces the pending row: the earlier
 * extraction is discarded and a new pending import carries `modelUsed`.
 *
 * V9.1 §7 — for a photo the stripped bytes and the trip window are the whole
 * of what the model receives (`readConfirmationPhotoWithModel`); the bytes
 * are not retained past this call and the new row holds only the reading.
 */
export async function readImportWithSidequestAction(tripId: string, importId: string, input: unknown): Promise<ImportActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = importInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  const pending = getImport(tripId, String(importId));
  if (!pending || pending.status !== 'pending') return { ok: false, error: 'That import is no longer open.' };
  const window = tripWindow(tripId);
  const outcome = await prepareImport(parsed.data as ImportInput, window);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  const { prepared } = outcome;
  const now = new Date();
  const reading = prepared.image
    ? await readConfirmationPhotoWithModel({ image: prepared.image, tripWindow: window, caller: null, now })
    : await readConfirmationWithModel({
        redactedText: prepared.redactedText,
        hints: { ...window, ...(prepared.senderDomain ? { senderDomain: prepared.senderDomain } : {}), ...(prepared.subject ? { subject: prepared.subject } : {}) },
        caller: null,
        now,
      });
  if (!reading.ok) return { ok: false, error: reading.error };
  const record = recordImport(tripId, { sourceKind: prepared.sourceKind, extracted: reading.extracted, modelUsed: true });
  resolveImport(tripId, pending.id, { status: 'discarded' });
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, importId: record.id, sourceKind: prepared.sourceKind, extracted: reading.extracted, summary: describeExtraction(reading.extracted), photo: prepared.sourceKind === 'image', modelUsed: true };
}

/** The candidate the review screen holds: a booked fact minus what the server fills in. */
const importCandidateSchema = bookedPlanItemInputSchema.pick({ type: true, title: true, date: true, endDate: true, startTime: true, endTime: true, timeZone: true, location: true, baseId: true, placeId: true, provider: true, confirmationRef: true, url: true, cost: true, paid: true, refundable: true, cancellationDeadline: true, notes: true });
export type ImportCandidate = z.input<typeof importCandidateSchema>;

function candidateAsFact(tripId: string, candidate: z.output<typeof importCandidateSchema>): BookedPlanItem {
  return bookedPlanItemSchema.parse({ ...candidate, id: 'candidate', tripId, status: 'booked', locked: true, source: 'imported', createdAt: new Date().toISOString() });
}

export interface ImportPreviewResult extends HubActionResult {
  /** What confirming would change, in one sentence. */
  summary?: string;
  honored?: string[];
  conflicts?: string[];
  dayNumbers?: number[];
}

/**
 * The affected radius before anything is stored: the booked facts already on
 * the trip plus this candidate, applied to a copy of the pristine plan.
 */
export async function previewImportAction(tripId: string, candidate: unknown): Promise<ImportPreviewResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = importCandidateSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  let itinerary: Itinerary | null;
  try {
    itinerary = getItinerary(tripId);
  } catch {
    itinerary = null;
  }
  if (!itinerary) return { ok: true, summary: 'There is no plan to compare against yet; the booking will be kept and applied once one is built.', honored: [], conflicts: [], dayNumbers: [] };
  const fact = candidateAsFact(tripId, parsed.data);
  const applied = applyBookedFacts(itinerary, [...listBookedItems(tripId), fact]);
  return { ok: true, summary: applied.affected.summary, honored: applied.honored.filter((h) => h.startsWith(fact.title)), conflicts: applied.conflicts.filter((c) => c.includes(fact.title)), dayNumbers: applied.affected.dayNumbers };
}

/** The open need this fact answers, matched by type, then base, then date — or nothing. Never a guess across kinds. */
function matchNeed(tripId: string, fact: Pick<BookedPlanItem, 'type' | 'date' | 'baseId' | 'placeId'>): string | undefined {
  const needs = getTravelIntelligence(tripId)?.bookings.items.filter((b) => b.status === 'open' && !b.memberIds && BOOKED_TYPE_FOR_KIND[b.kind] === fact.type) ?? [];
  if (needs.length === 0) return undefined;
  if (fact.baseId) {
    const byBase = needs.find((n) => n.baseId === fact.baseId);
    if (byBase) return byBase.id;
  }
  if (fact.placeId) {
    const byPlace = needs.find((n) => n.placeId === fact.placeId);
    if (byPlace) return byPlace.id;
  }
  if (fact.date) {
    const byDate = needs.filter((n) => n.date === fact.date);
    if (byDate.length === 1) return byDate[0]!.id;
  }
  return undefined;
}

export async function confirmImportAction(tripId: string, importId: string, candidate: unknown): Promise<BookingActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = importCandidateSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, error: ISSUE_TEXT(parsed.error.issues) };
  const pending = getImport(tripId, String(importId));
  if (!pending || pending.status !== 'pending') return { ok: false, error: 'That import is no longer open.' };
  const bookingItemId = matchNeed(tripId, parsed.data);
  const item = addBookedItem(tripId, { ...parsed.data, status: 'booked', locked: true, source: 'imported', ...(bookingItemId ? { bookingItemId } : {}) });
  if (bookingItemId) clearBookingResolution(tripId, bookingItemId);
  resolveImport(tripId, pending.id, { status: 'confirmed', bookedItemId: item.id });
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, bookedItemId: item.id };
}

export async function discardImportAction(tripId: string, importId: string): Promise<HubActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const pending = getImport(tripId, String(importId));
  if (!pending) return { ok: false, error: 'That import is no longer open.' };
  if (pending.status === 'pending') resolveImport(tripId, pending.id, { status: 'discarded' });
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true };
}
