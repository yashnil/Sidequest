import 'server-only';
import { z } from 'zod';

/**
 * GOOGLE PLACES (NEW) AND ROUTES.
 *
 * Two rules shape everything here, and both are about money or law rather than
 * taste:
 *
 * **The field mask is the cost dial.** Places bills at the highest SKU any
 * requested field triggers. `places.id` alone is free and unlimited; adding
 * `places.location` moves the same call to a paid tier. So discovery asks for
 * ids, and only the shortlist is enriched. `*` is never sent.
 *
 * **Google's content is not ours to keep.** The terms permit storing a place id
 * indefinitely and coordinates for thirty days, and permit storing nothing else
 * — not names, not addresses, not hours, not ratings. Everything this module
 * returns is therefore marked with how long it may live, and the compiled region
 * that consumes it carries an expiry rather than pretending to be permanent.
 * See `.claude-private/research/providers-and-packages.md`.
 */

const PLACES_BASE = 'https://places.googleapis.com/v1';
const ROUTES_BASE = 'https://routes.googleapis.com/distanceMatrix/v2';

const REQUEST_TIMEOUT_MS = 12_000;

/** How long a coordinate from Places may be cached. The terms' own number. */
export const GOOGLE_COORDINATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class GoogleProviderError extends Error {
  readonly code: 'not_configured' | 'rate_limited' | 'request_failed' | 'malformed_response';
  readonly status: number | undefined;

  constructor(code: GoogleProviderError['code'], message: string, status?: number) {
    super(message);
    this.name = 'GoogleProviderError';
    this.code = code;
    this.status = status;
  }
}

export function isGoogleConfigured(): boolean {
  return (process.env.GOOGLE_MAPS_API_KEY?.trim().length ?? 0) > 0;
}

function apiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new GoogleProviderError('not_configured', 'No Google credentials are configured.');
  return key;
}

export interface CallCounter {
  calls: number;
  failures: number;
  /** Billable matrix cells. The dominant cost, so it is counted separately. */
  elements: number;
}

export function emptyCounter(): CallCounter {
  return { calls: 0, failures: 0, elements: 0 };
}

/**
 * One POST, with the key in a header and never in the URL.
 *
 * A key in a query string ends up in every log line and every error message
 * built from that URL, which is how a credential leaks without anybody doing
 * anything obviously wrong.
 */
async function postJson<T>(
  url: string,
  body: unknown,
  fieldMask: string,
  counter: CallCounter,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  counter.calls += 1;

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey(),
        'x-goog-fieldmask': fieldMask,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      counter.failures += 1;
      throw new GoogleProviderError('rate_limited', 'Google asked us to slow down.', 429);
    }
    if (!response.ok) {
      counter.failures += 1;
      // The body can echo the request, so it is logged in a redacted form and
      // never carried into a sentence a traveller reads.
      console.error('Google request failed', { url: new URL(url).pathname, status: response.status });
      throw new GoogleProviderError(
        'request_failed',
        'Google did not answer that request.',
        response.status,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof GoogleProviderError) throw error;
    counter.failures += 1;
    throw new GoogleProviderError('request_failed', 'Google did not answer that request.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

const latLngSchema = z.object({ latitude: z.number(), longitude: z.number() });

const viewportSchema = z.object({ low: latLngSchema, high: latLngSchema });

const placeSchema = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  location: latLngSchema.optional(),
  viewport: viewportSchema.optional(),
  types: z.array(z.string()).optional(),
  primaryType: z.string().optional(),
  utcOffsetMinutes: z.number().optional(),
  addressComponents: z
    .array(
      z.object({
        longText: z.string().optional(),
        shortText: z.string().optional(),
        types: z.array(z.string()),
      }),
    )
    .optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  regularOpeningHours: z
    .object({
      periods: z
        .array(
          z.object({
            open: z.object({ day: z.number(), hour: z.number(), minute: z.number() }).optional(),
            close: z.object({ day: z.number(), hour: z.number(), minute: z.number() }).optional(),
          }),
        )
        .optional(),
      weekdayDescriptions: z.array(z.string()).optional(),
    })
    .optional(),
  googleMapsUri: z.string().optional(),
});
export type GooglePlace = z.infer<typeof placeSchema>;

const textSearchResponseSchema = z.object({
  places: z.array(placeSchema).optional(),
  nextPageToken: z.string().optional(),
});

/**
 * Field masks, smallest first.
 *
 * `IDS_ONLY` is the free tier and is what a wide discovery sweep uses. `LOCATE`
 * adds the two fields resolution genuinely cannot do without. `ENRICH` is the
 * shortlist mask and is the only one that reaches an Enterprise-tier field, so
 * it is applied to tens of places rather than hundreds.
 */
export const FIELD_MASKS = {
  idsOnly: 'places.id',
  locate:
    'places.id,places.displayName,places.location,places.viewport,places.formattedAddress,places.addressComponents,places.types,places.primaryType,places.utcOffsetMinutes',
  enrich:
    'places.id,places.displayName,places.location,places.types,places.primaryType,places.rating,places.userRatingCount,places.regularOpeningHours,places.googleMapsUri',
} as const;

export interface TextSearchInput {
  query: string;
  maxResults: number;
  fieldMask: string;
  /** Keeps a sweep inside the scope rather than returning the same city twice. */
  locationBias?: { center: { lat: number; lng: number }; radiusMetres: number };
  includedType?: string;
}

export async function textSearch(
  input: TextSearchInput,
  counter: CallCounter,
): Promise<GooglePlace[]> {
  const body: Record<string, unknown> = {
    textQuery: input.query,
    // Capped hard: paging is where an innocent-looking sweep becomes a bill.
    pageSize: Math.min(20, Math.max(1, input.maxResults)),
  };
  if (input.includedType) body.includedType = input.includedType;
  if (input.locationBias) {
    body.locationBias = {
      circle: {
        center: {
          latitude: input.locationBias.center.lat,
          longitude: input.locationBias.center.lng,
        },
        radius: Math.min(50_000, Math.max(1, input.locationBias.radiusMetres)),
      },
    };
  }

  const raw = await postJson<unknown>(
    `${PLACES_BASE}/places:searchText`,
    body,
    input.fieldMask,
    counter,
  );
  const parsed = textSearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleProviderError('malformed_response', 'Google returned a shape we could not read.');
  }
  return (parsed.data.places ?? []).slice(0, input.maxResults);
}

export async function placeDetails(
  placeId: string,
  fieldMask: string,
  counter: CallCounter,
): Promise<GooglePlace | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  counter.calls += 1;
  try {
    // Details is a GET; the mask is unprefixed here, unlike search.
    const response = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
      signal: controller.signal,
      headers: {
        'x-goog-api-key': apiKey(),
        'x-goog-fieldmask': fieldMask.replace(/places\./g, ''),
      },
    });
    if (!response.ok) {
      counter.failures += 1;
      return null;
    }
    const parsed = placeSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    counter.failures += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The country and administrative names, from the components Google returns. */
export function administrativeHierarchy(place: GooglePlace): {
  countryCode?: string;
  countryName?: string;
  areas: string[];
} {
  const components = place.addressComponents ?? [];
  const country = components.find((component) => component.types.includes('country'));
  const areas = components
    .filter((component) =>
      component.types.some((type) => type.startsWith('administrative_area_level') || type === 'locality'),
    )
    .map((component) => component.longText ?? component.shortText ?? '')
    .filter((name) => name.length > 0)
    .reverse();

  return {
    ...(country?.shortText ? { countryCode: country.shortText } : {}),
    ...(country?.longText ? { countryName: country.longText } : {}),
    areas,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type GoogleTravelMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT' | 'TWO_WHEELER';

const matrixElementSchema = z.object({
  originIndex: z.number(),
  destinationIndex: z.number(),
  status: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
  condition: z.string().optional(),
  distanceMeters: z.number().optional(),
  duration: z.string().optional(),
});

export interface MatrixPoint {
  id: string;
  lat: number;
  lng: number;
}

export interface MatrixResult {
  ids: string[];
  minutes: number[][];
  km: number[][];
  failed: { from: string; to: string }[];
  elements: number;
}

/** Google's own ceiling. Exceeding it is a 400, so batching is not optional. */
export const MAX_MATRIX_ELEMENTS = 625;
/** Transit and traffic-aware requests are capped far lower. */
export const MAX_TRANSIT_ELEMENTS = 100;

function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([\d.]+)s$/.exec(value);
  return match?.[1] ? Number(match[1]) / 60 : null;
}

/**
 * A full origin×destination matrix, in as few requests as the element cap allows.
 *
 * Two properties matter more than the batching itself:
 *
 * - **A pair Google could not answer is recorded, never zeroed.** A missing leg
 *   read as zero teleports a traveller, and the planner's own matrix validator
 *   is built to catch exactly that — so the honest value is "we do not know",
 *   and the compiler drops the place rather than scheduling around a fiction.
 * - **Nothing here falls back to straight-line distance.** A haversine number
 *   labelled as a drive time is the single most confidently wrong thing this
 *   system could produce.
 */
export async function computeMatrix(
  points: readonly MatrixPoint[],
  mode: GoogleTravelMode,
  maxElements: number,
  counter: CallCounter,
): Promise<MatrixResult> {
  const ids = points.map((point) => point.id);
  const size = ids.length;
  const minutes = ids.map(() => new Array<number>(size).fill(Number.NaN));
  const km = ids.map(() => new Array<number>(size).fill(Number.NaN));
  const failed: { from: string; to: string }[] = [];

  const perRequest = Math.min(
    mode === 'TRANSIT' ? MAX_TRANSIT_ELEMENTS : MAX_MATRIX_ELEMENTS,
    Math.max(1, maxElements),
  );
  const blockSize = Math.max(1, Math.floor(Math.sqrt(perRequest)));

  let spent = 0;
  for (let rowStart = 0; rowStart < size; rowStart += blockSize) {
    for (let colStart = 0; colStart < size; colStart += blockSize) {
      const origins = points.slice(rowStart, rowStart + blockSize);
      const destinations = points.slice(colStart, colStart + blockSize);
      const cells = origins.length * destinations.length;

      if (spent + cells > maxElements) {
        // Budget reached. Everything not requested stays NaN and is reported as
        // a failed pair, so the caller sees a hole rather than a zero.
        for (const origin of origins) {
          for (const destination of destinations) {
            if (origin.id !== destination.id) failed.push({ from: origin.id, to: destination.id });
          }
        }
        continue;
      }

      const body = {
        origins: origins.map((point) => ({
          waypoint: { location: { latLng: { latitude: point.lat, longitude: point.lng } } },
        })),
        destinations: destinations.map((point) => ({
          waypoint: { location: { latLng: { latitude: point.lat, longitude: point.lng } } },
        })),
        travelMode: mode,
      };

      let elements: z.infer<typeof matrixElementSchema>[];
      try {
        const raw = await postJson<unknown>(
          `${ROUTES_BASE}:computeRouteMatrix`,
          body,
          'originIndex,destinationIndex,duration,distanceMeters,status,condition',
          counter,
        );
        elements = z.array(matrixElementSchema).parse(raw);
        spent += cells;
        counter.elements += cells;
      } catch {
        for (const origin of origins) {
          for (const destination of destinations) {
            if (origin.id !== destination.id) failed.push({ from: origin.id, to: destination.id });
          }
        }
        continue;
      }

      for (const element of elements) {
        const from = rowStart + element.originIndex;
        const to = colStart + element.destinationIndex;
        const fromId = ids[from];
        const toId = ids[to];
        if (fromId === undefined || toId === undefined) continue;

        const durationMinutes = parseDuration(element.duration);
        const routeFound = element.condition === 'ROUTE_EXISTS' && durationMinutes !== null;
        if (!routeFound) {
          if (fromId !== toId) failed.push({ from: fromId, to: toId });
          continue;
        }
        minutes[from]![to] = from === to ? 0 : Math.round(durationMinutes);
        km[from]![to] = from === to ? 0 : (element.distanceMeters ?? 0) / 1000;
      }
    }
  }

  // The diagonal is zero by definition, whatever the provider said.
  for (let index = 0; index < size; index += 1) {
    minutes[index]![index] = 0;
    km[index]![index] = 0;
  }

  return { ids, minutes, km, failed, elements: counter.elements };
}

/**
 * Drop the points Google could not route to, and return a dense matrix.
 *
 * The planner refuses a matrix with a hole in it — correctly, because it cannot
 * lay out a day around a leg nobody can measure. So rather than hand it a
 * matrix full of NaN, the unroutable points leave here and the caller learns
 * which ones, which becomes a coverage number instead of a crash.
 */
export function densify(result: MatrixResult): {
  ids: string[];
  minutes: number[][];
  km: number[][];
  dropped: string[];
} {
  const keep: number[] = [];
  const dropped: string[] = [];

  for (let index = 0; index < result.ids.length; index += 1) {
    const row = result.minutes[index] ?? [];
    const usable = row.every((value, other) => other === index || Number.isFinite(value));
    const reachable = result.minutes.every(
      (otherRow, other) => other === index || Number.isFinite(otherRow[index]),
    );
    if (usable && reachable) keep.push(index);
    else dropped.push(result.ids[index]!);
  }

  return {
    ids: keep.map((index) => result.ids[index]!),
    minutes: keep.map((from) => keep.map((to) => result.minutes[from]![to]!)),
    km: keep.map((from) => keep.map((to) => result.km[from]![to]!)),
    dropped,
  };
}
