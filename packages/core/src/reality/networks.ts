/**
 * TRANSPORT INFRASTRUCTURE IS A FACT ABOUT A PIECE OF GROUND, NOT A COUNTRY.
 *
 * A country row (`jurisdictions.ts`) describes the network of the country's
 * mainland. A live Madeira build inherited Portugal's Alfa Pendular and printed
 * "≈50 min train · ~13 km" on an island with no railway; the same row would put
 * Spain's AVE on the Canaries, Italy's high-speed lines on Sardinia, Japan's
 * Shinkansen backbone on Hokkaido and Okinawa, and a metro in Heraklion because
 * Athens has one.
 *
 * These rows are ISO 3166-2 subdivisions whose network differs from the
 * country's, each split into geographic components (an island or island
 * group) with the land it covers, so a subdivision can be inferred from
 * coordinates when no code is known. A component only ever *removes* a
 * service the country row has (`AND`): it can say "no railway here", it can
 * never invent one the country row does not already state. A service a
 * component does not mention is not assumed present.
 *
 * Provenance: compiled from the operators' and regional governments' own
 * descriptions of their networks as of 2026-11; `reference` authority, like
 * the country rows. Extents are generous boxes around the land and are kept
 * clear of neighbouring land of the same country; they are only consulted for
 * a point already known to be in that country (or of unknown country).
 */

export interface NetworkBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface NetworkComponent {
  /** What the component is, for audit text. Never compared against anything. */
  label: string;
  extents: readonly NetworkBox[];
  /** False only where the row states there is no intercity passenger railway. */
  intercityRail: boolean;
  highSpeedRail: boolean;
  /** False where no metro is stated for this component (a light tram or one monorail line is not named a metro). */
  metro: boolean;
  /** Stated only where scheduled buses are known to be thin away from the main town. Absent is not "frequent", it is unstated. */
  bus?: 'sparse';
  note: string;
}

export interface SubnationalNetwork {
  /** ISO 3166-2. */
  code: string;
  /** ISO 3166-1 alpha-2 of the containing country. */
  countryCode: string;
  asOf: string;
  authority: 'reference';
  components: readonly NetworkComponent[];
}

const box = (south: number, west: number, north: number, east: number): NetworkBox => ({ south, west, north, east });

export const SUBNATIONAL_NETWORKS: readonly SubnationalNetwork[] = [
  {
    code: 'PT-30',
    countryCode: 'PT',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      {
        label: 'Madeira, Porto Santo and the Desertas',
        extents: [box(32.3, -17.4, 33.2, -16.15)],
        intercityRail: false,
        highSpeedRail: false,
        metro: false,
        bus: 'sparse',
        note: 'No railway; island buses run from Funchal along the coast and most mountain trailheads have little or no service.',
      },
      { label: 'Selvagens', extents: [box(29.9, -16.15, 30.25, -15.75)], intercityRail: false, highSpeedRail: false, metro: false, note: 'Uninhabited nature reserve; no public transport.' },
    ],
  },
  {
    code: 'PT-20',
    countryCode: 'PT',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      {
        label: 'The Azores',
        extents: [box(36.8, -31.4, 39.85, -24.9)],
        intercityRail: false,
        highSpeedRail: false,
        metro: false,
        bus: 'sparse',
        note: 'No railway on any island; buses are infrequent outside the main towns, and islands are linked by ferry and inter-island flights.',
      },
    ],
  },
  {
    code: 'ES-CN',
    countryCode: 'ES',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      {
        label: 'The Canary Islands',
        extents: [box(27.55, -18.3, 29.5, -13.3)],
        intercityRail: false,
        highSpeedRail: false,
        metro: false,
        note: 'No railway on any island (Tenerife has a tram between Santa Cruz and La Laguna); islands are crossed by bus, car and ferry.',
      },
    ],
  },
  {
    code: 'ES-IB',
    countryCode: 'ES',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      { label: 'Mallorca', extents: [box(39.2, 2.25, 40.05, 3.55)], intercityRail: true, highSpeedRail: false, metro: false, note: 'SFM trains run from Palma to Inca, Sa Pobla and Manacor; no high-speed rail.' },
      { label: 'Menorca', extents: [box(39.75, 3.75, 40.15, 4.4)], intercityRail: false, highSpeedRail: false, metro: false, note: 'No railway.' },
      { label: 'Ibiza and Formentera', extents: [box(38.6, 1.1, 39.2, 1.7)], intercityRail: false, highSpeedRail: false, metro: false, note: 'No railway.' },
    ],
  },
  {
    code: 'IT-88',
    countryCode: 'IT',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      { label: 'Sardinia', extents: [box(38.8, 8.05, 41.33, 9.9)], intercityRail: true, highSpeedRail: false, metro: false, note: 'Regional trains link Cagliari, Oristano, Sassari and Olbia; the high-speed network does not reach the island.' },
    ],
  },
  {
    code: 'IT-82',
    countryCode: 'IT',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      {
        label: 'Sicily',
        extents: [box(36.6, 12.35, 38.32, 15.35), box(37.75, 15.35, 38.3, 15.6)],
        intercityRail: true,
        highSpeedRail: false,
        metro: false,
        note: 'Regional and intercity trains link Palermo, Messina, Catania and Syracuse; the high-speed network does not reach the island.',
      },
      {
        label: "Sicily's minor islands",
        extents: [box(38.35, 14.3, 38.85, 15.3), box(37.85, 11.9, 38.1, 12.38), box(35.45, 12.3, 35.9, 12.9), box(36.7, 11.9, 36.86, 12.08), box(38.68, 13.12, 38.74, 13.22)],
        intercityRail: false,
        highSpeedRail: false,
        metro: false,
        note: 'No railway on the Aeolian, Egadi, Pelagie islands, Pantelleria or Ustica.',
      },
    ],
  },
  {
    code: 'FR-20R',
    countryCode: 'FR',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      { label: 'Corsica', extents: [box(41.33, 8.5, 43.05, 9.6)], intercityRail: true, highSpeedRail: false, metro: false, note: 'The island railway links Ajaccio, Corte, Bastia and Calvi; no high-speed rail.' },
    ],
  },
  {
    code: 'GR-M',
    countryCode: 'GR',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      { label: 'Crete', extents: [box(34.75, 23.45, 35.75, 26.4)], intercityRail: false, highSpeedRail: false, metro: false, note: 'No railway and no metro; KTEL buses link the towns.' },
    ],
  },
  {
    code: 'JP-01',
    countryCode: 'JP',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      {
        label: 'Hokkaido',
        extents: [box(41.35, 139.75, 41.62, 140.65), box(41.62, 139.3, 45.6, 145.9)],
        intercityRail: true,
        highSpeedRail: false,
        metro: true,
        note: 'JR Hokkaido limited expresses link the cities and Sapporo has a subway; the Shinkansen reaches only Shin-Hakodate-Hokuto, so it is not the island\'s backbone.',
      },
    ],
  },
  {
    code: 'JP-47',
    countryCode: 'JP',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      {
        label: 'Okinawa',
        extents: [box(24.0, 122.9, 27.1, 128.35), box(24.4, 130.9, 26.0, 131.35)],
        intercityRail: false,
        highSpeedRail: false,
        metro: false,
        note: 'No railway; the only rail line is the Naha monorail. The islands are crossed by bus and car.',
      },
    ],
  },
  {
    code: 'KR-49',
    countryCode: 'KR',
    asOf: '2026-11',
    authority: 'reference',
    components: [{ label: 'Jeju', extents: [box(33.1, 126.1, 33.6, 127.0)], intercityRail: false, highSpeedRail: false, metro: false, note: 'No railway and no metro; the island is crossed by bus, taxi and car.' }],
  },
  {
    code: 'AU-TAS',
    countryCode: 'AU',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      {
        label: 'Tasmania',
        extents: [box(-43.75, 143.75, -39.1, 148.55)],
        intercityRail: false,
        highSpeedRail: false,
        metro: false,
        bus: 'sparse',
        note: 'No passenger railway; intercity coaches run between the main towns a few times a day and rarely reach trailheads.',
      },
    ],
  },
  {
    code: 'US-HI',
    countryCode: 'US',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      { label: 'Oʻahu', extents: [box(21.2, -158.35, 21.75, -157.6)], intercityRail: false, highSpeedRail: false, metro: false, note: 'No intercity railway; TheBus covers the island and the Skyline rail line serves only part of it.' },
      {
        label: 'Hawaiʻi\'s other islands',
        extents: [box(18.85, -160.3, 22.3, -158.35), box(18.85, -157.6, 21.25, -154.75), box(21.25, -157.6, 22.3, -156.9)],
        intercityRail: false,
        highSpeedRail: false,
        metro: false,
        bus: 'sparse',
        note: 'No railway; island buses run a few routes a few times a day.',
      },
    ],
  },
  {
    code: 'US-AK',
    countryCode: 'US',
    asOf: '2026-11',
    authority: 'reference',
    components: [
      { label: 'Alaska', extents: [box(51.0, -180, 71.6, -129.9), box(51.0, 172.0, 53.1, 180)], intercityRail: true, highSpeedRail: false, metro: false, note: 'The Alaska Railroad links Seward, Anchorage, Denali and Fairbanks; there is no metro.' },
    ],
  },
  {
    code: 'CA-NL',
    countryCode: 'CA',
    asOf: '2026-11',
    authority: 'reference',
    components: [{ label: 'Newfoundland', extents: [box(46.6, -59.5, 51.7, -52.5)], intercityRail: false, highSpeedRail: false, metro: false, note: 'No passenger railway on the island.' }],
  },
];

const BY_CODE = new Map(SUBNATIONAL_NETWORKS.map((row) => [row.code, row] as const));

export function subnationalNetworkFor(code: string | null | undefined): SubnationalNetwork | null {
  if (!code) return null;
  return BY_CODE.get(code.toUpperCase()) ?? null;
}

type LatLng = { lat: number; lng: number };

function inside(b: NetworkBox, p: LatLng): boolean {
  return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

/** The component whose land holds this point, among the given country's rows (any country's when unknown). */
export function networkComponentAt(countryCode: string | null | undefined, point: LatLng): { code: string; component: NetworkComponent } | null {
  const country = countryCode?.toUpperCase();
  for (const row of SUBNATIONAL_NETWORKS) {
    if (country && row.countryCode !== country) continue;
    for (const component of row.components) if (component.extents.some((b) => inside(b, point))) return { code: row.code, component };
  }
  return null;
}

export interface NetworkLocator {
  /** ISO 3166-2 of the trip's scope, when a provider published one. */
  regionCode?: string | null | undefined;
  /** The points the question is about: a leg's two ends, or every place on the trip. */
  points?: readonly (LatLng | null | undefined)[] | undefined;
}

/** The single ISO 3166-2 code a concept's jurisdictions name, when exactly one subnational row in this country is named. */
export function singleRegionCode(jurisdictions: readonly { level: string; code: string; countryCode: string }[] | null | undefined, countryCode: string | null | undefined): string | null {
  const rows = (jurisdictions ?? []).filter((j) => j.level === 'subnational' && j.code.includes('-') && (!countryCode || j.countryCode.toUpperCase() === countryCode.toUpperCase()));
  const codes = [...new Set(rows.map((j) => j.code.toUpperCase()))];
  return codes.length === 1 ? codes[0]! : null;
}
