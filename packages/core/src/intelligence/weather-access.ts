import { z } from 'zod';
import type { Itinerary, ItineraryDay, ItineraryItem } from '../schemas/itinerary';

/**
 * WEATHER, CLIMATE, DAYLIGHT — WITH THE WORD FOR WHAT EACH ONE IS.
 *
 * A forecast is a statement about dates inside the provider's horizon. Climate
 * is what this period has done in past years. Neither is deleted from the plan
 * because the other is missing; the plan carries Plan A, a fallback and the
 * moment to decide.
 */
export const WEATHER_KINDS = ['forecast', 'climate', 'unavailable'] as const;
export const weatherKindSchema = z.enum(WEATHER_KINDS);

export const weatherSensitiveItemSchema = z.object({
  itemId: z.string().min(1),
  title: z.string().min(1),
  sensitivity: z.enum(['high', 'moderate']),
  fallbackType: z.enum(['indoor_alternative', 'reschedule_within_trip', 'shorten', 'go_anyway']),
  decisionPoint: z.enum(['evening_before', 'morning_of']),
});

export const dayWeatherSemanticsSchema = z.object({
  dayNumber: z.number().int().min(1),
  date: z.string().min(1),
  kind: weatherKindSchema,
  horizonNote: z.string().min(1),
  summary: z.string().min(1),
  sunrise: z.string().min(1).optional(),
  sunset: z.string().min(1).optional(),
  sensitiveItems: z.array(weatherSensitiveItemSchema).default([]),
  planA: z.string().min(1),
  fallback: z.string().min(1).optional(),
  decisionPoint: z.string().min(1).optional(),
});
export type DayWeatherSemantics = z.infer<typeof dayWeatherSemanticsSchema>;

export const weatherIntelligenceSchema = z.object({
  days: z.array(dayWeatherSemanticsSchema),
  packingBasis: z.enum(['forecast', 'climate', 'unknown']),
  providerNote: z.string().min(1),
});
export type WeatherIntelligence = z.infer<typeof weatherIntelligenceSchema>;

const OUTDOOR = new Set(['nature', 'hike', 'viewpoint', 'water', 'wildlife', 'scenic_drive', 'beach', 'geothermal']);

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function buildWeatherIntelligence(input: { itinerary: Itinerary; categoryOf: (item: ItineraryItem) => string; packageBackups: readonly { trigger: string; alternative: string }[] }): WeatherIntelligence {
  const days = input.itinerary.days.map((day) => {
    const kind: (typeof WEATHER_KINDS)[number] = day.weather.evidence === 'forecast' ? 'forecast' : day.weather.evidence === 'historical_pattern' ? 'climate' : 'unavailable';
    const sensitiveItems = day.items
      .filter((item) => item.kind === 'activity' && (item.weatherSensitive || OUTDOOR.has(input.categoryOf(item))))
      .map((item) => {
        const category = input.categoryOf(item);
        const high = item.weatherSensitive || category === 'hike' || category === 'viewpoint' || category === 'scenic_drive' || category === 'beach';
        return weatherSensitiveItemSchema.parse({
          itemId: item.id,
          title: item.title,
          sensitivity: high ? 'high' : 'moderate',
          fallbackType: category === 'hike' || category === 'scenic_drive' ? 'reschedule_within_trip' : category === 'viewpoint' || category === 'beach' ? 'shorten' : day.weather.backups.length > 0 ? 'indoor_alternative' : 'go_anyway',
          decisionPoint: category === 'hike' || category === 'scenic_drive' ? 'evening_before' : 'morning_of',
        });
      });
    const backup = day.weather.backups[0];
    const rainBackup = input.packageBackups.find((b) => /rain|weather|storm|wind|fog|snow/i.test(b.trigger));
    const fallback = backup ? `${backup.name} — ${backup.why}` : rainBackup ? rainBackup.alternative : undefined;
    return dayWeatherSemanticsSchema.parse({
      dayNumber: day.dayNumber,
      date: day.date,
      kind,
      horizonNote: kind === 'forecast' ? 'Inside the forecast horizon when this plan was built; re-read it the evening before.' : kind === 'climate' ? 'Too far out for a forecast. This is what past years have done, not a prediction for the date.' : 'No weather data reached this plan. Nothing outdoors was removed because of that.',
      summary: day.weather.summary,
      ...(day.weather.sunriseMinute !== undefined ? { sunrise: clock(day.weather.sunriseMinute) } : {}),
      ...(day.weather.sunsetMinute !== undefined ? { sunset: clock(day.weather.sunsetMinute) } : {}),
      sensitiveItems,
      planA: day.theme,
      ...(fallback ? { fallback } : {}),
      ...(sensitiveItems.length > 0 ? { decisionPoint: sensitiveItems.some((s) => s.decisionPoint === 'evening_before') ? 'Decide the evening before, on the latest forecast.' : 'Decide on the morning, from the window.' } : {}),
    });
  });
  const kinds = new Set(days.map((d) => d.kind));
  const packingBasis: WeatherIntelligence['packingBasis'] = kinds.size === 1 && kinds.has('forecast') ? 'forecast' : kinds.has('climate') || kinds.has('forecast') ? 'climate' : 'unknown';
  const provider = input.itinerary.days[0]?.weather.provider ?? 'none';
  return weatherIntelligenceSchema.parse({
    days,
    packingBasis,
    providerNote: packingBasis === 'unknown' ? 'No weather provider answered for this plan.' : `Weather from ${provider}. ${packingBasis === 'forecast' ? 'Every day is inside the forecast horizon.' : 'Packing is based on climate because at least one day is beyond the forecast horizon.'}`,
  });
}

// ---------------------------------------------------------------------------
// Access and operating state
// ---------------------------------------------------------------------------

export const ACCESS_STATES = ['confirmed_open', 'confirmed_closed', 'seasonal_unknown', 'hours_known', 'hours_unknown', 'reservation_required', 'permit_required', 'open_access', 'access_unknown', 'temporarily_closed_now'] as const;
export const accessStateSchema = z.enum(ACCESS_STATES);
export type AccessStateCode = z.infer<typeof accessStateSchema>;

export const ACCESS_STATE_LABELS: Record<AccessStateCode, string> = {
  confirmed_open: 'Open on your date',
  confirmed_closed: 'Closed on your date',
  seasonal_unknown: 'Seasonal — not confirmed for your date',
  hours_known: 'Hours known',
  hours_unknown: 'Hours not published — not the same as closed',
  reservation_required: 'Reservation required',
  permit_required: 'Permit required',
  open_access: 'Open ground — no opening hours apply',
  access_unknown: 'Access not verified',
  temporarily_closed_now: 'Temporarily closed at last check — not a verdict on your date',
};

export const accessStateSchemaFull = z.object({
  itemId: z.string().min(1),
  dayNumber: z.number().int().min(1),
  title: z.string().min(1),
  placeId: z.string().min(1).optional(),
  state: accessStateSchema,
  note: z.string().min(1),
  sourceName: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  /** Whether a traveller should phone or check before relying on it. */
  verifyBeforeTravel: z.boolean(),
  /** LIVE WORLD V1 closure — provenance of a provider-backed state. */
  checkedAt: z.string().min(1).optional(),
  attribution: z.string().min(1).optional(),
});
export type AccessStateEntry = z.infer<typeof accessStateSchemaFull>;

/**
 * UNKNOWN HOURS ≠ CLOSED. A lake has no opening hours. Only affirmative
 * evidence produces `confirmed_closed`, and that lives on the item as an
 * access warning the reconciler already wrote.
 */
export function accessStateFor(item: ItineraryItem, day: ItineraryDay, category: string): AccessStateEntry {
  const base = { itemId: item.id, dayNumber: day.dayNumber, title: item.title, ...(item.placeId ? { placeId: item.placeId } : {}) };
  if (item.booking?.kind === 'permit') return accessStateSchemaFull.parse({ ...base, state: 'permit_required', note: item.booking.note ?? 'A permit is needed; arrange it before you go.', ...(item.booking.url ? { sourceUrl: item.booking.url } : {}), verifyBeforeTravel: true });
  if (item.booking?.kind === 'reservation' || item.booking?.kind === 'timed_entry') return accessStateSchemaFull.parse({ ...base, state: 'reservation_required', note: item.booking.note ?? 'Booked entry; turn up without it and you may not get in.', ...(item.booking.url ? { sourceUrl: item.booking.url } : {}), verifyBeforeTravel: true });
  /*
   * LIVE WORLD V1 closure — operational evidence normalised by the
   * reconciler outranks the older heuristics. Only affirmative outcomes
   * confirm or contradict; unknown and unavailable stay unknown.
   */
  const op = item.operational;
  if (op && op.outcome !== 'not_applicable') {
    const prov = { sourceName: op.provider === 'google-places' ? 'Google' : op.provider, checkedAt: op.checkedAt, attribution: op.attribution };
    switch (op.outcome) {
      case 'open_at_time':
        return accessStateSchemaFull.parse({ ...base, state: 'confirmed_open', note: op.note, verifyBeforeTravel: op.recheck, ...prov });
      case 'opens_later':
      case 'closes_earlier':
        return accessStateSchemaFull.parse({ ...base, state: 'hours_known', note: op.note, verifyBeforeTravel: true, ...prov });
      case 'closed_on_date':
      case 'closed_permanently':
        return accessStateSchemaFull.parse({ ...base, state: 'confirmed_closed', note: op.note, verifyBeforeTravel: true, ...prov });
      case 'closed_temporarily_now':
        return accessStateSchemaFull.parse({ ...base, state: 'temporarily_closed_now', note: op.note, verifyBeforeTravel: true, ...prov });
      case 'hours_unknown':
      case 'unavailable':
        return accessStateSchemaFull.parse({ ...base, state: 'hours_unknown', note: op.note, verifyBeforeTravel: true, ...prov });
    }
  }
  if (item.accessWarning && /closed|shut/i.test(item.accessWarning)) return accessStateSchemaFull.parse({ ...base, state: 'confirmed_closed', note: item.accessWarning, verifyBeforeTravel: true });
  if (item.hours) return accessStateSchemaFull.parse({ ...base, state: item.hours.sourceKind === 'official' ? 'confirmed_open' : 'hours_known', note: `Open ${clock(item.hours.openMinute)}–${clock(item.hours.closeMinute)}${item.hours.periodLabel ? ` (${item.hours.periodLabel})` : ''}.`, sourceName: item.hours.sourceName, ...(item.hours.sourceUrl ? { sourceUrl: item.hours.sourceUrl } : {}), verifyBeforeTravel: item.hours.sourceKind !== 'official' });
  if (item.seasonalNote) return accessStateSchemaFull.parse({ ...base, state: 'seasonal_unknown', note: item.seasonalNote, verifyBeforeTravel: true });
  if (OUTDOOR.has(category) || category === 'scenic_drive') return accessStateSchemaFull.parse({ ...base, state: 'open_access', note: 'Open ground; daylight and weather decide, not a gate.', verifyBeforeTravel: false });
  if (item.verifyBeforeTravel) return accessStateSchemaFull.parse({ ...base, state: 'hours_unknown', note: item.verifyBeforeTravel, verifyBeforeTravel: true });
  return accessStateSchemaFull.parse({ ...base, state: item.placeId ? 'hours_unknown' : 'access_unknown', note: item.placeId ? 'Nobody publishes hours for this place in the data Sidequest has. It is kept; check before you rely on it.' : 'Sidequest could not confirm this place independently. It stays on the plan as the model proposed it.', verifyBeforeTravel: true });
}
