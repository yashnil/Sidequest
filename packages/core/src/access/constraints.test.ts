import { describe, expect, it } from 'vitest';
import { accessConstraintSetSchema, describeAccess, evaluateAccess, type AccessConstraint } from './constraints';

/**
 * V10 §9 — the operational fixtures the brief names, as data. Nothing in the
 * planner branches on these names; they are rows, loaded and passed in, and the
 * tests below are about the *rules*, which is why each one also has a
 * counterpart from a different place entirely.
 */
const MORAINE: AccessConstraint = {
  id: 'moraine-lake-shuttle-2026',
  placeName: 'Moraine Lake',
  status: 'restricted',
  requiredMode: 'shuttle',
  reservationRequired: true,
  validFrom: '2026-06-01',
  validUntil: '2026-10-12',
  authority: 'official_current',
  sourceName: 'Parks Canada — Lake Louise and Moraine Lake access',
  sourceUrl: 'https://parks.canada.ca/pn-np/ab/banff/visit/parkbus',
  checkedAt: '2026-09-12',
  travellerNote: 'Personal vehicles are not admitted on the Moraine Lake road; the only way in is the shuttle or a licensed operator, and seats are reserved ahead.',
};

const MALIGNE: AccessConstraint = {
  id: 'maligne-canyon-closure-2026',
  placeName: 'Maligne Canyon',
  status: 'seasonal_closure',
  reservationRequired: false,
  validFrom: '2026-04-01',
  validUntil: '2026-11-30',
  authority: 'official_current',
  sourceName: 'Parks Canada — Jasper National Park important bulletins',
  sourceUrl: 'https://parks.canada.ca/pn-np/ab/jasper/visit/avis-notices',
  checkedAt: '2026-09-12',
  travellerNote: 'Maligne Canyon is closed for the 2026 season while the trail and bridges are rebuilt.',
  alternative: 'Sunwapta Falls and Athabasca Falls are open and give the same canyon-and-water day.',
};

/** Somebody on a forum says a road is shut. Real information, not an authority. */
const RUMOUR: AccessConstraint = {
  id: 'rumour-icefields',
  placeName: 'Icefields Parkway',
  status: 'closed',
  reservationRequired: false,
  authority: 'crowd',
  sourceName: 'A traveller forum thread',
  checkedAt: '2026-09-12',
  travellerNote: 'A traveller report says the Parkway is shut; nothing official says so.',
};

const FERRY: AccessConstraint = {
  id: 'heimaey-ferry',
  placeName: 'Heimaey',
  status: 'restricted',
  requiredMode: 'ferry',
  reservationRequired: true,
  authority: 'operator',
  sourceName: 'Herjólfur timetable',
  checkedAt: '2026-09-12',
  travellerNote: 'Heimaey is reached by the Landeyjahöfn ferry, and a car space has to be booked.',
};

const SET = accessConstraintSetSchema.parse({ version: 1, constraints: [MORAINE, MALIGNE, RUMOUR, FERRY] });
const SEPT = ['2026-09-21', '2026-09-22'];
const JANUARY = ['2027-01-14'];

describe('access constraints', () => {
  it('makes a shuttle-only lake a dependency, not a parking note', () => {
    const verdict = evaluateAccess({ constraints: SET.constraints, placeName: 'Moraine Lake', dates: SEPT });
    expect(verdict.status).toBe('restricted');
    expect(verdict.requiredMode).toBe('shuttle');
    expect(verdict.dependency).toBe(true);
    expect(verdict.blocking).toBe(false);
    expect(describeAccess('Moraine Lake', verdict)).toBe('Moraine Lake requires a shuttle — reserve this.');
  });

  it('keeps the closure inside its own season and says nothing outside it', () => {
    const inside = evaluateAccess({ constraints: SET.constraints, placeName: 'Maligne Canyon', dates: SEPT });
    expect(inside.status).toBe('seasonal_closure');
    expect(inside.blocking).toBe(true);
    expect(describeAccess('Maligne Canyon', inside)).toContain('Sunwapta Falls');

    const outside = evaluateAccess({ constraints: SET.constraints, placeName: 'Maligne Canyon', dates: JANUARY });
    expect(outside.status).toBe('unknown');
    expect(outside.blocking).toBe(false);
    expect(outside.travellerNote).toBeNull();
  });

  it('will not rearrange a plan on a forum post, and still tells the traveller somebody said it', () => {
    const verdict = evaluateAccess({ constraints: SET.constraints, placeName: 'Icefields Parkway', dates: SEPT });
    expect(verdict.status).toBe('unknown');
    expect(verdict.blocking).toBe(false);
    expect(verdict.travellerNote).toContain('nothing official says so');
  });

  it('treats an operator as authoritative about its own service', () => {
    const verdict = evaluateAccess({ constraints: SET.constraints, placeName: 'Heimaey', dates: SEPT });
    expect(verdict.status).toBe('restricted');
    expect(verdict.requiredMode).toBe('ferry');
    expect(describeAccess('Heimaey', verdict)).toBe('Heimaey is reached by ferry — reserve this.');
  });

  it('answers "nothing is known" for a place nobody has a row for, and never "open"', () => {
    const verdict = evaluateAccess({ constraints: SET.constraints, placeName: 'Vestrahorn', dates: SEPT });
    expect(verdict.status).toBe('unknown');
    expect(verdict.basis).toEqual([]);
    expect(verdict.travellerNote).toBeNull();
    expect(describeAccess('Vestrahorn', verdict)).toBeNull();
  });

  it('prefers the official row when an official and an unofficial row disagree', () => {
    const official: AccessConstraint = { ...RUMOUR, id: 'official-parkway', status: 'open', authority: 'official_current', sourceName: 'Parks Canada road report', travellerNote: 'The Parkway is open.' };
    const verdict = evaluateAccess({ constraints: [RUMOUR, official], placeName: 'Icefields Parkway', dates: SEPT });
    expect(verdict.status).toBe('open');
    expect(verdict.blocking).toBe(false);
  });

  it('matches on a provider reference before a name', () => {
    const byRef: AccessConstraint = { ...MORAINE, id: 'by-ref', placeName: 'Something else entirely', placeRef: 'google-places:abc' };
    const verdict = evaluateAccess({ constraints: [byRef], placeName: 'Moraine Lake', placeRef: 'google-places:abc', dates: SEPT });
    expect(verdict.requiredMode).toBe('shuttle');
  });

  it('refuses a claim with no source name', () => {
    expect(accessConstraintSetSchema.safeParse({ version: 1, constraints: [{ ...MORAINE, sourceName: '' }] }).success).toBe(false);
  });
});
