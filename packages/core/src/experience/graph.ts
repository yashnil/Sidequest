import { z } from 'zod';
import { coordinatesSchema } from '../schemas/common';

/**
 * V10 §4 §13 — HIERARCHICAL EXPERIENCES, AND WHY TRANSPORT IS NOT ONE.
 *
 * A flat list of stops cannot say what a trip actually contains. Two failures
 * from the founder's trips are the same failure:
 *
 * - **A glacier lagoon and the beach its icebergs wash onto** came out as two
 *   stops with a 24-minute drive between them. They are one experience: the
 *   lagoon, the shore across the road, and — if the traveller wants it — a boat
 *   among the bergs. Flat stops double-count it, and the boat becomes
 *   "transport between two attractions".
 * - **Two upper trails sharing one lakeshore trailhead**, with a tea house
 *   sitting on one of them, can only be said as "two places with a drive between
 *   them", which is false, or by silently dropping one.
 *
 * So an experience is a tree:
 *
 *   experience  ── the thing a traveller would name and remember
 *     access    ── how you get *to* it and back: a trailhead, a shuttle stop,
 *                  a ferry pier, a car park. Part of the experience's own cost.
 *     components ── what happens inside it: a viewpoint, a tea house, a boat
 *                  tour, a beach, a game drive, a hut. Each may have its own
 *                  duration, reservation, time-of-day intent and effort — and
 *                  each may itself contain movement.
 *
 * **The invariant this exists for (§13, §22):** movement *inside* an experience
 * is never transportation between itinerary stops. Transportation connects
 * places; a boat tour, a gondola, a scenic cruise, a trail segment or a game
 * drive is a component, and `transportBetweenStops()` refuses to treat one as a
 * leg. That is what stops a flat representation double-counting one connected
 * experience, and it is checked, not hoped for.
 */

export const EXPERIENCE_COMPONENT_KINDS = [
  /** A place you stand and look. */
  'viewpoint',
  /** Somewhere inside the experience you eat or drink: a tea house, a lodge bar, a refuge. */
  'refreshment',
  /** A guided or ticketed movement that is the point, not the transfer: a boat tour, a gondola, a game drive, a scenic train. */
  'guided_movement',
  /** A stretch of trail, road or water covered under your own effort. */
  'traverse',
  /** A distinct sub-place inside the experience: a beach, a cave, a summit, a waterhole. */
  'sub_place',
  /** A night spent inside the experience: a hut, a camp, a vessel berth. */
  'overnight',
] as const;
export const experienceComponentKindSchema = z.enum(EXPERIENCE_COMPONENT_KINDS);
export type ExperienceComponentKind = z.infer<typeof experienceComponentKindSchema>;

/** Component kinds that contain movement. None of them is ever a leg between stops. */
export const MOVING_COMPONENT_KINDS: ReadonlySet<ExperienceComponentKind> = new Set<ExperienceComponentKind>(['guided_movement', 'traverse']);

export const ACCESS_LEG_MODES = ['walk', 'drive', 'shuttle', 'ferry', 'boat', 'gondola', 'cog_rail', 'transit', 'guided_transfer'] as const;
export const accessLegModeSchema = z.enum(ACCESS_LEG_MODES);
export type AccessLegMode = z.infer<typeof accessLegModeSchema>;

export const experienceAccessSchema = z.object({
  /** The place a traveller actually starts from: a trailhead, a pier, a shuttle stop, a car park. */
  label: z.string().min(1).max(120),
  mode: accessLegModeSchema,
  coordinates: coordinatesSchema.optional(),
  /** Minutes each way, when known. Unknown stays unknown. */
  minutesEachWay: z.number().int().nonnegative().max(600).optional(),
  /**
   * True when the mode is the *only* legal way in — a shuttle-only lake, a
   * ferry-only island, a permit-only trail. §22: this may never be rendered as
   * generic car travel.
   */
  required: z.boolean().default(false),
  /** A reservation is needed for the access itself, separately from the experience. */
  reservationRequired: z.boolean().default(false),
  note: z.string().max(240).optional(),
});
export type ExperienceAccess = z.infer<typeof experienceAccessSchema>;

export const experienceComponentSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  kind: experienceComponentKindSchema,
  coordinates: coordinatesSchema.optional(),
  minutes: z.number().int().nonnegative().max(1440).optional(),
  /** True when this component is what makes the experience worth doing. */
  defining: z.boolean().default(false),
  /** True when the component is optional: the experience still works without it. */
  optional: z.boolean().default(false),
  reservationRequired: z.boolean().default(false),
  /** `sunrise`, `sunset`, `morning`, `afternoon`, `evening`, `night` — the component's own timing intent. */
  timeOfDay: z.string().min(1).max(24).optional(),
  note: z.string().max(240).optional(),
});
export type ExperienceComponent = z.infer<typeof experienceComponentSchema>;

export const EXPERIENCE_GRAPH_VERSION = 1 as const;

export const experienceNodeSchema = z.object({
  id: z.string().min(1).max(64),
  /** The anchor this experience corresponds to on the itinerary, when it has one. */
  anchorId: z.string().min(1).max(96).optional(),
  name: z.string().min(1).max(120),
  dayNumber: z.number().int().positive().optional(),
  coordinates: coordinatesSchema.optional(),
  access: z.array(experienceAccessSchema).max(4).default([]),
  components: z.array(experienceComponentSchema).max(12).default([]),
  /** Minutes for the experience as a whole, when it is not simply the sum of its components. */
  minutes: z.number().int().nonnegative().max(4320).optional(),
  /** Days the experience spans, for a trek, cruise or safari circuit. */
  dayNumbers: z.array(z.number().int().positive()).max(30).default([]),
});
export type ExperienceNode = z.infer<typeof experienceNodeSchema>;

export const experienceGraphSchema = z.object({
  version: z.literal(EXPERIENCE_GRAPH_VERSION),
  experiences: z.array(experienceNodeSchema).max(80).default([]),
});
export type ExperienceGraph = z.infer<typeof experienceGraphSchema>;

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

export interface TransportVerdict {
  /** True when a leg between these two itinerary stops is real transportation. */
  isTransport: boolean;
  /** When it is not: which experience contains the movement, and which component it is. */
  containedBy?: { experienceId: string; experienceName: string; componentId?: string; componentName?: string };
  reason: string;
}

/**
 * V10 §13 — MAY A LEG BE DRAWN BETWEEN THESE TWO STOPS?
 *
 * No, when both are inside one experience: the movement between a lagoon and the
 * beach its icebergs reach, or between a trailhead and a tea house on the trail,
 * belongs to the experience, and drawing it as transport both invents a drive
 * and double-counts the experience. No, when one of them is a moving component —
 * a boat tour is not how you get from the beach to the lagoon, it is what you do
 * at the lagoon.
 */
export function transportBetweenStops(input: {
  graph: ExperienceGraph;
  fromRef: string;
  toRef: string;
}): TransportVerdict {
  const { graph, fromRef, toRef } = input;
  if (fromRef === toRef) return { isTransport: false, reason: 'the leg starts and ends at the same place' };
  for (const experience of graph.experiences) {
    const refs = new Set<string>([experience.id, ...(experience.anchorId ? [experience.anchorId] : [])]);
    const componentByRef = new Map<string, ExperienceComponent>();
    for (const component of experience.components) {
      refs.add(component.id);
      componentByRef.set(component.id, component);
    }
    for (const access of experience.access) refs.add(accessRefOf(experience.id, access));
    const fromInside = refs.has(fromRef);
    const toInside = refs.has(toRef);
    if (!fromInside || !toInside) {
      /* One end inside and the other outside is a real leg: you do drive to the trailhead. */
      continue;
    }
    const moving = [componentByRef.get(fromRef), componentByRef.get(toRef)].find((c) => c && MOVING_COMPONENT_KINDS.has(c.kind));
    return {
      isTransport: false,
      containedBy: {
        experienceId: experience.id,
        experienceName: experience.name,
        ...(moving ? { componentId: moving.id, componentName: moving.name } : {}),
      },
      reason: moving
        ? `${moving.name} happens inside ${experience.name}; it is what you do there, not how you get between two places`
        : `both ends are part of ${experience.name}`,
    };
  }
  return { isTransport: true, reason: 'the two ends belong to different experiences' };
}

/** A stable reference for one access point of one experience. */
export function accessRefOf(experienceId: string, access: Pick<ExperienceAccess, 'label'>): string {
  return `${experienceId}::${access.label.toLowerCase().replace(/\W+/g, '-')}`;
}

/**
 * Every reference an experience owns — itself, its anchor, its components, its
 * access points. Used to answer "is this one thing or two?" without any name
 * matching.
 */
export function refsOf(experience: ExperienceNode): Set<string> {
  const refs = new Set<string>([experience.id, ...(experience.anchorId ? [experience.anchorId] : [])]);
  for (const component of experience.components) refs.add(component.id);
  for (const access of experience.access) refs.add(accessRefOf(experience.id, access));
  return refs;
}

/**
 * V10 §22 — a flat representation may not double-count one connected
 * experience. Returns the references that appear in more than one experience,
 * and the pairs of stop references that a flat list would have counted twice.
 */
export function doubleCounted(input: { graph: ExperienceGraph; stopRefs: readonly string[] }): { experienceId: string; experienceName: string; refs: string[] }[] {
  const out: { experienceId: string; experienceName: string; refs: string[] }[] = [];
  for (const experience of input.graph.experiences) {
    const refs = refsOf(experience);
    const hits = input.stopRefs.filter((ref) => refs.has(ref));
    if (hits.length > 1) out.push({ experienceId: experience.id, experienceName: experience.name, refs: hits });
  }
  return out;
}

/** The minutes an experience costs in total: its own figure, or access plus every non-optional component. */
export function experienceMinutes(experience: ExperienceNode): number | null {
  if (experience.minutes !== undefined) return experience.minutes;
  let total = 0;
  let known = false;
  for (const access of experience.access) {
    if (access.minutesEachWay === undefined) continue;
    known = true;
    total += access.minutesEachWay * 2;
  }
  for (const component of experience.components) {
    if (component.optional || component.minutes === undefined) continue;
    known = true;
    total += component.minutes;
  }
  return known ? total : null;
}

/** Access a traveller cannot substitute: the shuttle, ferry or permit that is the only way in. */
export function requiredAccess(graph: ExperienceGraph): { experience: ExperienceNode; access: ExperienceAccess }[] {
  const out: { experience: ExperienceNode; access: ExperienceAccess }[] = [];
  for (const experience of graph.experiences) for (const access of experience.access) if (access.required) out.push({ experience, access });
  return out;
}
