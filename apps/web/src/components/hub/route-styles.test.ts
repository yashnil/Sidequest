import { describe, expect, it } from 'vitest';
import { LEG_LINE_STYLE, STRAIGHT_TIMED_STYLE, arcPath, drawnLegStyle, legPath, legendFor, legendForConnectors, wavePath } from './route-styles';

describe('one line per way of moving', () => {
  it('draws road solid, rail long-dashed, boat short-dashed on a wave, flight as an arc, trail dotted', () => {
    expect(LEG_LINE_STYLE.measured_drive.dash).toBeUndefined();
    expect(LEG_LINE_STYLE.measured_drive.shape).toBe('straight');
    expect(Number(LEG_LINE_STYLE.rail.dash!.split(' ')[0])).toBeGreaterThan(Number(LEG_LINE_STYLE.boat.dash!.split(' ')[0]));
    expect(LEG_LINE_STYLE.boat.shape).toBe('wave');
    expect(LEG_LINE_STYLE.flight.shape).toBe('arc');
    expect(Number(LEG_LINE_STYLE.trail.dash!.split(' ')[0])).toBeLessThanOrEqual(1);
  });
  it('keeps the measured / estimated / operator-timed / untimed distinction on every style', () => {
    expect(LEG_LINE_STYLE.measured_drive.basis).toBe('measured');
    expect(LEG_LINE_STYLE.estimated.basis).toBe('estimated');
    expect(LEG_LINE_STYLE.boat.basis).toBe('operator');
    expect(LEG_LINE_STYLE.rail.basis).toBe('operator');
    expect(LEG_LINE_STYLE.unmeasured.basis).toBe('untimed');
    expect(LEG_LINE_STYLE.unmeasured.legend).toMatch(/not a route/);
    expect(LEG_LINE_STYLE.estimated.legend).toMatch(/not timed/);
  });
  it('builds a legend only for the styles on the drawing, once each, in a fixed order', () => {
    const legend = legendFor(['unmeasured', 'boat', 'measured_drive', 'boat']);
    expect(legend.map((entry) => entry.style)).toEqual(['measured_drive', 'boat', 'unmeasured']);
    expect(legendFor([])).toEqual([]);
  });
  it('starts and ends an arc and a wave exactly on the two points', () => {
    const arc = arcPath({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(arc.startsWith('M0.0 0.0 Q')).toBe(true);
    expect(arc.endsWith(' 100.0 0.0')).toBe(true);
    expect(arc).not.toContain('Q50.0 0.0');
    const wave = wavePath({ x: 0, y: 0 }, { x: 140, y: 0 });
    expect(wave.startsWith('M0.0 0.0')).toBe(true);
    expect(wave.endsWith('L140.0 0.0')).toBe(true);
    expect(wave.split(' L').length).toBeGreaterThan(8);
    expect(legPath('measured_drive', { x: 1, y: 2 }, { x: 3, y: 4 })).toBe('M1.0 2.0 L3.0 4.0');
  });
});

describe('route honesty: a straight line is never styled like a road', () => {
  const at = { lat: 0, lng: 0 };
  it('draws a timed leg solid only along its route shape', () => {
    expect(drawnLegStyle({ style: 'measured_drive', path: [at, at] })).toBe('measured_drive');
    expect(drawnLegStyle({ style: 'measured_drive' })).toBe('straight_timed');
    expect(drawnLegStyle({ style: 'measured_transit', path: [] })).toBe('straight_timed');
    expect(drawnLegStyle({ style: 'unmeasured' })).toBe('unmeasured');
    expect(drawnLegStyle({ style: 'flight' })).toBe('flight');
  });
  it('makes every straight connection thinner than a road and broken', () => {
    for (const style of [STRAIGHT_TIMED_STYLE, LEG_LINE_STYLE.estimated, LEG_LINE_STYLE.unmeasured]) {
      expect(style.dash).toBeTruthy();
      expect(style.width).toBeLessThan(LEG_LINE_STYLE.measured_drive.width / 1.5);
    }
  });
  it('keys the drawn line, so the legend says "straight connection, not the road" for a shapeless timed leg', () => {
    const legend = legendForConnectors([{ style: 'measured_drive' }, { style: 'measured_drive', path: [at, at] }, { style: 'estimated' }]);
    expect(legend.map((entry) => entry.style)).toEqual(['measured_drive', 'straight_timed', 'estimated']);
    expect(legend[1]!.legend).toMatch(/straight connection, not the road/i);
    expect(legend[2]!.legend).toMatch(/straight connection, not the road/i);
    expect(legendForConnectors([{ style: 'measured_drive' }]).map((entry) => entry.style)).toEqual(['straight_timed']);
  });
});
