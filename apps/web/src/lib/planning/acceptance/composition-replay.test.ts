import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '@/lib/providers/json-extract';
import { TRIP_DRAFT_JSON_TAG, normalizeTripDraftWire } from '../trip-draft-wire';

/**
 * EVERY PAID ANSWER SIDEQUEST HAS EVER RECEIVED, REPLAYED OFFLINE.
 *
 * MVP V3, A5/A6. The rule the founder's Hong Kong failure earned: a raw response
 * must run
 *
 *     raw text → extraction → wire normalization → TripDraft
 *
 * and either produce a draft, or fail with **one precise semantic reason**. There
 * is no third outcome, and "Sidequest couldn't finish this draft" with nothing
 * behind it is not an outcome at all.
 *
 * Every fixture here is a real, recorded `composition_attempts.raw_text`. Nothing
 * is hand-written, nothing is a destination special case, and no model call is
 * ever made to run this file. `index.json` says what each one is and what it must
 * do; a fixture that changes verdict fails the suite.
 */

interface ReplayCase {
  file: string;
  destination: string;
  days: number;
  stopReason: string;
  /** `draft` — a usable TripDraft. `semantic` — parses, then fails the audit for a nameable reason. */
  expect: 'draft' | 'semantic';
  note: string;
}

const DIR = join(__dirname, 'fixtures', 'composition');
const CASES = JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8')) as ReplayCase[];

function replay(entry: ReplayCase) {
  const raw = readFileSync(join(DIR, entry.file), 'utf8');
  const extracted = extractJsonObject(raw, { wrapperTag: TRIP_DRAFT_JSON_TAG });
  return { raw, extracted };
}

describe('every recorded composition answer replays offline', () => {
  it('the fixture set covers the failures that reached a founder', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(4);
    expect(CASES.filter((c) => c.destination === 'Hong Kong').length).toBeGreaterThanOrEqual(3);
  });

  for (const entry of CASES) {
    it(`${entry.file} — ${entry.expect === 'draft' ? 'becomes a TripDraft' : 'fails for one nameable reason'}`, () => {
      const { extracted } = replay(entry);
      expect(extracted.ok, `${entry.file}: ${extracted.ok ? '' : extracted.reason}`).toBe(true);
      if (!extracted.ok) return;

      const normalized = normalizeTripDraftWire(extracted.json, { days: entry.days });
      if (entry.expect === 'draft') {
        expect(normalized.ok, normalized.ok ? '' : JSON.stringify(normalized.issues.slice(0, 3))).toBe(true);
        if (!normalized.ok) return;
        expect(normalized.draft.days).toHaveLength(entry.days);
        expect(normalized.draft.bases.length).toBeGreaterThan(0);
        // A draft that parses but carries nothing to do is not a draft.
        expect(normalized.draft.days.reduce((n, day) => n + day.anchors.length, 0)).toBeGreaterThan(entry.days);
        return;
      }

      expect(normalized.ok).toBe(false);
      if (normalized.ok) return;
      expect(normalized.kind).toBe('semantic');
      const first = normalized.issues[0];
      expect(first).toBeDefined();
      // "One precise reason" means a path and a message a person can act on.
      expect(first!.message.length).toBeGreaterThan(10);
    });
  }
});

describe('the Hong Kong failure, specifically', () => {
  const first = CASES.find((c) => c.file === 'hong-kong-attempt-1.txt')!;

  it('was a complete answer, not a truncated or refused one', () => {
    const raw = readFileSync(join(DIR, first.file), 'utf8');
    expect(first.stopReason).toBe('end_turn');
    expect(raw).toContain(`<${TRIP_DRAFT_JSON_TAG}>`);
    expect(raw).toContain(`</${TRIP_DRAFT_JSON_TAG}>`);
  });

  it('was lost to exactly one structural slip, and salvage names it', () => {
    const { extracted } = replay(first);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.repairs).toEqual(['key_delimiter']);
  });

  it('recovers the whole trip the traveller never saw', () => {
    const { extracted } = replay(first);
    if (!extracted.ok) throw new Error('extraction failed');
    const normalized = normalizeTripDraftWire(extracted.json, { days: first.days });
    if (!normalized.ok) throw new Error(`normalization failed: ${JSON.stringify(normalized.issues.slice(0, 2))}`);
    expect(normalized.draft.days).toHaveLength(7);
    expect(normalized.draft.days.reduce((n, day) => n + day.anchors.length, 0)).toBeGreaterThanOrEqual(20);
    expect(normalized.draft.archetype).toBe('single_base_urban');
    expect(normalized.draft.package.packing.length).toBeGreaterThan(0);
    expect(normalized.draft.package.backups.length).toBeGreaterThan(0);
  });
});

/**
 * THE DEADLINE SALVAGE, ON A REAL ANSWER RATHER THAN A SYNTHETIC ONE.
 *
 * MVP V3, Stage 26. Two live Kyrgyzstan builds (2026-09-08) were cancelled at
 * Sidequest's own hundred-second deadline with 1,285 and 8,534 bytes of good
 * JSON already written, and both were discarded for a failure screen. The
 * transport now keeps what arrived and runs it through the same extraction,
 * repair and normalisation as any completed answer
 * (`anthropic-transport.test.ts` holds the transport half).
 *
 * This is the other half, and the half that decides whether the mechanism is
 * worth anything: what a *real* recorded answer does when the clock stops
 * partway through it. Neither cancelled run left a row to replay — nothing was
 * recorded on an abort until this pass — so the nearest real thing is a
 * recorded answer cut at the two places a deadline actually lands.
 *
 * The two outcomes below are the contract:
 *
 *   - cut inside the days → refused, because a trip missing day six is not a
 *     shorter trip, it is a broken one;
 *   - cut after the days → a usable draft, because the trailing package arrays
 *     are things the normaliser already treats as absent-is-empty.
 *
 * If that second case ever starts failing, the salvage is dead weight and
 * should be removed rather than kept as decoration.
 */
describe('a draft cut off at the deadline', () => {
  const complete = readFileSync(join(DIR, 'ireland-attempt-1.txt'), 'utf8');
  /** Everything up to and including the first complete JSON object, as the stream would have written it. */
  const body = complete.slice(0, complete.lastIndexOf(`</${TRIP_DRAFT_JSON_TAG}>`));

  it('is refused when the clock stopped partway through the days', () => {
    const daysAt = body.indexOf('"days"');
    expect(daysAt).toBeGreaterThan(0);
    // A third of the way into the day array: several days written, the rest gone.
    const cut = body.slice(0, daysAt + Math.round((body.length - daysAt) / 3));
    const extracted = extractJsonObject(cut, { wrapperTag: TRIP_DRAFT_JSON_TAG });
    if (!extracted.ok) return; // Refused at extraction is also a refusal.
    const normalized = normalizeTripDraftWire(extracted.json, { days: 10 });
    expect(normalized.ok, 'a trip missing days must not be salvaged into a plan').toBe(false);
  });

  it('is a usable trip when the clock stopped after them', () => {
    // Cut immediately after the day array closes, before the package prose.
    const daysAt = body.indexOf('"days"');
    const afterDays = body.indexOf('"omissions"', daysAt);
    expect(afterDays).toBeGreaterThan(daysAt);
    const cut = body.slice(0, afterDays);
    const extracted = extractJsonObject(cut, { wrapperTag: TRIP_DRAFT_JSON_TAG });
    expect(extracted.ok, 'the repair must close a tail the model never finished').toBe(true);
    if (!extracted.ok) return;
    expect(extracted.repairs).toContain('truncated_tail');
    const normalized = normalizeTripDraftWire(extracted.json, { days: 10 });
    expect(normalized.ok, normalized.ok ? '' : JSON.stringify(normalized.issues.slice(0, 2))).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.draft.days).toHaveLength(10);
    expect(normalized.draft.days.every((day) => day.anchors.length > 0 || day.dayNumber === 10)).toBe(true);
  });
});

/**
 * A SOFT CAP MUST NEVER COST A TRIP.
 *
 * The latency closure's one live call is the case, and it is worth stating
 * plainly because the two halves point in opposite directions.
 *
 * The model half worked: the compact wire and the trimmed prompt brought a
 * ten-day Kyrgyzstan draft home in **81.3 seconds** against a hundred-second
 * deadline, at `end_turn`, with every day, twenty-three experiences, the route,
 * the lodging character and a genuinely specific season rationale.
 *
 * Sidequest then threw it away. `timingRationale` was **256 characters against
 * a 240-character display cap** — a limit whose own constant calls it soft —
 * and the normaliser had no trim, so the canonical schema refused the draft and
 * the traveller saw the failure panel.
 *
 * The fix is that a capped sentence is now shortened and the shortening
 * recorded, which is structural repair and belongs exactly where the other
 * structural repairs are. This test is the proof against the real answer.
 */
describe('the live compact-wire answer', () => {
  const raw = readFileSync(join(DIR, 'kyrgyzstan-compact-1.txt'), 'utf8');

  it('is a complete answer that the old cap refused and the new trim accepts', () => {
    const extracted = extractJsonObject(raw, { wrapperTag: TRIP_DRAFT_JSON_TAG });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    // It parsed first time: no repair was needed at all.
    expect(extracted.repairs).toEqual([]);

    const before = extracted.json as { timingRationale?: string };
    expect(before.timingRationale!.length, 'the sentence that cost the trip').toBeGreaterThan(240);

    const normalized = normalizeTripDraftWire(extracted.json, { days: 10 });
    expect(normalized.ok, normalized.ok ? '' : JSON.stringify(normalized.issues.slice(0, 2))).toBe(true);
    if (!normalized.ok) return;

    // The whole trip survives, and the sentence is shortened rather than lost.
    expect(normalized.draft.days).toHaveLength(10);
    expect(normalized.draft.days.every((day) => day.anchors.length > 0)).toBe(true);
    expect(normalized.draft.days.reduce((n, d) => n + d.anchors.length, 0)).toBe(23);
    expect(normalized.draft.timingRationale!.length).toBeLessThanOrEqual(240);
    expect(normalized.draft.timingRationale).toMatch(/^Early July/);
    expect(normalized.normalizedFields.some((f) => f.startsWith('timingRationale ('))).toBe(true);
  });

  it('keeps the judgement the trip is made of', () => {
    const extracted = extractJsonObject(raw, { wrapperTag: TRIP_DRAFT_JSON_TAG });
    if (!extracted.ok) throw new Error('extraction failed');
    const normalized = normalizeTripDraftWire(extracted.json, { days: 10 });
    if (!normalized.ok) throw new Error('normalisation failed');
    const draft = normalized.draft;

    // The route it chose, and the nights adding up to the trip.
    expect(draft.bases.map((b) => b.name)).toEqual(['Bishkek', 'Karakol']);
    expect(draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(9);
    // Destination-defining experiences, not a generic city break.
    /*
     * The experiences that make this a Kyrgyzstan trip rather than a generic
     * one. Matched loosely on purpose: the point is that the draft goes to the
     * high lake, the red rocks, the canyon and the gorge above the capital,
     * not that it spells any of them a particular way.
     */
    const plan = [...draft.days.flatMap((d) => d.anchors.map((a) => a.name)), ...draft.days.map((d) => d.theme)].join(' | ');
    for (const defining of [/Ala\s*Kul/i, /Jeti[- ]?Oguz/i, /Skazka|Fairytale/i, /Ala\s*Archa/i]) {
      expect(defining.test(plan), `${defining} should be on the plan`).toBe(true);
    }
    // A private driver, and a guided section above the last driveable point.
    expect(draft.package.transport.summary).toMatch(/private driver/i);
    expect(draft.days.flatMap((d) => d.anchors.map((a) => a.transport))).toContain('guide_or_lodge_transfer');
    // And it says what it left out, and why.
    expect(draft.omissions.length).toBeGreaterThan(0);
  });
});
