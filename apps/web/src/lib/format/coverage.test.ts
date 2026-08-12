import { describe, expect, it } from 'vitest';
import type { CoverageReport } from '@sidequest/core';
import { coverageHeadline, reconcileRouting, type RoutingTruth } from './coverage';

type Dimension = CoverageReport['dimensions'][number];

/**
 * THE CONTRADICTION THIS FILE EXISTS TO MAKE UNRENDERABLE.
 *
 * Read off a live artifact on 2026-08-11, three rows apart on one screen:
 *
 * ```text
 * WALKING TIMES     Good              Measured road times across 26 points.
 * PUBLIC TRANSPORT  Good              Measured road times across 26 points.
 * DRIVING TIMES     Not relevant here No driving is planned here.
 * ```
 *
 * The compiler that wrote it has been repaired. The artifact has not, and never
 * will be without a paid rebuild, so the guard has to live at the point of
 * reading.
 */
const roadSentence = 'Measured road times across 26 points.';

function dimension(
  name: Dimension['dimension'],
  level: Dimension['level'],
  detail: string,
): Dimension {
  return { dimension: name, level, reasons: ['fully_covered'], detail };
}

const legacyCarFreeArtifact: Dimension[] = [
  dimension('road_routing', 'not_applicable', 'No driving is planned here.'),
  dimension('walking_routing', 'high', roadSentence),
  dimension('transit_routing', 'high', roadSentence),
  dimension('operating_hours', 'unavailable', '0 of 24 have a published calendar.'),
];

describe('a road matrix cannot be rendered under another heading', () => {
  it('refuses a road sentence under public transport when nothing measured a timetable', () => {
    const truth: RoutingTruth = { matrixMode: 'car', transitMeasured: 0, transitRequested: 0 };
    const rows = reconcileRouting(legacyCarFreeArtifact, truth);

    const transit = rows.find((row) => row.dimension === 'transit_routing')!;
    expect(transit.detail).not.toContain('road');
    expect(transit.level).toBe('unavailable');
    expect(transit.detail).toMatch(/unverified/);
  });

  it('refuses a road sentence under walking times when the matrix is a car matrix', () => {
    const truth: RoutingTruth = { matrixMode: 'car', transitMeasured: 0, transitRequested: 0 };
    const rows = reconcileRouting(legacyCarFreeArtifact, truth);

    const walking = rows.find((row) => row.dimension === 'walking_routing')!;
    expect(walking.detail).not.toMatch(/^Measured road/);
    expect(walking.level).not.toBe('high');
  });

  it('calls an unmeasured walk a gap on a car-free trip and not on a driving one', () => {
    // The artifact above says no driving is planned, so walking is how the
    // traveller gets everywhere and an unmeasured walk is a real gap. Filing it
    // under "Not relevant here" — which is what the stored level did — is the
    // quiet version of the same substitution.
    const carFree = reconcileRouting(legacyCarFreeArtifact, {
      matrixMode: 'car',
      transitMeasured: 0,
      transitRequested: 0,
    }).find((row) => row.dimension === 'walking_routing')!;
    expect(carFree.level).toBe('unavailable');

    const driving = reconcileRouting(
      [
        dimension('road_routing', 'high', 'Measured road times across 26 points.'),
        dimension('walking_routing', 'high', 'Measured road times across 26 points.'),
      ],
      { matrixMode: 'car', transitMeasured: 0, transitRequested: 0 },
    ).find((row) => row.dimension === 'walking_routing')!;
    expect(driving.level).toBe('not_applicable');
  });

  it('tells "nobody was asked" apart from "we asked and nothing came back"', () => {
    const asked = reconcileRouting(legacyCarFreeArtifact, {
      matrixMode: 'car',
      transitMeasured: 0,
      transitRequested: 12,
    }).find((row) => row.dimension === 'transit_routing')!;
    expect(asked.detail).toMatch(/no timetable came back/);

    const neverAsked = reconcileRouting(legacyCarFreeArtifact, {
      matrixMode: 'car',
      transitMeasured: 0,
      transitRequested: 0,
    }).find((row) => row.dimension === 'transit_routing')!;
    expect(neverAsked.detail).toMatch(/Nothing in this build/);
  });

  it('leaves a row the artifact can support exactly as it was stored', () => {
    const honest: Dimension[] = [
      dimension('walking_routing', 'high', 'Measured walking times across 26 points.'),
      dimension('transit_routing', 'high', '9 of 12 journeys checked against published timetables.'),
      dimension('operating_hours', 'weak', 'Some hours are missing.'),
    ];
    const rows = reconcileRouting(honest, {
      matrixMode: 'foot',
      transitMeasured: 9,
      transitRequested: 12,
    });
    expect(rows).toEqual(honest);
  });

  it('touches nothing outside routing', () => {
    const rows = reconcileRouting(legacyCarFreeArtifact, {
      matrixMode: 'car',
      transitMeasured: 0,
      transitRequested: 0,
    });
    const hours = rows.find((row) => row.dimension === 'operating_hours')!;
    expect(hours).toEqual(legacyCarFreeArtifact[3]);
  });
});

/**
 * The other half of the plan-page repair: what leads, versus what is disclosed.
 */
describe('what a traveller is told before the questionnaire', () => {
  it('leads with what we found rather than with a grade', () => {
    const headline = coverageHeadline({
      dimensions: legacyCarFreeArtifact,
      placeCount: 24,
      areaCount: 5,
      baseName: 'Shinjuku',
    });
    expect(headline.found).toBe(
      'We found 24 places worth your time around Shinjuku, across 5 areas.',
    );
    expect(headline.found).not.toMatch(/coverage|dimension|Good|Thin/);
  });

  it('names at most two gaps, and only ones that change planning', () => {
    const headline = coverageHeadline({
      dimensions: [
        dimension('operating_hours', 'unavailable', ''),
        dimension('transit_routing', 'unavailable', ''),
        dimension('access_evidence', 'unavailable', ''),
        dimension('dietary_evidence', 'unavailable', ''),
      ],
      placeCount: 24,
      areaCount: 1,
      baseName: 'Shinjuku',
    });
    expect(headline.gaps).toHaveLength(2);
    // Dietary information is a real gap and not one that changes a plan.
    expect(headline.gaps.join(' ')).not.toMatch(/diet/i);
  });

  it('says nothing at all when nothing planning-critical is missing', () => {
    const headline = coverageHeadline({
      dimensions: [dimension('operating_hours', 'high', 'All published.')],
      placeCount: 12,
      areaCount: 1,
      baseName: 'Reykjavík',
    });
    expect(headline.gaps).toEqual([]);
  });
});
