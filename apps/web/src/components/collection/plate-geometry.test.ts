import { describe, expect, it } from 'vitest';
import { ledgerMark, ledgerWords, monogram, partyCounts, scaleBar } from './plate-geometry';
import { projectShape } from './stamp-geometry';

const base = { id: 'a', destination: 'Hong Kong', startDate: '2026-10-13', nights: 5, party: '3 adults', timing: 'fixed' as const, lifecycle: 'past' };

describe('a plate’s scale bar is a straight-line scale, never a road distance', () => {
  it('picks the longest round distance that fits, and states only the distance (the caption says lines are not roads)', () => {
    const shape = projectShape({ center: null, bases: [{ name: 'Reykjavík', lat: 64.147, lng: -21.943 }, { name: 'Akureyri', lat: 65.689, lng: -18.126 }], stops: [] }, { width: 400, height: 260, pad: 30 });
    const bar = scaleBar(shape.pxPerDegree, 120);
    expect(bar).not.toBeNull();
    expect(bar!.units).toBeLessThanOrEqual(120);
    expect(bar!.label).toMatch(/^\d[\d,.]* k?m$/);
  });

  it('states no scale for one place', () => {
    const one = projectShape({ center: null, bases: [{ name: 'Vík', lat: 63.419, lng: -19.006 }], stops: [] }, { width: 100, height: 100, pad: 10 });
    expect(one.pxPerDegree).toBe(0);
    expect(scaleBar(one.pxPerDegree, 60)).toBeNull();
  });
});

describe('a trip with no coordinates still gets a mark of its own', () => {
  it('sets the name’s letterforms, not a place', () => {
    expect(monogram('Hong Kong')).toBe('HK');
    expect(monogram('Mammoth Lakes')).toBe('ML');
    expect(monogram('Tasmania')).toBe('Ta');
    expect(monogram('Ireland')).not.toBe(monogram('Iceland'));
    expect(monogram('Q')).toBe('Q');
    expect(monogram('Kenya and Tanzania')).toBe('KT');
    expect(monogram('Île de Ré')).toBe('ÎR');
  });

  it('marks the months the days fall in, and marks none while the dates are open', () => {
    const october = ledgerMark(base);
    expect(october.months.flatMap((m, i) => (m ? [i] : []))).toEqual([9]);
    expect(october.year).toBe('2026');
    const across = ledgerMark({ ...base, startDate: '2026-08-28', nights: 9 });
    expect(across.months.flatMap((m, i) => (m ? [i] : []))).toEqual([7, 8]);
    const open = ledgerMark({ ...base, timing: 'open' });
    expect(open.datesOpen).toBe(true);
    expect(open.months.some(Boolean)).toBe(false);
    expect(ledgerWords(open)).toContain('dates open');
  });

  it('tells three trips to one city apart by what is known about them', () => {
    const a = ledgerMark({ ...base, timing: 'open', nights: 6, party: '2 adults' });
    const b = ledgerMark({ ...base, timing: 'open', nights: 5, party: '2 adults' });
    const c = ledgerMark({ ...base, nights: 4, party: '3 adults' });
    const key = (m: ReturnType<typeof ledgerMark>) => JSON.stringify([m.months, m.nights, m.adults, m.children, m.datesOpen]);
    expect(new Set([key(a), key(b), key(c)]).size).toBe(3);
  });

  it('reads the party from the words, and reads unknown words as nobody', () => {
    expect(partyCounts('2 adults, 1 child')).toEqual({ adults: 2, children: 1 });
    expect(partyCounts('4 adults')).toEqual({ adults: 4, children: 0 });
    expect(partyCounts('')).toEqual({ adults: 0, children: 0 });
  });

  it('caps the ticks for drawing and keeps the remainder', () => {
    expect(ledgerMark({ ...base, nights: 30 }).nights).toEqual({ drawn: 21, more: 9 });
  });

  it('frames an idea dashed and a finished trip faded', () => {
    expect(ledgerMark({ ...base, lifecycle: 'idea' }).frame).toBe('dashed');
    expect(ledgerMark({ ...base, lifecycle: 'archived' }).frame).toBe('faded');
    expect(ledgerMark({ ...base, lifecycle: 'planning' }).frame).toBe('solid');
  });
});
