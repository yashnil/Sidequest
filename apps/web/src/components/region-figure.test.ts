import { describe, expect, it } from 'vitest';
import { DAY_REACH_KM, type PreflightCluster, type PreflightPortfolio } from '@sidequest/core';
import { buildRegionFigure, estimatedTravel, type FigureLabel } from './region-figure';

/**
 * THE FIGURE'S GEOMETRY, ASSERTED RATHER THAN LOOKED AT.
 *
 * A picture that is subtly wrong looks exactly like a picture, so the properties
 * that make this one trustworthy are checked here: every mark is a cluster we
 * actually hold, no label is printed over another, every ring is the distance it
 * claims, and the words describing the figure come from the same pass that drew
 * it.
 */

function cluster(
  id: string,
  name: string,
  lat: number,
  lng: number,
  overrides: Partial<PreflightCluster> = {},
): PreflightCluster {
  return {
    id,
    name,
    center: { lat, lng },
    memberCount: 4,
    memberNames: [],
    distanceFromGatewayKm: 0,
    transferMinutesFromGateway: 0,
    ...overrides,
  };
}

const HARBOUR = cluster('harbour', 'Harbourmouth', 38.72, -9.14);
const RIDGE = cluster('ridge', 'Ridgeford', 39.6, -8.4, { distanceFromGatewayKm: 118 });
const LAKE = cluster('lake', 'Lakeshead', 40.4, -7.6, { distanceFromGatewayKm: 236 });
const SPUR = cluster('spur', 'Spurwater', 38.95, -9.0);
const FARFIELD = cluster('far', 'Farfield', 41.8, -6.2, {
  distanceFromGatewayKm: 430,
  transferMinutesFromGateway: 470,
});

function portfolio(overrides: Partial<PreflightPortfolio> = {}): PreflightPortfolio {
  return {
    gateway: { name: HARBOUR.name, center: HARBOUR.center },
    route: [HARBOUR, RIDGE, LAKE],
    baseReasons: [
      { clusterId: 'harbour', reason: 'The densest part of the region.', nights: 3, transferMinutes: 0 },
      { clusterId: 'ridge', reason: 'Too far to reach and come back in a day.', nights: 2, transferMinutes: 125 },
      { clusterId: 'lake', reason: 'Moving here saves more travel than it costs.', nights: 2, transferMinutes: 118 },
    ],
    satellites: [{ cluster: SPUR, baseId: 'harbour', transferMinutes: 34 }],
    excluded: [{ cluster: FARFIELD, reason: 'Further out than this trip has days for.' }],
    basesProposed: 3,
    transferDays: 1.0,
    mode: 'drive',
    reachRadiusKm: 306,
    rationale: 'Four distinct areas found; this route uses three bases.',
    estimated: true,
    ...overrides,
  };
}

function boxOf(label: FigureLabel): { x1: number; y1: number; x2: number; y2: number } {
  const width = Math.max(...label.lines.map((line) => line.length)) * label.fontSize * 0.58;
  const x1 =
    label.anchor === 'start'
      ? label.x
      : label.anchor === 'end'
        ? label.x - width
        : label.x - width / 2;
  return {
    x1,
    x2: x1 + width,
    y1: label.y - label.fontSize * 0.85,
    y2: label.y + (label.lines.length - 1) * 10 + label.fontSize * 0.3,
  };
}

function collide(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): boolean {
  return !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
}

describe('the region figure', () => {
  it('draws nothing when there is no route to draw', () => {
    expect(buildRegionFigure(portfolio({ route: [], baseReasons: [] }), 'Nowhere')).toBeNull();
  });

  it('marks every area the portfolio holds, and nothing else', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    expect(figure.marks.map((mark) => mark.id).sort()).toEqual(
      ['far', 'harbour', 'lake', 'ridge', 'spur'].sort(),
    );
    expect(figure.marks.filter((mark) => mark.role === 'base')).toHaveLength(3);
    expect(figure.marks.filter((mark) => mark.role === 'satellite')).toHaveLength(1);
    expect(figure.marks.filter((mark) => mark.role === 'excluded')).toHaveLength(1);
  });

  it('places each mark where its own coordinate projects', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    for (const mark of figure.marks) {
      const source = [HARBOUR, RIDGE, LAKE, SPUR, FARFIELD].find(
        (candidate) => candidate.id === mark.id,
      )!;
      const expected = figure.viewport.project(source.center);
      expect(mark.at.x).toBeCloseTo(expected.x, 9);
      expect(mark.at.y).toBeCloseTo(expected.y, 9);
    }
  });

  it('numbers the bases in route order and carries their nights and reasons', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    const bases = figure.marks.filter((mark) => mark.role === 'base');
    expect(bases.map((base) => base.order)).toEqual([1, 2, 3]);
    expect(bases.map((base) => base.nights)).toEqual([3, 2, 2]);
    expect(bases[0]!.transferMinutes).toBeNull();
    expect(bases[1]!.transferMinutes).toBe(125);
    expect(bases[2]!.note).toBe('Moving here saves more travel than it costs.');
  });

  it('says why an area was left out, on the mark that represents it', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    const left = figure.marks.find((mark) => mark.role === 'excluded')!;
    expect(left.note).toBe('Further out than this trip has days for.');
  });

  it('draws one leg per hotel move, labelled with its estimated cost', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    const transfers = figure.edges.filter((edge) => edge.kind === 'transfer');
    expect(transfers.map((edge) => edge.minutes)).toEqual([125, 118]);
    // The estimate marker is on the number itself, not only in a caption.
    for (const edge of transfers) expect(edge.label!.lines[0]).toMatch(/^≈/);
  });

  it('hangs a day trip off its base rather than drawing it as a move', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    const spokes = figure.edges.filter((edge) => edge.kind === 'day_trip');
    expect(spokes).toHaveLength(1);
    const base = figure.marks.find((mark) => mark.id === 'harbour')!;
    expect(spokes[0]!.from).toEqual(base.at);
    expect(figure.marks.find((mark) => mark.id === 'spur')!.baseId).toBe('harbour');
  });
});

/**
 * THE DEFECT THE OLD FIGURE DOCUMENTED AND DID NOT FIX.
 *
 * Its comment said alternating labels above and below "is not a general solution
 * to label collision; it is the cheap one that fixes the case that actually
 * occurs, which is two or three marks in a cluster". The case that actually
 * occurs now is a base with three or four satellites around it, and alternating
 * overprints every one of them.
 */
describe('label placement', () => {
  /*
   * The shape that actually occurs: one base with four day-trip satellites
   * around it and two areas left out further off. Seven marks, all inside a day
   * of each other, which is precisely where "alternate above and below" printed
   * four names on top of two.
   */
  const clustered = portfolio({
    route: [cluster('a', 'Alderwick', 47.0, 8.0)],
    baseReasons: [
      { clusterId: 'a', reason: 'Everything worth seeing is a day trip.', nights: 5, transferMinutes: 0 },
    ],
    satellites: [
      { cluster: cluster('c', 'Corrinsholt', 47.45, 8.0), baseId: 'a', transferMinutes: 55 },
      { cluster: cluster('d', 'Dunmarsh', 47.0, 8.66), baseId: 'a', transferMinutes: 55 },
      { cluster: cluster('e', 'Elverend', 46.68, 7.55), baseId: 'a', transferMinutes: 60 },
      { cluster: cluster('g', 'Greyhollow', 46.75, 8.4), baseId: 'a', transferMinutes: 45 },
    ],
    excluded: [
      { cluster: cluster('f', 'Fenwater', 48.3, 8.9), reason: 'Further out than a day allows.' },
      { cluster: cluster('h', 'Holmfirth', 45.9, 7.2), reason: 'Nothing here to stay for.' },
    ],
    reachRadiusKm: 130,
  });

  it('never prints one label across another, even with seven clustered marks', () => {
    const figure = buildRegionFigure(clustered, 'Testland')!;
    const labels = [
      ...figure.marks.map((mark) => mark.label),
      ...figure.edges.map((edge) => edge.label),
    ].filter((label): label is FigureLabel => label !== null);

    // Most of them are placed. A refusal is allowed; a figure that refuses
    // almost everything is a regression and this is the line that catches it.
    expect(labels.length).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        expect(
          collide(boxOf(labels[i]!), boxOf(labels[j]!)),
          `${labels[i]!.lines.join(' ')} overlaps ${labels[j]!.lines.join(' ')}`,
        ).toBe(false);
      }
    }
  });

  it('never prints a label over a mark', () => {
    const figure = buildRegionFigure(clustered, 'Testland')!;
    for (const label of figure.marks.map((mark) => mark.label)) {
      if (!label) continue;
      for (const mark of figure.marks) {
        expect(
          collide(boxOf(label), {
            x1: mark.at.x - mark.radius,
            y1: mark.at.y - mark.radius,
            x2: mark.at.x + mark.radius,
            y2: mark.at.y + mark.radius,
          }),
        ).toBe(false);
      }
    }
  });

  it('keeps every label inside the frame', () => {
    const figure = buildRegionFigure(clustered, 'Testland')!;
    for (const mark of figure.marks) {
      if (!mark.label) continue;
      const box = boxOf(mark.label);
      expect(box.x1).toBeGreaterThanOrEqual(0);
      expect(box.y1).toBeGreaterThanOrEqual(0);
      expect(box.x2).toBeLessThanOrEqual(figure.width);
      expect(box.y2).toBeLessThanOrEqual(figure.height);
    }
  });

  it('gives the bases their labels first, because they are the decision', () => {
    const figure = buildRegionFigure(clustered, 'Testland')!;
    for (const base of figure.marks.filter((mark) => mark.role === 'base')) {
      expect(base.label, `${base.name} lost its label`).not.toBeNull();
    }
  });

  it('shortens a name rather than letting it run off the frame', () => {
    const figure = buildRegionFigure(
      portfolio({
        route: [cluster('long', 'Ambervale Highlands Town 1', 45.7, 7.85)],
        baseReasons: [
          { clusterId: 'long', reason: 'The densest part.', nights: 4, transferMinutes: 0 },
        ],
        satellites: [],
        excluded: [],
      }),
      'Ambervale',
    )!;
    const label = figure.marks[0]!.label!;
    expect(label.lines[0]).toBe('Ambervale Highlan…');
    expect(label.lines[1]).toBe('Base 1 · 4 nights');
  });
});

describe('the distance rings', () => {
  it('draws a day out and back from every base, at the reach the structure used', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    const day = figure.rings.filter((ring) => ring.kind === 'day_reach');
    expect(day).toHaveLength(3);
    for (const ring of day) expect(ring.radiusKm).toBe(DAY_REACH_KM.drive);
    expect(figure.dayReachKm).toBe(DAY_REACH_KM.drive);
  });

  /**
   * A compact structure: everything is a day trip, so the reach the compilation
   * will use is only a little wider than the ground already on screen and the
   * ring is worth drawing.
   */
  const compact = portfolio({
    route: [cluster('one', 'Alderwick', 47.0, 8.0)],
    baseReasons: [
      { clusterId: 'one', reason: 'Everything is a day trip from here.', nights: 5, transferMinutes: 0 },
    ],
    satellites: [
      { cluster: cluster('two', 'Brookvale', 47.06, 8.05), baseId: 'one', transferMinutes: 30 },
    ],
    excluded: [],
    mode: 'walk',
    reachRadiusKm: 15,
  });

  it('draws the structure reach around the first base when it fits on the canvas', () => {
    const figure = buildRegionFigure(compact, 'Testland')!;
    const region = figure.rings.filter((ring) => ring.kind === 'region_reach');
    expect(region).toHaveLength(1);
    expect(region[0]!.radiusKm).toBe(15);
    expect(figure.regionRingDrawn).toBe(true);
  });

  /**
   * AND THE CASE THAT ACTUALLY DOMINATED THE FIRST CAPTURE.
   *
   * A 306 km structure reach around bases a couple of hundred kilometres apart
   * pushed every mark into a knot in the middle of a mostly empty circle. The
   * structure sets the frame; a reach that will not fit inside it is reported in
   * words by the caller instead of being drawn off the edge of the canvas.
   */
  it('states rather than draws a reach that will not fit', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    expect(figure.rings.filter((ring) => ring.kind === 'region_reach')).toHaveLength(0);
    expect(figure.regionRingDrawn).toBe(false);
    expect(figure.regionReachKm).toBe(306);
  });

  it('omits the structure reach when it would be the day reach drawn twice', () => {
    const figure = buildRegionFigure(
      portfolio({
        route: [HARBOUR],
        baseReasons: [
          { clusterId: 'harbour', reason: 'Everything is within a day.', nights: 5, transferMinutes: 0 },
        ],
        satellites: [],
        excluded: [],
        mode: 'walk',
        reachRadiusKm: DAY_REACH_KM.walk,
      }),
      'Harbourmouth',
    )!;
    expect(figure.rings.filter((ring) => ring.kind === 'region_reach')).toHaveLength(0);
    expect(figure.regionReachKm).toBeNull();
  });

  it('closes every ring, and draws it from real vertices rather than an ellipse', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    for (const ring of figure.rings) {
      expect(ring.path.endsWith(' Z')).toBe(true);
      expect(ring.path.split('L')).toHaveLength(72);
    }
  });

  it('fits every ring it draws inside the frame rather than clipping it into an arc', () => {
    for (const figure of [buildRegionFigure(portfolio(), 'Testland')!, buildRegionFigure(compact, 'Testland')!]) {
      for (const ring of figure.rings) {
        const vertices = ring.path
          .split(/[MLZ]/)
          .filter((part) => part.trim().length > 0)
          .map((pair) => pair.trim().split(' ').map(Number));
        for (const [x, y] of vertices) {
          expect(Number.isFinite(x!) && Number.isFinite(y!)).toBe(true);
          expect(x!).toBeGreaterThanOrEqual(-1);
          expect(x!).toBeLessThanOrEqual(figure.width + 1);
          expect(y!).toBeGreaterThanOrEqual(-1);
          expect(y!).toBeLessThanOrEqual(figure.height + 1);
        }
      }
    }
  });
});

describe('the scale bar', () => {
  it('states a round distance that fits under the frame', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    expect(figure.scale.pixels).toBeGreaterThan(10);
    expect(figure.scale.pixels).toBeLessThanOrEqual(figure.width * 0.45);
    expect(figure.scale.km).toBeGreaterThan(0);
  });

  it('is measured at the latitude it is drawn at', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    const kmPerPixel = figure.viewport.kmPerPixelAt(figure.scaleLatitude);
    expect(figure.scale.km / kmPerPixel).toBeCloseTo(figure.scale.pixels, 6);
  });
});

describe('the words that stand in for the figure', () => {
  it('counts the structure rather than describing the drawing', () => {
    const figure = buildRegionFigure(portfolio(), 'Testland')!;
    expect(figure.summary).toContain('Testland');
    expect(figure.summary).toContain('3 bases');
    expect(figure.summary).toContain('1 area reachable in a day');
    expect(figure.summary).toContain('1 area left out');
    expect(figure.summary).toContain('straight-line estimates');
  });

  it('says nothing about areas left out when none were', () => {
    const figure = buildRegionFigure(portfolio({ excluded: [] }), 'Testland')!;
    expect(figure.summary).not.toContain('left out');
  });
});

describe('a travel estimate', () => {
  it('carries its own uncertainty', () => {
    expect(estimatedTravel(34)).toBe('≈34 min');
    expect(estimatedTravel(120)).toBe('≈2 hr');
    expect(estimatedTravel(125)).toBe('≈2 hr 5 min');
  });
});

/**
 * ATTRIBUTION WHEN TWO MARKS LAND ON TOP OF EACH OTHER.
 *
 * The failure this covers came out of a capture, not a test: two bases eight
 * pixels apart had their labels pushed to opposite sides of their shared
 * position. Both names were perfectly legible and neither could be matched to a
 * disc. A leader line does not fix it — every candidate position is already
 * touching the mark — so the label carries the numeral instead.
 */
/** The furthest a first-ring candidate can put a base label from its mark. */
function firstRingReach(): number {
  return 6.5 + 9.5 + 2;
}

describe('a label says which mark it belongs to', () => {
  const overlapping = portfolio({
    route: [cluster('one', 'Alderwick', 47.0, 8.0), cluster('two', 'Bramblehead', 47.005, 8.006)],
    baseReasons: [
      { clusterId: 'one', reason: 'The densest part.', nights: 2, transferMinutes: 0 },
      { clusterId: 'two', reason: 'A short move for the second half.', nights: 2, transferMinutes: 15 },
    ],
    satellites: [],
    excluded: [{ cluster: cluster('far', 'Farfield', 49.5, 11.5), reason: 'Too far for these dates.' }],
    mode: 'walk',
    reachRadiusKm: 30,
  });

  it('repeats the route number the disc carries', () => {
    const figure = buildRegionFigure(overlapping, 'Testland')!;
    const bases = figure.marks.filter((mark) => mark.role === 'base');
    expect(bases[0]!.label!.lines).toEqual(['Alderwick', 'Base 1 · 2 nights']);
    expect(bases[1]!.label!.lines).toEqual(['Bramblehead', 'Base 2 · 2 nights']);
  });

  it('still names the base when the portfolio holds no nights for it', () => {
    const figure = buildRegionFigure(
      portfolio({
        route: [cluster('solo', 'Alderwick', 47.0, 8.0)],
        baseReasons: [{ clusterId: 'solo', reason: 'The only place to stay.', nights: 0, transferMinutes: 0 }],
        satellites: [],
        excluded: [],
      }),
      'Testland',
    )!;
    expect(figure.marks[0]!.label!.lines).toEqual(['Alderwick', 'Base 1']);
  });

  it('proves the two marks really do collide, so the test is about the case it names', () => {
    const figure = buildRegionFigure(overlapping, 'Testland')!;
    const [first, second] = figure.marks.filter((mark) => mark.role === 'base');
    expect(Math.hypot(first!.at.x - second!.at.x, first!.at.y - second!.at.y)).toBeLessThan(12);
  });

  /**
   * The placement consequence of that collision, and the reason the candidate
   * set has two rings rather than one: with a single ring, the second base's
   * name had nowhere to sit that was not already taken and was dropped — one of
   * two bases silently unnamed on the screen that is about choosing bases.
   */
  it('finds a crowded base a place further out rather than dropping its name', () => {
    const figure = buildRegionFigure(overlapping, 'Testland')!;
    const bases = figure.marks.filter((mark) => mark.role === 'base');
    for (const base of bases) expect(base.label, `${base.name} lost its label`).not.toBeNull();
    // One of them had to leave the ring of positions touching its own mark.
    const distances = bases.map((base) => Math.abs(base.label!.y - base.at.y));
    expect(Math.max(...distances)).toBeGreaterThan(firstRingReach());
  });
});
