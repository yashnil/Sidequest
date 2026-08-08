import { z } from 'zod';
import { isoDate } from './request';

/**
 * THE NEUTRAL PLAN.
 *
 * One shape, produced by converting either competitor's native output, and the
 * only shape the validators and the blind renderer ever see.
 *
 * The temptation this schema exists to resist is making it a slightly-relaxed
 * copy of the deterministic pipeline's `Itinerary`. That would decide the
 * benchmark before it ran: every `.refine`, every required evidence block and
 * every `.min(1)` in that schema is a convention one competitor agreed to and
 * the other never saw, and grading the second against them measures agreement
 * with Sidequest rather than usefulness to a traveller.
 *
 * So the rules here are:
 *
 * **Everything optional is optional for both.** A field either both systems can
 * populate or neither is required to. `hours`, `evidence`, `travel.minutes` and
 * the rest are absent-permitted, and absence means *not stated* — which the
 * validators score as lower verifiability, never as a defect. A renderer that
 * showed a section for one plan and hid it for the other would leak identity
 * through structure, so the absent case has an explicit rendering.
 *
 * **Unknown is representable everywhere it can happen.** `'unknown'` is a value,
 * not a missing key, wherever a system might genuinely have looked and failed.
 * That distinction — did not look, versus looked and could not tell — is one the
 * benchmark is specifically trying to measure.
 *
 * **Places are addressed by a shared identity.** Both systems draw from the same
 * open place inventory, so a stop carries the source-level id both can produce.
 * Name matching is banned: a validator that resolved "Convict Lake" by string
 * similarity would turn phrasing into a scoring axis.
 *
 * **There are no metrics in here.** Latency, cost, token counts and provider
 * calls live in a separate structure, because a semantic artifact that carries
 * its own clock cannot be compared byte for byte across two runs, and because
 * the blind renderer must be structurally unable to show a timing.
 */

export const BENCHMARK_PLAN_VERSION = 1 as const;

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * How a plan refers to somewhere in the world.
 *
 * `entityId` is the shared inventory identity where the system had one. When it
 * did not — a model naming a place it knows about that the inventory does not
 * hold — the reference is still legal, carries `null`, and every check that
 * needed ground truth about it returns `unknown` rather than an error. Inventing
 * an id would be worse than admitting the gap.
 */
export const placeRefSchema = z.object({
  entityId: z.string().min(1).nullable(),
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
});
export type PlaceRef = z.infer<typeof placeRefSchema>;

/**
 * A pointer into the plan's own `sources` list.
 *
 * An integer index rather than a URL, and that is a security property rather
 * than a convenience: a model that can emit a URL string can be told by a
 * hostile page to emit `javascript:`, and that string would land in an `href`
 * the reviewer's browser renders. The only strings in `sources` came from the
 * provider layer.
 */
export const evidenceRefSchema = z.object({
  sourceIndex: z.number().int().min(0),
  /** Which kind of fact this supports, so a validator can check the right one. */
  factPath: z.string().min(1).optional(),
  /** The value as the plan states it, for comparison against the source. */
  statedValue: z.string().min(1).optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const sourceSchema = z.object({
  /** Host only. Never a full URL in the rendered surface. */
  host: z.string().min(1),
  title: z.string().min(1).optional(),
  /** Retained for the post-reveal diagnostics view; never rendered pre-reveal. */
  url: z.string().url().optional(),
  retrievedAt: z.string().datetime().optional(),
});

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

export const BLOCK_KINDS = [
  'activity',
  'travel',
  'meal',
  'free_time',
  'rest',
  'transfer',
] as const;
export const blockKindSchema = z.enum(BLOCK_KINDS);
export type BlockKind = z.infer<typeof blockKindSchema>;

export const TRAVEL_MODES = [
  'walk',
  'drive',
  'transit',
  'rail',
  'bus',
  'ferry',
  'shuttle',
  'bicycle',
  'taxi',
  'unknown',
] as const;
export const travelModeSchema = z.enum(TRAVEL_MODES);

/**
 * How a stated travel time came to be known.
 *
 * `measured` means a routing engine answered for this pair. `unknown` means
 * nobody measured it — and a plan that states a number anyway is asserting
 * something no provider produced, which is exactly the failure the validators
 * look for. There is deliberately no `estimated` that a system could reach for
 * to make an invented number look sourced.
 */
export const TRAVEL_PROVENANCES = ['measured', 'published_timetable', 'unknown'] as const;
export const travelProvenanceSchema = z.enum(TRAVEL_PROVENANCES);

export const travelDetailSchema = z.object({
  mode: travelModeSchema,
  from: placeRefSchema.nullable().default(null),
  to: placeRefSchema.nullable().default(null),
  /** Null means the plan did not state a duration. Never a stand-in for zero. */
  minutes: z.number().int().min(0).max(2880).nullable().default(null),
  km: z.number().min(0).max(20000).nullable().default(null),
  provenance: travelProvenanceSchema,
});

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export const mealSlotSchema = z.enum(MEAL_SLOTS);

export const MEAL_STOP_KINDS = ['venue', 'grocery', 'packed', 'unstated'] as const;
export const mealStopKindSchema = z.enum(MEAL_STOP_KINDS);

export const mealDetailSchema = z.object({
  slot: mealSlotSchema,
  stopKind: mealStopKindSchema,
  venue: placeRefSchema.nullable().default(null),
  /** Minutes off the day's route this meal costs, when the plan states it. */
  detourMinutes: z.number().int().min(0).max(600).nullable().default(null),
});

/**
 * The opening window a visit claims to sit inside.
 *
 * Optional for both systems, and its absence is never a defect — a roadside
 * viewpoint has no gate, and a planner that did not look up hours has told the
 * truth by saying nothing. What *is* checkable is a plan that states a window
 * and then schedules outside it, and a plan that states a window no source
 * supports.
 */
export const openingClaimSchema = z.object({
  openMinute: z.number().int().min(0).max(1440),
  closeMinute: z.number().int().min(0).max(2880),
  lastAdmissionMinute: z.number().int().min(0).max(2880).optional(),
  evidence: evidenceRefSchema.optional(),
});

export const planBlockSchema = z
  .object({
    kind: blockKindSchema,
    title: z.string().min(1).max(300),
    /** Minutes from local midnight. Null when the plan gives no clock time. */
    startMinute: z.number().int().min(0).max(1440).nullable().default(null),
    endMinute: z.number().int().min(0).max(2880).nullable().default(null),
    place: placeRefSchema.nullable().default(null),
    travel: travelDetailSchema.nullable().default(null),
    meal: mealDetailSchema.nullable().default(null),
    opening: openingClaimSchema.nullable().default(null),
    /** Why the plan put this here. Prose, shown to the reviewer. */
    note: z.string().max(1500).default(''),
    /** Anything the plan is explicitly unsure about for this block. */
    uncertainty: z.array(z.string().min(1).max(300)).max(10).default([]),
    evidence: z.array(evidenceRefSchema).max(10).default([]),
  })
  .refine(
    (block) =>
      block.startMinute === null ||
      block.endMinute === null ||
      block.endMinute >= block.startMinute,
    { message: 'A block cannot end before it starts', path: ['endMinute'] },
  );
export type PlanBlock = z.infer<typeof planBlockSchema>;

/* ------------------------------------------------------------------ *
 * Days and bases
 * ------------------------------------------------------------------ */

export const planBaseSchema = z.object({
  id: z.string().min(1),
  place: placeRefSchema,
  nights: z.number().int().min(0).max(60),
  fromDate: isoDate.nullable().default(null),
  toDate: isoDate.nullable().default(null),
  why: z.string().max(1000).default(''),
});

export const planDaySchema = z.object({
  dayNumber: z.number().int().min(1),
  date: isoDate,
  /** Which base the traveller sleeps at that night, when the plan says. */
  baseId: z.string().min(1).nullable().default(null),
  theme: z.string().max(200).default(''),
  blocks: z.array(planBlockSchema).max(60).default([]),
  /**
   * What the plan itself claims about the day, kept apart from the blocks so a
   * validator can catch a plan that disagrees with its own timeline. A stated
   * total that does not match the blocks is an internal contradiction, and it is
   * the one class of defect that is always decidable without any world data.
   */
  statedTotals: z
    .object({
      travelMinutes: z.number().int().min(0).max(2880).nullable().default(null),
      driveMinutes: z.number().int().min(0).max(2880).nullable().default(null),
      freeMinutes: z.number().int().min(0).max(2880).nullable().default(null),
      /**
       * WHETHER THESE WERE ADDED UP FROM THE VERY ITEMS THEY DESCRIBE.
       *
       * One converter copies the planner's own totals, which that planner
       * computed by summing exactly the items that become these blocks. The two
       * then agree by arithmetic identity, and a *critical* check for an internal
       * contradiction became a check one arm could only ever pass — while the
       * other converter deliberately refuses to derive its totals, on the stated
       * grounds that deriving them would make the check pass for ever.
       *
       * The rule was right and was applied to one converter. Marking the
       * provenance lets it be applied to both: derived totals are reported as
       * unknown rather than as a pass, because a tautology is not evidence.
       */
      derived: z.boolean().default(false),
    })
    .default({ travelMinutes: null, driveMinutes: null, freeMinutes: null, derived: false }),
  /** Somewhere else to go if the day does not work. Never scheduled. */
  alternatives: z
    .array(
      z.object({
        place: placeRefSchema,
        trigger: z.string().min(1).max(300),
        why: z.string().max(500).default(''),
      }),
    )
    .max(10)
    .default([]),
  warnings: z.array(z.string().min(1).max(500)).max(20).default([]),
});
export type PlanDay = z.infer<typeof planDaySchema>;

/* ------------------------------------------------------------------ *
 * Generation state
 * ------------------------------------------------------------------ */

/**
 * How the run ended, from the plan's own point of view.
 *
 * `partial` and `failed` are results, not absences. A failed run still produces
 * a plan row — with whatever it managed, and with the failure named — because a
 * benchmark that quietly dropped its failures would report a success rate of one
 * hundred per cent for whichever system fell over most often.
 */
export const GENERATION_STATES = ['complete', 'partial', 'failed'] as const;
export const generationStateSchema = z.enum(GENERATION_STATES);
export type GenerationState = z.infer<typeof generationStateSchema>;

export const FAILURE_KINDS = [
  'provider_unavailable',
  'model_unavailable',
  'malformed_output',
  'schema_rejected',
  'budget_exhausted',
  'insufficient_data',
  'timeout',
  'cancelled',
  'internal_error',
] as const;
export const failureKindSchema = z.enum(FAILURE_KINDS);

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

export const benchmarkPlanSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_PLAN_VERSION),
  planId: z.string().min(1),
  requestId: z.string().min(1),
  /**
   * Which system produced it.
   *
   * Present in storage and absent from anything the pre-reveal renderer
   * receives. The route builds an explicit neutral projection rather than
   * passing this object with a field the component happens not to read — a
   * value handed to a client component is serialised into the page whether or
   * not it is rendered, and that is the leak nobody sees in the browser.
   */
  producedBy: z.enum(['sidequest', 'baseline']),
  generationState: generationStateSchema,
  failureKind: failureKindSchema.nullable().default(null),
  /** Neutral, system-agnostic sentence. Never provider or model wording. */
  failureDetail: z.string().max(500).nullable().default(null),

  summary: z.string().max(4000).default(''),
  destination: placeRefSchema,
  /** How wide the plan understood the destination to be, in its own words. */
  scopeNote: z.string().max(1000).default(''),
  startDate: isoDate,
  endDate: isoDate,

  bases: z.array(planBaseSchema).max(20).default([]),
  days: z.array(planDaySchema).max(40).default([]),

  /** Things the plan considered and deliberately left out, with reasons. */
  exclusions: z
    .array(
      z.object({
        place: placeRefSchema,
        reason: z.string().min(1).max(500),
        /**
         * WHETHER THE SYSTEM WROTE THIS DOWN OR THE CONVERTER SWEPT IT UP.
         *
         * A must-do that appears here is graded as deferred-with-a-reason rather
         * than ignored, and that downgrade turned on a converter habit: one
         * system's converter fills this from the planner's whole reject pile —
         * up to sixty entries, everything it considered — and the other fills it
         * only from what the model chose to say. So the same dropped must-do was
         * critical for one and major for the other, for a reason that is about
         * how a list is populated rather than about a planning decision.
         *
         * The flag does not change the grade. It makes the difference legible
         * on the finding and on the report, so a reader can tell "the system said
         * why" from "the system's candidate list happened to contain it".
         */
        derived: z.boolean().default(false),
      }),
    )
    .max(60)
    .default([]),
  /** What the plan says it does not know. A populated list is a good sign. */
  unknowns: z.array(z.string().min(1).max(500)).max(60).default([]),
  preparation: z.array(z.string().min(1).max(500)).max(60).default([]),
  warnings: z.array(z.string().min(1).max(500)).max(60).default([]),
  sources: z.array(sourceSchema).max(200).default([]),
});
export type BenchmarkPlan = z.infer<typeof benchmarkPlanSchema>;

/**
 * What the blind renderer is allowed to receive.
 *
 * `producedBy` is gone by construction rather than by discipline. A function
 * that returns this type cannot leak the system, and every route feeding the
 * pre-reveal UI returns this type.
 */
export type BlindPlan = Omit<BenchmarkPlan, 'producedBy'>;

export function toBlindPlan(plan: BenchmarkPlan): BlindPlan {
  const { producedBy: _producedBy, ...rest } = plan;
  return rest;
}
