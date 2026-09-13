import { describe, expect, it } from 'vitest';
import { buildTripQualityReport, TRIP_QUALITY_DIMENSIONS, type TripQualityInput } from './trip-quality';
import type { Stay, Chapter } from '../experience/chapters';

const itinerary = (overrides: Record<string, unknown> = {}) =>
  ({ days: [{ dayNumber: 1 }, { dayNumber: 2 }], package: undefined, transportStrategy: { primaryMode: 'drive' }, ...overrides }) as unknown as TripQualityInput['itinerary'];

describe('V11 §2 — the trip quality report', () => {
  it('never produces a single score', () => {
    const report = buildTripQualityReport({ itinerary: itinerary() });
    expect(Object.keys(report)).toEqual(['version', 'findings', 'weak', 'unmeasured']);
    expect(JSON.stringify(report)).not.toMatch(/"overall"|"total"|"grade"/);
  });

  it('reports every dimension exactly once', () => {
    const report = buildTripQualityReport({ itinerary: itinerary() });
    expect(report.findings.map((f) => f.dimension).sort()).toEqual([...TRIP_QUALITY_DIMENSIONS].sort());
  });

  it('says unknown rather than weak when nothing could be measured, and never counts it as weak', () => {
    const report = buildTripQualityReport({ itinerary: itinerary() });
    expect(report.unmeasured.length).toBeGreaterThan(0);
    for (const dimension of report.unmeasured) expect(report.weak).not.toContain(dimension);
  });

  it('calls a day that covers 80% more ground than its stops require weak', () => {
    /* The Canadian Rockies day 4: Banff → Jasper → back 189 km to Peyto Lake → north again. */
    const report = buildTripQualityReport({ itinerary: itinerary(), dayExcess: [{ dayNumber: 4, excessRatio: 0.8 }, { dayNumber: 2, excessRatio: 0 }] });
    expect(report.findings.find((f) => f.dimension === 'routeCoherence')?.verdict).toBe('weak');
    expect(report.weak).toContain('routeCoherence');
  });

  it('calls a clean set of days strong', () => {
    const report = buildTripQualityReport({ itinerary: itinerary(), dayExcess: [{ dayNumber: 1, excessRatio: 0 }, { dayNumber: 2, excessRatio: 0.05 }] });
    expect(report.findings.find((f) => f.dimension === 'routeCoherence')?.verdict).toBe('strong');
  });

  it('calls the founder Kyrgyzstan base sequence weak, and the collapsed one better', () => {
    const shipped: Stay[] = [
      { id: '1', baseIds: ['1'], name: 'A', nights: 1, countsAsHotelChange: false },
      { id: '2', baseIds: ['2'], name: 'B', nights: 2, countsAsHotelChange: true },
      { id: '3', baseIds: ['3'], name: 'C', nights: 2, countsAsHotelChange: true },
      { id: '4', baseIds: ['4'], name: 'B', nights: 1, countsAsHotelChange: true },
      { id: '5', baseIds: ['5'], name: 'B', nights: 1, countsAsHotelChange: true },
      { id: '6', baseIds: ['6'], name: 'D', nights: 2, countsAsHotelChange: true },
      { id: '7', baseIds: ['7'], name: 'A', nights: 1, countsAsHotelChange: true },
    ];
    expect(buildTripQualityReport({ itinerary: itinerary(), stays: shipped }).weak).toContain('baseEfficiency');

    const normalized: Stay[] = [
      { id: '1', baseIds: ['1'], name: 'A', nights: 1, countsAsHotelChange: false },
      { id: '2', baseIds: ['2'], name: 'B', nights: 2, countsAsHotelChange: true },
      { id: '3', baseIds: ['3'], name: 'C', nights: 2, countsAsHotelChange: false, withinExperience: 'Trek' },
      { id: '4', baseIds: ['4', '5'], name: 'B', nights: 2, countsAsHotelChange: true },
      { id: '6', baseIds: ['6'], name: 'D', nights: 2, countsAsHotelChange: false, withinExperience: 'Yurt' },
      { id: '7', baseIds: ['7'], name: 'A', nights: 1, countsAsHotelChange: true },
    ];
    expect(buildTripQualityReport({ itinerary: itinerary(), stays: normalized }).weak).not.toContain('baseEfficiency');
  });

  it('calls a bus on a private-driver trip a stray mode', () => {
    const report = buildTripQualityReport({ itinerary: itinerary(), transport: { declared: 'private_transfer', used: ['private_transfer', 'walk', 'public_bus'] } });
    expect(report.findings.find((f) => f.dimension === 'transportConsistency')?.verdict).toBe('adequate');
    const worse = buildTripQualityReport({ itinerary: itinerary(), transport: { declared: 'private_transfer', used: ['private_transfer', 'public_bus', 'rail'] } });
    expect(worse.weak).toContain('transportConsistency');
  });

  it('never treats walking as a stray mode, because every trip walks', () => {
    const report = buildTripQualityReport({ itinerary: itinerary(), transport: { declared: 'drive', used: ['drive', 'walk'] } });
    expect(report.findings.find((f) => f.dimension === 'transportConsistency')?.verdict).toBe('strong');
  });

  it('calls one refused measurement worse than several missing ones', () => {
    const complete = { basesPlaced: 4, basesTotal: 4, routeCriticalPlaced: 4, routeCriticalTotal: 4, baseTransfersTimed: 3, baseTransfersTotal: 3, signaturesPlaced: 3, signaturesTotal: 3, orderContradictions: 0, implausibleMeasurements: 0, unrepresentedAccessRequirements: 0, legsTimed: 28, legsTotal: 30 };
    expect(buildTripQualityReport({ itinerary: itinerary(), completeness: complete }).findings.find((f) => f.dimension === 'measurementIntegrity')?.verdict).toBe('strong');
    expect(buildTripQualityReport({ itinerary: itinerary(), completeness: complete, implausibleMeasurements: 1 }).weak).toContain('measurementIntegrity');
  });

  it('calls the Rockies placement rate weak', () => {
    const rockies = { basesPlaced: 4, basesTotal: 4, routeCriticalPlaced: 12, routeCriticalTotal: 24, baseTransfersTimed: 3, baseTransfersTotal: 3, signaturesPlaced: 2, signaturesTotal: 3, orderContradictions: 0, implausibleMeasurements: 0, unrepresentedAccessRequirements: 1, legsTimed: 14, legsTotal: 37 };
    expect(buildTripQualityReport({ itinerary: itinerary(), completeness: rockies }).weak).toEqual(expect.arrayContaining(['routeCriticalPlacement', 'measurementIntegrity']));
  });

  it('does not blame the traveller for uncertainty that is ours', () => {
    const ours = itinerary({ package: { feasibility: { items: [{ severity: 'dependency', owner: 'sidequest', detail: 'x' }, { severity: 'dependency', owner: 'sidequest', detail: 'y' }] } } });
    expect(buildTripQualityReport({ itinerary: ours }).findings.find((f) => f.dimension === 'uncertaintyBurden')?.verdict).toBe('adequate');
    const theirs = itinerary({ package: { feasibility: { items: [1, 2, 3].map((n) => ({ severity: 'dependency', owner: 'traveller', detail: `x${n}` })) } } });
    expect(buildTripQualityReport({ itinerary: theirs }).weak).toContain('uncertaintyBurden');
  });

  it('wants a demanding chapter followed by a lighter one', () => {
    const chapters: Chapter[] = [
      { id: 'c1', title: 'A', role: 'arrival', dayNumbers: [1], stayIds: ['1'], nights: 1 },
      { id: 'c2', title: 'Trek', role: 'expedition', dayNumbers: [2, 3, 4], stayIds: ['2'], nights: 3, experience: 'Trek' },
      { id: 'c3', title: 'Yurt', role: 'expedition', dayNumbers: [5, 6], stayIds: ['3'], nights: 2, experience: 'Yurt' },
      { id: 'c4', title: 'B', role: 'finale', dayNumbers: [7], stayIds: ['4'], nights: 1 },
    ];
    /* Two expeditions back to back: one of them has no recovery after it. */
    expect(buildTripQualityReport({ itinerary: itinerary(), chapters }).findings.find((f) => f.dimension === 'recoveryPlacement')?.verdict).toBe('adequate');
  });

  it('calls an undifferentiated trip weak on rhythm', () => {
    const one: Chapter[] = [{ id: 'c1', title: 'A', role: 'exploration', dayNumbers: [1, 2, 3, 4, 5], stayIds: ['1'], nights: 5 }];
    expect(buildTripQualityReport({ itinerary: itinerary(), chapters: one }).weak).toContain('chapterRhythm');
  });
});
