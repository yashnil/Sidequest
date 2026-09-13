import { describe, expect, it } from 'vitest';
import {
  accessRefOf,
  doubleCounted,
  experienceGraphSchema,
  experienceMinutes,
  requiredAccess,
  transportBetweenStops,
  type ExperienceGraph,
} from './graph';

/**
 * V10 §4 §13 §22 — the shapes the schema has to be able to hold, and the
 * invariant that stops an activity inside an experience becoming transport.
 * Each case below is one of the shapes the brief names.
 */
function graph(experiences: ExperienceGraph['experiences']): ExperienceGraph {
  return experienceGraphSchema.parse({ version: 1, experiences });
}

/** Jökulsárlón: a lagoon, the beach its bergs reach, and a boat among them. */
const JOKULSARLON = graph([
  {
    id: 'jokulsarlon',
    anchorId: 'd5-a1-jokulsarlon',
    name: 'Jökulsárlón glacier lagoon',
    dayNumber: 5,
    coordinates: { lat: 64.0784, lng: -16.2306 },
    access: [{ label: 'Lagoon car park', mode: 'drive', minutesEachWay: 0, required: false, reservationRequired: false }],
    components: [
      { id: 'lagoon-shore', name: 'Lagoon shore', kind: 'viewpoint', minutes: 45, defining: true, optional: false, reservationRequired: false },
      { id: 'diamond-beach', name: 'Diamond Beach', kind: 'sub_place', coordinates: { lat: 64.0443, lng: -16.1777 }, minutes: 45, defining: true, optional: false, reservationRequired: false },
      { id: 'zodiac', name: 'Zodiac tour among the icebergs', kind: 'guided_movement', minutes: 60, defining: false, optional: true, reservationRequired: true },
    ],
    dayNumbers: [],
  },
]);

/** Lake Louise: one lakeshore trailhead, two upper objectives, a tea house on the trail. */
const LAKE_LOUISE = graph([
  {
    id: 'lake-louise-trails',
    name: 'Lake Louise upper trails',
    dayNumber: 4,
    coordinates: { lat: 51.4161, lng: -116.2165 },
    access: [{ label: 'Lakeshore trailhead', mode: 'shuttle', minutesEachWay: 20, required: true, reservationRequired: true, note: 'Private vehicles are not admitted to the lakeshore in season.' }],
    components: [
      { id: 'lake-agnes', name: 'Lake Agnes', kind: 'sub_place', minutes: 120, defining: true, optional: false, reservationRequired: false },
      { id: 'agnes-tea-house', name: 'Lake Agnes Tea House', kind: 'refreshment', minutes: 40, defining: false, optional: true, reservationRequired: false },
      { id: 'plain-of-six', name: 'Plain of Six Glaciers', kind: 'sub_place', minutes: 150, defining: true, optional: true, reservationRequired: false },
      { id: 'highline', name: 'Highline traverse between the two', kind: 'traverse', minutes: 75, defining: false, optional: true, reservationRequired: false },
    ],
    dayNumbers: [],
  },
]);

describe('the experience graph', () => {
  it('holds a lagoon, its beach and a boat tour as one experience', () => {
    expect(JOKULSARLON.experiences[0]!.components).toHaveLength(3);
    expect(experienceMinutes(JOKULSARLON.experiences[0]!)).toBe(90);
  });

  it('refuses to draw a leg between the lagoon and Diamond Beach', () => {
    const verdict = transportBetweenStops({ graph: JOKULSARLON, fromRef: 'lagoon-shore', toRef: 'diamond-beach' });
    expect(verdict.isTransport).toBe(false);
    expect(verdict.containedBy?.experienceName).toBe('Jökulsárlón glacier lagoon');
  });

  it('refuses to make the Zodiac tour transport between the beach and the lagoon', () => {
    const verdict = transportBetweenStops({ graph: JOKULSARLON, fromRef: 'diamond-beach', toRef: 'zodiac' });
    expect(verdict.isTransport).toBe(false);
    expect(verdict.containedBy?.componentName).toContain('Zodiac');
    expect(verdict.reason).toContain('what you do there');
  });

  it('still calls the drive to the lagoon a real leg', () => {
    const verdict = transportBetweenStops({ graph: JOKULSARLON, fromRef: 'base:hofn', toRef: 'd5-a1-jokulsarlon' });
    expect(verdict.isTransport).toBe(true);
  });

  it('catches a flat list double-counting one experience', () => {
    const doubles = doubleCounted({ graph: JOKULSARLON, stopRefs: ['d5-a1-jokulsarlon', 'diamond-beach'] });
    expect(doubles).toHaveLength(1);
    expect(doubles[0]!.refs).toEqual(['d5-a1-jokulsarlon', 'diamond-beach']);
  });

  it('does not flag two genuinely separate stops', () => {
    expect(doubleCounted({ graph: JOKULSARLON, stopRefs: ['d5-a1-jokulsarlon', 'd5-a0-fjadrargljufur'] })).toEqual([]);
  });

  it('holds Lake Agnes, the tea house and the Plain of Six Glaciers behind one trailhead', () => {
    const experience = LAKE_LOUISE.experiences[0]!;
    expect(experience.components.map((c) => c.id)).toEqual(['lake-agnes', 'agnes-tea-house', 'plain-of-six', 'highline']);
    /* Access plus the non-optional component: 20 each way, plus Lake Agnes. */
    expect(experienceMinutes(experience)).toBe(160);
    expect(transportBetweenStops({ graph: LAKE_LOUISE, fromRef: 'lake-agnes', toRef: 'plain-of-six' }).isTransport).toBe(false);
  });

  it('names a shuttle as the only way in rather than a parking note', () => {
    const required = requiredAccess(LAKE_LOUISE);
    expect(required).toHaveLength(1);
    expect(required[0]!.access.mode).toBe('shuttle');
    expect(required[0]!.access.reservationRequired).toBe(true);
    expect(accessRefOf('lake-louise-trails', required[0]!.access)).toBe('lake-louise-trails::lakeshore-trailhead');
  });

  it('holds the other shapes §4 names: a park scenic drive, a safari game drive, an island ferry and a hut-to-hut segment', () => {
    const shapes = graph([
      {
        id: 'icefields-parkway',
        name: 'Icefields Parkway',
        access: [{ label: 'Lake Louise junction', mode: 'drive', required: false, reservationRequired: false }],
        components: [
          { id: 'peyto', name: 'Peyto Lake viewpoint', kind: 'viewpoint', minutes: 40, defining: true, optional: false, reservationRequired: false },
          { id: 'parkway-drive', name: 'The drive itself', kind: 'traverse', minutes: 210, defining: true, optional: false, reservationRequired: false },
        ],
        dayNumbers: [],
      },
      {
        id: 'mara-game-drive',
        name: 'Masai Mara game drive',
        access: [{ label: 'Camp gate', mode: 'guided_transfer', minutesEachWay: 15, required: true, reservationRequired: false }],
        components: [{ id: 'game-drive', name: 'Morning game drive', kind: 'guided_movement', minutes: 240, defining: true, optional: false, reservationRequired: true, timeOfDay: 'sunrise' }],
        dayNumbers: [],
      },
      {
        id: 'heimaey',
        name: 'Heimaey day',
        access: [{ label: 'Landeyjahöfn ferry', mode: 'ferry', minutesEachWay: 40, required: true, reservationRequired: true }],
        components: [{ id: 'eldfell', name: 'Eldfell crater walk', kind: 'sub_place', minutes: 120, defining: true, optional: false, reservationRequired: false }],
        dayNumbers: [],
      },
      {
        id: 'laugavegur',
        name: 'Laugavegur hut-to-hut',
        access: [{ label: 'Landmannalaugar', mode: 'shuttle', minutesEachWay: 240, required: true, reservationRequired: true }],
        components: [
          { id: 'hrafntinnusker', name: 'Hrafntinnusker hut', kind: 'overnight', defining: true, optional: false, reservationRequired: true },
          { id: 'alftavatn', name: 'Álftavatn hut', kind: 'overnight', defining: true, optional: false, reservationRequired: true },
        ],
        dayNumbers: [6, 7, 8],
      },
    ]);
    expect(shapes.experiences).toHaveLength(4);
    /* A game drive is movement, and never a leg between two stops. */
    expect(transportBetweenStops({ graph: shapes, fromRef: 'mara-game-drive::camp-gate', toRef: 'game-drive' }).isTransport).toBe(false);
    /* Nor is the Parkway drive, nor the ferry's own crossing inside the island day. */
    expect(transportBetweenStops({ graph: shapes, fromRef: 'peyto', toRef: 'parkway-drive' }).isTransport).toBe(false);
    expect(transportBetweenStops({ graph: shapes, fromRef: 'heimaey::landeyjah-fn-ferry', toRef: 'eldfell' }).isTransport).toBe(false);
    /* But moving from the Parkway to the Mara is, absurdly, a real leg: different experiences. */
    expect(transportBetweenStops({ graph: shapes, fromRef: 'parkway-drive', toRef: 'game-drive' }).isTransport).toBe(true);
    expect(requiredAccess(shapes).map((r) => r.access.mode)).toEqual(['guided_transfer', 'ferry', 'shuttle']);
  });
});
