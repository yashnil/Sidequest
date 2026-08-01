import { describe, expect, it } from 'vitest';
import {
  buildPreparation,
  factIndependenceKey,
  isEnforceable,
  parseOsmOpeningHours,
  rankConflictingFacts,
  resolveFacts,
  resolutionKey,
  shelfLifeFor,
  type FactPath,
  type PlaceEvidence,
  type SourceFact,
} from '../index';

const NOW = new Date('2026-08-01T09:00:00.000Z');

function fact(overrides: Partial<SourceFact> & { id: string }): SourceFact {
  return {
    subjectId: 'place-1',
    factPath: 'hours.weekly',
    kind: 'operating_hours',
    statement: 'Open 09:00 to 17:00.',
    authorityKind: 'operator',
    authorityName: 'The operator',
    sourceUrl: 'https://operator.example/visit',
    sourceDomain: 'operator.example',
    retrievedAt: '2026-07-25T00:00:00.000Z',
    derivation: 'directly_stated',
    volatility: 'seasonal_recurring',
    recheckRequired: false,
    evidenceExcerpt: 'Open 09:00 to 17:00.',
    ...overrides,
  } as SourceFact;
}

describe('the deterministic fact resolver', () => {
  it('accepts the more authoritative source when two disagree, and keeps both', () => {
    const result = resolveFacts({
      facts: [
        fact({
          id: 'guide',
          statement: 'Open 10:00 to 16:00.',
          authorityKind: 'authoritative_secondary',
          authorityName: 'A guide',
          sourceDomain: 'guide.example',
          sourceUrl: 'https://guide.example/hours',
        }),
        fact({ id: 'operator' }),
      ],
      now: NOW,
    });

    const entry = result.byKey.get(resolutionKey('place-1', 'hours.weekly'))!;
    expect(entry.acceptedFactId).toBe('operator');
    expect(entry.state).toBe('conflicted');
    // Both survive: a traveller is told the sources disagree, never shown an average.
    expect(entry.factIds).toHaveLength(2);
    expect(entry.rationale).toContain('disagree');
  });

  it('never lets a planner enforce a conflicted fact', () => {
    expect(isEnforceable('conflicted')).toBe(false);
    expect(isEnforceable('verified')).toBe(true);
    expect(isEnforceable('single_source')).toBe(true);
    expect(isEnforceable('stale')).toBe(false);
  });

  it('never accepts a model inference over a sourced fact', () => {
    const result = resolveFacts({
      facts: [
        fact({
          id: 'model',
          authorityKind: 'model_inference',
          authorityName: 'A model',
          derivation: 'model_inference',
          sourceUrl: undefined,
          sourceDomain: undefined,
          evidenceExcerpt: undefined,
        }),
        fact({ id: 'operator' }),
      ],
      now: NOW,
    });
    expect(result.resolved[0]!.acceptedFactId).toBe('operator');
  });

  it('cannot rise above "inferred" when a model is the only voice', () => {
    const result = resolveFacts({
      facts: [
        fact({
          id: 'model',
          authorityKind: 'model_inference',
          authorityName: 'A model',
          derivation: 'model_inference',
          sourceUrl: undefined,
          sourceDomain: undefined,
        }),
      ],
      now: NOW,
    });
    expect(result.resolved[0]!.state).toBe('inferred');
  });

  it('counts two pages on one domain as one voice, not as corroboration', () => {
    const result = resolveFacts({
      facts: [
        fact({
          id: 'a',
          authorityKind: 'authoritative_secondary',
          sourceUrl: 'https://guide.example/one',
          sourceDomain: 'guide.example',
        }),
        fact({
          id: 'b',
          authorityKind: 'authoritative_secondary',
          sourceUrl: 'https://guide.example/two',
          sourceDomain: 'guide.example',
        }),
      ],
      now: NOW,
    });
    expect(result.resolved[0]!.independentSources).toBe(1);
    expect(result.resolved[0]!.state).toBe('single_source');
  });

  it('counts the same bytes on two domains as one voice', () => {
    const shared = 'sha-identical';
    const result = resolveFacts({
      facts: [
        fact({
          id: 'a',
          authorityKind: 'authoritative_secondary',
          sourceDomain: 'one.example',
          contentHash: shared,
        }),
        fact({
          id: 'b',
          authorityKind: 'authoritative_secondary',
          sourceDomain: 'two.example',
          contentHash: shared,
        }),
      ],
      now: NOW,
    });
    expect(result.resolved[0]!.independentSources).toBe(1);
  });

  it('earns corroboration from two genuinely independent secondary sources', () => {
    const result = resolveFacts({
      facts: [
        fact({
          id: 'a',
          authorityKind: 'authoritative_secondary',
          sourceDomain: 'one.example',
          contentHash: 'sha-a',
        }),
        fact({
          id: 'b',
          authorityKind: 'authoritative_secondary',
          sourceDomain: 'two.example',
          contentHash: 'sha-b',
        }),
      ],
      now: NOW,
    });
    expect(result.resolved[0]!.independentSources).toBe(2);
    expect(result.resolved[0]!.state).toBe('corroborated');
  });

  it('declines to group facts it cannot tell apart, rather than crediting them', () => {
    const bare = fact({ id: 'bare', sourceUrl: undefined, sourceDomain: undefined });
    expect(factIndependenceKey(bare)).toBe('fact:bare');
  });

  it('ages a fact out on its own path policy when it declared no shelf life', () => {
    const result = resolveFacts({
      facts: [fact({ id: 'old', retrievedAt: '2026-01-01T00:00:00.000Z' })],
      now: NOW,
    });
    // hours.weekly ages in 90 days; seven months is well past it.
    expect(result.resolved[0]!.state).toBe('stale');
  });

  it('ages a closure notice far faster than a place identity', () => {
    expect(shelfLifeFor('hours.closure')).toBeLessThan(shelfLifeFor('identity.officialSite'));
    expect(shelfLifeFor('safety.caution')).toBeLessThan(shelfLifeFor('duration.typical'));
  });

  it('reports a path nobody answered as unknown rather than omitting it', () => {
    const result = resolveFacts({
      facts: [],
      wanted: [{ subjectId: 'place-1', factPath: 'cost.admission' as FactPath }],
      now: NOW,
    });
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]!.state).toBe('unknown');
    expect(result.resolved[0]!.acceptedFactId).toBeUndefined();
  });

  it('distinguishes a page it could not read from a question nobody answered', () => {
    const result = resolveFacts({
      facts: [fact({ id: 'dead', retrievalStatus: 'fetch_failed' })],
      now: NOW,
    });
    expect(result.resolved[0]!.state).toBe('unavailable');
  });

  it('prefers structured data over prose from the same publisher', () => {
    const ranked = rankConflictingFacts([
      fact({ id: 'prose' }),
      fact({ id: 'structured', retrievalStatus: 'structured_data', evidenceField: 'openingHours' }),
    ]);
    expect(ranked[0]!.id).toBe('structured');
  });

  it('prefers a dated page over an undated one at equal authority', () => {
    const ranked = rankConflictingFacts([
      fact({ id: 'undated' }),
      fact({ id: 'dated', publishedAt: '2026-06-01' }),
    ]);
    expect(ranked[0]!.id).toBe('dated');
  });

  it('is deterministic: the same facts resolve to the same bytes', () => {
    const facts = [fact({ id: 'a' }), fact({ id: 'b', sourceDomain: 'other.example' })];
    const first = resolveFacts({ facts, now: NOW });
    const second = resolveFacts({ facts: [...facts].reverse(), now: NOW });
    expect(JSON.stringify(first.resolved)).toBe(JSON.stringify(second.resolved));
  });
});

describe('the OpenStreetMap opening-hours reader', () => {
  it('reads a plain weekday range', () => {
    const parsed = parseOsmOpeningHours('Mo-Fr 09:00-17:00');
    expect(parsed?.kind).toBe('scheduled');
    expect(parsed?.periods[0]?.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parsed?.periods[0]?.windows[0]).toEqual({ openMinute: 540, closeMinute: 1020 });
  });

  it('reads a split service day', () => {
    const parsed = parseOsmOpeningHours('Mo-Sa 10:00-14:00,15:00-18:00');
    expect(parsed?.periods[0]?.windows).toHaveLength(2);
  });

  it('reads a seasonal month range', () => {
    const parsed = parseOsmOpeningHours('Apr-Oct Mo-Su 08:00-20:00');
    expect(parsed?.periods[0]?.months).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it('reads 24/7 as always open rather than as a schedule', () => {
    expect(parseOsmOpeningHours('24/7')?.kind).toBe('always_open');
  });

  it('keeps an explicit closure clause as prose rather than dropping it', () => {
    const parsed = parseOsmOpeningHours('Mo-Fr 09:00-17:00; PH off');
    expect(parsed?.closedNote).toContain('PH off');
  });

  it('refuses anything it does not fully model, rather than reading it in part', () => {
    // Each of these would produce a plausible-looking partial calendar if the
    // parser guessed, and each would send somebody to a locked gate.
    for (const value of [
      'Mo-Fr 09:00-17:00; Sa["by appointment"]',
      'sunrise-sunset',
      'Mo[1] 09:00-17:00',
      'Mo-Fr 09:00-17:00 || "call ahead"',
      'Jan 01-Feb 14 09:00-17:00',
    ]) {
      expect(parseOsmOpeningHours(value), value).toBeNull();
    }
  });

  it('refuses two clauses that both claim the same weekday', () => {
    expect(parseOsmOpeningHours('Mo-Fr 09:00-12:00; We-Th 14:00-18:00')).toBeNull();
  });

  it('refuses an overnight window rather than wrapping it', () => {
    expect(parseOsmOpeningHours('Mo-Fr 22:00-02:00')).toBeNull();
  });
});

describe('the preparation checklist', () => {
  const evidence = {
    version: 1 as const,
    places: [
      {
        subjectId: 'place-1',
        aliases: [],
        booking: {
          reservationRequired: 'yes' as const,
          timedEntry: 'yes' as const,
          permitRequired: 'no' as const,
          guideRequired: 'unknown' as const,
          leadTimeDays: 14,
          bookingUrl: 'https://operator.example/tickets',
          claim: { factId: 'f1', state: 'verified' as const },
        },
        costs: [],
        closures: [],
        safety: [
          {
            statement: 'The upper path is exposed and needs proper footwear.',
            severity: 'cautions' as const,
            requires: ['Walking boots'],
            claim: { factId: 'f2', state: 'verified' as const },
          },
        ],
        resolved: [],
      } satisfies PlaceEvidence,
      {
        subjectId: 'place-not-scheduled',
        aliases: [],
        booking: {
          reservationRequired: 'yes' as const,
          timedEntry: 'unknown' as const,
          permitRequired: 'unknown' as const,
          guideRequired: 'unknown' as const,
          bookingUrl: 'https://elsewhere.example/book',
          claim: { state: 'verified' as const },
        },
        costs: [],
        closures: [],
        safety: [],
        resolved: [],
      } satisfies PlaceEvidence,
    ],
    regionSafety: [],
  };

  const names = new Map([
    ['place-1', 'The Museum'],
    ['place-2', 'The Viewpoint'],
  ]);

  it('lists only what the plan actually schedules', () => {
    const items = buildPreparation({
      evidence,
      scheduledSubjectIds: ['place-1'],
      namesById: names,
    });
    expect(items.some((item) => item.subjectId === 'place-not-scheduled')).toBe(false);
  });

  it('turns a booking requirement into a booking item with its official link', () => {
    const items = buildPreparation({
      evidence,
      scheduledSubjectIds: ['place-1'],
      namesById: names,
    });
    const book = items.find((item) => item.kind === 'book');
    expect(book?.text).toContain('timed-entry slot');
    expect(book?.text).toContain('14 days');
    expect(book?.url).toBe('https://operator.example/tickets');
  });

  it('lists required kit separately from cautions', () => {
    const items = buildPreparation({
      evidence,
      scheduledSubjectIds: ['place-1'],
      namesById: names,
    });
    expect(items.find((item) => item.kind === 'bring')?.text).toBe('Walking boots');
  });

  it('asks the traveller to check anything the plan assumes and nobody published', () => {
    const items = buildPreparation({
      evidence,
      scheduledSubjectIds: ['place-1', 'place-2'],
      namesById: names,
      unverifiedHoursSubjectIds: ['place-2'],
    });
    const check = items.find((item) => item.kind === 'check');
    expect(check?.subjectName).toBe('The Viewpoint');
    expect(check?.text).toContain('opening hours');
  });

  it('produces nothing at all when a region carries no evidence', () => {
    expect(
      buildPreparation({ evidence: undefined, scheduledSubjectIds: ['place-1'], namesById: names }),
    ).toEqual([]);
  });
});
