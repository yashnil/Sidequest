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
    const chosen = selectLabels([candidate('bazaar', 'stop', 100, 100, 'Osh Bazaar'), candidate('square', 'stop', 104, 102, 'Ala-Too Square')], { max: 10 });
    expect(chosen).toHaveLength(1);
  });

  it('keeps both when they are genuinely apart', () => {
    const chosen = selectLabels([candidate('a', 'stop', 100, 100, 'Osh Bazaar'), candidate('b', 'stop', 400, 300, 'Ala-Too Square')], { max: 10 });
    expect(chosen).toHaveLength(2);
  });

  it('gives a base priority over a stop when they collide', () => {
    const chosen = selectLabels([candidate('stop', 'stop', 100, 100, 'A stop'), candidate('base', 'base', 102, 101, 'Bishkek')], { max: 10 });
    expect(chosen.map((l) => l.id)).toEqual(['base']);
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
