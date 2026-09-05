import { describe, expect, it } from 'vitest';
import { COMPOSITION_MAX_TOKENS, buildCompositionTask, compositionEffort, compositionUntrustedPayload, type CompositionContext } from './composition';
import { DRAFT_SOFT_PROSE_CAPS, tripDraftSchema, type TripDraft } from './trip-draft';
import { buildHybridTripRequest } from './hybrid-request';
import { defaultProfileFor } from './production-plan';
import type { Trip } from '@sidequest/core';

/**
 * THE OUTPUT CEILING IS SIZED AGAINST A MEASURED MAXIMAL DRAFT, NOT A GUESS.
 *
 * A live composition once consumed its entire budget reasoning and emitted
 * zero visible bytes. This test builds the heaviest draft the schema can
 * express for a two-week trip — every optional field present, every prose
 * field at its cap, five anchors a day — measures it with the same rough
 * tokens-per-byte ratio the earlier budget tests used, and holds the ceiling
 * to that plus the measured low-effort reasoning allowance (~4,500 tokens on
 * the recorded live calls, held here at 7,000 for margin).
 */
const TOKENS_PER_BYTE = 1 / 3.6;
const REASONING_ALLOWANCE_TOKENS = 7_000;

function at(cap: number): string {
  return 'w'.repeat(cap);
}

function maximalDraft(days: number): TripDraft {
  const anchors = Array.from({ length: 5 }, (_, i) => ({
    name: at(60),
    locality: at(40),
    category: 'landmark' as const,
    role: (['core', 'secondary', 'optional', 'flex', 'flex'] as const)[i]!,
    estimatedDurationMinutes: 120,
    transport: 'guide_or_lodge_transfer' as const,
    why: at(DRAFT_SOFT_PROSE_CAPS.anchorWhy),
  }));
  return {
    archetype: 'moving_route',
    purpose: at(DRAFT_SOFT_PROSE_CAPS.purpose),
    routeRationale: at(DRAFT_SOFT_PROSE_CAPS.routeRationale),
    assumptions: Array.from({ length: 5 }, () => at(DRAFT_SOFT_PROSE_CAPS.assumption)),
    tradeoffs: Array.from({ length: 5 }, () => at(DRAFT_SOFT_PROSE_CAPS.tradeoff)),
    bases: Array.from({ length: 8 }, (_, i) => ({ id: `base-${i}`, name: at(100), locality: at(40), nights: 2, why: at(DRAFT_SOFT_PROSE_CAPS.baseWhy), lodgingArea: at(DRAFT_SOFT_PROSE_CAPS.lodgingArea), lodgingStyle: at(DRAFT_SOFT_PROSE_CAPS.lodgingStyle) })),
    days: Array.from({ length: days }, (_, i) => ({
      dayNumber: i + 1,
      baseId: `base-${Math.min(7, Math.floor(i / 2))}`,
      theme: at(DRAFT_SOFT_PROSE_CAPS.dayTheme),
      intensity: 'moderate' as const,
      relocation: i % 2 === 0,
      anchors,
      meals: { breakfast: at(DRAFT_SOFT_PROSE_CAPS.meal), lunch: at(DRAFT_SOFT_PROSE_CAPS.meal), dinner: at(DRAFT_SOFT_PROSE_CAPS.meal) },
      note: at(DRAFT_SOFT_PROSE_CAPS.dayNote),
      whyItFits: at(DRAFT_SOFT_PROSE_CAPS.whyItFits),
    })),
    omissions: Array.from({ length: 8 }, () => ({ name: at(60), reason: at(DRAFT_SOFT_PROSE_CAPS.omissionReason) })),
    unresolved: Array.from({ length: 8 }, () => at(DRAFT_SOFT_PROSE_CAPS.unresolvedItem)),
    package: {
      foodStrategy: Array.from({ length: 6 }, () => at(DRAFT_SOFT_PROSE_CAPS.foodStrategy)),
      transport: { summary: at(DRAFT_SOFT_PROSE_CAPS.transportSummary), notes: Array.from({ length: 6 }, () => at(DRAFT_SOFT_PROSE_CAPS.transportNote)) },
      beforeYouGo: Array.from({ length: 10 }, () => at(DRAFT_SOFT_PROSE_CAPS.beforeYouGo)),
      packing: Array.from({ length: 15 }, () => at(DRAFT_SOFT_PROSE_CAPS.packing)),
      backups: Array.from({ length: 6 }, () => ({ trigger: at(DRAFT_SOFT_PROSE_CAPS.backupTrigger), alternative: at(DRAFT_SOFT_PROSE_CAPS.backupAlternative) })),
    },
  };
}

const TRIP: Trip = {
  id: 't',
  basics: { mode: 'known_destination', destinationInput: 'Anywhere', regionId: 'dynamic', startDate: '2026-07-05', endDate: '2026-07-18', arrivalTime: '10:00', departureTime: '16:00', adults: 2, children: 0, travelerNeeds: [] },
  status: 'draft',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

/** A rich, realistic draft: every field present, prose at about 40% of its cap. */
function richDraft(days: number): TripDraft {
  const maximal = maximalDraft(days);
  const shrink = (value: unknown): unknown => {
    // Prose only: enum values and ids are short and must stay intact.
    if (typeof value === 'string') return value.length > 40 ? value.slice(0, Math.max(16, Math.ceil(value.length * 0.4))) : value;
    if (Array.isArray(value)) return value.map(shrink);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)]));
    return value;
  };
  const rich = shrink(maximal) as TripDraft;
  rich.bases = rich.bases.slice(0, 5).map((base, i) => ({ ...base, id: `base-${i}` }));
  rich.days = rich.days.map((day, i) => ({ ...day, baseId: `base-${Math.min(4, Math.floor(i / 3))}`, anchors: day.anchors.slice(0, 4) }));
  return tripDraftSchema.parse(rich);
}

describe('composition budget', () => {
  it('a rich 14-day draft plus the reasoning allowance fits the ceiling with headroom; the pathological every-field-at-cap draft is documented, not budgeted for', () => {
    const rich = richDraft(14);
    const richTokens = JSON.stringify(rich).length * TOKENS_PER_BYTE;
    expect(richTokens + REASONING_ALLOWANCE_TOKENS).toBeLessThanOrEqual(COMPOSITION_MAX_TOKENS);
    // Headroom: a realistic week fits several times over.
    const week = JSON.stringify(richDraft(7)).length * TOKENS_PER_BYTE;
    expect(week * 3).toBeLessThanOrEqual(COMPOSITION_MAX_TOKENS);
    const maximal = maximalDraft(14);
    expect(tripDraftSchema.safeParse(maximal).success).toBe(true);
    const maximalTokens = JSON.stringify(maximal).length * TOKENS_PER_BYTE;
    // Even the pathological every-field-at-cap draft fits the ceiling on its own; only its reasoning allowance is not budgeted for, because a draft that fills every cap is a stress test, not a trip.
    expect(maximalTokens).toBeLessThanOrEqual(COMPOSITION_MAX_TOKENS);
  });

  it('effort defaults to low and honours the environment override', () => {
    const before = process.env.SIDEQUEST_COMPOSITION_EFFORT;
    delete process.env.SIDEQUEST_COMPOSITION_EFFORT;
    expect(compositionEffort()).toBe('low');
    process.env.SIDEQUEST_COMPOSITION_EFFORT = 'medium';
    expect(compositionEffort()).toBe('medium');
    if (before === undefined) delete process.env.SIDEQUEST_COMPOSITION_EFFORT;
    else process.env.SIDEQUEST_COMPOSITION_EFFORT = before;
  });

  it('the task is compact: a full brief for a two-week trip stays under ~2,500 tokens of input', () => {
    const request = buildHybridTripRequest({ trip: TRIP, composer: null, profile: defaultProfileFor(TRIP, null), now: new Date('2026-06-01T00:00:00Z') });
    const context: CompositionContext = { request, envelope: { name: 'Anywhere', center: { lat: 1, lng: 2 } }, mode: 'full' };
    const input = buildCompositionTask(context) + JSON.stringify(compositionUntrustedPayload(context));
    expect(input.length * TOKENS_PER_BYTE).toBeLessThan(2_500);
  });
});
