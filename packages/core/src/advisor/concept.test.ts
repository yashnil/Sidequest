import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '../schemas/composer';
import { emptyAdvisorAnswers } from './answers';
import { buildAdvisorShortlist } from './advise';
import { destinationCatalog } from './catalog/index';
import { asDestination, type Destination } from './destination';
import { durationVerdict, readConcept, staysNeeded, vacationFit } from './concept';
import { parseTravelRequest } from './parse';

const NOW = new Date('2026-11-12T12:00:00Z');
function base(): TripComposerAnswers {
  return { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month', wantsRecommendation: false }, discovery: emptyAdvisorAnswers() };
}
const says = (text: string) => (pattern: RegExp) => pattern.test(` ${text.toLowerCase()} `);
const catalog = destinationCatalog();
const byId = (id: string): Destination => asDestination(catalog.find((entry) => entry.id === id)!);

/** A destination built from the first catalog entry, with the attributes a test cares about overridden. */
function place(overrides: Partial<Destination>): Destination {
  return { ...asDestination(catalog[0]!), id: 'test', name: 'Test', bases: ['A'], radiusKm: 50, ...overrides };
}

const OWNER_REQUEST =
  'I want to go on a trip with my family over spring, March 19-29. Preferably a nice retreat. I want to feel good because life has been stressful recently. Outdoors stuff.';

describe('reading what kind of vacation a request describes', () => {
  it('reads the owner’s request as a restful family trip in nature, and says so', () => {
    const parsed = parseTravelRequest(OWNER_REQUEST, base(), NOW);
    const concept = parsed.answers.discovery?.concept ?? [];
    expect(concept.map((entry) => entry.key)).toEqual(['restoration', 'family_bonding', 'scenic_nature']);
    expect(concept[0]!.weight).toBeGreaterThan(0.35);
    /* "Retreat" is no longer a spa booking, and the emotional words never become search terms. */
    expect(parsed.answers.discovery?.pursuits ?? []).not.toContain('wellness');
    expect(parsed.answers.discovery?.terms ?? []).not.toEqual(expect.arrayContaining(['stressful']));
    expect(parsed.answers.discovery?.terms ?? []).not.toEqual(expect.arrayContaining(['life']));
    /* Stated back as a travel preference, never as a statement about the person. */
    expect(parsed.assumptions.join(' ')).toMatch(/come back rested/);
    expect(parsed.assumptions.join(' ')).not.toMatch(/stress/i);
    /* "With my family" is read as a family, without inventing children. */
    expect(parsed.readings.some((reading) => reading.kind === 'party' && reading.label === 'With family')).toBe(true);
    expect(parsed.answers.children).toBe(0);
  });

  it('respects negation and keeps a stated activity in charge', () => {
    const beach = parseTravelRequest('No hiking please, just a beach holiday in May.', base(), NOW);
    expect(beach.answers.discovery?.concept?.map((entry) => entry.key)).not.toContain('active_hiking');
    expect(beach.answers.discovery?.concept?.map((entry) => entry.key)).toContain('beach_resort');
    const ski = parseTravelRequest('A family ski week at February half term, gentle slopes and a village, from the UK.', base(), NOW);
    expect(ski.answers.discovery?.focus).toContain('snow');
    expect(ski.answers.discovery?.concept?.map((entry) => entry.key)).toContain('family_bonding');
  });

  it('separates a multi-day trek from a day of hiking, and a moderate budget from a budget trip', () => {
    expect(readConcept('two weeks of trekking, moderate budget', says('two weeks of trekking, moderate budget')).concept.map((c) => c.key)).toEqual(['trekking']);
    expect(readConcept('cheap backpacking around asia', says('cheap backpacking around asia')).concept.map((c) => c.key)).toContain('budget');
  });

  it('softens a hike when rest is the point', () => {
    const reading = readConcept('burnt out, want gentle hikes and a quiet lake', says('burnt out, want gentle hikes and a quiet lake'));
    expect(reading.concept[0]!.key).toBe('restoration');
  });
});

describe('scoring the whole trip against the kind of trip', () => {
  const restful = [{ key: 'restoration' as const, weight: 1 }];

  it('tells a gentle hot-spring region from a trek-built one', () => {
    const gentle = place({ experiences: { hot_springs_wellness: 3, lakes: 3, rainforest_biodiversity: 2 }, challenge: { easiest: 0, typical: 1 }, lodging: { simple: true, comfortable: true, luxury: true }, access: { ...asDestination(catalog[0]!).access, car: 'unnecessary', transit: 'good', reach: 1 }, remoteness: 0 });
    const trek = place({ experiences: { multi_day_trekking: 3, villages_culture: 3, hot_springs_wellness: 2 }, challenge: { easiest: 1, typical: 2 }, lodging: { simple: true, comfortable: true, luxury: false }, access: { ...asDestination(catalog[0]!).access, car: 'unnecessary', transit: 'limited', reach: 1 }, remoteness: 1 });
    const a = vacationFit(gentle, restful, { nights: 10, kids: false })!;
    const b = vacationFit(trek, restful, { nights: 10, kids: false })!;
    expect(a.value).toBeGreaterThan(b.value + 0.2);
    expect(b.against.join(' ')).toMatch(/built around multi-day trekking/);
    expect(a.carries).toEqual(expect.arrayContaining(['hot springs', 'lakes']));
  });

  it('never marks a place down for comfort it has no reading for', () => {
    const unknown = vacationFit(place({ lodging: null, experiences: { lakes: 3 } }), restful, { nights: 7, kids: false })!;
    const simple = vacationFit(place({ lodging: { simple: true, comfortable: false, luxury: false }, experiences: { lakes: 3 } }), restful, { nights: 7, kids: false })!;
    expect(unknown.value).toBeGreaterThan(simple.value);
  });

  it('lets a stated adventure level outrank what “outdoors” assumes', () => {
    const rugged = place({ challenge: { easiest: 2, typical: 3 }, experiences: { high_mountains: 3, multi_day_trekking: 3 } });
    const concept = [{ key: 'scenic_nature' as const, weight: 1 }];
    expect(vacationFit(rugged, concept, { nights: 7, kids: false, adventure: 2 })!.value).toBeGreaterThan(vacationFit(rugged, concept, { nights: 7, kids: false })!.value);
  });

  it('counts the places to sleep a trip needs, not the towns a region lists', () => {
    expect(staysNeeded(place({ bases: ['A', 'B', 'C', 'D'], radiusKm: 60 }))).toBe(1);
    expect(staysNeeded(place({ bases: ['A', 'B', 'C', 'D'], radiusKm: 320 }))).toBe(3);
  });

  it('says when the stay is longer than the place deserves', () => {
    expect(durationVerdict(place({ nights: { min: 3, ideal: 5, max: 6 } }), 10).overlong).toBe(true);
    expect(durationVerdict(place({ nights: { min: 3, ideal: 5, max: 6 } }), 7).overlong).toBe(false);
  });
});

describe('the shortlist a restful family trip gets', () => {
  const answers = parseTravelRequest(OWNER_REQUEST, base(), NOW).answers;
  const list = buildAdvisorShortlist({ answers, catalog, catalogVersion: 'test', now: NOW });

  it('offers places that suit the kind of trip, each with a distinct reason', () => {
    expect(list.picks).toHaveLength(3);
    for (const pick of list.picks) {
      expect(pick.feel?.value ?? 0).toBeGreaterThanOrEqual(0.75);
      expect(byId(pick.id).challenge.easiest).toBeLessThanOrEqual(1);
    }
    const whys = list.picks.map((pick) => pick.why);
    expect(new Set(whys).size).toBe(whys.length);
    for (const why of whys) expect(why).not.toMatch(/^Strong on/);
  });

  it('never suggests more nights than a place carries, and says what to do with the rest', () => {
    for (const pick of [...list.picks, ...list.alternates]) {
      expect(pick.nights.suggested).toBeLessThanOrEqual(pick.nights.max);
      if (pick.length) expect(pick.length.note).toMatch(/^Best for \d/);
    }
  });

  it('explains what changed, with reasons, when an answer changes the list', () => {
    const next = buildAdvisorShortlist({
      answers: { ...answers, discovery: { ...answers.discovery!, focus: ['beaches'], focusRanked: true } },
      catalog,
      catalogVersion: 'test',
      now: NOW,
      previous: list,
    });
    const added = next.changes.filter((line) => line.startsWith('New: '));
    const dropped = next.changes.filter((line) => line.startsWith('Dropped: '));
    for (const line of [...added, ...dropped]) expect(line).toMatch(/^(New|Dropped): .+ — .+\.$/);
    expect(added.length + dropped.length + next.changes.filter((line) => line.startsWith('Still here') || line.startsWith('Nothing better')).length).toBeGreaterThan(0);
  });
});
