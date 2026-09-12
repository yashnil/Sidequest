import { describe, expect, it } from 'vitest';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import { interestOfferFromEntityType } from '../interests/offer';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { buildTravelerBrief, renderTravelerBriefXml, type TravelerBriefTripFacts } from './brief';
import { INTERVIEW_QUESTIONS, questionById, type InterviewContext } from './catalog';
import { planInterview } from './selector';
import { answerQuestion, withScreening } from './state';
import { screenDestination, type ScreeningSignals } from './traits';

/**
 * V8.1 — A MOUNTAIN REGION IS INTERVIEWED AS ONE.
 *
 * "The Canadian Rockies" reached the questionnaire as a point in Calgary and
 * was asked about walking tolerance and late nights
 * (`.claude-private/V8.1-DESTINATION-FAILURE.md`). With the semantic reading
 * on the signals the screening emits `mountain`, and the interview must turn
 * on it: hiking, altitude, trail setting, driving comfort, early starts,
 * huts and camps, permit-bound days — and none of the city questions.
 *
 * Signals, never names: the destination here is a shape, and a dense city of
 * the same trip length is the control.
 */
const NOW = new Date('2026-09-11T10:00:00Z');

function contextFor(signals: ScreeningSignals): InterviewContext {
  const destination = screenDestination(signals);
  const offer = interestOfferFromEntityType(signals.entityType ?? 'unknown');
  return { destination, traveller: { travelerNeeds: [], tripDays: signals.tripDays, adults: 2, children: 0, offeredInterests: offer.interests, carried: [] } };
}

function fresh(ctx: InterviewContext): QuestionnaireAnswers {
  return withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays }), ctx.destination);
}

const mountainRegion = (): InterviewContext =>
  contextFor({
    name: 'the Canadian Rockies',
    proseName: 'the Canadian Rockies',
    tripDays: 8,
    entityType: 'natural_region',
    breadth: 'region',
    semantic: { type: 'mountain_region', scale: 'region', landscape: 'rockies', extentSource: 'interpreted_parts', gateways: 3 },
    center: { lat: 51.4, lng: -116.2 },
    bounds: { southWest: { lat: 50.6, lng: -118.3 }, northEast: { lat: 53.2, lng: -114.9 } },
    startDate: '2027-07-10',
  });

const denseCity = (): InterviewContext =>
  contextFor({
    name: 'Harbour Metropolis',
    proseName: 'the city',
    tripDays: 8,
    entityType: 'city',
    breadth: 'city',
    semantic: { type: 'settlement', scale: 'settlement' },
    population: 7_500_000,
    center: { lat: 22.28, lng: 114.16 },
    startDate: '2027-07-10',
  });

const MOUNTAIN_SET = ['hike_appetite', 'altitude_comfort', 'permit_activities', 'day_start', 'rustic_lodging', 'base_moves', 'scenic_reach', 'transport_mode'] as const;
const URBAN_SET = ['walking_tolerance', 'transit_comfort', 'day_trips', 'late_nights', 'stairs_hills'] as const;

function relevant(plan: ReturnType<typeof planInterview>): Set<string> {
  return new Set(plan.questions.map((q) => q.id));
}

const TRIP: TravelerBriefTripFacts = { destination: 'the Canadian Rockies', nights: 7, days: 8, startDate: '2027-07-10', endDate: '2027-07-17', adults: 2, children: 0, arrival: 'in the afternoon', departure: 'in the morning', bookedFacts: [] };

function briefFor(answers: QuestionnaireAnswers): string {
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 8 });
  return renderTravelerBriefXml(buildTravelerBrief({ profile, trip: TRIP }));
}

describe('a mountain region, screened from its semantics', () => {
  it('carries the mountain traits and none of the city ones', () => {
    const ctx = mountainRegion();
    expect(ctx.destination.traits).toEqual(expect.arrayContaining(['mountain', 'weather_exposed', 'road_trip_region']));
    expect(ctx.destination.traits).not.toContain('dense_urban');
    expect(ctx.destination.traits).not.toContain('walk_heavy');
    expect(ctx.destination.traits).not.toContain('transit_rich');
    expect(ctx.destination.scaleLabel).toBe('A mountain region');
  });

  it('asks the physically meaningful questions and suppresses the urban ones', () => {
    const ctx = mountainRegion();
    const answers = fresh(ctx);
    const plan = planInterview({ ctx, answers });
    const ids = relevant(plan);
    for (const id of MOUNTAIN_SET) expect(ids.has(id), `${id} should be relevant for a mountain region`).toBe(true);
    for (const id of URBAN_SET) expect(ids.has(id), `${id} should not be asked for a mountain region`).toBe(false);
    /* Front-country or backcountry is relevant here; it enters the walk once the trail length is answered. */
    expect(questionById(ctx, answers, 'trail_setting')!.relevance(ctx, answers)).toBe(1);
    /* Driving comfort is a question once the traveller has said they will drive (it waits behind the transport question). */
    const driving = { ...answers, willDrive: true };
    expect(questionById(ctx, driving, 'road_comfort')!.relevance(ctx, driving)).toBe(1);
    expect(questionById(ctx, driving, 'daily_driving')!.relevance(ctx, driving)).toBe(1);
  });

  it('shows the trail, altitude, hike and lodging questions in the normal walk, and the permit question once the traveller digs deeper', () => {
    const ctx = mountainRegion();
    const answers = fresh(ctx);
    const plan = planInterview({ ctx, answers });
    expect(plan.shown).toContain('hike_appetite');
    expect(plan.shown).toContain('altitude_comfort');
    expect(plan.shown).toContain('rustic_lodging');
    expect(plan.shown).toContain('base_moves');
    /* Where the trail starts and ends is asked once its length is known. */
    const hike = questionById(ctx, answers, 'hike_appetite')!;
    const afterHike = answerQuestion({ answers, ctx, question: hike, value: 'full_day', now: NOW });
    expect(planInterview({ ctx, answers: afterHike }).shown).toContain('trail_setting');
    expect(relevant(plan).has('permit_activities')).toBe(true);
    expect(planInterview({ ctx, answers: afterHike, mode: 'deep' }).shown).toContain('permit_activities');
  });

  it('a dense city is the mirror image: the urban set is asked, the trail questions never are', () => {
    const ctx = denseCity();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    const ids = relevant(plan);
    expect(ctx.destination.traits).toContain('dense_urban');
    expect(ctx.destination.traits).not.toContain('mountain');
    for (const id of ['walking_tolerance', 'day_trips', 'late_nights'] as const) expect(ids.has(id), `${id} should be relevant for a city`).toBe(true);
    for (const id of ['trail_setting', 'permit_activities', 'altitude_comfort', 'rustic_lodging', 'road_comfort'] as const) expect(ids.has(id), `${id} should not be asked for a city`).toBe(false);
  });

  it('the wildlife interest is offered first-screen for a mountain region', () => {
    const ctx = mountainRegion();
    expect(ctx.traveller.offeredInterests).toContain('hiking');
    expect(ctx.traveller.offeredInterests).toContain('wildlife');
  });
});

describe('the two new answers reach the composition brief', () => {
  it('trail_setting changes the brief in both directions and a backcountry answer admits simple beds', () => {
    const ctx = mountainRegion();
    const base = fresh(ctx);
    const question = INTERVIEW_QUESTIONS.find((q) => q.id === 'trail_setting')!;
    expect(question).toBeDefined();
    const baseline = briefFor(base);
    const back = answerQuestion({ answers: { ...base, rusticLodgingOk: false }, ctx, question, value: 'backcountry', now: NOW });
    expect(back.trailSetting).toBe('backcountry');
    expect(back.rusticLodgingOk).toBe(true);
    expect(briefFor(back)).toContain('Trails: backcountry welcome');
    const front = answerQuestion({ answers: base, ctx, question, value: 'frontcountry', now: NOW });
    expect(briefFor(front)).toContain('Trails: front-country only');
    expect(briefFor(front)).not.toEqual(baseline);
  });

  it('permit_activities changes the brief and names what the composition must do about bookings', () => {
    const ctx = mountainRegion();
    const base = fresh(ctx);
    const question = questionById(ctx, base, 'permit_activities')!;
    const around = answerQuestion({ answers: base, ctx, question, value: 'build_around', now: NOW });
    expect(around.permitSensitiveActivities).toBe('build_around');
    expect(briefFor(around)).toContain('build the trip around them and list exactly what to book');
    const flexible = answerQuestion({ answers: base, ctx, question, value: 'keep_flexible', now: NOW });
    expect(briefFor(flexible)).not.toEqual(briefFor(around));
  });

  it('the profile carries both fields with their defaults for every answer set saved before this pass', () => {
    const profile = buildTravelerProfile(fresh(mountainRegion()), { travelerNeeds: [], tripDays: 8 });
    expect(profile.interview.trailSetting).toBe('mixed');
    expect(profile.interview.permitSensitiveActivities).toBe('keep_flexible');
  });
});
