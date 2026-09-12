import type { Itinerary, ItineraryDay, Trip } from '@sidequest/core';
import { formatMinuteOfDay } from '@sidequest/core';
import { formatDateRange } from '@/lib/format';

/**
 * V9 §11 — THE TRIP AS A PICTURE, WITH NOTHING PRIVATE IN IT.
 *
 * Two models and the elements that draw them. The overview card is what a
 * share link previews and what a traveller posts: destination, dates, the
 * bases in order, and a readiness word taken from the feasibility report —
 * never a booking, a price, a reference or who is travelling. The day card is
 * the vertical one a phone shows: the day's number, its theme, its base and up
 * to five stops with times.
 *
 * Pure functions of the trip and the itinerary, so they are tested as data;
 * the elements are plain JSX for `ImageResponse`: flexbox only, `display:
 * flex` on every multi-child box, no grid, the default font, no asset fetched.
 */
export const OVERVIEW_CARD_SIZE = { width: 1200, height: 630 } as const;
export const DAY_CARD_SIZE = { width: 1080, height: 1350 } as const;

const ATLAS = '#101d24';
const ATLAS_RAISED = '#16262f';
const ATLAS_INK = '#e9eef0';
const ATLAS_MUTED = '#9fb3bb';
const OCHRE = '#a94f27';
const OCHRE_SOFT = '#f5e3d6';
const PINE = '#2f5d50';
const AMBER = '#b8860b';

export type ReadinessTone = 'ready' | 'nearly' | 'attention' | 'blocked';

export interface OverviewCardModel {
  destination: string;
  dates: string;
  dayCount: number;
  stopCount: number;
  /** Bases in order with nights: "Reykjavík · 2 nights". */
  route: { name: string; nights: number }[];
  /** Only from the feasibility report; null when the plan carries none. */
  readiness: { label: string; tone: ReadinessTone } | null;
}

/** The readiness word a picture may say, and where it may come from. */
export function readinessFromFeasibility(verdict: string | undefined): OverviewCardModel['readiness'] {
  switch (verdict) {
    case 'feasible':
      return { label: 'Ready', tone: 'ready' };
    case 'feasible_with_cautions':
      return { label: 'Nearly ready', tone: 'nearly' };
    case 'unresolved_major_dependency':
      return { label: 'A decision still open', tone: 'attention' };
    case 'infeasible':
      return { label: 'Needs rework', tone: 'blocked' };
    default:
      return null;
  }
}

/** The bases in the order the days sleep in them, with a night count each. */
export function baseRouteOf(itinerary: Itinerary): { name: string; nights: number }[] {
  const packageBases = new Map((itinerary.package?.bases ?? []).map((base) => [base.id, base] as const));
  const route: { id: string; name: string; nights: number }[] = [];
  for (const day of itinerary.days) {
    const last = route[route.length - 1];
    if (last && last.id === day.baseId) {
      last.nights += 1;
      continue;
    }
    const base = packageBases.get(day.baseId);
    route.push({ id: day.baseId, name: base?.displayName ?? base?.name ?? day.baseName, nights: 1 });
  }
  /* A day is a night except the last one, which is a departure. */
  if (route.length > 0) route[route.length - 1]!.nights = Math.max(0, route[route.length - 1]!.nights - 1);
  return route.map(({ name, nights }) => ({ name, nights }));
}

export function overviewCardModel(trip: Pick<Trip, 'basics'>, itinerary: Itinerary): OverviewCardModel {
  return {
    destination: trip.basics.destinationInput,
    dates: formatDateRange(itinerary.startDate, itinerary.endDate),
    dayCount: itinerary.days.length,
    stopCount: itinerary.days.reduce((sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length, 0),
    route: baseRouteOf(itinerary),
    readiness: readinessFromFeasibility(itinerary.package?.feasibility?.verdict),
  };
}

export interface DayCardModel {
  destination: string;
  dayNumber: number;
  dayCount: number;
  dateLabel: string;
  theme: string;
  base: string;
  stops: { time: string; title: string }[];
  /** Stops beyond the five shown. */
  more: number;
}

const DAY_CARD_STOPS = 5;

export function dayCardModel(trip: Pick<Trip, 'basics'>, itinerary: Itinerary, day: ItineraryDay): DayCardModel {
  const packageBase = itinerary.package?.bases.find((base) => base.id === day.baseId);
  const activities = day.items.filter((item) => item.kind === 'activity');
  /* Meals fill in only when a day has fewer than three activities, so a quiet day still shows a shape. */
  const chosen = activities.length >= 3 ? activities : day.items.filter((item) => item.kind === 'activity' || item.kind === 'meal');
  const stops = chosen.slice(0, DAY_CARD_STOPS).map((item) => ({ time: formatMinuteOfDay(item.startMinute), title: item.title }));
  return {
    destination: trip.basics.destinationInput,
    dayNumber: day.dayNumber,
    dayCount: itinerary.days.length,
    dateLabel: formatDateRange(day.date, day.date),
    theme: day.theme,
    base: packageBase?.displayName ?? packageBase?.name ?? day.baseName,
    stops,
    more: Math.max(0, chosen.length - stops.length),
  };
}

function toneColour(tone: ReadinessTone): string {
  return tone === 'ready' ? PINE : tone === 'nearly' ? AMBER : OCHRE;
}

/** The 1200×630 overview: what a share link previews. */
export function OverviewCard({ model }: { model: OverviewCardModel }) {
  const routeLine = model.route.map((base) => (base.nights > 0 ? `${base.name} · ${base.nights} ${base.nights === 1 ? 'night' : 'nights'}` : base.name)).join('   →   ');
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: ATLAS, color: ATLAS_INK, padding: '56px 64px', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ width: 18, height: 18, borderRadius: 9, background: OCHRE, marginRight: 14 }} />
          <div style={{ fontSize: 26, letterSpacing: 2, color: ATLAS_MUTED }}>SIDEQUEST</div>
        </div>
        {model.readiness ? (
          <div style={{ display: 'flex', alignItems: 'center', fontSize: 26, color: ATLAS_INK }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: toneColour(model.readiness.tone), marginRight: 12 }} />
            <div>{model.readiness.label}</div>
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: model.destination.length > 24 ? 72 : 96, fontWeight: 700, lineHeight: 1.05, color: ATLAS_INK }}>{model.destination}</div>
        <div style={{ fontSize: 34, color: ATLAS_MUTED, marginTop: 20 }}>{`${model.dates} · ${model.dayCount} ${model.dayCount === 1 ? 'day' : 'days'} · ${model.stopCount} stops`}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 3, background: OCHRE, width: '100%', marginBottom: 22 }} />
        <div style={{ fontSize: 28, color: ATLAS_INK, lineHeight: 1.3 }}>{routeLine || 'Route to come'}</div>
      </div>
    </div>
  );
}

/** The 1080×1350 vertical day card. */
export function DayCard({ model }: { model: DayCardModel }) {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: ATLAS, color: ATLAS_INK, padding: '64px 72px', fontFamily: 'sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 28, letterSpacing: 2, color: ATLAS_MUTED }}>{model.destination.toUpperCase()}</div>
        <div style={{ fontSize: 28, color: ATLAS_MUTED }}>{`Day ${model.dayNumber} of ${model.dayCount}`}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 48 }}>
        <div style={{ fontSize: 40, color: OCHRE_SOFT }}>{model.dateLabel}</div>
        <div style={{ fontSize: model.theme.length > 40 ? 56 : 72, fontWeight: 700, lineHeight: 1.1, marginTop: 12 }}>{model.theme}</div>
        <div style={{ fontSize: 32, color: ATLAS_MUTED, marginTop: 18 }}>{`Sleeping in ${model.base}`}</div>
      </div>
      <div style={{ height: 3, background: OCHRE, width: '100%', marginTop: 44, marginBottom: 36 }} />
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
        {model.stops.length === 0 ? (
          <div style={{ fontSize: 34, color: ATLAS_MUTED }}>A quiet day — nothing timed.</div>
        ) : (
          model.stops.map((stop, index) => (
            <div key={`${stop.time}-${index}`} style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 30 }}>
              <div style={{ width: 150, fontSize: 36, color: OCHRE_SOFT, flexShrink: 0 }}>{stop.time}</div>
              <div style={{ fontSize: 40, lineHeight: 1.2, flexGrow: 1, background: ATLAS_RAISED, padding: '14px 22px', borderRadius: 16 }}>{stop.title}</div>
            </div>
          ))
        )}
        {model.more > 0 ? <div style={{ fontSize: 30, color: ATLAS_MUTED, marginTop: 6 }}>{`+ ${model.more} more`}</div> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 24 }}>
        <div style={{ width: 16, height: 16, borderRadius: 8, background: OCHRE, marginRight: 14 }} />
        <div style={{ fontSize: 26, letterSpacing: 2, color: ATLAS_MUTED }}>SIDEQUEST</div>
      </div>
    </div>
  );
}
