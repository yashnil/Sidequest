import 'server-only';
import {
  destinationIndexEntrySchema,
  destinationIndexReleaseSchema,
  searchTermsFor,
  type DestinationIndexEntry,
  type DestinationIndexRelease,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * PERSISTENCE FOR THE DESTINATION INDEX.
 *
 * Two responsibilities, kept apart because they have different costs: *pruning*
 * (SQL, bounded, indexed) and *ranking* (pure TypeScript in `@sidequest/core`,
 * with tests). This file must never contain a ranking rule — a scoring decision
 * hidden in an `ORDER BY` is one nobody can test and one the in-memory provider
 * cannot reproduce.
 *
 * The `rank` column is the exception that proves it: it is not a score, it is a
 * *pruning* key. It decides which five hundred of forty thousand rows are worth
 * scoring, and the real ordering happens afterwards over all of them.
 */

/**
 * How many rows a prefix may pull back before ranking.
 *
 * Sized from the worst realistic case: a two-character prefix in a Latin script
 * matches on the order of ten thousand entries, and the top five hundred by
 * catalogue prominence reliably contain everything a person could have meant.
 * The cap is what keeps a keystroke O(1) in the size of the world.
 */
const PRUNE_LIMIT = 500;

/** Prefix scans widen when the exact prefix was thin; each variant is cheaper. */
const FUZZY_PRUNE_LIMIT = 150;

interface Row {
  payload_json: string;
}

function parseRow(row: Row): DestinationIndexEntry | null {
  try {
    return destinationIndexEntrySchema.parse(JSON.parse(row.payload_json));
  } catch {
    // A row written by an older build that no longer validates is a row we do
    // not serve. Never a throw: one bad entry must not empty a dropdown.
    return null;
  }
}

export function destinationIndexRelease(): DestinationIndexRelease | null {
  const row = getDb()
    .prepare<[], { payload_json: string }>('SELECT payload_json FROM destination_index_release WHERE id = 1')
    .get();
  if (!row) return null;
  try {
    return destinationIndexReleaseSchema.parse(JSON.parse(row.payload_json));
  } catch {
    return null;
  }
}

/**
 * Entries whose folded terms start with this prefix, most prominent first.
 *
 * The upper bound uses `￿` rather than `LIKE 'x%'` deliberately: `LIKE` on
 * a text column cannot use the index unless the collation is `NOCASE` *and* the
 * pattern is a literal, and getting that wrong turns every keystroke into a full
 * scan of four hundred thousand rows. A half-open range on the primary key is
 * an index seek by construction.
 */
export function entriesByPrefix(prefix: string, limit = PRUNE_LIMIT): DestinationIndexEntry[] {
  if (prefix.length === 0) return [];
  const rows = getDb()
    .prepare<[string, string, number], Row>(
      `SELECT e.payload_json AS payload_json
         FROM destination_index_terms t
         JOIN destination_index e ON e.id = t.entry_id
        WHERE t.term >= ? AND t.term < ?
        ORDER BY t.rank DESC
        LIMIT ?`,
    )
    .all(prefix, `${prefix}￿`, limit);

  const entries: DestinationIndexEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = parseRow(row);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

/** The same seek, for a handful of typo-tolerant prefixes. Bounded per variant. */
export function entriesByPrefixes(prefixes: readonly string[]): DestinationIndexEntry[] {
  const merged = new Map<string, DestinationIndexEntry>();
  for (const prefix of prefixes) {
    for (const entry of entriesByPrefix(prefix, FUZZY_PRUNE_LIMIT)) {
      if (!merged.has(entry.id)) merged.set(entry.id, entry);
    }
  }
  return [...merged.values()];
}

export function destinationEntryById(entryId: string): DestinationIndexEntry | null {
  const row = getDb()
    .prepare<[string], Row>('SELECT payload_json FROM destination_index WHERE id = ?')
    .get(entryId);
  return row ? parseRow(row) : null;
}

/**
 * Every indexed feature inside one country.
 *
 * Used by the broad-scope layer to cluster a country into candidate regions from
 * source coordinates rather than from a model's idea of how a country divides.
 * Bounded by `limit` because a large country has thousands of localities and the
 * clusterer only needs the ones somebody would base a trip in.
 */
export function entriesInCountry(
  countryCode: string,
  featureTypes: readonly string[],
  limit = 400,
): DestinationIndexEntry[] {
  if (featureTypes.length === 0) return [];
  const placeholders = featureTypes.map(() => '?').join(',');
  const rows = getDb()
    .prepare<unknown[], Row>(
      `SELECT payload_json FROM destination_index
        WHERE country_code = ? AND feature_type IN (${placeholders})
        ORDER BY rank DESC LIMIT ?`,
    )
    .all(countryCode.toUpperCase(), ...featureTypes, limit);
  return rows.map(parseRow).filter((entry): entry is DestinationIndexEntry => entry !== null);
}

/**
 * THE CANDIDATE UNIVERSE FOR "WHERE SHOULD I GO".
 *
 * A bounded, worldwide read — the one query in this file that is not scoped to a
 * country or a prefix. Three things keep it honest:
 *
 * **It prunes, it does not rank.** `rank` decides which rows are worth *scoring*
 * and nothing else, exactly as it does for the dropdown. The ordering a
 * traveller sees is computed in `@sidequest/core` from climate, duration,
 * structure and supply, none of which SQL can see.
 *
 * **It is stratified by country before it is capped.** A plain
 * `ORDER BY rank DESC LIMIT n` over the whole index returns the largest places
 * on earth — a list of megacities, which is the capital-concentration defect one
 * level up from where it was fixed in the inventory. Taking the top few per
 * country first means the universe spans the world before it is narrowed, and
 * the *ranking* then decides which of those actually suit the trip.
 *
 * **It reads a bounded number of rows, and ties are broken by a stated rule.**
 * See {@link scanRecommendationUniverse} for both, and for what the previous
 * implementation did instead.
 */
export function recommendationUniverse(input: {
  featureTypes: readonly string[];
  /** How many candidates any one country may contribute before scoring. */
  perCountry: number;
  /** Total ceiling. A bound on the work, not a judgement. */
  limit: number;
}): DestinationIndexEntry[] {
  return scanRecommendationUniverse(input).entries;
}

/**
 * The SQL the universe scan is made of, named so a test can hold it to its plan.
 *
 * Exported because "this query is an index seek" is a claim, and a claim about a
 * query plan can only be checked against the exact text the driver runs. A test
 * that retyped the statement would be asserting the plan of a query nobody
 * executes.
 *
 * `{types}` is the only substitution: the `IN` list is built from a caller's
 * feature types, and SQLite has no array parameter.
 */
export const UNIVERSE_SQL = {
  /**
   * Every distinct country code, without reading a row per country's worth of
   * entries.
   *
   * A skip-scan expressed as a recursive `MIN` walk: each step is an index seek
   * to the next value strictly greater than the last, so the work is one seek
   * per *distinct* country rather than one row per entry. `SELECT DISTINCT`
   * cannot do this — it reads every index entry and de-duplicates afterwards,
   * which on a real catalogue is a hundred thousand rows to learn two hundred
   * and seventy answers.
   */
  countries: `WITH RECURSIVE codes(code) AS (
      SELECT MIN(country_code) FROM destination_index WHERE country_code IS NOT NULL
      UNION ALL
      SELECT (SELECT MIN(country_code) FROM destination_index WHERE country_code > codes.code)
        FROM codes WHERE code IS NOT NULL
    )
    SELECT code FROM codes WHERE code IS NOT NULL`,

  /**
   * The top `n` of one country's entries of one feature type.
   *
   * One feature type per statement rather than an `IN` list, and that is the
   * whole boundedness argument. With `feature_type IN (…)` SQLite has to merge
   * several index ranges before it can honour `ORDER BY rank DESC`, so it reads
   * *every* row in those ranges into a temporary b-tree and then returns three —
   * which is the same unbounded read in a smaller costume. With a single
   * equality on the second index column the index is already in `rank` order, so
   * the plan is an ordered covering seek and `LIMIT` stops it after `n` entries.
   */
  bucket: `SELECT id, rank FROM destination_index
            WHERE country_code = ? AND feature_type = ?
            ORDER BY rank DESC, id ASC
            LIMIT ?`,

  /** The chosen entries' payloads, by primary key. One seek each. */
  payload: 'SELECT payload_json FROM destination_index WHERE id = ?',
} as const;

/** What one universe scan cost, so the bound can be asserted rather than asserted about. */
export interface UniverseScan {
  entries: DestinationIndexEntry[];
  /** Distinct countries the index holds. One index seek each. */
  countries: number;
  /**
   * Index entries returned by the per-bucket seeks.
   *
   * Never more than `countries × featureTypes × perCountry`. Because each seek
   * is an *ordered* covering seek — no sort step — this is also the number of
   * index entries SQLite reads.
   */
  indexRowsRead: number;
  /** Table rows read for their payload. Never more than `limit`. */
  payloadRowsRead: number;
}

/**
 * The same read, reporting what it cost.
 *
 * ## What this replaces, and why
 *
 * The previous implementation was one statement: a `ROW_NUMBER() OVER (PARTITION
 * BY country_code ORDER BY rank DESC)` window over
 * `WHERE feature_type IN (…) AND country_code IS NOT NULL`. Two problems, both
 * of which this fixes.
 *
 * **It read the whole index.** `country_code IS NOT NULL` is a range over the
 * leading index column, so the plan was a scan of every indexed row; the window
 * then materialised `payload_json` for all of them and sorted them twice. On a
 * catalogue of 109,853 entries that is 42,826 rows read, two temporary b-trees
 * and 50–210 ms of a *synchronous* driver — on the click that builds a
 * shortlist, blocking every other request in the process for the duration.
 *
 * This version reads one index entry per distinct country, then at most
 * `perCountry` per (country, feature type), then one table row per entry it
 * actually returns: 272 + 1,168 + 240 rows for the same catalogue, in ~20 ms.
 * The bound holds however large the index grows, because it is a function of how
 * many countries exist rather than of how many places do.
 *
 * **Its result was not reproducible.** `rank` is a coarse pruning key with heavy
 * ties — every region floors at 70 — so both cuts landed inside a tie. On the
 * catalogue above, 447 entries tie for the last 19 seats and 165 countries have
 * a tied third seat, and SQL leaves the choice among equal sort keys
 * unspecified: adding an index to that table changes 20 of the 240 rows the old
 * statement returns. A shortlist is a product surface, so "the same inputs give
 * the same list" has to be a property of the code rather than of whichever plan
 * the optimiser picked that day.
 *
 * So ties are broken here, explicitly, by `id` ascending — at both cuts. That
 * changes which of several *equally ranked* entries reach the scorer and nothing
 * else: the multiset of ranks in the result is unchanged, and every entry that
 * enters or leaves is exchanged for one the pruning key rates identically. It
 * cannot change which entries the traveller sees ranked above which, because
 * `rank` is not that ranking — `@sidequest/core` computes that afterwards from
 * climate, duration, structure and supply.
 */
export function scanRecommendationUniverse(input: {
  featureTypes: readonly string[];
  perCountry: number;
  limit: number;
}): UniverseScan {
  const empty: UniverseScan = {
    entries: [],
    countries: 0,
    indexRowsRead: 0,
    payloadRowsRead: 0,
  };
  if (input.featureTypes.length === 0) return empty;

  const perCountry = Math.max(0, Math.floor(input.perCountry));
  const limit = Math.max(0, Math.floor(input.limit));
  if (perCountry === 0 || limit === 0) return empty;

  const db = getDb();
  const countries = db
    .prepare<[], { code: string }>(UNIVERSE_SQL.countries)
    .all()
    .map((row) => row.code);
  const bucket = db.prepare<[string, string, number], Seat>(UNIVERSE_SQL.bucket);

  let indexRowsRead = 0;
  const chosen: Seat[] = [];
  for (const code of countries) {
    const forCountry: Seat[] = [];
    for (const featureType of input.featureTypes) {
      const seats = bucket.all(code, featureType, perCountry);
      indexRowsRead += seats.length;
      forCountry.push(...seats);
    }
    /*
     * Each feature type contributed its own top `perCountry`, so the country's
     * true top `perCountry` across all of them is in here — a row outside it
     * would have to beat `perCountry` rows of its own type, which is exactly
     * what the seek already excluded.
     */
    forCountry.sort(bySeat);
    chosen.push(...forCountry.slice(0, perCountry));
  }

  chosen.sort(bySeat);
  const top = chosen.slice(0, limit);

  const payload = db.prepare<[string], Row>(UNIVERSE_SQL.payload);
  const entries: DestinationIndexEntry[] = [];
  for (const seat of top) {
    const row = payload.get(seat.id);
    if (!row) continue;
    const entry = parseRow(row);
    if (entry) entries.push(entry);
  }

  return {
    entries,
    countries: countries.length,
    indexRowsRead,
    payloadRowsRead: top.length,
  };
}

interface Seat {
  id: string;
  rank: number;
}

/**
 * Higher pruning key first; `id` ascending decides ties.
 *
 * The tiebreak is arbitrary on purpose and stated on purpose. Something has to
 * choose between two entries the pruning key cannot separate, and the only two
 * options are a rule written down here or whatever order the storage engine
 * happened to produce.
 */
function bySeat(left: Seat, right: Seat): number {
  if (left.rank !== right.rank) return right.rank - left.rank;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function destinationIndexSize(): number {
  const row = getDb()
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM destination_index')
    .get();
  return row?.count ?? 0;
}

/**
 * Replace the whole index, transactionally.
 *
 * Wholesale rather than incremental because a half-written index is worse than
 * none: a traveller would get suggestions for the parts of the world that had
 * been imported and silence for the rest, with nothing on screen to distinguish
 * that from "nowhere by that name". One transaction means the index is either
 * the old release or the new one.
 */
export function replaceDestinationIndex(input: {
  entries: readonly DestinationIndexEntry[];
  release: DestinationIndexRelease;
}): { entries: number; terms: number } {
  const db = getDb();
  const insertEntry = db.prepare(
    `INSERT OR REPLACE INTO destination_index
       (id, catalog, source_id, feature_type, country_code, rank, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTerm = db.prepare(
    'INSERT OR IGNORE INTO destination_index_terms (term, rank, entry_id) VALUES (?, ?, ?)',
  );

  let terms = 0;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM destination_index_terms').run();
    db.prepare('DELETE FROM destination_index').run();

    for (const entry of input.entries) {
      const rank = rankOf(entry);
      insertEntry.run(
        entry.id,
        entry.catalog,
        entry.sourceId,
        entry.featureType,
        entry.countryCode ?? null,
        rank,
        JSON.stringify(entry),
      );
      const names = [entry.displayName];
      if (entry.localName) names.push(entry.localName);
      names.push(...entry.aliases);
      for (const term of searchTermsFor(names)) {
        insertTerm.run(term, rank, entry.id);
        terms += 1;
      }
    }

    db.prepare('DELETE FROM destination_index_release').run();
    db.prepare('INSERT INTO destination_index_release (id, payload_json) VALUES (1, ?)').run(
      JSON.stringify({ ...input.release, entryCount: input.entries.length }),
    );
  });
  run();

  return { entries: input.entries.length, terms };
}

/**
 * The pruning key: how likely this entry is to be the one somebody meant.
 *
 * Not a score — the score is computed in core, from the query. This decides only
 * which rows are worth scoring when a prefix matches more than we will read.
 * Countries and regions are floored above localities so that a two-letter prefix
 * always surfaces the coarse answer, which is the one a traveller is most often
 * reaching for and the one that costs most to miss.
 */
function rankOf(entry: DestinationIndexEntry): number {
  const floor =
    entry.featureType === 'country' || entry.featureType === 'dependency'
      ? 95
      : entry.featureType === 'region'
        ? 70
        : 0;
  const prominence = entry.prominence ?? 0;
  const population = entry.population ?? 0;
  const fromPopulation = population > 0 ? Math.min(90, Math.log10(population) * 13) : 0;
  return Math.max(floor, prominence, fromPopulation);
}
