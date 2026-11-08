import { describe, expect, it } from 'vitest';
import type { Preflight, TravelIntelligence } from '@sidequest/core';
import { buildPrepareModel, firstSentence } from './prepare-model';

type Entry = TravelIntelligence['readiness']['entries'][number];

function entry(kind: string, extra: Partial<Entry> = {}): Entry {
  return { kind, title: kind, state: 'unverified', summary: `About ${kind}. More detail.`, links: [{ name: `${kind} source`, url: `https://example.org/${kind}` }], blocking: false, phase: 'do_now', tier: 'primary', ...extra } as Entry;
}

function intel(international: 'yes' | 'no' | 'unknown', entries: Entry[]): TravelIntelligence {
  return {
    destinationContext: { name: 'Somewhere', countryCode: 'PT', international, tripDays: 5, daysUntilTrip: 40, remote: false, drives: true },
    readiness: { international, entries, destinationCountry: 'PT' },
    bookings: { items: [] },
    packing: {
      items: [
        { id: 'p1', category: 'essential_documents', label: 'Passport or ID', why: 'At the border.', optional: false },
        { id: 'p2', category: 'transport', label: 'Offline maps for the whole route', why: 'No signal.', optional: false },
        { id: 'p3', category: 'outdoor', label: 'Trekking poles', why: 'Long descents.', optional: true },
      ],
    },
    safety: { official: [], practical: [], unknown: [] },
    weather: { days: [] },
  } as unknown as TravelIntelligence;
}

const BORDER = ['passport_validity', 'visa', 'health_document', 'advisory', 'local_law'];

function preflightFor(entries: Entry[], ready: string[] = []): Preflight {
  const items = entries.map((e) => ({ id: `preflight:readiness:${e.kind}`, category: 'documents' as const, title: e.title, href: '#x', bucket: ready.includes(e.kind) ? ('ready' as const) : ('attention' as const), checkId: `readiness:${e.kind}`, readinessKind: e.kind, readinessState: e.state }));
  return { verdict: 'not_yet', headline: '', daysUntilTrip: 40, ready: items.filter((i) => i.bucket === 'ready'), attention: items.filter((i) => i.bucket !== 'ready'), later: [] };
}

describe('the Prepare checklist model', () => {
  it('folds the border entries into one row to verify when the citizenship is unknown, carrying every tick and link', () => {
    const entries = [...BORDER.map((k) => entry(k, k === 'visa' ? { state: 'needs_input' } : {})), entry('connectivity', { phase: 'one_week_out' })];
    const model = buildPrepareModel({ intel: intel('unknown', entries), preflight: preflightFor(entries), checks: { packing: [], checklist: [] }, canTick: true });
    const border = model.book.filter((row) => BORDER.includes(row.preflight?.readinessKind ?? ''));
    expect(border).toHaveLength(1);
    expect(border[0]!.title).toMatch(/If you're coming from abroad/);
    expect(border[0]!.preflight).toMatchObject({ readinessKind: 'visa', readinessState: 'needs_input' });
    expect(border[0]!.tick?.map((t) => t.id).sort()).toEqual(BORDER.map((k) => `readiness:${k}`).sort());
    expect(border[0]!.links).toHaveLength(BORDER.length);
    expect(border[0]!.profileForm).toBe(true);
    /* Never asserted as a fact. */
    expect(JSON.stringify(model)).not.toMatch(/rarely applies abroad/);
  });

  it('lists each document separately once the citizenship is known, and none on a domestic trip', () => {
    const entries = BORDER.map((k) => entry(k));
    const abroad = buildPrepareModel({ intel: intel('yes', entries), preflight: preflightFor(entries), checks: { packing: [], checklist: [] }, canTick: true });
    const kinds = [...abroad.book, ...abroad.weeks].map((row) => row.preflight?.readinessKind);
    expect(kinds).toEqual(expect.arrayContaining(['passport_validity', 'visa', 'health_document', 'advisory']));
    expect(abroad.know.map((row) => row.key)).toContain('local_law');

    const home = buildPrepareModel({ intel: intel('no', BORDER.map((k) => entry(k, { state: 'not_applicable' }))), preflight: null, checks: { packing: [], checklist: [] }, canTick: true });
    expect(home.book).toHaveLength(0);
  });

  it('reads done from the persisted ticks and never lets a confirmed fact pass for a finished action', () => {
    const entries = [entry('visa'), entry('language', { state: 'confirmed', tier: 'primary' })];
    const model = buildPrepareModel({ intel: intel('yes', entries), preflight: preflightFor(entries, ['visa', 'language']), checks: { packing: ['p1'], checklist: [] }, canTick: true });
    expect(model.book.find((row) => row.preflight?.readinessKind === 'visa')?.done).toBe(true);
    const language = model.install.find((row) => row.preflight?.readinessKind === 'language')!;
    expect(language.done).toBe(false);
    expect(language.tick).toEqual([{ list: 'checklist', id: 'prepare:language' }]);
    expect(model.packed).toEqual({ done: 1, total: 2 });
  });

  it('moves offline maps from the bag to Install, and keeps optional gear in its own group', () => {
    const entries = [entry('connectivity', { phase: 'one_week_out' })];
    const model = buildPrepareModel({ intel: intel('unknown', entries), preflight: preflightFor(entries), checks: { packing: [], checklist: [] }, canTick: true });
    const offline = model.install.find((row) => row.preflight?.readinessKind === 'connectivity')!;
    expect(offline.tick?.map((t) => t.list)).toEqual(['preflight', 'packing']);
    expect(model.pack.flatMap((g) => g.rows).map((r) => r.title)).not.toContain('Offline maps for the whole route');
    expect(model.pack.find((g) => g.key === 'optional')?.rows.map((r) => r.title)).toEqual(['Trekking poles']);
  });

  it('writes no tick on a shared copy', () => {
    const entries = [entry('visa')];
    const model = buildPrepareModel({ intel: intel('yes', entries), preflight: preflightFor(entries), checks: { packing: [], checklist: [] }, canTick: false });
    expect([...model.book, ...model.weeks, ...model.install, ...model.pack.flatMap((g) => g.rows)].some((row) => row.tick)).toBe(false);
  });

  it('splits a summary at its first sentence', () => {
    expect(firstSentence('One thing. Then another.')).toEqual({ head: 'One thing.', rest: 'Then another.' });
    expect(firstSentence('No split here')).toEqual({ head: 'No split here', rest: '' });
  });
});
