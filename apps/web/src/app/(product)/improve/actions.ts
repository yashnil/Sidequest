'use server';

import { z } from 'zod';
import { PLAN_MAX_STOPS, PLAN_TEXT_MAX, critiquePlan, foldForMatch, parsePlanText, statedItinerarySchema, type DestinationIndexEntry, type ParsedPlan, type PlanCheckResult, type PlanCheckStopInput, type ResolvedParty } from '@sidequest/core';
import { knownPartyFor } from '@/lib/party/known-party';
import { entriesByPrefix } from '@/lib/db/destination-index-repository';
import { verificationProviders } from '@/lib/planning/verification-providers';
import { destinationConceptCache } from '@/lib/destinations/concept-cache';
import { guardAction } from '@/lib/net/caller';
import { placePlanStops, type PlacedPlanStop } from '@/lib/plan-check/resolve';
import { composerInputForPlan } from '@/lib/plan-check/to-composer';
import { createTripFromComposer } from '@/app/(product)/trips/new/actions';

/**
 * "I ALREADY HAVE A PLAN — OPTIMISE IT" (master prompt §7, Mode 3).
 *
 * Two actions and no model:
 *
 * - `checkPlanAction` reads the traveller's words (`parsePlanText`), places
 *   every stop through the semantic gate (`placePlanStops`) and returns the
 *   deterministic critique (`critiquePlan`). Its only external cost is the
 *   geocoder, behind its own fence and the thirty-day concept cache.
 * - `planFromCheckAction` turns the plan — as written, or with the
 *   suggestions applied — into an ordinary trip through the setup flow's own
 *   `createTripFromComposer`, so nothing downstream knows or cares where it
 *   started.
 */

export interface PlanCheckView {
  parsed: ParsedPlan;
  placed: PlacedPlanStop[];
  result: PlanCheckResult;
  /** The stops as the critique read them (placed, with nights and marks): what each version is measured from. */
  inputs: PlanCheckStopInput[];
  /** Who is going, and how that is known: their words, their saved travellers, or an assumption that asks. */
  party: ResolvedParty & { needsQuestion: boolean };
}

export type PlanCheckResponse = { ok: true; view: PlanCheckView } | { ok: false; error: string };

export async function checkPlanAction(raw: { text: string }): Promise<PlanCheckResponse> {
  const text = String(raw?.text ?? '').slice(0, PLAN_TEXT_MAX).trim();
  if (text.length < 3) return { ok: false, error: 'Paste or type your plan — the places in order, and how long if you know.' };
  const now = new Date();
  const parsed = parsePlanText(text, now);
  if (parsed.stops.length === 0) return { ok: false, error: 'We couldn’t find any places in that. Try one place per line, or a list like “Lisbon, Porto, the Douro Valley in 8 days”.' };

  const refusal = await guardAction('plan_check');
  if (refusal) return { ok: false, error: refusal };

  const { resolver } = verificationProviders();
  let placed: PlacedPlanStop[];
  try {
    placed = await placePlanStops({ stops: parsed.stops, contextCountries: parsed.contextCountries, resolver, now, cache: destinationConceptCache(), indexLookup: confidentIndexHit });
  } catch (error) {
    /* A provider that failed is not a plan that is wrong: every stop stays, unplaced. */
    console.warn('Plan check placement failed', { reason: error instanceof Error ? error.name : 'unknown' });
    placed = parsed.stops.map((s) => ({ label: s.label, placedName: null, point: null, countryCode: s.countryCode ?? null, kind: s.kind, source: null }));
  }
  const inputs: PlanCheckStopInput[] = placed.map((p, i) => {
      const s = parsed.stops[i]!;
      return { label: p.label, placedName: p.placedName, point: p.point, countryCode: p.countryCode, kind: p.kind, nights: s.nights, nightsBasis: s.nightsBasis, dayTrip: s.dayTrip, fixed: s.fixed, mustSee: s.mustSee, transportIn: s.transportIn, dates: s.dates };
  });
  const result = critiquePlan({ totalNights: parsed.totalNights, stops: inputs });
  const party = await knownPartyFor([text]);
  return { ok: true, view: { parsed, placed, inputs, result, party } };
}

const planSchema = z.object({
  stops: z
    .array(z.object({ label: z.string().trim().min(1).max(80), nights: z.number().int().min(0).max(60), dayTrip: z.boolean() }))
    .min(1)
    .max(PLAN_MAX_STOPS),
  totalNights: z.number().int().min(0).max(120).nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  month: z.number().int().min(1).max(12).nullable(),
  contextCountries: z.array(z.string().length(2)).max(4),
  /* Mode 3 — the version they chose (original + accepted changes) as the canonical stated itinerary. */
  statedItinerary: statedItinerarySchema.optional(),
  /* Who is going and how it is known; `assumed` when they skipped the question. */
  party: z.object({ adults: z.number().int().min(1).max(12), children: z.number().int().min(0).max(12), basis: z.enum(['stated', 'profile', 'assumed']) }).optional(),
});

export type PlanFromCheckInput = z.input<typeof planSchema>;

/**
 * The places are the traveller's own words either way: as written, or as the
 * critique rearranged them after they pressed "Plan the improved version". The
 * payload is validated here like any other client input and goes through the
 * same door — and the same fences — as the setup flow.
 */
export async function planFromCheckAction(raw: PlanFromCheckInput): Promise<{ ok: true; href: string } | { ok: false; error: string }> {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'That plan could not be read. Check it again and try once more.' };
  /* Its own fence, ahead of the trip door's: a plan is checked, then planned, and both presses draw from one bucket. */
  const refusal = await guardAction('plan_check');
  if (refusal) return { ok: false, error: refusal };
  const result = await createTripFromComposer(composerInputForPlan(parsed.data));
  if (!result.ok) return { ok: false, error: result.error ?? Object.values(result.fieldErrors ?? {})[0] ?? 'We could not start that trip. Nothing was lost — try again.' };
  return { ok: true, href: result.href };
}

/** The index row this name is unambiguously about — an exact folded name held by exactly one row — or nothing. */
function confidentIndexHit(folded: string): DestinationIndexEntry | null {
  if (folded.length < 2) return null;
  let rows: DestinationIndexEntry[];
  try {
    rows = entriesByPrefix(folded, 40);
  } catch {
    return null;
  }
  const exact = rows.filter((row) => foldForMatch(row.displayName) === folded || row.aliases.some((alias) => foldForMatch(alias) === folded));
  if (exact.length === 0) return null;
  const best = [...exact].sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0));
  if (best.length > 1 && (best[1]!.prominence ?? 0) === (best[0]!.prominence ?? 0)) return null;
  return best[0]!;
}
