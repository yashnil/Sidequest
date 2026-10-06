import 'server-only';
import { countNights, countryFacts, decomposeDestination, needsDecomposition, routeObjectivesFor, type DestinationCandidate, type Trip, type TravelerProfile } from '@sidequest/core';
import type { getIntent } from '../db/compiler-repository';
import type { RegionContext } from '../region';
import { accessConstraintsFor } from '../providers/access-constraints';
import type { DestinationEnvelope } from './composition';

/**
 * V1 CONVERGENCE — ONE ACCOUNT OF THE DESTINATION, READ BY EVERY MODEL CALL.
 *
 * Extracted unchanged from `production-plan.ts` so the discovery scan's
 * proposal call and the build read the same envelope: the traveller's own
 * phrase, the resolved centre, the coverage graph for a broad region, the
 * gateways, the operational facts and the route's objectives. Two copies of
 * this is how the board and the plan would come to disagree about what the
 * destination is. Pure apart from reading the bundled access-constraint data.
 */
export interface DestinationEnvelopeResult {
  envelope: DestinationEnvelope;
  storedIntent: NonNullable<ReturnType<typeof getIntent>>['destinationIntent'] | null;
  concept: NonNullable<NonNullable<ReturnType<typeof getIntent>>['destinationIntent']>['semantics'] | null;
  conceptCountries: string[];
  divisions: string[];
  conceptGateways: { label: string; coordinates?: { lat: number; lng: number } }[];
  decomposition: ReturnType<typeof decomposeDestination> | null;
  resolvedName: string;
  rawDestinationPhrase: string;
  destinationName: string;
}

/** Case- and punctuation-insensitive, so "Hong Kong" and "hong kong" are one phrase. */
export function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function destinationEnvelopeFor(input: {
  trip: Trip;
  intent: ReturnType<typeof getIntent>;
  candidate: DestinationCandidate | null;
  region: RegionContext | null;
  profile: TravelerProfile;
}): DestinationEnvelopeResult {
  const { trip, intent, candidate, region, profile } = input;
  const composer = intent?.composer ?? null;
  /*
   * MVP V3, Stages 10–12 — THE DURABLE INTENT DECIDES WHAT THIS TRIP IS CALLED.
   *
   * The traveller's own phrase, and whether anything has earned the right to
   * replace it. "inland Alaska" resolving to a town is a *lead*, not a
   * correction, so `interpretedLabel` is still their words and the town travels
   * as a centre. Where no intent was ever recorded — a trip made before this
   * existed — the old derivation stands unchanged.
   */
  const storedIntent = intent?.destinationIntent ?? null;
  /*
   * V10 §2 — THE ONE CANONICAL DESTINATION OBJECT. Setup resolved it, the
   * questionnaire read it, and from here it is what composition, the placement
   * ladder, the quality compiler and the jurisdiction language all read.
   */
  const concept = storedIntent?.semantics ?? null;
  const conceptCountries = concept?.countries ?? (candidate?.countryCode ? [candidate.countryCode] : []);
  const divisions = (concept?.jurisdictions ?? []).filter((j) => j.level === 'subnational').map((j) => j.name);
  /*
   * V10 §8 — the gateways, in order of authority: the traveller's own scope
   * first (a gateway they named is a fact), then the rest of the scope's, then
   * the ones the semantic layer inferred. Context, never the destination.
   */
  const scopeGateways = [...(intent?.scope?.gateways ?? [])].sort((a, b) => Number(b.fixed) - Number(a.fixed));
  const conceptGateways = [
    ...scopeGateways.map((g) => ({ label: g.name, ...(g.coordinates ? { coordinates: g.coordinates } : {}) })),
    ...(concept?.gateways ?? []).map((g) => ({ label: g.label, ...(g.center ? { coordinates: g.center } : {}) })),
  ].filter((g, index, all) => all.findIndex((other) => other.label.toLowerCase() === g.label.toLowerCase()) === index);
  /*
   * V10 §3 — the coverage graph, derived from what already placed. Pure and
   * free: no provider call, no model call, no destination name in the code.
   */
  const decomposition =
    concept && needsDecomposition(concept)
      ? decomposeDestination({
          concept,
          ...(region ? { signatureExperiences: region.compiled.subregions.slice(0, 6).map((s) => ({ name: s.name, ...(s.center ? { near: s.center } : {}) })) } : {}),
        })
      : null;
  /* V10 §9 §11 — the operational facts that shape the plan, in the call's hands rather than corrected out of it afterwards. */
  const accessFacts = accessConstraintsFor(conceptCountries)
    .filter((c) => c.status !== 'unknown' && c.status !== 'open')
    .filter((c) => {
      const from = c.validFrom ?? '0000-01-01';
      const until = c.validUntil ?? '9999-12-31';
      return trip.basics.endDate >= from && trip.basics.startDate <= until;
    })
    .slice(0, 10)
    .map((c) => `${c.travellerNote} (${c.sourceName})`);
  /* V10 §11 — the route's objectives, derived from the traveller's own answers and the destination's own shape. */
  const routeObjectives = routeObjectivesFor({
    concept,
    profile,
    nights: countNights(trip.basics.startDate, trip.basics.endDate),
    ...(decomposition ? { coreZones: decomposition.zones.filter((z) => z.role === 'core').length } : {}),
  });
  const resolvedName = candidate?.displayName ?? region?.region.name ?? trip.basics.destinationInput;
  const rawDestinationPhrase = (storedIntent?.rawText || intent?.destinationQuery || composer?.destinationQuery || trip.basics.destinationInput || '').trim();
  const destinationName = storedIntent?.interpretedLabel || resolvedName;
  const referenceTimeZone = (() => {
    const codes = [...(intent?.destinationIntent?.graph?.countries ?? []), ...(candidate?.countryCode ? [candidate.countryCode] : [])];
    for (const code of codes) {
      const zone = countryFacts(code)?.timeZone;
      if (zone) return zone;
    }
    return null;
  })();
  const envelope: DestinationEnvelope = {
    name: destinationName,
    ...(candidate?.qualifiedName ? { qualifiedName: candidate.qualifiedName } : {}),
    ...(candidate?.countryCode ? { countryCode: candidate.countryCode } : {}),
    ...(candidate?.countryName ? { countryName: candidate.countryName } : {}),
    ...(candidate?.breadth ? { scale: candidate.breadth } : {}),
    center: candidate?.center ?? region?.region.baseCoordinates ?? { lat: 0, lng: 0 },
    /* The candidate's zone, else the first named country's reference zone: a sunset computed in UTC is a wrong sunset, not a missing one. */
    ...(candidate?.timeZones?.[0] ? { timeZone: candidate.timeZones[0] } : referenceTimeZone ? { timeZone: referenceTimeZone } : {}),
    ...(region ? { knownAreas: region.compiled.subregions.map((s) => s.name).slice(0, 8) } : {}),
    ...(storedIntent && storedIntent.interpretationType !== 'unresolved' ? { interpretation: storedIntent.interpretationType } : {}),
    /* The resolved place, when it did not earn the destination's name: a centre, labelled as one. */
    ...(storedIntent?.anchor && normalizePhrase(storedIntent.anchor.label) !== normalizePhrase(destinationName) ? { anchorName: storedIntent.anchor.label } : {}),
    ...(rawDestinationPhrase && normalizePhrase(rawDestinationPhrase) !== normalizePhrase(destinationName) ? { travellerPhrase: rawDestinationPhrase } : {}),
    /*
     * V10 §3 §11 — the semantic envelope: coverage graph, jurisdictions kept
     * separate, gateways, operational facts and what the route is for. Derived
     * from evidence Sidequest already holds; nothing is an allow-list.
     */
    ...(decomposition && decomposition.zones.length > 0
      ? {
          coverage: decomposition.zones.map((zone) => ({ label: zone.label, role: zone.role, kmFromCentre: zone.kmFromCentre, signatureExperiences: zone.signatureExperiences })),
          coverageNote: decomposition.note,
        }
      : {}),
    ...(concept && concept.jurisdictions.length > 0 ? { jurisdictions: concept.jurisdictions.map((j) => ({ level: j.level, name: j.name })) } : {}),
    ...(conceptGateways.length > 0 ? { gateways: conceptGateways.map((g) => g.label) } : {}),
    ...(accessFacts.length > 0 ? { accessFacts } : {}),
    ...(routeObjectives.length > 0 ? { routeObjectives } : {}),
  };
  return { envelope, storedIntent, concept, conceptCountries, divisions, conceptGateways, decomposition, resolvedName, rawDestinationPhrase, destinationName };
}
