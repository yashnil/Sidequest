import 'server-only';
import type {
  BenchmarkGroundTruth,
  BenchmarkTripRequest,
  DayOpening,
  FoodVenueFacts,
  InventoryEntry,
  SolarDay,
} from '@sidequest/bench';
import { haversineKm } from '@sidequest/bench';
import type { PacketInputs, RawPlace } from './baseline/packet';

/**
 * ONE WORLD, ASSEMBLED FROM EVERYTHING EITHER ARM ESTABLISHED.
 *
 * The two arms buy their own data. The deterministic pipeline compiles a region;
 * the baseline gathers a packet. Both reach the same public providers — the same
 * open place data, the same routing service, the same forecast — so where they
 * both saw a place they agree about it, and both record it under the same
 * source-level identity.
 *
 * They do not see the *same* set of places, though, and that creates a problem
 * the benchmark would otherwise get wrong in a way nobody would notice.
 *
 * If each plan were checked only against its own arm's world, each arm would be
 * marking its own homework: a plan asserting hours that its own gather step
 * invented would validate clean. And if both were checked only against the
 * pipeline's compiled region, every place the baseline found and the pipeline did
 * not would come back `subject_not_in_inventory` — which is not a defect, but
 * which would systematically depress one arm's verifiability for a reason that is
 * a property of the instrument rather than of the plan.
 *
 * So the instrument is the union. A fact either arm established is established
 * for the checker, whichever plan it is checking. What remains unknown afterwards
 * is genuinely unknown — a gap in the world rather than a gap in whose notebook
 * we happened to open — which is the only reading under which "lower
 * verifiability rather than an error" means anything.
 *
 * The composition rule is first-non-null, and it is safe because the underlying
 * providers are the same: two sources that both answer are answering about the
 * same public record. Where they would genuinely disagree — a route measured on
 * different days, say — the disagreement is smaller than the tolerances every
 * check applies, and preferring either one systematically would be worse than
 * preferring whichever answered.
 */

/**
 * Try each source in turn; the first that establishes something wins.
 *
 * `null` means "not established" throughout the port, so falling through a
 * source that does not know is exactly the right behaviour and needs no special
 * case. A method that returns `null` from every source stays `null`, and the
 * check that asked reports `unknown` with a reason.
 */
export function composeGroundTruth(
  sources: readonly BenchmarkGroundTruth[],
): BenchmarkGroundTruth {
  const first = sources[0];
  if (!first) {
    throw new Error('A composed ground truth needs at least one source.');
  }

  function tryEach<T>(read: (source: BenchmarkGroundTruth) => T | null): T | null {
    for (const source of sources) {
      const answer = read(source);
      if (answer !== null && answer !== undefined) return answer;
    }
    return null;
  }

  return {
    // The request and the instant are properties of the session, not of a
    // source. Taken from the first and asserted identical by the orchestrator,
    // because two sources judging against different clocks would be two
    // instruments wearing one name.
    request: first.request,
    now: first.now,

    place: (entityId) => tryEach((source) => source.place(entityId)),
    openingOn: (entityId, date) => tryEach((source) => source.openingOn(entityId, date)),
    seasonallyOpenOn: (entityId, date) =>
      tryEach((source) => source.seasonallyOpenOn(entityId, date)),
    solar: (entityId, date) => tryEach((source) => source.solar(entityId, date)),
    routeMinutes: (from, to) => tryEach((source) => source.routeMinutes(from, to)),
    straightLineKm: (from, to) => tryEach((source) => source.straightLineKm(from, to)),
    food: (entityId) => tryEach((source) => source.food(entityId)),
    supportsClaim: (sourceIndex, factPath, statedValue) =>
      tryEach((source) => source.supportsClaim(sourceIndex, factPath, statedValue)),
  };
}

/* ------------------------------------------------------------------ *
 * The world the baseline gathered
 * ------------------------------------------------------------------ */

/**
 * A ground truth over the packet inputs the baseline's gather step produced.
 *
 * Deliberately built here rather than inside the baseline. A planner that
 * supplied the instrument it is measured with could shape both together, and
 * "the arm wrote its own checker" is not a sentence this benchmark can survive.
 * What the arm supplies is *data it fetched from a provider*; what the
 * orchestrator does with it is not the arm's business.
 */
export function packetGroundTruth(input: {
  inputs: PacketInputs;
  request: BenchmarkTripRequest;
  now: Date;
}): BenchmarkGroundTruth {
  const places = new Map<string, RawPlace>(
    input.inputs.places.map((place) => [place.entityId, place]),
  );

  const routes = new Map<string, number>();
  for (const leg of input.inputs.routeLegs) {
    // Symmetric, because a routing service asked for one direction has told us
    // something about the pair. A check comparing an allotted gap against a
    // measured leg does not care which way round it was measured, and treating
    // the reverse as unmeasured would report `unknown` for a fact we hold.
    routes.set(`${leg.fromEntityId}|${leg.toEntityId}`, leg.minutes);
    if (!routes.has(`${leg.toEntityId}|${leg.fromEntityId}`)) {
      routes.set(`${leg.toEntityId}|${leg.fromEntityId}`, leg.minutes);
    }
  }

  const daysByDate = new Map(input.inputs.days.map((day) => [day.date, day]));

  return {
    request: input.request,
    now: input.now,

    place(entityId): InventoryEntry | null {
      const place = places.get(entityId);
      if (!place) return null;
      return {
        entityId: place.entityId,
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
        typicalDurationMinutes: place.typicalDurationMinutes,
        daylightOnly: place.daylightOnly,
        tags: place.tags,
        requiresCar: place.access.requiresCar,
        unpavedApproach: place.access.unpavedApproach,
        remoteNoServices: place.access.remoteNoServices,
        strenuous: place.access.strenuous,
      };
    },

    openingOn(entityId, date): DayOpening | null {
      const place = places.get(entityId);
      if (!place) return null;
      const hours = place.hours;
      if (hours.state === 'always_open') {
        return { status: 'always_open', windows: [], lastAdmissionMinute: null };
      }
      if (hours.state === 'known') {
        if (hours.closedDates.includes(date)) {
          return { status: 'closed', windows: [], lastAdmissionMinute: null };
        }
        const onTheDay = hours.windows.filter((window) => window.date === date);
        // A date the source covered but listed no window for is not the same as
        // a date it never mentioned. The first is silence about that day and
        // stays unknown; only an explicit closure is a closure.
        if (onTheDay.length === 0) {
          return { status: 'unknown', windows: [], lastAdmissionMinute: null };
        }
        return {
          status: 'open',
          windows: onTheDay.map((window) => ({
            openMinute: window.openMinute,
            closeMinute: window.closeMinute,
          })),
          lastAdmissionMinute: null,
        };
      }
      /*
       * The honest answer, and the common one.
       *
       * The baseline's gather step reads `opening_hours` rather than parsing it,
       * because a half-correct parser is worse than none — a place wrongly
       * believed open at nine is somebody standing at a locked gate. So a place
       * whose hours were not trivially readable is `unknown`, the check that
       * asked reports `unknown`, and neither plan is credited or penalised for
       * a window nobody established.
       */
      return { status: 'unknown', windows: [], lastAdmissionMinute: null };
    },

    seasonallyOpenOn(entityId): boolean | null {
      const place = places.get(entityId);
      if (!place) return null;
      if (place.seasonal.state === 'open_in_season') return true;
      if (place.seasonal.state === 'closed_in_season') return false;
      return null;
    },

    solar(_entityId, date): SolarDay | null {
      // Computed for the destination rather than per place: sunrise moves by
      // seconds across a region a trip covers, and by far less than the
      // half-hour buffer any daylight check applies.
      const day = daysByDate.get(date);
      if (!day) return null;
      const daylight = day.daylight;
      if (daylight.state === 'known') {
        return {
          sunriseMinute: daylight.sunriseMinute,
          sunsetMinute: daylight.sunsetMinute,
          kind: 'normal',
        };
      }
      // A polar day or night has no sunrise to schedule against, and saying so
      // is a different answer from having failed to compute one. The daylight
      // check reads the kind and declines rather than comparing against a time
      // that does not exist.
      if (daylight.state === 'polar_day') {
        return { sunriseMinute: 0, sunsetMinute: 1440, kind: 'polar_day' };
      }
      if (daylight.state === 'polar_night') {
        return { sunriseMinute: 0, sunsetMinute: 0, kind: 'polar_night' };
      }
      return null;
    },

    routeMinutes(from, to): number | null {
      return routes.get(`${from}|${to}`) ?? null;
    },

    straightLineKm(from, to): number | null {
      const a = places.get(from);
      const b = places.get(to);
      if (!a || !b) return null;
      return haversineKm(a, b);
    },

    food(entityId): FoodVenueFacts | null {
      const place = places.get(entityId);
      if (!place?.food) return null;
      return {
        entityId: place.entityId,
        name: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
        servesSlots: place.food.servesSlots,
        // What a venue *states* it cannot do. An empty list is not a promise
        // that it can; it means nobody said, and the dietary check reads that
        // as unverified rather than as safe.
        cannotAccommodate: place.food.cannotAccommodate,
      };
    },

    supportsClaim(_sourceIndex, _factPath, _statedValue): boolean | null {
      /*
       * Always `null`, and the reason is the whole point of the port's contract.
       *
       * This used to answer `false` for an index outside the packet's own source
       * count — which reads like a range check and is not one. A `sourceIndex`
       * is an index into *the plan's* source list, and the packet's list is a
       * different list of a different length. So a perfectly good citation was
       * convicted as an unsupported factual claim, at major severity, on the
       * strength of an unrelated count — and the arm that cites systematically
       * was the one exposed to it.
       *
       * The range check belongs to the claims validator, which has the plan in
       * front of it and already does it. What this port is asked is narrower:
       * does the source at that index *state* the value the plan attributes to
       * it. The packet holds provider records rather than quoted statements, so
       * it cannot tell — and `null` is the honest answer to a question you
       * cannot answer. `false` is reserved for a source that was read and does
       * not say it.
       */
      return null;
    },
  };
}
