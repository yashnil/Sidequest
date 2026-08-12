import { describe, expect, it } from 'vitest';
import { buildBoardMap, type BoardMapPlace } from './BoardMapModel';

/**
 * The map has to be checkable as arithmetic, because the thing that makes a map
 * worse than no map is a mark in the wrong place — and a mark in the wrong place
 * looks exactly like a mark in the right place.
 */

const BASE = { name: 'Mammoth Lakes', coordinates: { lat: 37.6485, lng: -118.9721 } };

function place(overrides: Partial<BoardMapPlace> & { id: string }): BoardMapPlace {
  return {
    name: overrides.id,
    chosen: false,
    travelMinutes: 20,
    coordinates: { lat: 37.65, lng: -118.97 },
    ...overrides,
  };
}

describe('board map model', () => {
  it('draws nothing at all rather than a map with no places on it', () => {
    expect(buildBoardMap({ base: BASE, places: [], width: 400, height: 300 })).toBeNull();
  });

  it('never invents a position for a place that has none', () => {
    /*
     * The failure this forbids: a candidate with no coordinates dropped at the
     * base, or at the centre of the frame, because the drawing wanted a dot. A
     * map is read as a claim about the ground; an invented pin is a false one.
     */
    const model = buildBoardMap({
      base: BASE,
      places: [
        place({ id: 'known' }),
        place({ id: 'unknown', coordinates: undefined }),
      ],
      width: 400,
      height: 300,
    });

    expect(model).not.toBeNull();
    expect(model!.pins.map((pin) => pin.id)).toEqual(['known']);
    expect(model!.unplaced.map((entry) => entry.id)).toEqual(['unknown']);
    expect(model!.summary).toMatch(/no published position/);
  });

  it('separates places that share a position instead of stacking them into one dot', () => {
    const model = buildBoardMap({
      base: BASE,
      places: ['a', 'b', 'c'].map((id) =>
        place({ id, coordinates: { lat: 37.6501, lng: -118.9702 } }),
      ),
      width: 400,
      height: 300,
    })!;

    const positions = new Set(model.pins.map((pin) => `${pin.x.toFixed(1)}:${pin.y.toFixed(1)}`));
    expect(positions.size).toBe(3);
  });

  it('puts the same board in the same place twice', () => {
    const places = ['a', 'b', 'c'].map((id, index) =>
      place({ id, coordinates: { lat: 37.6 + index * 0.02, lng: -118.9 - index * 0.02 } }),
    );
    const once = buildBoardMap({ base: BASE, places, width: 400, height: 300 })!;
    // Offered in a different order: a redraw must not move a pin, or a card's
    // highlight would point at a different dot after a refresh.
    const twice = buildBoardMap({ base: BASE, places: [...places].reverse(), width: 400, height: 300 })!;
    expect(twice.pins.map((pin) => [pin.id, pin.x, pin.y])).toEqual(
      once.pins.map((pin) => [pin.id, pin.x, pin.y]),
    );
  });

  it('keeps relative geography: a place further east is drawn further right', () => {
    const model = buildBoardMap({
      base: BASE,
      places: [
        place({ id: 'west', coordinates: { lat: 37.65, lng: -119.2 } }),
        place({ id: 'east', coordinates: { lat: 37.65, lng: -118.7 } }),
        place({ id: 'north', coordinates: { lat: 37.9, lng: -118.95 } }),
        place({ id: 'south', coordinates: { lat: 37.4, lng: -118.95 } }),
      ],
      width: 400,
      height: 300,
    })!;

    const at = (id: string) => model.pins.find((pin) => pin.id === id)!;
    expect(at('east').x).toBeGreaterThan(at('west').x);
    // Screen y grows downward, so further north is a smaller y.
    expect(at('north').y).toBeLessThan(at('south').y);
  });

  it('states a scale ring that fits inside the frame', () => {
    const model = buildBoardMap({
      base: BASE,
      places: [
        place({ id: 'near', coordinates: { lat: 37.66, lng: -118.98 } }),
        place({ id: 'far', coordinates: { lat: 37.9, lng: -119.2 } }),
      ],
      width: 400,
      height: 300,
    })!;

    expect(model.ring).not.toBeNull();
    expect(model.ring!.km).toBeGreaterThan(0);
    expect(model.ring!.path.startsWith('M')).toBe(true);
  });

  it('reports how many are chosen so the drawing and the board agree', () => {
    const model = buildBoardMap({
      base: BASE,
      places: [
        place({ id: 'a', chosen: true, coordinates: { lat: 37.7, lng: -118.9 } }),
        place({ id: 'b', coordinates: { lat: 37.6, lng: -119.0 } }),
      ],
      width: 400,
      height: 300,
    })!;
    expect(model.summary).toMatch(/1 of them chosen/);
  });
});
