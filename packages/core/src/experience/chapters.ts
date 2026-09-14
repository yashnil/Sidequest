import type { BaseKind, Itinerary, ItineraryDay } from '../schemas/itinerary';
import { haversineKm } from '../travel/estimate';

/**
 * V11 §5 §6 — STAYS, EXPERIENCES AND CHAPTERS.
 *
 * The founder's Kyrgyzstan trip listed **seven bases** for ten nights:
 *
 *   Bishkek 1 · Karakol 2 · Ala-Kul trek (camp) 2 · Karakol 1 · Karakol 1 · Song-Kol 2 · Bishkek 1
 *
 * Two things are wrong with that list and both are structural rather than
 * cosmetic.
 *
 * **Karakol appears twice in a row.** The trip therefore printed "You move from
 * Karakol to Karakol today", scheduled a base-to-base leg of "0 min", and
 * counted the non-move as one of six hotel changes.
 *
 * **The trek camp is in the list at all.** `Ala-Kul trek (camp)` is two nights
 * inside a three-day operated traverse. Modelled as an ordinary base it needs
 * its own booking (bought a second time beside the trek itself), it contributes
 * two of the six hotel changes, and the lodging adviser — reasoning correctly
 * from a wrong premise — recommended *"Karakol could be a day trip from Ala-Kul
 * trek (camp) instead of a one-night stop"*, which is a day trip to a town from
 * a tent on the far side of a 3,900 m pass.
 *
 * The information needed to prevent all of it was already persisted. V7's
 * `episodes` carry `dayNumbers` and `baseIds`, and the day headers already read
 * "Trek · day 1 of 3". The episode was an **annotation**; the base list was
 * **authority**. This module makes the derived stay sequence the authority
 * instead, and every surface that counts hotel changes, lists somewhere to
 * book, or advises on lodging reads it.
 *
 * Nothing here invents structure. A stay collapses only into an immediately
 * neighbouring stay it is genuinely the same place as; an overnight belongs to
 * an experience only where the persisted episode says its day does. Both are
 * facts the plan already states about itself.
 */

/** How near two overnight points have to be to be the same place under different names. */
const SAME_PLACE_KM = 2;
/** How near two stays have to be to belong to one chapter of the trip. */
const SAME_AREA_KM = 60;

export interface StayInput {
  id: string;
  name: string;
  nights: number;
  displayName?: string | undefined;
  locality?: string | undefined;
  canonicalName?: string | undefined;
  baseKind?: BaseKind | undefined;
  coordinates?: { lat: number; lng: number } | undefined;
  episode?: string | undefined;
  /**
   * V11 §N — THE ID A *DAY* USES FOR ITS BASE, WHICH IS NOT THIS ONE.
   *
   * A package base is keyed by a slug the draft chose (`karakol`); a day is
   * keyed by whatever the place resolved to (`relation/15585749`). On the live
   * Kyrgyzstan build not one of eleven days matched a single base, so every
   * chapter resolved to zero stays: the titles fell back to "This part of the
   * trip" and the geographic cut — the rule that decides where a chapter
   * begins — compared `null` to `null` and never fired. Every chapter boundary
   * in that trip came from the trek episode alone, which is why a four-base
   * Rockies road trip also came out as three chapters.
   *
   * The join therefore needs every identity a base answers to, not one of them.
   */
  placeId?: string | undefined;
}

export interface EpisodeInput {
  name: string;
  kind: string;
  dayNumbers: readonly number[];
  baseIds: readonly string[];
  timing: 'operator' | 'self' | 'unknown';
}

/** One run of nights the traveller experiences as staying in a single place. */
export interface Stay {
  /** The first constituent base's id, so existing references keep resolving. */
  id: string;
  /** Every base folded into this stay, in order. More than one means a collapse happened. */
  baseIds: string[];
  /**
   * Every identity a day might name this stay by: the base ids above, the
   * provider refs those bases resolved to, and the names they were given.
   * A day is joined to a stay through this rather than through `id`, because
   * the two layers key a base differently (see `StayInput.placeId`).
   *
   * Optional so that a `Stay` built by hand — or read back from a package
   * written before this field existed — still resolves, through the ids and the
   * name it has always carried.
   */
  identifiers?: string[];
  name: string;
  nights: number;
  baseKind?: BaseKind | undefined;
  coordinates?: { lat: number; lng: number } | undefined;
  /**
   * The multi-day experience these nights belong to, when they do. A stay
   * inside an experience is not somewhere the traveller chose to sleep: the
   * experience decided it, the operator books it, and moving out of it is not
   * a hotel change.
   */
  withinExperience?: string | undefined;
  /** Whether arriving here counts as the traveller changing hotel. */
  countsAsHotelChange: boolean;
}

export interface StayNormalization {
  stays: Stay[];
  /** Every collapse that happened, for the audit trail and the tests. */
  collapsed: { name: string; foldedBaseIds: string[]; reason: 'same_name' | 'same_point' }[];
  /** Hotel changes after normalisation: moves between stays the traveller is actually responsible for. */
  hotelChanges: number;
}

function normalizeLabel(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Whether two neighbouring stays are the same place under two labels.
 *
 * Deliberately strict, and deliberately only ever applied to *neighbours*. Two
 * separate visits to one town with a week between them are two visits and the
 * route depends on the difference; two consecutive nights under the same name
 * are one stay whatever the plan called them. A shared coordinate within two
 * kilometres settles it where the labels differ (a town and the guesthouse in
 * it), and nothing else does — a name similarity heuristic would eventually
 * fold two genuinely different villages together.
 */
function sameStay(a: StayInput, b: StayInput): 'same_name' | 'same_point' | null {
  /*
   * Nights inside two *different* experiences are never one stay, whatever they
   * are called.
   *
   * V11 §N — but one of them having an experience and the other not is a
   * different case, and it used to be refused by the same line. The live
   * Kyrgyzstan build ended its trek with a night in Karakol the operator owns
   * and followed it with a recovery night in Karakol the traveller books: two
   * consecutive nights, one town, one bed — shown as two bases both called
   * "Karakol", which is the founder defect §5 exists to prevent, arriving
   * through a door §5 did not close. Who paid for the night is not where the
   * traveller sleeps. Two *stated* experiences that differ still never merge.
   */
  if (a.episode !== undefined && b.episode !== undefined && a.episode !== b.episode) return null;
  const labelsA = [a.name, a.displayName, a.canonicalName, a.locality].map(normalizeLabel).filter(Boolean);
  const labelsB = [b.name, b.displayName, b.canonicalName, b.locality].map(normalizeLabel).filter(Boolean);
  if (labelsA.some((label) => labelsB.includes(label))) return 'same_name';
  if (a.coordinates && b.coordinates && haversineKm(a.coordinates, b.coordinates) <= SAME_PLACE_KM) return 'same_point';
  return null;
}

/** Every string a day could plausibly name this base by, normalised where it is a name. */
function identifiersOf(base: StayInput): string[] {
  const out = [base.id, base.placeId, base.name, base.displayName, base.canonicalName, base.locality];
  return [...new Set(out.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

/**
 * The stay sequence a traveller actually experiences, from the persisted bases
 * and episodes.
 *
 * Two passes, in this order and not the other, because collapsing first would
 * fold two nights of one trek camp into a neighbouring town if the episode had
 * not yet been attributed.
 */
export function normalizeStays(input: { bases: readonly StayInput[]; episodes?: readonly EpisodeInput[] }): StayNormalization {
  const episodes = input.episodes ?? [];
  /* Pass 1 — attribute each base to an experience, by the episode's own base list or its own name. */
  const attributed: StayInput[] = input.bases.map((base) => {
    if (base.episode) return base;
    const owning = episodes.find((episode) => episode.baseIds.includes(base.id));
    return owning ? { ...base, episode: owning.name } : base;
  });

  /* Pass 2 — collapse consecutive stays that are the same place. */
  const collapsed: StayNormalization['collapsed'] = [];
  const stays: Stay[] = [];
  const sources: StayInput[] = [];
  for (const base of attributed) {
    const previous = stays[stays.length - 1];
    const previousSource = sources[sources.length - 1];
    const same = previous && previousSource ? sameStay(previousSource, base) : null;
    if (previous && same) {
      previous.nights += base.nights;
      previous.baseIds.push(base.id);
      previous.identifiers ??= [];
      for (const identifier of identifiersOf(base)) if (!previous.identifiers.includes(identifier)) previous.identifiers.push(identifier);
      /* A coordinate the earlier row lacked is still a coordinate for the stay. */
      if (!previous.coordinates && base.coordinates) previous.coordinates = base.coordinates;
      const record = collapsed.find((entry) => entry.name === previous.name);
      if (record) record.foldedBaseIds.push(base.id);
      else collapsed.push({ name: previous.name, foldedBaseIds: [base.id], reason: same });
      continue;
    }
    stays.push({
      id: base.id,
      baseIds: [base.id],
      identifiers: identifiersOf(base),
      name: base.displayName ?? base.name,
      nights: base.nights,
      ...(base.baseKind ? { baseKind: base.baseKind } : {}),
      ...(base.coordinates ? { coordinates: base.coordinates } : {}),
      ...(base.episode ? { withinExperience: base.episode } : {}),
      countsAsHotelChange: false,
    });
    sources.push(base);
  }

  /*
   * Pass 3 — which arrivals are hotel changes.
   *
   * The first stay is not a change (the traveller arrives somewhere). Moving
   * *into* nights an experience owns is not a change either: the operator moved
   * them, there is no second bed to find, and counting it makes a trek look like
   * churn. Moving *out* of an experience back to an ordinary base is a change,
   * because a bed does have to exist at the other end.
   */
  stays.forEach((stay, index) => {
    if (index === 0) return;
    stay.countsAsHotelChange = stay.withinExperience === undefined;
  });

  return { stays, collapsed, hotelChanges: stays.filter((stay) => stay.countsAsHotelChange).length };
}

// ---------------------------------------------------------------------------
// V11 §6 — chapters
// ---------------------------------------------------------------------------

export const CHAPTER_ROLES = ['arrival', 'exploration', 'expedition', 'transition', 'recovery', 'finale'] as const;
export type ChapterRole = (typeof CHAPTER_ROLES)[number];

export interface Chapter {
  id: string;
  /** The place or experience the chapter is about — never invented prose. */
  title: string;
  role: ChapterRole;
  dayNumbers: number[];
  stayIds: string[];
  nights: number;
  /** The experience this whole chapter is, when it is one. */
  experience?: string | undefined;
}

interface ChapterDay {
  dayNumber: number;
  stayId: string | null;
  episode: string | null;
  strenuous: boolean;
  heavyTravel: boolean;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Where the trip's chapters begin and end.
 *
 * Derived from geography, experiences and route structure, in that order of
 * authority, and from nothing else:
 *
 * - **An experience is always its own chapter.** A three-day traverse is one
 *   thing that happens to the traveller, whatever bases it passes through.
 * - **Otherwise a chapter is a run of days in one area.** Consecutive stays
 *   within 60 km are one chapter — a base move down a valley is not a new act
 *   of the trip — and a stay with no coordinate only joins the previous
 *   chapter when it is the same stay, because unknown is not "nearby".
 * - **The arrival and departure days are separated** only when they are short
 *   edge days that are not already inside an experience, which is what makes
 *   "ARRIVE / ORIENT" and a finale read as deliberate rather than as an
 *   arbitrary cut.
 *
 * `recovery` is assigned afterwards and only where it is true: an
 * ordinary chapter that follows an expedition and contains no strenuous day.
 */
export function deriveChapters(input: {
  days: readonly Pick<ItineraryDay, 'dayNumber' | 'baseId' | 'baseName' | 'items' | 'intensity' | 'totals'>[];
  stays: readonly Stay[];
  episodes?: readonly EpisodeInput[];
}): Chapter[] {
  const episodes = input.episodes ?? [];
  /*
   * One index, every identity. A day names its base by whichever id the place
   * resolved to and carries the display name beside it; the stay knows both.
   * The first stay to claim an identity keeps it, so a name shared by two
   * stays (two visits to one town) resolves to the earlier — and the two are
   * still distinguished by the ids, which are unique.
   */
  const stayByIdentity = new Map<string, Stay>();
  for (const stay of input.stays) {
    const identifiers = stay.identifiers ?? [stay.id, ...stay.baseIds, stay.name];
    for (const identifier of identifiers) if (identifier && !stayByIdentity.has(identifier)) stayByIdentity.set(identifier, stay);
  }
  const stayFor = (day: { baseId?: string | undefined; baseName?: string | undefined }): string | null => {
    /* By id first: a name is ambiguous where a trip visits one town twice, an id never is. */
    if (day.baseId) {
      const byId = stayByIdentity.get(day.baseId);
      if (byId) return byId.id;
    }
    if (day.baseName) {
      const byName = stayByIdentity.get(day.baseName);
      if (byName) return byName.id;
    }
    return null;
  };
  const lastDayNumber = input.days[input.days.length - 1]?.dayNumber ?? 0;

  const chapterDays: ChapterDay[] = input.days.map((day) => ({
    dayNumber: day.dayNumber,
    stayId: stayFor(day),
    episode: episodes.find((episode) => episode.dayNumbers.includes(day.dayNumber))?.name ?? null,
    strenuous: day.intensity === 'intense' || day.totals.strenuousCount > 0,
    /*
     * §9 — a "recovery" day that is really hours of transfers is not recovery.
     * Two hours of moving is the line: below it a day is somewhere you are,
     * above it a day is a journey.
     */
    heavyTravel: (day.totals.driveMinutes ?? 0) + (day.totals.transitMinutes ?? 0) + (day.totals.unverifiedMinutes ?? 0) > 120,
    isFirst: day.dayNumber === input.days[0]?.dayNumber,
    isLast: day.dayNumber === lastDayNumber,
  }));

  const distanceBetween = (a: string | null, b: string | null): number | null => {
    if (a === null || b === null) return null;
    if (a === b) return 0;
    const from = input.stays.find((stay) => stay.id === a)?.coordinates;
    const to = input.stays.find((stay) => stay.id === b)?.coordinates;
    return from && to ? haversineKm(from, to) : null;
  };

  const groups: ChapterDay[][] = [];
  for (const day of chapterDays) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    const cut = (): boolean => {
      if (!previous) return true;
      /* An experience boundary always cuts, in either direction. */
      if (previous.episode !== day.episode) return true;
      /* Inside one experience nothing cuts. */
      if (day.episode !== null) return false;
      /* A short arrival day stands alone when the trip moves on the next day. */
      if (previous.isFirst && previous.stayId !== day.stayId) return true;
      /* A departure day joins whatever came before it unless the base changed. */
      if (day.stayId === previous.stayId) return false;
      const km = distanceBetween(previous.stayId, day.stayId);
      /* Unknown is not "nearby": an unplaced stay starts its own chapter rather than being folded in silently. */
      return km === null || km > SAME_AREA_KM;
    };
    if (cut()) groups.push([day]);
    else current!.push(day);
  }

  const chapters: Chapter[] = groups.map((group, index) => {
    const episode = group[0]!.episode;
    const stayIds = [...new Set(group.map((day) => day.stayId).filter((id): id is string => id !== null))];
    const stays = stayIds.map((id) => input.stays.find((stay) => stay.id === id)).filter((stay): stay is Stay => stay !== undefined);
    const nights = stays.reduce((total, stay) => total + stay.nights, 0);
    const title = episode ?? stays.map((stay) => stay.name).join(' & ') ?? 'This part of the trip';
    const role: ChapterRole = episode
      ? 'expedition'
      : group.some((day) => day.isFirst)
        ? 'arrival'
        : group.some((day) => day.isLast)
          ? 'finale'
          : /* A one-day chapter between two others is the trip moving, not a place it spends time in. */
            group.length === 1
            ? 'transition'
            : 'exploration';
    return {
      id: `chapter-${index + 1}`,
      title: title || 'This part of the trip',
      role,
      dayNumbers: group.map((day) => day.dayNumber),
      stayIds,
      nights,
      ...(episode ? { experience: episode } : {}),
    };
  });

  /*
   * Recovery: a chapter directly after an expedition with nothing strenuous and
   * no day that is mostly travel. A single quiet day counts — after a three-day
   * traverse, one day is what recovery looks like — but a day spent driving does
   * not, because §9's whole point is that a recovery day full of transfers is
   * not one. A finale is never relabelled: the trip ending is what it is.
   */
  chapters.forEach((chapter, index) => {
    if (index === 0 || (chapter.role !== 'exploration' && chapter.role !== 'transition')) return;
    if (chapters[index - 1]!.role !== 'expedition') return;
    const days = chapter.dayNumbers.map((dayNumber) => chapterDays.find((day) => day.dayNumber === dayNumber));
    if (days.some((day) => day?.strenuous || day?.heavyTravel)) return;
    chapter.role = 'recovery';
  });

  return chapters;
}

/** Both derivations at once, from a persisted itinerary. The one entry point a surface should use. */
export function tripStructureOf(itinerary: Pick<Itinerary, 'days' | 'package'>): { stays: Stay[]; chapters: Chapter[]; collapsed: StayNormalization['collapsed']; hotelChanges: number } {
  const bases = itinerary.package?.bases ?? [];
  const episodes = (itinerary.package?.episodes ?? []) as readonly EpisodeInput[];
  const normalization = normalizeStays({ bases, episodes });
  const chapters = deriveChapters({ days: itinerary.days, stays: normalization.stays, episodes });
  return { stays: normalization.stays, chapters, collapsed: normalization.collapsed, hotelChanges: normalization.hotelChanges };
}
