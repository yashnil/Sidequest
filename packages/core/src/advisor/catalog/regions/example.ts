import type { z } from 'zod';
import type { catalogDestinationSchema } from '../schema';

/** The template every regional file follows. Not part of the catalog. */
export const EXAMPLE: z.input<typeof catalogDestinationSchema>[] = [
  {
    id: 'lofoten',
    name: 'Lofoten Islands',
    context: 'Northern Norway',
    kind: 'island_group',
    countries: ['NO'],
    worldRegion: 'northern_europe',
    center: { lat: 68.2, lng: 13.9 },
    radiusKm: 90,
    resolveAs: 'Lofoten, Norway',
    wikidataId: 'Q186822',
    bases: ['Svolvær', 'Henningsvær', 'Reine'],
    nights: { min: 4, ideal: 6, max: 10 },
    experiences: {
      day_hiking: 3, high_mountains: 2, coastal_scenery: 3, beaches_swimming: 1, paddling_boating: 2,
      marine_wildlife: 2, birding: 2, villages_culture: 2, scenic_driving: 2, food: 1, night_skies: 2,
    },
    highlights: [
      'Ridge hikes like Reinebringen straight above fishing villages',
      'White-sand Arctic beaches at Haukland and Kvalvika',
      'Sea kayaking between granite peaks in the Reinefjord',
      'Midnight sun from late May to mid-July',
    ],
    pitch: 'A chain of granite peaks rising straight out of the Norwegian Sea, with red fishing cabins at their feet and short, steep hikes everywhere.',
    season: [1, 1, 2, 1, 2, 3, 3, 3, 2, 1, 0, 0],
    highC: [1, 1, 2, 5, 9, 12, 15, 15, 11, 7, 3, 2],
    wet: [2, 2, 2, 1, 1, 1, 1, 2, 2, 3, 3, 2],
    cost: 4,
    lodging: { simple: true, comfortable: true, luxury: false },
    challenge: { easiest: 1, typical: 2 },
    remoteness: 1,
    crowds: 2,
    familiarity: 2,
    access: {
      airports: ['BOO', 'EVE', 'SVJ'],
      reach: 2,
      car: 'helpful',
      transit: 'limited',
      note: 'Fly to Bodø and take the ferry, or fly to Evenes and drive the E10. Buses run but thinly.',
    },
    family: 2,
    lowMobility: 1,
    tradeoffs: ['Expensive, even by Norwegian standards', 'Summer weather changes fast; plan spare days', 'Popular trailheads and parking fill in July'],
    cautions: ['Steep summit trails are slippery when wet'],
    evidence: { basis: 'sidequest_editorial', asOf: '2026-10', references: ['Wikivoyage: Lofoten', 'visitnorway.com'] },
  },
];
