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
  -- Everything the composer captured before a penny was spent. Written on every
  -- keystroke-settled answer, so back-navigation and refresh cost nothing.
  composer_json              TEXT,
  -- The identity the traveller picked out of the destination index, if they did.
  -- Its presence is what lets the flow skip resolution and interpretation
  -- entirely: there is nothing to interpret about a row somebody pointed at.
  selected_destination_json  TEXT,
  -- The cheap preflight: region portfolio, date guidance, duration guidance and
  -- the supply verdict. Persisted so a refusal survives the refresh that used to
  -- throw it away, exactly as planner readiness now does.
  preflight_json             TEXT,
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

-- Region packs: bounded, release-versioned source data for one piece of ground.
--
-- Immutable, like compiled_regions, and for a stronger reason: a compiled region
-- names the pack it was built from, so mutating a pack would silently change
-- what an existing plan claims to rest on. A rebuild inserts a new row.
--
-- Deliberately *not* keyed to a trip. A pack is traveller-independent geography,
-- so two people going to the same city share one — which is most of why a second
-- compilation of the same ground is cheap. It follows that deleting a trip must
-- not delete its pack, hence no foreign key, and hence the retention sweep in
-- the repository rather than a cascade.
--
-- 'state' is written last: a build that dies mid-way leaves a non-ready row that
-- the lookup ignores and the sweep removes.
CREATE TABLE IF NOT EXISTS region_packs (
  id             TEXT PRIMARY KEY,
  scope_hash     TEXT NOT NULL,
  catalog        TEXT NOT NULL,
  release_id     TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  state          TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  record_count   INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT
);

-- The lookup: this ground, this release, newest usable first.
CREATE INDEX IF NOT EXISTS idx_region_packs_lookup
  ON region_packs(scope_hash, catalog, release_id, created_at);

-- The stale-fallback lookup: this ground, any release.
CREATE INDEX IF NOT EXISTS idx_region_packs_scope ON region_packs(scope_hash, created_at);

-- At most one usable pack per (ground, release). A second build for the same
-- inputs is waste, not a variant, and two rows would make "which pack was this
-- plan built from" ambiguous. Enforced by the database because two tabs and two
-- web instances both go straight past any check in application code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_region_packs_unique_ready
  ON region_packs(scope_hash, catalog, release_id)
  WHERE state IN ('ready', 'partial');

-- ===========================================================================
-- THE SHARED EVIDENCE STORE
-- ===========================================================================
--
-- Six tables rather than one, and the split is the whole design. A single
-- opaque cache row cannot express "the page is unchanged but the extraction
-- schema moved on", which is exactly the invalidation that has to be surgical:
-- changing a prompt must not throw away a fetch, and changing a fetch must not
-- throw away a search.
--
-- Everything here is **traveller-independent**. There is no trip_id anywhere in
-- this section and there must never be one: a fact about a museum is a fact
-- about a museum, and a fact about a trip belongs on the trip's own tables. An
-- architecture test fails the build if a traveller field reaches a cache key.
--
-- None of it is load-bearing for a stored plan. A compiled region carries its
-- own copy of every fact it was built from, so every table below can be emptied
-- and no persisted trip changes.

-- Who published a page, as an identity rather than as a URL string.
--
-- Keyed on the canonical URL, so two orderings of one query, a tracking
-- parameter and a "www." prefix all land on one row. Deliberately *not* keyed on
-- content: two mirrors of the same bytes are two publishers, and collapsing them
-- would let a syndicated copy corroborate itself.
CREATE TABLE IF NOT EXISTS evidence_sources (
  id             TEXT PRIMARY KEY,
  canonical_url  TEXT NOT NULL,
  host           TEXT NOT NULL,
  origin         TEXT NOT NULL,
  publisher      TEXT NOT NULL,
  authority      TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_sources_url ON evidence_sources(canonical_url);
CREATE INDEX IF NOT EXISTS idx_evidence_sources_host ON evidence_sources(host);

-- One version of one document, addressed by the hash of what we retained.
--
-- Immutable: changed content is a new row, never an update, so an artifact
-- compiled last month can still be explained by the bytes it was actually built
-- from. "content_observed_at" and "last_checked_at" are two different clocks and
-- keeping them apart is the point of the whole phase — a 304 moves the second
-- and never the first, so revalidating a page every morning cannot make a
-- year-old closure notice current.
CREATE TABLE IF NOT EXISTS evidence_documents (
  id                 TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL,
  content_digest     TEXT NOT NULL,
  status             INTEGER NOT NULL,
  content_bytes      INTEGER NOT NULL,
  truncated          INTEGER NOT NULL DEFAULT 0,
  etag               TEXT,
  last_modified      TEXT,
  vary               TEXT,
  cache_control      TEXT,
  content_observed_at TEXT NOT NULL,
  last_checked_at    TEXT NOT NULL,
  published_at       TEXT,
  retrieval_version  TEXT NOT NULL,
  payload_json       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_documents_identity
  ON evidence_documents(source_id, content_digest);
CREATE INDEX IF NOT EXISTS idx_evidence_documents_source
  ON evidence_documents(source_id, content_observed_at);

-- Every attempt to read a source, including the ones that returned nothing.
--
-- A 304 is an observation against an existing version rather than a new version,
-- which is what makes "bytes avoided" a measured number instead of an estimate.
CREATE TABLE IF NOT EXISTS evidence_retrievals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           TEXT NOT NULL,
  document_version_id TEXT,
  kind                TEXT NOT NULL,
  status              INTEGER NOT NULL,
  observed_at         TEXT NOT NULL,
  bytes               INTEGER NOT NULL DEFAULT 0,
  bytes_avoided       INTEGER NOT NULL DEFAULT 0,
  detail              TEXT
);

CREATE INDEX IF NOT EXISTS idx_evidence_retrievals_source
  ON evidence_retrievals(source_id, observed_at);

-- What the deterministic parsers got out of a document version.
--
-- Its own table rather than a column on the document, because a parser version
-- bump must invalidate parses without invalidating the fetch behind them. Free
-- to recompute, so it is a convenience rather than a necessity — but a free
-- answer that avoids a paid one is worth a row.
CREATE TABLE IF NOT EXISTS evidence_parses (
  document_version_id TEXT NOT NULL,
  parser_version      TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  parsed_at           TEXT NOT NULL,
  PRIMARY KEY (document_version_id, parser_version)
);

-- One model extraction, keyed on everything that could change its answer.
--
-- Failures are stored too, and that is deliberate: an extraction that came back
-- malformed is worth remembering so a retry storm is visible and bounded. It is
-- never served as an answer, and a later success supersedes it — failing closed
-- must not mean failing forever.
CREATE TABLE IF NOT EXISTS evidence_extractions (
  key            TEXT PRIMARY KEY,
  operation      TEXT NOT NULL,
  status         TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_extractions_created
  ON evidence_extractions(created_at);

-- Claims: one source saying one thing about one subject, kept.
--
-- Subject identity is geographic and name-based rather than a trip-local place
-- id, which is what lets a second trip to the same museum read the first trip's
-- research. Superseding is by reference so history stays reconstructible.
CREATE TABLE IF NOT EXISTS evidence_claims (
  id                  TEXT PRIMARY KEY,
  subject_key         TEXT NOT NULL,
  fact_path           TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  document_version_id TEXT NOT NULL,
  content_digest      TEXT NOT NULL,
  extraction_key      TEXT,
  origin              TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  supersedes_claim_id TEXT,
  -- Marked, never deleted: an artifact compiled last month quotes a fact id, and
  -- that fact has to stay explicable after a newer observation replaces it.
  superseded          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_evidence_claims_subject
  ON evidence_claims(subject_key, fact_path, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_evidence_claims_document
  ON evidence_claims(document_version_id);

-- Which durable claims a stored artifact actually quotes.
--
-- An index rather than a scan. A compiled region already carries its own copy of
-- every fact it was built from, so deleting a claim cannot break a plan — what it
-- breaks is the ability to trace a fact on somebody's itinerary *back* to the
-- claim, the document and the page behind it. This table is what makes the
-- retention rule exact instead of a guess about age.
--
-- Swept rather than cascaded, for the same reason "source_documents" is: adding
-- a foreign key would let an audit trail block a delete.
CREATE TABLE IF NOT EXISTS compiled_region_claims (
  compiled_region_id TEXT NOT NULL,
  claim_id           TEXT NOT NULL,
  PRIMARY KEY (compiled_region_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_compiled_region_claims_claim
  ON compiled_region_claims(claim_id);

-- That we asked, and what asking yielded.
--
-- The row without which shared claims save nothing. "Every question answered" is
-- almost never true — most museums never publish a typical visit length — so
-- coverage measured that way would re-buy the same fruitless search on every
-- compilation forever. What is true, and useful, is that we looked at this
-- subject, for these questions, under this contract, on this date.
--
-- A record of an action, never of a fact. Nothing downstream reads it as
-- evidence, and it cannot make anything more certain.
CREATE TABLE IF NOT EXISTS evidence_research_attempts (
  key           TEXT PRIMARY KEY,
  subject_key   TEXT NOT NULL,
  contract      TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  attempted_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_attempts_subject
  ON evidence_research_attempts(subject_key);

-- Answers resolved once, for the questions whose answer is the same for
-- everybody.
--
-- Keyed on the exact set of claims behind the answer rather than on a
-- timestamp, so a new claim about the same question mints a new key
-- automatically and a stale answer can never be served for a set that has since
-- grown.
--
-- Only context-independent paths reach this table. Whether a place is open on
-- the fourteenth is not one of them and never will be: a shared cache that
-- answered a dated question would be the most dangerous thing this store could
-- hold, so the allow-list lives in code and is a closed one.
CREATE TABLE IF NOT EXISTS evidence_fact_sets (
  key          TEXT PRIMARY KEY,
  subject_key  TEXT NOT NULL,
  fact_path    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_fact_sets_subject
  ON evidence_fact_sets(subject_key, fact_path);

-- Where to look, cached by subject rather than by destination.
--
-- A museum and the ticket office on its domain are different subjects and get
-- different searches; two trips to one museum share one. A negative result is
-- stored with a reason, because "nobody publishes this" deserves a long memory
-- and "the provider was down" deserves a short one.
CREATE TABLE IF NOT EXISTS evidence_discovery (
  key          TEXT PRIMARY KEY,
  outcome      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_discovery_expiry ON evidence_discovery(expires_at);

-- Work somebody else is already doing.
--
-- Two compilations of the same city start within seconds of each other and would
-- otherwise fetch the same page twice and pay for the same extraction twice. The
-- unique partial index is the coalescing mechanism — the same idiom
-- "compilation_jobs" and "region_packs" already use, so there is one concurrency
-- story in this codebase rather than three.
--
-- A heartbeat rather than a lease timestamp, for the same reason as
-- "compilation_jobs": a process killed mid-fetch must not wedge a URL forever.
CREATE TABLE IF NOT EXISTS evidence_operations (
  operation_key TEXT NOT NULL,
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  owner         TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  finished_at   TEXT,
  result_ref    TEXT,
  detail        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_operations_active
  ON evidence_operations(operation_key) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS idx_evidence_operations_key
  ON evidence_operations(operation_key, started_at);

-- What a compilation decided to reuse, before it ran.
--
-- Persisted so "why was this run cheap" has a record rather than a
-- reconstruction, and so the technical panel can show it without recomputing
-- anything at render time.
CREATE TABLE IF NOT EXISTS compilation_work_plans (
  job_id       TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compilation_work_plans_trip ON compilation_work_plans(trip_id);

-- Why a plan could not be built, kept so the answer survives a refresh.
--
-- One row per trip, replaced on each attempt. Trip-scoped by nature: readiness is
-- a statement about *this* traveller's selections on *these* dates, which is
-- exactly the kind of thing the evidence store above must never hold.
CREATE TABLE IF NOT EXISTS planner_readiness (
  trip_id      TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  level        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- ===========================================================================
-- THE DESTINATION SEARCH INDEX
-- ===========================================================================
--
-- Built from a place catalogue's own division records under a pinned release,
-- and queried locally so that typing a destination costs nobody a request. The
-- public geocoder's usage policy names autocomplete as unacceptable use, and
-- "we ask you to press a button because somebody else asked us to" was the
-- product's answer for a whole phase. This table is the answer instead.
--
-- Traveller-independent, like the evidence store and for the same reasons: the
-- ranking is a pure function of the query and the row, so it can be shared, and
-- nothing anybody types is stored here.
--
-- Not load-bearing. Emptying it costs suggestions, not trips: a trip persists
-- the identity it selected, and the resolver remains the path for anything the
-- index does not hold.
CREATE TABLE IF NOT EXISTS destination_index (
  id           TEXT PRIMARY KEY,
  catalog      TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  feature_type TEXT NOT NULL,
  country_code TEXT,
  rank         REAL NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_destination_index_country
  ON destination_index(country_code, feature_type);

-- The prefix index. One row per (folded term, entry), where a term is a whole
-- folded name or one of its words — so "Issyk" finds "Issyk-Kul Region", which a
-- whole-string index cannot do.
--
-- 'rank' is denormalised onto this row on purpose. A two-character prefix can
-- match tens of thousands of entries, and ordering those by a column on another
-- table means SQLite materialises and sorts all of them before the limit
-- applies. With the composite index below, the query is a bounded range scan
-- that stops as soon as it has enough.
CREATE TABLE IF NOT EXISTS destination_index_terms (
  term     TEXT NOT NULL,
  rank     REAL NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (term, rank, entry_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_destination_terms_prefix
  ON destination_index_terms(term, rank DESC);

-- Which release the index was built from. One row, replaced wholesale.
CREATE TABLE IF NOT EXISTS destination_index_release (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL
);

-- ===========================================================================
-- DECIDING WHERE TO GO
-- ===========================================================================
--
-- A traveller who has dates and preferences and no destination has nothing to
-- attach their answers to: the trips table requires a destination_input, and inventing
-- a placeholder one would put a fake destination on the dashboard and in every
-- listing until they picked a real one.
--
-- So a decision is its own row, before a trip exists. It holds the same
-- TripComposerAnswers the known-destination path uses — one preference
-- vocabulary, not two — and the shortlist those answers produced. Choosing a
-- destination creates a normal trip from these answers and marks the session
-- resolved; nothing about the trip that results is different from one typed in
-- directly, which is the point.
--
-- Traveller-scoped by nature, and deliberately not in the evidence store: what
-- somebody is deciding between is the most traveller-specific thing this
-- product holds.
CREATE TABLE IF NOT EXISTS decision_sessions (
  id             TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  answers_json   TEXT NOT NULL,
  -- Null until a shortlist has been built. Its own column rather than a flag on
  -- the answers, because "they have answered" and "we have ranked" are separate
  -- states and the screen renders differently for each.
  shortlist_json TEXT,
  -- The trip this became, once they chose. Set once, never cleared: it is what
  -- makes "why was I shown this" answerable after the fact.
  resolved_trip_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_sessions_updated ON decision_sessions(updated_at);

-- ===========================================================================
-- THE PROVISIONAL BOARD
-- ===========================================================================
--
-- A board projected at the one boundary where the pipeline holds real candidates
-- and has not yet bought anything: after food discovery, before the research
-- funnel. It exists so a traveller sees something real in seconds rather than
-- after every model call has been made.
--
-- Its own table, and never compiled_regions. A provisional board has no measured
-- travel time, no verified claim, no access dataset and no hours dataset — so it
-- cannot satisfy PlannerInput, and putting it anywhere the region resolver looks
-- would be inviting exactly the confusion the separate type exists to prevent.
--
-- Immutable, like compiled_regions and for the same reason: a board already
-- shown to somebody must stay readable after a rebuild replaces it, or "why did
-- that place disappear" has no answer. A rebuild inserts a new row with a higher
-- version and names the one it supersedes.
CREATE TABLE IF NOT EXISTS provisional_boards (
  id                 TEXT PRIMARY KEY,
  trip_id            TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  job_id             TEXT NOT NULL,
  scope_fingerprint  TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  version            INTEGER NOT NULL,
  supersedes_board_id TEXT,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provisional_boards_trip
  ON provisional_boards(trip_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provisional_boards_job
  ON provisional_boards(job_id);

-- What the traveller said about a provisional card.
--
-- Deliberately not discovery_selections. That table's status enum is read by the
-- planner, its three values answer a different question ("do you want this?"
-- versus "is this worth us finding out about?"), and a provisional pick is not a
-- selection — it is a research priority signal that still has to survive
-- evidence, access and routing.
--
-- Keyed on the trip rather than the board, so revising the board does not lose
-- what somebody already said about a place that is still on it.
-- The columns added later — board_id, board_version, action_version,
-- reconciliation_state, reconciled_region_id, reconciled_at — are in
-- COLUMN_MIGRATIONS rather than here, because a database written before them
-- exists and CREATE TABLE IF NOT EXISTS would leave it short.
CREATE TABLE IF NOT EXISTS provisional_selections (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id   TEXT NOT NULL,
  intent     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_provisional_selections_trip
  ON provisional_selections(trip_id);

-- EVERY MARK ANYBODY EVER MADE, IN THE ORDER THEY MADE IT.
--
-- "provisional_selections" holds the *current* answer to "what do you think of
-- this place". That is what a board renders, and it is not enough to answer the
-- question a reconciliation panel actually gets asked a week later: I changed my
-- mind twice and then the board was rebuilt — which of those did you act on?
--
-- So the current answer stays where it is and every transition is appended here,
-- with the identity of the board it was made against. Append-only: a row is
-- never rewritten except to record that it was reconciled, which is why
-- reconciliation is idempotent rather than merely re-runnable.
--
-- The unique key is (trip, place, action_version). A retry that replays the same
-- action version is a no-op at the database rather than a second row, which is
-- what makes duplicate delivery safe without a distributed lock.
CREATE TABLE IF NOT EXISTS provisional_actions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id              TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id             TEXT NOT NULL,
  board_id             TEXT,
  board_version        INTEGER,
  action               TEXT NOT NULL,
  action_version       INTEGER NOT NULL,
  recorded_at          TEXT NOT NULL,
  reconciliation_state TEXT NOT NULL DEFAULT 'pending',
  reconciled_region_id TEXT,
  reconciled_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provisional_actions_identity
  ON provisional_actions(trip_id, place_id, action_version);
CREATE INDEX IF NOT EXISTS idx_provisional_actions_pending
  ON provisional_actions(trip_id, reconciliation_state);

-- What happened to those picks once verification finished.
--
-- One row per trip — the *current* account, which is what a page renders.
-- Superseded accounts are not overwritten into nothing: they move to
-- "board_reconciliation_history" first, so "what did you tell me last time"
-- has an answer.
--
-- "reconciliation_version" is the compare-and-set token. A worker holding an
-- older version cannot overwrite a newer account, which is the whole of the
-- stale-writer defence and does not need a lock to hold.
CREATE TABLE IF NOT EXISTS board_reconciliations (
  trip_id            TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  provisional_board_id TEXT NOT NULL,
  compiled_region_id TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

-- Every account that was ever current, kept so a superseded one is inspectable
-- rather than gone.
--
-- Unique on (trip, compiled region, reconciliation version): a re-run against
-- the same artifact at the same version is the same event, so a retry writes
-- nothing new. A *superseding* artifact reconciles again and lands beside it
-- rather than on top of it.
CREATE TABLE IF NOT EXISTS board_reconciliation_history (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id                TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  provisional_board_id   TEXT NOT NULL,
  provisional_board_version INTEGER NOT NULL,
  compiled_region_id     TEXT NOT NULL,
  reconciliation_version INTEGER NOT NULL,
  schema_version         INTEGER NOT NULL,
  payload_json           TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_reconciliation_history_identity
  ON board_reconciliation_history(trip_id, compiled_region_id, reconciliation_version);
CREATE INDEX IF NOT EXISTS idx_board_reconciliation_history_trip
  ON board_reconciliation_history(trip_id, created_at);

-- ===========================================================================
-- PAID MODEL OPERATIONS — THE SINGLE-FLIGHT LEASE
-- ===========================================================================
--
-- A ceiling of "one paid call per trip per sentence" that is implemented as a
-- read followed by an await is not a ceiling. Two concurrent server actions each
-- observe no prior call, each buy one, and the record afterwards says one.
--
-- The mechanism is the same unique partial index "evidence_operations",
-- "compilation_jobs" and "region_packs" already use, so this codebase has one
-- concurrency story rather than four. The winner is whoever's INSERT lands; the
-- losers read the winner's row and wait for its result rather than calling.
--
-- "operation_key" covers everything that could change the answer — trip,
-- normalised text, taxonomy, prompt, schema, model, locale — so a traveller who
-- edits their sentence gets a *different* operation rather than a stale result.
--
-- A heartbeat rather than a lease expiry timestamp, for the same reason as
-- "compilation_jobs": a process killed mid-call must not wedge a trip forever.
CREATE TABLE IF NOT EXISTS model_operations (
  id            TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL,
  owner         TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  started_at    TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  finished_at   TEXT,
  result_json   TEXT,
  failure_kind  TEXT,
  detail        TEXT,
  calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_operations_active
  ON model_operations(operation_key) WHERE state IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_model_operations_key
  ON model_operations(operation_key, started_at);
CREATE INDEX IF NOT EXISTS idx_model_operations_trip
  ON model_operations(trip_id, started_at);

-- ===========================================================================
-- IMAGERY METADATA
-- ===========================================================================
--
-- Metadata only, never bytes — the same discipline source_documents follows for
-- pages. A URL, a licence, a creator, an attribution string and the dimensions
-- are enough to render a compliant credit and to notice a file has changed, and
-- are not a redistribution of somebody's photograph.
--
-- Traveller-independent: a photograph of a mountain is a photograph of a
-- mountain. Keyed on the subject identity and the file, so two trips to the same
-- place share one lookup and one licence check.
--
-- Rejections are stored too, with their reason. A file we refused for its
-- licence is worth remembering: without it, every build re-fetches, re-checks
-- and re-refuses the same file.
CREATE TABLE IF NOT EXISTS destination_images (
  subject_key    TEXT NOT NULL,
  file_title     TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  accepted       INTEGER NOT NULL,
  rejected_reason TEXT,
  licence_id     TEXT,
  payload_json   TEXT NOT NULL,
  retrieved_at   TEXT NOT NULL,
  revalidate_after TEXT NOT NULL,
  PRIMARY KEY (subject_key, file_title)
);

CREATE INDEX IF NOT EXISTS idx_destination_images_subject
  ON destination_images(subject_key, accepted);
CREATE INDEX IF NOT EXISTS idx_destination_images_revalidate
  ON destination_images(revalidate_after);

-- ===========================================================================
-- STAGE TIMING OBSERVATIONS
-- ===========================================================================
--
-- What builds have actually taken, so a remaining-time range can be a
-- measurement rather than an invention. The compiler's own stage timestamps come
-- from an injected clock advanced one step per stage — deliberately, so two runs
-- of the same inputs produce byte-identical artifacts — and that made every
-- stage claim a millisecond and the progress screen offer "roughly 0s-0s to go".
--
-- Bucketed rather than pooled: breadth separates a city build from a country
-- build, warmth separates a run that bought its data from one that reused it,
-- and outcome keeps a stage that failed after two seconds out of the evidence
-- for how long that stage takes.
--
-- Not load-bearing. Emptying it costs an estimate, which the UI already knows
-- how to render as silence.
CREATE TABLE IF NOT EXISTS stage_observations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stage        TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  breadth      TEXT NOT NULL,
  warmth       TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_observations_bucket
  ON stage_observations(breadth, warmth, outcome, stage);
CREATE INDEX IF NOT EXISTS idx_stage_observations_observed
  ON stage_observations(observed_at);

-- ===========================================================================
-- FREE-TEXT INTERPRETATION CACHE
-- ===========================================================================
--
-- What a bounded model call made of text the deterministic phrase table could
-- not resolve.
--
-- **Traveller-scoped by construction, and that is the whole design.** The shared
-- evidence store holds facts about the world; this holds a reading of one
-- person's sentence. Letting it into a global cache would mean one traveller's
-- phrasing steering another traveller's ranking — so the row carries a trip id,
-- cascades with the trip, and the architecture test forbids this table's key
-- from appearing in any shared-cache derivation.
--
-- Keyed on normalised unresolved text *and* every version that could change the
-- answer (taxonomy, prompt, schema, model, locale), so a contract bump
-- re-derives rather than serving a reading produced under different rules.
CREATE TABLE IF NOT EXISTS interpretation_cache (
  cache_key    TEXT NOT NULL,
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (trip_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_interpretation_cache_expiry
  ON interpretation_cache(expires_at);

-- ===========================================================================
-- WEATHER SNAPSHOTS
-- ===========================================================================
--
-- Weather as a *persisted operation result*, never as something a page fetches
-- while rendering.
--
-- The /discover route used to call the forecast provider inside resolveTripRegion
-- during render, so every page load — every refresh, every back button — made an
-- external request, and a provider having a bad afternoon turned into a slow
-- page rather than into a stale badge. The snapshot is written by an explicit
-- refresh operation and read by the render path, which means a page can say
-- "fetched 40 minutes ago" or "never fetched" and offer a button, rather than
-- quietly buying data nobody asked for.
--
-- One row per (trip, dates fingerprint). Replaced by a refresh; never mutated by
-- a render. Deleting the table costs a badge, not a plan.
CREATE TABLE IF NOT EXISTS weather_snapshots (
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  scope_key     TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  valid_until   TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  PRIMARY KEY (trip_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_weather_snapshots_trip
  ON weather_snapshots(trip_id, fetched_at);

-- ===========================================================================
-- THE BENCHMARK — AN INTERNAL EXPERIMENT, APPEND-ONLY BY CONSTRUCTION
-- ===========================================================================
--
-- One session is one head-to-head: a shared traveller request, two independent
-- runs, two neutral plans, a randomised blind presentation, a locked review, an
-- irreversible reveal, and up to three correction rounds per system.
--
-- Two properties of the design are enforced here rather than in application
-- code, because both are the kind that a second browser tab and a direct POST
-- walk straight past.
--
-- **Content rows are never rewritten.** Plans, validations, reviews and model
-- calls are inserted and superseded, never updated. An experiment whose earlier
-- results can be edited after the fact is not evidence of anything, and "we only
-- ever meant to append" is a habit rather than a guarantee. Every column that any
-- UPDATE in this directory writes carries a MUTABLE marker below, and
-- "benchmark.architecture.test.ts" parses both this file and the
-- repositories to hold the list to its word — so a new UPDATE against an unmarked
-- column fails a test rather than quietly widening what may be rewritten.
--
-- The marked set is not all lifecycle. A correction round's payload, a question's
-- answer, a draft and an upserted metric are each rewritten in place, and each is
-- marked and says why it is not evidence being edited.
--
-- **A benchmark outlives the trip it ran against.** "trip_id" is a plain TEXT
-- column with no foreign key, deliberately, following "decision_sessions". With
-- "foreign_keys = ON" and the cascade every other table carries, deleting one
-- trip would silently destroy the record of a comparison — which is the one
-- thing a benchmark must not lose.
--
-- Retention does not know these tables exist, and a test asserts it stays that
-- way. The sweep is an explicit allow-list of five deletes; a new table is safe
-- precisely because nobody added a rule for it.

CREATE TABLE IF NOT EXISTS benchmark_sessions (
  id               TEXT PRIMARY KEY,
  schema_version   INTEGER NOT NULL,
  case_id          TEXT,
  benchmark_version TEXT NOT NULL,
  -- No REFERENCES. See the note above.
  -- MUTABLE, and set-once: attached when the deterministic arm's trip exists,
  -- and the write requires the column to still be NULL.
  trip_id          TEXT,
  -- Absorbs a retried submit. A second press of the button adopts the first
  -- session rather than starting a second comparison against the same request.
  idempotency_key  TEXT NOT NULL,
  request_version  INTEGER NOT NULL,
  request_json     TEXT NOT NULL,
  input_hash       TEXT NOT NULL,
  locale           TEXT NOT NULL,
  -- MUTABLE. created | running | ready_for_review | review_locked | revealed
  --        | corrections | complete | abandoned
  state            TEXT NOT NULL,
  -- MUTABLE, and set-once. Written by a compare-and-set that requires the column
  -- to still be NULL, which is what makes the transition it represents genuinely
  -- irreversible rather than merely discouraged.
  review_locked_at TEXT,
  -- MUTABLE, and set-once, by the same compare-and-set for the same reason.
  revealed_at      TEXT,
  created_at       TEXT NOT NULL,
  -- MUTABLE. Moves with whichever of the columns above moved.
  updated_at       TEXT NOT NULL,
  -- MUTABLE, with "state". Who is holding the two states that are held rather
  -- than passed through, and when they last said they were alive.
  --
  -- "preparing" and "running" are entered by a compare-and-set and left only by
  -- the invocation that entered them, which runs inside "after()" — so a restart
  -- during a world purchase left a session nothing could move, after it had been
  -- paid for. Every other durable claim in this schema has a heartbeat; these
  -- two now do too, and a claim whose pulse stopped is returned to the state it
  -- was taken from.
  state_owner      TEXT NOT NULL DEFAULT '',
  -- MUTABLE, with "state_owner", and on a pulse from the holder.
  state_heartbeat_at TEXT NOT NULL DEFAULT '',
  -- MUTABLE once, when the comparison is first started: whether paid operations
  -- were permitted at that moment. See the migration entry for why this is
  -- recorded rather than inferred from whether any money was spent.
  paid_mode        INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_sessions_idem
  ON benchmark_sessions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_benchmark_sessions_state
  ON benchmark_sessions(state, created_at);
CREATE INDEX IF NOT EXISTS idx_benchmark_sessions_case
  ON benchmark_sessions(case_id, created_at);

-- Drawn once, at session creation, and a stored fact thereafter. Nothing
-- re-derives it: a layout that changed on refresh would itself be a way to learn
-- which system is which.
CREATE TABLE IF NOT EXISTS benchmark_assignments (
  session_id      TEXT PRIMARY KEY REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  schema_version  INTEGER NOT NULL,
  label_a_system  TEXT NOT NULL,
  label_b_system  TEXT NOT NULL,
  first_label     TEXT NOT NULL,
  source          TEXT NOT NULL,
  seed            TEXT,
  -- The raw uniform draws, kept so the coin can be audited across sessions and
  -- so a tampered row disagrees with the number that supposedly produced it.
  draw_label      REAL NOT NULL,
  draw_order      REAL NOT NULL,
  assigned_at     TEXT NOT NULL
);

-- One arm of one session.
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  arm            TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  -- MUTABLE, and only from NULL: an arm names the prompt it used and the model it
  -- reached when it settles, because neither is known when the row is opened.
  prompt_version TEXT,
  -- MUTABLE, on the same terms as "prompt_version".
  model          TEXT,
  -- MUTABLE. pending | running | succeeded | partial | failed
  state          TEXT NOT NULL,
  -- MUTABLE, written once with the settling state. How a run ended is part of
  -- how it ended, not a later revision of it.
  failure_kind   TEXT,
  -- MUTABLE, written once with "failure_kind".
  failure_detail TEXT,
  started_at     TEXT NOT NULL,
  -- MUTABLE, written once with the settling state.
  finished_at    TEXT,
  -- MUTABLE, by the metric writer. cold | warm | mixed | unknown.
  --
  -- Here rather than in "benchmark_metrics" because that table stores one row per
  -- *Measurement* and this is a classification, not a number — so it had nowhere
  -- to go, was silently dropped on write, and every latency figure on the
  -- dashboard pooled first runs with repeats as a result. Warmth is the one
  -- covariate the pre-registered rules name as making latency readable.
  warmth         TEXT,
  -- MUTABLE, with "warmth". One sentence naming what the verdict was read off,
  -- so that "nothing observed this" and "this was observed to be cold" are
  -- distinguishable afterwards rather than both printing as a word.
  warmth_basis   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_runs_arm
  ON benchmark_runs(session_id, arm);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_state
  ON benchmark_runs(state, started_at);

-- The neutral plan. Immutable and content-addressed: a correction round inserts
-- a new row at a higher version naming the one it supersedes.
CREATE TABLE IF NOT EXISTS benchmark_plans (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  plan_version      INTEGER NOT NULL,
  supersedes_plan_id TEXT,
  schema_version    INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  fingerprint       TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_plans_identity
  ON benchmark_plans(run_id, plan_version);
CREATE INDEX IF NOT EXISTS idx_benchmark_plans_session
  ON benchmark_plans(session_id, created_at);

-- What each system produced in its own idiom, kept beside the neutral form so
-- the neutral form can stay neutral. Never rendered before the reveal.
CREATE TABLE IF NOT EXISTS benchmark_native_artifacts (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  plan_id        TEXT,
  kind           TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_native_identity
  ON benchmark_native_artifacts(run_id, kind, content_hash);

-- Every question either system asked, why, and who answered it. "asked_by" is
-- persisted and never rendered before the reveal.
CREATE TABLE IF NOT EXISTS benchmark_questions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  asked_by        TEXT NOT NULL,
  stage           TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  schema_version  INTEGER NOT NULL,
  -- MUTABLE once, with the answer. The question itself is not edited; the row
  -- carries the whole question object and the answer is part of it. Re-parsed
  -- before it is written, because a payload that will not parse afterwards is
  -- dropped on read and takes the question out of the pooled list with it.
  payload_json    TEXT NOT NULL,
  presented_at    TEXT NOT NULL,
  -- MUTABLE once, when the answer arrives, and only while the review is unlocked.
  answered_at     TEXT,
  -- MUTABLE once, with "answered_at". NULL means unanswered. Zero means answered
  -- from the shared request in no time at all. Collapsing those two is how a
  -- system looks cheap because nobody answered its questions.
  elapsed_ms      INTEGER,
  -- MUTABLE once, with "answered_at".
  answer_json     TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_questions_identity
  ON benchmark_questions(session_id, id);
CREATE INDEX IF NOT EXISTS idx_benchmark_questions_order
  ON benchmark_questions(session_id, sequence);

CREATE TABLE IF NOT EXISTS benchmark_validations (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  plan_id        TEXT NOT NULL REFERENCES benchmark_plans(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  critical_count INTEGER NOT NULL,
  major_count    INTEGER NOT NULL,
  minor_count    INTEGER NOT NULL,
  informational_count INTEGER NOT NULL,
  unknown_count  INTEGER NOT NULL,
  attempted      INTEGER NOT NULL,
  decided        INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_validations_plan
  ON benchmark_validations(plan_id);

-- One row per (run, metric). "value_num" is NULL exactly when the measurement is
-- unavailable, and then the reason says why. There is no zero in this table that
-- means "we could not tell" — the CHECK makes that shape unrepresentable rather
-- than merely discouraged, because the equivalent field elsewhere in this schema
-- coalesces a missing count to 0 and the two have been indistinguishable ever
-- since.
-- Every column below the identity is MUTABLE, by upsert: a run's metric set is
-- recomputed as later boundaries are reached, and the second write replaces the
-- first rather than adding a row the readers would then have to choose between.
-- The metric is a derived reading of the run, not a record of what happened, so
-- recomputing it is not editing evidence.
CREATE TABLE IF NOT EXISTS benchmark_metrics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  run_id             TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  metric_key         TEXT NOT NULL,
  -- MUTABLE, by upsert.
  availability       TEXT NOT NULL,
  -- MUTABLE, by upsert.
  value_num          REAL,
  -- MUTABLE, by upsert.
  unit               TEXT,
  -- MUTABLE, by upsert.
  unavailable_reason TEXT,
  -- MUTABLE, by upsert.
  detail             TEXT,
  -- MUTABLE, by upsert.
  computed_at        TEXT NOT NULL,
  CHECK (
    (availability = 'measured'
       AND value_num IS NOT NULL AND unit IS NOT NULL
       AND unavailable_reason IS NULL)
    OR
    (availability = 'unavailable'
       AND value_num IS NULL AND unit IS NULL
       AND unavailable_reason IS NOT NULL
       -- Present is not the same as said. An empty detail satisfies IS NOT NULL
       -- and renders as a blank beside the reason, which reads as an absence
       -- nobody bothered to explain — the one shape this table exists to refuse.
       AND detail IS NOT NULL AND length(detail) > 0)
  ),
  -- "x != x" is true only for NaN in SQLite; the bounds reject both infinities.
  -- Either would serialise through JSON as "null" and stop being detectable.
  CHECK (value_num IS NULL
         OR (value_num = value_num AND value_num > -1e308 AND value_num < 1e308))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_metrics_identity
  ON benchmark_metrics(run_id, metric_key);
CREATE INDEX IF NOT EXISTS idx_benchmark_metrics_session
  ON benchmark_metrics(session_id, metric_key);

-- The reviewer's blind judgement. Written once, at the lock, and never edited.
CREATE TABLE IF NOT EXISTS benchmark_reviews (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  reviewer       TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json   TEXT NOT NULL,
  submitted_at   TEXT NOT NULL
);

-- One locked review per session. A second submission changes no rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_reviews_session
  ON benchmark_reviews(session_id);

-- The draft a reviewer is still editing. The only benchmark content row that is
-- rewritten, and it is not evidence — it exists so a refresh mid-review does not
-- lose an hour's work. Its contents become evidence only by being copied into
-- "benchmark_reviews" at the lock.
CREATE TABLE IF NOT EXISTS benchmark_review_drafts (
  session_id   TEXT PRIMARY KEY REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  -- MUTABLE, on every keystroke that autosaves, and refused once the review is
  -- locked. See the note above for why rewriting this one is not editing evidence.
  payload_json TEXT NOT NULL,
  -- MUTABLE, with the draft.
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_post_reveal (
  session_id   TEXT PRIMARY KEY REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  -- MUTABLE, by upsert: these answers are given after the reveal, when the blind
  -- ratings are already locked and beyond reach, so a reviewer revising them
  -- changes nothing the comparison rests on.
  payload_json TEXT NOT NULL,
  -- MUTABLE, with the answers.
  answered_at  TEXT
);

-- Correction rounds. Append-only and version-guarded: "supersedes_plan_id" is
-- the compare-and-set token, so a round that started against an older plan
-- cannot land on top of a newer one.
CREATE TABLE IF NOT EXISTS benchmark_corrections (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  system             TEXT NOT NULL,
  round              INTEGER NOT NULL,
  supersedes_plan_id TEXT NOT NULL,
  -- MUTABLE once, when the round completes: the plan it produced does not exist
  -- when the round is claimed, and claiming is what reserves the round number.
  result_plan_id     TEXT,
  instruction_hash   TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  -- MUTABLE once, with the outcome. The instruction inside it is never rewritten
  -- — "instruction_hash" is fixed at the claim and is what proves that.
  payload_json       TEXT NOT NULL,
  requested_at       TEXT NOT NULL,
  -- MUTABLE once, and the guard requires it to still be NULL, so a round settles
  -- exactly one way.
  completed_at       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_corrections_identity
  ON benchmark_corrections(session_id, system, round);
CREATE INDEX IF NOT EXISTS idx_benchmark_corrections_session
  ON benchmark_corrections(session_id, requested_at);

-- The spend ledger. Counters and identifiers only — never a prompt body, never a
-- header map, never anything that has been near a credential. A failed call is
-- recorded with its tokens, because a provider that took the request and
-- returned nothing usable has still spent real money, and a ledger that only
-- counts successes is wrong in exactly the situation somebody is reading it.
CREATE TABLE IF NOT EXISTS benchmark_model_calls (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  run_id             TEXT,
  operation_key      TEXT NOT NULL,
  arm                TEXT NOT NULL,
  operation          TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  request_id         TEXT,
  attempt            INTEGER NOT NULL,
  -- NULL when the caller counted calls and not tokens. Not zero: the adjacent
  -- cost column is carefully guarded and these were not, so a compilation whose
  -- token counters were absent stored "it used no tokens" — the exact
  -- coalescence the writer's own header says appears nowhere in it.
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  -- NULL when the model has no entry in the checked-in rate table. Not zero: a
  -- call nobody could price and a call that cost nothing are different facts.
  cost_micro_usd     INTEGER,
  cost_unavailable_reason TEXT,
  outcome            TEXT NOT NULL,
  failure_kind       TEXT,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  duration_ms        INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_model_calls_identity
  ON benchmark_model_calls(operation_key, attempt);
CREATE INDEX IF NOT EXISTS idx_benchmark_model_calls_session
  ON benchmark_model_calls(session_id, started_at);

-- Durable single-flight, shaped exactly like "model_operations" above: a
-- heartbeat rather than an expiry timestamp, so a process killed mid-call
-- releases its claim instead of wedging a session for ever.
--
-- "operation_key" carries the session id. Without it two sessions running the
-- same request would collide on one operation and the second would be handed the
-- first's result, which is a cross-session leak wearing a cache's clothes.
CREATE TABLE IF NOT EXISTS benchmark_operations (
  id            TEXT PRIMARY KEY,
  operation_key TEXT NOT NULL,
  session_id    TEXT NOT NULL REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  -- MUTABLE. pending | running | succeeded | failed_retryable | failed_terminal
  --        | superseded
  state         TEXT NOT NULL,
  owner         TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  -- MUTABLE, and the point of the table: the holder says it is still alive, and a
  -- claim that stops arriving is what releases the lease.
  heartbeat_at  TEXT NOT NULL,
  -- MUTABLE, written when the operation settles or its lease expires.
  finished_at   TEXT,
  -- MUTABLE, written with the settling state.
  result_ref    TEXT,
  -- MUTABLE, written with the settling state.
  failure_kind  TEXT,
  -- MUTABLE, written with the settling state.
  detail        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_operations_active
  ON benchmark_operations(operation_key) WHERE state IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_benchmark_operations_key
  ON benchmark_operations(operation_key, started_at);
CREATE INDEX IF NOT EXISTS idx_benchmark_operations_session
  ON benchmark_operations(session_id, started_at);

-- THE WORLD BOTH ARMS PLAN AGAINST, BOUGHT ONCE AND KEPT.
--
-- Written during the question round, before either planner starts, and read back
-- when the traveller has answered. It exists because the round is a genuine
-- pause — the harness stops and waits for a person — and the two halves are
-- separate server invocations either side of it. Without a stored world the
-- second half would have to buy the same places, routes, hours and forecast a
-- second time: minutes of somebody else's volunteer-run service, paid twice, for
-- data that has not changed.
--
-- One row per session and never rewritten, which is what makes the world the two
-- arms are compared on demonstrably the same one the questions were derived from.
CREATE TABLE IF NOT EXISTS benchmark_shared_worlds (
  session_id      TEXT PRIMARY KEY REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  schema_version  INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  -- How long the purchase took. Charged to neither arm and recorded on both.
  preparation_ms  INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  gathered_at     TEXT NOT NULL
);

-- The clock that separates what a person waited from what the machines did.
--
-- Written by the harness rather than by either arm: an arm cannot see the other
-- arm, and neither can see the traveller. "questions_ready_at" and
-- "answers_closed_at" bound the only span in a comparison that is spent waiting
-- for a human, and the difference between them is what "humanAnswerWaitMs"
-- reports. Session-level because the wait is the session's, not either arm's.
CREATE TABLE IF NOT EXISTS benchmark_session_clock (
  session_id         TEXT PRIMARY KEY REFERENCES benchmark_sessions(id) ON DELETE CASCADE,
  -- Set once, when the comparison is first started by a press.
  started_at         TEXT NOT NULL,
  -- MUTABLE once: set when the question round opens.
  questions_ready_at TEXT,
  -- MUTABLE once: set when the traveller asks for the plans.
  answers_closed_at  TEXT,
  -- MUTABLE once: set when both arms have stopped.
  finished_at        TEXT
);
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
  /**
   * Added when claims gained supersession.
   *
   * A database written by the first half of Phase 10 has `evidence_claims`
   * without it, and `CREATE TABLE IF NOT EXISTS` would not add it — the first
   * write would fail with a message about SQL syntax rather than about what
   * actually happened.
   */
  { table: 'evidence_claims', column: 'superseded', definition: 'INTEGER NOT NULL DEFAULT 0' },
  /**
   * Added by the trip composer.
   *
   * Nullable rather than defaulted: a trip created before the composer existed
   * genuinely has no composer answers, and a `'{}'` default would be a record of
   * somebody having answered nothing rather than of nobody having been asked.
   */
  { table: 'trip_intents', column: 'composer_json', definition: 'TEXT' },
  { table: 'trip_intents', column: 'selected_destination_json', definition: 'TEXT' },
  { table: 'trip_intents', column: 'preflight_json', definition: 'TEXT' },
  /**
   * Added by the provisional board.
   *
   * Nullable, for the same reason the composer columns are: a job that ran before
   * the provisional cut existed genuinely produced no board, and an id pointing
   * at nothing would be a record of a board nobody was shown.
   */
  { table: 'compilation_jobs', column: 'provisional_board_id', definition: 'TEXT' },
  /**
   * Added when pinned removals gained an acknowledgment.
   *
   * A pinned place that did not survive verification must not disappear
   * silently, and "we told them" is a fact about this traveller rather than
   * about the artifact — so it is a column on the reconciliation row rather than
   * a rewrite of it. Nullable: a reconciliation written before this existed has
   * nothing acknowledged, which is the correct reading, and an empty-object
   * default would claim the panel had been shown.
   */
  { table: 'board_reconciliations', column: 'acknowledged_json', definition: 'TEXT' },
  /**
   * Added when operational counters were taken off the artifact.
   *
   * The runner used to fold live provider and cache counters into
   * `CompiledRegion.diagnostics.budget.consumed` *after* the compiler returned.
   * The compiler's own determinism was intact; what was persisted was not — two
   * builds of identical inputs differed by exactly how warm the cache happened
   * to be, which is the property `saveWorkPlan`'s own comment says it exists to
   * avoid.
   *
   * They are facts about a run, so they live on the run. Nullable: a job that
   * finished before this column existed genuinely recorded none, and a `'{}'`
   * default would be a record of a build that cost nothing.
   */
  { table: 'compilation_jobs', column: 'operational_json', definition: 'TEXT' },
  /**
   * Added when a traveller's mark gained the identity of the board it was made
   * on.
   *
   * Without these, "you unpinned it" and "the board you pinned it on no longer
   * exists" are the same row, and a removal gets blamed on a board the traveller
   * never saw. Nullable rather than defaulted: a mark made before the board
   * identity was recorded genuinely has no board attached, and inventing version
   * 1 would be asserting it was made on the first board when nobody knows.
   */
  { table: 'provisional_selections', column: 'board_id', definition: 'TEXT' },
  { table: 'provisional_selections', column: 'board_version', definition: 'INTEGER' },
  /**
   * Monotonic per (trip, place). The compare-and-set token for a mark.
   *
   * A stale worker holding version 3 cannot overwrite version 4, and a duplicate
   * delivery of version 3 is a no-op rather than a second event. Defaulted to 1
   * because a row that predates the column has had exactly one recorded state.
   */
  {
    table: 'provisional_selections',
    column: 'action_version',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  /**
   * Every mark ends in an explicit state, and `pending` is one of them.
   *
   * The defect this closes is a mark recorded after reconciliation ran, which
   * previously ended in *no* state at all — neither reconciled nor recorded as
   * outstanding — while the panel counted it among "all N decisions you made".
   * A row that predates the column is `pending`, which is true: nothing has told
   * the traveller what became of it under the new model.
   */
  {
    table: 'provisional_selections',
    column: 'reconciliation_state',
    definition: "TEXT NOT NULL DEFAULT 'pending'",
  },
  { table: 'provisional_selections', column: 'reconciled_region_id', definition: 'TEXT' },
  { table: 'provisional_selections', column: 'reconciled_at', definition: 'TEXT' },
  /**
   * The board version the account was written against, and the compare-and-set
   * token that stops an older worker overwriting a newer account.
   *
   * Defaulted rather than nullable: an account written before this existed was
   * the first one, and 1 is the honest reading of that rather than a guess.
   */
  {
    table: 'board_reconciliations',
    column: 'provisional_board_version',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  {
    table: 'board_reconciliations',
    column: 'reconciliation_version',
    definition: 'INTEGER NOT NULL DEFAULT 1',
  },
  /**
   * Added when the progress poll's bucket lookup stopped being a table scan.
   *
   * `runBucket` matched `payload_json LIKE '%"jobId":"…"%'` against up to fifty
   * thousand rows on every poll of the progress screen. The job id was already
   * inside the payload; it just was not anywhere an index could reach. Nullable:
   * a row written before the column has its job id in the payload and is read
   * from there, so backfilling would be rewriting history to no purpose.
   */
  { table: 'stage_observations', column: 'job_id', definition: 'TEXT' },
  /**
   * Added when `rowToJob` stopped stamping the current version onto whatever was
   * stored.
   *
   * A row that claims to be the version this build happens to be on is a row
   * asserting it was written under rules it has never been read against. With the
   * column, a job that cannot be read degrades to absent and the caller offers a
   * rebuild — the policy `getCompiledRegion` already follows. Defaulted to 1
   * rather than nullable, because 1 is the only version ever written, and that is
   * a fact rather than a guess.
   */
  { table: 'compilation_jobs', column: 'schema_version', definition: 'INTEGER NOT NULL DEFAULT 1' },

  /*
   * THE COLUMNS A NEW TABLE DOES NOT NEED AND AN EXISTING ONE DOES.
   *
   * `benchmark_shared_worlds` and `benchmark_session_clock` are new tables and
   * arrive fine — `CREATE TABLE IF NOT EXISTS` creates them. `benchmark_runs`
   * already shipped, so `CREATE TABLE IF NOT EXISTS` does nothing to it and the
   * two warmth columns landed in `SCHEMA_SQL` alone. Any database created by an
   * earlier build on this branch — including a pilot's — would then answer
   * `no such column: warmth` to the first `SELECT`, which is on the path of
   * `startRun`, `getRuns` and `getRunForArm`: the session index, the progress
   * poll, the review page, the report and both arms of every run, all rendering
   * the same neutral "something went wrong" with nothing saying it is one column.
   *
   * Defaulted rather than nullable, and to the same word the writer uses for an
   * unobserved run, so a row written before the column existed reads as what it
   * is: a run whose warmth nobody recorded.
   */
  { table: 'benchmark_runs', column: 'warmth', definition: "TEXT NOT NULL DEFAULT 'unknown'" },
  {
    table: 'benchmark_runs',
    column: 'warmth_basis',
    definition:
      "TEXT NOT NULL DEFAULT 'This run predates the column, so nothing observed its warmth.'",
  },

  /*
   * The lease on the two in-flight session states.
   *
   * `preparing` and `running` are entered by a compare-and-set and were left only
   * by the same invocation, which runs inside `after()` — so a hot reload, a
   * recycled container or an OOM between the two left the session in a state
   * nothing could move it out of, after the world had already been bought and
   * paid for. A lock with no release is not a lock, it is a trap.
   */
  { table: 'benchmark_sessions', column: 'state_owner', definition: "TEXT NOT NULL DEFAULT ''" },
  /*
   * Whether paid operations were permitted when this session ran.
   *
   * Liveness used to be inferred from the spend ledger — a session counted as
   * live only if *both* arms had recorded a model call. A fully warm compilation
   * makes none, so eleven repeat sessions on one destination would all be filed
   * as practice and vanish from the live aggregate. The bias is one-sided and
   * runs with the outcome: the warmest, fastest, cheapest sessions are the ones
   * most likely to disappear, and the pre-registered rules forbid excluding a
   * session for anything but a documented harness defect.
   *
   * Recorded rather than inferred. Defaulted to 0 because a row written before
   * the column existed cannot have been a live run under this build.
   */
  { table: 'benchmark_sessions', column: 'paid_mode', definition: 'INTEGER NOT NULL DEFAULT 0' },
  {
    table: 'benchmark_sessions',
    column: 'state_heartbeat_at',
    definition: "TEXT NOT NULL DEFAULT ''",
  },
];

/**
 * Indexes that cannot live in `SCHEMA_SQL`.
 *
 * `SCHEMA_SQL` runs *before* `COLUMN_MIGRATIONS`, so an index over a column that
 * arrives by migration would fail on exactly the databases the migration exists
 * for — the old ones. These are applied afterwards instead, and are otherwise
 * ordinary `IF NOT EXISTS` DDL.
 */
export const INDEX_MIGRATIONS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_stage_observations_job
     ON stage_observations(job_id, id)`,
  /**
   * The bucket query constrains warmth and outcome and never breadth, so an
   * index leading with breadth was never usable by it. This one leads with what
   * the predicate actually holds.
   */
  `CREATE INDEX IF NOT EXISTS idx_stage_observations_lookup
     ON stage_observations(warmth, outcome, observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_provisional_selections_pending
     ON provisional_selections(trip_id, reconciliation_state)`,
  /**
   * The shortlist's per-country bucket read, in the order it asks for.
   *
   * Building a shortlist used to scan the whole destination index — `IS NOT NULL`
   * on the leading index column plus a full window sort — on the click that
   * produces it. The query is now a bounded per-(country, feature type) read, and
   * this is the index that makes it *bounded to read* rather than merely bounded
   * to return: `LIMIT n` only stops an index walk early when the index is already
   * in the order the query asks for, so without `rank DESC` here SQLite reads
   * every row of the range into a temporary b-tree and hands back three.
   *
   * Here rather than in `SCHEMA_SQL` because it is applied in the same pass as the
   * other post-migration indexes, and keeping one place for them beats two.
   */
  `CREATE INDEX IF NOT EXISTS idx_destination_index_bucket
     ON destination_index(country_code, feature_type, rank DESC, id)`,
  /**
   * The retention sweep's own predicate.
   *
   * `idx_weather_snapshots_trip` leads with `trip_id`, which the sweep never
   * constrains — so of the four retention rules this was the only one that
   * full-scanned, synchronously, on the rare path a compilation already stalls
   * on.
   */
  `CREATE INDEX IF NOT EXISTS idx_weather_snapshots_expiry
     ON weather_snapshots(valid_until)`,
];
