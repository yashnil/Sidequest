import {
  REGION_SEMANTIC_TYPES,
  centreIsStandIn,
  isAreaType,
  type CoverageRole,
  type CoverageZone,
  type DestinationConcept,
  type DestinationDecomposition,
  type SemanticGateway,
  type SemanticPart,
  type ZoneRelation,
  DESTINATION_DECOMPOSITION_VERSION,
  destinationDecompositionSchema,
} from './semantics';
import type { Coordinates } from '../schemas/common';
import { diagonalKm } from './semantics';

/**
 * V10 §3 — REGIONAL DECOMPOSITION, GENERICALLY.
 *
 * A broad natural or cultural region cannot be composed against as one word.
 * "the Canadian Rockies" is four parks in two provinces across 400 km; a model
 * asked to plan it from the phrase alone has to invent the geography *and* the
 * trip, and what it invents is unverifiable. So before composition the
 * destination is broken into a **coverage graph**: zones a trip can actually be
 * built from, their roles, how far apart they are, and which experiences were
 * named for each.
 *
 * Three rules keep this honest and keep it generic:
 *
 * 1. **A zone is evidence.** Every zone is a name something placed — a
 *    resolved part of the phrase, or an area the interpreter named that the
 *    geocoder then found and the semantic gate accepted. Nothing here invents a
 *    coordinate and nothing here is keyed to a destination name: there is no
 *    `if (destination === 'Canadian Rockies')` and there cannot be, because the
 *    function never sees a destination name it branches on.
 * 2. **Role is derived, not asserted.** `core` and `optional` are decided by
 *    where a zone sits relative to the destination's own extent (or, absent an
 *    extent, relative to the spread of the zones themselves). A gateway is a
 *    gateway because it arrived as one — context, never the destination.
 * 3. **A thin decomposition is allowed to be thin.** A city is one zone. A
 *    destination nobody placed is no zones and a sentence saying so. An empty
 *    coverage graph is a true statement about the evidence; a fabricated one is
 *    not.
 *
 * The route that comes out of composition may deliberately cover only a subset
 * of the core zones — depth over breadth is a real choice — but §3 requires it
 * to say which ones it left and why, and it can only do that against a list.
 */

/** Kilometres between two points, great-circle. */
export function kmBetween(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la = toRad(a.lat);
  const lb = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A stable id from a label: lower-case, words joined by hyphens, no provider ids. */
export function zoneIdFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'zone';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-x`;
}

/**
 * How far from the centre a zone may sit and still be core.
 *
 * Derived from the destination's own extent when one exists, so it scales with
 * the thing: half the corner-to-corner diagonal is "inside". With no published
 * extent the zones themselves are the only evidence of size, so the median
 * distance from the centre is used — which puts roughly half the named areas in
 * core and is a statement about this destination rather than a constant tuned
 * against one country.
 */
export function coreRadiusKm(input: { extentDiagonalKm: number | null; distances: readonly number[] }): number {
  if (input.extentDiagonalKm !== null && input.extentDiagonalKm > 0) return Math.max(20, input.extentDiagonalKm / 2);
  if (input.distances.length === 0) return 60;
  const sorted = [...input.distances].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return Math.max(20, median * 1.25);
}

export interface DecompositionInput {
  concept: Pick<DestinationConcept, 'type' | 'scale' | 'center' | 'centerBasis' | 'extent' | 'parts' | 'gateways' | 'label'>;
  /** Experiences the interpreter named, by name only. Assigned to the nearest zone that placed. */
  signatureExperiences?: readonly { name: string; near?: Coordinates }[];
  /** Measured road minutes for zone pairs, when a router answered. Keyed `fromId>toId`. */
  measured?: ReadonlyMap<string, number>;
}

/**
 * Build the coverage graph. Pure, deterministic, and free of provider calls:
 * the caller has already resolved whatever it could, and this reads only what
 * placed.
 */
export function decomposeDestination(input: DecompositionInput): DestinationDecomposition {
  const { concept } = input;
  const centre = concept.center ?? null;
  const taken = new Set<string>();
  const zones: CoverageZone[] = [];

  const addZone = (source: SemanticPart | SemanticGateway, role: CoverageRole, kmFromCentre: number): CoverageZone | null => {
    const center = 'center' in source ? source.center : undefined;
    if (!center) return null;
    const id = zoneIdFor(source.label, taken);
    taken.add(id);
    const zone: CoverageZone = {
      id,
      label: source.label,
      role,
      center,
      ...('bounds' in source && source.bounds ? { bounds: source.bounds } : {}),
      ...(source.countryCode ? { countryCode: source.countryCode } : {}),
      source: source.source,
      ...('featureType' in source && source.featureType ? { featureType: source.featureType } : {}),
      kmFromCentre: Math.round(kmFromCentre * 10) / 10,
      signatureExperiences: [],
    };
    zones.push(zone);
    return zone;
  };

  const partDistances = centre ? concept.parts.map((p) => kmBetween(centre, p.center)) : [];
  const radius = coreRadiusKm({
    extentDiagonalKm: concept.extent ? diagonalKm(concept.extent.bounds) : null,
    distances: partDistances,
  });

  for (const [index, part] of concept.parts.entries()) {
    const km = centre ? partDistances[index]! : 0;
    /*
     * A stand-in centre cannot decide "inside": measuring from a country's
     * published point would call the nearest area core because it happens to
     * be nearest to a capital. With no trustworthy centre every placed area is
     * core, which is the honest reading — they are all the evidence there is.
     */
    const role: CoverageRole = !centre || centreIsStandIn(concept.centerBasis) ? 'core' : km <= radius ? 'core' : 'optional';
    addZone(part, role, km);
  }
  for (const gateway of concept.gateways) {
    if (!gateway.center) continue;
    addZone(gateway, 'gateway', centre ? kmBetween(centre, gateway.center) : 0);
  }

  /* Experiences attach to the nearest zone that placed; one with no coordinate attaches to nothing rather than to a guess. */
  for (const experience of input.signatureExperiences ?? []) {
    if (!experience.near) continue;
    let best: CoverageZone | null = null;
    let bestKm = Number.POSITIVE_INFINITY;
    for (const zone of zones) {
      if (zone.role === 'gateway') continue;
      const km = kmBetween(zone.center, experience.near);
      if (km < bestKm) {
        bestKm = km;
        best = zone;
      }
    }
    if (best && best.signatureExperiences.length < 8) best.signatureExperiences.push(experience.name);
  }

  const relations: ZoneRelation[] = [];
  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      const a = zones[i]!;
      const b = zones[j]!;
      const minutes = input.measured?.get(`${a.id}>${b.id}`) ?? input.measured?.get(`${b.id}>${a.id}`);
      relations.push({
        fromId: a.id,
        toId: b.id,
        km: Math.round(kmBetween(a.center, b.center) * 10) / 10,
        ...(minutes !== undefined ? { minutes } : {}),
        basis: minutes !== undefined ? 'measured' : 'unmeasured',
      });
      if (relations.length >= 120) break;
    }
    if (relations.length >= 120) break;
  }

  const core = zones.filter((z) => z.role === 'core').length;
  const optional = zones.filter((z) => z.role === 'optional').length;
  const gateways = zones.filter((z) => z.role === 'gateway').length;
  const note =
    zones.length === 0
      ? `Nothing has placed an area inside ${concept.label} yet, so the plan is composed from the destination as a whole.`
      : !isAreaType(concept.type) && zones.length <= 1
        ? `${concept.label} is one place, not a region to divide.`
        : `${core} core ${core === 1 ? 'zone' : 'zones'}${optional > 0 ? `, ${optional} optional` : ''}${gateways > 0 ? `, ${gateways} gateway${gateways === 1 ? '' : 's'}` : ''}.`;

  return destinationDecompositionSchema.parse({
    version: DESTINATION_DECOMPOSITION_VERSION,
    zones: zones.slice(0, 16),
    relations,
    note,
  });
}

/** Whether a destination is broad enough that a decomposition is required before composition. */
export function needsDecomposition(concept: Pick<DestinationConcept, 'type' | 'scale'>): boolean {
  if (!REGION_SEMANTIC_TYPES.has(concept.type)) return false;
  return concept.scale === 'subregion' || concept.scale === 'region' || concept.scale === 'country' || concept.scale === 'continental';
}

/** The zones a route left out, for the omissions the composition is asked to explain. */
export function uncoveredZones(input: { decomposition: DestinationDecomposition; covered: readonly string[] }): CoverageZone[] {
  const hit = new Set(input.covered.map((c) => c.toLowerCase()));
  return input.decomposition.zones.filter((zone) => {
    if (zone.role === 'gateway') return false;
    const label = zone.label.toLowerCase();
    for (const name of hit) if (name.includes(label) || label.includes(name)) return false;
    return true;
  });
}
