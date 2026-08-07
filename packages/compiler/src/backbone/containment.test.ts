import { describe, expect, it } from 'vitest';
import {
  RELATIONSHIP_ADMISSION,
  SCOPE_RELATIONSHIPS,
  admitsToInventory,
  canAnchor,
  eligibilityFor,
  compareAtLevel,
  isSubdivisionCode,
  typedEvidenceFrom,
  type GeographicScope,
  type ScopeRelationship,
  type SourceRecord,
} from '@sidequest/core';
import {
  DivisionDirectory,
  decideContainment,
  haversineKm,
  partitionByContainment,
  retainsInPack,
  scopeIdentityKnown,
  scopeIsAdministrativeRegion,
  withContainmentDecision,
  containmentDecisionOf,
  type IncludedArea,
  type ScopeContainmentContext,
} from './containment';
import { admitLateCandidate, buildTripScopeOverlay, decisionFor } from './overlay';
import {
  CORRIDOR_TOWN_CENTRE,
  METRO_CENTRE,
  corridorCases,
  fixtureDivision,
  fixtureRecord,
  corridorDivisions,
  corridorExpansionAreas,
  corridorExpansionBase,
  corridorTownScope,
  countryCases,
  countryDivisions,
  countryScope,
  islandCases,
  islandDivisions,
  islandScope,
  measuredExtentScope,
  metropolitanCases,
  metropolitanDivisions,
  metropolitanInternalGateway,
  metropolitanScope,
  narrowedMetropolitanScope,
  northOf,
  protectedAreaCases,
  protectedAreaDivisions,
  protectedAreaExpansionAreas,
  protectedAreaScopeWithBoundary,
  utilityCases,
  utilityDivisions,
  utilityHeavyScope,
  type ContainmentCase,
} from '../testing/containment-fixtures';

/**
 * WHAT THESE TESTS ARE FOR, AND WHAT THEY DELIBERATELY NO LONGER ASSERT.
 *
 * The previous version of this file encoded a ladder whose fourth rung refused a
 * record for being far away. Seven of its assertions pinned that behaviour, and
 * the closure required them to be **re-reasoned rather than renamed** — for each
 * one, name the user-facing invariant, keep it if it is real, and delete the
 * assertion if what it protected was a distance threshold wearing a membership
 * name. `phase-12-containment-test-migration.md` records each of those decisions.
 *
 * The two failures the suite must hold apart, and the reason a single number can
 * hold neither:
 *
 * - **an unrelated record in an adjacent first-level division must not reach a
 *   board**, whatever the trip's reach;
 * - **a legitimate regional member forty-five kilometres out must survive**,
 *   without widening any radius and without naming any place.
 *
 * A threshold small enough to exclude the first necessarily excludes the second,
 * because real regions are not discs. Every test below therefore states the
 * *evidence* that decided it, and `distance is never the reason` is asserted as
 * its own property.
 */

function contextFor(
  scope: GeographicScope,
  divisions: readonly SourceRecord[],
  includedAreas: readonly IncludedArea[] = [],
): ScopeContainmentContext {
  const overlay = buildTripScopeOverlay({ scope, records: divisions, includedAreas });
  return overlay.context;
}

function subjectOf(record: SourceRecord) {
  return {
    id: record.id,
    coordinates: record.coordinates,
    ...(record.bounds ? { bounds: record.bounds } : {}),
    containment: record.containment,
    planningRole: record.planningRole,
    name: record.name,
  };
}

function runCases(cases: ContainmentCase[], context: ScopeContainmentContext): void {
  for (const entry of cases) {
    it(`${entry.label} → ${entry.expected}`, () => {
      const decision = decideContainment(subjectOf(entry.record), context);
      expect(decision.relationship, `${entry.label}: ${entry.because}`).toBe(entry.expected);
    });
  }
}

// ---------------------------------------------------------------------------

describe('the scope context', () => {
  it('reads a reach circle as a circle and never as a boundary', () => {
    const context = contextFor(metropolitanScope(), metropolitanDivisions());
    expect(context.boundaryEvidence).toBe('reach_circle');
    expect(context.boundary).toBeUndefined();
  });

  it('reads a measured extent as geometry', () => {
    const context = contextFor(measuredExtentScope(), metropolitanDivisions());
    expect(context.boundaryEvidence).toBe('measured_extent');
    expect(context.boundary).toBeDefined();
  });

  it('carries no reach radius at all, because reach is a traveller and not a place', () => {
    const context = contextFor(metropolitanScope(), metropolitanDivisions());
    expect(Object.keys(context)).not.toContain('reachRadiusKm');
    expect(Object.keys(context)).not.toContain('coreRadiusKm');
  });

  it('resolves the destination’s own identity from the same divisions every record uses', () => {
    const context = contextFor(metropolitanScope(), metropolitanDivisions());
    expect(scopeIdentityKnown(context)).toBe(true);
    expect(context.evidence.divisionIds).toContain('div-selected-city');
    expect(context.evidence.countryCode).toBe('AA');
    expect(context.evidence.regionCode).toBe('AA-SR');
  });

  it('says so honestly when there are no divisions to resolve against', () => {
    const context = contextFor(metropolitanScope(), []);
    /*
     * The scope still knows its own country code and its own name, which is
     * genuine evidence — but nothing resolved a division, so the identity that
     * excludes an adjacent first-level division is missing and the build is
     * thin. The point of this test is that the thinness is *visible*: no escape
     * turns it into a promotion.
     */
    expect(context.evidence.divisionIds).toHaveLength(0);
    expect(context.directory?.size ?? 0).toBe(0);
  });

  it('keys "agreeing at region is membership" on what the destination is, not how big it is', () => {
    expect(scopeIsAdministrativeRegion({ entityType: 'country', breadth: 'country' })).toBe(true);
    expect(scopeIsAdministrativeRegion({ entityType: 'state_or_province', breadth: 'region' })).toBe(true);
    /*
     * Both of these are `subregion` breadth and neither is an administrative
     * region. A park and an island are as big as a province and are not one, and
     * treating them alike is what would put the gateway town's museum inside the
     * park.
     */
    expect(scopeIsAdministrativeRegion({ entityType: 'protected_area', breadth: 'subregion' })).toBe(false);
    expect(scopeIsAdministrativeRegion({ entityType: 'island', breadth: 'subregion' })).toBe(false);
    /* A destination we could not classify behaves like its breadth. */
    expect(scopeIsAdministrativeRegion({ entityType: 'unknown', breadth: 'country' })).toBe(true);
    expect(scopeIsAdministrativeRegion({ entityType: 'unknown', breadth: 'city' })).toBe(false);
  });
});

describe('a metropolitan destination with a reach circle and no boundary', () => {
  runCases(metropolitanCases(), contextFor(metropolitanScope(), metropolitanDivisions()));
});

describe('the two failures that must hold simultaneously', () => {
  const metro = contextFor(metropolitanScope(), metropolitanDivisions());
  const corridor = contextFor(
    corridorTownScope(),
    corridorDivisions(),
    corridorExpansionAreas(),
  );

  it('excludes an unrelated record in an adjacent first-level division', () => {
    const unrelated = metropolitanCases().find(
      (entry) => entry.record.sourceId === 'adjacent-division-retail',
    )!;
    const decision = decideContainment(subjectOf(unrelated.record), metro);
    expect(decision.relationship).toBe('outside_scope');
    expect(decision.eligibility.provisionalBoardEligible).toBe(false);
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(false);
    /* On its own published evidence, not on how far away it is. */
    expect(decision.basis).not.toBe('no_evidence');
    expect(decision.levels.some((level) => level.comparison === 'disagree')).toBe(true);
  });

  it('keeps a legitimate regional member forty-five kilometres out', () => {
    const member = corridorCases().find((entry) => entry.record.sourceId === 'corridor-lake')!;
    const decision = decideContainment(subjectOf(member.record), corridor);
    expect(decision.relationship).toBe('regional_expansion_member');
    expect(decision.eligibility.finalBoardEligible).toBe(true);
    expect(decision.eligibility.plannerEligible).toBe(true);
    expect(decision.inclusionReason).toBe('regional_expansion_requested');
    expect(decision.servesAreaId).toBe('area-lakeside');
  });

  it('holds both at once, and the far one is further away than the excluded one is', () => {
    const unrelated = metropolitanCases().find(
      (entry) => entry.record.sourceId === 'adjacent-division-retail',
    )!;
    const member = corridorCases().find((entry) => entry.record.sourceId === 'corridor-lake')!;
    const excludedKm = haversineKm(METRO_CENTRE, unrelated.record.coordinates);
    const keptKm = haversineKm(CORRIDOR_TOWN_CENTRE, member.record.coordinates);
    /*
     * The excluded record is 160 km out and the kept one is 45 km out, so a
     * single threshold *could* separate these two. The point of the assertion is
     * the next one: change the trip's reach and neither answer moves, because
     * reach is not among the arguments.
     */
    expect(excludedKm).toBeGreaterThan(keptKm);
  });

  it('gives the same answers for a three-night trip and a nine-night trip', () => {
    /*
     * The traveller-dependence CS-9 named, as a test. `nights` changes the
     * reach radius from about 112 km to about 220 km, and used to change the
     * gateway and satellite sets computed at pack build — into a cache two
     * travellers shared.
     */
    const short = contextFor(corridorTownScope({ nights: 3 }), corridorDivisions(), corridorExpansionAreas());
    const long = contextFor(corridorTownScope({ nights: 9 }), corridorDivisions(), corridorExpansionAreas());
    for (const entry of corridorCases()) {
      expect(decideContainment(subjectOf(entry.record), short).relationship).toBe(
        decideContainment(subjectOf(entry.record), long).relationship,
      );
    }
  });

  it('does not become stricter when the traveller narrows the trip', () => {
    /*
     * CS-9. Narrowing changes the shape a trip covers; it does not change the
     * destination's published extent. The old code chose the boundary
     * half-diagonal for a *narrowed* scope and a loose 30 km default otherwise,
     * so asking for a wider trip made containment four times stricter.
     */
    const wide = contextFor(measuredExtentScope(), metropolitanDivisions());
    const narrow = contextFor(narrowedMetropolitanScope(), metropolitanDivisions());
    for (const entry of metropolitanCases()) {
      const wideDecision = decideContainment(subjectOf(entry.record), wide);
      const narrowDecision = decideContainment(subjectOf(entry.record), narrow);
      expect(narrowDecision.relationship, entry.label).toBe(wideDecision.relationship);
    }
  });
});

describe('distance is diagnostic and never a reason', () => {
  const context = contextFor(metropolitanScope(), metropolitanDivisions());

  it('gives two records with identical evidence the same answer at any distance', () => {
    const near = metropolitanCases().find((entry) => entry.record.sourceId === 'unplaced-inner')!;
    const far = metropolitanCases().find((entry) => entry.record.sourceId === 'unplaced-outer')!;
    const nearDecision = decideContainment(subjectOf(near.record), context);
    const farDecision = decideContainment(subjectOf(far.record), context);
    expect(nearDecision.relationship).toBe(farDecision.relationship);
    expect(nearDecision.basis).toBe(farDecision.basis);
    /* Recorded, and different, and it changed nothing. */
    expect(farDecision.diagnosticDistanceKm).toBeGreaterThan(
      nearDecision.diagnosticDistanceKm + 100,
    );
  });

  it('never admits a record for being near the centre', () => {
    /*
     * A record with no evidence, nine kilometres from the destination centre and
     * outside every published division box. The old ladder's `withinCore` branch
     * called this `membership_unknown` *and* let it anchor, because
     * `canAnchor` had an escape for an unidentifiable destination; a still older
     * one called it `inside_scope`. Proximity to a centre is not evidence of
     * belonging — an enclave is at the centre of the thing it is not part of.
     */
    const nearby = metropolitanCases().find((entry) => entry.record.sourceId === 'unplaced-inner')!;
    const decision = decideContainment(subjectOf(nearby.record), context);
    expect(decision.relationship).toBe('membership_unknown');
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(false);
    expect(canAnchor(decision)).toBe(false);
  });

  it('admits a record inside a published division extent, and says that is what did it', () => {
    /*
     * The distinction the whole file turns on, as an assertion. A *published
     * division's* extent is a source's own statement about where a named thing
     * is. A reach circle is a statement about a traveller. The first may admit;
     * the second may not, and no longer can, because no radius is an input.
     */
    const inside = metropolitanCases().find((entry) => entry.record.sourceId === 'fallback-inside')!;
    const decision = decideContainment(subjectOf(inside.record), context);
    expect(decision.relationship).toBe('inside_selected_division');
    expect(decision.basis).toBe('selected_division_geometry');
    expect(decision.confidence).toBe('high');
  });

  it('never refuses a record on distance alone', () => {
    const decision = decideContainment(
      {
        id: 'places:remote',
        coordinates: northOf(METRO_CENTRE, 4000),
        containment: { divisionIds: [] },
        planningRole: 'attraction',
        name: 'Very Remote Nothing',
      },
      context,
    );
    expect(decision.relationship).toBe('membership_unknown');
    expect(decision.relationship).not.toBe('outside_scope');
  });
});

describe('typed geographic names', () => {
  it('routes an ISO 3166-2 code to the region code and a name to the region names', () => {
    expect(isSubdivisionCode('AA-SR')).toBe(true);
    expect(isSubdivisionCode('US-NY')).toBe(true);
    expect(isSubdivisionCode('GB-ENG')).toBe(true);
    expect(isSubdivisionCode('AA')).toBe(false);
    expect(isSubdivisionCode('Alto-Adige')).toBe(false);

    expect(typedEvidenceFrom({ regionName: 'IS-8' }).regionCode).toBe('IS-8');
    expect(typedEvidenceFrom({ regionName: 'IS-8' }).regionNames).toHaveLength(0);
    expect(typedEvidenceFrom({ regionName: 'Suðurland' }).regionNames).toEqual(['Suðurland']);
    expect(typedEvidenceFrom({ regionName: 'Suðurland' }).regionCode).toBeUndefined();
  });

  it('never compares a code against a name, and never calls that a disagreement', () => {
    /*
     * The two vocabularies a live pack actually mixes, per record, depending on
     * whether the covering division survived the retention cap. Collapsing "we
     * cannot compare these" into "these disagree" reports a coverage gap as a
     * place-belongs-elsewhere verdict.
     */
    const byCode = typedEvidenceFrom({ regionName: 'IS-8' });
    const byName = typedEvidenceFrom({ regionName: 'Suðurland' });
    expect(compareAtLevel('region', byCode, byName)).toBe('not_comparable');
    expect(compareAtLevel('region', byName, byCode)).toBe('not_comparable');
  });

  it('does not let a country name satisfy a region or a locality comparison', () => {
    /*
     * CS-11 in one assertion. The destination's published hierarchy used to be
     * unioned wholesale into the region accept-set, and one of the two producers
     * emits country, state, county and city in one flat array — so the country's
     * name sat in the region accept-set and a record whose region *was* the
     * country's name "agreed at region".
     */
    const scopeEvidence = typedEvidenceFrom({ countryCode: 'AA', unleveledNames: ['Selected Country'] });
    const candidate = typedEvidenceFrom({ countryCode: 'AA', regionName: 'Selected Country' });
    expect(compareAtLevel('region', candidate, scopeEvidence)).toBe('not_comparable');
    expect(compareAtLevel('locality', candidate, scopeEvidence)).toBe('not_comparable');
    expect(compareAtLevel('country', candidate, scopeEvidence)).toBe('agree');
  });

  it('treats an alias only at the level of the entity it names', () => {
    const localScope = typedEvidenceFrom({ localityName: 'Selected City', aliases: ['Кыргызстан'] });
    const candidate = typedEvidenceFrom({ regionName: 'Кыргызстан' });
    expect(compareAtLevel('region', candidate, localScope, { aliasLevel: 'locality' })).toBe(
      'not_comparable',
    );
  });

  it('matches across script, case, diacritics and punctuation', () => {
    const left = typedEvidenceFrom({ localityName: 'Ríver-Town' });
    const right = typedEvidenceFrom({ localityName: 'river town' });
    expect(compareAtLevel('locality', left, right)).toBe('agree');
  });
});

describe('the division directory', () => {
  const directory = DivisionDirectory.from(metropolitanDivisions());

  it('indexes divisions by their own published identifier', () => {
    expect(directory.size).toBe(metropolitanDivisions().length);
    expect(directory.entry('div-inner-borough')?.name).toBe('Inner Borough');
    expect(directory.entry('div-inner-borough')?.chain).toContain('div-selected-city');
  });

  it('indexes them by name, which is what a candidate’s address actually carries', () => {
    expect(directory.named('inner borough').map((entry) => entry.id)).toEqual(['div-inner-borough']);
    expect(directory.named('Inner Borough', 'locality')).toHaveLength(1);
    expect(directory.named('Inner Borough', 'region')).toHaveLength(0);
  });

  it('finds the divisions whose published box contains a point', () => {
    const covering = directory.covering(METRO_CENTRE).map((entry) => entry.id);
    expect(covering).toContain('div-selected-city');
    expect(covering).toContain('div-selected-region');
  });

  it('is empty rather than wrong when the divisions layer was starved', () => {
    const empty = DivisionDirectory.from([]);
    expect(empty.size).toBe(0);
    expect(empty.named('Inner Borough')).toHaveLength(0);
    expect(empty.covering(METRO_CENTRE)).toHaveLength(0);
  });
});

describe('a starved divisions budget cannot promote anything', () => {
  /*
   * The reproduction recorded in the closure notes: the divisions layer resolves
   * the destination's administrative identity mid-build on a small share of the
   * extraction budget. Starve it and there is no directory, no selected
   * division, and no way to tell an adjacent first-level division from a
   * borough.
   *
   * The old `canAnchor` had an escape reading "unless the gap is ours", which
   * converted exactly this budget failure into a membership claim for every
   * record in the pack. What must survive the starvation is only what a record
   * says about *itself*: an address naming the destination is still an address
   * naming the destination.
   */
  const starved = contextFor(metropolitanScope(), []);
  const cases = metropolitanCases();
  const namesTheDestination = (entry: ContainmentCase) =>
    entry.record.containment.localityName === 'Selected City';

  it('keeps only what a record says about itself', () => {
    for (const entry of cases.filter(namesTheDestination)) {
      expect(decideContainment(subjectOf(entry.record), starved).relationship, entry.label).toBe(
        'inside_selected_division',
      );
    }
  });

  it('cannot place anything else, and says unknown rather than inside', () => {
    for (const entry of cases.filter((candidate) => !namesTheDestination(candidate))) {
      const decision = decideContainment(subjectOf(entry.record), starved);
      expect(decision.relationship, entry.label).not.toBe('inside_scope');
      expect(decision.relationship, entry.label).not.toBe('inside_selected_division');
      expect(decision.relationship, entry.label).not.toBe('inside_selected_region');
    }
  });

  it('loses the ability to exclude an adjacent division, and does not pretend otherwise', () => {
    /*
     * The honest cost of the starvation, asserted so it cannot be mistaken for a
     * regression. Without the divisions layer the adjacent-township record
     * publishes no region of its own, so nothing refutes it — and nothing
     * admits it either. It is unknown, which keeps it off the final board and
     * away from the planner.
     */
    const unrelated = cases.find((entry) => entry.record.sourceId === 'adjacent-division-retail')!;
    const decision = decideContainment(subjectOf(unrelated.record), starved);
    expect(decision.relationship).toBe('membership_unknown');
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(false);
  });

  it('lets nothing it could not place anchor', () => {
    for (const entry of cases.filter((candidate) => !namesTheDestination(candidate))) {
      expect(canAnchor(decideContainment(subjectOf(entry.record), starved)), entry.label).toBe(false);
    }
  });
});

describe('gateways', () => {
  const context = contextFor(metropolitanScope(), metropolitanDivisions());

  it('is admitted to the inventory and to no board slot', () => {
    const airport = metropolitanCases().find((entry) => entry.record.sourceId === 'metro-airport')!;
    const decision = decideContainment(subjectOf(airport.record), context);
    expect(decision.relationship).toBe('adjacent_gateway');
    expect(admitsToInventory(decision.relationship)).toBe(true);
    expect(decision.eligibility.provisionalBoardEligible).toBe(false);
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(true);
    expect(canAnchor(decision)).toBe(false);
    expect(decision.gatewayReason).toBe('no_gateway_inside_scope');
  });

  it('is demoted when the destination has a way in of its own', () => {
    const records = [
      ...metropolitanCases().map((entry) => entry.record),
      metropolitanInternalGateway(),
    ];
    const result = partitionByContainment(records.map(subjectOf), context);
    const airport = result.admitted.find((entry) => entry.subject.name === 'Regional Airport');
    expect(airport?.decision.relationship).not.toBe('adjacent_gateway');
  });

  it('is not demoted when the traveller named it', () => {
    const named = contextFor(
      metropolitanScope({ gateways: [{ id: 'g1', name: 'Regional Airport', kind: 'airport', role: 'both', fixed: true }] }),
      metropolitanDivisions(),
    );
    const records = [
      ...metropolitanCases().map((entry) => entry.record),
      metropolitanInternalGateway(),
    ];
    const result = partitionByContainment(records.map(subjectOf), named);
    const airport = result.admitted.find((entry) => entry.subject.name === 'Regional Airport');
    expect(airport?.decision.relationship).toBe('adjacent_gateway');
    expect(airport?.decision.gatewayReason).toBe('traveller_named_gateway');
  });
});

describe('satellites and expansion members require an explicit inclusion', () => {
  it('produces neither when nothing asked for the area', () => {
    const noExpansion = contextFor(corridorTownScope(), corridorDivisions());
    for (const entry of corridorCases()) {
      const decision = decideContainment(subjectOf(entry.record), noExpansion);
      expect(decision.relationship, entry.label).not.toBe('optional_satellite');
      expect(decision.relationship, entry.label).not.toBe('regional_expansion_member');
    }
  });

  it('distinguishes an included area from an offered one', () => {
    const context = contextFor(corridorTownScope(), corridorDivisions(), corridorExpansionAreas());
    runInline(corridorCases(), context);
  });

  it('leaves an optional satellite off the final board and away from the planner', () => {
    const context = contextFor(corridorTownScope(), corridorDivisions(), corridorExpansionAreas());
    const satellite = corridorCases().find((entry) => entry.record.sourceId === 'corridor-basin')!;
    const decision = decideContainment(subjectOf(satellite.record), context);
    expect(decision.relationship).toBe('optional_satellite');
    expect(decision.eligibility.provisionalBoardEligible).toBe(true);
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(false);
  });

  it('admits a park’s gateway town only when the expansion asked for it', () => {
    const withoutExpansion = contextFor(protectedAreaScopeWithBoundary(), protectedAreaDivisions());
    const withExpansion = contextFor(
      protectedAreaScopeWithBoundary(),
      protectedAreaDivisions(),
      protectedAreaExpansionAreas(),
    );
    const museum = protectedAreaCases().find((entry) => entry.record.sourceId === 'approach-museum')!;
    expect(decideContainment(subjectOf(museum.record), withoutExpansion).relationship).toBe(
      'membership_unknown',
    );
    expect(decideContainment(subjectOf(museum.record), withExpansion).relationship).toBe(
      'regional_expansion_member',
    );
  });
});

function runInline(cases: ContainmentCase[], context: ScopeContainmentContext): void {
  for (const entry of cases) {
    expect(
      decideContainment(subjectOf(entry.record), context).relationship,
      `${entry.label}: ${entry.because}`,
    ).toBe(entry.expected);
  }
}

describe('an island', () => {
  runCases(islandCases(), contextFor(islandScope(), islandDivisions()));
});

describe('a protected area with a published boundary', () => {
  runCases(protectedAreaCases(), contextFor(protectedAreaScopeWithBoundary(), protectedAreaDivisions()));
});

describe('a broad country', () => {
  runCases(countryCases(), contextFor(countryScope(), countryDivisions()));
});

describe('a destination whose catalogue is mostly transport and services', () => {
  runCases(utilityCases(), contextFor(utilityHeavyScope(), utilityDivisions()));

  it('says nothing about whether any of them may be an attraction', () => {
    /*
     * Containment answers *where*. Role answers *what for*. An airport inside
     * the destination is `inside_scope`, and that must never be readable as
     * permission to occupy a slot a traveller chooses between — the eligibility
     * a decision carries is the conjunction, and the role factor is supplied
     * from outside this file.
     */
    const context = contextFor(utilityHeavyScope(), utilityDivisions());
    const airport = utilityCases().find((entry) => entry.record.sourceId === 'utility-airport')!;
    const asAttraction = decideContainment(subjectOf(airport.record), context, {
      roleEligible: false,
    });
    expect(asAttraction.relationship).toBe('inside_selected_division');
    expect(asAttraction.eligibility.roleEligible).toBe(false);
    expect(asAttraction.eligibility.provisionalBoardEligible).toBe(false);
    expect(asAttraction.eligibility.finalBoardEligible).toBe(false);
    expect(asAttraction.eligibility.plannerEligible).toBe(false);
  });
});

describe('the admission table', () => {
  it('covers every relationship exactly once', () => {
    expect(Object.keys(RELATIONSHIP_ADMISSION).sort()).toEqual([...SCOPE_RELATIONSHIPS].sort());
  });

  it('never grants a wider permission than the narrower one it depends on', () => {
    for (const relationship of SCOPE_RELATIONSHIPS) {
      const admission = RELATIONSHIP_ADMISSION[relationship];
      if (admission.finalBoardEligible) {
        expect(admission.provisionalBoardEligible, relationship).toBe(true);
      }
    }
  });

  it('lets an ineligible role veto every slot, for every relationship', () => {
    for (const relationship of SCOPE_RELATIONSHIPS) {
      const eligibility = eligibilityFor(relationship, false);
      expect(eligibility.provisionalBoardEligible, relationship).toBe(false);
      expect(eligibility.finalBoardEligible, relationship).toBe(false);
      expect(eligibility.plannerEligible, relationship).toBe(false);
    }
  });

  it('lets an eligible role reach exactly what the relationship permits', () => {
    for (const relationship of SCOPE_RELATIONSHIPS) {
      const eligibility = eligibilityFor(relationship, true);
      expect(eligibility.finalBoardEligible, relationship).toBe(
        RELATIONSHIP_ADMISSION[relationship].finalBoardEligible,
      );
    }
  });

  it('withholds membership_unknown from the final board and the planner', () => {
    const eligibility = eligibilityFor('membership_unknown', true);
    expect(eligibility.provisionalBoardEligible).toBe(true);
    expect(eligibility.finalBoardEligible).toBe(false);
    expect(eligibility.plannerEligible).toBe(false);
  });

  it('rejects outside_scope everywhere', () => {
    const eligibility = eligibilityFor('outside_scope', true);
    expect(eligibility.provisionalBoardEligible).toBe(false);
    expect(eligibility.finalBoardEligible).toBe(false);
    expect(eligibility.plannerEligible).toBe(false);
    expect(admitsToInventory('outside_scope')).toBe(false);
  });

  it('lets exactly the positive-inside relationships and expansion members anchor', () => {
    const anchorable = SCOPE_RELATIONSHIPS.filter((relationship) =>
      canAnchor({ relationship, eligibility: eligibilityFor(relationship, true) }),
    );
    expect([...anchorable].sort()).toEqual(
      [
        'inside_scope',
        'inside_selected_division',
        'inside_selected_region',
        'regional_expansion_member',
      ].sort(),
    );
  });
});

describe('the collection pass', () => {
  const context = contextFor(metropolitanScope(), metropolitanDivisions());

  it('is order-independent', () => {
    const records = metropolitanCases().map((entry) => entry.record).map(subjectOf);
    const forwards = partitionByContainment(records, context);
    const backwards = partitionByContainment([...records].reverse(), context);
    const key = (entry: { subject: { id?: string }; decision: { relationship: ScopeRelationship } }) =>
      `${entry.subject.id}:${entry.decision.relationship}`;
    expect(forwards.admitted.map(key).sort()).toEqual(backwards.admitted.map(key).sort());
    expect(forwards.removed.map(key).sort()).toEqual(backwards.removed.map(key).sort());
  });

  it('counts every relationship it produced and every basis it decided on', () => {
    const records = metropolitanCases().map((entry) => entry.record).map(subjectOf);
    const result = partitionByContainment(records, context);
    const total = result.diagnostics.byRelationship.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBe(records.length);
    expect(result.diagnostics.byBasis.reduce((sum, entry) => sum + entry.count, 0)).toBe(
      records.length,
    );
  });

  it('records what removed each exclusion, with its distance as a diagnostic', () => {
    const records = metropolitanCases().map((entry) => entry.record).map(subjectOf);
    const result = partitionByContainment(records, context);
    expect(result.removed.length).toBeGreaterThan(0);
    for (const entry of result.diagnostics.excluded) {
      expect(entry.relationship).toBe('outside_scope');
      expect(entry.basis).not.toBe('no_evidence');
      expect(entry.diagnosticDistanceKm).toBeGreaterThan(0);
    }
  });

  it('reports an unresolvable destination identity rather than hiding it', () => {
    const starved = contextFor(metropolitanScope(), []);
    const records = metropolitanCases().map((entry) => entry.record).map(subjectOf);
    /*
     * The scope still carries its own country code, so identity is not strictly
     * "unknown" — what is missing is the division chain. The diagnostic a
     * traveller-facing panel reads is `divisionsAvailable`, and it is zero.
     */
    const overlay = buildTripScopeOverlay({ scope: metropolitanScope(), records: [] });
    expect(overlay.integrity.divisionsAvailable).toBe(0);
    expect(partitionByContainment(records, starved).diagnostics.considered).toBe(records.length);
  });
});

describe('the pack keeps everything', () => {
  it('retains every record, because a pack is ground and a verdict is a traveller’s', () => {
    expect(retainsInPack()).toBe(true);
  });

  it('carries a decision on a record without mutating the original', () => {
    const record = metropolitanCases()[0]!.record;
    const context = contextFor(metropolitanScope(), metropolitanDivisions());
    const decision = decideContainment(subjectOf(record), context);
    const carried = withContainmentDecision(record, decision);
    expect(containmentDecisionOf(carried)).toEqual(decision);
    expect(containmentDecisionOf(record)).toBeUndefined();
  });
});

describe('the trip-scope overlay is the gate', () => {
  it('decides every record it is given', () => {
    const overlay = buildTripScopeOverlay({
      scope: metropolitanScope(),
      records: [...metropolitanDivisions(), ...metropolitanCases().map((entry) => entry.record)],
    });
    for (const entry of metropolitanCases()) {
      expect(overlay.decisions.get(entry.record.id)?.relationship, entry.label).toBe(entry.expected);
    }
  });

  it('fails closed for a record it never saw', () => {
    const overlay = buildTripScopeOverlay({ scope: metropolitanScope(), records: metropolitanDivisions() });
    const decision = decisionFor(overlay, 'places:never-registered');
    expect(decision.relationship).toBe('membership_unknown');
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(false);
  });

  it('fails closed when there is no overlay at all', () => {
    const decision = decisionFor(undefined, 'places:orphan');
    expect(decision.relationship).toBe('membership_unknown');
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(false);
  });

  it('counts what it did, so a board can say why it is thin', () => {
    const overlay = buildTripScopeOverlay({
      scope: metropolitanScope(),
      records: [...metropolitanDivisions(), ...metropolitanCases().map((entry) => entry.record)],
    });
    expect(overlay.integrity.considered).toBeGreaterThan(0);
    expect(overlay.integrity.outOfScope).toBeGreaterThan(0);
    expect(overlay.integrity.membershipUnknown).toBeGreaterThan(0);
    expect(overlay.integrity.gateways).toBeGreaterThan(0);
    expect(overlay.integrity.divisionsAvailable).toBe(metropolitanDivisions().length);
    expect(overlay.contractVersion).toBe(1);
  });

  it('decides a late-arriving regional-expansion base through the same gate', () => {
    const overlay = buildTripScopeOverlay({
      scope: corridorTownScope(),
      records: corridorDivisions(),
      includedAreas: corridorExpansionAreas(),
    });
    const base = corridorExpansionBase();
    /* Before the gate sees it, it has no eligibility at all. */
    expect(decisionFor(overlay, base.id).eligibility.plannerEligible).toBe(false);
    const decision = admitLateCandidate(overlay, { ...subjectOf(base), id: base.id });
    expect(decision.relationship).toBe('regional_expansion_member');
    expect(decisionFor(overlay, base.id).relationship).toBe('regional_expansion_member');
    expect(overlay.integrity.expansionMembers).toBeGreaterThan(0);
  });
});


describe('the three ways a coordinate could still have decided something', () => {
  /**
   * Each of these was found by an adversarial review of the corrected layer,
   * and each is the same mistake in a different disguise: a rule that reads
   * correct in isolation and lets a *position* settle a question about
   * *belonging* once you look at what the rest of the system feeds it.
   */

  it('does not let an included area’s radius overrule a published refusal', () => {
    /*
     * The reachable one. `compile.ts` turns every expansion base into an
     * included area centred on its own coordinates with no radius, so the 25 km
     * default applies — and when the model proposes no base, the fallback base
     * *is* the destination centre. So there was a 25 km disc around every
     * destination inside which a record the sources place in another country
     * became a plannable, anchorable member.
     */
    const areaAtCentre: IncludedArea[] = [
      { id: 'area-base', name: 'The Base', reason: 'expansion_base', status: 'included', center: METRO_CENTRE },
    ];
    const context = contextFor(metropolitanScope(), metropolitanDivisions(), areaAtCentre);
    const foreign = {
      id: 'places:foreign-near-base',
      coordinates: northOf(METRO_CENTRE, 20),
      containment: { countryCode: 'ZZ', localityName: 'Far Town', divisionIds: [] },
      planningRole: 'attraction' as const,
      name: 'Foreign Museum',
    };
    const decision = decideContainment(foreign, context);
    expect(decision.relationship).toBe('outside_scope');
    expect(decision.eligibility.finalBoardEligible).toBe(false);
    expect(decision.eligibility.plannerEligible).toBe(false);
  });

  it('still admits a record the expansion asked for **by name**, even across a border', () => {
    /*
     * The other half, and the reason the fix is a narrowing rather than a
     * removal: an island's mainland approach town is in another region and is
     * legitimately part of the trip, because something typed says so.
     */
    const named: IncludedArea[] = [
      { id: 'area-port', name: 'Port Town', reason: 'regional_expansion_requested', status: 'included' },
    ];
    const context = contextFor(islandScope(), islandDivisions(), named);
    const restaurant = islandCases().find((entry) => entry.record.sourceId === 'mainland-restaurant')!;
    const decision = decideContainment(subjectOf(restaurant.record), context);
    expect(decision.relationship).toBe('regional_expansion_member');
    expect(decision.servesAreaId).toBe('area-port');
  });

  it('gives the same verdict whichever homonym the directory indexed first', () => {
    /*
     * Two localities named `Riverside`, one in the selected region and one in
     * the adjacent one. An earlier version merged *whichever sorted first* into
     * the evidence set allowed to refuse, so a record twelve kilometres inside
     * the destination was deleted or admitted depending on scan order — and scan
     * order changes with the retention budget, which is the "two builds of one
     * destination produce different boards" failure typed evidence exists to end.
     */
    const homonyms = (order: 'selected-first' | 'adjacent-first'): SourceRecord[] => {
      const selected = fixtureDivision({
        id: 'div-riverside-selected',
        name: 'Riverside',
        subtype: 'locality',
        centre: northOf(METRO_CENTRE, 12),
        radiusKm: 2,
        chain: ['div-selected-country', 'div-selected-region', 'div-selected-city', 'div-riverside-selected'],
        countryCode: 'AA',
        regionName: 'AA-SR',
      });
      const adjacent = fixtureDivision({
        id: 'div-riverside-adjacent',
        name: 'Riverside',
        subtype: 'locality',
        centre: northOf(METRO_CENTRE, 220),
        radiusKm: 2,
        chain: ['div-selected-country', 'div-adjacent-region', 'div-riverside-adjacent'],
        countryCode: 'AA',
        regionName: 'AA-AR',
      });
      const pair = order === 'selected-first' ? [selected, adjacent] : [adjacent, selected];
      return [...metropolitanDivisions(), ...pair];
    };

    const museum = fixtureRecord({
      id: 'riverside-museum',
      name: 'Riverside Museum',
      coordinates: northOf(METRO_CENTRE, 12),
      containment: { countryCode: 'AA', localityName: 'Riverside' },
    });

    const first = decideContainment(
      subjectOf(museum),
      contextFor(metropolitanScope(), homonyms('selected-first')),
    );
    const second = decideContainment(
      subjectOf(museum),
      contextFor(metropolitanScope(), homonyms('adjacent-first')),
    );
    expect(second.relationship).toBe(first.relationship);
    expect(second.basis).toBe(first.basis);
    /* And neither is a refusal, because the two readings do not agree. */
    expect(first.relationship).not.toBe('outside_scope');
  });

  it('does not identify the destination with a same-named division somewhere else', () => {
    /*
     * The one that corrupts every candidate at once. The destination's own
     * division is frequently *not* retained — the layer is capped at a few
     * hundred records for a whole country — and a pure name lookup over the pack
     * would then pick a homonym on another continent. Records around it become
     * high-confidence members; records genuinely in the destination lose their
     * only positive rung.
     */
    const withoutOwnDivision = metropolitanDivisions().filter(
      (record) => record.sourceId !== 'div-selected-city',
    );
    const foreignHomonym = fixtureDivision({
      id: 'div-selected-city-elsewhere',
      name: 'Selected City',
      subtype: 'locality',
      centre: { lat: -40, lng: 150 },
      radiusKm: 5,
      chain: ['div-other-country', 'div-selected-city-elsewhere'],
      countryCode: 'ZZ',
      regionName: 'ZZ-1',
    });
    const context = contextFor(metropolitanScope(), [...withoutOwnDivision, foreignHomonym]);
    expect(context.selectedDivisionIds).not.toContain('div-selected-city-elsewhere');

    const distant = {
      id: 'places:distant-homonym-museum',
      coordinates: { lat: -40, lng: 150 },
      containment: { countryCode: 'ZZ', localityName: 'Selected City', divisionIds: [] },
      planningRole: 'attraction' as const,
      name: 'Antipodean Museum',
    };
    expect(decideContainment(distant, context).relationship).toBe('outside_scope');
  });

  it('reports an unusable destination identity rather than counting its own name as one', () => {
    /*
     * `scopeIdentityKnown` used to be `hasGeographicEvidence`, and the scope
     * always writes its own name into a level — so it could not return false on
     * any build ever made, and the one signal distinguishing a starved build
     * from a good one reported nothing.
     */
    const nameless = metropolitanScope({ countryCode: undefined });
    const context = contextFor(nameless, []);
    expect(context.evidence.localityNames).toContain('Selected City');
    expect(scopeIdentityKnown(context)).toBe(false);

    const identified = contextFor(metropolitanScope(), metropolitanDivisions());
    expect(scopeIdentityKnown(identified)).toBe(true);
  });
});
