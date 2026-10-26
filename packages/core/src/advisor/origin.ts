import { countryFromText, countryPointFor } from '../reference/countries';

/**
 * WHERE THE TRAVELLER IS STARTING FROM, OFFLINE.
 *
 * "How far are you willing to go" means nothing without a "from". The country
 * reference places a country at its main city; that is honest for Portugal and
 * wrong by 4,000 km for a traveller in Los Angeles who typed "the US". So the
 * big departure cities of the large countries are listed here, and a country
 * alone is used only when no city is named. Anything else returns null — no
 * distance at all is better than a confident wrong one.
 */
export interface OriginPoint {
  lat: number;
  lng: number;
  label: string;
  countryCode: string | null;
  basis: 'city' | 'country';
}

const CITIES: readonly [string, number, number, string][] = [
  ['new york', 40.71, -74.01, 'US'], ['nyc', 40.71, -74.01, 'US'], ['boston', 42.36, -71.06, 'US'], ['washington', 38.9, -77.04, 'US'],
  ['philadelphia', 39.95, -75.17, 'US'], ['chicago', 41.88, -87.63, 'US'], ['atlanta', 33.75, -84.39, 'US'], ['miami', 25.76, -80.19, 'US'],
  ['dallas', 32.78, -96.8, 'US'], ['houston', 29.76, -95.37, 'US'], ['austin', 30.27, -97.74, 'US'], ['denver', 39.74, -104.99, 'US'],
  ['phoenix', 33.45, -112.07, 'US'], ['los angeles', 34.05, -118.24, 'US'], ['la', 34.05, -118.24, 'US'], ['san diego', 32.72, -117.16, 'US'],
  ['san francisco', 37.77, -122.42, 'US'], ['bay area', 37.6, -122.2, 'US'], ['san jose', 37.34, -121.89, 'US'], ['seattle', 47.61, -122.33, 'US'],
  ['portland', 45.52, -122.68, 'US'], ['salt lake city', 40.76, -111.89, 'US'], ['minneapolis', 44.98, -93.27, 'US'], ['detroit', 42.33, -83.05, 'US'],
  ['honolulu', 21.31, -157.86, 'US'], ['anchorage', 61.22, -149.9, 'US'], ['california', 36.5, -119.5, 'US'], ['texas', 31.0, -97.5, 'US'],
  ['toronto', 43.65, -79.38, 'CA'], ['montreal', 45.5, -73.57, 'CA'], ['vancouver', 49.28, -123.12, 'CA'], ['calgary', 51.05, -114.07, 'CA'],
  ['mexico city', 19.43, -99.13, 'MX'], ['sao paulo', -23.55, -46.63, 'BR'], ['rio de janeiro', -22.91, -43.17, 'BR'], ['buenos aires', -34.6, -58.38, 'AR'],
  ['santiago', -33.45, -70.67, 'CL'], ['lima', -12.05, -77.04, 'PE'], ['bogota', 4.71, -74.07, 'CO'],
  ['london', 51.51, -0.13, 'GB'], ['manchester', 53.48, -2.24, 'GB'], ['edinburgh', 55.95, -3.19, 'GB'], ['dublin', 53.35, -6.26, 'IE'],
  ['paris', 48.86, 2.35, 'FR'], ['berlin', 52.52, 13.4, 'DE'], ['munich', 48.14, 11.58, 'DE'], ['frankfurt', 50.11, 8.68, 'DE'],
  ['amsterdam', 52.37, 4.9, 'NL'], ['madrid', 40.42, -3.7, 'ES'], ['barcelona', 41.39, 2.17, 'ES'], ['lisbon', 38.72, -9.14, 'PT'],
  ['rome', 41.9, 12.5, 'IT'], ['milan', 45.46, 9.19, 'IT'], ['zurich', 47.38, 8.54, 'CH'], ['vienna', 48.21, 16.37, 'AT'],
  ['stockholm', 59.33, 18.07, 'SE'], ['oslo', 59.91, 10.75, 'NO'], ['copenhagen', 55.68, 12.57, 'DK'], ['helsinki', 60.17, 24.94, 'FI'],
  ['warsaw', 52.23, 21.01, 'PL'], ['prague', 50.08, 14.44, 'CZ'], ['istanbul', 41.01, 28.98, 'TR'], ['athens', 37.98, 23.73, 'GR'],
  ['dubai', 25.2, 55.27, 'AE'], ['tel aviv', 32.09, 34.78, 'IL'], ['cairo', 30.04, 31.24, 'EG'], ['nairobi', -1.29, 36.82, 'KE'],
  ['johannesburg', -26.2, 28.05, 'ZA'], ['cape town', -33.92, 18.42, 'ZA'], ['lagos', 6.52, 3.38, 'NG'],
  ['mumbai', 19.08, 72.88, 'IN'], ['delhi', 28.61, 77.21, 'IN'], ['bangalore', 12.97, 77.59, 'IN'], ['bengaluru', 12.97, 77.59, 'IN'],
  ['singapore', 1.35, 103.82, 'SG'], ['bangkok', 13.76, 100.5, 'TH'], ['kuala lumpur', 3.14, 101.69, 'MY'], ['jakarta', -6.2, 106.85, 'ID'],
  ['manila', 14.6, 120.98, 'PH'], ['hong kong', 22.32, 114.17, 'HK'], ['shanghai', 31.23, 121.47, 'CN'], ['beijing', 39.9, 116.4, 'CN'],
  ['seoul', 37.57, 126.98, 'KR'], ['tokyo', 35.68, 139.69, 'JP'], ['osaka', 34.69, 135.5, 'JP'], ['taipei', 25.03, 121.57, 'TW'],
  ['sydney', -33.87, 151.21, 'AU'], ['melbourne', -37.81, 144.96, 'AU'], ['brisbane', -27.47, 153.03, 'AU'], ['perth', -31.95, 115.86, 'AU'],
  ['auckland', -36.85, 174.76, 'NZ'], ['wellington', -41.29, 174.78, 'NZ'],
];

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function originPointFromText(text: string | null | undefined, countryCode?: string | null): OriginPoint | null {
  const folded = text ? fold(text) : '';
  if (folded) {
    const padded = ` ${folded} `;
    /* Longest name first, so "san jose" is not read as "san" anything and "la" only matches alone. */
    const hit = [...CITIES]
      .sort((a, b) => b[0].length - a[0].length)
      .find(([name]) => (name.length <= 3 ? folded === name : padded.includes(` ${name} `)));
    if (hit) return { lat: hit[1], lng: hit[2], label: titleCase(hit[0]), countryCode: hit[3], basis: 'city' };
    const country = countryFromText(text);
    if (country) return { lat: country.point.lat, lng: country.point.lng, label: country.facts.name, countryCode: country.facts.code, basis: 'country' };
  }
  if (countryCode) {
    const point = countryPointFor(countryCode);
    if (point) return { lat: point.lat, lng: point.lng, label: point.place, countryCode: countryCode.toUpperCase(), basis: 'country' };
  }
  return null;
}

function titleCase(name: string): string {
  if (name === 'nyc') return 'New York';
  if (name === 'la') return 'Los Angeles';
  return name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function advisorKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
