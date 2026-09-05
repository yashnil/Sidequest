import { describe, expect, it } from 'vitest';
import { defaultAnswers, buildTravelerProfile } from '../questionnaire/transform';
import { interestOfferFromEntityType } from '../interests/offer';
import { questionnaireAnswersSchema, type QuestionnaireAnswers } from '../schemas/profile';
import { INTERVIEW_QUESTIONS, interviewCatalog, questionById, type InterviewContext } from './catalog';
import { isPlanningImpactKey, PLANNING_IMPACT_CONSUMERS, PLANNING_IMPACT_KEYS } from './impact';
import { interviewAnalytics } from './analytics';
import { reviewLedger, personalityBars, personalitySentence } from './review';
import { CORE_BUDGET, CORE_ROLE_BUDGET, DESTINATION_BUDGET, planInterview, nextOpenQuestion } from './selector';
import { answerQuestion, applySmartDefaults, decideQuestion, interviewComplete, skipQuestion, withScreening } from './state';
import { compositionPreferenceSummary, renderPreferenceSummary } from './summary';
import { screenDestination, unscreenedDestination, type ScreeningSignals } from './traits';

const NOW = new Date('2026-09-04T10:00:00Z');

function contextFor(signals: Partial<ScreeningSignals> & { name: string; tripDays: number }, traveller: Partial<InterviewContext['traveller']> = {}): InterviewContext {
  const destination = screenDestination({ ...signals });
  const offer = interestOfferFromEntityType(signals.entityType ?? 'unknown');
  return {
    destination,
    traveller: {
      travelerNeeds: [],
      tripDays: signals.tripDays,
      adults: 2,
      children: 0,
      offeredInterests: offer.interests,
      carried: [],
      ...traveller,
    },
  };
}

function fresh(ctx: InterviewContext): QuestionnaireAnswers {
  return withScreening(defaultAnswers({ travelerNeeds: [...ctx.traveller.travelerNeeds], tripDays: ctx.traveller.tripDays }), ctx.destination);
}

/** The eight destination shapes the acceptance fixtures describe — as signals, never as names in production code. */
export const SHAPES = {
  mountainRegion: (): InterviewContext =>
    contextFor({ name: 'Alpine Lakes Basin', proseName: 'the basin', tripDays: 5, entityType: 'subregion', breadth: 'subregion', seededClass: 'mountain', bounds: { southWest: { lat: 37.4, lng: -119.3 }, northEast: { lat: 38.2, lng: -118.4 } }, startDate: '2026-08-12', center: { lat: 37.65, lng: -118.97 }, climate: { high: 26, low: 6 } }),
  denseCity: (): InterviewContext =>
    contextFor({ name: 'Harbour City', tripDays: 5, entityType: 'city', breadth: 'city', population: 7_400_000, center: { lat: 22.3, lng: 114.2 }, startDate: '2026-10-03', climate: { high: 29, low: 24 }, compiled: { placeCount: 40, transitMeasured: 12, hasScheduledNetwork: true, foodVenueCount: 30, classes: ['urban', 'coastal'] } }),
  cityState: (): InterviewContext =>
    contextFor({ name: 'Island City', tripDays: 4, entityType: 'city', breadth: 'city', population: 5_600_000, center: { lat: 1.35, lng: 103.8 }, startDate: '2026-07-10', climate: { high: 32, low: 26 }, scopeTransport: { primaryMode: 'rail', allowedModes: ['rail', 'walk', 'public_bus'], carAvailable: false } }),
  remoteMountainCountry: (): InterviewContext =>
    contextFor({ name: 'High Pass Republic', proseName: 'the high country', tripDays: 10, entityType: 'country', breadth: 'country', population: 6_500_000, bounds: { southWest: { lat: 39.2, lng: 69.3 }, northEast: { lat: 43.3, lng: 80.3 } }, center: { lat: 41.2, lng: 74.8 }, startDate: '2026-07-05', climate: { high: 27, low: 5 }, scopeTransport: { primaryMode: 'private_transfer', allowedModes: ['private_transfer', 'drive'], carAvailable: null }, compiled: { placeCount: 24, carOnlyShare: 0.8, classes: ['mountain', 'countryside'], maxElevationMetres: 3200, furthestSatelliteMinutes: 240 } }),
  broadArchipelago: (): InterviewContext =>
    contextFor({ name: 'Spice Archipelago', tripDays: 12, entityType: 'archipelago', breadth: 'country', bounds: { southWest: { lat: -10.5, lng: 95 }, northEast: { lat: 5.9, lng: 141 } }, center: { lat: -2.5, lng: 118 }, startDate: '2026-08-01', climate: { high: 31, low: 24 }, scopeTransport: { primaryMode: 'ferry', allowedModes: ['ferry', 'drive', 'walk'], carAvailable: null, acceptsWaterOrAirTransfers: true } }),
  wildernessBasin: (): InterviewContext =>
    contextFor({ name: 'Great River Basin', proseName: 'the basin', tripDays: 6, entityType: 'protected_area', breadth: 'region', featureType: 'national_park', population: 12_000, center: { lat: -3.4, lng: -62 }, startDate: '2026-09-15', climate: { high: 33, low: 23 }, scopeTransport: { primaryMode: 'private_transfer', allowedModes: ['private_transfer', 'ferry'], carAvailable: false, acceptsWaterOrAirTransfers: true }, gatewayKinds: ['airport', 'ferry_port'] }),
  safariDelta: (): InterviewContext =>
    contextFor({ name: 'Reed Delta', proseName: 'the delta', tripDays: 6, entityType: 'protected_area', breadth: 'region', population: 8_000, center: { lat: -19.3, lng: 22.9 }, startDate: '2026-08-20', climate: { high: 30, low: 8 }, scopeTransport: { primaryMode: 'private_transfer', allowedModes: ['private_transfer', 'ferry'], carAvailable: false, acceptsWaterOrAirTransfers: true } }),
  compactCountry: (): InterviewContext =>
    contextFor({ name: 'Green Isle', proseName: 'the island', tripDays: 8, entityType: 'country', breadth: 'country', population: 5_100_000, bounds: { southWest: { lat: 51.4, lng: -10.5 }, northEast: { lat: 55.4, lng: -5.4 } }, center: { lat: 53.4, lng: -8 }, startDate: '2026-05-10', climate: { high: 15, low: 6 }, scopeTransport: { primaryMode: 'drive', allowedModes: ['drive', 'rail', 'public_bus'], carAvailable: null } }),
};

describe('the impact registry', () => {
  it('every question names at least one real planning impact', () => {
    for (const question of INTERVIEW_QUESTIONS) {
      expect(question.impacts.length, `${question.id} has no downstream impact`).toBeGreaterThan(0);
      for (const impact of question.impacts) expect(isPlanningImpactKey(impact), `${question.id}: ${impact}`).toBe(true);
    }
  });
  it('every impact key names its consumer', () => {
    for (const key of PLANNING_IMPACT_KEYS) expect(PLANNING_IMPACT_CONSUMERS[key].length).toBeGreaterThan(10);
  });
  it('question ids are unique and copy names no destination', () => {
    const ids = INTERVIEW_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ctx = SHAPES.denseCity();
    const answers = fresh(ctx);
    for (const q of INTERVIEW_QUESTIONS) {
      const text = `${q.prompt(ctx, answers)} ${q.why(ctx)} ${(q.options?.(ctx, answers) ?? []).map((o) => `${o.label} ${o.detail ?? ''}`).join(' ')}`;
      expect(text).not.toMatch(/Mammoth|Hong Kong|Singapore|Kyrgyzstan|Iceland|Indonesia|Amazon|Okavango|Ireland/);
    }
  });
});

describe('destination screening', () => {
  it('reads a mountain region as road-trip, mountain, weather-exposed — never urban', () => {
    const d = SHAPES.mountainRegion().destination;
    expect(d.traits).toEqual(expect.arrayContaining(['road_trip_region', 'mountain', 'weather_exposed']));
    expect(d.traits).not.toContain('dense_urban');
    expect(d.basis.road_trip_region).toBeTruthy();
    expect(d.assumption?.movement).toBe('car');
    expect(d.evidence).toBe('screened');
  });
  it('reads a dense harbour city as urban, transit-rich, walk-heavy, food-dense — never a road trip', () => {
    const d = SHAPES.denseCity().destination;
    expect(d.traits).toEqual(expect.arrayContaining(['dense_urban', 'transit_rich', 'walk_heavy', 'food_dense', 'nightlife_dense']));
    expect(d.traits).not.toContain('road_trip_region');
    expect(d.traits).not.toContain('mountain');
    expect(d.assumption?.movement).toBe('transit_walk');
    expect(d.assumption?.bases).toBe('one');
  });
  it('reads a city-state as urban and heat-sensitive with no base moves', () => {
    const d = SHAPES.cityState().destination;
    expect(d.traits).toEqual(expect.arrayContaining(['dense_urban', 'transit_rich', 'heat_sensitive']));
    expect(d.traits).not.toContain('multi_base_likely');
    expect(d.traits).not.toContain('road_trip_region');
  });
  it('reads a remote mountain country as broad, guided, high-altitude, remote', () => {
    const d = SHAPES.remoteMountainCountry().destination;
    expect(d.traits).toEqual(expect.arrayContaining(['broad_geography', 'guide_transfer_likely', 'remote', 'high_altitude', 'mountain', 'road_trip_region', 'multi_base_likely']));
    expect(d.traits).not.toContain('dense_urban');
    expect(d.assumption?.movement).toBe('guided');
  });
  it('reads a broad archipelago as islands, water transfer, flights likely', () => {
    const d = SHAPES.broadArchipelago().destination;
    expect(d.traits).toEqual(expect.arrayContaining(['archipelago', 'water_transfer', 'internal_flight_likely', 'broad_geography', 'multi_base_likely', 'heat_sensitive']));
    expect(d.assumption?.movement).toBe('boat');
  });
  it('reads a wilderness basin as wilderness, remote, guided, water', () => {
    const d = SHAPES.wildernessBasin().destination;
    expect(d.traits).toEqual(expect.arrayContaining(['wilderness', 'remote', 'guide_transfer_likely', 'water_transfer', 'heat_sensitive']));
    expect(d.traits).not.toContain('dense_urban');
    expect(d.traits).not.toContain('transit_rich');
  });
  it('reads a compact country as compact, road-trip, multi-base — not broad', () => {
    const d = SHAPES.compactCountry().destination;
    expect(d.traits).toEqual(expect.arrayContaining(['compact_country', 'road_trip_region', 'multi_base_likely']));
    expect(d.traits).not.toContain('broad_geography');
    expect(d.traits).not.toContain('dense_urban');
  });
  it('with nothing known, emits no traits and no assumption, and never throws', () => {
    const d = screenDestination({ name: 'Somewhere', tripDays: 4 });
    expect(d.traits).toEqual([]);
    expect(d.evidence).toBe('none');
    expect(d.assumption).toBeUndefined();
    expect(unscreenedDestination('Somewhere', 4).traits).toEqual([]);
  });
  it('a winter date in mountain country adds winter access with a basis', () => {
    const d = screenDestination({ name: 'Snow Valley', tripDays: 5, entityType: 'subregion', breadth: 'subregion', seededClass: 'mountain', startDate: '2027-01-15', center: { lat: 46, lng: 10 } });
    expect(d.traits).toContain('winter_access');
    expect(d.basis.winter_access).toMatch(/winter/);
  });
});

describe('the selector', () => {
  it('asks a mountain region about driving, reach and hikes, and never about the metro or the ferry', () => {
    const ctx = SHAPES.mountainRegion();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    expect(plan.shown[0]).toBe('priorities');
    const modules = new Set(plan.questions.filter((q) => plan.shown.includes(q.id)).map((q) => q.module));
    expect(modules.has('road_trip')).toBe(true);
    expect(modules.has('urban_mobility')).toBe(false);
    expect(modules.has('island_water')).toBe(false);
    expect(modules.has('broad_scope')).toBe(false);
    expect(plan.shown).toContain('hard_constraints');
    expect(plan.shown[plan.shown.length - 1]).toBe('hard_constraints');
  });
  it('asks a dense city about walking, transit and day trips — no dirt roads', () => {
    const ctx = SHAPES.denseCity();
    let answers = fresh(ctx);
    // Transport first: the traveller takes the metro.
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'transport_mode')!, value: 'transit_walk', now: NOW });
    const plan = planInterview({ ctx, answers });
    const ids = plan.shown;
    expect(ids).toContain('walking_tolerance');
    expect(ids).toContain('day_trips');
    expect(ids).not.toContain('road_comfort');
    expect(ids).not.toContain('daily_driving');
    expect(ids).not.toContain('scenic_reach');
    expect(ids).not.toContain('boats_ferries');
    expect(ids).not.toContain('guide_willingness');
    expect(ids).not.toContain('base_moves');
  });
  it('a city-state is never interrogated about hotel changes or road trips', () => {
    const ctx = SHAPES.cityState();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    expect(plan.shown).not.toContain('base_moves');
    expect(plan.shown).not.toContain('coverage_strategy');
    expect(plan.shown).not.toContain('daily_driving');
    expect(plan.shown).toContain('weather_avoidances');
  });
  it('a remote mountain country asks about guides, transfers, altitude and scope', () => {
    const ctx = SHAPES.remoteMountainCountry();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    for (const id of ['coverage_strategy', 'guide_willingness', 'remote_comfort', 'altitude_comfort', 'base_moves']) expect(plan.shown, id).toContain(id);
    expect(planInterview({ ctx, answers: fresh(ctx), mode: 'deep' }).shown).toContain('private_transfers');
    expect(plan.shown).not.toContain('walking_tolerance');
    expect(plan.shown).not.toContain('day_trips');
  });
  it('a broad archipelago asks about scope, boats, flights and island changes', () => {
    const ctx = SHAPES.broadArchipelago();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    for (const id of ['coverage_strategy', 'boats_ferries', 'internal_flights', 'base_moves']) expect(plan.shown, id).toContain(id);
  });
  it('a wilderness basin asks about guides, unverified transfers and remoteness, never the metro', () => {
    const ctx = SHAPES.wildernessBasin();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    for (const id of ['guide_willingness', 'private_transfers', 'remote_comfort']) expect(plan.shown, id).toContain(id);
    expect(plan.shown).not.toContain('transit_comfort');
    expect(plan.shown).not.toContain('day_trips');
  });
  it('a compact country asks about road versus rail, base changes and reach', () => {
    const ctx = SHAPES.compactCountry();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    expect(plan.shown).toContain('transport_mode');
    expect(plan.shown).toContain('base_moves');
    expect(plan.shown).not.toContain('coverage_strategy');
  });
  it('an unscreened destination still asks the generic high-information questions', () => {
    const ctx = contextFor({ name: 'Somewhere', tripDays: 4 });
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    expect(plan.shown).toContain('priorities');
    expect(plan.shown).toContain('transport_mode');
    expect(plan.shown).toContain('day_shape');
    expect(plan.shown).toContain('hard_constraints');
  });
  it('keeps the normal experience within budget and orders by value', () => {
    for (const shape of Object.values(SHAPES)) {
      const ctx = shape();
      const plan = planInterview({ ctx, answers: fresh(ctx) });
      expect(plan.byTier.core).toBeLessThanOrEqual(CORE_BUDGET + CORE_ROLE_BUDGET + 2);
      expect(plan.byTier.destination).toBeLessThanOrEqual(DESTINATION_BUDGET);
      expect(plan.shown.length).toBeLessThanOrEqual(CORE_BUDGET + CORE_ROLE_BUDGET + 2 + DESTINATION_BUDGET);
      const core = plan.questions.filter((q) => q.tier === 'core' && !q.id.startsWith('priority_role') && q.id !== 'priorities' && q.id !== 'hard_constraints');
      for (let i = 1; i < core.length; i += 1) expect(core[i - 1]!.score).toBeGreaterThanOrEqual(core[i]!.score);
    }
  });
  it('a carried composer answer is not asked again but stays in the plan for the review', () => {
    const ctx = SHAPES.mountainRegion();
    ctx.traveller.carried = ['budgetStyle', 'pace'];
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    expect(plan.shown).not.toContain('budget');
    expect(plan.shown).not.toContain('day_shape');
    expect(plan.questions.find((q) => q.id === 'budget')?.status).toBe('carried');
  });
  it('the fine-tune tier only appears in deep mode', () => {
    const ctx = SHAPES.denseCity();
    const normal = planInterview({ ctx, answers: fresh(ctx), mode: 'normal' });
    const deep = planInterview({ ctx, answers: fresh(ctx), mode: 'deep' });
    expect(normal.shown).not.toContain('lodging_style');
    expect(deep.shown).toContain('lodging_style');
    expect(deep.shown.length).toBeGreaterThan(normal.shown.length);
  });
  it('choosing priorities unlocks role questions for exactly what was chosen', () => {
    const ctx = SHAPES.mountainRegion();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'priorities')!, value: ['hiking', 'lakes_and_rivers'], now: NOW });
    const plan = planInterview({ ctx, answers });
    expect(plan.shown).toContain('priority_role:hiking');
    expect(plan.shown).toContain('priority_role:lakes_and_rivers');
    expect(plan.shown).not.toContain('priority_role:stargazing');
    // The core trade-offs survive the roles: day shape, crowds and food are still asked.
    for (const id of ['day_shape', 'iconic_crowds', 'food_tradeoff', 'transport_mode', 'effort']) expect(plan.shown, id).toContain(id);
    expect(interviewCatalog(ctx, answers).some((q) => q.id === 'priority_role:hiking')).toBe(true);
  });
});

describe('state transitions', () => {
  it('an explicit answer is recorded with full confidence and reaches the legacy fields', () => {
    const ctx = SHAPES.mountainRegion();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'transport_mode')!, value: 'no_car', now: NOW });
    expect(answers.willDrive).toBe(false);
    expect(answers.provenance.transport_mode).toMatchObject({ source: 'explicit', confidence: 1 });
    expect(answers.interview?.answered).toContain('transport_mode');
  });
  it('decide-for-me records a destination prior with its reason, and the value follows the screening', () => {
    const ctx = SHAPES.denseCity();
    const answers = fresh(ctx);
    const { answers: next, decision } = decideQuestion({ answers, ctx, question: questionById(ctx, answers, 'transport_mode')!, now: NOW });
    expect(decision.value).toBe('transit_walk');
    expect(decision.source).toBe('destination_prior');
    expect(decision.reason).toMatch(/walking and riding public transport/);
    expect(next.willDrive).toBe(false);
    expect(next.provenance.transport_mode?.source).toBe('destination_prior');
    expect(next.interview?.decided).toContain('transport_mode');
    const mountain = SHAPES.mountainRegion();
    const decided = decideQuestion({ answers: fresh(mountain), ctx: mountain, question: questionById(mountain, fresh(mountain), 'transport_mode')!, now: NOW });
    expect(decided.decision.value).toBe('rent_car');
  });
  it('answering after deciding takes the decision back', () => {
    const ctx = SHAPES.denseCity();
    let answers = fresh(ctx);
    answers = decideQuestion({ answers, ctx, question: questionById(ctx, answers, 'day_shape')!, now: NOW }).answers;
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'day_shape')!, value: 'cover', now: NOW });
    expect(answers.pace).toBe('fast');
    expect(answers.interview?.decided).not.toContain('day_shape');
    expect(answers.provenance.day_shape?.source).toBe('explicit');
  });
  it('a skip keeps the silent value and records the skip', () => {
    const ctx = SHAPES.denseCity();
    let answers = fresh(ctx);
    answers = skipQuestion({ answers, ctx, question: questionById(ctx, answers, 'famous_vs_hidden')!, now: NOW });
    expect(answers.discoveryMix).toBe('balanced');
    expect(answers.interview?.skipped).toContain('famous_vs_hidden');
    expect(planInterview({ ctx, answers }).questions.find((q) => q.id === 'famous_vs_hidden')?.status).toBe('skipped');
  });
  it('hard constraints persist as typed constraints and land on the legacy fields', () => {
    const ctx = SHAPES.mountainRegion();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'hard_constraints')!, value: { constraints: [{ code: 'max_daily_drive_minutes', value: 120 }, { code: 'must_be_back_by', value: 20 * 60 }, { code: 'no_early_starts' }], notes: 'my knee is bad', notesAreHard: true }, now: NOW });
    expect(answers.maxDailyTravelMinutes).toBe(120);
    expect(answers.dayStart).toBe('relaxed');
    expect(answers.avoidances).toContain('early_mornings');
    expect(answers.hardNotes).toBe('my knee is bad');
    expect(answers.provenance.hard_constraints?.strength).toBe('hard');
    const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 5 });
    expect(profile.hard.map((c) => c.code)).toEqual(expect.arrayContaining(['max_daily_drive_minutes', 'must_be_back_by', 'no_early_starts']));
    expect(profile.interview.mustBeBackByMinute).toBe(1200);
    expect(profile.transport.maxDailyDriveMinutes).toBe(120);
  });
  it('a "cannot" tolerance becomes a hard constraint on the profile', () => {
    const ctx = SHAPES.broadArchipelago();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'boats_ferries')!, value: 'cannot', now: NOW });
    const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 12 });
    expect(profile.hard.some((c) => c.code === 'no_boats')).toBe(true);
    expect(profile.interview.boatsAndFerries).toBe('cannot');
    expect(answers.provenance.boats_ferries?.strength).toBe('hard');
  });
  it('soft notes stay soft', () => {
    const ctx = SHAPES.mountainRegion();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'hard_constraints')!, value: { constraints: [], notes: 'would rather not drive at night', notesAreHard: false }, now: NOW });
    expect(answers.hardNotes).toBeUndefined();
    expect(answers.accessibilityNotes).toBe('would rather not drive at night');
    expect(answers.hardConstraints).toEqual([]);
  });
  it('the fast path decides every core and destination question with reasons and completes the interview', () => {
    const ctx = SHAPES.remoteMountainCountry();
    const { answers, decisions } = applySmartDefaults({ answers: fresh(ctx), ctx, now: NOW });
    expect(decisions.length).toBeGreaterThan(6);
    for (const { decision } of decisions) expect(decision.reason.length).toBeGreaterThan(10);
    const plan = planInterview({ ctx, answers, mode: 'normal' });
    expect(interviewComplete(plan)).toBe(true);
    expect(nextOpenQuestion(plan)).toBeNull();
    expect(answers.interview?.mode).toBe('fast');
    expect(answers.willDrive).toBe(false);
    expect(answers.guideWillingness).toBe('prefer');
    expect(Object.values(answers.provenance).every((p) => p.source !== 'explicit')).toBe(true);
  });
  it('answers survive a schema round trip', () => {
    const ctx = SHAPES.denseCity();
    const { answers } = applySmartDefaults({ answers: fresh(ctx), ctx, now: NOW });
    const parsed = questionnaireAnswersSchema.parse(JSON.parse(JSON.stringify(answers)));
    expect(parsed).toEqual(answers);
  });
});

describe('review, analytics and the composition summary', () => {
  it('the review separates what was told from what was assumed', () => {
    const ctx = SHAPES.mountainRegion();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'transport_mode')!, value: 'rent_car', now: NOW });
    answers = decideQuestion({ answers, ctx, question: questionById(ctx, answers, 'day_shape')!, now: NOW }).answers;
    const plan = planInterview({ ctx, answers });
    const ledger = reviewLedger(ctx, answers, plan);
    expect(ledger.told.map((e) => e.questionId)).toContain('transport_mode');
    expect(ledger.assumed.map((e) => e.questionId)).toContain('day_shape');
    expect(ledger.assumed.find((e) => e.questionId === 'day_shape')?.reason).toBeTruthy();
    expect(ledger.told.map((e) => e.questionId)).not.toContain('day_shape');
  });
  it('analytics count available, shown, answered, decided and skipped with branch reasons', () => {
    const ctx = SHAPES.broadArchipelago();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'priorities')!, value: ['beaches_and_swimming'], now: NOW });
    answers = decideQuestion({ answers, ctx, question: questionById(ctx, answers, 'coverage_strategy')!, now: NOW }).answers;
    answers = skipQuestion({ answers, ctx, question: questionById(ctx, answers, 'famous_vs_hidden')!, now: NOW });
    const plan = planInterview({ ctx, answers });
    const analytics = interviewAnalytics(ctx, answers, plan);
    expect(analytics.available).toBeGreaterThan(analytics.shown);
    expect(analytics.answered).toBe(1);
    expect(analytics.decided).toBe(1);
    expect(analytics.skipped).toBe(1);
    expect(analytics.branchReasons.boats_ferries).toMatch(/archipelago|water transfer/);
    expect(analytics.dimensionsResolved).toContain('scope');
    expect(analytics.traits).toContain('archipelago');
  });
  it('the personality is qualitative and the sentence names the trip shape', () => {
    const ctx = SHAPES.mountainRegion();
    let answers = fresh(ctx);
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'priorities')!, value: ['hiking', 'scenic_viewpoints'], now: NOW });
    answers = answerQuestion({ answers, ctx, question: questionById(ctx, answers, 'priority_role:hiking')!, value: 'build_around', now: NOW });
    const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 5 });
    const bars = personalityBars(profile);
    expect(bars[0]).toMatchObject({ label: 'Outdoors', level: 'high' });
    expect(bars.every((bar) => ['off', 'low', 'medium', 'high'].includes(bar.level))).toBe(true);
    expect(personalitySentence(ctx, profile)).toMatch(/outdoors-led/);
  });
  it('changing an answer changes the composition input, and hard constraints lead', () => {
    const ctx = SHAPES.compactCountry();
    const base = fresh(ctx);
    const context = { travelerNeeds: [] as never[], tripDays: 8 };
    const a = compositionPreferenceSummary(buildTravelerProfile(answerQuestion({ answers: base, ctx, question: questionById(ctx, base, 'base_moves')!, value: 'stay_put', now: NOW }), context));
    const b = compositionPreferenceSummary(buildTravelerProfile(answerQuestion({ answers: base, ctx, question: questionById(ctx, base, 'base_moves')!, value: 'move_freely', now: NOW }), context));
    expect(a.explicit).toContain('One base for the whole trip');
    expect(b.explicit).toContain('Move as often as the route wants');
    expect(renderPreferenceSummary(a).join('\n')).not.toEqual(renderPreferenceSummary(b).join('\n'));
    const hard = answerQuestion({ answers: base, ctx, question: questionById(ctx, base, 'hard_constraints')!, value: { constraints: [{ code: 'cannot_drive' }] }, now: NOW });
    const summary = compositionPreferenceSummary(buildTravelerProfile(hard, context));
    expect(summary.hard).toContain('Nobody will be driving');
    const lines = renderPreferenceSummary(summary);
    expect(lines[1]).toBe('Hard constraints:');
    expect(lines[2]).toMatch(/Nobody will be driving/);
  });
  it('assumptions are tagged so the model can trade them away', () => {
    const ctx = SHAPES.denseCity();
    const { answers } = applySmartDefaults({ answers: fresh(ctx), ctx, now: NOW });
    const summary = compositionPreferenceSummary(buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 5 }));
    expect(summary.assumed.some((line) => /\(assumed/.test(line))).toBe(true);
    expect(summary.explicit.filter((line) => /\(assumed/.test(line))).toEqual([]);
  });
});
