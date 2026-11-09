/**
 * WHICH CONTINENT A POINT IS ON — FOR REPORTING ONLY.
 *
 * The evidence stages print "how is this class spread over the world" so a
 * class that is 95 % one country's bureaucratic designation is seen for what it
 * is. That needs seven buckets, not the advisor's twenty-four travel regions,
 * so this folds `world-regions.mjs` (by country, with its coordinate splits for
 * the countries that span continents) and falls back to its by-point reading
 * when no country is known. Nothing here decides anything about a place.
 */
import { worldRegionByPoint, worldRegionFor } from './world-regions.mjs';

const CONTINENT_OF_REGION = {
  northern_europe: 'Europe',
  western_europe: 'Europe',
  southern_europe: 'Europe',
  central_eastern_europe: 'Europe',
  caucasus_central_asia: 'Asia',
  middle_east: 'Asia',
  south_asia: 'Asia',
  southeast_asia: 'Asia',
  east_asia: 'Asia',
  north_africa: 'Africa',
  east_africa: 'Africa',
  southern_africa: 'Africa',
  west_central_africa: 'Africa',
  indian_ocean: 'Africa',
  oceania: 'Oceania',
  pacific_islands: 'Oceania',
  north_america_west: 'North America',
  north_america_east: 'North America',
  north_america_north: 'North America',
  mexico_central_america: 'North America',
  caribbean: 'North America',
  south_america_north: 'South America',
  south_america_south: 'South America',
  polar: 'Polar',
};

export const CONTINENTS = ['Europe', 'Asia', 'North America', 'South America', 'Africa', 'Oceania', 'Polar'];

export function continentFor(iso, lat, lng) {
  const region = (iso ? worldRegionFor(iso, lat, lng) : null) ?? worldRegionByPoint(lat, lng);
  return CONTINENT_OF_REGION[region] ?? 'Other';
}
