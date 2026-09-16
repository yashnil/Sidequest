import { describe, expect, it } from 'vitest';
import { WALK_SUGGESTS_MISPLACEMENT_KM, assessWalk, walkCeilingKm, walkPurposeOf, walkSuggestsMisplacement, type WalkContext } from './walking';

/**
 * V12.2 §2 §3 §21 — the walking corpus.
 *
 * Every case §2 names, plus the one that shipped. The point of the file is that
 * **no single cutoff appears anywhere in it**: a 4 km walk is right in one row
 * and wrong in the next, and what separates them is what the walk is for.
 */

function ctx(over: Omit<Partial<WalkContext>, 'segment'> & { segment?: Partial<WalkContext['segment']> } = {}): WalkContext {
  const { segment, ...rest } = over;
  return {
    ...rest,
    segment: { role: 'approach', km: null, provenance: 'estimated', ...(segment ?? {}) } as WalkContext['segment'],
  };
}

describe('what a walk is for', () => {
  it('calls a base-to-base leg a base transfer', () => {
    expect(walkPurposeOf(ctx({ segment: { role: 'transfer' } }))).toBe('base_transfer_walk');
  });

  it('calls a stage inside a walking experience an activity', () => {
    expect(walkPurposeOf(ctx({ segment: { episode: 'The high route', episodeMode: 'walk' } }))).toBe('activity_walk');
  });

  it('calls a horse stage inside an experience an activity too', () => {
    expect(walkPurposeOf(ctx({ segment: { episode: 'The pasture ride', episodeMode: 'horse' } }))).toBe('activity_walk');
  });

  it('treats an ordinary hop between two stops as a transfer', () => {
    /* The honest default: a leg with nothing said about it is a way of arriving. */
    expect(walkPurposeOf(ctx())).toBe('transfer_walk');
  });
});

describe('the cases §2 names', () => {
  it('allows a four-kilometre deliberate walk through a city', () => {
    const walk = assessWalk(ctx({ straightLineKm: 4, statedAsActivity: true, mobilityPattern: 'walk_and_transit' }), true);
    expect(walk.purpose).toBe('activity_walk');
    expect(walk.verdict).toBe('plausible');
  });

  it('refuses a four-kilometre transfer with luggage', () => {
    const walk = assessWalk(ctx({ straightLineKm: 4, segment: { role: 'transfer' } }), false);
    expect(walk.purpose).toBe('base_transfer_walk');
    expect(walk.verdict).toBe('refuse');
  });

  it('allows an eight-kilometre trek segment', () => {
    const walk = assessWalk(ctx({ straightLineKm: 8, mobilityPattern: 'trail', segment: { episode: 'Ala-Köl', episodeMode: 'walk' } }), false);
    expect(walk.verdict).toBe('plausible');
  });

  it('refuses an eight-kilometre walk to dinner', () => {
    const walk = assessWalk(ctx({ straightLineKm: 8, mobilityPattern: 'walk_and_transit' }), false);
    expect(walk.purpose).toBe('transfer_walk');
    expect(walk.verdict).toBe('refuse');
  });

  it('substitutes rather than refusing when the trip has another way', () => {
    const walk = assessWalk(ctx({ straightLineKm: 8, mobilityPattern: 'walk_and_transit' }), true);
    expect(walk.verdict).toBe('substitute');
  });
});

describe('the leg that shipped', () => {
  /* Naxos → Halki: 218 km straight line, priced at 3,640 minutes on foot. */
  const HALKI = ctx({ straightLineKm: 218.2, mobilityPattern: 'scheduled_transport' });

  it('is refused when the trip has no other ground mode', () => {
    const walk = assessWalk(HALKI, false);
    expect(walk.verdict).toBe('refuse');
    expect(walk.note).toMatch(/no other way/i);
  });

  it('is recognised as a placement error rather than an ambitious day', () => {
    /* "Too far to walk" is true of 218 km and useless. The useful sentence is that the stop is in the wrong place. */
    expect(walkSuggestsMisplacement(assessWalk(HALKI, false))).toBe(true);
    expect(WALK_SUGGESTS_MISPLACEMENT_KM).toBeGreaterThan(20);
  });

  it('does not call an ordinary long walk a placement error', () => {
    expect(walkSuggestsMisplacement(assessWalk(ctx({ straightLineKm: 9 }), false))).toBe(false);
  });
});

describe('the ceiling moves with the trip and the traveller', () => {
  it('gives a walking city more room between stops than a driving trip', () => {
    expect(walkCeilingKm('transfer_walk', ctx({ mobilityPattern: 'walk_and_transit' }))).toBeGreaterThan(walkCeilingKm('transfer_walk', ctx({ mobilityPattern: 'self_drive' })));
  });

  it('gives a trail trip far more room for the walking itself', () => {
    expect(walkCeilingKm('activity_walk', ctx({ mobilityPattern: 'trail' }))).toBeGreaterThan(walkCeilingKm('activity_walk', ctx({ mobilityPattern: 'self_drive' })));
  });

  it('never lets a trip’s shape override what the traveller said they would walk', () => {
    /* Somebody who said twenty-five minutes has not agreed to a two-hour walk because the trip is a walking one. */
    const stated = walkCeilingKm('transfer_walk', ctx({ mobilityPattern: 'walk_and_transit', maxWalkMinutes: 25 }));
    expect(stated).toBeLessThan(walkCeilingKm('transfer_walk', ctx({ mobilityPattern: 'walk_and_transit' })));
  });

  it('tightens hard for a party with a recorded mobility limitation', () => {
    expect(walkCeilingKm('transfer_walk', ctx({ mobilityLimited: true }))).toBeLessThanOrEqual(1.5);
    expect(walkCeilingKm('activity_walk', ctx({ mobilityPattern: 'trail', mobilityLimited: true }))).toBeLessThanOrEqual(1.5);
  });

  it('keeps a base transfer the least forgiving of the three', () => {
    const plain = ctx();
    expect(walkCeilingKm('base_transfer_walk', plain)).toBeLessThan(walkCeilingKm('transfer_walk', plain));
    expect(walkCeilingKm('transfer_walk', plain)).toBeLessThan(walkCeilingKm('activity_walk', plain));
  });
});

describe('what the verdict is measured on', () => {
  it('prefers a measured road distance', () => {
    const walk = assessWalk(ctx({ straightLineKm: 1, segment: { provenance: 'measured', km: 9 } }), false);
    expect(walk.basis).toBe('measured');
    expect(walk.verdict).toBe('refuse');
  });

  it('falls back to the straight line, which is a safe lower bound', () => {
    /* A walk already too far as the crow flies is further on the ground, so refusing on it cannot be over-strict. */
    const walk = assessWalk(ctx({ straightLineKm: 9 }), false);
    expect(walk.basis).toBe('geodesic');
    expect(walk.verdict).toBe('refuse');
  });

  it('says nothing at all when neither end is placed', () => {
    const walk = assessWalk(ctx(), false);
    expect(walk.basis).toBe('none');
    expect(walk.verdict).toBe('plausible');
    expect(walk.note).toMatch(/unknown/i);
  });

  it('leaves a short walk entirely alone', () => {
    expect(assessWalk(ctx({ straightLineKm: 0.6 }), false).verdict).toBe('plausible');
  });
});
