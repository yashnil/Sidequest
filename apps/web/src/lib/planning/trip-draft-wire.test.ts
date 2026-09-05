import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildTravelerProfile, defaultAnswers, type Trip } from '@sidequest/core';
import { extractJsonObject } from '@/lib/providers/json-extract';
import type { StructuredModel } from '@/lib/providers/interpretation-model';
import { COMPOSITION_INSTRUCTION, buildCompositionTask, compositionWireDecision, generateTripDraft, type CompositionContext } from './composition';
import { buildHybridTripRequest } from './hybrid-request';
import { travelerBriefFor } from './production-plan';
import { TRIP_DRAFT_JSON_TAG, normalizeTripDraftWire, tripDraftWireSchema } from './trip-draft-wire';
import { tripDraftSchema } from './trip-draft';

/**
 * COMPOSITION RELIABILITY — the wire layer. What Claude emits is normalized
 * deterministically into the canonical draft; harmless deviations are
 * accepted and listed, semantic failures are refused with the exact path,
 * and nothing is ever invented. The two real live drafts (East Africa,
 * Tasmania) replay through the same path with zero model calls.
 */
const FIXTURES = resolve(__dirname, 'acceptance/fixtures/live');
const read = (name: string) => readFileSync(resolve(FIXTURES, name), 'utf8');

function wireDraft(days = 3) {
  return {
    archetype: 'single_base_urban',
    purpose: 'A compact city break.',
    routeRationale: 'One base, everything on foot.',
    assumptions: [],
    tradeoffs: [],
    stays: [{ name: 'Old Town', locality: null, nights: days - 1, why: 'Central', lodgingArea: null, lodgingStyle: null }],
    days: Array.from({ length: days }, (_, i) => ({
      day: i + 1,
      stay: 'Old Town',
      theme: `Day ${i + 1}`,
      intensity: 'moderate',
      relocation: false,
      activities: [{ name: `Stop ${i + 1}`, locality: null, category: 'landmark', role: 'core', minutes: 90, transport: 'walk', why: 'Worth it' }],
      breakfast: null,
      lunch: null,
      dinner: null,
      note: null,
      whyItFits: null,
    })),
    omissions: [],
    unresolved: [],
    bookingPriorities: [],
    foodStrategy: [],
    transportSummary: 'On foot.',
    transportNotes: [],
    beforeYouGo: [],
    packing: [],
    backups: [],
  };
}

describe('normalizeTripDraftWire — tolerant where harmless', () => {
  it('a clean wire draft becomes a canonical draft with generated ids and derived day numbers', () => {
    const out = normalizeTripDraftWire(wireDraft(), { days: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.bases[0]!.id).toMatch(/^[a-z0-9-]+$/);
    expect(out.draft.days.map((d) => d.dayNumber)).toEqual([1, 2, 3]);
    expect(out.draft.days.every((d) => d.baseId === out.draft.bases[0]!.id)).toBe(true);
    expect(tripDraftSchema.safeParse(out.draft).success).toBe(true);
  });
  it('the wire schema itself accepts the clean draft (what grammar mode would enforce)', () => {
    expect(tripDraftWireSchema.safeParse(wireDraft()).success).toBe(true);
  });
  it('the full deviation fixture: prose, wrapper, fence, numeric strings, enum casing, extra fields, absent optionals, duplicates, clamping', () => {
    const extracted = extractJsonObject(read('prompt-mode-deviations.txt'), { wrapperTag: TRIP_DRAFT_JSON_TAG });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.source).toBe('wrapped');
    const out = normalizeTripDraftWire(extracted.json, { days: 4 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { draft, normalizedFields } = out;
    expect(draft.archetype).toBe('road_trip');
    expect(draft.bases.map((b) => b.nights)).toEqual([2, 1]);
    expect(draft.days[0]!.anchors).toHaveLength(1); // the same-day duplicate is dropped
    expect(draft.days[0]!.anchors[0]).toMatchObject({ category: 'neighbourhood', role: 'core', estimatedDurationMinutes: 90, transport: 'walk' });
    expect(draft.days[1]!.baseId).toBe(draft.bases[0]!.id); // "harbour town" matched case-insensitively
    expect(draft.days[1]!.anchors[0]).toMatchObject({ category: 'viewpoint', transport: 'car' }); // Cliffs → viewpoint, Self-drive → car
    expect(draft.days[1]!.anchors[1]!.estimatedDurationMinutes).toBe(600); // 900 clamped
    expect(draft.days[2]!.relocation).toBe(true);
    expect(draft.days[3]!.anchors).toEqual([]);
    expect(draft.purpose).not.toContain('http'); // URLs stripped
    expect(draft.package.packing).toEqual([]);
    expect(draft.package.backups).toEqual([]);
    expect(normalizedFields.join('\n')).toMatch(/stays\[0\]\.nights \(string → number\)/);
    expect(normalizedFields.join('\n')).toMatch(/duplicate/);
    expect(normalizedFields.join('\n')).toMatch(/clamped/);
    expect(tripDraftSchema.safeParse(draft).success).toBe(true);
  });
  it('canonical aliases (bases / anchors / dayNumber / meals / package) are read too', () => {
    const canonical = JSON.parse(read('tasmania-draft.json')) as { days: unknown[] };
    const out = normalizeTripDraftWire(canonical, { days: canonical.days.length });
    expect(out.ok).toBe(true);
  });
  it('unknown keys are ignored, never an error', () => {
    const out = normalizeTripDraftWire({ ...wireDraft(), confidence: 0.9, reasoning: 'long', days: wireDraft().days.map((d) => ({ ...d, mood: 'x' })) }, { days: 3 });
    expect(out.ok).toBe(true);
  });
});

describe('normalizeTripDraftWire — precise where it matters', () => {
  it('malformed root', () => {
    expect(normalizeTripDraftWire('nope')).toMatchObject({ ok: false, kind: 'structural', issues: [{ path: '', code: 'not_an_object', received: 'string' }] });
    expect(normalizeTripDraftWire([])).toMatchObject({ ok: false, issues: [{ received: 'array' }] });
  });
  it('semantically incomplete: no stays, no days', () => {
    const out = normalizeTripDraftWire({ archetype: 'road_trip', purpose: 'x' }, { days: 3 });
    expect(out).toMatchObject({ ok: false, kind: 'semantic' });
    if (out.ok) return;
    expect(out.issues.map((i) => `${i.path}:${i.code}`)).toEqual(['stays:empty', 'days:empty']);
    expect(out.issues[1]!.expected).toBe('3 days');
  });
  it('wrong day count is refused, not padded or trimmed', () => {
    const out = normalizeTripDraftWire(wireDraft(3), { days: 5 });
    expect(out).toMatchObject({ ok: false, kind: 'semantic', issues: [{ path: 'days', code: 'day_count', expected: '5 days', received: '3 days' }] });
  });
  it('a day naming an undeclared stay', () => {
    const draft = wireDraft(3);
    draft.days[1]!.stay = 'Somewhere Else';
    const out = normalizeTripDraftWire(draft, { days: 3 });
    expect(out).toMatchObject({ ok: false, kind: 'semantic', issues: [{ path: 'days[1].stay', code: 'unknown_stay', received: 'Somewhere Else', expected: 'Old Town' }] });
  });
  it('invalid nights', () => {
    const draft = wireDraft(3) as unknown as { stays: { nights: unknown }[] };
    draft.stays[0]!.nights = 'two';
    const out = normalizeTripDraftWire(draft, { days: 3 });
    expect(out).toMatchObject({ ok: false, kind: 'semantic' });
    if (out.ok) return;
    expect(out.issues[0]).toMatchObject({ path: 'stays[0].nights', code: 'invalid_number', expected: 'number ≥ 0', received: 'two' });
  });
  it('a nameless activity is refused rather than named for the model', () => {
    const draft = wireDraft(3) as unknown as { days: { activities: Record<string, unknown>[] }[] };
    draft.days[0]!.activities.push({ category: 'museum', why: 'no name' });
    const out = normalizeTripDraftWire(draft, { days: 3 });
    expect(out).toMatchObject({ ok: false, issues: [{ path: 'days[0].activities[1].name', code: 'missing' }] });
  });
  it('a day that is not an object', () => {
    const draft = wireDraft(3) as unknown as { days: unknown[] };
    draft.days[2] = 'day three';
    expect(normalizeTripDraftWire(draft, { days: 3 })).toMatchObject({ ok: false, issues: [{ path: 'days[2]', code: 'not_an_object' }] });
  });
});

describe('replay of the live drafts — zero model calls', () => {
  for (const name of ['east-africa', 'tasmania']) {
    it(`${name}: the persisted draft normalizes to itself`, () => {
      const stored = JSON.parse(read(`${name}-draft.json`)) as ReturnType<typeof tripDraftSchema.parse>;
      const out = normalizeTripDraftWire(stored, { days: stored.days.length });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.draft.days.length).toBe(stored.days.length);
      expect(out.draft.bases.map((b) => b.name)).toEqual(stored.bases.map((b) => b.name));
      expect(out.draft.days.map((d) => d.anchors.map((a) => a.name))).toEqual(stored.days.map((d) => d.anchors.map((a) => a.name)));
      expect(out.draft.archetype).toBe(stored.archetype);
    });
  }
});

// ---------------------------------------------------------------------------
// generateTripDraft — one call, mode chosen locally, raw before parse
// ---------------------------------------------------------------------------
const NOW = new Date('2026-09-04T10:00:00Z');
const TRIP: Trip = {
  id: 'trip-1',
  basics: { mode: 'known_destination', destinationInput: 'Green Isle', regionId: 'dynamic', startDate: '2026-05-10', endDate: '2026-05-12', arrivalTime: '11:00', departureTime: '09:00', adults: 2, children: 0, travelerNeeds: [] },
  status: 'draft',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};
function contextFor(): CompositionContext {
  const profile = buildTravelerProfile(defaultAnswers({ travelerNeeds: [], tripDays: 3 }), { travelerNeeds: [], tripDays: 3 });
  const request = buildHybridTripRequest({ trip: TRIP, composer: null, profile, now: NOW });
  const envelope = { name: 'Green Isle', center: { lat: 53.4, lng: -8 } };
  return { request, envelope, brief: travelerBriefFor({ profile, trip: TRIP, request, envelope }), mode: 'full' };
}

function fakeModel(answer: unknown, seen: { inputs: Record<string, unknown>[] }): StructuredModel {
  return {
    callsRemaining: 1,
    callLog: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
    async structured<T>(input: Parameters<StructuredModel['structured']>[0]): Promise<T> {
      seen.inputs.push(input as unknown as Record<string, unknown>);
      input.onResponse?.({ text: JSON.stringify(answer), stopReason: 'end_turn', requestId: 'req_test', inputTokens: 10, outputTokens: 20, elapsedMs: 5, enforcement: input.schemaEnforcement ?? 'prompt' });
      return (input.validationSchema ?? input.schema).parse(answer) as T;
    },
  } as unknown as StructuredModel;
}

describe('generateTripDraft', () => {
  it('chooses the mode before the request, forbids the paid fallback, asks for the wrapper, validates loosely, and hands the raw text over first', async () => {
    const seen = { inputs: [] as Record<string, unknown>[] };
    const raws: string[] = [];
    const out = await generateTripDraft({ model: fakeModel(wireDraft(3), seen), context: contextFor(), onRawResponse: (raw) => raws.push(raw.text) });
    expect(out.ok).toBe(true);
    expect(seen.inputs).toHaveLength(1);
    const input = seen.inputs[0]!;
    expect(input.schema).toBe(tripDraftWireSchema);
    expect(input.allowEnforcementFallback).toBe(false);
    expect(input.jsonWrapperTag).toBe(TRIP_DRAFT_JSON_TAG);
    expect(input.schemaEnforcement).toBe(compositionWireDecision().enforcement);
    expect((input.validationSchema as z.ZodType).safeParse({ anything: true }).success).toBe(true);
    expect(raws).toHaveLength(1);
    if (out.ok) expect(out.enforcement).toBe(compositionWireDecision().enforcement);
  });
  it('a semantically wrong answer fails once with the exact path — no second call', async () => {
    const seen = { inputs: [] as Record<string, unknown>[] };
    const out = await generateTripDraft({ model: fakeModel(wireDraft(2), seen), context: contextFor() });
    expect(seen.inputs).toHaveLength(1);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failureKind).toBe('malformed_output');
    expect(out.issueKind).toBe('semantic');
    expect(out.issues?.[0]).toMatchObject({ path: 'days', code: 'day_count', expected: '3 days', received: '2 days' });
    expect(out.detail).not.toMatch(/end_turn|Zod|grammar/);
  });
  it('the prompt names the wire fields, not the canonical ones', () => {
    const task = buildCompositionTask(contextFor());
    expect(task).toMatch(/day 1 to day 3/);
    expect(COMPOSITION_INSTRUCTION).toMatch(/stays \(name = the town/);
    expect(COMPOSITION_INSTRUCTION).not.toMatch(/baseId|dayNumber|estimatedDurationMinutes/);
  });
});
