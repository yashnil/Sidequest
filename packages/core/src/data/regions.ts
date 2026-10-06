import type { Region } from '../schemas/region';

export const EASTERN_SIERRA: Region = {
  id: 'eastern-sierra',
  name: 'Mammoth Lakes & the Eastern Sierra',
  baseName: 'Mammoth Lakes',
  baseCoordinates: { lat: 37.6485, lng: -118.9721 },
  summary:
    'A single base town at 7,880 ft with the whole Highway 395 corridor hanging off it: alpine lakes and trailheads minutes from the door, then volcanic country, Mono Lake and a gold-rush ghost town within a two-hour drive.',
  maxRadiusKm: 220,
  /*
   * Whole-token phrases only (see `resolveRegion`). No bare "mammoth": that is
   * also a cave in Kentucky and hot springs in Wyoming.
   */
  aliases: ['mammoth lakes', 'eastern sierra', 'june lake', 'june lake loop', 'mono county'],
  aliasQualifiers: ['ca', 'calif', 'california', 'us', 'usa', 'united', 'states', 'america', 'of', 'the'],
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

/** Lower-case word tokens; punctuation and hyphens are separators. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Whether `input` is `alias` plus nothing but recognised qualifier words.
 *
 * The alias must appear as a contiguous run of whole tokens, and every token
 * outside that run must be one of the region's qualifiers. "Mammoth Lakes, CA"
 * matches; "Mammoth Cave, Kentucky", "Lake" and "Sierra Leone" do not.
 */
function phraseMatches(input: readonly string[], alias: readonly string[], qualifiers: ReadonlySet<string>): boolean {
  if (alias.length === 0 || alias.length > input.length) return false;
  for (let start = 0; start + alias.length <= input.length; start += 1) {
    if (!alias.every((token, offset) => input[start + offset] === token)) continue;
    const rest = [...input.slice(0, start), ...input.slice(start + alias.length)];
    if (rest.every((token) => qualifiers.has(token))) return true;
  }
  return false;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Resolves free text a traveller typed to a known region, or null.
 *
 * Whole-token phrase matching against the region's own aliases, id and base
 * name, where the input may add only the region's recognised qualifier words.
 * Data-driven: nothing here names a place.
 *
 * `center`, when the caller holds a resolved position for what was typed,
 * must also fall inside the region's radius — so a same-named place elsewhere
 * cannot borrow this region even when its words match.
 */
export function resolveRegion(input: string, options: { center?: { lat: number; lng: number } | null } = {}): Region | null {
  const needle = tokens(input);
  if (needle.length === 0) return null;
  for (const region of REGIONS) {
    const qualifiers = new Set((region.aliasQualifiers ?? []).map((q) => q.toLowerCase()));
    const phrases = [region.id, region.baseName, ...region.aliases].map(tokens);
    if (!phrases.some((phrase) => phraseMatches(needle, phrase, qualifiers))) continue;
    if (options.center && haversineKm(options.center, region.baseCoordinates) > region.maxRadiusKm) continue;
    return region;
  }
  return null;
}
