import { z } from 'zod';
import {
  closureRiskSchema,
  costLevelSchema,
  crowdLevelSchema,
  interestSchema,
  parkingDifficultySchema,
  physicalIntensitySchema,
  httpUrlSchema,
  placeCategorySchema,
  roadSurfaceSchema,
  timeOfDaySchema,
} from './common';
import { POI_BASE_FIELDS } from './poi';
import { placeWeatherProfileSchema } from './weather';
import { displayNameSchema } from '../naming/display-name';
/*
 * The standing model's own vocabulary, imported rather than restated: a second
 * copy of these three words here is a second place they can drift apart. The
 * dependency runs one way — `quality/significance.ts` takes only the `Place`
 * *type* from this file, which erases — so nothing circular is created at
 * runtime.
 */
import { NOTICE_MAGNITUDES, PROMINENCE_BASES } from '../quality/significance';

/**
 * When the place itself is reachable at all — the snow gate, not the shuttle.
 *
 * `shuttleMonths` used to live here and no longer does. Whether a shuttle
 * replaces private vehicles is a property of a *service calendar*, which has
 * days of the week and hours; a month list on the place could only ever be a
 * second, coarser answer to a question `schemas/access.ts` already answers
 * properly, and the two had already drifted apart.
 */
export const seasonalAccessSchema = z.object({
  /** Months (1-12) the place is normally reachable. */
  openMonths: z.array(z.number().int().min(1).max(12)).min(1).max(12),
  closureRisk: closureRiskSchema,
  note: z.string().min(1).optional(),
});
export type SeasonalAccess = z.infer<typeof seasonalAccessSchema>;

/**
 * The physical facts of getting to the door: what the road is like and what is
 * there when you arrive.
 *
 * Deliberately *not* "do you need a car" or "is transit possible". Those two
 * booleans lived here until they proved unwritable — Devils Postpile is
 * shuttle-only between fixed hours in some months and drivable in others, and
 * the Lakes Basin trolley runs June to mid-September and stops at 17:30. A field
 * that has to be true and false on different days of the same trip is not a
 * field. Both now come from date-aware access rules; see `schemas/access.ts`.
 */
export const placeAccessSchema = z.object({
  roadSurface: roadSurfaceSchema,
  mountainRoad: z.boolean(),
  parkingDifficulty: parkingDifficultySchema,
  /** No fuel, water, toilets or reliable phone signal at or near the stop. */
  remoteNoServices: z.boolean().default(false),
});
export type PlaceAccess = z.infer<typeof placeAccessSchema>;

/**
 * Places that sit behind one shared gate, road or shuttle.
 *
 * Reds Meadow is the case that forced this: Minaret Vista is the fee station,
 * and Devils Postpile and Rainbow Falls are both beyond it on the same road,
 * served by the same mandatory shuttle. Treating them as three independent stops
 * lets a planner schedule them on three different days, which would mean paying
 * and boarding three times — or, worse, "driving" to Rainbow Falls on a day when
 * private vehicles are not allowed past the vista at all.
 *
 * The planner keeps members of a group in the same geographic cluster, so they
 * land on the same day or not at all. Destination-agnostic: any shuttle system,
 * toll road or single-entrance valley uses the same mechanism.
 */
export const accessGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  note: z.string().min(1).optional(),
});
export type AccessGroup = z.infer<typeof accessGroupSchema>;

export const travelFromBaseSchema = z.object({
  distanceKm: z.number().min(0),
  /**
   * Minutes from base **in the mode the matrix was measured in** — see `mode`.
   * The field name predates multi-mode measurement and is kept for artifact
   * compatibility; a consumer that needs the mode reads it off `mode` and must
   * not assume a car.
   */
  driveMinutes: z.number().int().min(0),
  /** True when the drive itself is part of the appeal, not just transit cost. */
  driveIsScenic: z.boolean().default(false),
  /**
   * The mode the minutes above were measured in. Absent on records written
   * before the field existed, and on legs nobody measured.
   */
  mode: z.enum(['car', 'foot']).optional(),
  /**
   * True only when a routing engine actually measured this leg. **Absent means
   * the zeros above are placeholders, not measurements** — a compiled place
   * whose journey could not be measured keeps the schema-required zeros and
   * says so here, and every consumer that would read `0` as "no journey at
   * all" must check this first. The board's reach machinery resolves journeys
   * independently; this marker is for readers of the stored artifact.
   */
  measured: z.boolean().optional(),
});
export type TravelFromBase = z.infer<typeof travelFromBaseSchema>;

export const placeSchema = z.object({
  ...POI_BASE_FIELDS,
  /** Base = you sleep here / it is the anchor. Satellite = you travel out to it. */
  relationship: z.enum(['base', 'satellite']),
  category: placeCategorySchema,
  /**
   * The type-truthful noun a card should print, where the planning category's
   * label would be a lie: "River", "Cemetery", "Theme park".
   *
   * `category` is a thirteen-value planning vocabulary and a river genuinely
   * plans like a lake — but a live board captioning the Sumida River "Lake"
   * told the traveller the machine cannot see. Optional and additive: absent
   * means the category label is already truthful, and every stored place
   * written before the field existed reads exactly as it did.
   */
  displayKind: z.string().min(1).optional(),
  /**
   * The traveller-facing name resolution: recognised English/romanised form
   * leading, the native form beside it, the source's own name kept canonical.
   * Optional for the same stale-artifact reason as everything else here —
   * `displayNameOf` falls back to `name` when it is absent.
   */
  names: displayNameSchema.optional(),
  /**
   * 0–1 combined kind-and-evidence significance. See
   * `quality/significance.ts#experienceSignificanceOf` for the exact model.
   * Distinct from `popularityScore` (knowledge-base breadth alone) and barred,
   * like every ranking input, from reading `evidenceRichness`.
   */
  experienceSignificance: z.number().min(0).max(1).optional(),
  /**
   * True when the witness bound capped this place's evidence contribution:
   * its kind demanded more than encyclopaedic notice and nothing certified
   * the visit — no posted hours or fee, no standing designation, no authority
   * page, no graded ground witnesses. A rank the model itself refused to let
   * the evidence buy must not be presented as established standing, so the
   * "established names" caption and the classics group both require this to
   * be absent or false. Absent on stored places from before the distinction
   * existed, which reads as "not bounded" — exactly today's behaviour.
   */
  significanceBounded: z.boolean().optional(),
  /**
   * What kind of hours question this place can even have.
   *
   * `gated` — somebody opens and closes it, so unknown hours are a real gap to
   * warn about. `open_ground` — a river, a slope, an unfenced park: "check its
   * hours" is a category error, and a compiled build stamped exactly that on
   * every geographic feature it shipped. Absent means nobody classified it,
   * which consumers must read as `gated` (the cautious direction).
   */
  hoursExpectation: z.enum(['gated', 'open_ground']).optional(),
  /**
   * Where `typicalDurationMinutes` came from. `category_estimate` is the
   * archetype's constant and must render as an estimate ("about 1½ h"), never
   * as a measured fact — a live card printed "Time there: 1 hr 30 min" for a
   * river. Absent on stored places from before the distinction existed.
   */
  durationBasis: z.enum(['category_estimate', 'source_stated']).optional(),
  /**
   * WHICH OF THIS RECORD'S PRACTICAL FIELDS ARE THE CATEGORY'S GUESS.
   *
   * The schema requires an access block, a season, an intensity, a crowd level
   * and a cost on every place, and a producer that has no evidence fills them
   * from the category archetype — which is honest as a prior and a lie as a
   * printed fact: a live road-region board stored a highland ice field as
   * paved, easy, open all year and busy, because the archetype's defaults were
   * serialized with nothing marking them as defaults. Each name listed here
   * says "the corresponding field is a category estimate, not a fact about
   * this place" — the same contract `durationBasis: 'category_estimate'`
   * already states for the duration — so a card can render "not verified"
   * instead of the guess. Absent entries mean the producer had real evidence
   * (or predate the field, which readers must treat as unmarked, not as
   * verified).
   */
  estimatedDefaults: z
    .array(z.enum(['access', 'seasonal_access', 'physical_intensity', 'crowd_level', 'cost_level']))
    .optional(),
  /**
   * Interests this place genuinely satisfies, ordered by how central each one is
   * to the place itself. Order is load-bearing: the first entry the traveller
   * cares about becomes the place's primary interest, which is what frequency
   * ceilings are counted against. A viewpoint hike is a hike first.
   */
  interests: z.array(interestSchema).min(1),
  typicalDurationMinutes: z.number().int().min(15).max(600),
  costLevel: costLevelSchema,
  physicalIntensity: physicalIntensitySchema,
  /**
   * How busy to expect it. **A required read of `crowdExpectation`.**
   *
   * `'quiet'` here can mean "nothing published anything about visitation", which
   * is why `crowdExpectation` exists beside it: a consumer that can act on an
   * absence should read that one. This field used to be
   * `popularityScore > 0.7 ? 'busy' : 'quiet'` — a threshold on a metadata count
   * wearing a third name.
   */
  crowdLevel: crowdLevelSchema,
  /**
   * 0-1 how well known the place is. **A derived read of the standing.**
   *
   * Kept because the board, the autoselector, the fit scorer and the coverage
   * report all read it and none of them can express an absence. `prominenceRead`
   * produces it: the world's notice where that was observed, otherwise what the
   * region's own authorities, designations and ground established, otherwise
   * `WITHHELD_PROMINENCE_READ`. It used to floor at that constant the moment a
   * knowledge-base tag was missing, which read absence of evidence as evidence
   * of obscurity and put a metropolis's principal castle under a municipal
   * sports park. A low value here still means "unnoticed *or* unobserved" —
   * `globalProminence` is the field that tells those apart, and
   * `standsAsEstablishedName` is what any consumer claiming standing must ask.
   * Produced by `standingFields`, never by hand.
   */
  popularityScore: z.number().min(0).max(1),
  /**
   * 0-1 how far off the standard tourist track it is. **A read of `hiddenness`.**
   *
   * It was `1 − popularityScore`, which made "hidden gem" a synonym for "we hold
   * less metadata about it" and made the board's classics and hidden-gem groups
   * the two ends of one number. See `quality/significance.ts`.
   */
  hiddenGemScore: z.number().min(0).max(1),
  /**
   * THE SEPARATED SCORES — see `quality/significance.ts` for why they exist.
   *
   * All optional, and the optionality is the contract: an absent score means
   * nobody could establish it, which is a different claim from a low one and
   * must never be written as `0` or `0.5`. A place with no evidence at all is not
   * a hidden gem; it is a place we know nothing about.
   */
  /**
   * WHICH QUESTION `popularityScore` ANSWERED — see `PROMINENCE_BASES`.
   *
   * `observed` is a notice read; `withheld` is a standing something pointing at
   * this place established while nobody ever put the notice question; and
   * `unestablished` is a landlord's front door, a shared administrative name,
   * or nothing at all beyond a name and a position.
   *
   * Carried because two consumers act on the difference and both were reading
   * the wrong fact off `globalProminence`: the classics seat and the
   * established-names caption (`standsAsEstablishedName`), which asserted
   * standing over a ward park and refused it to a destination's principal
   * temple, and the anchor-slot condition (`standingWasEstablished`), which did
   * not exist and let a record with no evidence beyond its name and position
   * hold 42% of a trip's activity time.
   *
   * Absent on places stored before the distinction existed, and every consumer
   * falls back to the fields it does carry — an old artifact reads exactly as
   * it did. Produced by `standingFields`, never by hand.
   */
  prominenceBasis: z.enum(PROMINENCE_BASES).optional(),
  /**
   * WHAT VOUCHED FOR THE SIZE OF THIS RECORD'S NOTICE — SEE `NOTICE_MAGNITUDES`.
   *
   * Absent where nothing did, which is the ordinary case and the one that reads
   * exactly as it always has.
   *
   * Carried because "how big is this thing" and "does the world know about it"
   * are different questions and one of them was answering the other. The notice
   * channels are all *presence* bits an open catalogue mints for every row of a
   * class it maps at all, so no record can pass `MAX_UNMAGNIFIED_PROMINENCE` on
   * them; the magnitude gate is what admits the rest. That put the classics bar
   * and the magnitude gate at the same place, and the consequence was
   * mechanical: a designated suburban lake wore "Classics worth your time — the
   * well-known ones" on a delivered board, alone, while the destination's
   * famous waterfall sat under "Probably skip" — because a protected boundary
   * somebody drew is a statement about *size*, and the caption is a claim about
   * fame.
   *
   * `ground_namesake` is the other magnitude and it is not the same claim: the
   * surrounding ground orienting its own records around a thing is the ground
   * saying it matters. That one may buy the caption; a designation alone may
   * not. See `standsAsEstablishedName`.
   */
  noticeMagnitude: z.enum(NOTICE_MAGNITUDES).optional(),
  /** 0-1 knowledge-base breadth only. Never an attribute count. */
  globalProminence: z.number().min(0).max(1).optional(),
  /** 0-1 official publication, conferred designation, the region's own naming. */
  localSignificance: z.number().min(0).max(1).optional(),
  /**
   * 0-1 how much a source wrote down.
   *
   * Feeds `source.confidence` and **must not feed ranking**. It is the figure
   * that used to masquerade as popularity, and a franchise scores highly on it
   * by definition.
   */
  evidenceRichness: z.number().min(0).max(1).optional(),
  /** 0-1 locally significant beyond what the wider world has noticed. */
  hiddenness: z.number().min(0).max(1).optional(),
  /** Only when visitation, capacity or season evidence exists. Never a threshold. */
  crowdExpectation: crowdLevelSchema.optional(),
  /**
   * How this place reacts to weather, on the axes that change a decision.
   * Canonical facts about the place itself — never a forecast, never a date.
   */
  weather: placeWeatherProfileSchema,
  bestTimeOfDay: timeOfDaySchema.default('any'),
  seasonalAccess: seasonalAccessSchema,
  access: placeAccessSchema,
  /** Set when this place shares an access road, gate or shuttle with others. */
  accessGroup: accessGroupSchema.optional(),
  travelFromBase: travelFromBaseSchema,
  /** Practical caveat shown verbatim on the card when present. */
  logisticsNote: z.string().min(1).optional(),
  imageUrl: httpUrlSchema.optional(),
  /**
   * The open identifier the backbone already linked this record to.
   *
   * Carried so that imagery resolution can be an *identifier relationship*
   * rather than a name search. Without it the only rung available to a compiled
   * candidate is a bounded search over a name, whose confidence deliberately
   * never clears the bar for display — so the board would render a fallback
   * graphic for every card whose Wikidata id we already held two layers up.
   *
   * Optional, and its absence is meaningful rather than lazy: plenty of records
   * genuinely have no open identifier, and inventing one from a name is exactly
   * the ambiguous-same-name failure the imagery gate exists to refuse.
   */
  wikidataId: z
    .string()
    .regex(/^Q\d+$/)
    .optional(),
});
export type Place = z.infer<typeof placeSchema>;

export const placeCollectionSchema = z.array(placeSchema);
