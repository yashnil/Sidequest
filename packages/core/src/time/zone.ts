import { assertCalendarDate } from '../schemas/calendar';

/**
 * Wall-clock arithmetic against a real IANA zone.
 *
 * These lived in `data/weather.ts` — the Eastern Sierra seed file — because the
 * first thing that needed them was the fixture forecast generator. Nothing about
 * them is region-specific: they are the two operations the domain's
 * minutes-from-local-midnight model needs whenever it has to meet an absolute
 * instant, and a compiled region in any timezone needs them exactly as much.
 */

/**
 * How far ahead any forecast provider is worth asking.
 *
 * A shared default rather than a claim about a particular service: the live
 * adapter re-derives the real horizon from the response it actually got, and
 * this is what the fixture and the tests agree on so a horizon boundary is a
 * property of the test rather than of the afternoon somebody runs it.
 */
export const FORECAST_HORIZON_DAYS = 16;

export function isInsideForecastHorizon(date: string, now: Date, timeZone: string): boolean {
  const today = localDateIn(now, timeZone);
  const days = Math.round(
    (assertCalendarDate(date).getTime() - assertCalendarDate(today).getTime()) / 86_400_000,
  );
  return days >= 0 && days < FORECAST_HORIZON_DAYS;
}

/**
 * The calendar date it is *right now* in a given zone.
 *
 * The domain's whole time model is wall-clock-where-you-are-standing, and the
 * forecast horizon is measured from the traveller's today, not the server's. A
 * server in Frankfurt deciding at 00:30 that a trip starting "tomorrow" is out
 * of horizon would push a perfectly good forecast into historical patterns for
 * nine hours a day.
 */
export function localDateIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * The offset from UTC in force in `timeZone` on `date`, in minutes.
 *
 * **Computed, never stored.** That is a deliberate architectural rule and not a
 * stylistic one: an IANA identifier survives a timezone-database update and a
 * written-down offset does not. Legislatures move clocks — Morocco to permanent
 * UTC on 2026-09-20, British Columbia to permanent −07, Alberta to permanent −06
 * — and an artifact holding `-480` for Vancouver becomes wrong the day the rule
 * lands, while one holding `America/Vancouver` becomes right the day the runtime
 * is updated. Every caller in this repository stores the identifier and calls
 * this at read time; a future one that caches the number has reintroduced the
 * whole class of bug.
 *
 * The corollary, which the doctor reports: this answer is only as current as the
 * runtime's own tzdata (`process.versions.tz`). A Node release lagging the
 * database will be wrong about a rule change that has already happened, and no
 * amount of care here can fix that from inside the process.
 */
export function utcOffsetMinutesOn(date: string, timeZone: string): number {
  // Noon local-ish, so the answer is never taken from the ambiguous hour a
  // daylight-saving transition creates at either end of the day.
  const probe = new Date(`${date}T12:00:00Z`);
  /*
   * `'en-US'` and `'longOffset'` are both load-bearing, and both look like
   * details somebody could tidy away.
   *
   * The locale is pinned because other locales localise the literal — an Arabic
   * numbering system renders the digits in Arabic-Indic, and several locales use
   * a fullwidth minus sign. The regex below would then match nothing and this
   * would return zero, which is a silent eight-hour error in Los Angeles.
   *
   * `longOffset` rather than `shortOffset` because the short form drops both the
   * zero padding and, for some zones, the minutes: `GMT-5` and `GMT+5:45` cannot
   * be read by a fixed-width pattern, and Kathmandu and Eucla are exactly the
   * places where the minutes are the whole point.
   */
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
  const part = formatter.formatToParts(probe).find((entry) => entry.type === 'timeZoneName')?.value;
  /*
   * The seconds group is optional because pre-1900 local mean time has them —
   * Kolkata in 1850 formats as `GMT+05:53:28`. Nothing in a travel product dates
   * that far back, and reading the group is still cheaper than silently
   * truncating a value somebody one day passes in.
   */
  const match = /GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?/.exec(part ?? '');
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * The timezone database this process is reasoning with.
 *
 * Reported rather than assumed, because it is the one input to every offset
 * above that nobody in this codebase controls. Node 22.21 ships 2025b; the
 * database was at 2026c by July 2026, and the releases in between are precisely
 * the ones moving North America and Morocco onto permanent standard time. An
 * artifact whose daylight numbers were computed under a stale release is not
 * wrong in a way this code can detect — so the version travels with the
 * diagnostic instead, and the doctor prints it.
 */
export function runtimeTimeZoneDataVersion(): string | null {
  const version = (process as { versions?: Record<string, string | undefined> }).versions?.tz;
  return typeof version === 'string' && version.length > 0 ? version : null;
}

/**
 * Whether a set of zones is really one zone.
 *
 * A compiled region carries every zone its scope spans, and a great many
 * consumers want "the" timezone. Taking `zones[0]` is how a region straddling a
 * boundary silently gets one side's clock applied to both — so the question has
 * to be asked out loud, and answered `null` when the honest answer is "more than
 * one".
 */
export function singleTimeZone(zones: readonly string[]): string | null {
  const distinct = new Set(zones.filter((zone) => zone.length > 0));
  if (distinct.size !== 1) return null;
  return [...distinct][0] ?? null;
}

/**
 * A DESTINATION'S CLOCK, DERIVED, WHEN NOBODY PUBLISHED ONE.
 *
 * `'UTC'` was the fallback everywhere a zone was missing, and it is not a
 * neutral default — it is a claim, and for most of the inhabited world a wrong
 * one by several hours. Every consumer downstream formats opening hours,
 * daylight and forecast day-boundaries with `timeZones[0]`, so a destination
 * nine hours off UTC had its museums opening at midnight and nothing anywhere
 * said the zone had been invented.
 *
 * The longitude is a real measurement we always have, and solar time from it is
 * a **derived deterministic fact** rather than a guess: the returned zone is
 * within half an hour of local solar noon by construction. It is not a
 * political zone — it has no daylight saving and does not know that a country
 * has chosen a neighbour's clock — so callers must record the basis and prefer
 * a published zone whenever one exists.
 *
 * Note the sign. POSIX `Etc/GMT±N` is inverted relative to ISO 8601: UTC+9 is
 * `Etc/GMT-9`. Getting this backwards is an eighteen-hour error, so it is
 * asserted in the tests rather than trusted to a comment.
 */
export function deriveTimeZoneFromLongitude(longitude: number): string {
  if (!Number.isFinite(longitude)) return 'UTC';
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  const offsetHours = Math.max(-14, Math.min(14, Math.round(wrapped / 15)));
  if (offsetHours === 0) return 'UTC';
  return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${Math.abs(offsetHours)}`;
}

/**
 * Where a zone came from. A resolved civil zone is worth more than a derived one.
 *
 * `provider_resolved` is new in this pass and is the only value that means **a
 * source that publishes civil timezones was asked, and answered**. `published`
 * kept its place because artifacts compiled before that distinction existed
 * carry it, and re-reading an old artifact must not silently promote a zone
 * nobody can now account for — see `timeZoneConfidence`.
 */
export const TIME_ZONE_BASES = [
  'provider_resolved',
  'published',
  'derived_from_longitude',
  'unknown',
] as const;
export type TimeZoneBasis = (typeof TIME_ZONE_BASES)[number];

/**
 * HOW MUCH A ZONE IS WORTH, AS ITS OWN WORD.
 *
 * The basis says where a zone came from; this says whether it may be treated as
 * the destination's real civil clock. They are separate because only one of them
 * is a decision: a consumer scheduling against a published timetable, or a
 * screen printing "10:40 local", has to refuse a solar approximation, and the
 * refusal has to be spellable without enumerating bases at every call site.
 *
 * `degraded` is deliberately not `false`. A solar zone is right to within half an
 * hour and is far better than the `UTC` it replaced; what it must never do is
 * present itself as a political zone that knows about daylight saving.
 */
export type TimeZoneConfidence = 'authoritative' | 'degraded' | 'unknown';

export function timeZoneConfidence(basis: TimeZoneBasis): TimeZoneConfidence {
  switch (basis) {
    case 'provider_resolved':
    case 'published':
      return 'authoritative';
    case 'derived_from_longitude':
      return 'degraded';
    default:
      return 'unknown';
  }
}

/**
 * Whether an identifier names a real civil zone rather than a fixed offset.
 *
 * `Etc/GMT+7` and a bare `UTC` are legitimate IANA identifiers and are *not*
 * civil zones: they have no daylight saving, no political history and no
 * relationship to what a clock in that place says in October. This is the
 * structural half of the same claim `timeZoneConfidence` makes from provenance,
 * and both exist because either one alone can be wrong — a provider could return
 * `Etc/GMT-3`, and a solar derivation could coincidentally produce a string that
 * looks regional.
 */
export function isCivilTimeZone(zone: string): boolean {
  const trimmed = zone.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === 'UTC' || trimmed === 'GMT' || trimmed === 'Z') return false;
  if (trimmed.startsWith('Etc/')) return false;
  return trimmed.includes('/');
}

/** A zone, everything known about where it came from, and what it may be used for. */
export interface TimeZoneResolution {
  zones: string[];
  basis: TimeZoneBasis;
  confidence: TimeZoneConfidence;
  /** The adapter that answered, when one did. Never invented. */
  source?: string;
  /** When the answer was obtained. */
  resolvedAt?: string;
  /**
   * The instant the answer is *for*.
   *
   * A civil zone identifier is timeless, but the offset it implies is not, and a
   * provider that answers with an offset rather than an identifier is answering
   * about one moment. Recorded so a consumer can tell whether the reply predates
   * a daylight-saving transition inside the trip.
   */
  referenceInstant?: string;
}

/**
 * The zones to plan in, and how much they are worth.
 *
 * One place that answers "what clock is this destination on", so no consumer
 * has to write `?? 'UTC'` again. Every remaining occurrence of that string in a
 * planning path is a bug this function exists to make unnecessary.
 *
 * `resolved` is the new normal path: a civil-timezone provider was asked about
 * this destination's own coordinates and answered. `published` is a zone that
 * travelled with the destination record. The longitude derivation is the last
 * resort and is labelled `degraded` all the way to the screen.
 */
export function resolveTimeZones(input: {
  published: readonly string[];
  center: { lat: number; lng: number };
  /** What a civil-timezone provider returned for this destination, if anything. */
  resolved?: {
    zones: readonly string[];
    source: string;
    resolvedAt: string;
    referenceInstant?: string;
  };
}): TimeZoneResolution {
  const resolved = (input.resolved?.zones ?? []).filter((zone) => zone.trim().length > 0);
  if (input.resolved && resolved.length > 0) {
    return {
      zones: [...resolved],
      basis: 'provider_resolved',
      confidence: 'authoritative',
      source: input.resolved.source,
      resolvedAt: input.resolved.resolvedAt,
      ...(input.resolved.referenceInstant
        ? { referenceInstant: input.resolved.referenceInstant }
        : {}),
    };
  }

  const published = input.published.filter((zone) => zone.trim().length > 0);
  if (published.length > 0) {
    return { zones: [...published], basis: 'published', confidence: 'authoritative' };
  }
  return {
    zones: [deriveTimeZoneFromLongitude(input.center.lng)],
    basis: 'derived_from_longitude',
    confidence: 'degraded',
  };
}

/**
 * What to tell a traveller about the clock, in their words rather than ours.
 *
 * `Etc/GMT+7` is not a sentence anybody can act on, and printing it beside a
 * museum's opening time is worse than printing nothing: it looks precise. So a
 * degraded zone is described by the offset it stands for and says plainly that
 * it was estimated.
 */
export function describeTimeZone(resolution: {
  zones: readonly string[];
  basis: TimeZoneBasis;
}): string {
  const zones = resolution.zones.filter((zone) => zone.trim().length > 0);
  if (zones.length === 0) return 'We could not establish the local time here.';

  /*
   * Branched on what the value *is*, not on one basis it might have.
   *
   * The first version tested `basis === 'derived_from_longitude'` and printed
   * everything else verbatim, which left three ways for a fixed offset to reach
   * a screen looking like a civil clock:
   *
   * - `basis: 'unknown'`, which is what every artifact compiled before the basis
   *   existed reads as, and which the scope schema is explicit means "not
   *   recorded" rather than "published";
   * - a `published` or `provider_resolved` zone that is itself an `Etc/GMT±N` —
   *   the case `isCivilTimeZone` was written for, and which this function never
   *   consulted;
   * - a multi-zone trip, printed as raw identifiers.
   *
   * So a non-civil identifier is always rendered as the offset it stands for and
   * always labelled unconfirmed, whatever the basis claims.
   */
  const first = zones[0]!;
  if (!isCivilTimeZone(first) || timeZoneConfidence(resolution.basis) !== 'authoritative') {
    return isCivilTimeZone(first)
      ? `${first} — we have not been able to confirm this is the local time zone.`
      : `About ${offsetLabel(first)} — estimated from where this is on the map, because we could not confirm the local time zone.`;
  }
  if (zones.length > 1) return `${zones.join(' and ')} — this trip spans more than one clock.`;
  return first;
}

/** `Etc/GMT-9` → `UTC+9`. The POSIX sign is inverted; this is where that is undone. */
export function offsetLabel(zone: string): string {
  const match = /^Etc\/GMT([+-])(\d{1,2})$/.exec(zone.trim());
  if (!match) return zone === 'UTC' ? 'UTC' : zone;
  // POSIX `Etc/GMT+5` is UTC−5. Flipping here rather than at the call sites is
  // the whole reason this function exists; an eighteen-hour error hides in it.
  const sign = match[1] === '+' ? '−' : '+';
  return `UTC${sign}${match[2]}`;
}
