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
  food_plan_json           TEXT NOT NULL DEFAULT '{}',
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
  availability_json TEXT NOT NULL DEFAULT '{}',
  weather_json   TEXT NOT NULL DEFAULT '{}',
  food_json      TEXT NOT NULL DEFAULT '{}',
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

-- What the traveller said about where they would like to eat.
--
-- Its own table rather than a status on discovery_selections: a food venue is
-- not a place, must never be counted against the activity-frequency caps, and
-- has only two meaningful answers rather than three. The planner reads it as a
-- preference, never as a promise — a venue that will not fit the route comes
-- back as a visible conflict.
CREATE TABLE IF NOT EXISTS food_selections (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  venue_id   TEXT NOT NULL,
  status     TEXT NOT NULL,
  source     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, venue_id)
);

CREATE INDEX IF NOT EXISTS idx_food_selections_trip ON food_selections(trip_id);

-- Weather fetched from an external provider, remembered so that rendering a
-- page does not mean a forecast request. Not itinerary data: a plan carries its
-- own copy of the evidence it was built from, so this table can be emptied at
-- any moment without changing a single stored trip.
CREATE TABLE IF NOT EXISTS weather_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  stored_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weather_cache_stored ON weather_cache(stored_at);

CREATE INDEX IF NOT EXISTS idx_itinerary_days_trip ON itinerary_days(trip_id);
CREATE INDEX IF NOT EXISTS idx_itinerary_items_trip_day ON itinerary_items(trip_id, day_number);

-- What the traveller asked for, before a region exists.
--
-- One row per trip, carrying the free-form destination text, what our sources
-- made of it, the clarification answers, and the scope they confirmed. Written
-- at every step for the same reason answers_json is: a refresh — or a closed
-- laptop — must not throw away work, and this work is several screens long.
--
-- 'scope_json' is the contract the compiler is held to. 'scope_revision' is
-- bumped whenever the traveller edits anything on the confirmation screen, and
-- it travels into the fingerprint, so a compiled artifact can never be
-- attributed to a scope it was not built from.
CREATE TABLE IF NOT EXISTS trip_intents (
  trip_id                    TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  mode                       TEXT NOT NULL,
  destination_query          TEXT NOT NULL DEFAULT '',
  resolution_json            TEXT,
  selected_candidate_id      TEXT,
  clarifications_json        TEXT NOT NULL DEFAULT '{}',
  scope_json                 TEXT,
  scope_revision             INTEGER NOT NULL DEFAULT 0,
  selected_compiled_region_id TEXT,
  discovery_prefs_json       TEXT,
  shortlist_json             TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

-- A compilation, as a row rather than a promise in a request.
--
-- Building a region takes minutes and spends money. Everything else in this
-- product is an awaited server action, which a browser refresh simply loses;
-- that is fine for two seconds of planning and unacceptable here. So the job is
-- durable, its stages are written as they complete, and the browser reads it.
--
-- 'heartbeat_at' is what makes a killed process recoverable: a 'running' job
-- that has gone quiet can be reclaimed, where without it one crash would leave a
-- trip permanently unable to compile.
CREATE TABLE IF NOT EXISTS compilation_jobs (
  id                 TEXT PRIMARY KEY,
  trip_id            TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  scope_fingerprint  TEXT NOT NULL,
  state              TEXT NOT NULL,
  stage              TEXT NOT NULL,
  stages_json        TEXT NOT NULL DEFAULT '[]',
  started_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  finished_at        TEXT,
  heartbeat_at       TEXT NOT NULL,
  cancel_requested   INTEGER NOT NULL DEFAULT 0,
  error_code         TEXT,
  error_detail       TEXT,
  compiled_region_id TEXT,
  correlation_id     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compilation_jobs_trip ON compilation_jobs(trip_id);

-- Duplicate-click protection, enforced by the database rather than by a disabled
-- button. The button is client-side: two tabs, a refresh mid-run, or a direct
-- POST all go straight past it. At most one live job per trip, full stop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_compilation_jobs_active
  ON compilation_jobs(trip_id) WHERE state IN ('queued', 'running');

-- Compiled regions, immutable.
--
-- Never updated, only inserted. A recompile writes a new row with a new id, so
-- an itinerary built against one artifact keeps pointing at exactly the evidence
-- it was built from — and a traveller who deliberately refreshes can be shown
-- what changed rather than having the old answer overwritten underneath them.
CREATE TABLE IF NOT EXISTS compiled_regions (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  scope_fingerprint TEXT NOT NULL,
  schema_version    INTEGER NOT NULL,
  compiler_version  TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compiled_regions_lookup
  ON compiled_regions(trip_id, scope_fingerprint, created_at);

-- Provider responses, cached so that a retry or a second trip to the same city
-- does not mean paying twice.
--
-- Not itinerary data and never load-bearing: a compiled region carries its own
-- copy of everything it was built from, so this table can be emptied at any
-- moment without changing a single stored trip. 'expires_at' is per-entry
-- because the things cached here age at wildly different rates — a geocode is
-- stable for years, a route matrix for weeks, an opening time for days.
CREATE TABLE IF NOT EXISTS provider_cache (
  cache_key    TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  stored_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_cache_expiry ON provider_cache(expires_at);

-- Pages the research layer actually read.
--
-- Deliberately *not* a copy of the web. What is kept is the URL, the publisher,
-- when we read it, how many bytes came back, and a hash of the extracted text —
-- enough to notice a page has changed since a region was compiled, and not
-- enough to be a redistribution of somebody's copyrighted page. The excerpts
-- that justify individual facts live inside the compiled artifact, capped at 400
-- characters each by the schema.
--
-- Like provider_cache, this is an audit and freshness aid rather than plan data:
-- a compiled region carries its own copy of every fact it was built from, so
-- this table can be emptied at any moment without changing a stored trip.
CREATE TABLE IF NOT EXISTS source_documents (
  url            TEXT NOT NULL,
  compiled_region_id TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  publisher      TEXT NOT NULL,
  authority      TEXT NOT NULL,
  title          TEXT,
  content_hash   TEXT NOT NULL,
  content_bytes  INTEGER NOT NULL,
  robots_allowed INTEGER NOT NULL,
  retrieved_at   TEXT NOT NULL,
  published_at   TEXT,
  PRIMARY KEY (compiled_region_id, url, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_source_documents_region ON source_documents(compiled_region_id);
CREATE INDEX IF NOT EXISTS idx_source_documents_retrieved ON source_documents(retrieved_at);
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
  {
    table: 'itinerary_days',
    column: 'availability_json',
    definition: "TEXT NOT NULL DEFAULT '{}'",
  },
  { table: 'itinerary_days', column: 'weather_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'itineraries', column: 'food_plan_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
  { table: 'itinerary_days', column: 'food_json', definition: "TEXT NOT NULL DEFAULT '{}'" },
];
