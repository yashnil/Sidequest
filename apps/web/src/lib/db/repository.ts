import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  discoverySelectionSchema,
  ITINERARY_VERSION,
  itinerarySchema,
  migrateTravelerProfile,
  type Itinerary,
  questionnaireAnswersSchema,
  countTripDays,
  travelerProfileSchema,
  tripBasicsSchema,
  tripSchema,
  type DiscoverySelection,
  type QuestionnaireAnswers,
  type SelectionSource,
  type SelectionStatus,
  type TravelerProfile,
  type Trip,
  type TripBasics,
  type TripStatus,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * Every read parses through the schema rather than casting. A row written by an
 * older build, or hand-edited, surfaces as a validation error at the boundary
 * instead of as a confusing failure three layers into the scoring code.
 */

interface TripRow {
  id: string;
  mode: string;
  destination_input: string;
  region_id: string;
  start_date: string;
  end_date: string;
  arrival_time: string;
  departure_time: string;
  adults: number;
  children: number;
  traveler_needs: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  trip_id: string;
  profile_version: number;
  answers_json: string;
  profile_json: string | null;
}

interface SelectionRow {
  place_id: string;
  status: string;
  source: string;
  updated_at: string;
}

function rowToTrip(row: TripRow): Trip {
  return tripSchema.parse({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    basics: {
      mode: row.mode,
      destinationInput: row.destination_input,
      regionId: row.region_id,
      startDate: row.start_date,
      endDate: row.end_date,
      arrivalTime: row.arrival_time,
      departureTime: row.departure_time,
      adults: row.adults,
      children: row.children,
      travelerNeeds: JSON.parse(row.traveler_needs),
    },
  });
}

export function createTrip(basics: TripBasics): Trip {
  const parsed = tripBasicsSchema.parse(basics);
  const now = new Date().toISOString();
  const id = randomUUID();

  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
         arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
       VALUES (@id, @mode, @destination_input, @region_id, @start_date, @end_date,
         @arrival_time, @departure_time, @adults, @children, @traveler_needs, @status, @created_at, @updated_at)`,
    )
    .run({
      id,
      mode: parsed.mode,
      destination_input: parsed.destinationInput,
      region_id: parsed.regionId,
      start_date: parsed.startDate,
      end_date: parsed.endDate,
      arrival_time: parsed.arrivalTime,
      departure_time: parsed.departureTime,
      adults: parsed.adults,
      children: parsed.children,
      traveler_needs: JSON.stringify(parsed.travelerNeeds),
      status: 'draft' satisfies TripStatus,
      created_at: now,
      updated_at: now,
    });

  return { id, basics: parsed, status: 'draft', createdAt: now, updatedAt: now };
}

export function getTrip(id: string): Trip | null {
  const row = getDb().prepare('SELECT * FROM trips WHERE id = ?').get(id) as TripRow | undefined;
  return row ? rowToTrip(row) : null;
}

export function listTrips(): Trip[] {
  const rows = getDb()
    .prepare('SELECT * FROM trips ORDER BY created_at DESC')
    .all() as TripRow[];
  return rows.map(rowToTrip);
}

function setTripStatus(tripId: string, status: TripStatus): void {
  getDb()
    .prepare('UPDATE trips SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), tripId);
}

/** Stores in-progress questionnaire answers so a refresh does not lose them. */
export function saveAnswers(tripId: string, answers: QuestionnaireAnswers): void {
  const parsed = questionnaireAnswersSchema.parse(answers);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO traveler_profiles (trip_id, profile_version, answers_json, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(trip_id) DO UPDATE SET answers_json = excluded.answers_json, updated_at = excluded.updated_at`,
    )
    .run(tripId, 1, JSON.stringify(parsed), now, now);
}

export function saveProfile(
  tripId: string,
  answers: QuestionnaireAnswers,
  profile: TravelerProfile,
): void {
  const parsedAnswers = questionnaireAnswersSchema.parse(answers);
  const parsedProfile = travelerProfileSchema.parse(profile);
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO traveler_profiles (trip_id, profile_version, answers_json, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(trip_id) DO UPDATE SET
         profile_version = excluded.profile_version,
         answers_json = excluded.answers_json,
         profile_json = excluded.profile_json,
         updated_at = excluded.updated_at`,
    )
    .run(tripId, parsedProfile.version, JSON.stringify(parsedAnswers), JSON.stringify(parsedProfile), now, now);

  setTripStatus(tripId, 'profiled');
}

export function getAnswers(tripId: string): QuestionnaireAnswers | null {
  const row = getDb()
    .prepare('SELECT * FROM traveler_profiles WHERE trip_id = ?')
    .get(tripId) as ProfileRow | undefined;
  if (!row) return null;
  return questionnaireAnswersSchema.parse(JSON.parse(row.answers_json));
}

/**
 * Reads the profile, upgrading it in place when an older build wrote it.
 *
 * The answers are the durable artefact; the profile is derived from them. So a
 * profile that no longer parses is rebuilt from its own answers rather than
 * hand-mapped field by field — no bespoke migration code to drift, and a trip
 * created before transport preferences existed keeps working with the defaults
 * those questions now carry.
 *
 * The upgrade is written back so the next read is a plain parse.
 */
export function getProfile(tripId: string): TravelerProfile | null {
  const row = getDb()
    .prepare('SELECT * FROM traveler_profiles WHERE trip_id = ?')
    .get(tripId) as ProfileRow | undefined;
  if (!row?.profile_json) return null;

  const current = travelerProfileSchema.safeParse(JSON.parse(row.profile_json));
  if (current.success) return current.data;

  const trip = getTrip(tripId);
  const answers = questionnaireAnswersSchema.safeParse(JSON.parse(row.answers_json));
  if (!trip || !answers.success) return null;

  const migrated = migrateTravelerProfile(answers.data, {
    travelerNeeds: trip.basics.travelerNeeds,
    tripDays: countTripDays(trip.basics.startDate, trip.basics.endDate),
  });
  if (!migrated) return null;

  // Written back so the next read is a plain parse — but *only* the profile.
  // Routing this through `saveProfile` would also set the trip to `profiled`,
  // so merely opening a planned trip would demote it.
  getDb()
    .prepare(
      `UPDATE traveler_profiles SET profile_version = ?, profile_json = ?, updated_at = ?
       WHERE trip_id = ?`,
    )
    .run(migrated.version, JSON.stringify(migrated), new Date().toISOString(), tripId);
  return migrated;
}

export function getSelections(tripId: string): DiscoverySelection[] {
  const rows = getDb()
    .prepare('SELECT place_id, status, source, updated_at FROM discovery_selections WHERE trip_id = ?')
    .all(tripId) as SelectionRow[];
  return rows.map((row) =>
    discoverySelectionSchema.parse({
      placeId: row.place_id,
      status: row.status,
      source: row.source,
      updatedAt: row.updated_at,
    }),
  );
}

export function setSelection(
  tripId: string,
  placeId: string,
  status: SelectionStatus,
  source: SelectionSource,
): void {
  discoverySelectionSchema.parse({
    placeId,
    status,
    source,
    updatedAt: new Date().toISOString(),
  });
  getDb()
    .prepare(
      `INSERT INTO discovery_selections (trip_id, place_id, status, source, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trip_id, place_id) DO UPDATE SET
         status = excluded.status, source = excluded.source, updated_at = excluded.updated_at`,
    )
    .run(tripId, placeId, status, source, new Date().toISOString());
  setTripStatus(tripId, 'discovering');
}

/**
 * Drops a stored plan.
 *
 * Called when the profile changes: an itinerary is a function of the answers it
 * was built from, so once those change the stored plan describes a trip nobody
 * asked for. Deleting it is honest — the traveller lands on the board, which
 * offers Build my trip — whereas leaving it would show a transport strategy
 * derived from answers they have just replaced.
 */
export function clearItinerary(tripId: string): void {
  const db = getDb();
  const apply = db.transaction(() => {
    db.prepare('DELETE FROM itinerary_items WHERE trip_id = ?').run(tripId);
    db.prepare('DELETE FROM itinerary_days WHERE trip_id = ?').run(tripId);
    db.prepare('DELETE FROM itineraries WHERE trip_id = ?').run(tripId);
  });
  apply();
}

export function clearSelection(tripId: string, placeId: string): void {
  getDb()
    .prepare('DELETE FROM discovery_selections WHERE trip_id = ? AND place_id = ?')
    .run(tripId, placeId);
}

/**
 * Replaces the whole auto-picked set in one transaction. User decisions are
 * preserved: auto-pick proposes a starting point, it does not overrule someone
 * who has already said no to something.
 */
export function replaceAutoSelections(tripId: string, placeIds: string[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const apply = db.transaction((ids: string[]) => {
    db.prepare("DELETE FROM discovery_selections WHERE trip_id = ? AND source = 'auto'").run(tripId);
    const insert = db.prepare(
      `INSERT INTO discovery_selections (trip_id, place_id, status, source, updated_at)
       VALUES (?, ?, 'included', 'auto', ?)
       ON CONFLICT(trip_id, place_id) DO NOTHING`,
    );
    for (const id of ids) insert.run(tripId, id, now);
  });
  apply(placeIds);
  setTripStatus(tripId, 'discovering');
}

// ---------------------------------------------------------------------------
// Itineraries
// ---------------------------------------------------------------------------

interface ItineraryRow {
  trip_id: string;
  version: number;
  region_id: string;
  base_id: string;
  base_name: string;
  start_date: string;
  end_date: string;
  status: string;
  summary: string;
  transport_strategy_json: string;
  issues_json: string;
  unscheduled_json: string;
  diagnostics_json: string;
}

interface ItineraryDayRow {
  day_number: number;
  date: string;
  base_id: string;
  base_name: string;
  theme: string;
  intensity: string;
  window_json: string;
  totals_json: string;
  transport_json: string;
  warnings_json: string;
}

/**
 * A stored plan written by an older build.
 *
 * Thrown rather than returned so the caller cannot mistake it for "no plan yet".
 * The two states need different screens: one offers a rebuild that keeps every
 * selection, the other says the trip has not been built at all.
 */
export class StaleItineraryError extends Error {
  readonly storedVersion: number;

  constructor(storedVersion: number) {
    super(`Stored itinerary is version ${storedVersion}; this build writes ${ITINERARY_VERSION}.`);
    this.name = 'StaleItineraryError';
    this.storedVersion = storedVersion;
  }
}

interface ItineraryItemRow {
  day_number: number;
  position: number;
  item_json: string;
}

/**
 * Replaces a trip's itinerary in one transaction.
 *
 * All-or-nothing on purpose: a half-written plan that the reader then rejects
 * would look to the user like "we generated your trip" followed by a broken
 * page. Either the whole itinerary lands or nothing changes.
 */
export function saveItinerary(itinerary: Itinerary): void {
  const parsed = itinerarySchema.parse(itinerary);
  const db = getDb();
  const now = new Date().toISOString();

  const apply = db.transaction((value: Itinerary) => {
    db.prepare('DELETE FROM itinerary_items WHERE trip_id = ?').run(value.tripId);
    db.prepare('DELETE FROM itinerary_days WHERE trip_id = ?').run(value.tripId);
    db.prepare('DELETE FROM itineraries WHERE trip_id = ?').run(value.tripId);

    db.prepare(
      `INSERT INTO itineraries (trip_id, version, region_id, base_id, base_name, start_date, end_date,
         status, summary, transport_strategy_json, issues_json, unscheduled_json, diagnostics_json,
         created_at, updated_at)
       VALUES (@trip_id, @version, @region_id, @base_id, @base_name, @start_date, @end_date,
         @status, @summary, @transport_strategy_json, @issues_json, @unscheduled_json,
         @diagnostics_json, @created_at, @updated_at)`,
    ).run({
      trip_id: value.tripId,
      version: value.version,
      region_id: value.regionId,
      base_id: value.baseId,
      base_name: value.baseName,
      start_date: value.startDate,
      end_date: value.endDate,
      status: value.status,
      summary: value.summary,
      transport_strategy_json: JSON.stringify(value.transportStrategy),
      issues_json: JSON.stringify(value.issues),
      unscheduled_json: JSON.stringify(value.unscheduled),
      diagnostics_json: JSON.stringify(value.diagnostics),
      created_at: now,
      updated_at: now,
    });

    const insertDay = db.prepare(
      `INSERT INTO itinerary_days (trip_id, day_number, date, base_id, base_name, theme, intensity,
         window_json, totals_json, transport_json, warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertItem = db.prepare(
      `INSERT INTO itinerary_items (trip_id, day_number, position, kind, place_id, start_minute, end_minute, item_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const day of value.days) {
      insertDay.run(
        value.tripId,
        day.dayNumber,
        day.date,
        day.baseId,
        day.baseName,
        day.theme,
        day.intensity,
        JSON.stringify(day.window),
        JSON.stringify(day.totals),
        JSON.stringify(day.transport),
        JSON.stringify(day.warnings),
      );
      day.items.forEach((item, position) => {
        insertItem.run(
          value.tripId,
          day.dayNumber,
          position,
          item.kind,
          item.placeId ?? null,
          item.startMinute,
          item.endMinute,
          JSON.stringify(item),
        );
      });
    }

    db.prepare('UPDATE trips SET status = ?, updated_at = ? WHERE id = ?').run(
      'planned' satisfies TripStatus,
      now,
      value.tripId,
    );
  });

  apply(parsed);
}

/**
 * Reassembles the itinerary and re-validates it. A row written by an older build,
 * or corrupted by hand, throws here rather than rendering a broken timeline.
 */
export function getItinerary(tripId: string): Itinerary | null {
  const db = getDb();
  const head = db.prepare('SELECT * FROM itineraries WHERE trip_id = ?').get(tripId) as
    | ItineraryRow
    | undefined;
  if (!head) return null;
  // An older plan cannot be coerced into the current shape without inventing the
  // transport it never recorded. Say so, and let the caller offer a rebuild.
  if (head.version !== ITINERARY_VERSION) throw new StaleItineraryError(head.version);

  const dayRows = db
    .prepare('SELECT * FROM itinerary_days WHERE trip_id = ? ORDER BY day_number')
    .all(tripId) as ItineraryDayRow[];
  const itemRows = db
    .prepare('SELECT * FROM itinerary_items WHERE trip_id = ? ORDER BY day_number, position')
    .all(tripId) as ItineraryItemRow[];

  const itemsByDay = new Map<number, unknown[]>();
  for (const row of itemRows) {
    const bucket = itemsByDay.get(row.day_number) ?? [];
    bucket.push(JSON.parse(row.item_json));
    itemsByDay.set(row.day_number, bucket);
  }

  return itinerarySchema.parse({
    version: head.version,
    tripId: head.trip_id,
    regionId: head.region_id,
    baseId: head.base_id,
    baseName: head.base_name,
    startDate: head.start_date,
    endDate: head.end_date,
    status: head.status,
    summary: head.summary,
    transportStrategy: JSON.parse(head.transport_strategy_json),
    issues: JSON.parse(head.issues_json),
    unscheduled: JSON.parse(head.unscheduled_json),
    diagnostics: JSON.parse(head.diagnostics_json),
    days: dayRows.map((row) => ({
      dayNumber: row.day_number,
      date: row.date,
      baseId: row.base_id,
      baseName: row.base_name,
      theme: row.theme,
      intensity: row.intensity,
      window: JSON.parse(row.window_json),
      totals: JSON.parse(row.totals_json),
      transport: JSON.parse(row.transport_json),
      warnings: JSON.parse(row.warnings_json),
      items: itemsByDay.get(row.day_number) ?? [],
    })),
  });
}

export function hasItinerary(tripId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS present FROM itineraries WHERE trip_id = ?')
    .get(tripId) as { present: number } | undefined;
  return Boolean(row);
}
