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
