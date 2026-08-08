/**
 * THE SCHEMA AS IT STOOD AT THE PHASE 12 MERGE, FROZEN.
 *
 * Lifted verbatim from `git show 3ace096:apps/web/src/lib/db/schema.ts` with the
 * explanatory comments stripped, and then never touched again. It is a fixture,
 * not a copy of anything live: the moment somebody "updates" it to match the
 * current schema, the migration test starts migrating the present to the present
 * and passes forever while proving nothing.
 *
 * This is a genuine **pre-Phase-13** database. It has everything Phase 12 shipped
 * — the evidence store, region packs, provisional boards, reconciliations, the
 * destination index, imagery, stage observations, the interpretation cache and
 * weather snapshots — and none of the eleven benchmark tables.
 */
export const PRE_PHASE_13_SCHEMA = `
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

CREATE TABLE IF NOT EXISTS food_selections (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  venue_id   TEXT NOT NULL,
  status     TEXT NOT NULL,
  source     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, venue_id)
);

CREATE INDEX IF NOT EXISTS idx_food_selections_trip ON food_selections(trip_id);

CREATE TABLE IF NOT EXISTS weather_cache (
  cache_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  stored_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_weather_cache_stored ON weather_cache(stored_at);

CREATE INDEX IF NOT EXISTS idx_itinerary_days_trip ON itinerary_days(trip_id);
CREATE INDEX IF NOT EXISTS idx_itinerary_items_trip_day ON itinerary_items(trip_id, day_number);

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
  composer_json              TEXT,
  selected_destination_json  TEXT,
  preflight_json             TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_compilation_jobs_active
  ON compilation_jobs(trip_id) WHERE state IN ('queued', 'running');

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

CREATE TABLE IF NOT EXISTS provider_cache (
  cache_key    TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  stored_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provider_cache_expiry ON provider_cache(expires_at);

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

CREATE INDEX IF NOT EXISTS idx_region_packs_lookup
  ON region_packs(scope_hash, catalog, release_id, created_at);

CREATE INDEX IF NOT EXISTS idx_region_packs_scope ON region_packs(scope_hash, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_region_packs_unique_ready
  ON region_packs(scope_hash, catalog, release_id)
  WHERE state IN ('ready', 'partial');

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

CREATE TABLE IF NOT EXISTS evidence_parses (
  document_version_id TEXT NOT NULL,
  parser_version      TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  parsed_at           TEXT NOT NULL,
  PRIMARY KEY (document_version_id, parser_version)
);

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
  superseded          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_evidence_claims_subject
  ON evidence_claims(subject_key, fact_path, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_evidence_claims_document
  ON evidence_claims(document_version_id);

CREATE TABLE IF NOT EXISTS compiled_region_claims (
  compiled_region_id TEXT NOT NULL,
  claim_id           TEXT NOT NULL,
  PRIMARY KEY (compiled_region_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_compiled_region_claims_claim
  ON compiled_region_claims(claim_id);

CREATE TABLE IF NOT EXISTS evidence_research_attempts (
  key           TEXT PRIMARY KEY,
  subject_key   TEXT NOT NULL,
  contract      TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  attempted_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_attempts_subject
  ON evidence_research_attempts(subject_key);

CREATE TABLE IF NOT EXISTS evidence_fact_sets (
  key          TEXT PRIMARY KEY,
  subject_key  TEXT NOT NULL,
  fact_path    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_fact_sets_subject
  ON evidence_fact_sets(subject_key, fact_path);

CREATE TABLE IF NOT EXISTS evidence_discovery (
  key          TEXT PRIMARY KEY,
  outcome      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_discovery_expiry ON evidence_discovery(expires_at);

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

CREATE TABLE IF NOT EXISTS compilation_work_plans (
  job_id       TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compilation_work_plans_trip ON compilation_work_plans(trip_id);

CREATE TABLE IF NOT EXISTS planner_readiness (
  trip_id      TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  level        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS destination_index_terms (
  term     TEXT NOT NULL,
  rank     REAL NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (term, rank, entry_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_destination_terms_prefix
  ON destination_index_terms(term, rank DESC);

CREATE TABLE IF NOT EXISTS destination_index_release (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_sessions (
  id             TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  answers_json   TEXT NOT NULL,
  shortlist_json TEXT,
  resolved_trip_id TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_sessions_updated ON decision_sessions(updated_at);

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

CREATE TABLE IF NOT EXISTS provisional_selections (
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id   TEXT NOT NULL,
  intent     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_provisional_selections_trip
  ON provisional_selections(trip_id);

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

CREATE TABLE IF NOT EXISTS board_reconciliations (
  trip_id            TEXT PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  provisional_board_id TEXT NOT NULL,
  compiled_region_id TEXT NOT NULL,
  schema_version     INTEGER NOT NULL,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

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
`;
