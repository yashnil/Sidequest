import type { GeoPoint, TravelTimeMatrix, TravelTimeProvider } from '@sidequest/geo';
import { EASTERN_SIERRA } from './regions';
import { EASTERN_SIERRA_PLACES } from './places';

/**
 * A modelled travel-time matrix for the Eastern Sierra.
 *
 * WHY A MODEL RATHER THAN STRAIGHT-LINE DISTANCE
 *
 * Haversine distance is worse than useless here. Devils Postpile is 6 km from the
 * Panorama Gondola as the raven flies and roughly an hour apart by road, because
 * the only way in is back down Minaret Road. A planner fed straight-line numbers
 * would cheerfully build a day that cannot be driven.
 *
 * WHAT THIS MODEL IS
 *
 * The Eastern Sierra really is a linear road network: US-395 runs north-south
 * through the region, and everything hangs off it on a spur. So each place gets
 * two numbers — how far along the corridor it sits (signed: negative south of
 * Mammoth Lakes, positive north) and how far up its spur road it is — plus the
 * name of the spur it shares with its neighbours.
 *
 *   same spur road      → |spurA - spurB|
 *   different spurs     → |corridorA - corridorB| + spurA + spurB
 *
 * That one rule reproduces every authored base-to-place drive time exactly (there
 * is a test for it) and produces sane place-to-place times: Minaret Vista to
 * Devils Postpile stays on Minaret Road at 30 minutes rather than routing back
 * through town, and June Lake to Mono Lake comes out at 35.
 *
 * WHAT THIS MODEL IS NOT
 *
 * It is not measured road data. It carries `modelled` provenance so nothing
 * downstream can present it as a verified drive time, and it ignores traffic,
 * season, grade and the difference between a paved highway and a graded dirt
 * spur. It exists to be replaced: implement `TravelTimeProvider` against a real
 * routing service and nothing else in the planner changes.
 */

export const EASTERN_SIERRA_BASE_ID = 'base-mammoth-lakes';

interface CorridorNode {
  /** Signed minutes along US-395 from Mammoth Lakes. South is negative. */
  corridorMinutes: number;
  /** Minutes from the highway up this place's spur road. */
  spurMinutes: number;
  /**
   * Places sharing a spur road. `null` means the place sits on US-395 itself, so
   * the corridor rule always applies.
   */
  spurGroup: string | null;
}

/**
 * Authored so that `|corridorMinutes| + spurMinutes` equals the `driveMinutes`
 * already recorded on each place. `travel-times.test.ts` enforces that.
 */
const CORRIDOR: Record<string, CorridorNode> = {
  [EASTERN_SIERRA_BASE_ID]: { corridorMinutes: 0, spurMinutes: 0, spurGroup: null },

  'the-village-at-mammoth': { corridorMinutes: 0, spurMinutes: 3, spurGroup: 'mammoth-town' },
  'earthquake-fault': { corridorMinutes: 0, spurMinutes: 8, spurGroup: 'minaret-road' },
  'mammoth-lakes-basin': { corridorMinutes: 0, spurMinutes: 10, spurGroup: 'lakes-basin' },
  'panorama-gondola': { corridorMinutes: 0, spurMinutes: 12, spurGroup: 'minaret-road' },
  'minaret-vista': { corridorMinutes: 0, spurMinutes: 15, spurGroup: 'minaret-road' },
  'sherwin-lakes-trail': { corridorMinutes: 0, spurMinutes: 15, spurGroup: 'sherwin-creek-road' },
  // Reds Meadow valley: same road, same shuttle, beyond Minaret Vista.
  'devils-postpile': { corridorMinutes: 0, spurMinutes: 45, spurGroup: 'minaret-road' },
  'rainbow-falls': { corridorMinutes: 0, spurMinutes: 50, spurGroup: 'minaret-road' },

  'convict-lake': { corridorMinutes: -18, spurMinutes: 2, spurGroup: 'convict-lake-road' },
  'hot-creek-geologic-site': { corridorMinutes: -12, spurMinutes: 13, spurGroup: 'hot-creek-road' },
  'mcgee-creek-canyon': { corridorMinutes: -20, spurMinutes: 5, spurGroup: 'mcgee-creek-road' },
  'wild-willys-hot-spring': { corridorMinutes: -15, spurMinutes: 15, spurGroup: 'crowley-road' },
  'little-lakes-valley': { corridorMinutes: -33, spurMinutes: 12, spurGroup: 'rock-creek-road' },
  'bishop-town': { corridorMinutes: -45, spurMinutes: 0, spurGroup: null },
  'manzanar-historic-site': { corridorMinutes: -95, spurMinutes: 0, spurGroup: null },
  'alabama-hills': { corridorMinutes: -132, spurMinutes: 3, spurGroup: 'movie-road' },

  'inyo-craters': { corridorMinutes: 12, spurMinutes: 13, spurGroup: 'inyo-craters-road' },
  'obsidian-dome': { corridorMinutes: 20, spurMinutes: 10, spurGroup: 'obsidian-dome-road' },
  'june-lake-loop': { corridorMinutes: 25, spurMinutes: 10, spurGroup: 'highway-158' },
  'mono-lake-south-tufa': { corridorMinutes: 45, spurMinutes: 5, spurGroup: 'mono-basin' },
  'tioga-pass-tuolumne': { corridorMinutes: 45, spurMinutes: 30, spurGroup: 'highway-120' },
  'bodie-state-historic-park': { corridorMinutes: 57, spurMinutes: 23, spurGroup: 'bodie-road' },
};

/** Distance is split along the same corridor/spur proportions as time. */
interface CorridorGeometry extends CorridorNode {
  corridorKm: number;
  spurKm: number;
}

function geometryFor(id: string): CorridorGeometry {
  const node = CORRIDOR[id];
  if (!node) {
    throw new Error(`No corridor position recorded for "${id}".`);
  }
  const totalMinutes = Math.abs(node.corridorMinutes) + node.spurMinutes;
  const place = EASTERN_SIERRA_PLACES.find((candidate) => candidate.id === id);
  const totalKm = place?.travelFromBase.distanceKm ?? 0;

  if (totalMinutes === 0) {
    return { ...node, corridorKm: 0, spurKm: 0 };
  }
  const corridorShare = Math.abs(node.corridorMinutes) / totalMinutes;
  return {
    ...node,
    corridorKm: totalKm * corridorShare * Math.sign(node.corridorMinutes || 1),
    spurKm: totalKm * (1 - corridorShare),
  };
}

function pairMinutes(a: CorridorGeometry, b: CorridorGeometry): number {
  if (a.spurGroup !== null && a.spurGroup === b.spurGroup) {
    return Math.abs(a.spurMinutes - b.spurMinutes);
  }
  return Math.abs(a.corridorMinutes - b.corridorMinutes) + a.spurMinutes + b.spurMinutes;
}

function pairKm(a: CorridorGeometry, b: CorridorGeometry): number {
  if (a.spurGroup !== null && a.spurGroup === b.spurGroup) {
    return Math.abs(a.spurKm - b.spurKm);
  }
  return Math.abs(a.corridorKm - b.corridorKm) + a.spurKm + b.spurKm;
}

export function easternSierraPoints(): GeoPoint[] {
  const base: GeoPoint = {
    id: EASTERN_SIERRA_BASE_ID,
    lat: EASTERN_SIERRA.baseCoordinates.lat,
    lng: EASTERN_SIERRA.baseCoordinates.lng,
  };
  return [
    base,
    ...EASTERN_SIERRA_PLACES.map((place) => ({
      id: place.id,
      lat: place.coordinates.lat,
      lng: place.coordinates.lng,
    })),
  ];
}

/**
 * Builds the matrix for the given ids (default: base plus every seeded place).
 * Round to whole minutes so the output is stable and comparable.
 */
export function easternSierraTravelMatrix(ids?: readonly string[]): TravelTimeMatrix {
  const pointIds = ids ? [...ids] : easternSierraPoints().map((point) => point.id);
  const geometry = pointIds.map((id) => geometryFor(id));

  return {
    mode: 'car',
    ids: pointIds,
    minutes: geometry.map((from) =>
      geometry.map((to) => (from === to ? 0 : Math.round(pairMinutes(from, to)))),
    ),
    km: geometry.map((from) =>
      geometry.map((to) => (from === to ? 0 : Math.round(pairKm(from, to) * 10) / 10)),
    ),
    provenance: {
      kind: 'modelled',
      note: 'Modelled from an authored US-395 corridor-and-spur topology, not measured road data. Replace with a routing provider before relying on exact times.',
      source: 'packages/core/src/data/travel-times.ts',
    },
  };
}

/**
 * The offline provider used everywhere today. Async to match the interface a real
 * routing service will implement, so swapping it in is not a signature change.
 */
export const easternSierraTravelTimeProvider: TravelTimeProvider = {
  name: 'eastern-sierra-corridor-model',
  async getMatrix(points, mode) {
    if (mode !== 'car') {
      throw new Error(`The Eastern Sierra corridor model only covers driving, not "${mode}".`);
    }
    return easternSierraTravelMatrix(points.map((point) => point.id));
  },
};
