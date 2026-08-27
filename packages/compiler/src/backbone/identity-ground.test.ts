import { describe, expect, it } from 'vitest';
import type { CompiledRegion, SourceRecord } from '@sidequest/core';
import { compileRegion } from '../compile';
import { deriveScope } from '../scope';
import { buildInventory } from './inventory';
import { syntheticCandidate, SYNTHETIC_WORLDS, type SyntheticWorldSpec } from '../testing/fakes';
import { packBackedProviders, syntheticPack } from '../testing/pack-fakes';

/**
 * A FAMOUS KIND OF THING, STANDING SOMEWHERE IT CANNOT BE.
 *
 * ---
 *
 * **The live evidence class.** Three delivered boards carried records whose
 * category asserts regional ground and whose coordinates are a city address:
 * a mountain gondola tagged as a ski resort, geocoded a hundred and fifty
 * kilometres from its own ground inside a dense central ward; a national park
 * eight hundred kilometres away in a suburban ward; a cave nine hundred; a
 * castle in a country that has none. Every one carried source confidence in
 * the high thirties and a description reading, in full, that nothing beyond
 * its name and position is published about it. Auto-pick made one of them the
 * sole activity of a day, and the readiness verdict for that trip depended on
 * it.
 *
 * **Why this file drives the whole compile.** The last wave's lesson is that
 * an invariant is worthless when the production branch bypasses it. These tests
 * therefore run `compileRegion` over a pack-backed provider set — the real
 * pack build, the real containment overlay, the real eligibility and witness
 * gates, the real inventory, the real shortlist — and assert on the *artifact's
 * own places*, which is what the board renders and the planner anchors days on.
 * A gate that only a unit test can see would not have caught the defect it is
 * being written for.
 *
 * **Fixture names are invented.** Nothing here names a real destination or a
 * real place; the world is a synthetic metropolis in the Atlantic and the
 * impostor's name is made up. The fixture-quarantine test enforces that, and
 * the point of the class is that it is destination-independent anyway.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

/**
 * The impostor, in the shape the catalogue really publishes one.
 *
 * A category that claims regional ground, a point in the middle of a dense
 * city, no outline of its own, no identifier, no site, no second catalogue —
 * and a perfectly ordinary address, because the row is not malformed. That is
 * the whole difficulty: nothing about it is broken except that the three
 * fields disagree with one another.
 */
function impostor(
  spec: SyntheticWorldSpec,
  overrides: Partial<SourceRecord> = {},
): SourceRecord {
  return {
    id: 'places:vaskerly-ridge-park',
    layerId: 'places',
    sourceId: 'vaskerly-ridge-park',
    name: 'Vaskerly Ridge National Park',
    alternateNames: [],
    coordinates: { lat: spec.center.lat + 0.001, lng: spec.center.lng + 0.001 },
    sourceCategory: 'national_park',
    sourceCategoryPath: [],
    planningRole: 'attraction',
    operatingStatus: 'open',
    websiteCandidates: [],
    containment: {
      countryCode: spec.countryCode,
      localityName: spec.name,
      divisionIds: [`div-${spec.id}`],
    },
    attributes: {},
    sources: [
      {
        dataset: 'primary-catalogue',
        licenceId: 'CDLA-Permissive-2.0',
        recordId: 'vaskerly-1',
        existenceConfidence: 0.38,
      },
    ],
    cellId: 'g-0-0',
    ...overrides,
  };
}

/** A ground claim the record itself backs with an outline: 2.2 km across. */
function withOwnGround(spec: SyntheticWorldSpec): SourceRecord {
  const record = impostor(spec);
  return {
    ...record,
    bounds: {
      southWest: { lat: record.coordinates.lat - 0.01, lng: record.coordinates.lng - 0.01 },
      northEast: { lat: record.coordinates.lat + 0.01, lng: record.coordinates.lng + 0.01 },
    },
  };
}

function worldWith(records: readonly SourceRecord[]): SyntheticWorldSpec {
  return {
    ...SYNTHETIC_WORLDS.transit_metro!,
    id: 'identity-ground-metro',
    extraPlaceRecords: records,
  };
}

function scopeOf(spec: SyntheticWorldSpec) {
  return deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    nights: DATES.length,
    revision: 1,
  });
}

async function compile(spec: SyntheticWorldSpec): Promise<CompiledRegion> {
  const result = await compileRegion({
    compilationId: `identity-${spec.id}`,
    scope: scopeOf(spec),
    dates: [...DATES],
    months: [8],
    providers: packBackedProviders(spec),
    now: NOW,
  });
  if (!result.ok) throw new Error(`${spec.id} did not compile: ${result.code} — ${result.message}`);
  return result.region;
}

function inventoryOf(spec: SyntheticWorldSpec) {
  const scope = scopeOf(spec);
  return buildInventory({ pack: syntheticPack(spec, scope), scope });
}

describe('a record whose kind claims ground it cannot be standing on', () => {
  it('never reaches the compiled artifact a board and a planner read', async () => {
    const spec = worldWith([impostor(SYNTHETIC_WORLDS.transit_metro!)]);
    const region = await compile(spec);

    /*
     * By identity rather than by count. A count would still pass if the gate
     * refused something else instead, which is the failure mode a refusal gate
     * has.
     */
    const names = region.places.map((place) => place.name);
    expect(names).not.toContain('Vaskerly Ridge National Park');
    /* And the artifact is not empty, so the assertion above means something. */
    expect(region.places.length).toBeGreaterThan(3);
  });

  it('books the refusal under its own reason, so a thin board can explain itself', () => {
    const portfolio = inventoryOf(worldWith([impostor(SYNTHETIC_WORLDS.transit_metro!)])).portfolio;
    const entry = portfolio.rejected.find(
      (rejection) => rejection.reason === 'identity_conflicts_with_ground',
    );
    expect(entry?.count).toBe(1);
    expect(entry?.examples).toContain('Vaskerly Ridge National Park');
  });

  it('refuses on the disagreement, not on the category — the same kind with ground is kept', async () => {
    /*
     * The control that makes the gate a gate rather than a ban. Identical
     * record, identical category, identical absence of a website or an
     * identifier — plus the one thing the claim needs: an outline of its own.
     */
    const region = await compile(worldWith([withOwnGround(SYNTHETIC_WORLDS.transit_metro!)]));
    expect(region.places.map((place) => place.name)).toContain('Vaskerly Ridge National Park');
  });

  it('refuses the mountain-resort shape too — the record that held a whole day', async () => {
    /*
     * The flagship live case, in its own kind. A resort *is* the mountain: the
     * word names a whole ski area, which is why the taxonomy now files it as a
     * landscape claim beside a range, and why a point wearing it inside a
     * central ward with nothing behind it is refused by the same plausibility
     * rule. Asserted separately from the park above because the two travel
     * through different gates to the same refusal, and a single fixture would
     * not have shown that.
     */
    const gondola = impostor(SYNTHETIC_WORLDS.transit_metro!, {
      id: 'places:vaskerly-ridge-gondola',
      sourceId: 'vaskerly-ridge-gondola',
      name: 'Vaskerly Ridge Gondola',
      sourceCategory: 'ski_resort',
    });
    const region = await compile(worldWith([gondola]));
    expect(region.places.map((place) => place.name)).not.toContain('Vaskerly Ridge Gondola');
  });

  it('leaves every other record of the world untouched', () => {
    const clean = inventoryOf(worldWith([]));
    const contaminated = inventoryOf(worldWith([impostor(SYNTHETIC_WORLDS.transit_metro!)]));
    /*
     * Stated as set equality on what survived, because a refusal gate that
     * quietly costs a neighbour is the regression this whole pass exists to
     * avoid trading for.
     */
    expect(contaminated.candidates.map((candidate) => candidate.place.name).sort()).toEqual(
      clean.candidates.map((candidate) => candidate.place.name).sort(),
    );
  });
});

describe('the same claim, with something independent vouching for it', () => {
  /**
   * A record can carry a thin catalogue row and still be real — a designated
   * area mapped as a point, a famous site whose row nobody filled in. What
   * separates it from the impostor is that somebody *else* says it exists.
   * The honest answer to that is not deletion; it is that it may be offered and
   * may not be the reason a morning exists.
   */
  const vouched = (spec: SyntheticWorldSpec): SourceRecord =>
    impostor(spec, { wikidataId: 'Q9100001' });

  it('keeps it on the board rather than deleting it', () => {
    const inventory = inventoryOf(worldWith([vouched(SYNTHETIC_WORLDS.transit_metro!)]));
    const kept = [...inventory.candidates, ...inventory.supporting].map(
      (candidate) => candidate.place.name,
    );
    expect(kept).toContain('Vaskerly Ridge National Park');
    expect(
      inventory.portfolio.rejected.some(
        (rejection) => rejection.reason === 'identity_conflicts_with_ground',
      ),
    ).toBe(false);
  });

  it('withholds the anchor slot, so it cannot be the reason a day exists', () => {
    const clean = inventoryOf(worldWith([])).portfolio.anchorDemotions;
    const contaminated = inventoryOf(
      worldWith([vouched(SYNTHETIC_WORLDS.transit_metro!)]),
    ).portfolio.anchorDemotions;
    /*
     * One more demotion than the same world without it. Compared rather than
     * asserted absolutely, because the demotion counter also serves the
     * unplaceable-attraction path and a bare number would not say which.
     */
    expect(contaminated).toBe(clean + 1);
  });
});
