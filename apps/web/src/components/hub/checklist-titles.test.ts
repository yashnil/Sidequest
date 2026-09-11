import { describe, expect, it } from 'vitest';
import { checklistRows, subjectOf } from './checklist-titles';

describe('checklist rows that share a title take their own subject', () => {
  const phase = [
    { id: 'eta', title: 'Set this up before you fly.', why: 'Entry needs an electronic authorisation issued in advance; rules and fees change, so use the official portal.' },
    { id: 'safari', title: 'Set this up before you fly.', why: 'Camps in the parks have few beds and the guide is the trip. Safari is done in a guided 4x4.' },
    { id: 'laws', title: 'Local laws and customs', why: 'Rules that surprise visitors are listed in the official advice for the destination.' },
  ];
  it('keeps a unique title as written', () => {
    const rows = checklistRows(phase);
    expect(rows[2]!.title).toBe('Local laws and customs');
    expect(rows[2]!.detail).toBe(phase[2]!.why);
  });
  it('titles duplicated rows by their first clause and keeps the phrase in the detail', () => {
    const rows = checklistRows(phase);
    expect(rows[0]!.title).toBe('Entry needs an electronic authorisation issued in advance');
    expect(rows[0]!.detail).toBe('Set this up before you fly. Rules and fees change, so use the official portal.');
    expect(rows[1]!.title).toBe('Camps in the parks have few beds and the guide is the trip');
    expect(rows[1]!.detail).toBe('Set this up before you fly. Safari is done in a guided 4x4.');
    expect(new Set(rows.map((row) => row.title)).size).toBe(rows.length);
  });
  it('shortens a very long clause at a word boundary', () => {
    const long = subjectOf('Fees, tips and markets are cash while lodges take cards and towns and markets run on cash with US dollars accepted for fees and tips and mobile money everywhere else');
    expect(long.length).toBeLessThanOrEqual(86);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });
  it('carries blocking and the source through', () => {
    const rows = checklistRows([{ id: 'x', title: 'Book a bed', why: 'The route depends on it.', blocking: true, sourceName: 'Official page', sourceUrl: 'https://example.org' }]);
    expect(rows[0]).toMatchObject({ blocking: true, sourceName: 'Official page', sourceUrl: 'https://example.org' });
  });
});
