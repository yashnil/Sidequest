import { describe, expect, it } from 'vitest';
import { balancedObjectEnd, extractJsonObject } from './json-extract';

/**
 * COMPOSITION RELIABILITY — the prompt-mode extractor against the ways a
 * model actually deviates. Every accepted case yields the same object; every
 * refused case names the reason. No content is ever invented.
 */
const DRAFT = { archetype: 'road_trip', days: [{ day: 1, activities: [{ name: 'A "quoted" place {with braces}' }] }] };
const TEXT = JSON.stringify(DRAFT);
const TAG = 'trip_draft_json';

describe('extractJsonObject accepts harmless deviations', () => {
  it('exact JSON', () => {
    const out = extractJsonObject(TEXT, { wrapperTag: TAG });
    expect(out).toMatchObject({ ok: true, source: 'bare', json: DRAFT });
  });
  it('whitespace and newlines around it', () => {
    expect(extractJsonObject(`\n\n   ${TEXT}\n\n`, { wrapperTag: TAG })).toMatchObject({ ok: true, json: DRAFT });
  });
  it('a ```json fence', () => {
    expect(extractJsonObject('```json\n' + TEXT + '\n```', { wrapperTag: TAG })).toMatchObject({ ok: true, source: 'fenced', json: DRAFT });
  });
  it('a bare ``` fence', () => {
    expect(extractJsonObject('```\n' + TEXT + '\n```')).toMatchObject({ ok: true, source: 'fenced', json: DRAFT });
  });
  it('the XML wrapper', () => {
    expect(extractJsonObject(`<${TAG}>\n${TEXT}\n</${TAG}>`, { wrapperTag: TAG })).toMatchObject({ ok: true, source: 'wrapped', json: DRAFT });
  });
  it('the XML wrapper around a fence, with prose before and after', () => {
    const text = `Sure — here it is.\n<${TAG}>\n\`\`\`json\n${TEXT}\n\`\`\`\n</${TAG}>\nTell me if you want changes.`;
    expect(extractJsonObject(text, { wrapperTag: TAG })).toMatchObject({ ok: true, source: 'wrapped', json: DRAFT });
  });
  it('surrounding text without any wrapper', () => {
    const text = `Here is the draft: ${TEXT} — hope it helps {not json}`;
    expect(extractJsonObject(text, { wrapperTag: TAG })).toMatchObject({ ok: true, source: 'embedded', json: DRAFT });
  });
  it('a non-object first brace followed by the real object', () => {
    const text = `{oops} then ${TEXT}`;
    expect(extractJsonObject(text)).toMatchObject({ ok: true, json: DRAFT });
  });
  it('escaped quotes and braces inside strings do not confuse the scan', () => {
    const tricky = JSON.stringify({ why: 'He said \\"go\\" } { and left', name: 'x' });
    expect(balancedObjectEnd(tricky, 0)).toBe(tricky.length);
    expect(extractJsonObject(tricky)).toMatchObject({ ok: true, json: JSON.parse(tricky) });
  });
  it('a wrapper that only opens falls through to the fence or the bare object', () => {
    expect(extractJsonObject(`<${TAG}>\n${TEXT}`, { wrapperTag: TAG })).toMatchObject({ ok: true, json: DRAFT });
  });
});

describe('extractJsonObject refuses precisely', () => {
  it('empty text', () => {
    expect(extractJsonObject('   \n')).toMatchObject({ ok: false, reason: 'empty' });
  });
  it('no JSON at all', () => {
    expect(extractJsonObject('I cannot plan this trip without more information.')).toMatchObject({ ok: false, reason: 'no_object' });
  });
  it('balanced but invalid JSON (single quotes)', () => {
    expect(extractJsonObject("{ 'archetype': 'road_trip', }").ok).toBe(false);
  });
  it('a JSON array is not the draft', () => {
    expect(extractJsonObject('[1, 2, 3]')).toMatchObject({ ok: false, reason: 'no_object' });
  });
  it('never invents content: the refusal carries no json', () => {
    const out = extractJsonObject('nothing here');
    expect(out.ok).toBe(false);
    expect('json' in out).toBe(false);
  });
});

/**
 * MVP V3 — SALVAGE IS THE SECOND PASS, NEVER THE FIRST.
 *
 * A truncated answer used to be refused outright; the repairs in
 * `json-repair.ts` mean it now arrives short and honest instead, with the tail
 * the model never finished discarded rather than guessed at. What must not
 * change is that a strictly valid answer is passed through untouched, and that
 * a salvage which cannot be made honestly is still a refusal.
 */
describe('salvage', () => {
  it('leaves a valid answer completely alone', () => {
    const out = extractJsonObject(TEXT, { wrapperTag: TAG });
    expect(out).toMatchObject({ ok: true, repairs: [] });
  });
  it('recovers a truncated object by discarding the unfinished tail', () => {
    const out = extractJsonObject(TEXT.slice(0, TEXT.length - 12), { wrapperTag: TAG });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.repairs).toContain('truncated_tail');
  });
  it('recovers a key that swallowed its delimiter', () => {
    const out = extractJsonObject('{"days":[{"day":1,"stay":"A"},{"day2,"stay":"B"}]}');
    expect(out).toMatchObject({ ok: true, repairs: ['key_delimiter'] });
    expect((out as { json: { days: { day: number }[] } }).json.days[1]!.day).toBe(2);
  });
  it('still refuses text with no object in it at all', () => {
    expect(extractJsonObject('I cannot plan this trip.')).toMatchObject({ ok: false });
  });
});
