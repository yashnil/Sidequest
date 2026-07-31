/**
 * Sidequest local schema.
 *
 * SQLite is the development driver; the table and column shapes deliberately
 * mirror the Postgres tables this moves to when a Supabase project exists, so
 * the migration is a driver swap rather than a redesign. JSON columns hold
 * structures that are validated by Zod on the way in and on the way out.
 *
 * Kept as a TypeScript module rather than a .sql file so it survives Next's
 * server bundling without a copy step.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trips (
  id                TEXT PRIMARY KEY,
  mode              TEXT NOT NULL,
  destination_input TEXT NOT NULL,
  region_id         TEXT NOT NULL,
  start_date        TEXT NOT NULL,
  end_date          TEXT NOT NULL,
  arrival_time      TEXT NOT NULL,
  departure_time    TEXT NOT NULL,
  adults            INTEGER NOT NULL,
  children          INTEGER NOT NULL,
  traveler_needs    TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One profile per trip. answers_json is the raw questionnaire state, kept so a
-- refresh mid-questionnaire does not lose work and so the traveller can revise
-- their answers later. profile_json is the canonical derived profile and is only
-- written once the questionnaire validates.
CREATE TABLE IF NOT EXISTS traveler_profiles (
  trip_id         TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  profile_version INTEGER NOT NULL,
  answers_json    TEXT NOT NULL,
  profile_json    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_selections (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id   TEXT NOT NULL,
  status     TEXT NOT NULL,
  source     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_discovery_selections_trip ON discovery_selections(trip_id);

-- Generated itineraries, normalised across three tables to match the shape the
-- master data model describes (itineraries / itinerary_days / itinerary_items)
-- rather than dropping one opaque blob per trip.
--
-- Sub-structures that are genuinely polymorphic — a day's window and totals, an
-- item's travel segment — stay as validated JSON, because exploding them into
-- columns would mean a wide table of mostly-null fields. Everything worth
-- querying (day number, date, item kind, place, start and end minute) is a real
-- column. Every read is parsed back through Zod before it reaches the app.
--
-- One itinerary per trip: rebuilding replaces it wholesale, inside a transaction.
CREATE TABLE IF NOT EXISTS itineraries (
  trip_id                  TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  version                  INTEGER NOT NULL,
  region_id                TEXT NOT NULL,
  base_id                  TEXT NOT NULL,
  base_name                TEXT NOT NULL,
  start_date               TEXT NOT NULL,
  end_date                 TEXT NOT NULL,
  status                   TEXT NOT NULL,
  summary                  TEXT NOT NULL,
  transport_strategy_json  TEXT NOT NULL DEFAULT '{}',
  issues_json              TEXT NOT NULL DEFAULT '[]',
  unscheduled_json         TEXT NOT NULL DEFAULT '[]',
  diagnostics_json         TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS itinerary_days (
  trip_id        TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_number     INTEGER NOT NULL,
  date           TEXT NOT NULL,
  base_id        TEXT NOT NULL,
  base_name      TEXT NOT NULL,
  theme          TEXT NOT NULL,
  intensity      TEXT NOT NULL,
  window_json    TEXT NOT NULL,
  totals_json    TEXT NOT NULL,
  transport_json TEXT NOT NULL DEFAULT '{}',
  warnings_json  TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (trip_id, day_number)
);

CREATE TABLE IF NOT EXISTS itinerary_items (
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_number   INTEGER NOT NULL,
  position     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  place_id     TEXT,
  start_minute INTEGER NOT NULL,
  end_minute   INTEGER NOT NULL,
  item_json    TEXT NOT NULL,
  PRIMARY KEY (trip_id, day_number, position)
);

CREATE INDEX IF NOT EXISTS idx_itinerary_days_trip ON itinerary_days(trip_id);
CREATE INDEX IF NOT EXISTS idx_itinerary_items_trip_day ON itinerary_items(trip_id, day_number);
`;

/**
 * Additive column migrations.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a
 * database created by an earlier build would silently lack every column added
 * since — and the first write would fail with a message about SQL syntax rather
 * than about what actually happened. Each entry is checked against
 * `PRAGMA table_info` and applied only when missing, so running this repeatedly
 * is safe and a fresh database skips it entirely.
 *
 * Every added column carries a NOT NULL default, because a row written before
 * the column existed still has to parse afterwards.
 */
export const COLUMN_MIGRATIONS: readonly {
  table: string;
  column: string;
  definition: string;
}[] = [
  {
    table: 'itineraries',
    column: 'transport_strategy_json',
    definition: "TEXT NOT NULL DEFAULT '{}'",
  },
  { table: 'itinerary_days', column: 'transport_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
];
