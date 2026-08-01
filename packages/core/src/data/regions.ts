import type { Region } from '../schemas/region';

export const EASTERN_SIERRA: Region = {
  id: 'eastern-sierra',
  name: 'Mammoth Lakes & the Eastern Sierra',
  baseName: 'Mammoth Lakes',
  baseCoordinates: { lat: 37.6485, lng: -118.9721 },
  summary:
    'A single base town at 7,880 ft with the whole Highway 395 corridor hanging off it: alpine lakes and trailheads minutes from the door, then volcanic country, Mono Lake and a gold-rush ghost town within a two-hour drive.',
  maxRadiusKm: 220,
  aliases: [
    'mammoth',
    'mammoth lakes',
    'mammoth lakes, ca',
    'mammoth lakes california',
    'eastern sierra',
    'june lake',
    'mono county',
  ],
  transportSummary:
    'A corridor with everything hanging off one highway. A vehicle is what turns a town into a region here.',
  noVehicleSummary:
    'Adding a vehicle would open the whole Highway 395 corridor — Convict Lake, Hot Creek, Mono Lake and everything north of town.',
  seasonalRoadSummary:
    'Several approach roads here are on the Caltrans District 9 winter closure list and reopen on the snowpack, not on a date.',
  /**
   * Every sentence the questionnaire used to hard-code, now owned by the region
   * that is actually about. The rendered wording is unchanged.
   */
  questionnaireCopy: {
    proseName: 'the Eastern Sierra',
    destinationOnlyLabel: 'Town and the Lakes Basin',
    expansionExamples: {
      destination_only: 'Keep it tight',
      nearby_30: 'Convict Lake, Hot Creek, Minaret Vista',
      nearby_60: 'Adds June Lake Loop and Mono Lake',
      nearby_120: 'Adds Bodie, Bishop, Rock Creek',
      best_regional: 'Go wherever it is worth it',
    },
    /**
     * Without a vehicle this region really is the town and the free summer
     * trolley up to the Lakes Basin. That was the hard-coded rule; here it is a
     * fact about the Eastern Sierra instead.
     */
    carFreeExpansions: ['destination_only', 'nearby_30'],
    regionStepIntro: 'The best of this region is spread along Highway 395.',
    discoveryIntro: 'The Eastern Sierra has both. The mix is up to you.',
    transportIntro: 'Out here this decides which places are even reachable.',
  },
};

export const REGIONS: Region[] = [EASTERN_SIERRA];

/** Resolves free text a traveller typed to a known region, or null. */
export function resolveRegion(input: string): Region | null {
  const needle = input.trim().toLowerCase();
  if (!needle) return null;
  return (
    REGIONS.find(
      (region) =>
        region.id === needle ||
        region.baseName.toLowerCase() === needle ||
        region.aliases.includes(needle),
    ) ??
    REGIONS.find((region) =>
      region.aliases.some((alias) => needle.includes(alias) || alias.includes(needle)),
    ) ??
    null
  );
}
