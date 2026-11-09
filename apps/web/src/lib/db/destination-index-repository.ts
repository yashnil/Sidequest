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
