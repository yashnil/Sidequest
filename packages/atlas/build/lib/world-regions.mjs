/**
 * WHICH PART OF THE WORLD A PLACE IS IN, IN THE ADVISOR'S 24 TRAVEL REGIONS.
 *
 * By country, because that is how a traveller says it ("somewhere in Southeast
 * Asia"), with the handful of countries that span several travel regions split
 * by coordinate: Alaska is not the American West, Hawaii is the Pacific, and
 * the Canaries are Spanish and African at once (kept with southern Europe,
 * where travellers file them). The grouping follows the curated catalog's own
 * usage so a derived record and an editorial one in the same country agree.
 */

const BY_COUNTRY = {
  northern_europe: 'IS NO SE FI DK FO AX EE LV LT GB IE IM JE GG',
  western_europe: 'FR BE NL LU DE AT CH LI MC',
  southern_europe: 'ES PT IT GR MT CY AD SM VA GI HR ME AL MK BA RS XK',
  central_eastern_europe: 'PL CZ SK HU RO BG MD UA BY SI',
  caucasus_central_asia: 'GE AM AZ KZ KG TJ UZ TM',
  middle_east: 'TR JO IL PS LB SY IQ IR SA AE OM QA BH KW YE',
  north_africa: 'MA DZ TN LY EG EH',
  east_africa: 'KE TZ UG RW BI ET ER DJ SO SS SD',
  southern_africa: 'ZA NA BW ZW ZM MW MZ LS SZ AO',
  west_central_africa: 'SN GM GW GN SL LR CI GH TG BJ NG CM GQ GA CG CD CF TD NE ML BF MR CV ST',
  indian_ocean: 'MG MU SC KM RE YT',
  south_asia: 'IN NP BT LK BD PK AF MV',
  southeast_asia: 'TH VN LA KH MM MY SG ID PH BN TL',
  east_asia: 'JP KR KP CN TW HK MO MN',
  oceania: 'AU NZ NF',
  pacific_islands: 'FJ PG SB VU NC PF WS TO CK NU TV KI NR FM MH PW GU MP AS WF TK PN',
  north_america_west: '',
  north_america_east: 'BM PM',
  north_america_north: '',
  mexico_central_america: 'MX GT BZ SV HN NI CR PA',
  caribbean: 'CU JM HT DO PR BS BB TT LC VC GD AG DM KN AW CW BQ SX MF BL GP MQ KY TC VG VI AI MS',
  south_america_north: 'CO VE EC PE BO BR GY SR GF',
  south_america_south: 'AR CL UY PY FK GS',
  polar: 'AQ SJ BV TF HM GL',
};

const COUNTRY_REGION = new Map();
for (const [region, codes] of Object.entries(BY_COUNTRY)) for (const code of codes.split(/\s+/).filter(Boolean)) COUNTRY_REGION.set(code, region);

export const WORLD_REGIONS = Object.keys(BY_COUNTRY);

/** The travel region of a point in a country. Null only for a country code nobody has filed. */
export function worldRegionFor(iso, lat, lng) {
  switch (iso) {
    case 'US':
      if (lat >= 51 && lng <= -129) return 'north_america_north';
      if (lat <= 30 && lng <= -150) return 'pacific_islands';
      return lng <= -100 ? 'north_america_west' : 'north_america_east';
    case 'CA':
      if (lat >= 59.5) return 'north_america_north';
      return lng <= -100 ? 'north_america_west' : 'north_america_east';
    case 'RU':
      if (lat >= 66.5) return 'polar';
      if (lng >= 60 || lng <= -160) return 'east_asia';
      if (lat <= 45 && lng >= 36) return 'caucasus_central_asia';
      return 'central_eastern_europe';
    case 'TZ':
      /* Zanzibar, Pemba and Mafia are an Indian Ocean beach trip, not a mainland safari. */
      return lng >= 39.1 && lat <= -4.8 && lat >= -8.2 ? 'indian_ocean' : 'east_africa';
    case 'CL':
    case 'AR':
      return 'south_america_south';
    case 'EC':
      return 'south_america_north';
    case 'PT':
    case 'ES':
      return 'southern_europe';
    case 'FR':
      if (lng <= -50 && lat <= 20) return lat <= 7 ? 'south_america_north' : 'caribbean';
      if (lng >= 40 && lat <= 0) return 'indian_ocean';
      if (lng <= -130 || lng >= 160) return 'pacific_islands';
      /* Corsica is filed with the Mediterranean islands. */
      if (lat <= 43.1 && lng >= 8.4 && lng <= 9.7) return 'southern_europe';
      return 'western_europe';
    case 'NL':
      return lng <= -50 ? 'caribbean' : 'western_europe';
    case 'GB':
      if (lng <= -50 && lat <= 30) return 'caribbean';
      if (lat <= -40) return 'south_america_south';
      return 'northern_europe';
    case 'DK':
      return lng <= -15 ? 'polar' : 'northern_europe';
    case 'NO':
      return lat >= 74 ? 'polar' : 'northern_europe';
    case 'CN':
      return 'east_asia';
    default:
      return COUNTRY_REGION.get(iso) ?? null;
  }
}

/** When no country is known (open ocean, disputed ground): the nearest reading by coordinate, coarse on purpose. */
export function worldRegionByPoint(lat, lng) {
  if (lat <= -60) return 'polar';
  if (lat >= 72) return 'polar';
  if (lng >= -170 && lng <= -30) {
    if (lat >= 50) return lng <= -100 ? 'north_america_north' : 'north_america_east';
    if (lat >= 30) return lng <= -100 ? 'north_america_west' : 'north_america_east';
    if (lat >= 8) return lng >= -90 && lat <= 27 ? 'caribbean' : 'mexico_central_america';
    return lat >= -20 ? 'south_america_north' : 'south_america_south';
  }
  if (lng > -30 && lng <= 60) {
    if (lat >= 55) return 'northern_europe';
    if (lat >= 36) return lng <= 20 ? 'western_europe' : lng <= 40 ? 'central_eastern_europe' : 'caucasus_central_asia';
    if (lat >= 15) return lng <= 34 ? 'north_africa' : 'middle_east';
    if (lat >= -12) return lng <= 28 ? 'west_central_africa' : 'east_africa';
    return lng >= 42 ? 'indian_ocean' : 'southern_africa';
  }
  if (lng > 60 && lng <= 150) {
    if (lat >= 35) return lng <= 90 ? 'caucasus_central_asia' : 'east_asia';
    if (lat >= 5 && lng <= 92) return 'south_asia';
    if (lat >= -11 && lng <= 141) return lat >= 20 && lng >= 100 ? 'east_asia' : 'southeast_asia';
    return lat <= -9 ? 'oceania' : 'indian_ocean';
  }
  return lat <= -28 && lng >= 150 ? 'oceania' : 'pacific_islands';
}
