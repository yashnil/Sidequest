import { z } from 'zod';
import { SAFE_PROSE_PATTERN, SAFE_SLUG_PATTERN } from '@/lib/benchmark/baseline/generate';

/**
 * THE TRIP DRAFT — THE CANONICAL TRAVELLER-FACING CONTENT SIDEQUEST VERIFIES.
 *
 * "The model composes. Sidequest verifies, corrects, enriches and presents."
 * This schema is what the one composition call returns and it is the
 * *content draft* of the finished itinerary, not planner internals: bases and
 * nights, a sequence of experiences per day with the reason each is there,
 * meal intent, lodging guidance, food and transport strategy, preparation,
 * packing, backups and the omissions the model made on purpose.
 *
 * Deliberately absent, because the model is never authoritative for them:
 * provider ids, coordinates, measured durations, opening hours, permit
 * availability, prices, legal/visa facts. Every anchor is a *name* plus a
 * locality hint; identity, routing, hours and access are resolved afterwards
 * by `reconcile.ts` against Sidequest's own evidence, and anything that
 * cannot be verified stays in the trip marked as unverified rather than being
 * deleted (`unknown != false`).
 *
 * Every prose field reuses the baseline composer's `SAFE_PROSE_PATTERN` (no
 * URLs, no markup), and every array is bounded, so the wire size is
 * predictable — see `trip-draft-budget.test.ts` for the measured ceiling.
 */
export const TRIP_DRAFT_SCHEMA_VERSION = 1 as const;

export function prose(max: number): z.ZodString {
  return z.string().max(max).regex(SAFE_PROSE_PATTERN);
}
const slug = () => z.string().max(40).regex(SAFE_SLUG_PATTERN);

export const TRIP_ARCHETYPES = ['single_base', 'moving_route', 'loop'] as const;
export type TripArchetype = (typeof TRIP_ARCHETYPES)[number];

/** A small closed vocabulary so the reconciler can pick sensible default durations and the UI a plate colour. */
export const ANCHOR_CATEGORIES = [
  'landmark',
  'nature',
  'hike',
  'viewpoint',
  'water',
  'wildlife',
  'geothermal',
  'museum',
  'historic',
  'neighbourhood',
  'market',
  'food',
  'activity',
  'scenic_drive',
  'beach',
  'town',
  'relaxation',
  'other',
] as const;
export type AnchorCategory = (typeof ANCHOR_CATEGORIES)[number];

/** `core` is what the day is for; `secondary` fits around it; `optional`/`flex` are the first to give way when a hard constraint bites. */
export const ANCHOR_ROLES = ['core', 'secondary', 'optional', 'flex'] as const;
export type AnchorRole = (typeof ANCHOR_ROLES)[number];

/**
 * How the traveller reaches this experience, as the model expects it — a
 * hint the reconciler carries into `travel.mode` where Sidequest can measure
 * the leg, and reports honestly ("local arrangement, not measured") where it
 * cannot. Deliberately wider than the road/rail set the routing provider
 * measures: a boat leg into a delta or a lodge transfer is a real, plannable
 * movement that no road router will ever answer for.
 */
export const DRAFT_TRANSPORTS = [
  'walk',
  'metro',
  'rail',
  'bus',
  'car',
  'ferry',
  'boat',
  'flight',
  'private_transfer',
  'four_wheel_drive',
  'guide_or_lodge_transfer',
  'unknown',
] as const;
export type DraftTransport = (typeof DRAFT_TRANSPORTS)[number];

export const DRAFT_SOFT_PROSE_CAPS = {
  purpose: 240,
  routeRationale: 240,
  assumption: 120,
  tradeoff: 120,
  baseWhy: 140,
  lodgingArea: 80,
  lodgingStyle: 60,
  dayTheme: 100,
  dayNote: 160,
  whyItFits: 160,
  meal: 100,
  anchorWhy: 140,
  omissionReason: 140,
  unresolvedItem: 160,
  foodStrategy: 140,
  transportSummary: 200,
  transportNote: 140,
  beforeYouGo: 140,
  packing: 80,
  backupTrigger: 100,
  backupAlternative: 140,
} as const;

export const draftAnchorSchema = z.object({
  /** The place's own real name. Identity is resolved by Sidequest afterwards. */
  name: prose(60),
  /** A town, region or landmark to disambiguate the name — "near Vík", "Westfjords". */
  locality: prose(40).optional(),
  category: z.enum(ANCHOR_CATEGORIES),
  role: z.enum(ANCHOR_ROLES),
  /** The model's rough sense of time on site, minutes. Only used until Sidequest has a better figure; never presented as more than an estimate. */
  estimatedDurationMinutes: z.number().int().min(10).max(600).optional(),
  transport: z.enum(DRAFT_TRANSPORTS).optional(),
  why: prose(DRAFT_SOFT_PROSE_CAPS.anchorWhy),
});
export type DraftAnchor = z.infer<typeof draftAnchorSchema>;

export const draftBaseSchema = z.object({
  id: slug(),
  name: prose(100),
  locality: prose(40).optional(),
  nights: z.number().int().min(0).max(60),
  why: prose(DRAFT_SOFT_PROSE_CAPS.baseWhy),
  /** The neighbourhood or part of town to sleep in, when the model has a real opinion. */
  lodgingArea: prose(DRAFT_SOFT_PROSE_CAPS.lodgingArea).optional(),
  /** "guesthouse", "mid-range hotel near the harbour", "mountain lodge" — style, never a named hotel as a promise. */
  lodgingStyle: prose(DRAFT_SOFT_PROSE_CAPS.lodgingStyle).optional(),
});
export type DraftBase = z.infer<typeof draftBaseSchema>;

export const draftMealsSchema = z.object({
  breakfast: prose(DRAFT_SOFT_PROSE_CAPS.meal).optional(),
  lunch: prose(DRAFT_SOFT_PROSE_CAPS.meal).optional(),
  dinner: prose(DRAFT_SOFT_PROSE_CAPS.meal).optional(),
});

export const draftDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(40),
  /** Which base the traveller sleeps at *that night* (the last day's base is where they leave from). */
  baseId: slug(),
  theme: prose(DRAFT_SOFT_PROSE_CAPS.dayTheme),
  intensity: z.enum(['light', 'moderate', 'intense']),
  /** True when this day moves from the previous base to a new one. */
  relocation: z.boolean().optional(),
  anchors: z.array(draftAnchorSchema).max(5),
  meals: draftMealsSchema.optional(),
  note: prose(DRAFT_SOFT_PROSE_CAPS.dayNote).optional(),
  whyItFits: prose(DRAFT_SOFT_PROSE_CAPS.whyItFits).optional(),
});
export type DraftDay = z.infer<typeof draftDaySchema>;

export const draftPackageSchema = z.object({
  foodStrategy: z.array(prose(DRAFT_SOFT_PROSE_CAPS.foodStrategy)).max(6),
  transport: z.object({
    summary: prose(DRAFT_SOFT_PROSE_CAPS.transportSummary),
    notes: z.array(prose(DRAFT_SOFT_PROSE_CAPS.transportNote)).max(6),
  }),
  beforeYouGo: z.array(prose(DRAFT_SOFT_PROSE_CAPS.beforeYouGo)).max(10),
  packing: z.array(prose(DRAFT_SOFT_PROSE_CAPS.packing)).max(15),
  backups: z
    .array(
      z.object({
        trigger: prose(DRAFT_SOFT_PROSE_CAPS.backupTrigger),
        alternative: prose(DRAFT_SOFT_PROSE_CAPS.backupAlternative),
      }),
    )
    .max(6),
});
export type DraftPackage = z.infer<typeof draftPackageSchema>;

export const tripDraftSchema = z.object({
  archetype: z.enum(TRIP_ARCHETYPES),
  purpose: prose(DRAFT_SOFT_PROSE_CAPS.purpose),
  routeRationale: prose(DRAFT_SOFT_PROSE_CAPS.routeRationale),
  assumptions: z.array(prose(DRAFT_SOFT_PROSE_CAPS.assumption)).max(5),
  tradeoffs: z.array(prose(DRAFT_SOFT_PROSE_CAPS.tradeoff)).max(5),
  bases: z.array(draftBaseSchema).min(1).max(8),
  days: z.array(draftDaySchema).min(1).max(40),
  /** Destination-defining experiences weighed and left out, by name — never silently. */
  omissions: z.array(z.object({ name: prose(60), reason: prose(DRAFT_SOFT_PROSE_CAPS.omissionReason) })).max(8),
  unresolved: z.array(prose(DRAFT_SOFT_PROSE_CAPS.unresolvedItem)).max(8),
  package: draftPackageSchema,
});
export type TripDraft = z.infer<typeof tripDraftSchema>;

/** Stable within one draft and independent of provider identity. */
export function draftAnchorId(dayNumber: number, anchorIndex: number, name: string): string {
  const slugPart = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `d${dayNumber}-a${anchorIndex}-${slugPart || 'anchor'}`;
}

/**
 * Cosmetic-only rescue before strict validation — the same hard/soft split
 * `normalizeTripSkeleton` drew: enums, slugs, names, numbers and array
 * lengths are hard; free explanatory prose is trimmed and clipped to its cap
 * when the trimmed text already passes `SAFE_PROSE_PATTERN`. Nothing is ever
 * dropped from an array here — dropping an entry is a content decision.
 */
export function normalizeTripDraft(raw: unknown): { value: unknown; normalizedFields: readonly string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, normalizedFields: [] };
  const touched: string[] = [];
  const clip = (path: string, value: unknown, max: number): unknown => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed.length <= max) {
      if (trimmed !== value) touched.push(`${path} (trim)`);
      return trimmed;
    }
    if (!SAFE_PROSE_PATTERN.test(trimmed)) return value;
    touched.push(`${path} (clip)`);
    return trimmed.slice(0, max);
  };
  const clipArray = (path: string, value: unknown, max: number): unknown =>
    Array.isArray(value) ? value.map((item, i) => clip(`${path}[${i}]`, item, max)) : value;
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const root: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  root.purpose = clip('purpose', root.purpose, DRAFT_SOFT_PROSE_CAPS.purpose);
  root.routeRationale = clip('routeRationale', root.routeRationale, DRAFT_SOFT_PROSE_CAPS.routeRationale);
  root.assumptions = clipArray('assumptions', root.assumptions, DRAFT_SOFT_PROSE_CAPS.assumption);
  root.tradeoffs = clipArray('tradeoffs', root.tradeoffs, DRAFT_SOFT_PROSE_CAPS.tradeoff);
  root.unresolved = clipArray('unresolved', root.unresolved, DRAFT_SOFT_PROSE_CAPS.unresolvedItem);

  if (Array.isArray(root.bases)) {
    root.bases = root.bases.map((entry, i) => {
      const base = record(entry);
      if (!base) return entry;
      return {
        ...base,
        why: clip(`bases[${i}].why`, base.why, DRAFT_SOFT_PROSE_CAPS.baseWhy),
        lodgingArea: clip(`bases[${i}].lodgingArea`, base.lodgingArea, DRAFT_SOFT_PROSE_CAPS.lodgingArea),
        lodgingStyle: clip(`bases[${i}].lodgingStyle`, base.lodgingStyle, DRAFT_SOFT_PROSE_CAPS.lodgingStyle),
      };
    });
  }
  if (Array.isArray(root.omissions)) {
    root.omissions = root.omissions.map((entry, i) => {
      const omission = record(entry);
      if (!omission) return entry;
      return { ...omission, reason: clip(`omissions[${i}].reason`, omission.reason, DRAFT_SOFT_PROSE_CAPS.omissionReason) };
    });
  }
  if (Array.isArray(root.days)) {
    root.days = root.days.map((entry, d) => {
      const day = record(entry);
      if (!day) return entry;
      const out: Record<string, unknown> = {
        ...day,
        theme: clip(`days[${d}].theme`, day.theme, DRAFT_SOFT_PROSE_CAPS.dayTheme),
        note: clip(`days[${d}].note`, day.note, DRAFT_SOFT_PROSE_CAPS.dayNote),
        whyItFits: clip(`days[${d}].whyItFits`, day.whyItFits, DRAFT_SOFT_PROSE_CAPS.whyItFits),
      };
      const meals = record(day.meals);
      if (meals) {
        out.meals = {
          ...meals,
          breakfast: clip(`days[${d}].meals.breakfast`, meals.breakfast, DRAFT_SOFT_PROSE_CAPS.meal),
          lunch: clip(`days[${d}].meals.lunch`, meals.lunch, DRAFT_SOFT_PROSE_CAPS.meal),
          dinner: clip(`days[${d}].meals.dinner`, meals.dinner, DRAFT_SOFT_PROSE_CAPS.meal),
        };
      }
      if (Array.isArray(day.anchors)) {
        out.anchors = day.anchors.map((anchorEntry, a) => {
          const anchor = record(anchorEntry);
          if (!anchor) return anchorEntry;
          return { ...anchor, why: clip(`days[${d}].anchors[${a}].why`, anchor.why, DRAFT_SOFT_PROSE_CAPS.anchorWhy) };
        });
      }
      return out;
    });
  }
  const pkg = record(root.package);
  if (pkg) {
    const transport = record(pkg.transport);
    root.package = {
      ...pkg,
      foodStrategy: clipArray('package.foodStrategy', pkg.foodStrategy, DRAFT_SOFT_PROSE_CAPS.foodStrategy),
      ...(transport
        ? {
            transport: {
              ...transport,
              summary: clip('package.transport.summary', transport.summary, DRAFT_SOFT_PROSE_CAPS.transportSummary),
              notes: clipArray('package.transport.notes', transport.notes, DRAFT_SOFT_PROSE_CAPS.transportNote),
            },
          }
        : {}),
      beforeYouGo: clipArray('package.beforeYouGo', pkg.beforeYouGo, DRAFT_SOFT_PROSE_CAPS.beforeYouGo),
      packing: clipArray('package.packing', pkg.packing, DRAFT_SOFT_PROSE_CAPS.packing),
      backups: Array.isArray(pkg.backups)
        ? pkg.backups.map((entry, i) => {
            const backup = record(entry);
            if (!backup) return entry;
            return {
              ...backup,
              trigger: clip(`package.backups[${i}].trigger`, backup.trigger, DRAFT_SOFT_PROSE_CAPS.backupTrigger),
              alternative: clip(`package.backups[${i}].alternative`, backup.alternative, DRAFT_SOFT_PROSE_CAPS.backupAlternative),
            };
          })
        : pkg.backups,
    };
  }
  // Strip `undefined` produced by clipping absent optionals, so the shape the
  // schema sees is the shape the model sent.
  return { value: JSON.parse(JSON.stringify(root)), normalizedFields: touched };
}

/** Sanity checks the schema cannot express: every day names a base that exists, day numbers are 1..N in order, nights sum sanity is left to the reconciler. */
export function draftStructureIssues(draft: TripDraft): string[] {
  const issues: string[] = [];
  const baseIds = new Set(draft.bases.map((b) => b.id));
  draft.days.forEach((day, i) => {
    if (day.dayNumber !== i + 1) issues.push(`days[${i}] is numbered ${day.dayNumber}, expected ${i + 1}`);
    if (!baseIds.has(day.baseId)) issues.push(`day ${day.dayNumber} names base "${day.baseId}" which the draft does not define`);
  });
  return issues;
}
