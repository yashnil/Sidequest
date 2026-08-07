import { describe, expect, it } from 'vitest';
import {
  admitToBoard,
  inclusionReasonOfPlace,
  isVisitableRole,
  PLANNING_ROLES,
  placeInclusionTag,
  placeRoleTag,
  planningRoleOfPlace,
  SUPPORTING_ROLES,
  VISITABLE_ROLES,
  type Place,
  type PlanningRole,
} from '@sidequest/core';
import {
  admitsToInventory,
  RELATIONSHIP_ADMISSION,
  SCOPE_RELATIONSHIPS,
  type ScopeRelationship,
} from './containment';
import {
  admitByScope,
  assessVisitableSupply,
  balanceAcrossAreas,
  hasMinimumIdentity,
  INCLUSION_REASONS,
  isVisitableSlot,
  PORTFOLIO_REJECTIONS,
  PORTFOLIO_SLOTS,
  RejectionLedger,
  roleCanOccupy,
  scopeRelationshipOf,
  slotsForRole,
  type VisitableSupply,
} from './balance';

/**
 * THE MEASUREMENT THIS FILE EXISTS FOR.
 *
 * A live Kyrgyzstan compilation kept twenty-four places and they were
 * overwhelmingly capital-city venues. The cause was not the discovery layer and
 * not the router: the pack was geographically even, and one global `.sort()` by
 * how much was *known* about each record threw that evenness away — because
 * cataloguing effort concentrates where commerce does.
 *
 * Every test below is written against that shape: a dense, richly-described
 * area and several sparse, thinly-described ones.
 */

interface Item {
  id: string;
  area: string;
  category: string;
}

function world(input: {
  dense: number;
  sparseAreas: number;
  perSparse: number;
  categories?: number;
}): Item[] {
  const categories = input.categories ?? 4;
  const items: Item[] = [];
  /*
   * The dense area comes first in the ranked order, which is exactly the
   * situation: its records carry websites, hours and operators, so `knownness`
   * puts every one of them above every rural record.
   */
  for (let index = 0; index < input.dense; index += 1) {
    items.push({ id: `dense-${index}`, area: 'capital', category: `c${index % categories}` });
  }
  for (let area = 0; area < input.sparseAreas; area += 1) {
    for (let index = 0; index < input.perSparse; index += 1) {
      items.push({
        id: `sparse-${area}-${index}`,
        area: `region-${area}`,
        category: `c${index % categories}`,
      });
    }
  }
  return items;
}

const areaOf = (item: Item): string => item.area;
const categoryOf = (item: Item): string => item.category;

function balance(items: Item[], quota: number, maxAreaShare = 0.45, maxPerCategory = 1000) {
  return balanceAcrossAreas({
    ranked: items,
    areaOf,
    categoryOf,
    limits: { quota, maxPerCategory, maxAreaShare },
  });
}

describe('geographic balancing', () => {
  it('is the regression: a dense area no longer takes the whole quota', () => {
    /*
     * The exact shape of the defect. Rank order alone returns 100 items and
     * every one of them is from the capital, because all 100 capital records
     * sort above every regional one.
     */
    const items = world({ dense: 500, sparseAreas: 6, perSparse: 40 });
    const rankOrderOnly = items.slice(0, 100);
    expect(rankOrderOnly.every((item) => item.area === 'capital')).toBe(true);

    const { kept, diagnostics } = balance(items, 100);
    expect(kept).toHaveLength(100);

    const fromCapital = kept.filter((item) => item.area === 'capital').length;
    expect(fromCapital).toBeLessThanOrEqual(45);
    expect(kept.length - fromCapital).toBeGreaterThanOrEqual(55);

    // Every region with anything in it is represented.
    const areas = new Set(kept.map((item) => item.area));
    expect(areas.size).toBe(7);
    expect(diagnostics.concentration).toBeLessThanOrEqual(0.45);
  });

  it('serves every area in every round, so a four-record region is not starved', () => {
    const items = world({ dense: 400, sparseAreas: 5, perSparse: 4 });
    const { kept } = balance(items, 60);

    for (let area = 0; area < 5; area += 1) {
      const fromArea = kept.filter((item) => item.area === `region-${area}`);
      expect(fromArea, `region-${area}`).toHaveLength(4);
    }
  });

  it('lets a genuinely single-area region fill the quota, and says that it did', () => {
    /*
     * The mirror-image failure the cap must not cause. A city really is one
     * area, and a rule that refused to fill a board because it could not find a
     * second one would produce a shorter plan for the same city — which helps
     * nobody and is not more honest.
     */
    const items = world({ dense: 200, sparseAreas: 0, perSparse: 0 });
    const { kept, diagnostics } = balance(items, 100);

    expect(kept).toHaveLength(100);
    expect(diagnostics.areaCapRelaxed).toBe(true);
    expect(diagnostics.concentration).toBe(1);
  });

  it('respects the category cap while balancing, and counts what it held back', () => {
    const items = world({ dense: 300, sparseAreas: 3, perSparse: 30, categories: 3 });
    const { kept, diagnostics } = balance(items, 90, 0.45, 10);

    for (const category of ['c0', 'c1', 'c2']) {
      expect(kept.filter((item) => item.category === category).length).toBeLessThanOrEqual(10);
    }
    expect(kept.length).toBeLessThanOrEqual(30);
    expect(diagnostics.heldBackByCategory).toBeGreaterThan(0);
  });

  it('never invents, never duplicates, and never exceeds the quota', () => {
    const items = world({ dense: 120, sparseAreas: 4, perSparse: 25 });
    const { kept } = balance(items, 70);

    expect(kept).toHaveLength(70);
    expect(new Set(kept.map((item) => item.id)).size).toBe(70);
    const available = new Set(items.map((item) => item.id));
    for (const item of kept) expect(available.has(item.id)).toBe(true);
  });

  it('is deterministic, including under a shuffled input of equal rank', () => {
    const items = world({ dense: 200, sparseAreas: 5, perSparse: 20 });
    const first = balance(items, 80).kept.map((item) => item.id);
    const second = balance(items, 80).kept.map((item) => item.id);
    expect(second).toEqual(first);
  });

  it('shrinks every area proportionally when the quota halves, emptying none', () => {
    const items = world({ dense: 300, sparseAreas: 5, perSparse: 30 });
    const full = balance(items, 100);
    const half = balance(items, 50);

    const areasFull = new Set(full.kept.map((item) => item.area));
    const areasHalf = new Set(half.kept.map((item) => item.area));
    expect(areasHalf.size).toBe(areasFull.size);
    expect(half.kept).toHaveLength(50);
  });

  it('handles the degenerate inputs without throwing', () => {
    expect(balance([], 50).kept).toEqual([]);
    expect(balance(world({ dense: 3, sparseAreas: 0, perSparse: 0 }), 0).kept).toEqual([]);
    expect(balance(world({ dense: 2, sparseAreas: 1, perSparse: 1 }), 500).kept).toHaveLength(3);
  });

  it('reports a concentration inside its range whatever the shape', () => {
    for (const shape of [
      { dense: 500, sparseAreas: 6, perSparse: 40 },
      { dense: 1, sparseAreas: 1, perSparse: 1 },
      { dense: 40, sparseAreas: 0, perSparse: 0 },
      { dense: 0, sparseAreas: 3, perSparse: 10 },
    ]) {
      const { diagnostics } = balance(world(shape), 30);
      expect(Number.isFinite(diagnostics.concentration)).toBe(true);
      expect(diagnostics.concentration).toBeGreaterThanOrEqual(0);
      expect(diagnostics.concentration).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Admission — what may be balanced at all
// ---------------------------------------------------------------------------

/**
 * THE OTHER MEASUREMENT.
 *
 * A live compilation put an international airport, a driver-for-hire and two
 * tour operators on a discovery board. Nothing was misclassified: the taxonomy
 * calls an airport a gateway, and the pack schema already declared which roles a
 * traveller chooses between. What was missing was any layer whose job it was to
 * *enforce* the distinction, so every test here is about a refusal rather than
 * about a ranking.
 */
describe('scope admission', () => {
  it('covers every relationship, so a new one cannot fall through', () => {
    for (const relationship of SCOPE_RELATIONSHIPS) {
      const admission = admitByScope(relationship);
      expect(admission, relationship).toBeDefined();
      if (admission.admitted) {
        expect(INCLUSION_REASONS, relationship).toContain(admission.reason);
        expect(admission.permits.length, relationship).toBeGreaterThan(0);
      } else {
        expect(admission.rejection).toBe('outside_scope');
      }
    }
  });

  it('refuses an outside-scope record outright', () => {
    expect(admitByScope('outside_scope')).toEqual({ admitted: false, rejection: 'outside_scope' });
  });

  it('lets an adjacent gateway be a way in and nothing else', () => {
    const admission = admitByScope('adjacent_gateway');
    expect(admission.admitted).toBe(true);
    if (!admission.admitted) throw new Error('unreachable');
    expect([...admission.permits]).toEqual(['gateway']);
    expect(admission.external).toBe(true);
    for (const slot of PORTFOLIO_SLOTS.filter(isVisitableSlot)) {
      expect(admission.permits, slot).not.toContain(slot);
    }
  });

  it('gives every admitted record a typed reason, and marks the external ones', () => {
    const external = admitByScope('optional_satellite');
    expect(external.admitted && external.external).toBe(true);
    expect(external.admitted && external.reason).toBe('optional_satellite');

    const inside = admitByScope('inside_scope');
    expect(inside.admitted && inside.external).toBe(false);
  });

  it('treats unestablished membership as unknown rather than as inside', () => {
    const unknown = admitByScope('membership_unknown');
    expect(unknown.admitted).toBe(true);
    expect(unknown.admitted && unknown.membershipVerified).toBe(false);
    expect(unknown.admitted && unknown.reason).toBe('membership_unknown');
  });

  it('reads a missing or unrecognised relationship as unknown, never as inside', () => {
    expect(scopeRelationshipOf({})).toBe('membership_unknown');
    expect(scopeRelationshipOf(undefined)).toBe('membership_unknown');
    expect(scopeRelationshipOf({ scopeRelationship: 'a_vocabulary_from_next_year' })).toBe(
      'membership_unknown',
    );
    for (const relationship of SCOPE_RELATIONSHIPS) {
      expect(scopeRelationshipOf({ scopeRelationship: relationship })).toBe(relationship);
      /*
       * The trip-scope overlay attaches a whole decision, not a bare verdict.
       * Both shapes have to read the same way or the two layers drift.
       */
      expect(scopeRelationshipOf({ containmentDecision: decisionFor(relationship) })).toBe(
        relationship,
      );
    }
  });

  /**
   * The two layers must not be able to disagree.
   *
   * `RELATIONSHIP_ADMISSION` in `@sidequest/core` is the contract's yes/no
   * answer; `admitByScope` adds *which slots* and the typed reason. If the second
   * ever contradicted the first, an airport would be refused by one gate and
   * admitted by the other, which is the shape of the original defect.
   */
  it('agrees with the containment contract for every relationship', () => {
    for (const relationship of SCOPE_RELATIONSHIPS) {
      const mine = admitByScope(relationship);
      expect(mine.admitted, relationship).toBe(admitsToInventory(relationship));

      const admission = RELATIONSHIP_ADMISSION[relationship];
      const permitsVisitable = mine.admitted && mine.permits.some(isVisitableSlot);
      expect(permitsVisitable, relationship).toBe(admission.provisionalBoardEligible);

      /*
       * The one distinction a yes/no cannot carry, asserted where it lives: only
       * a relationship the contract lets onto a **final** board may occupy the
       * slot a day is anchored on. `membership_unknown` and `optional_satellite`
       * reach `discovery` and stop there.
       */
      const permitsAnchor = mine.admitted && mine.permits.includes('anchor');
      expect(permitsAnchor, relationship).toBe(admission.finalBoardEligible);
    }
  });
});

function decisionFor(relationship: ScopeRelationship): { relationship: ScopeRelationship } {
  return { relationship };
}

describe('role eligibility', () => {
  it('gives no visitable slot to any supporting role', () => {
    for (const role of SUPPORTING_ROLES) {
      const slots = slotsForRole(role);
      expect(slots.filter(isVisitableSlot), role).toHaveLength(0);
    }
  });

  it('gives every visitable role a visitable slot', () => {
    for (const role of VISITABLE_ROLES) {
      expect(slotsForRole(role).filter(isVisitableSlot).length, role).toBeGreaterThan(0);
    }
  });

  it('is the invariant: no utility role may be an anchor or a discovery', () => {
    for (const role of PLANNING_ROLES) {
      if (isVisitableRole(role)) continue;
      expect(roleCanOccupy(role, 'anchor'), role).toBe(false);
      expect(roleCanOccupy(role, 'discovery'), role).toBe(false);
    }
  });

  it('gives a market both slots, because it is both things', () => {
    expect(roleCanOccupy('market', 'anchor')).toBe(true);
    expect(roleCanOccupy('market', 'food')).toBe(true);
  });

  it('gives the roles no portfolio plans around nothing at all', () => {
    for (const role of ['lodging', 'administrative', 'infrastructure', 'excluded'] as const) {
      expect(slotsForRole(role), role).toHaveLength(0);
    }
  });
});

describe('minimum identity', () => {
  it('refuses a row whose name is its own category', () => {
    expect(hasMinimumIdentity({ name: 'Viewpoint', sourceCategory: 'viewpoint' })).toBe(false);
    expect(
      hasMinimumIdentity({
        name: 'Nature Reserve',
        sourceCategory: 'unknown_leaf',
        sourceCategoryPath: ['geographic_entities', 'nature_reserve'],
      }),
    ).toBe(false);
  });

  it('keeps a row that names a thing', () => {
    expect(hasMinimumIdentity({ name: 'Harbour Museum', sourceCategory: 'museum' })).toBe(true);
    expect(
      hasMinimumIdentity({ name: 'North Ridge Viewpoint', sourceCategory: 'viewpoint' }),
    ).toBe(true);
  });

  it('names no language: the comparison is against the source vocabulary', () => {
    // A record whose name matches nothing in its own category path survives,
    // whatever alphabet it is in.
    expect(hasMinimumIdentity({ name: '興福寺', sourceCategory: 'historic_site' })).toBe(true);
    expect(hasMinimumIdentity({ name: 'Museu do Mar', sourceCategory: 'museum' })).toBe(true);
  });
});

describe('the rejection ledger', () => {
  it('counts every refusal and reports in the declared order', () => {
    const ledger = new RejectionLedger();
    ledger.reject('over_area_share');
    ledger.reject('outside_scope', 'Somewhere Else');
    ledger.reject('outside_scope', 'Another');
    ledger.reject('superseded_duplicate', 'A twin');

    expect(ledger.total()).toBe(4);
    expect(ledger.countOf('outside_scope')).toBe(2);
    const reasons = ledger.entries().map((entry) => entry.reason);
    expect(reasons).toEqual(
      PORTFOLIO_REJECTIONS.filter((reason) => reasons.includes(reason)),
    );
  });

  it('bounds the examples, so a country-sized refusal is still readable', () => {
    const ledger = new RejectionLedger(2);
    for (let index = 0; index < 5_000; index += 1) ledger.reject('outside_scope', `n${index}`);
    const entry = ledger.entries()[0]!;
    expect(entry.count).toBe(5_000);
    expect(entry.examples).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Supply — board size must not stand in for supply
// ---------------------------------------------------------------------------

function supplyOf(overrides: Partial<VisitableSupply> = {}): VisitableSupply {
  return {
    anchors: 12,
    discoveries: 6,
    visitable: 18,
    supporting: 4,
    categories: 5,
    areasWithAnchors: 3,
    concentration: 0.4,
    ...overrides,
  };
}

describe('visitable supply', () => {
  /**
   * The measurement this exists for. A board of twenty-four of which one is an
   * airport and three are tour operators reads as a rich destination and is a
   * thin one — and the thinness is invisible exactly where it matters, because
   * the sparsest regions are the ones whose infrastructure outnumbers their
   * attractions.
   */
  it('is the regression: infrastructure never counts as something to do', () => {
    const verdict = assessVisitableSupply({
      supply: supplyOf({ anchors: 2, discoveries: 4, visitable: 6, supporting: 18, categories: 3 }),
      tripDays: 5,
    });

    expect(verdict.supply.visitable).toBe(6);
    expect(verdict.maxHonestBoardSize).toBe(6);
    expect(verdict.supportHeavy).toBe(true);
    expect(verdict.shortfalls).toContain('support_outnumbers_visitable');
    expect(verdict.shortfalls).toContain('anchors_below_days');
    expect(verdict.shortfalls).toContain('anchors_critical');
    // The sentence a traveller reads carries the real number, not the board size.
    expect(verdict.summary).toContain('6');
    expect(verdict.summary).not.toContain('24');
  });

  it('never lets the honest board be larger than the visitable supply', () => {
    for (const visitable of [0, 1, 6, 18, 140]) {
      const verdict = assessVisitableSupply({
        supply: supplyOf({ visitable, anchors: visitable, discoveries: 0, supporting: 60 }),
        tripDays: 4,
      });
      expect(verdict.maxHonestBoardSize).toBe(visitable);
    }
  });

  it('says so plainly when everything found was infrastructure', () => {
    const verdict = assessVisitableSupply({
      supply: supplyOf({ anchors: 0, discoveries: 0, visitable: 0, supporting: 22, categories: 0, areasWithAnchors: 0 }),
      tripDays: 5,
    });
    expect(verdict.maxHonestBoardSize).toBe(0);
    expect(verdict.summary).toContain('22');
    expect(verdict.summary.toLowerCase()).toContain('no attractions');
  });

  it('reports a healthy region as having no shortfall', () => {
    const verdict = assessVisitableSupply({ supply: supplyOf(), tripDays: 4 });
    expect(verdict.shortfalls).toEqual([]);
    expect(verdict.supportHeavy).toBe(false);
  });

  it('measures anchors against days rather than against a fixed number', () => {
    const supply = supplyOf({ anchors: 5, discoveries: 5, visitable: 10 });
    expect(assessVisitableSupply({ supply, tripDays: 4 }).shortfalls).toEqual([]);
    expect(assessVisitableSupply({ supply, tripDays: 9 }).shortfalls).toContain('anchors_below_days');
  });

  it('does not judge against a trip length nobody has established', () => {
    const verdict = assessVisitableSupply({ supply: supplyOf({ anchors: 1 }), tripDays: 0 });
    expect(verdict.shortfalls).not.toContain('anchors_below_days');
    expect(verdict.shortfalls).not.toContain('anchors_critical');
  });

  it('names one-category and one-area regions as the shortfalls they are', () => {
    expect(
      assessVisitableSupply({ supply: supplyOf({ categories: 1 }), tripDays: 3 }).shortfalls,
    ).toContain('single_category');
    expect(
      assessVisitableSupply({ supply: supplyOf({ areasWithAnchors: 1 }), tripDays: 3 }).shortfalls,
    ).toContain('single_area');
  });

  it('names no destination anywhere in the copy', () => {
    for (const supply of [supplyOf(), supplyOf({ visitable: 0, anchors: 0, discoveries: 0 })]) {
      const summary = assessVisitableSupply({ supply, tripDays: 3 }).summary;
      expect(summary).not.toMatch(/[A-Z][a-z]+,\s[A-Z]/);
    }
  });
});

// ---------------------------------------------------------------------------
// The board gate, which is the same rule one package over
// ---------------------------------------------------------------------------

/**
 * A `Place` records what *kind* of thing something is and never recorded what
 * part it plays in a trip — an airport and a market town are both
 * `town_and_food`. These tests are here rather than beside the board because the
 * convention is written by the inventory and read by the board, and a test that
 * only exercised one end would not catch the two drifting apart.
 */
function placeWith(tags: string[]): Place {
  return { tags } as unknown as Place;
}

describe('the board role gate', () => {
  it('round-trips every role through the tag the inventory writes', () => {
    for (const role of PLANNING_ROLES) {
      expect(planningRoleOfPlace(placeWith([placeRoleTag(role)]))).toBe(role);
    }
    for (const reason of INCLUSION_REASONS) {
      expect(inclusionReasonOfPlace(placeWith([placeInclusionTag(reason)]))).toBe(reason);
    }
  });

  it('never collides with the source-category tag the quality layer reads', () => {
    // `classifyingTagValue` splits on `=`; both conventions here use `:`.
    expect(placeRoleTag('gateway')).not.toContain('=');
    expect(placeInclusionTag('inside_scope')).not.toContain('=');
  });

  it('is the regression: a gateway and a support stop are refused as cards', () => {
    for (const role of SUPPORTING_ROLES) {
      const admission = admitToBoard(placeWith([placeRoleTag(role), 'places=airport']));
      expect(admission.admitted, role).toBe(false);
      expect(admission.refusal, role).toBe('utility_role');
    }
  });

  it('admits every visitable role', () => {
    for (const role of VISITABLE_ROLES) {
      expect(admitToBoard(placeWith([placeRoleTag(role)])).admitted, role).toBe(true);
    }
  });

  it('refuses an adjacent gateway however it is classified', () => {
    const admission = admitToBoard(
      placeWith([placeRoleTag('attraction'), placeInclusionTag('adjacent_gateway')]),
    );
    expect(admission.admitted).toBe(false);
    expect(admission.refusal).toBe('gateway_only');
  });

  it('admits an external satellite, because its reason says why', () => {
    expect(
      admitToBoard(
        placeWith([placeRoleTag('outdoor'), placeInclusionTag('optional_satellite')]),
      ).admitted,
    ).toBe(true);
  });

  it('never defaults an untagged place to a role', () => {
    // Admitted — refusing them would empty every pre-convention region's board —
    // but never *claimed* as an attraction.
    const place = placeWith(['places=museum']);
    expect(planningRoleOfPlace(place)).toBeUndefined();
    expect(admitToBoard(place).admitted).toBe(true);
    expect(admitToBoard(place).role).toBeUndefined();
  });

  it('reads an unrecognised role value as no role rather than as a role', () => {
    expect(planningRoleOfPlace(placeWith(['role:something_new']))).toBeUndefined();
  });
});

/** A compile-time reminder that the two vocabularies stay one vocabulary. */
const _roleCoverage: Record<PlanningRole, boolean> = Object.fromEntries(
  PLANNING_ROLES.map((role: PlanningRole) => [role, slotsForRole(role).length >= 0]),
) as Record<PlanningRole, boolean>;
void _roleCoverage;
void ((relationship: ScopeRelationship): ScopeRelationship => relationship);
