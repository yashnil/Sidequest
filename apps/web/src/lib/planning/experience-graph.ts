import {
  evaluateAccess,
  experienceGraphSchema,
  type AccessConstraint,
  type ExperienceAccess,
  type ExperienceComponent,
  type ExperienceGraph,
  type ExperienceNode,
  type RequiredAccessMode,
} from '@sidequest/core';
import { draftAnchorId, type TripDraft } from './trip-draft';

/**
 * V10 §4 §13 — DERIVING THE EXPERIENCE GRAPH FROM EVIDENCE, NOT FROM A GUESS.
 *
 * `packages/core/src/experience/graph.ts` holds the shape and the invariants. This
 * builds one for a real draft, and it is deliberately conservative: a hierarchy
 * invented by a heuristic would merge two genuinely separate museums into one
 * "experience" and then refuse to draw the walk between them, which is a new lie
 * in place of an old one.
 *
 * So only two things create structure, and both are evidence:
 *
 * 1. **A required access mode from an official access constraint.** Where a park
 *    service says the only way in is the shuttle, the shuttle is an access leg on
 *    that experience and §22 forbids the plan representing it as a drive. Fully
 *    sourced; no inference at all.
 * 2. **Containment the draft states itself.** An anchor whose own `locality` names
 *    another anchor on the same day (a beach whose locality is the lagoon it
 *    belongs to) is a component of it, and an anchor whose name contains
 *    another's (a tea house named after the lake it sits above) is a component of
 *    that. The model said so; nothing is read from coordinates, and two stops
 *    that merely sit near each other stay two stops.
 *
 * Everything the schema can hold that this cannot yet derive — a boat tour inside
 * a lagoon, a tea house on a trail, a hut-to-hut segment — reaches the graph from
 * the access-constraint layer or from a later pass, and is representable today,
 * which is what §4 asks of the schema.
 */

const MIN_CONTAINMENT_LENGTH = 6;

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function accessModeFor(mode: RequiredAccessMode): ExperienceAccess['mode'] {
  switch (mode) {
    case 'shuttle':
      return 'shuttle';
    case 'ferry':
      return 'ferry';
    case 'boat':
      return 'boat';
    case 'transit':
      return 'transit';
    case 'guided':
      return 'guided_transfer';
    case 'foot_only':
      return 'walk';
    default:
      /* A permit or a high-clearance vehicle is still a drive; what it needs is a document or a vehicle, not another mode. */
      return 'drive';
  }
}

export interface DeriveExperienceGraphInput {
  draft: TripDraft;
  /** Dates the trip covers, so a seasonal constraint is evaluated against the day it would apply on. */
  datesByDay: ReadonlyMap<number, string>;
  accessConstraints: readonly AccessConstraint[];
  /** Provider place ids for anchors that resolved, keyed by the anchor id, so a constraint can match by reference. */
  placeIdByAnchor?: ReadonlyMap<string, string>;
}

export function deriveExperienceGraph(input: DeriveExperienceGraphInput): ExperienceGraph {
  const experiences: ExperienceNode[] = [];

  for (const day of input.draft.days) {
    const anchors = day.anchors.map((anchor, index) => ({ anchor, index, id: draftAnchorId(day.dayNumber, index, anchor.name) }));
    /** Which anchor each one is a component of, by the draft's own words. */
    const parentOf = new Map<string, string>();
    for (const child of anchors) {
      const locality = normalize(child.anchor.locality ?? '');
      const childName = normalize(child.anchor.name);
      for (const parent of anchors) {
        if (parent.id === child.id) continue;
        const parentName = normalize(parent.anchor.name);
        if (parentName.length < MIN_CONTAINMENT_LENGTH) continue;
            /* A beach whose locality is the lagoon, or a tea house whose name carries the lake's. */
        const statedByLocality = locality.length > 0 && (locality === parentName || locality.includes(parentName));
        const statedByName = childName !== parentName && childName.includes(parentName);
        if (statedByLocality || statedByName) {
          parentOf.set(child.id, parent.id);
          break;
        }
      }
    }

    for (const { anchor, id } of anchors) {
      if (parentOf.has(id)) continue;
      const components: ExperienceComponent[] = anchors
        .filter((candidate) => parentOf.get(candidate.id) === id)
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.anchor.name,
          kind: candidate.anchor.category === 'food' ? ('refreshment' as const) : candidate.anchor.category === 'viewpoint' ? ('viewpoint' as const) : ('sub_place' as const),
          ...(candidate.anchor.estimatedDurationMinutes !== undefined ? { minutes: candidate.anchor.estimatedDurationMinutes } : {}),
          defining: candidate.anchor.role === 'core',
          optional: candidate.anchor.role === 'optional' || candidate.anchor.role === 'flex',
          reservationRequired: false,
          ...(candidate.anchor.timeOfDay && candidate.anchor.timeOfDay !== 'any' ? { timeOfDay: candidate.anchor.timeOfDay } : {}),
        }));

      /* The access an official source says is the only way in. */
      const date = input.datesByDay.get(day.dayNumber);
      const verdict = input.accessConstraints.length > 0
        ? evaluateAccess({
            constraints: input.accessConstraints,
            placeName: anchor.name,
            ...(input.placeIdByAnchor?.get(id) ? { placeRef: input.placeIdByAnchor.get(id)! } : {}),
            dates: date ? [date] : [],
          })
        : null;
      const access: ExperienceAccess[] = [];
      if (verdict?.requiredMode) {
        access.push({
          label: `${anchor.name} access`,
          mode: accessModeFor(verdict.requiredMode),
          required: true,
          reservationRequired: verdict.reservationRequired,
          ...(verdict.travellerNote ? { note: verdict.travellerNote } : {}),
        });
      }

      /* An experience with no structure at all is a flat stop, and does not belong in the graph. */
      if (components.length === 0 && access.length === 0) continue;
      experiences.push({
        id,
        anchorId: id,
        name: anchor.name,
        dayNumber: day.dayNumber,
        access,
        components,
        dayNumbers: [],
      });
    }
  }

  return experienceGraphSchema.parse({ version: 1, experiences: experiences.slice(0, 80) });
}
