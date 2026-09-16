import 'server-only';
import { EMPTY_MOBILITY_CAPABILITIES, type CapabilityCoverage, type MobilityCapabilities, type ProviderCapability, type TravelMode } from '@sidequest/core';
import { routingCoverageFromEnv } from './routing-coverage';
import { isFixtureComposer, isGlobalRoutesProviderEnabled, isRoutesProviderEnabled, isTransitProviderEnabled } from './switches';

/**
 * V12.1 §9 §10 — THE DEPLOYMENT'S MOBILITY CAPABILITIES, BUILT FROM THE SWITCHES.
 *
 * `providers/capabilities.mjs` answers "is a router configured". This answers
 * the question readiness actually asks — "**could anything here have timed this
 * mode on this ground**" — and the difference is not pedantic. Probed in this
 * pass, the deployed Valhalla's tile build is Iceland: Tokyo→Kyoto,
 * Paris→Paris, Athens→Mykonos and Canmore→Lake Louise all return
 * `error_code 171`, while the registry reported `routing.drive: available` for
 * every one of them. That is how a Rockies build shipped one measured leg in
 * twenty-seven with nothing upstream noticing.
 *
 * Reads the import-free switches and the coverage declaration, and nothing
 * else. No provider module enters a render path's import graph through this
 * file — the same rule `switches.ts` holds itself to.
 */

/*
 * What a road router can be asked about. `operator_transfer` is deliberately
 * absent: a guide's vehicle drives on roads, and the journey time is the
 * operator's to state, so a router that answered would be answering a different
 * question from the one the plan asks.
 */
const ROAD_MODES: TravelMode[] = ['drive', 'four_wheel_drive', 'taxi', 'private_transfer', 'bus', 'shuttle'];

function localCoverage(): CapabilityCoverage {
  const declared = routingCoverageFromEnv();
  if (!declared.declared) return { kind: 'unknown' };
  return { kind: 'declared', boxes: declared.boxes, label: declared.label };
}

/**
 * What this build can measure, mode by mode.
 *
 * Deliberately conservative about what it claims and deliberately generous
 * about what it refuses to rule out: an undeclared coverage is `unknown`, which
 * behaves as "the request is worth making". Turning our own ignorance of a
 * router's tiles into a statement about the world is the mistake this whole
 * pass exists to stop.
 */
export function mobilityCapabilities(): MobilityCapabilities {
  const entries: ProviderCapability[] = [];

  /*
   * The fixture composer's world is measured by construction: the acceptance
   * fixtures carry their own durations, and a build that reported "no provider"
   * there would make every fixture trip unready for a reason the fixture has
   * nothing to do with.
   */
  if (isFixtureComposer()) {
    for (const mode of [...ROAD_MODES, 'walk', 'bike', 'trail'] as TravelMode[]) {
      entries.push({ provider: 'fixture', mode, coverage: { kind: 'global' }, supportsDuration: true, supportsShape: true, supportsTimetable: false, supportsFutureDate: true, supportsFrequency: false, persistable: true });
    }
    return { entries };
  }

  if (isRoutesProviderEnabled()) {
    const coverage = localCoverage();
    for (const mode of ROAD_MODES) {
      entries.push({ provider: 'valhalla', mode, coverage, supportsDuration: true, supportsShape: true, supportsTimetable: false, supportsFutureDate: false, supportsFrequency: false, persistable: true });
    }
    entries.push({ provider: 'valhalla', mode: 'walk', coverage, supportsDuration: true, supportsShape: true, supportsTimetable: false, supportsFutureDate: false, supportsFrequency: false, persistable: true });
  }

  if (isGlobalRoutesProviderEnabled()) {
    for (const mode of [...ROAD_MODES, 'walk', 'bike'] as TravelMode[]) {
      entries.push({ provider: 'openrouteservice', mode, coverage: { kind: 'global' }, supportsDuration: true, supportsShape: true, supportsTimetable: false, supportsFutureDate: false, supportsFrequency: false, persistable: true });
    }
  }

  if (isTransitProviderEnabled()) {
    /*
     * Valhalla multimodal, and only where the instance holds transit tiles. The
     * adapter's own post-flight check refuses a reply with no transit maneuver
     * in it, so a server without tiles produces no evidence rather than a
     * walking route wearing a transit label. Coverage is `unknown` here because
     * transit tiles are per-metro and nothing declares which.
     */
    for (const mode of ['urban_transit', 'bus', 'rail'] as TravelMode[]) {
      entries.push({ provider: 'valhalla-multimodal', mode, coverage: { kind: 'unknown' }, supportsDuration: true, supportsShape: false, supportsTimetable: true, supportsFutureDate: true, supportsFrequency: false, persistable: true });
    }
  }

  /*
   * GOOGLE ROUTES IS NEVER REGISTERED HERE, AND THAT IS A DECISION.
   *
   * It supports transit with real timetables and it is configured in some
   * deployments. `BLOCKER-google-terms.md` finds no clause permitting Sidequest
   * to persist a Routes duration or polyline, and every Journey is stored on
   * `itinerary.package`. Registering it with `persistable: false` would be
   * honest and would still be read by `measurementAvailability` as
   * `unusable_terms` — which is the right answer and is why the field exists.
   * It is left unregistered until an operator has settled the terms question,
   * because a capability that cannot be used is not a capability this build has.
   */

  return entries.length > 0 ? { entries } : EMPTY_MOBILITY_CAPABILITIES;
}
