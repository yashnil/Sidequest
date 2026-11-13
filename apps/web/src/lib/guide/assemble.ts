import { imageCropPolicy, travelFigurePrefix } from '@sidequest/core';
import {
  PACKING_CATEGORY_LABELS,
  TRANSPORT_MODE_LABELS,
  countryFacts,
  dayPartFor,
  type BookedPlanItem,
  type BookingResolution,
  type DestinationImage,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type TransportMode,
  type TravelIntelligence,
} from '@sidequest/core';
import { dayMapModel } from '@/components/day-map-legs';
import { firstSentence, humanDate, span, timelineClock, travelSpan } from '@/components/hub/plan-format';
import { formatDateRange } from '@/lib/format';
import { dayRouteLinks, mapModeFor, type MapStop } from '@/lib/maps';
import { coordinatePair, placeNavigationLinks } from '@/lib/navigation-links';
import type {
  GuideAudience,
  GuideBooking,
  GuideDay,
  GuideItem,
  GuideLineStyle,
  GuideLink,
  GuideMap,
  GuideModel,
  GuidePhoto,
  GuideStay,
  GuideVariant,
} from './model';

/**
 * FROM A FINISHED PLAN TO A GUIDE SOMEBODY WOULD HAND TO THEIR FAMILY.
 *
 * Pure: no database, no provider, no clock except the one handed in. The print
 * route loads the inputs (through the public-audience boundary for a shared
 * copy) and renders whatever this returns.
 *
 * Three decisions live here rather than in the components:
 *
 * 1. **What each variant carries.** The compact copy is the route, the days,
 *    where you sleep, what to book and the numbers to keep; the complete copy
 *    adds day maps, photographs, backups, packing and the appendices.
 * 2. **Every planning sentence is said once.** The live hub repeats the trip's
 *    reasoning in the band, the overview, the stays and every day; on paper
 *    that is pages of the same paragraph. A sentence already placed is never
 *    placed again, and a warning true on most days is lifted to the overview.
 * 3. **The public copy is a boundary.** A shared guide carries no party facts,
 *    no booking status, references, notes, addresses or costs — not hidden by
 *    the layout, simply never put in the model.
 */

export interface GuideInput {
  variant: GuideVariant;
  audience: GuideAudience;
  trip: { destination: string; startDate: string; endDate: string; adults?: number; children?: number };
  /** The itinerary with booked facts applied. */
  itinerary: Itinerary;
  intelligence: TravelIntelligence;
  booked: readonly BookedPlanItem[];
  resolutions?: readonly BookingResolution[];
  coordinates: Record<string, { lat: number; lng: number }>;
  images: Record<string, DestinationImage>;
  rationale: Record<string, { name?: string; why?: string; category?: string }>;
  personality: string | null;
  timeZone?: string;
  attributions: readonly string[];
  worthSkipping: readonly { name: string; reason: string }[];
  /** Absolute URLs; each becomes a QR code. */
  links: { trip?: string; share?: string };
  generatedAt: Date;
}

const LIMITS = {
  compact: { highlights: 4, dayNotes: 1, bookings: 10, beforeYouGo: 6, transportPoints: 3, packing: 0 },
  complete: { highlights: 6, dayNotes: 3, bookings: 40, beforeYouGo: 14, transportPoints: 6, packing: 60 },
} as const;

/** Lower-case, punctuation-free form of a sentence, for "have we said this already". */
export function sentenceKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A ledger of sentences already placed in the guide. */
export class SaidOnce {
  private readonly seen = new Set<string>();
  /** True the first time a sentence is offered; false for every repeat (and for empty text). */
  take(text: string | undefined | null): text is string {
    if (!text) return false;
    const key = sentenceKey(text);
    if (key.length === 0 || this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
  has(text: string): boolean {
    return this.seen.has(sentenceKey(text));
  }
  /** The texts not said yet, recorded as said, in order. */
  filter(texts: readonly (string | undefined | null)[]): string[] {
    return texts.filter((text): text is string => this.take(text));
  }
}

const SCRIPT_LANG: Record<string, string> = { JP: 'ja', CN: 'zh-Hans', TW: 'zh-Hant', HK: 'zh-Hant', MO: 'zh-Hant', KR: 'ko', TH: 'th', GR: 'el', RU: 'ru', UA: 'uk', IL: 'he', AE: 'ar', SA: 'ar', EG: 'ar', IN: 'hi', NP: 'ne', GE: 'ka', AM: 'hy' };

export function zoneLabel(timeZone: string, isoDate: string): { id: string; abbreviation: string } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(`${isoDate}T12:00:00Z`));
    const abbreviation = parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
    return { id: timeZone, abbreviation };
  } catch {
    return undefined;
  }
}

/**
 * One sentence, cut at a word near `max` characters. Longer than the hub's
 * `firstSentence` cap: paper has room for the clause that makes a reason
 * specific, and an ellipsis mid-thought reads worse in print than on screen.
 * The fit model's "You marked X as …, and that is what this delivers:" lead-in
 * is dropped — on a page of twelve stops it is twelve copies of one clause.
 */
export function oneSentence(text: string, max = 230): string {
  const trimmed = text.trim().replace(/^You marked .{1,80}?, and that is what this delivers:\s*/i, '');
  const lead = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const match = /^.*?[.!?](?=\s|$)/.exec(lead);
  const sentence = (match ? match[0] : lead).trim();
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[,;:\s]+$/, '')}…`;
}

function weekdayOf(isoDate: string): string {
  const parsed = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

function longDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? isoDate : parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function nightsBetween(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : 0;
}

function modeLabel(mode: string): string {
  return (TRANSPORT_MODE_LABELS as Record<string, string>)[mode] ?? mode.replace(/_/g, ' ');
}

/** The photo a frame may print: a durable, licensed record whose subject is not a weak guess. */
function photoFor(placeId: string | undefined, name: string, images: GuideInput['images']): GuidePhoto | undefined {
  if (!placeId) return undefined;
  const image = images[placeId];
  if (!image || image.subjectConfidence === 'weak') return undefined;
  /* Licence-aware (`imageCropPolicy`): a share-alike crop prints its conditions in the credit itself — paper has no links to follow. */
  const policy = imageCropPolicy(image.licenceId);
  const notice = policy.crop === 'with_notice' && policy.notice ? ` · ${policy.notice.text}${policy.notice.licenceUrl ? ` (${policy.notice.licenceUrl.replace(/^https?:\/\//, '')})` : ''}` : '';
  return { src: image.thumbnailUrl, alt: name, credit: `${image.attributionText}${notice}`, crop: policy.crop !== 'never' };
}

type Precision = 'fixed' | 'measured' | 'estimated' | 'band';

/** The same clock honesty as the hub: once a leg could not be timed, later clocks become parts of the day. */
function precisionByItem(day: ItineraryDay): Record<string, Precision> {
  const out: Record<string, Precision> = {};
  const rank: Record<Precision, number> = { fixed: 0, measured: 0, estimated: 1, band: 2 };
  let state: Precision = 'measured';
  for (const item of [...day.items].sort((a, b) => a.startMinute - b.startMinute || (a.kind === 'travel' ? -1 : 1))) {
    if (item.kind === 'travel') {
      const own: Precision =
        item.timing?.precision ??
        (item.travel?.provenance === 'measured' ? 'measured' : item.travel?.provenance === 'estimated' ? 'estimated' : item.travel && item.travel.fromId !== item.travel.toId ? 'band' : 'measured');
      if (rank[own] > rank[state]) state = own;
      out[item.id] = own;
      continue;
    }
    out[item.id] = item.timing?.precision === 'fixed' ? 'fixed' : state;
  }
  return out;
}

function lineStyle(style: string): GuideLineStyle {
  if (style === 'flight' || style === 'boat' || style === 'rail' || style === 'trail') return style;
  if (style === 'estimated') return 'estimated';
  if (style === 'unmeasured') return 'unmeasured';
  return 'measured';
}

function travelPhrase(item: ItineraryItem): { title: string; duration?: string; approx: boolean } {
  const travel = item.travel!;
  const mode = modeLabel(travel.mode);
  const title = `${mode} to ${travel.toName}`;
  if (travel.minutes === null) return { title, duration: 'time not measured', approx: true };
  const approx = travel.provenance !== 'measured' && travel.provenance !== 'official';
  /* Eval v3 — `≥` for a floor proved from measured legs, `≈` for an estimate. */
  const mark = travelFigurePrefix(travel);
  return { title, duration: `${mark ? `${mark} ` : ''}${travelSpan(travel.minutes)}${travel.feasibility === 'bounded_estimate' ? ' at least' : ''}`, approx };
}

function intensityWord(value: ItineraryDay['intensity']): GuideDay['intensity'] {
  return value === 'intense' ? 'Full' : value === 'moderate' ? 'Moderate' : 'Light';
}

interface StayRun {
  id: string;
  name: string;
  firstDate: string;
  lastDate: string;
  nights: number;
}

/** Consecutive days at one base, with the night count a hotel would charge. */
export function stayRuns(itinerary: Itinerary): StayRun[] {
  const bases = new Map((itinerary.package?.bases ?? []).map((base) => [base.id, base] as const));
  const runs: StayRun[] = [];
  for (const day of itinerary.days) {
    const last = runs[runs.length - 1];
    if (last && last.id === day.baseId) {
      last.lastDate = day.date;
      last.nights += 1;
      continue;
    }
    const base = bases.get(day.baseId);
    runs.push({ id: day.baseId, name: base?.displayName ?? base?.name ?? day.baseName, firstDate: day.date, lastDate: day.date, nights: 1 });
  }
  // The last day is a departure, not a night.
  if (runs.length > 0) runs[runs.length - 1]!.nights = Math.max(0, runs[runs.length - 1]!.nights - 1);
  return runs.filter((run) => run.nights > 0);
}

function lodgingFor(run: StayRun, booked: readonly BookedPlanItem[]): BookedPlanItem | undefined {
  return booked.find((item) => {
    if (item.type !== 'lodging' || item.status !== 'booked') return false;
    if (item.baseId && item.baseId === run.id) return true;
    if (!item.date) return false;
    const end = item.endDate ?? item.date;
    return item.date <= run.lastDate && end >= run.firstDate;
  });
}

function needStatus(item: TravelIntelligence['bookings']['items'][number], resolutions: readonly BookingResolution[]): string {
  const resolution = resolutions.find((entry) => entry.bookingItemId === item.id)?.resolution;
  if (resolution === 'skipped') return 'Skipped';
  if (resolution === 'replaced') return 'Replaced';
  if (resolution === 'not_needed') return 'Not needed';
  if (item.status === 'booked') return 'Booked';
  if (item.status === 'soft_hold') return 'Held';
  if (item.status === 'not_needed') return 'Not needed';
  return 'To book';
}

function priorityWord(item: TravelIntelligence['bookings']['items'][number]): GuideBooking['priority'] {
  if (item.necessity === 'required') return 'Essential';
  if (item.necessity === 'strongly_recommended' || item.priority === 'book_first' || item.priority === 'book_soon') return 'Recommended';
  return 'Optional';
}

/** A map from day items: numbered stops, the base as "A", lines by how each leg is known. */
function dayMap(day: ItineraryDay, input: GuideInput, nameOf: (placeId: string, fallback: string) => string): GuideMap | undefined {
  const model = dayMapModel({ day, coordinates: input.coordinates, nameOf });
  if (model.markers.length === 0) return undefined;
  const points: GuideMap['points'] = model.markers.map((marker) => ({ lat: marker.coordinates.lat, lng: marker.coordinates.lng, label: String(marker.order ?? ''), name: marker.name, kind: 'stop' as const }));
  if (model.base) points.unshift({ lat: model.base.lat, lng: model.base.lng, label: 'A', name: day.baseName, kind: 'base' });
  const lines = model.connectors.map((connector) => ({ points: connector.path ? [...connector.path] : [connector.from, connector.to], style: lineStyle(connector.style) }));
  return { points, lines, unplaced: model.omitted };
}

/** The whole route: each base once (lettered), every positioned stop as a dot, bases joined in order. */
function overviewMap(input: GuideInput, runs: StayRun[]): GuideMap | undefined {
  const points: GuideMap['points'] = [];
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const baseSeen = new Map<string, string>();
  const baseOrder: { lat: number; lng: number }[] = [];
  for (const run of runs) {
    const point = input.coordinates[run.id];
    if (!point) continue;
    baseOrder.push(point);
    if (baseSeen.has(run.id)) continue;
    const label = letters[baseSeen.size] ?? '•';
    baseSeen.set(run.id, label);
    points.push({ ...point, label, name: run.name, kind: 'base' });
  }
  let unplaced = 0;
  let stopNumber = 0;
  for (const day of input.itinerary.days) {
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      const point = input.coordinates[item.placeId];
      if (!point) {
        unplaced += 1;
        continue;
      }
      stopNumber += 1;
      points.push({ ...point, label: String(day.dayNumber), name: input.rationale[item.placeId]?.name ?? item.title, kind: 'stop' });
    }
  }
  if (points.length === 0) return undefined;
  const lines: GuideMap['lines'] = [];
  for (let index = 1; index < baseOrder.length; index += 1) {
    const from = baseOrder[index - 1]!;
    const to = baseOrder[index]!;
    if (from.lat !== to.lat || from.lng !== to.lng) lines.push({ points: [from, to], style: 'unmeasured' });
  }
  // Within a single-base trip, connect each day's stops so the overview reads as a route.
  for (const day of input.itinerary.days) {
    const map = dayMap(day, input, (id, fallback) => input.rationale[id]?.name ?? fallback);
    for (const line of map?.lines ?? []) if (line.style !== 'unmeasured' || baseOrder.length <= 1) lines.push(line);
  }
  void stopNumber;
  return { points, lines, unplaced };
}

export function assembleGuide(input: GuideInput): GuideModel {
  const { itinerary, intelligence, variant, audience } = input;
  const limits = LIMITS[variant];
  const complete = variant === 'complete';
  const owner = audience === 'owner';
  const said = new SaidOnce();
  const pkg = itinerary.package;
  const nameOf = (placeId: string, fallback: string) => input.rationale[placeId]?.name ?? fallback;
  const country = countryFacts(intelligence.destinationContext.countryCode);
  const runs = stayRuns(itinerary);
  const bases = new Map((pkg?.bases ?? []).map((base) => [base.id, base] as const));

  /* Identity. The thesis is the draft's own sentence, said once, here. */
  const thesis = input.personality ? firstSentence(input.personality) : pkg?.purpose ? firstSentence(pkg.purpose) : undefined;
  said.take(thesis);
  said.take(input.personality);
  said.take(pkg?.purpose);
  const route: string[] = [];
  for (const run of runs) if (route[route.length - 1] !== run.name) route.push(run.name);
  if (route.length === 0) route.push(itinerary.baseName);
  const partyBits: string[] = [];
  if (owner && input.trip.adults) partyBits.push(`${input.trip.adults} ${input.trip.adults === 1 ? 'adult' : 'adults'}`);
  if (owner && input.trip.children) partyBits.push(`${input.trip.children} ${input.trip.children === 1 ? 'child' : 'children'}`);
  const zone = input.timeZone ? zoneLabel(input.timeZone, itinerary.startDate) : undefined;

  /* Warnings true on most days are said once, in the overview. */
  const warningDays = new Map<string, { text: string; days: number }>();
  for (const day of itinerary.days) {
    for (const warning of new Set(day.warnings)) {
      const key = sentenceKey(warning);
      const entry = warningDays.get(key) ?? { text: warning, days: 0 };
      entry.days += 1;
      warningDays.set(key, entry);
    }
  }
  const throughoutCut = Math.max(3, Math.ceil(itinerary.days.length * 0.5));
  const throughout = [...warningDays.values()].filter((entry) => entry.days >= throughoutCut && itinerary.days.length >= 3).map((entry) => entry.text);
  said.filter(throughout);

  /* Stays. */
  const stays: GuideStay[] = runs.map((run) => {
    const base = bases.get(run.id);
    const lodging = owner ? lodgingFor(run, input.booked) : undefined;
    const why = base?.why ? firstSentence(base.why) : undefined;
    return {
      name: run.name,
      ...(base?.area && base.area !== run.name ? { area: base.area } : {}),
      nights: run.nights,
      dates: `${humanDate(run.firstDate)} – ${humanDate(run.lastDate)}`,
      ...(why && said.take(why) ? { why } : {}),
      ...(owner ? { status: lodging ? ('Booked' as const) : ('To book' as const) } : {}),
      ...(owner && lodging ? { booked: lodging.location ? `${lodging.title}, ${lodging.location}` : lodging.title } : {}),
    };
  });

  /* Highlights: the plan's scored signatures first, then what not to miss. */
  const highlights: GuideModel['glance']['highlights'] = [];
  const highlightNames = new Set<string>();
  for (const signature of pkg?.signatures ?? []) {
    if (highlights.length >= limits.highlights) break;
    const why = signature.why ? firstSentence(signature.why) : undefined;
    highlightNames.add(sentenceKey(signature.name));
    highlights.push({ name: signature.name, dayNumber: signature.dayNumber, ...(why && said.take(why) ? { why } : {}) });
  }
  for (const entry of intelligence.regret.dontMiss) {
    if (highlights.length >= limits.highlights) break;
    if (highlightNames.has(sentenceKey(entry.name))) continue;
    const day = itinerary.days.find((d) => d.items.some((item) => sentenceKey(item.title) === sentenceKey(entry.name)));
    if (!day) continue;
    highlightNames.add(sentenceKey(entry.name));
    const why = firstSentence(entry.why);
    highlights.push({ name: entry.name, dayNumber: day.dayNumber, ...(said.take(why) ? { why } : {}) });
  }

  /* Days. */
  const backupsByDay = new Map(intelligence.backups.map((entry) => [entry.dayNumber, entry] as const));
  const authoredBackups = pkg?.backups ?? [];
  let previousBase: string | null = null;
  let previousBaseName: string | null = null;
  const usedPhotos = new Set<string>();
  const days: GuideDay[] = itinerary.days.map((day) => {
    const precision = precisionByItem(day);
    const map = dayMap(day, input, nameOf);
    const pinOf = new Map<string, string>();
    for (const point of map?.points ?? []) if (point.kind === 'stop') pinOf.set(sentenceKey(point.name), point.label);
    const items: GuideItem[] = [];
    for (const item of [...day.items].sort((a, b) => a.startMinute - b.startMinute)) {
      const p = precision[item.id] ?? 'measured';
      const time = p === 'band' ? dayPartFor(item.startMinute) : timelineClock(item.startMinute, 'later');
      const approx = p === 'estimated' || p === 'band';
      if (item.kind === 'travel') {
        if (!item.travel || item.travel.fromId === item.travel.toId) continue;
        if (item.travel.minutes !== null && item.travel.minutes < 3) continue;
        const phrase = travelPhrase(item);
        items.push({ kind: 'travel', time: null, approx: phrase.approx, title: phrase.title, ...(phrase.duration ? { duration: phrase.duration } : {}) });
        continue;
      }
      if (item.kind === 'activity') {
        const title = item.placeId ? nameOf(item.placeId, item.title) : item.title;
        const reason = (item.placeId ? input.rationale[item.placeId]?.why : undefined) ?? item.note ?? item.reason;
        const detail = reason ? oneSentence(reason) : undefined;
        const flag = item.booking ? (item.booking.kind === 'timed_entry' ? 'Timed entry' : 'Book ahead') : undefined;
        const pin = pinOf.get(sentenceKey(title));
        items.push({
          kind: 'stop',
          time,
          approx,
          title,
          ...(detail && !/^matches your interest/i.test(detail) && said.take(detail) ? { detail } : {}),
          ...(item.durationMinutes > 0 ? { duration: span(item.durationMinutes) } : {}),
          ...(pin ? { pin } : {}),
          ...(flag ? { flag } : {}),
        });
        continue;
      }
      if (item.kind === 'meal') {
        items.push({ kind: 'meal', time, approx, title: item.title, ...(item.note && said.take(item.note) ? { detail: firstSentence(item.note) } : {}) });
        continue;
      }
      items.push({ kind: item.kind === 'rest' ? 'rest' : 'free', time, approx, title: item.title, ...(item.durationMinutes > 0 ? { duration: span(item.durationMinutes) } : {}) });
    }

    const notes = said.filter([...day.warnings, ...(pkg?.planning?.dayNotes ?? []).filter((note) => note.dayNumber === day.dayNumber).map((note) => note.note)]).slice(0, limits.dayNotes);

    let backup: string | undefined;
    if (complete) {
      const authored = authoredBackups.find((entry) => entry.dayNumbers?.includes(day.dayNumber));
      const derived = backupsByDay.get(day.dayNumber)?.fallback;
      const text = authored ? `${authored.trigger}: ${authored.alternative}` : derived ? `${derived.trigger}: ${derived.name}` : undefined;
      if (text && said.take(text)) backup = firstSentence(text);
    }

    let photo: GuidePhoto | undefined;
    if (complete) {
      for (const item of day.items) {
        if (item.kind !== 'activity' || !item.placeId || usedPhotos.has(item.placeId)) continue;
        const candidate = photoFor(item.placeId, nameOf(item.placeId, item.title), input.images);
        if (candidate) {
          usedPhotos.add(item.placeId);
          photo = candidate;
          break;
        }
      }
    }

    const baseName = bases.get(day.baseId)?.displayName ?? bases.get(day.baseId)?.name ?? day.baseName;
    const move = previousBase !== null && previousBase !== day.baseId && previousBaseName ? { from: previousBaseName, to: baseName } : undefined;
    previousBase = day.baseId;
    previousBaseName = baseName;
    const travelMinutes = day.totals.travelMinutes;

    return {
      number: day.dayNumber,
      isoDate: day.date,
      weekday: weekdayOf(day.date),
      dateLabel: longDate(day.date),
      base: baseName,
      ...(move ? { move } : {}),
      theme: day.theme,
      intensity: intensityWord(day.intensity),
      items,
      notes,
      ...(backup ? { backup } : {}),
      ...(photo ? { photo } : {}),
      ...(complete && map ? { map } : {}),
      ...(travelMinutes > 0 ? { travel: `${travelSpan(travelMinutes)} on the move` } : {}),
    };
  });

  /* Getting around. */
  const strategy = itinerary.transportStrategy;
  const transportPoints = said
    .filter([...strategy.rationale, pkg?.transport.summary, ...(pkg?.transport.notes ?? []), ...strategy.seasonalWarnings, ...strategy.verifyBeforeTravel].map((text) => (text ? firstSentence(text) : text)))
    .slice(0, limits.transportPoints);
  const moves = days
    .filter((day) => day.move)
    .map((day) => {
      const source = itinerary.days.find((d) => d.dayNumber === day.number)!;
      const leg = source.items.find((item) => item.kind === 'travel' && item.travel && item.travel.role !== 'approach' && item.travel.fromId !== item.travel.toId) ?? source.items.find((item) => item.kind === 'travel' && item.travel);
      const how = leg?.travel ? (leg.travel.minutes === null ? `${modeLabel(leg.travel.mode)} · time not measured` : `${modeLabel(leg.travel.mode)} · ${((mark) => (mark ? `${mark} ` : ''))(travelFigurePrefix(leg.travel))}${travelSpan(leg.travel.minutes)}`) : modeLabel(source.transport.primaryMode as TransportMode);
      return { day: day.number, from: day.move!.from, to: day.move!.to, how };
    });

  /* Bookings: the needs, never the owner's private facts on a shared copy. */
  const resolutions = input.resolutions ?? [];
  const bookings: GuideBooking[] = intelligence.bookings.items
    .filter((item) => !item.memberIds)
    .map((item) => {
      const status = owner ? needStatus(item, resolutions) : undefined;
      const when = item.date ? humanDate(item.date) : item.dayNumber ? `Day ${item.dayNumber}` : undefined;
      return {
        title: item.title,
        ...(when ? { when } : {}),
        action: firstSentence(item.travelerAction),
        priority: priorityWord(item),
        ...(item.deadline ? { deadline: humanDate(item.deadline) } : item.bookingWindow ? { deadline: item.bookingWindow } : {}),
        ...(status ? { status } : {}),
      };
    })
    .filter((item) => complete || item.priority !== 'Optional' || item.status === 'Booked')
    .sort((a, b) => ['Essential', 'Recommended', 'Optional'].indexOf(a.priority) - ['Essential', 'Recommended', 'Optional'].indexOf(b.priority))
    .slice(0, limits.bookings);

  /* Before you go: the plan's own list, then readiness actions, each once. */
  const readinessActions = intelligence.readiness.entries
    .filter((entry) => entry.state !== 'not_applicable' && entry.tier === 'primary' && entry.phase !== 'keep_offline')
    .map((entry) => (entry.action ? `${entry.title}: ${firstSentence(entry.action)}` : null));
  const beforeYouGo = said.filter([...(pkg?.beforeYouGo ?? []).map((text) => firstSentence(text)), ...readinessActions]).slice(0, limits.beforeYouGo);

  const packing: GuideModel['prep']['packing'] = [];
  if (complete) {
    const groups = new Map<string, string[]>();
    for (const item of intelligence.packing.items.slice(0, limits.packing)) {
      const label = (PACKING_CATEGORY_LABELS as Record<string, string>)[item.category] ?? item.category;
      const list = groups.get(label) ?? [];
      list.push(item.optional ? `${item.label} (optional)` : item.label);
      groups.set(label, list);
    }
    for (const [category, items] of groups) packing.push({ category, items });
  }

  /* Links that become QR codes. Raw URLs are never printed. */
  const links: GuideLink[] = [];
  const shortOf = (url: string) => {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return undefined;
    }
  };
  if (owner && input.links.trip) links.push({ label: 'This trip in Sidequest', note: 'Your live copy: changes, Today view and offline pages.', url: input.links.trip });
  if (input.links.share) {
    const short = shortOf(input.links.share);
    links.push({ label: owner ? 'Read-only copy for companions' : 'This trip online', note: 'Anyone with this link can read the plan.', url: input.links.share, ...(short ? { short } : {}) });
  }
  for (const day of itinerary.days) {
    const stops: MapStop[] = day.items
      .filter((item) => item.kind === 'activity' && item.placeId !== undefined && input.coordinates[item.placeId] !== undefined)
      .map((item) => ({ id: item.placeId!, name: nameOf(item.placeId!, item.title), ...input.coordinates[item.placeId!]! }));
    if (stops.length === 0) continue;
    const mode = day.totals.unverifiedMinutes > 0 ? 'transit' : mapModeFor(day.transport.modes);
    const url = stops.length === 1 ? placeNavigationLinks({ lat: stops[0]!.lat, lng: stops[0]!.lng, name: stops[0]!.name }).google : dayRouteLinks(stops, mode)?.google;
    if (!url) continue;
    links.push({ label: `Day ${day.dayNumber} in Google Maps`, note: stops.length === 1 ? stops[0]!.name : `${stops.length} stops, in order`, url });
  }

  /* Appendices, complete copy only. */
  let appendix: GuideModel['appendix'];
  if (complete) {
    const planning = said.filter([pkg?.routeRationale, pkg?.timingRationale, ...(pkg?.tradeoffs ?? []), ...(pkg?.assumptions ?? []), strategy.headline]);
    const positions: NonNullable<GuideModel['appendix']>['positions'] = [];
    for (const day of itinerary.days) {
      for (const item of day.items) {
        if (item.kind !== 'activity' || !item.placeId) continue;
        const point = input.coordinates[item.placeId];
        if (point) positions.push({ day: day.dayNumber, name: nameOf(item.placeId, item.title), coordinates: coordinatePair(point) });
      }
    }
    let budget: NonNullable<GuideModel['appendix']>['budget'];
    const b = intelligence.budget;
    if (owner && b.lines.length > 0) {
      const money = (n: number) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(n);
      budget = {
        currency: b.currency,
        lines: b.lines
          .filter((line) => line.precision !== 'unknown')
          .map((line) => ({ label: line.category.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), range: `${money(line.low)}–${money(line.high)}${line.perPerson ? ' pp' : ''}`, basis: firstSentence(line.basis) })),
        total: `${b.currency} ${money(b.total.low)}–${money(b.total.high)}${b.total.perPerson ? ' per person' : ''}`,
        note: firstSentence(b.conversionNote),
      };
    }
    appendix = {
      planning,
      ...(budget ? { budget } : {}),
      positions,
      skip: input.worthSkipping.slice(0, 6).map((entry) => ({ name: entry.name, reason: firstSentence(entry.reason) })),
    };
  }

  /* Cover photograph: a signature first, then any landscape image on the plan. */
  const placeIdsInOrder = itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'activity' && item.placeId).map((item) => item.placeId!));
  const signatureIds = (pkg?.signatures ?? []).map((signature) => pkg?.anchors.find((anchor) => anchor.id === signature.id)?.placeId).filter((id): id is string => Boolean(id));
  const coverCandidates = [...new Set([...signatureIds, ...placeIdsInOrder])].filter((id) => photoFor(id, '', input.images));
  const coverScore = (id: string) => {
    const image = input.images[id]!;
    const ratio = image.width / image.height;
    // A croppable landscape fills the cover; a whole-frame one must at least not be a sliver.
    return (image.useTier === 'modifiable' ? 2 : 0) + (ratio >= 1.15 && ratio <= 2.2 ? 2 : ratio > 2.2 ? 0.5 : 0);
  };
  const coverId = [...coverCandidates].sort((a, b) => coverScore(b) - coverScore(a))[0];
  const coverName = coverId ? nameOf(coverId, input.trip.destination) : '';
  const coverPhoto = coverId ? photoFor(coverId, coverName, input.images) : undefined;

  const photoCredits = new Set<string>();
  if (coverPhoto) photoCredits.add(`${coverName}: ${coverPhoto.credit}`);
  for (const day of days) if (day.photo) photoCredits.add(`${day.photo.alt}: ${day.photo.credit}`);

  const placedStops = days.reduce((sum, day) => sum + day.items.filter((item) => item.kind === 'stop').length, 0);
  const figures: GuideModel['glance']['figures'] = [
    { label: 'Days', value: String(itinerary.days.length) },
    { label: 'Stays', value: String(new Set(runs.map((run) => run.id)).size || 1) },
    { label: 'Stops', value: String(placedStops) },
  ];
  if (strategy.totals.driveKm > 0) figures.push({ label: 'Driving', value: `${Math.round(strategy.totals.driveKm)} km` });

  const getAround = strategy.headline && said.take(strategy.headline) ? firstSentence(strategy.headline) : undefined;
  const placeLang = intelligence.destinationContext.countryCode ? SCRIPT_LANG[intelligence.destinationContext.countryCode.toUpperCase()] : undefined;

  return {
    variant,
    audience,
    ...(placeLang ? { placeLang } : {}),
    identity: {
      title: input.trip.destination,
      ...(thesis ? { thesis } : {}),
      dateRange: `${formatDateRange(input.trip.startDate, input.trip.endDate)} ${input.trip.endDate.slice(0, 4)}`,
      dayCount: itinerary.days.length,
      nightCount: nightsBetween(itinerary.startDate, itinerary.endDate),
      route,
      ...(partyBits.length > 0 ? { party: partyBits.join(', ') } : {}),
      ...(zone ? { timeZone: zone } : {}),
      generatedOn: input.generatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    },
    cover: { ...(coverPhoto ? { photo: coverPhoto } : {}) },
    glance: {
      ...(overviewMap(input, runs) ? { map: overviewMap(input, runs)! } : {}),
      stays,
      highlights,
      ...(getAround ? { getAround } : {}),
      throughout,
      figures,
    },
    days,
    stays,
    transport: { ...(getAround ? { headline: getAround } : {}), points: transportPoints, moves },
    bookings,
    prep: { beforeYouGo, packing },
    reference: {
      ...(country
        ? {
            country: {
              name: country.name,
              emergency: country.emergency,
              ...(country.emergencyNotes ? { emergencyNotes: country.emergencyNotes } : {}),
              drivingSide: country.drivingSide,
              currency: country.currency,
              plugs: country.plugs,
              voltage: country.voltage,
              callingCode: country.callingCode,
              languages: country.languages,
            },
          }
        : {}),
      links,
    },
    ...(appendix ? { appendix } : {}),
    credits: { photos: [...photoCredits], data: [...new Set(input.attributions)] },
  };
}
