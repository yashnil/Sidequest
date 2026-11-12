import { describe, expect, it } from 'vitest';
import { journeyKey, lineKindOf } from './journey-key';

const leg = (shape: 'routed' | 'straight', time: 'measured' | 'estimated' | 'unknown', disconnected = false) => ({ shape, time, disconnected, coords: [[0, 0], [1, 1]] as [number, number][] });

describe('the journey key lists exactly what is drawn', () => {
  it('sorts a leg into the line kind the map draws it as', () => {
    expect(lineKindOf(leg('routed', 'measured'))).toBe('routed');
    expect(lineKindOf(leg('straight', 'measured'))).toBe('straight_timed');
    expect(lineKindOf(leg('straight', 'estimated'))).toBe('straight_timed');
    expect(lineKindOf(leg('straight', 'unknown'))).toBe('straight_unknown');
    expect(lineKindOf(leg('straight', 'measured', true))).toBe('arc');
  });

  it('never keys a solid road when every line is a straight connection', () => {
    const key = journeyKey({ legs: [leg('straight', 'measured'), leg('straight', 'unknown')], pins: [{ kind: 'base' }, { kind: 'stop' }] });
    expect(key.lines.map((l) => l.kind)).toEqual(['straight_timed', 'straight_unknown']);
    expect(key.lines[0]!.text).toMatch(/straight connection, not the road/);
    expect(key.marks.map((m) => m.kind)).toEqual(['base', 'stop_numbered']);
  });

  it('keys stops by day on the whole trip, and the cluster mark only when one is drawn', () => {
    const pins = [{ kind: 'base' }, { kind: 'stop', dayNumber: 2, colour: '#fff' }, { kind: 'meal' }];
    expect(journeyKey({ legs: [], pins, clusters: 0 }).marks.map((m) => m.kind)).toEqual(['base', 'stop_by_day', 'meal']);
    expect(journeyKey({ legs: [], pins, clusters: 2 }).marks.map((m) => m.kind)).toEqual(['base', 'stop_by_day', 'meal', 'cluster']);
  });

  it('ignores a leg with nothing to draw', () => {
    expect(journeyKey({ legs: [{ ...leg('routed', 'measured'), coords: [[0, 0]] }], pins: [] }).lines).toEqual([]);
  });
});
