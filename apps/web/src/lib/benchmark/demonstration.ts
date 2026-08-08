import 'server-only';
import {
  type BenchmarkTripRequest,
  benchmarkTripRequestSchema,
} from '@sidequest/bench';
import { fakeRequest } from '@sidequest/bench/testing';

/**
 * THE TRAVELLER THE OFFLINE DEMONSTRATION USES.
 *
 * A seventeen-case library exists, and every case in it names a real
 * destination, because a human comparing sixteen traveller profiles has to be
 * able to tell them apart. That is right for the library and wrong for a
 * demonstration that has to run with every provider switched off.
 *
 * Offline, the geocoder is not reachable. So a request naming a real city gets
 * as far as "the destination could not be matched to a place on the map", and
 * the deterministic arm honestly fails — which is a correct outcome, exercises
 * the failure path, and is a poor demonstration: a reviewer opening it sees one
 * empty panel and learns nothing about whether a blind comparison of two plans
 * works.
 *
 * This request names a destination from the seeded index the offline stack
 * already ships for its browser suite. Five invented countries, none of them
 * anywhere, deliberately — so that nothing about the demonstration can be
 * mistaken for a measurement of how well either system plans a real trip, and so
 * that no production behaviour can come to depend on a place name.
 *
 * It is a harness fixture and it lives here rather than in the case library for
 * exactly that reason: the library is a set of travellers, and this is a piece of
 * test apparatus.
 */

/** A locality from `e2e/support/destination-index.ndjson`. Invented. */
export const DEMONSTRATION_DESTINATION = 'Ambervale Highlands Town 1';

export const DEMONSTRATION_CASE_ID = 'demonstration-offline';

/**
 * Dates far enough out that nothing needs a forecast, and close enough that a
 * climate record covers them. Fixed rather than relative to today, so two runs a
 * week apart produce the same session.
 */
const START = '2027-05-18';
const END = '2027-05-21';

export function demonstrationRequest(): BenchmarkTripRequest {
  const base = fakeRequest();
  const request: BenchmarkTripRequest = {
    ...base,
    requestId: 'request-demonstration-offline',
    destination: {
      mode: 'known',
      text: DEMONSTRATION_DESTINATION,
      /*
       * Resolved up front, because the shared request is where a destination
       * identity belongs.
       *
       * Both arms plan the same trip only if they agree about where it is, and
       * two systems each geocoding the same words could land on different
       * places. So the harness resolves once and hands the answer to both — and
       * offline, where no geocoder is reachable, the answer is this: the seeded
       * index's own locality, at its own centre.
       */
      identity: {
        id: 'AA-region-0-loc-0',
        displayName: DEMONSTRATION_DESTINATION,
        countryCode: 'AA',
        latitude: 45.73,
        longitude: 7.85,
      },
    },
    dates: { ...base.dates, mode: 'exact', startDate: START, endDate: END, nights: 3 },
    // The must-do is dropped rather than carried over from the fixture
    // traveller: it names a place in the fixture world, and a demonstration
    // that shipped a must-do neither arm could ever satisfy would put two
    // critical findings on every panel for a reason that is about the apparatus.
    taste: { ...base.taste, mustDo: [] },
  };
  // Parsed rather than asserted. A demonstration that could not be created is
  // better discovered here than on a screen the founder has just opened.
  return benchmarkTripRequestSchema.parse(request);
}
