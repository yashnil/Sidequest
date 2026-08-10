import { describe, expect, it } from 'vitest';
import {
  classifyPreferences,
  mustDoRequestsFrom,
  namesSomething,
  settleMustDoCoverage,
  type DestinationResearchReadiness,
  type InterpretationSet,
  type MustDoCoverage,
  type MustDoRequest,
  type Place,
} from '@sidequest/core';
import { mustDoCoverageFrom, resolveMustDos } from './must-do';

/**
 * CAN A TRAVELLER SAY "THIS ONE IS NON-NEGOTIABLE" AND TRUST THE ANSWER?
 *
 * Every case below is a sentence somebody could type and a set of records
 * somebody could have published. None of them names a real destination, and a
 * rule that needed to know which city it was looking at would have stopped
 * measuring identity and started remembering answers.
 *
 * The cases that matter most are the *negative* ones. It is easy to make a
 * resolver that finds things; the whole difficulty is making one that refuses,
 * out loud, when the only available match is the wrong attraction.
 */

function placeNamed(name: string, id = name.toLowerCase().replace(/\W+/g, '-')): Place {
  return {
    id,
    regionId: 'compiled-test',
    name,
    locality: 'Testville',
    shortDescription: `${name}, used to exercise the resolver.`,
    coordinates: { lat: 40.7, lng: -74 },
    tags: [],
    source: { name: 'Test', kind: 'curated', confidence: 0.9, lastVerified: '2026-01-01' },
    relationship: 'satellite',
    category: 'museum',
    interests: ['history_and_culture'],
    typicalDurationMinutes: 60,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.5,
    hiddenGemScore: 0.5,
    weather: {
      exposure: 'indoor',
      precipitation: 'low',
      wind: 'low',
      heat: 'low',
      cold: 'low',
      visibilityDependent: false,
      poorWeatherBackup: true,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: { roadSurface: 'paved', mountainRoad: false, parkingDifficulty: 'easy', remoteNoServices: false },
    travelFromBase: { distanceKm: 4, driveMinutes: 10, driveIsScenic: false },
  };
}

function request(quote: string, overrides: Partial<MustDoRequest> = {}): MustDoRequest {
  return {
    id: `mustdo:span:0`,
    kind: 'named_subject',
    source: 'composer_text',
    quote,
    span: [0, quote.length],
    namedExplicitly: true,
    ...overrides,
  };
}

describe('a place the traveller named that we found', () => {
  it('is covered, by name equality and not by similarity', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: { plannable: [placeNamed('Cutler Falls'), placeNamed('Harbour Museum')] },
    });
    expect(resolution?.status).toBe('covered');
    expect(resolution?.match?.name).toBe('Cutler Falls');
    expect(resolution?.match?.method).toBe('exact_name');
  });

  it('is found through a name the source itself publishes, and says which rule fired', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Old Quay Steps')],
      space: {
        plannable: [],
        groundRecords: [
          { id: 'r1', name: 'The Harbour Stair', alternateNames: ['Old Quay Steps'] },
        ],
      },
    });
    expect(resolution?.match?.method).toBe('published_alias');
  });

  it('is found inside a longer sentence when the name carries a distinguishing word', () => {
    const [resolution] = resolveMustDos({
      requests: [request('We want a sunrise at Cutler Falls before anything else')],
      space: { plannable: [placeNamed('Cutler Falls'), placeNamed('Harbour Museum')] },
    });
    expect(resolution?.status).toBe('covered');
    expect(resolution?.match?.method).toBe('named_within_request');
  });
});

describe('the refusals, which are the point', () => {
  /**
   * The failure this resolver exists to prevent. "A long afternoon in a big art
   * museum" is not a request for the one place in the region whose name happens
   * to contain the word museum, and any similarity threshold loose enough to
   * match it is loose enough to match the wrong thing constantly.
   */
  it('does not match a category word to a place that happens to contain it', () => {
    const plannable = [
      placeNamed('Harbour Museum'),
      placeNamed('Dockside Museum'),
      placeNamed('Hill Museum'),
      placeNamed('Cutler Falls'),
    ];
    const [resolution] = resolveMustDos({
      requests: [request('One long afternoon in a big art museum')],
      space: { plannable },
    });
    expect(resolution?.status).toBe('not_found');
    expect(resolution?.match).toBeUndefined();
  });

  /**
   * The case the run requirement alone cannot stop: a record whose entire
   * published name is a category noun. Matching it would hand somebody the wrong
   * attraction with a straight face.
   */
  it('refuses a one-word name that names half the region', () => {
    const plannable = [
      placeNamed('Museum', 'm0'),
      placeNamed('Harbour Museum', 'm1'),
      placeNamed('Dockside Museum', 'm2'),
      placeNamed('Hill Museum', 'm3'),
    ];
    const [resolution] = resolveMustDos({
      requests: [request('One long afternoon in a big art museum')],
      space: { plannable },
    });
    expect(resolution?.status).toBe('not_found');
  });

  /** The same rule, the other way: a one-word name nothing else shares is fine. */
  it('accepts a one-word name that picks out exactly one place', () => {
    const [resolution] = resolveMustDos({
      requests: [request('An afternoon at Alcazaba, if we can')],
      space: { plannable: [placeNamed('Alcazaba'), placeNamed('Harbour Museum')] },
    });
    expect(resolution?.status).toBe('covered');
    expect(resolution?.match?.method).toBe('named_within_request');
  });

  it('reports several matches rather than picking one', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: {
        plannable: [placeNamed('Cutler Falls', 'a'), placeNamed('Cutler Falls', 'b')],
      },
    });
    expect(resolution?.status).toBe('ambiguous');
    expect(resolution?.candidates.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
    expect(resolution?.match).toBeUndefined();
  });

  it('says nothing answers to a name nothing answers to', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Bellweather Observatory')],
      space: { plannable: [placeNamed('Cutler Falls')] },
    });
    expect(resolution?.status).toBe('not_found');
  });

  /**
   * A sentence with no proper noun in it is dropped rather than reported as a
   * shortfall. Reporting "we could not find *somewhere to potter about*" would
   * put an unfixable deficit on a very large share of trips, and the panel a
   * traveller ignores is worse than the panel they never see.
   */
  it('drops an unnamed preference instead of reporting it as a missing place', () => {
    const resolutions = resolveMustDos({
      requests: [
        request('somewhere we can potter about with no fixed plan', { namedExplicitly: false }),
      ],
      space: { plannable: [placeNamed('Cutler Falls')] },
    });
    expect(resolutions).toEqual([]);
  });

  it('keeps an unnamed phrase that turns out to match something real', () => {
    const resolutions = resolveMustDos({
      requests: [request('cutler falls', { namedExplicitly: false })],
      space: { plannable: [placeNamed('Cutler Falls')] },
    });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.status).toBe('covered');
  });
});

describe('what we found and cannot use', () => {
  it('names the closure rather than claiming we could not find it', () => {
    const shut = placeNamed('Cutler Falls');
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: { plannable: [], removed: [{ place: shut, outcome: 'removed_closed' }] },
    });
    expect(resolution?.status).toBe('unusable');
    expect(resolution?.obstacle).toBe('closed_on_your_dates');
    expect(resolution?.match?.id).toBe(shut.id);
  });

  it('names an unmeasurable journey as its own obstacle', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: {
        plannable: [],
        removed: [{ place: placeNamed('Cutler Falls'), outcome: 'removed_unreachable' }],
      },
    });
    expect(resolution?.obstacle).toBe('no_measurable_journey');
  });

  it('reports a record the containment layer placed elsewhere as outside the area', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: {
        plannable: [],
        groundRecords: [{ id: 'elsewhere', name: 'Cutler Falls' }],
        isOutsideDestination: (id) => id === 'elsewhere',
      },
    });
    expect(resolution?.status).toBe('outside_area');
  });

  /**
   * The same record, with the overlay saying nothing about it. Unplaced is not
   * outside — reporting it as outside would turn a hole in our own directory
   * into a statement about the traveller's destination.
   */
  it('does not call an unplaced record outside the area', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: {
        plannable: [],
        groundRecords: [{ id: 'elsewhere', name: 'Cutler Falls' }],
      },
    });
    expect(resolution?.status).toBe('unusable');
    expect(resolution?.obstacle).toBe('nothing_confirmed_about_it');
  });
});

describe('an area the traveller named', () => {
  it('is covered by the trip including it, without needing a place of that name', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Principe')],
      space: { plannable: [placeNamed('Cutler Falls')], areas: [{ id: 'a1', name: 'Príncipe' }] },
    });
    expect(resolution?.status).toBe('covered');
    expect(resolution?.match?.target).toBe('area');
  });
});

describe('a kind of thing rather than a named one', () => {
  it('is satisfied by any candidate of that kind, and several is not an ambiguity', () => {
    const [resolution] = resolveMustDos({
      requests: [
        request('the hot springs', {
          id: 'mustdo:interest:hot_springs',
          kind: 'experience',
          source: 'confirmed_preference',
          interest: 'history_and_culture',
        }),
      ],
      space: { plannable: [placeNamed('Harbour Museum'), placeNamed('Hill Museum')] },
    });
    expect(resolution?.status).toBe('covered');
    expect(resolution?.candidates).toHaveLength(2);
    /*
     * And no single match. Naming one of them would print it as "the" place they
     * asked for, and would make it hand-picked downstream — a place the traveller
     * chose by accident.
     */
    expect(resolution?.match).toBeUndefined();
  });

  it('is not found when nothing here is of that kind', () => {
    const [resolution] = resolveMustDos({
      requests: [
        request('the hot springs', {
          id: 'mustdo:interest:hot_springs',
          kind: 'experience',
          source: 'confirmed_preference',
          interest: 'hot_springs',
        }),
      ],
      space: { plannable: [placeNamed('Harbour Museum')] },
    });
    expect(resolution?.status).toBe('not_found');
  });
});

describe('a decision the traveller took', () => {
  it('withdraws a request without pretending it was found', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Bellweather Observatory')],
      space: { plannable: [placeNamed('Cutler Falls')] },
      decisions: [{ requestId: 'mustdo:span:0', kind: 'withdrawn', decidedAt: '2026-08-01T00:00:00Z' }],
    });
    expect(resolution?.status).toBe('withdrawn');
    expect(resolution?.match).toBeUndefined();
  });

  it('settles an ambiguity to the one they picked', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: { plannable: [placeNamed('Cutler Falls', 'a'), placeNamed('Cutler Falls', 'b')] },
      decisions: [
        { requestId: 'mustdo:span:0', kind: 'chose', chosenId: 'b', decidedAt: '2026-08-01T00:00:00Z' },
      ],
    });
    expect(resolution?.status).toBe('replaced');
    expect(resolution?.match?.id).toBe('b');
    expect(resolution?.match?.method).toBe('traveller_chose');
  });

  /**
   * A choice pointing at something this build no longer holds is not a choice.
   * Honouring it would be planning around an identifier with nothing behind it,
   * so the request goes back to the traveller rather than silently succeeding.
   */
  it('re-asks rather than honouring a choice whose subject is gone', () => {
    const [resolution] = resolveMustDos({
      requests: [request('Cutler Falls')],
      space: { plannable: [placeNamed('Cutler Falls', 'a'), placeNamed('Cutler Falls', 'b')] },
      decisions: [
        { requestId: 'mustdo:span:0', kind: 'chose', chosenId: 'gone', decidedAt: '2026-08-01T00:00:00Z' },
      ],
    });
    expect(resolution?.status).toBe('ambiguous');
  });
});

describe('turning what somebody typed into requests', () => {
  it('reads a proper noun out of the must-do box', () => {
    const set = classifyPreferences({ mustDo: 'We must see the Bellweather Observatory.' });
    const requests = mustDoRequestsFrom(set);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.kind).toBe('named_subject');
    expect(requests[0]?.quote).toContain('Bellweather Observatory');
  });

  /**
   * The case a leftovers-only rule would lose. "Museum" is in the phrase table,
   * so the parser resolves the clause to an interest and records no unresolved
   * span at all — and the one thing the traveller actually named would vanish.
   */
  it('reads a named place out of a clause the phrase table already matched', () => {
    const set = classifyPreferences({ mustDo: 'A day at the Bellweather Museum.' });
    expect(set.unresolved).toHaveLength(0);
    expect(set.chips.length).toBeGreaterThan(0);
    const requests = mustDoRequestsFrom(set);
    expect(requests.map((entry) => entry.kind)).toEqual(['named_subject']);
  });

  it('takes nothing from the avoid box', () => {
    const set = classifyPreferences({ avoid: 'The Bellweather Observatory, please not that.' });
    expect(mustDoRequestsFrom(set)).toEqual([]);
  });

  it('does not turn an ordinary sentence into a named requirement', () => {
    const set = classifyPreferences({ mustDo: 'We would like somewhere quiet to sit.' });
    expect(mustDoRequestsFrom(set).filter((entry) => entry.kind === 'named_subject')).toEqual([]);
  });

  it('reads a confirmed must-have preference as a kind of thing', () => {
    const parsed = classifyPreferences({ mustDo: 'We must go hiking.' });
    const confirmed: InterpretationSet = {
      ...parsed,
      confirmedAt: '2026-08-01T00:00:00Z',
      chips: parsed.chips.map((chip) => ({ ...chip, status: 'confirmed' as const })),
    };
    const requests = mustDoRequestsFrom(confirmed);
    expect(requests.some((entry) => entry.kind === 'experience')).toBe(true);
  });

  it('gives the same request the same id across two readings of the same text', () => {
    const text = 'We must see the Bellweather Observatory.';
    const first = mustDoRequestsFrom(classifyPreferences({ mustDo: text }));
    const second = mustDoRequestsFrom(classifyPreferences({ mustDo: text }));
    expect(first.map((entry) => entry.id)).toEqual(second.map((entry) => entry.id));
  });

  it('reads sentence case as sentence case, and a two-word capital run as a name', () => {
    expect(namesSomething('We must go hiking')).toBe(false);
    expect(namesSomething('Ghibli Museum')).toBe(true);
    expect(namesSomething('a day at Cutler Falls')).toBe(true);
  });
});

describe('applying a decision to a reading that was already written', () => {
  const coverage: MustDoCoverage = {
    schemaVersion: 1,
    resolutions: [
      {
        request: request('Bellweather Observatory'),
        status: 'not_found',
        candidates: [],
        detail: 'Nothing we found here answers to that name.',
      },
    ],
  };

  const readiness: DestinationResearchReadiness = {
    schemaVersion: 1,
    level: 'thin',
    funnel: {
      packRecords: 100,
      visitable: 12,
      anchors: 4,
      discoveries: 8,
      food: 5,
      support: 2,
      gateways: 1,
      anchorDemotions: 0,
      membershipUnverified: 0,
      tripDays: 4,
    },
    dimensions: [
      {
        dimension: 'must_do_coverage',
        state: 'unmet',
        detail: '1 of the 1 things you named is still unaccounted for.',
        required: true,
        observed: 0,
        expected: 1,
      },
    ],
    binding: ['must_do_coverage'],
    repairs: [],
    repairsAttempted: [],
    summary: '1 of the 1 things you named is still unaccounted for.',
  };

  it('returns exactly what it was given when nobody has decided anything', () => {
    const settled = settleMustDoCoverage({ coverage, readiness, decisions: [] });
    expect(settled.coverage).toBe(coverage);
    expect(settled.readiness).toBe(readiness);
  });

  it('clears the deficit once the traveller withdraws the request', () => {
    const settled = settleMustDoCoverage({
      coverage,
      readiness,
      decisions: [
        { requestId: 'mustdo:span:0', kind: 'withdrawn', decidedAt: '2026-08-02T00:00:00Z' },
      ],
    });
    expect(settled.coverage?.resolutions[0]?.status).toBe('withdrawn');
    expect(settled.readiness?.binding).toEqual([]);
    expect(settled.readiness?.level).toBe('ready');
  });
});

describe('the artifact-shaped value', () => {
  it('is absent when nobody named anything, rather than an empty claim', () => {
    expect(mustDoCoverageFrom([])).toBeUndefined();
  });
});
