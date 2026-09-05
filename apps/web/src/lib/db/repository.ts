import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  discoverySelectionSchema,
  foodSelectionSchema,
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
  type FoodSelection,
  type QuestionnaireAnswers,
  type SelectionSource,
  type SelectionStatus,
  type TravelerProfile,
  type Trip,
  type TripBasics,
  type TripStatus,
  plannerReadinessSchema,
  type PlannerReadiness,
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
  /** Null for a trip written before trips had an owner. See `listTrips`. */
  owner_token: string | null;
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

export function createTrip(basics: TripBasics, ownerToken?: string | null): Trip {
  const parsed = tripBasicsSchema.parse(basics);
  const now = new Date().toISOString();
  const id = randomUUID();

  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
         arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at,
         owner_token)
       VALUES (@id, @mode, @destination_input, @region_id, @start_date, @end_date,
         @arrival_time, @departure_time, @adults, @children, @traveler_needs, @status, @created_at, @updated_at,
         @owner_token)`,
    )
    .run({
      id,
      owner_token: ownerToken ?? null,
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

/**
 * Move a trip's dates, and nothing else.
 *
 * Narrow on purpose. This exists so a traveller can *adopt* a recommended date
 * window — the recommendation was read-only otherwise, which made it advice
 * rather than a feature. A general "update the trip" would let a caller change
 * the destination out from under a compiled region.
 *
 * Compiled artifacts are untouched, as always: a scope fingerprint carries the
 * dates, so changing them means the next build produces a *new* artifact rather
 * than reinterpreting an old one.
 */
/**
 * REWRITE A TRIP'S BASICS IN PLACE.
 *
 * Deliberately wider than `updateTripDates`, and deliberately narrower than an
 * arbitrary update: it takes a whole validated `TripBasics` and rewrites
 * exactly the columns `createTrip` writes, leaving id, status and `created_at`
 * alone. Anything less than the whole record would let the two paths drift, and
 * the point of it existing is that editing a trip and creating one produce the
 * same row.
 *
 * The status is untouched on purpose. A traveller correcting their party size
 * has not un-profiled themselves, and resetting the status would send them back
 * through a questionnaire they already completed.
 *
 * Compiled artifacts are untouched here too. Whether an edit invalidates a
 * build is a question about *which* answer changed, and it is answered by
 * `invalidateDependentStages` rather than by a blanket reset — see its note for
 * why over-invalidating is not the safe direction.
 */
export function updateTripBasics(id: string, basics: TripBasics): void {
  const parsed = tripBasicsSchema.parse(basics);
  getDb()
    .prepare(
      `UPDATE trips SET mode = @mode, destination_input = @destination_input, region_id = @region_id,
         start_date = @start_date, end_date = @end_date, arrival_time = @arrival_time,
         departure_time = @departure_time, adults = @adults, children = @children,
         traveler_needs = @traveler_needs, updated_at = @updated_at
       WHERE id = @id`,
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
      updated_at: new Date().toISOString(),
    });
}

export function updateTripDates(id: string, startDate: string, endDate: string): void {
  getDb()
    .prepare('UPDATE trips SET start_date = ?, end_date = ?, updated_at = ? WHERE id = ?')
    .run(startDate, endDate, new Date().toISOString(), id);
}

export function getTrip(id: string): Trip | null {
  const row = getDb().prepare('SELECT * FROM trips WHERE id = ?').get(id) as TripRow | undefined;
  return row ? rowToTrip(row) : null;
}

/**
 * THE TRIPS THIS BROWSER MADE, AND NOBODY ELSE'S.
 *
 * This used to be `SELECT * FROM trips` with no predicate, and the homepage
 * rendered the result under the heading "Your trips" with a Remove button on
 * every row. On the live database that was one visitor looking at a hundred and
 * eighty strangers' plans and holding a control that deletes them. §22 asks for
 * trip ownership and no cross-user leakage; there was neither, because there
 * was no owner.
 *
 * The owner is required rather than optional, and that is the point of the
 * signature: an optional argument is one a future caller forgets, and the
 * failure mode of forgetting is the defect coming back silently. A caller with
 * nobody to ask for must pass null and gets nothing, which is the honest answer
 * to "what are the trips belonging to no one".
 *
 * **A null owner token lists nothing.** Not everything: rows written before
 * this column existed cannot be attributed to a browser, so showing them to
 * whoever arrives next would be exactly the leak this closes. They answer to
 * nobody at the trip doors either — `lib/net/trip-access` refuses what cannot
 * be claimed — so an unowned row is reachable only through a share token its
 * owner minted while it still had one.
 */
export function listTrips(ownerToken: string | null): Trip[] {
  if (!ownerToken) return [];
  const rows = getDb()
    .prepare('SELECT * FROM trips WHERE owner_token = ? ORDER BY created_at DESC')
    .all(ownerToken) as TripRow[];
  return rows.map(rowToTrip);
}

/**
 * Who made this trip, or null when nobody can be said to have.
 *
 * Separate from `getTrip` because reading a row and *authorising* a caller are
 * different questions. The trip id is the owner's capability and must never be
 * treated as shareable: every `/trips/{id}` page and mutating action checks
 * this token against the session cookie (`lib/net/trip-access`), and
 * `/share/<token>` is the one surface that shows a plan to anybody else.
 */
export function tripOwnerToken(id: string): string | null {
  const row = getDb().prepare('SELECT owner_token FROM trips WHERE id = ?').get(id) as
    | { owner_token: string | null }
    | undefined;
  return row?.owner_token ?? null;
}

/**
 * THE SHARE TOKEN, MINTED ONCE AND KEPT.
 *
 * The token is the share link's entire security model — no accounts, so nothing
 * else stands between a stranger and this plan — which sets both properties
 * here. It is 128 bits of crypto randomness in a URL-safe alphabet, because a
 * guessable token is an open trip. And it is minted exactly once: the guarded
 * UPDATE writes only into NULL, so two tabs pressing Share race to a single
 * winner and a second press next week returns the link somebody already sent
 * rather than silently killing it.
 *
 * Null for a trip that does not exist. Never minted on read paths — only the
 * owner's explicit Share creates one, so an unshared trip stays unshared.
 */
export function ensureShareToken(tripId: string): string | null {
  const db = getDb();
  db.prepare('UPDATE trips SET share_token = ? WHERE id = ? AND share_token IS NULL').run(
    randomBytes(16).toString('base64url'),
    tripId,
  );
  const row = db.prepare('SELECT share_token FROM trips WHERE id = ?').get(tripId) as
    | { share_token: string | null }
    | undefined;
  return row?.share_token ?? null;
}

/**
 * The trip a share token opens, or null.
 *
 * Resolution answers to the token *alone*. There is deliberately no id
 * fallback, no prefix match and no normalisation: a lookup that also honoured
 * trip ids would turn every id into a working share link with no share ever
 * created, which is the enumeration door §22 exists to keep shut. The empty
 * string is refused before the database is asked, so no probe can meet the
 * NULL every unshared trip holds.
 */
export function tripForShareToken(token: string): Trip | null {
  if (!token) return null;
  const row = getDb().prepare('SELECT * FROM trips WHERE share_token = ?').get(token) as
    | TripRow
    | undefined;
  return row ? rowToTrip(row) : null;
}

/**
 * REMOVE A TRIP AND EVERYTHING HUNG OFF IT.
 *
 * One statement, because the schema does the rest: every table that references
 * `trips(id)` declares `ON DELETE CASCADE` and `foreign_keys` is `ON` for every
 * connection (see `db/client`), so removing the row removes the answers, the
 * intent, the jobs, the compiled regions, the board selections, the locks and
 * the itinerary with it. Spelling out the child deletes here would be a second,
 * hand-maintained copy of the cascade that would silently fall behind the next
 * migration.
 *
 * Deliberately unconditional and deliberately silent about whether a row was
 * there. "Make this not exist" is satisfied by a trip that never existed, and
 * the caller — which has to refuse the delete while a compilation is writing to
 * the trip — is where the judgement about *when* it is safe belongs.
 */
export function deleteTrip(tripId: string): void {
  getDb().prepare('DELETE FROM trips WHERE id = ?').run(tripId);
}

function setTripStatus(tripId: string, status: TripStatus): void {
  getDb()
    .prepare('UPDATE trips SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), tripId);
}

/**
 * Stores in-progress questionnaire answers so a refresh does not lose them.
 *
 * `step` is stored alongside because the answers alone were never enough. They
 * were saved as the traveller moved, the *position* was React state, and a
 * refresh on step seven of nine came back at step one — with every answer
 * intact and nothing to say which of them had been reached on purpose. The
 * screen said "Saved as you go" the whole time.
 *
 * Omitting `step` leaves the stored position untouched rather than resetting
 * it, so a save that is only about answers cannot silently send somebody back
 * to the beginning.
 */
export function saveAnswers(tripId: string, answers: QuestionnaireAnswers, step?: number): void {
  const parsed = questionnaireAnswersSchema.parse(answers);
  const now = new Date().toISOString();
  const safeStep = step === undefined ? null : Math.max(0, Math.floor(step));
  getDb()
    .prepare(
      /*
       * `COALESCE` ON THE WAY IN, NOT ON `excluded`.
       *
       * The obvious form — binding NULL and coalescing against
       * `excluded.draft_step` in the update — does not work, and fails loudly:
       * the column is `NOT NULL`, SQLite checks that *before* it detects the
       * uniqueness conflict, so the insert throws before the update clause is
       * ever reached. Every call that omitted a step would have crashed.
       *
       * So the insert coalesces to zero (a row nobody recorded a position for
       * starts at the first step) and the update coalesces against the *stored*
       * value, which is what "omitting `step` leaves the position untouched"
       * actually requires.
       */
      `INSERT INTO traveler_profiles (trip_id, profile_version, answers_json, profile_json, draft_step, created_at, updated_at)
       VALUES (?, ?, ?, NULL, COALESCE(?, 0), ?, ?)
       ON CONFLICT(trip_id) DO UPDATE SET
         answers_json = excluded.answers_json,
         draft_step = COALESCE(?, traveler_profiles.draft_step),
         updated_at = excluded.updated_at`,
    )
    .run(tripId, 1, JSON.stringify(parsed), safeStep, now, now, safeStep);
}

/**
 * The step the traveller had reached, or zero when nobody recorded one.
 *
 * Zero rather than null at the boundary: every caller wants a step index, and
 * "we do not know" and "the first step" are the same instruction to a wizard.
 */
export function getDraftStep(tripId: string): number {
  const row = getDb()
    .prepare('SELECT draft_step FROM traveler_profiles WHERE trip_id = ?')
    .get(tripId) as { draft_step?: number } | undefined;
  const step = row?.draft_step;
  return typeof step === 'number' && Number.isFinite(step) && step > 0 ? Math.floor(step) : 0;
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

/**
 * What the traveller said about where they would like to eat.
 *
 * Kept apart from `getSelections` for the reason the table is kept apart: a
 * venue is a preference about a meal, and letting it arrive in the same list as
 * the places would put it in front of the frequency caps and the day capacity,
 * neither of which it belongs to.
 */
export function getFoodSelections(tripId: string): FoodSelection[] {
  const rows = getDb()
    .prepare('SELECT venue_id, status, source, updated_at FROM food_selections WHERE trip_id = ?')
    .all(tripId) as FoodSelectionRow[];
  return rows.map((row) =>
    foodSelectionSchema.parse({
      venueId: row.venue_id,
      status: row.status,
      source: row.source,
      updatedAt: row.updated_at,
    }),
  );
}

export function setFoodSelection(
  tripId: string,
  venueId: string,
  status: FoodSelection['status'],
  source: SelectionSource,
): void {
  const now = new Date().toISOString();
  foodSelectionSchema.parse({ venueId, status, source, updatedAt: now });
  getDb()
    .prepare(
      `INSERT INTO food_selections (trip_id, venue_id, status, source, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(trip_id, venue_id) DO UPDATE SET
         status = excluded.status, source = excluded.source, updated_at = excluded.updated_at`,
    )
    .run(tripId, venueId, status, source, now);
}

export function clearFoodSelection(tripId: string, venueId: string): void {
  getDb()
    .prepare('DELETE FROM food_selections WHERE trip_id = ? AND venue_id = ?')
    .run(tripId, venueId);
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

interface FoodSelectionRow {
  venue_id: string;
  status: string;
  source: string;
  updated_at: string;
}

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
  food_plan_json: string;
  issues_json: string;
  unscheduled_json: string;
  diagnostics_json: string;
  package_json: string | null;
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
  availability_json: string;
  weather_json: string;
  food_json: string;
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
         status, summary, transport_strategy_json, food_plan_json, issues_json, unscheduled_json,
         diagnostics_json, package_json, created_at, updated_at)
       VALUES (@trip_id, @version, @region_id, @base_id, @base_name, @start_date, @end_date,
         @status, @summary, @transport_strategy_json, @food_plan_json, @issues_json,
         @unscheduled_json, @diagnostics_json, @package_json, @created_at, @updated_at)`,
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
      food_plan_json: JSON.stringify(value.foodPlan),
      issues_json: JSON.stringify(value.issues),
      unscheduled_json: JSON.stringify(value.unscheduled),
      diagnostics_json: JSON.stringify(value.diagnostics),
      package_json: value.package ? JSON.stringify(value.package) : null,
      created_at: now,
      updated_at: now,
    });

    const insertDay = db.prepare(
      `INSERT INTO itinerary_days (trip_id, day_number, date, base_id, base_name, theme, intensity,
         window_json, totals_json, transport_json, availability_json, weather_json, food_json,
         warnings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(day.availability),
        JSON.stringify(day.weather),
        JSON.stringify(day.food),
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
    foodPlan: JSON.parse(head.food_plan_json),
    issues: JSON.parse(head.issues_json),
    unscheduled: JSON.parse(head.unscheduled_json),
    diagnostics: JSON.parse(head.diagnostics_json),
    ...(head.package_json ? { package: JSON.parse(head.package_json) } : {}),
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
      availability: JSON.parse(row.availability_json),
      weather: JSON.parse(row.weather_json),
      food: JSON.parse(row.food_json),
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

/**
 * A stale plan, read for display only.
 *
 * The version gate in `getItinerary` protects *claims*: a stored plan is
 * rendered without re-validation, so a shape this build no longer stands
 * behind must not be presented with a fresh plan's confidence. What the gate
 * must not do — and did, for every stored itinerary across a version bump — is
 * turn the whole artifact into a wall. The traveller's plan still exists, its
 * days and times are still what they agreed to, and "you may not look at your
 * own trip" is a worse outcome than "here it is, read-only, built by an
 * earlier version, rebuild to refresh".
 *
 * So this reader is deliberately lenient and deliberately shallow. It never
 * throws for a malformed field: every value is checked before it is kept, an
 * item that will not parse is dropped rather than poisoning the day, and only
 * plain display primitives come back — nothing here can be mistaken for a
 * current, validated `Itinerary`, and nothing downstream can write it back.
 * Writes stay gated exactly as before: `saveItinerary` parses against the
 * current schema and always writes the current version.
 */
export interface StaleItineraryDisplay {
  storedVersion: number;
  /** When the plan was written, for the dated banner. Null if unrecorded. */
  savedAt: string | null;
  baseName: string;
  startDate: string;
  endDate: string;
  summary: string;
  days: StaleItineraryDisplayDay[];
}

export interface StaleItineraryDisplayDay {
  dayNumber: number;
  date: string;
  theme: string | null;
  items: {
    kind: string;
    title: string;
    startMinute: number | null;
    endMinute: number | null;
    note: string | null;
  }[];
}

export function getStaleItineraryDisplay(tripId: string): StaleItineraryDisplay | null {
  const db = getDb();
  const head = db.prepare('SELECT * FROM itineraries WHERE trip_id = ?').get(tripId) as
    | (ItineraryRow & { created_at?: string })
    | undefined;
  if (!head) return null;

  const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const asMinute = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

  const dayRows = db
    .prepare('SELECT * FROM itinerary_days WHERE trip_id = ? ORDER BY day_number')
    .all(tripId) as ItineraryDayRow[];
  const itemRows = db
    .prepare('SELECT * FROM itinerary_items WHERE trip_id = ? ORDER BY day_number, position')
    .all(tripId) as ItineraryItemRow[];

  const itemsByDay = new Map<number, StaleItineraryDisplayDay['items']>();
  for (const row of itemRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.item_json);
    } catch {
      continue; // One corrupt item must not take the day with it.
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const item = parsed as Record<string, unknown>;
    const title = asString(item.title);
    const kind = asString(item.kind);
    if (!title || !kind) continue;
    const bucket = itemsByDay.get(row.day_number) ?? [];
    bucket.push({
      kind,
      title,
      startMinute: asMinute(item.startMinute),
      endMinute: asMinute(item.endMinute),
      /*
       * The one line of prose worth keeping per row. Older versions called it
       * `reason`; keep whatever string is there, or nothing.
       */
      note: asString(item.reason),
    });
    itemsByDay.set(row.day_number, bucket);
  }

  return {
    storedVersion: head.version,
    savedAt: asString(head.created_at) ?? null,
    baseName: asString(head.base_name) ?? 'your base',
    startDate: asString(head.start_date) ?? '',
    endDate: asString(head.end_date) ?? '',
    summary: asString(head.summary) ?? '',
    days: dayRows.map((row) => ({
      dayNumber: row.day_number,
      date: asString(row.date) ?? '',
      theme: asString(row.theme),
      items: itemsByDay.get(row.day_number) ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Itinerary locks
// ---------------------------------------------------------------------------

/**
 * A stop the traveller pinned to a day, surviving rebuilds.
 *
 * Trip-scoped state, like the selections beside it: a lock is this traveller's
 * decision about this trip, never a fact about a place. The table is created
 * lazily here rather than in the client's schema because the itinerary slice
 * owns it end to end — everything that reads or writes a lock is in this
 * section — and it must be safe to add against an existing database without a
 * migration step.
 */
export interface StoredItineraryLock {
  placeId: string;
  dayNumber: number;
}

function ensureLockTable(): void {
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS itinerary_locks (
       trip_id TEXT NOT NULL,
       place_id TEXT NOT NULL,
       day_number INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (trip_id, place_id)
     )`,
  );
}

export function getItineraryLocks(tripId: string): StoredItineraryLock[] {
  ensureLockTable();
  const rows = getDb()
    .prepare('SELECT place_id, day_number FROM itinerary_locks WHERE trip_id = ? ORDER BY place_id')
    .all(tripId) as { place_id: string; day_number: number }[];
  return rows.map((row) => ({ placeId: row.place_id, dayNumber: row.day_number }));
}

export function setItineraryLock(tripId: string, placeId: string, dayNumber: number): void {
  ensureLockTable();
  getDb()
    .prepare(
      `INSERT INTO itinerary_locks (trip_id, place_id, day_number, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(trip_id, place_id) DO UPDATE SET
         day_number = excluded.day_number,
         created_at = excluded.created_at`,
    )
    .run(tripId, placeId, dayNumber, new Date().toISOString());
}

export function clearItineraryLock(tripId: string, placeId: string): void {
  ensureLockTable();
  getDb()
    .prepare('DELETE FROM itinerary_locks WHERE trip_id = ? AND place_id = ?')
    .run(tripId, placeId);
}

// ---------------------------------------------------------------------------
// Planner readiness
// ---------------------------------------------------------------------------

/**
 * Why the last build produced what it did, kept so the answer survives a
 * refresh.
 *
 * Trip-scoped by nature: readiness is a statement about *this* traveller's
 * selections on *these* dates, which is exactly the kind of thing the shared
 * evidence store must never hold. One row per trip, replaced on each attempt —
 * the current answer is the only one worth keeping, and a history of refusals is
 * not something anybody would read.
 */
export function saveReadiness(tripId: string, readiness: PlannerReadiness, now: Date): void {
  const parsed = plannerReadinessSchema.parse(readiness);
  try {
    getDb()
      .prepare(
        `INSERT INTO planner_readiness (trip_id, level, payload_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(trip_id) DO UPDATE SET
           level = excluded.level,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at`,
      )
      .run(tripId, parsed.level, JSON.stringify(parsed), now.toISOString());
  } catch (error) {
    console.error('Could not store planner readiness', error);
  }
}

export function getReadiness(tripId: string): PlannerReadiness | null {
  try {
    const row = getDb()
      .prepare('SELECT payload_json FROM planner_readiness WHERE trip_id = ?')
      .get(tripId) as { payload_json: string } | undefined;
    if (!row) return null;
    return plannerReadinessSchema.parse(JSON.parse(row.payload_json));
  } catch {
    /**
     * A readiness row that will not parse — a schema version that has moved on,
     * most likely — is treated as absent. The next build writes a current one,
     * and in the meantime the board simply does not show a stale explanation.
     */
    return null;
  }
}
