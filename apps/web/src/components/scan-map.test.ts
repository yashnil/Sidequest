import { describe, expect, it } from 'vitest';
import { specimenMarks } from './ScanMap';

describe('the scan map’s specimens', () => {
  it('numbers places in the order the scan placed them and counts bases on their own', () => {
    const marks = specimenMarks([
      { name: 'A', lat: 0, lng: 0, kind: 'place' },
      { name: 'Base', lat: 0, lng: 0, kind: 'base' },
      { name: 'B', lat: 0, lng: 0, kind: 'place' },
    ]);
    expect(marks).toEqual(['01', 'B1', '02']);
  });
});
