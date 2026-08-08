import { describe, expect, it } from 'vitest';
import type { BenchFinding } from '@sidequest/bench';
import { fixturePacketInputs } from './fixtures';
import { buildResearchPacket } from './packet';
import { MAX_REPAIR_FINDINGS, packetSliceFor, repairableFindings } from './repair';

/**
 * A REPAIR THAT CAN ONLY DELETE IS NOT A REPAIR.
 *
 * The one correction attempt is narrow on purpose — fix these findings, change
 * nothing else — and the narrowness was applied to the wrong thing. The slice of
 * the packet it received held exactly the places the findings *named*, so a
 * museum shut on a Monday could be dropped and could not be swapped for the
 * gallery two streets away: the gallery was not in front of the model. The
 * findings stay narrow; the evidence is now wide enough to act on.
 */

const packet = buildResearchPacket(fixturePacketInputs());

function finding(overrides: Partial<BenchFinding> = {}): BenchFinding {
  return {
    code: 'scheduled_while_closed',
    severity: 'critical',
    subject: { dayNumber: 1, blockIndex: 0, entityId: 'node/1003' },
    message: 'The museum is shut at that hour.',
    groundTruth: 'openingOn',
    observed: {},
    expected: {},
    ...overrides,
  } as BenchFinding;
}

describe('the slice one repair is shown', () => {
  it('holds the offending place', () => {
    const slice = packetSliceFor(packet, [finding()]);
    expect(slice.places.map((place) => place.entityId)).toContain('node/1003');
  });

  /**
   * The property the whole change is for: something else to put there. The
   * museum's own cluster travels with it, so a substitution is available and is
   * a substitution within walking distance of where the day already was.
   */
  it('holds the rest of the offending place’s cluster, so a swap is possible', () => {
    const offending = packet.places.find((place) => place.entityId === 'node/1003');
    expect(offending?.clusterIndex).not.toBeNull();

    const slice = packetSliceFor(packet, [finding()]);
    const neighbours = packet.places.filter(
      (place) =>
        place.clusterIndex === offending?.clusterIndex && place.entityId !== 'node/1003',
    );
    expect(neighbours.length).toBeGreaterThan(0);
    for (const neighbour of neighbours) {
      expect(slice.places.map((place) => place.entityId)).toContain(neighbour.entityId);
    }
    expect(slice.clusters.map((cluster) => cluster.index)).toEqual([offending?.clusterIndex]);
  });

  /**
   * A day that is too long or a total that does not add up names no place at
   * all, and there is no neighbourhood to narrow to — so the whole inventory
   * travels rather than an empty list that offers nothing to fix it with.
   */
  it('sends the whole inventory when the findings name no place', () => {
    const slice = packetSliceFor(packet, [
      finding({ code: 'daily_travel_exceeded', subject: { dayNumber: 2 } }),
    ]);
    expect(slice.places).toHaveLength(packet.places.length);
    expect(slice.days.map((day) => day.dayNumber)).toEqual([2]);
  });

  it('keeps only the legs whose both ends it is showing', () => {
    const slice = packetSliceFor(packet, [finding()]);
    const indices = new Set(slice.places.map((place) => place.index));
    for (const leg of slice.routeLegs) {
      expect(indices.has(leg.fromIndex)).toBe(true);
      expect(indices.has(leg.toIndex)).toBe(true);
    }
  });

  /**
   * The narrowness that stayed. Minor and informational findings invite polish,
   * and polish is how a correction quietly rewrites a plan that was acceptable;
   * an `unknown` finding means a check could not be decided, and asking a model
   * to fix one is asking it to supply the missing evidence.
   */
  it('acts on the findings that mean the trip does not work, and no others', () => {
    const findings = [
      finding({ severity: 'critical' }),
      finding({ severity: 'major' }),
      finding({ severity: 'minor' }),
      finding({ severity: 'informational' }),
      finding({ severity: 'unknown' }),
    ];
    const worth = repairableFindings(findings);
    expect(worth.map((entry) => entry.severity)).toEqual(['critical', 'major']);
    expect(repairableFindings(Array.from({ length: 40 }, () => finding()))).toHaveLength(
      MAX_REPAIR_FINDINGS,
    );
  });
});
