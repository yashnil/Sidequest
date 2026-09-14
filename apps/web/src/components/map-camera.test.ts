import { describe, expect, it } from 'vitest';
import { abbreviateLabel, cameraFrameFor, labelBudget, selectLabels, type MapMarker } from './map-camera';

/**
 * V11 §11 §12 — the two map defects the founder screenshots showed, as tests
 * that need no browser.
 *
 * A "Banff townsite orientation" day framed a patch of Echo Creek, and the
 * Kyrgyzstan generation map printed every name at once around Bishkek until
 * they overlapped into "Osh BazaarSquare".
 */
const BANFF = { lat: 51.1784, lng: -115.5708 };
const ECHO_CREEK = { lat: 51.1521, lng: -115.5012 };
const LAKE_LOUISE = { lat: 51.4249, lng: -116.1775 };
const JASPER = { lat: 52.8737, lng: -118.0814 };
const CALGARY = { lat: 51.0447, lng: -114.0719 };

const marker = (over: Partial<MapMarker> & { id: string }): MapMarker => ({ label: over.id, kind: 'stop', ...over });

describe('V11 §11 — the camera frames the trip, not whatever happened to be placed', () => {
  it('frames a day from its own base and stops', () => {
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 2,
      markers: [
        marker({ id: 'base', kind: 'base', point: BANFF, dayNumber: 2 }),
        marker({ id: 'louise', kind: 'signature', point: LAKE_LOUISE, dayNumber: 2 }),
        marker({ id: 'jasper', kind: 'base', point: JASPER, dayNumber: 5 }),
      ],
    });
    expect(frame.ok).toBe(true);
    expect(frame.ok && frame.basis).toBe('day_stops');
    expect(frame.ok && frame.points).toHaveLength(2);
  });

  it('does NOT frame one incidental creek when the day has a single placed stop', () => {
    /* The founder screenshot, exactly: a day-1 orientation whose only placed point is a creek. */
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 1,
      chapterId: 'c1',
      markers: [
        marker({ id: 'creek', point: ECHO_CREEK, dayNumber: 1, chapterId: 'c1' }),
        marker({ id: 'banff', kind: 'base', point: BANFF, dayNumber: 2, chapterId: 'c1' }),
        marker({ id: 'louise', kind: 'signature', point: LAKE_LOUISE, dayNumber: 2, chapterId: 'c1' }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('day_widened_to_chapter');
    /* The creek is still in the frame — the day is about it — but so is the town it sits beside. */
    expect(frame.ok && frame.points).toContainEqual(ECHO_CREEK);
    expect(frame.ok && frame.points).toContainEqual(BANFF);
  });

  it('falls back to the route when the chapter is as thin as the day', () => {
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 1,
      chapterId: 'c1',
      markers: [
        marker({ id: 'creek', point: ECHO_CREEK, dayNumber: 1, chapterId: 'c1' }),
        marker({ id: 'banff', kind: 'base', point: BANFF, dayNumber: 4, chapterId: 'c2' }),
        marker({ id: 'gate', kind: 'gateway', point: CALGARY, chapterId: 'c3' }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('day_widened_to_route');
  });

  it('shows a genuinely single-point trip with real ground around it', () => {
    const frame = cameraFrameFor({ mode: 'day', dayNumber: 1, markers: [marker({ id: 'only', point: ECHO_CREEK, dayNumber: 1 })] });
    expect(frame.ok && frame.basis).toBe('single_point_with_context');
    /* 12 km, not 6: one pin needs the valley around it or it is a pin on nothing. */
    expect(frame.ok && frame.minSpanKm).toBe(12);
  });

  it('an unplaced stop cannot move the frame or empty it', () => {
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 2,
      markers: [
        marker({ id: 'base', kind: 'base', point: BANFF, dayNumber: 2 }),
        marker({ id: 'louise', kind: 'signature', point: LAKE_LOUISE, dayNumber: 2 }),
        marker({ id: 'nowhere', kind: 'unresolved', dayNumber: 2 }),
      ],
    });
    expect(frame.ok && frame.points).toHaveLength(2);
  });

  it('says so rather than drawing the ocean when nothing is placed at all', () => {
    const frame = cameraFrameFor({ mode: 'day', dayNumber: 1, markers: [marker({ id: 'a', kind: 'unresolved' }), marker({ id: 'b' })] });
    expect(frame.ok).toBe(false);
    expect(!frame.ok && frame.reason).toBe('nothing_placed');
  });

  it('the overview frames the spine and leaves ordinary stops out of it', () => {
    const frame = cameraFrameFor({
      mode: 'overview',
      markers: [
        marker({ id: 'gate', kind: 'gateway', point: CALGARY }),
        marker({ id: 'banff', kind: 'base', point: BANFF }),
        marker({ id: 'jasper', kind: 'base', point: JASPER }),
        marker({ id: 'creek', point: ECHO_CREEK }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('route_extent');
    expect(frame.ok && frame.points).not.toContainEqual(ECHO_CREEK);
  });

  it('the overview still draws something when a trip has only ordinary stops', () => {
    const frame = cameraFrameFor({ mode: 'overview', markers: [marker({ id: 'a', point: BANFF }), marker({ id: 'b', point: LAKE_LOUISE })] });
    expect(frame.ok && frame.points).toHaveLength(2);
  });

  it('explore keeps everything, because density is the point there', () => {
    const frame = cameraFrameFor({
      mode: 'explore',
      markers: [marker({ id: 'gate', kind: 'gateway', point: CALGARY }), marker({ id: 'creek', point: ECHO_CREEK })],
    });
    expect(frame.ok && frame.basis).toBe('everything');
    expect(frame.ok && frame.points).toHaveLength(2);
  });
});

describe('V11 §12 — labels do not pile up', () => {
  const candidate = (id: string, kind: Parameters<typeof selectLabels>[0][number]['kind'], x: number, y: number, label = id) => ({ id, label, kind, x, y });

  it('drops a colliding label rather than drawing two unreadable names', () => {
    /* "Osh Bazaar" and "Ala-Too Square" a few pixels apart, which is what shipped. */
    const chosen = selectLabels([candidate('bazaar', 'stop', 100, 100, 'Osh Bazaar'), candidate('square', 'stop', 104, 102, 'Ala-Too Square')], { max: 10, width: 600 });
    expect(chosen).toHaveLength(1);
  });

  it('keeps both when they are genuinely apart', () => {
    const chosen = selectLabels([candidate('a', 'stop', 100, 100, 'Osh Bazaar'), candidate('b', 'stop', 400, 300, 'Ala-Too Square')], { max: 10 });
    expect(chosen).toHaveLength(2);
  });

  it('gives a base the preferred side when it collides with a stop', () => {
    /*
     * Priority decides who gets the side a name is read from, not only who
     * survives: the base takes the right of its mark and the stop takes what is
     * left, which is the other side or nothing.
     */
    const chosen = selectLabels([candidate('stop', 'stop', 100, 100, 'A stop'), candidate('base', 'base', 102, 101, 'Bishkek')], { max: 10, width: 600 });
    expect(chosen[0]?.id).toBe('base');
    expect(chosen.find((label) => label.id === 'base')?.side).toBe('right');
    expect(chosen.find((label) => label.id === 'stop')?.side ?? 'dropped').not.toBe('right');
  });

  it('always keeps the selected label, whatever it overlaps', () => {
    const chosen = selectLabels([candidate('base', 'base', 100, 100, 'Bishkek'), candidate('stop', 'stop', 102, 101, 'A stop')], { max: 10, selectedId: 'stop' });
    expect(chosen.map((l) => l.id)).toContain('stop');
  });

  it('respects a cap, and the cap is smaller on a phone', () => {
    const many = Array.from({ length: 30 }, (_, i) => candidate(`m${i}`, 'stop', i * 200, i * 60, `Place ${i}`));
    expect(selectLabels(many, { max: 5 })).toHaveLength(5);
    expect(labelBudget({ mode: 'day', widthPx: 390 })).toBeLessThan(labelBudget({ mode: 'day', widthPx: 1440 }));
  });

  it('never draws a chip over another mark, which the label-only test could not see', () => {
    /*
     * V11 §N — the Mammoth overview, read at four widths: the base square, two
     * signature dots and a chip, all inside about forty pixels. Every label
     * cleared every other label, so the collision count was zero and the
     * picture was a smear. A chip is drawn to the right of its own mark, so a
     * neighbour 30 px to the right sits underneath it.
     */
    const chosen = selectLabels(
      [
        { id: 'base', label: 'Mammoth Lakes', kind: 'base', x: 100, y: 100, radius: 5.5 },
        { id: 'signature', label: 'Convict Lake', kind: 'signature', x: 130, y: 100, radius: 8.5 },
      ],
      { max: 10 },
    );
    /* The base keeps its name by moving to its other side, not by covering the dot. */
    expect(chosen.map((label) => label.id)).toEqual(['base', 'signature']);
    expect(chosen.find((label) => label.id === 'base')?.side).toBe('left');
    expect(chosen.find((label) => label.id === 'signature')?.side).toBe('right');
  });

  it('drops a chip only when neither side of its mark is clear', () => {
    /* Marks either side of it, so right lands on one and left lands on the other. */
    const chosen = selectLabels(
      [
        { id: 'left', label: 'Convict Lake', kind: 'base', x: 100, y: 100, radius: 5.5 },
        { id: 'right', label: 'June Lake Loop', kind: 'base', x: 200, y: 100, radius: 5.5 },
        { id: 'boxed', label: 'Mammoth Lakes', kind: 'stop', x: 150, y: 100, radius: 5.5 },
      ],
      { max: 10, width: 600 },
    );
    expect(chosen.map((label) => label.id)).not.toContain('boxed');
  });

  it('places a chip at the right-hand edge on the side it will actually be drawn', () => {
    /*
     * A chip that would run off the frame flips to the left of its mark, and
     * the flip is decided with the collision rather than after it — the
     * renderer draws the side it is handed.
     */
    const edge = { id: 'edge', label: 'Mono Lake South Tufa', kind: 'signature' as const, x: 560, y: 100, radius: 8.5 };
    expect(selectLabels([edge], { max: 10, width: 600 })[0]?.side).toBe('left');
    expect(selectLabels([edge], { max: 10, width: 1400 })[0]?.side).toBe('right');
  });

  it('never labels an unresolved marker unless it is the one selected', () => {
    expect(selectLabels([candidate('u', 'unresolved', 10, 10, 'Somewhere')], { max: 5 })).toHaveLength(0);
    expect(selectLabels([candidate('u', 'unresolved', 10, 10, 'Somewhere')], { max: 5, selectedId: 'u' })).toHaveLength(1);
  });

  it('abbreviates a long name instead of dropping it, and drops the gloss first', () => {
    expect(abbreviateLabel('Skazka Canyon (Fairy Tale Canyon)', 22)).toBe('Skazka Canyon');
    expect(abbreviateLabel('Ala-Kul & Altyn-Arashan trek', 12)).toMatch(/…$/);
    expect(abbreviateLabel('Banff', 22)).toBe('Banff');
  });

  it('never cuts a name mid-word', () => {
    const out = abbreviateLabel('Przhevalsky Museum area walk', 16);
    expect(out.endsWith('…')).toBe(true);
    expect(out.replace('…', '').trim()).toBe('Przhevalsky');
  });
});

/**
 * V11 §F5 — THE EIGHT CAMERA CASES, RUN RATHER THAN REASONED ABOUT.
 *
 * §F5 names eight shapes the camera has to handle and asks for each to be
 * actually exercised: one stop, multiple stops, a city, a road trip, a regional
 * overview, a gateway and base, an unresolved point, and a multi-day trek. Each
 * one below states the shape, the expected basis, and — where it is the point —
 * how much ground the frame must cover.
 *
 * The assertion that matters in every case is the same: the frame must contain
 * what the traveller is reading about, and must never be a pin on an empty
 * field. "Banff / Echo Creek-style useless framing must be impossible" is not a
 * sentence a reviewer can check; a stated `basis` and a stated `minSpanKm` are.
 */
describe('V11 §F5 — the eight camera cases', () => {
  const KEG = { lat: 51.1642, lng: -115.5615 };
  const SONG_KUL = { lat: 41.8397, lng: 75.1386 };
  const KARAKOL = { lat: 42.4907, lng: 78.3936 };
  const ALA_KUL = { lat: 42.3, lng: 78.55 };
  const BISHKEK = { lat: 42.8746, lng: 74.5698 };

  /** How much ground a frame actually spans, in kilometres, north to south. */
  function spanKm(points: readonly { lat: number; lng: number }[]): number {
    const lats = points.map((point) => point.lat);
    return (Math.max(...lats) - Math.min(...lats)) * 111;
  }

  it('one stop — borrows context rather than filling the frame with it', () => {
    const frame = cameraFrameFor({ mode: 'day', dayNumber: 1, markers: [marker({ id: 'only', kind: 'signature', point: ECHO_CREEK, dayNumber: 1 })] });
    expect(frame.ok && frame.basis).toBe('single_point_with_context');
    expect(frame.ok && frame.minSpanKm).toBeGreaterThanOrEqual(12);
  });

  it('multiple stops in one town — the town, not the country around it', () => {
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 1,
      markers: [
        marker({ id: 'base', kind: 'base', point: BANFF, dayNumber: 1 }),
        marker({ id: 'keg', kind: 'stop', point: KEG, dayNumber: 1 }),
        marker({ id: 'creek', kind: 'stop', point: ECHO_CREEK, dayNumber: 1 }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('day_stops');
    expect(frame.ok && frame.points).toHaveLength(3);
    expect(frame.ok && spanKm(frame.points)).toBeLessThan(10);
  });

  it('a city day — every stop in it, and no borrowed geography', () => {
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 3,
      markers: [
        marker({ id: 'sq', kind: 'signature', point: BISHKEK, dayNumber: 3 }),
        marker({ id: 'bazaar', kind: 'stop', point: { lat: 42.8735, lng: 74.5817 }, dayNumber: 3 }),
        marker({ id: 'far', kind: 'base', point: KARAKOL, dayNumber: 9 }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('day_stops');
    expect(frame.ok && frame.points.some((point) => point.lng > 78)).toBe(false);
  });

  it('a road trip overview — end to end, and the ordinary stops suppressed', () => {
    const frame = cameraFrameFor({
      mode: 'overview',
      markers: [
        marker({ id: 'yyc', kind: 'gateway', point: CALGARY }),
        marker({ id: 'banff', kind: 'base', point: BANFF }),
        marker({ id: 'jasper', kind: 'base', point: JASPER }),
        marker({ id: 'creek', kind: 'stop', point: ECHO_CREEK }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('route_extent');
    expect(frame.ok && frame.points).toHaveLength(3);
    expect(frame.ok && spanKm(frame.points)).toBeGreaterThan(150);
  });

  it('a regional overview — a trip’s worth of ground, never a town’s', () => {
    const frame = cameraFrameFor({ mode: 'overview', markers: [marker({ id: 'banff', kind: 'base', point: BANFF }), marker({ id: 'keg', kind: 'base', point: KEG })] });
    expect(frame.ok && frame.minSpanKm).toBeGreaterThanOrEqual(40);
  });

  it('a gateway and one base — both in frame, because the transfer between them is the day', () => {
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 1,
      markers: [marker({ id: 'yyc', kind: 'gateway', point: CALGARY, dayNumber: 1 }), marker({ id: 'banff', kind: 'base', point: BANFF, dayNumber: 1 })],
    });
    expect(frame.ok && frame.basis).toBe('day_stops');
    expect(frame.ok && frame.points).toHaveLength(2);
  });

  it('an unresolved point — absent from the frame, never fatal to it', () => {
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 4,
      markers: [
        marker({ id: 'camp', kind: 'unresolved', dayNumber: 4 }),
        marker({ id: 'karakol', kind: 'base', point: KARAKOL, dayNumber: 4 }),
        marker({ id: 'alakul', kind: 'signature', point: ALA_KUL, dayNumber: 4 }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('day_stops');
    expect(frame.ok && frame.points).toHaveLength(2);
  });

  it('a multi-day trek — the whole crossing, from a day inside it', () => {
    /*
     * Day 5 of a trek has one placed camp; the chapter is the crossing. Widening
     * to the chapter is the honest frame: the day is one leg of a thing that
     * only makes sense whole.
     */
    const frame = cameraFrameFor({
      mode: 'day',
      dayNumber: 5,
      chapterId: 'crossing',
      markers: [
        marker({ id: 'camp', kind: 'overnight_experience', point: ALA_KUL, dayNumber: 5, chapterId: 'crossing' }),
        marker({ id: 'karakol', kind: 'base', point: KARAKOL, dayNumber: 4, chapterId: 'crossing' }),
        marker({ id: 'songkul', kind: 'base', point: SONG_KUL, dayNumber: 8, chapterId: 'lake' }),
      ],
    });
    expect(frame.ok && frame.basis).toBe('day_widened_to_chapter');
    expect(frame.ok && frame.points.some((point) => point.lng < 76)).toBe(false);
  });

  it('nothing placed at all — no frame, so the caller says so rather than drawing the ocean', () => {
    const frame = cameraFrameFor({ mode: 'overview', markers: [marker({ id: 'a', kind: 'base' }), marker({ id: 'b', kind: 'signature' })] });
    expect(frame.ok).toBe(false);
    expect(!frame.ok && frame.reason).toBe('nothing_placed');
  });
});

describe('V11 §N — a mark with no label of its own is still something a chip must clear', () => {
  it('keeps a chip off the base square, which is drawn from the frame rather than from the marker list', () => {
    /*
     * The Mammoth explore view: a signature dot a little to the left of the
     * trip's base square, whose chip ran straight underneath it and read
     * "h Lakes". The base is painted from `base`, not from `markers`, so the
     * selection only learns about it because it is handed one.
     */
    const signature = { id: 'signature', label: 'Mammoth Lakes', kind: 'signature' as const, x: 520, y: 100, radius: 8.5 };
    const withoutBase = selectLabels([signature], { max: 10, width: 1400 });
    expect(withoutBase[0]?.side).toBe('right');
    const withBase = selectLabels([signature], { max: 10, width: 1400, obstacles: [{ x: 541, y: 100, radius: 5.5 }] });
    expect(withBase[0]?.side).toBe('left');
  });
});
