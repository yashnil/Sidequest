import { describe, expect, it } from 'vitest';
import { doubleCounted, requiredAccess, transportBetweenStops, type AccessConstraint } from '@sidequest/core';
import { deriveExperienceGraph } from './experience-graph';
import { tripDraftSchema, type TripDraft } from './trip-draft';
import { draftOf } from './acceptance/harness';

/**
 * V10 §4 §13 §22 — what the derivation may and may not conclude.
 *
 * The test that matters most is the negative one: two stops that merely sit near
 * each other are two stops, and the graph does not invent a hierarchy that would
 * then refuse to draw the walk between them.
 */
const SHUTTLE: AccessConstraint = {
  id: 'shuttle-only',
  placeName: 'Upper Lake',
  status: 'restricted',
  requiredMode: 'shuttle',
  reservationRequired: true,
  authority: 'official_current',
  sourceName: 'The park service access page',
  checkedAt: '2026-09-12',
  travellerNote: 'Private vehicles are not admitted; the way in is the park shuttle, reserved ahead.',
};

const dates = new Map([
  [1, '2026-09-21'],
  [2, '2026-09-22'],
]);

function draftWith(anchors: Parameters<typeof draftOf>[0]['days'][number]['anchors']): TripDraft {
  return tripDraftSchema.parse(draftOf({ bases: [{ id: 'b', name: 'Base Town', nights: 1 }], days: [{ base: 'b', anchors }, { base: 'b', anchors: [] }] }));
}

describe('deriving the experience graph', () => {
  it('makes a component of a stop whose own locality names another stop on the day', () => {
    const draft = draftWith([
      { name: 'Glacier Lagoon', category: 'water', role: 'core', minutes: 60 },
      { name: 'Iceberg Beach', category: 'beach', role: 'core', minutes: 45, locality: 'Glacier Lagoon' },
    ]);
    const graph = deriveExperienceGraph({ draft, datesByDay: dates, accessConstraints: [] });
    expect(graph.experiences).toHaveLength(1);
    const experience = graph.experiences[0]!;
    expect(experience.name).toBe('Glacier Lagoon');
    expect(experience.components.map((c) => c.name)).toEqual(['Iceberg Beach']);
    /* And the leg between them is not transportation. */
    expect(transportBetweenStops({ graph, fromRef: experience.id, toRef: experience.components[0]!.id }).isTransport).toBe(false);
  });

  it('makes a component of a stop whose name contains another stop on the day', () => {
    const draft = draftWith([
      { name: 'Upper Lake', category: 'water', role: 'core', minutes: 120 },
      { name: 'Upper Lake Tea House', category: 'food', role: 'optional', minutes: 40 },
    ]);
    const graph = deriveExperienceGraph({ draft, datesByDay: dates, accessConstraints: [] });
    expect(graph.experiences).toHaveLength(1);
    expect(graph.experiences[0]!.components[0]!.kind).toBe('refreshment');
    expect(graph.experiences[0]!.components[0]!.optional).toBe(true);
  });

  it('does NOT invent a hierarchy for two unrelated stops on the same day', () => {
    const draft = draftWith([
      { name: 'City Museum', category: 'museum', role: 'core', minutes: 90 },
      { name: 'Harbour Gallery', category: 'museum', role: 'secondary', minutes: 60 },
    ]);
    const graph = deriveExperienceGraph({ draft, datesByDay: dates, accessConstraints: [] });
    /* No structure means no entry: a flat stop stays a flat stop. */
    expect(graph.experiences).toEqual([]);
    /* And a leg between them is still a real leg. */
    expect(transportBetweenStops({ graph, fromRef: 'a', toRef: 'b' }).isTransport).toBe(true);
  });

  it('turns an official required mode into a required access leg, never a note', () => {
    const draft = draftWith([{ name: 'Upper Lake', category: 'water', role: 'core', minutes: 120 }]);
    const graph = deriveExperienceGraph({ draft, datesByDay: dates, accessConstraints: [SHUTTLE] });
    const required = requiredAccess(graph);
    expect(required).toHaveLength(1);
    expect(required[0]!.access.mode).toBe('shuttle');
    expect(required[0]!.access.required).toBe(true);
    expect(required[0]!.access.reservationRequired).toBe(true);
    expect(required[0]!.access.note).toContain('park shuttle');
  });

  it('does not apply a seasonal constraint to a day outside its window', () => {
    const seasonal: AccessConstraint = { ...SHUTTLE, id: 'summer-only', validFrom: '2027-06-01', validUntil: '2027-09-30' };
    const draft = draftWith([{ name: 'Upper Lake', category: 'water', role: 'core', minutes: 120 }]);
    expect(deriveExperienceGraph({ draft, datesByDay: dates, accessConstraints: [seasonal] }).experiences).toEqual([]);
  });

  it('catches a flat list counting one derived experience twice', () => {
    const draft = draftWith([
      { name: 'Glacier Lagoon', category: 'water', role: 'core', minutes: 60 },
      { name: 'Iceberg Beach', category: 'beach', role: 'core', minutes: 45, locality: 'Glacier Lagoon' },
    ]);
    const graph = deriveExperienceGraph({ draft, datesByDay: dates, accessConstraints: [] });
    const refs = [graph.experiences[0]!.id, graph.experiences[0]!.components[0]!.id];
    expect(doubleCounted({ graph, stopRefs: refs })).toHaveLength(1);
    expect(doubleCounted({ graph, stopRefs: [refs[0]!] })).toEqual([]);
  });

  it('ignores a containment claim too short to mean anything', () => {
    const draft = draftWith([
      { name: 'Lake', category: 'water', role: 'core', minutes: 60 },
      { name: 'Lakeside Cafe', category: 'food', role: 'optional', minutes: 30 },
    ]);
    /* "Lake" is four characters; treating every name containing it as a component would swallow half a trip. */
    expect(deriveExperienceGraph({ draft, datesByDay: dates, accessConstraints: [] }).experiences).toEqual([]);
  });
});
