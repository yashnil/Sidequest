'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { bookedPlanItemInputSchema, travelReadinessProfileSchema, type Itinerary } from '@sidequest/core';
import { addBookedItem, clearReadinessProfile, removeBookedItem, saveReadinessProfile, setCheck, updateBookedItem } from '@/lib/db/intelligence-repository';
import {
  easeDay,
  removeStopFromDay,
  swapAlternativesForStop,
  swapStopOnDay,
  type ItineraryEditResult,
  type PlannerInput,
} from '@sidequest/planner';
import { type BuildResult, plannerInputForTrip } from '@/lib/planning/build';
import { generateSidequestPlanForTrip } from '@/lib/planning/production-plan';
import { addCustomStop, easeReconciledDay, isReconciledItinerary, moveStopToDay, removeStopFromReconciledItinerary, setStopDuration, setStopKeep, shiftStop } from '@/lib/planning/reconciled-edits';
import { repairReconciledDay } from '@/lib/planning/day-repair';
import { discoverFoodNear, discoverStaysNear } from '@/lib/providers/discovery';
import {
  clearItineraryLock,
  ensureShareToken,
  getItinerary,
  getTrip,
  saveItinerary,
  setItineraryLock,
  setSelection,
  tripOwnerToken,
} from '@/lib/db/repository';
import { sessionToken } from '@/lib/net/caller';
import { tripAccessRefusal } from '@/lib/net/trip-access';

export type { BuildResult } from '@/lib/planning/build';

/*
 * Every action in this file edits or rebuilds somebody's plan, so every one
 * starts with the same question `deleteTripAction` and `createShareLinkAction`
 * already ask: does the asking browser own this trip? The check lives in
 * `lib/net/trip-access`; the read-only /share/<token> view is the one door
 * that stays open without it.
 */

/**
 * Builds and stores the itinerary, then navigates to it.
 *
 * The canonical production orchestrator (`generateSidequestPlanForTrip` —
 * "Claude authors a complete useful trip; Sidequest verifies and improves
 * it") is the default generation path this action reaches. It owns model
 * composition, targeted verification, routing/relocation remediation and
 * the draft-anchor scheduling bridge; this action stays thin — cache
 * invalidation and navigation only, exactly as before. The old pure-
 * deterministic `build.ts#buildItinerary()` (`planTrip()` with no model at
 * all) remains available for rollback/comparison but is no longer what this
 * button calls. Both persist through the identical `saveItinerary()`/
 * `getItinerary()` seam, so nothing downstream of this action — editing,
 * sharing, the itinerary page itself — needed to change.
 */
export async function buildItineraryAction(tripId: string): Promise<BuildResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };

  const generated = await generateSidequestPlanForTrip(tripId, { caller: 'itinerary_build_action', mode: 'full' });
  const result: BuildResult = generated.ok
    ? { ok: true, ...(generated.result ? { readiness: generated.result.readiness } : {}) }
    : { ok: false, error: generated.error ?? 'We could not build a plan just now.' };
  if (!result.ok) return result;

  revalidatePath(`/trips/${tripId}/itinerary`);
  // `redirect` throws, so nothing below it runs and the caller never sees this
  // return. It is here because a function typed as returning a result should
  // not rely on a thrown control-flow signal to satisfy its own signature.
  redirect(`/trips/${tripId}/itinerary`);
  return result;
}

/**
 * "Regenerate" on the itinerary page — the same canonical generation as
 * "Build my trip", reached from the plan itself. One model call, a fresh
 * draft, verified and reconciled the same way, replacing the stored plan.
 */
export async function regenerateItineraryAction(tripId: string): Promise<BuildResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const generated = await generateSidequestPlanForTrip(tripId, { caller: 'itinerary_regenerate_action', mode: 'full' });
  if (!generated.ok) return { ok: false, error: generated.error ?? 'We could not regenerate your trip just now.' };
  revalidatePath(`/trips/${tripId}/itinerary`);
  return { ok: true, ...(generated.result ? { readiness: generated.result.readiness } : {}) };
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

  const owner = tripOwnerToken(tripId);
  const asking = await sessionToken({ mint: false });
  if (!owner || !asking || owner !== asking) {
    return {
      ok: false,
      error: 'This trip was made in a different browser, so only that browser can share it.',
    };
  }

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

export async function setCheckAction(tripId: string, list: 'packing' | 'checklist', itemId: string, checked: boolean): Promise<HubActionResult> {
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
  items?: { name: string; distanceKm: number; priceLevel?: string; rating?: number; ratingCount?: number; mapsUri?: string; website?: string; address?: string }[];
}

function forDisplay(result: Awaited<ReturnType<typeof discoverStaysNear>>): DiscoveryActionResult {
  return {
    ok: true,
    available: result.available,
    provider: result.provider,
    ...(result.attribution ? { attribution: result.attribution } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    items: result.items.map((p) => ({ name: p.name, distanceKm: p.distanceKm, ...(p.priceLevel ? { priceLevel: p.priceLevel } : {}), ...(p.rating !== undefined ? { rating: p.rating } : {}), ...(p.ratingCount !== undefined ? { ratingCount: p.ratingCount } : {}), ...(p.mapsUri ? { mapsUri: p.mapsUri } : {}), ...(p.website ? { website: p.website } : {}), ...(p.address ? { address: p.address } : {}) })),
  };
}

/** One bounded lookup for display; nothing is stored. Live prices and availability are never part of the answer. */
export async function discoverStaysAction(tripId: string, near: { lat: number; lng: number }, query?: string): Promise<DiscoveryActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!Number.isFinite(near?.lat) || !Number.isFinite(near?.lng)) return { ok: false, error: 'That base has no verified position to search around.' };
  return forDisplay(await discoverStaysNear({ near, ...(query ? { query: query.slice(0, 60) } : {}) }));
}

export async function discoverFoodAction(tripId: string, near: { lat: number; lng: number }, query?: string): Promise<DiscoveryActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!Number.isFinite(near?.lat) || !Number.isFinite(near?.lng)) return { ok: false, error: 'That stop has no verified position to search around.' };
  return forDisplay(await discoverFoodNear({ near, ...(query ? { query: query.slice(0, 60) } : {}) }));
}
