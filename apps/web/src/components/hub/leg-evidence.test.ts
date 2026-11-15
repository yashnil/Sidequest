import { describe, expect, it } from 'vitest';
import { LEG_LINE_STYLE, legendForConnectors } from './route-styles';
import { compactSpan } from './plan-format';

describe('a floor proved from measured legs has its own line', () => {
  it('is drawn apart from both a measured route and a distance estimate, and the legend says "at least"', () => {
    expect(LEG_LINE_STYLE.bounded.dash).not.toBe(LEG_LINE_STYLE.estimated.dash);
    expect(LEG_LINE_STYLE.bounded.dash).toBeDefined();
    expect(LEG_LINE_STYLE.bounded.basis).toBe('estimated');
    const legend = legendForConnectors([{ style: 'measured_drive', path: [{}, {}] }, { style: 'estimated' }, { style: 'bounded' }, { style: 'unmeasured' }]);
    expect(legend.map((entry) => entry.style)).toEqual(['measured_drive', 'estimated', 'bounded', 'unmeasured']);
    expect(legend.find((entry) => entry.style === 'bounded')!.legend).toMatch(/at least/i);
  });
});

describe('the clock column fits its duration on one line', () => {
  it('says minutes under an hour, whole hours plainly, and hours with minutes compactly', () => {
    expect(compactSpan(45)).toBe('45 min');
    expect(compactSpan(240)).toBe('4 hr');
    expect(compactSpan(150)).toBe('2h 30');
    expect(compactSpan(150).length).toBeLessThanOrEqual(6);
  });
});
