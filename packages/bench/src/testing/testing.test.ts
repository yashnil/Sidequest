import { describe, expect, it } from 'vitest';
import { planFingerprint } from '../fingerprint';
import { benchmarkPlanSchema } from '../schemas/plan';
import { benchmarkTripRequestSchema } from '../schemas/request';
import {
  ALL_FIXTURE_PLANS,
  aLeftAssignment,
  bLeftAssignment,
  A_LEFT_SEED,
  B_LEFT_SEED,
  FIXED_NOW,
  fakeGroundTruth,
  fakeRequest,
  sampleAssignment,
  sampleCorrection,
  sampleMetrics,
  samplePlan,
  sampleQuestion,
  sampleReview,
  validBaselineShapedPlan,
  validSidequestShapedPlan,
} from './index';
import { assignmentIsConsistent } from '../assign';
import { timingViolations } from '../schemas/metrics';

/**
 * The fixture kit checking itself.
 *
 * Everything here is a property some other test will rely on without restating:
 * that a fixture plan parses, that the neutrality pair really is structurally
 * identical, that the two seeded assignments really do differ in render order.
 * A fixture that quietly stopped satisfying one of those would not fail here —
 * it would fail somewhere else, as a mysterious result about a validator.
 */

describe('the fixture plans', () => {
  it.each(ALL_FIXTURE_PLANS.map((plan) => [plan.planId, plan] as const))(
    '%s parses, and parsing it again changes nothing',
    (_planId, plan) => {
      expect(benchmarkPlanSchema.parse(plan)).toEqual(plan);
    },
  );

  it('gives every fixture plan its own id', () => {
    const ids = ALL_FIXTURE_PLANS.map((plan) => plan.planId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The fingerprint reads blocks in the order the plan wrote them and a neutral
   * checker canonicalises them by clock time first. A fixture whose array
   * disagreed with its own timeline would therefore be two different plans
   * depending on which one was looking, and every result built on it would be
   * about the fixture rather than about either system.
   */
  it.each(ALL_FIXTURE_PLANS.map((plan) => [plan.planId, plan] as const))(
    '%s lists its blocks in the order they happen',
    (_planId, plan) => {
      for (const day of plan.days) {
        const starts = day.blocks
          .map((entry) => entry.startMinute)
          .filter((minute): minute is number => minute !== null);
        expect(starts, `day ${day.dayNumber}`).toEqual([...starts].sort((a, b) => a - b));
      }
    },
  );

  it('lets a caller override the top level without rebuilding the days', () => {
    const plan = samplePlan({ planId: 'plan-override', producedBy: 'baseline' });
    expect(plan.planId).toBe('plan-override');
    expect(plan.producedBy).toBe('baseline');
    expect(planFingerprint(plan)).toBe(planFingerprint(validSidequestShapedPlan));
  });
});

describe('the neutrality pair', () => {
  it('fingerprints identically', () => {
    expect(planFingerprint(validBaselineShapedPlan)).toBe(
      planFingerprint(validSidequestShapedPlan),
    );
  });

  it('differs in every way that is not the plan', () => {
    expect(validBaselineShapedPlan.producedBy).not.toBe(validSidequestShapedPlan.producedBy);
    expect(validBaselineShapedPlan.planId).not.toBe(validSidequestShapedPlan.planId);
    expect(validBaselineShapedPlan.summary).not.toBe(validSidequestShapedPlan.summary);
    expect(validBaselineShapedPlan.scopeNote).not.toBe(validSidequestShapedPlan.scopeNote);
    expect(validBaselineShapedPlan.sources).not.toEqual(validSidequestShapedPlan.sources);

    // Different names for the same ids, which is what proves nothing downstream
    // is resolving a place by string similarity.
    expect(validBaselineShapedPlan.destination.entityId).toBe(
      validSidequestShapedPlan.destination.entityId,
    );
    expect(validBaselineShapedPlan.destination.name).not.toBe(
      validSidequestShapedPlan.destination.name,
    );

    // Exclusions in the opposite order, and the fingerprint does not mind.
    expect(validBaselineShapedPlan.exclusions.map((entry) => entry.place.entityId)).toEqual(
      validSidequestShapedPlan.exclusions.map((entry) => entry.place.entityId).reverse(),
    );

    const sidequestDay = validSidequestShapedPlan.days[0];
    const baselineDay = validBaselineShapedPlan.days[0];
    expect(sidequestDay).toBeDefined();
    expect(baselineDay).toBeDefined();
    expect(baselineDay?.theme).not.toBe(sidequestDay?.theme);
    // One states its own totals, the other does not. Optional for both means
    // optional for both, and the fingerprint has to survive the asymmetry.
    expect(sidequestDay?.statedTotals.travelMinutes).not.toBeNull();
    expect(baselineDay?.statedTotals.travelMinutes).toBeNull();

    const sidequestBlocks = sidequestDay?.blocks ?? [];
    const baselineBlocks = baselineDay?.blocks ?? [];
    expect(baselineBlocks).toHaveLength(sidequestBlocks.length);
    expect(sidequestBlocks.some((entry) => entry.evidence.length > 0)).toBe(true);
    expect(baselineBlocks.every((entry) => entry.evidence.length === 0)).toBe(true);
    expect(sidequestBlocks.some((entry) => entry.place?.latitude !== null)).toBe(true);
    expect(baselineBlocks.every((entry) => entry.place === null || entry.place.latitude === null)).toBe(
      true,
    );
  });
});

describe('the seeded assignments', () => {
  it('put a different panel first, and agree with their own draws', () => {
    expect(aLeftAssignment.firstLabel).toBe('A');
    expect(bLeftAssignment.firstLabel).toBe('B');
    expect(aLeftAssignment.firstLabel).not.toBe(bLeftAssignment.firstLabel);
    expect(assignmentIsConsistent(aLeftAssignment)).toBe(true);
    expect(assignmentIsConsistent(bLeftAssignment)).toBe(true);
  });

  it('vary only the render order, so a position effect is estimable from the pair', () => {
    expect(bLeftAssignment.labelASystem).toBe(aLeftAssignment.labelASystem);
    expect(bLeftAssignment.labelBSystem).toBe(aLeftAssignment.labelBSystem);
  });

  it('are marked as seeded, and carry the seed that produced them', () => {
    expect(aLeftAssignment.source).toBe('seeded');
    expect(aLeftAssignment.seed).toBe(A_LEFT_SEED);
    expect(bLeftAssignment.seed).toBe(B_LEFT_SEED);
  });

  it('are the same every time, from the seed alone', () => {
    expect(sampleAssignment(A_LEFT_SEED)).toEqual(aLeftAssignment);
    expect(sampleAssignment(A_LEFT_SEED, new Date('2030-01-01T00:00:00.000Z')).drawLabel).toBe(
      aLeftAssignment.drawLabel,
    );
  });
});

describe('the fake ground truth', () => {
  const truth = fakeGroundTruth();

  it('answers about a place it holds and admits the ones it does not', () => {
    expect(truth.place('kc-lantern-museum')?.name).toBe('Lantern Museum');
    expect(truth.place('nowhere-at-all')).toBeNull();
  });

  it('tells a missing dataset apart from a dataset that does not know', () => {
    // No hours data at all for the tarn: nothing to compare a claim against.
    expect(truth.openingOn('kc-mirror-tarn', '2027-05-19')).toBeNull();
    // A dataset exists for the garden and says it cannot say. Different answer.
    expect(truth.openingOn('kc-tidal-garden', '2027-05-18')?.status).toBe('unknown');
    expect(truth.openingOn('kc-lantern-museum', '2027-05-18')?.status).toBe('open');
    expect(truth.openingOn('kc-lantern-museum', '2027-05-21')?.status).toBe('closed');
  });

  it('has a seasonal rule for some places and none for others', () => {
    expect(truth.seasonallyOpenOn('kc-mirror-tarn', '2027-05-19')).toBe(true);
    expect(truth.seasonallyOpenOn('kc-mirror-tarn', '2027-01-19')).toBe(false);
    expect(truth.seasonallyOpenOn('kc-old-quay-steps', '2027-05-19')).toBeNull();
  });

  it('has measured some pairs and not others, and never guesses the rest', () => {
    expect(truth.routeMinutes('kc-harbour-quarter', 'kc-mirror-tarn')).toBe(45);
    // Read in both directions, because a fixture with only one would drown every
    // round trip in unknowns.
    expect(truth.routeMinutes('kc-mirror-tarn', 'kc-harbour-quarter')).toBe(45);
    expect(truth.routeMinutes('kc-harbour-quarter', 'kc-north-headland')).toBeNull();
    expect(truth.straightLineKm('kc-harbour-quarter', 'kc-north-headland')).toBeGreaterThan(0);
    expect(truth.straightLineKm('kc-harbour-quarter', 'nowhere-at-all')).toBeNull();
  });

  it('separates a claim nothing backs from a claim nobody could check', () => {
    expect(
      truth.supportsClaim(0, 'hours.weekly', '09:00-17:30'),
    ).toBe(true);
    // The right source, the wrong value.
    expect(truth.supportsClaim(0, 'hours.weekly', '07:00-22:00')).toBe(false);
    // Retrieved and never read: neither confirmed nor denied.
    expect(truth.supportsClaim(2, 'hours.weekly', '10:00-17:00')).toBeNull();
    /*
     * An index the world has no source for is not this port's question.
     *
     * It reads like a range check and is not one: the index belongs to the
     * *plan's* source list, which the claims validator holds and checks itself.
     * Answering `false` here convicted a perfectly good citation of being an
     * unsupported claim because an unrelated count happened to be smaller — so
     * the honest answer is that this world cannot tell.
     */
    expect(truth.supportsClaim(99, 'hours.weekly', '10:00-17:00')).toBeNull();
  });

  it('knows what a venue cannot cook, and takes the instant it is judged at', () => {
    expect(truth.food('kc-harbour-canteen')?.cannotAccommodate).toContain('gluten_free');
    expect(truth.food('kc-quay-bakery')?.cannotAccommodate).toEqual([]);
    expect(truth.food('kc-lantern-museum')).toBeNull();
    expect(truth.now).toEqual(FIXED_NOW);
  });

  it('takes an override for the traveller and for the world', () => {
    const stricter = fakeGroundTruth({
      request: { movement: { maxDailyTravelMinutes: 90, maxDailyDriveMinutes: 60 } },
      world: { measuredRoutes: {} },
      now: new Date('2027-05-11T09:00:00.000Z'),
    });
    expect(stricter.request.movement.maxDailyTravelMinutes).toBe(90);
    // Untouched fields survive the merge: one section changed, not the request.
    expect(stricter.request.movement.desiredBaseCount).toBe(1);
    expect(stricter.routeMinutes('kc-harbour-quarter', 'kc-mirror-tarn')).toBeNull();
    expect(stricter.now.toISOString()).toBe('2027-05-11T09:00:00.000Z');
  });
});

describe('the fixture request', () => {
  it('parses, and states the avoidance the defect plans rely on', () => {
    const request = fakeRequest();
    expect(benchmarkTripRequestSchema.parse(request)).toEqual(request);
    expect(request.taste.hardAvoidances).toContain('strenuous_activity');
  });

  it('merges a section rather than replacing the whole request', () => {
    const request = fakeRequest({ party: { children: 2, childAges: [4, 7] } });
    expect(request.party.children).toBe(2);
    expect(request.party.adults).toBe(2);
    expect(request.destination.identity?.id).toBe('kc-region');
  });
});

describe('the session records', () => {
  it('build metrics whose ordering holds and whose absences carry a reason', () => {
    const metrics = sampleMetrics();
    expect(timingViolations(metrics)).toEqual([]);
    expect(metrics.cacheHits.state).toBe('unavailable');
    expect(sampleMetrics({ warmth: 'warm' }).warmth).toBe('warm');
  });

  it('build a review with both panels rated and every choice answered', () => {
    const review = sampleReview();
    expect(review.ratings).toHaveLength(2);
    expect(Object.keys(review.choices)).toHaveLength(6);
    expect(review.submittedAt).toBe(FIXED_NOW.toISOString());
    expect(sampleReview({ reviewer: 'someone-else' }).reviewer).toBe('someone-else');
  });

  it('build a correction whose hash follows its text', () => {
    const correction = sampleCorrection();
    const changed = sampleCorrection({ instructionText: 'Something else entirely.' });
    expect(correction.instructionHash).not.toBe(changed.instructionHash);
    expect(sampleCorrection().instructionHash).toBe(correction.instructionHash);
  });

  it('build a question that was answered by the shared request in no time at all', () => {
    const question = sampleQuestion();
    expect(question.answeredFrom).toBe('shared_request');
    expect(question.elapsedMs).toBe(0);
    expect(sampleQuestion({ answeredFrom: 'unanswered', answerValues: null }).answerValues).toBeNull();
  });
});
