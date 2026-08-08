import 'server-only';
import {
  GeocoderError,
  boundsRadiusKm,
  classifyNominatim,
  geocode,
  osmElementId,
  type NominatimPlace,
} from '../../providers/nominatim';
import type { PacketDestination } from './packet-types';

/**
 * WHERE THE TRIP IS, DECIDED WITHOUT A MODEL.
 *
 * Zero model calls, deliberately, and the reason is not economy. The shared
 * request may already carry an `identity` that the benchmark harness resolved
 * once and handed to both systems — two competitors that each geocoded the same
 * words and landed on different towns would be planning different trips, and the
 * comparison would be void before either had done any work. When it carries one,
 * this module returns it and asks nobody anything.
 *
 * When it does not, a geocoder answers. A geocoder's own classification of what
 * it found is *evidence*; a model's opinion about the same string is inference,
 * and inference is the wrong instrument for the one fact everything downstream
 * is anchored to.
 *
 * The failure case is a stated failure. A destination nobody can resolve is not
 * a reason to guess a coordinate — it is a reason for the run to end with
 * `insufficient_data`, which the plan schema can express and the results table
 * can count.
 */

export type IdentityOutcome =
  | { ok: true; destination: PacketDestination; providerCalls: number; fromRequest: boolean }
  | {
      ok: false;
      failureKind: 'insufficient_data' | 'provider_unavailable';
      detail: string;
      providerCalls: number;
    };

export interface ResolveIdentityInput {
  /** Exactly what the traveller typed. */
  text: string;
  /** The harness's shared resolution, when the session already has one. */
  identity: {
    id: string;
    displayName: string;
    countryCode?: string | undefined;
    latitude: number;
    longitude: number;
  } | null;
  /** False in fixture mode, where nothing may leave the process. */
  geocoderPermitted: boolean;
  /** Injected so the offline suite drives the parser without a network. */
  geocodeImpl?: typeof geocode;
}

export async function resolveDestinationIdentity(
  input: ResolveIdentityInput,
): Promise<IdentityOutcome> {
  if (input.identity) {
    /*
     * The shared identity carries no breadth and no bounding box, because the
     * request schema deliberately holds stated facts rather than derived ones.
     * So the scale is `unknown` here rather than guessed — and the scan below
     * sizes the region from the traveller's own movement caps instead, which is
     * a statement rather than an inference.
     */
    return {
      ok: true,
      fromRequest: true,
      providerCalls: 0,
      destination: {
        entityId: input.identity.id,
        displayName: input.identity.displayName,
        countryCode: input.identity.countryCode ?? null,
        latitude: input.identity.latitude,
        longitude: input.identity.longitude,
        radiusKm: null,
        scale: 'unknown',
      },
    };
  }

  if (!input.geocoderPermitted) {
    return {
      ok: false,
      failureKind: 'insufficient_data',
      detail: 'No shared destination identity was supplied and the geocoder is not permitted here.',
      providerCalls: 0,
    };
  }

  let result: Awaited<ReturnType<typeof geocode>>;
  try {
    result = await (input.geocodeImpl ?? geocode)(input.text, { limit: 5 });
  } catch (error) {
    /*
     * A geocoder that threw is unavailable, whatever it threw.
     *
     * The distinction that matters is the one below: a service that *answered*
     * with nothing has told us the destination does not exist, which is
     * `insufficient_data` and will never work. A service that did not answer may
     * answer in a minute. Collapsing those two would make an outage look like a
     * place that is not real, and a retry would be pointless in one case and
     * correct in the other.
     */
    const rateLimited = error instanceof GeocoderError && error.code === 'rate_limited';
    return {
      ok: false,
      failureKind: 'provider_unavailable',
      detail: rateLimited
        ? 'The geocoder asked us to slow down, so the destination could not be established.'
        : 'The geocoder did not answer, so the destination could not be established.',
      providerCalls: 1,
    };
  }

  const best = pickBest(result.places);
  if (!best) {
    return {
      ok: false,
      failureKind: 'insufficient_data',
      detail: 'The geocoder returned nothing for that destination.',
      providerCalls: result.calls,
    };
  }

  const latitude = Number(best.lat);
  const longitude = Number(best.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      ok: false,
      failureKind: 'insufficient_data',
      detail: 'The geocoder returned a record with no usable position.',
      providerCalls: result.calls,
    };
  }

  const classification = classifyNominatim(best);
  return {
    ok: true,
    fromRequest: false,
    providerCalls: result.calls,
    destination: {
      entityId: osmElementId(best) ?? `nominatim/${best.place_id ?? best.display_name}`,
      displayName: best.display_name,
      countryCode: best.address?.country_code?.toUpperCase() ?? null,
      latitude,
      longitude,
      radiusKm: boundsRadiusKm(best),
      scale: classification.breadth,
    },
  };
}

/**
 * The first record, and nothing cleverer.
 *
 * Nominatim orders by its own relevance, which is a published behaviour of the
 * service rather than a judgement of ours. Re-ranking here would be this arm
 * quietly acquiring a destination-resolution heuristic that the other arm's
 * shared identity never went through — and a difference in *which town* the two
 * systems planned would swamp every other difference in the results.
 */
function pickBest(places: readonly NominatimPlace[]): NominatimPlace | null {
  return places[0] ?? null;
}
