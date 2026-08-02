import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  EVIDENCE_STORE_VERSION,
  canonicalSourceSchema,
  documentVersionSchema,
  evidenceClaimRecordSchema,
  extractionVersionSchema,
  isTransientDiscoveryOutcome,
  isUsableDigest,
  parsedDocumentSchema,
  researchAttemptKey,
  researchAttemptSchema,
  resolvedFactSchema,
  sourceDiscoveryRecordSchema,
  type CanonicalSource,
  type DocumentVersion,
  type EvidenceClaimRecord,
  type ExtractionVersion,
  type ParsedDocument,
  type ResearchAttempt,
  type ResolvedFact,
  type RetrievalObservation,
  type SourceDiscoveryRecord,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * THE SHARED EVIDENCE STORE, PERSISTED.
 *
 * Same discipline as every other repository here — **every read parses through
 * the schema rather than casting** — plus one rule this table set has and the
 * others do not:
 *
 *   **Nothing in this file is allowed to be load-bearing.**
 *
 * A compiled region carries its own copy of every fact it was built from, so a
 * corrupted row, a failed parse or an emptied table costs a compilation some
 * money and costs a stored trip nothing. Every read therefore degrades to "we do
 * not have that" rather than throwing, and a row that will not parse is deleted
 * on the way past.
 *
 * The second rule is the one an architecture test enforces: **no trip, no
 * traveller, no dates.** A fact about a museum is a fact about a museum.
 */

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface SourceRow {
  id: string;
  payload_json: string;
}

export function findSourceByCanonicalUrl(canonicalUrl: string): CanonicalSource | null {
  return readOne(
    'SELECT id, payload_json FROM evidence_sources WHERE canonical_url = ?',
    [canonicalUrl],
    canonicalSourceSchema.parse.bind(canonicalSourceSchema),
    (id) => deleteRow('evidence_sources', 'id', id),
  );
}

export function getSource(id: string): CanonicalSource | null {
  return readOne(
    'SELECT id, payload_json FROM evidence_sources WHERE id = ?',
    [id],
    canonicalSourceSchema.parse.bind(canonicalSourceSchema),
    (rowId) => deleteRow('evidence_sources', 'id', rowId),
  );
}

/**
 * Record a source, merging what we already knew.
 *
 * `first_seen_at` is never moved forward and relations are unioned rather than
 * replaced, because a later sighting of a page is new information *about* an
 * existing identity rather than a new identity. Overwriting would quietly lose
 * the mirror relationships that stop syndicated copies corroborating each other.
 */
export function upsertSource(source: CanonicalSource): CanonicalSource {
  const parsed = canonicalSourceSchema.parse(source);
  const existing = getSource(parsed.id);

  const merged: CanonicalSource = existing
    ? {
        ...existing,
        ...parsed,
        firstSeenAt: existing.firstSeenAt,
        identityWarnings: unique([...existing.identityWarnings, ...parsed.identityWarnings]).slice(0, 6),
        relations: dedupeRelations([...existing.relations, ...parsed.relations]),
      }
    : parsed;

  try {
    getDb()
      .prepare(
        `INSERT INTO evidence_sources
           (id, canonical_url, host, origin, publisher, authority, payload_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           publisher = excluded.publisher,
           authority = excluded.authority,
           payload_json = excluded.payload_json,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        merged.id,
        merged.canonicalUrl,
        merged.host,
        merged.origin,
        merged.publisher,
        merged.authority,
        JSON.stringify(merged),
        merged.firstSeenAt,
        merged.lastSeenAt,
      );
  } catch (error) {
    console.error('Could not record an evidence source', error);
  }
  return merged;
}

function dedupeRelations(
  relations: readonly CanonicalSource['relations'][number][],
): CanonicalSource['relations'] {
  const seen = new Map<string, CanonicalSource['relations'][number]>();
  for (const relation of relations) {
    seen.set(`${relation.relation}:${relation.otherSourceId}`, relation);
  }
  return [...seen.values()].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Document versions
// ---------------------------------------------------------------------------

/**
 * The newest usable version of a source's content.
 *
 * "Usable" excludes a digest this build cannot verify. An unknown hash algorithm
 * means "read it again", never "it matches" and never "it does not" — the third
 * option would be the same outcome by accident and the second would serve
 * evidence we cannot confirm is what we think it is.
 */
export function findLatestDocument(sourceId: string): DocumentVersion | null {
  const rows = getDb()
    .prepare(
      `SELECT id, payload_json FROM evidence_documents
        WHERE source_id = ? ORDER BY content_observed_at DESC LIMIT 5`,
    )
    .all(sourceId) as SourceRow[];

  for (const row of rows) {
    const parsed = parseRow(row, documentVersionSchema.parse.bind(documentVersionSchema), (id) =>
      deleteRow('evidence_documents', 'id', id),
    );
    if (parsed && isUsableDigest(parsed.contentDigest)) return parsed;
  }
  return null;
}

export function getDocument(id: string): DocumentVersion | null {
  return readOne(
    'SELECT id, payload_json FROM evidence_documents WHERE id = ?',
    [id],
    documentVersionSchema.parse.bind(documentVersionSchema),
    (rowId) => deleteRow('evidence_documents', 'id', rowId),
  );
}

/**
 * Store a document version.
 *
 * `INSERT OR IGNORE` on the content-addressed identity: the same bytes read
 * twice is the same version, and the second read must not overwrite the first's
 * `content_observed_at`. That timestamp is what fact freshness is computed from,
 * so moving it forward on a re-read of unchanged content would be the exact lie
 * this phase exists to prevent — the page has not changed, and pretending it just
 * did would make a year-old closure look current.
 */
export function saveDocument(document: DocumentVersion): DocumentVersion {
  const parsed = documentVersionSchema.parse(document);
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO evidence_documents
           (id, source_id, content_digest, status, content_bytes, truncated, etag,
            last_modified, vary, cache_control, content_observed_at, last_checked_at,
            published_at, retrieval_version, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.sourceId,
        parsed.contentDigest,
        parsed.status,
        parsed.representation.bytes,
        parsed.representation.truncated ? 1 : 0,
        parsed.validators.etag ?? null,
        parsed.validators.lastModified ?? null,
        parsed.validators.vary ?? null,
        parsed.validators.cacheControl ?? null,
        parsed.contentObservedAt,
        parsed.lastCheckedAt,
        parsed.publishedAt ?? null,
        parsed.retrievalVersion,
        JSON.stringify(parsed),
      );
  } catch (error) {
    console.error('Could not store a document version', error);
  }
  return getDocument(parsed.id) ?? parsed;
}

/**
 * Record that we looked again and nothing had changed.
 *
 * Two clocks, and only one of them moves. `last_checked_at` advances because we
 * genuinely checked; `content_observed_at` does not, because a `304` proves the
 * publisher says the representation is unchanged and proves nothing whatsoever
 * about whether the facts on it are still true. Conflating the two would let a
 * nightly revalidation keep a lifted closure alive indefinitely.
 */
export function recordRevalidation(input: {
  documentVersionId: string;
  checkedAt: string;
  /** When the site's robots policy was confirmed, if this request confirmed it. */
  robotsCheckedAt?: string;
  /** A 304 may carry refreshed validators; RFC 9110 says it must carry metadata. */
  validators?: Partial<DocumentVersion['validators']>;
}): DocumentVersion | null {
  const existing = getDocument(input.documentVersionId);
  if (!existing) return null;

  const next: DocumentVersion = {
    ...existing,
    lastCheckedAt: input.checkedAt,
    ...(input.robotsCheckedAt ? { robotsCheckedAt: input.robotsCheckedAt } : {}),
    validators: { ...existing.validators, ...(input.validators ?? {}) },
  };

  try {
    getDb()
      .prepare(
        `UPDATE evidence_documents
            SET last_checked_at = ?, etag = ?, last_modified = ?, vary = ?,
                cache_control = ?, payload_json = ?
          WHERE id = ?`,
      )
      .run(
        next.lastCheckedAt,
        next.validators.etag ?? null,
        next.validators.lastModified ?? null,
        next.validators.vary ?? null,
        next.validators.cacheControl ?? null,
        JSON.stringify(next),
        next.id,
      );
  } catch (error) {
    console.error('Could not record a revalidation', error);
  }
  return next;
}

export function recordRetrieval(observation: RetrievalObservation): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO evidence_retrievals
           (source_id, document_version_id, kind, status, observed_at, bytes, bytes_avoided, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.sourceId,
        observation.documentVersionId ?? null,
        observation.kind,
        observation.status,
        observation.observedAt,
        observation.bytes,
        observation.bytesAvoided,
        observation.detail ?? null,
      );
  } catch (error) {
    console.error('Could not record a retrieval observation', error);
  }
}

/**
 * How many observations to keep. A diagnostic trail, not an archive.
 *
 * Trimmed by the sweep rather than on every insert. The per-insert version cost
 * a full scan of the table for each observation recorded — which is O(n) work on
 * the hot path, in a synchronous driver, to bound a table nobody reads in a
 * request. One retrieval-heavy compilation ran that scan dozens of times and
 * blocked the event loop while it did.
 */
const MAX_RETRIEVAL_OBSERVATIONS = 5000;

// ---------------------------------------------------------------------------
// Parses
// ---------------------------------------------------------------------------

export function findParse(documentVersionId: string, parserVersion: string): ParsedDocument | null {
  return readOne(
    'SELECT document_version_id AS id, payload_json FROM evidence_parses WHERE document_version_id = ? AND parser_version = ?',
    [documentVersionId, parserVersion],
    parsedDocumentSchema.parse.bind(parsedDocumentSchema),
    () => {
      try {
        getDb()
          .prepare('DELETE FROM evidence_parses WHERE document_version_id = ? AND parser_version = ?')
          .run(documentVersionId, parserVersion);
      } catch {
        /* the read path already degrades correctly */
      }
    },
  );
}

export function saveParse(parse: ParsedDocument): void {
  const parsed = parsedDocumentSchema.parse(parse);
  try {
    getDb()
      .prepare(
        `INSERT INTO evidence_parses (document_version_id, parser_version, payload_json, parsed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(document_version_id, parser_version) DO UPDATE SET
           payload_json = excluded.payload_json, parsed_at = excluded.parsed_at`,
      )
      .run(parsed.documentVersionId, parsed.parserVersion, JSON.stringify(parsed), parsed.parsedAt);
  } catch (error) {
    console.error('Could not store a parsed document', error);
  }
}

// ---------------------------------------------------------------------------
// Extractions
// ---------------------------------------------------------------------------

/**
 * A previous extraction for exactly these inputs.
 *
 * Only a **succeeded** row is ever returned. A failure is kept so a retry storm
 * is visible and bounded, and is never served as an answer — and because a later
 * success overwrites it, failing closed does not mean failing forever.
 */
export function findExtraction(key: string): ExtractionVersion | null {
  const found = readOne(
    'SELECT key AS id, payload_json FROM evidence_extractions WHERE key = ?',
    [key],
    extractionVersionSchema.parse.bind(extractionVersionSchema),
    (id) => deleteRow('evidence_extractions', 'key', id),
  );
  if (!found) return null;
  return found.status === 'succeeded' ? found : null;
}

/** The failure record for a key, so a caller can bound its own retries. */
export function findExtractionAttempt(key: string): ExtractionVersion | null {
  return readOne(
    'SELECT key AS id, payload_json FROM evidence_extractions WHERE key = ?',
    [key],
    extractionVersionSchema.parse.bind(extractionVersionSchema),
    (id) => deleteRow('evidence_extractions', 'key', id),
  );
}

export function saveExtraction(extraction: ExtractionVersion): void {
  const parsed = extractionVersionSchema.parse(extraction);
  try {
    getDb()
      .prepare(
        `INSERT INTO evidence_extractions
           (key, operation, status, schema_version, prompt_version, model_id, parser_version,
            input_tokens, output_tokens, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           status = excluded.status,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at`,
      )
      .run(
        parsed.key,
        parsed.inputs.operation,
        parsed.status,
        parsed.inputs.schemaVersion,
        parsed.inputs.promptVersion,
        parsed.inputs.modelId,
        parsed.inputs.parserVersion,
        parsed.tokens.input,
        parsed.tokens.output,
        JSON.stringify(parsed),
        parsed.createdAt,
      );
  } catch (error) {
    console.error('Could not store an extraction', error);
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export function findClaims(subjectKey: string): EvidenceClaimRecord[] {
  return findClaimsFor([subjectKey]).get(subjectKey) ?? [];
}

/**
 * Every durable claim held about these subjects, in one query.
 *
 * One statement rather than one per subject: a compilation asks about thirty
 * subjects at once, and thirty round trips through a synchronous driver is
 * thirty stalls of the event loop for no reason.
 *
 * Superseded rows come back too. The caller drops them from resolution — the
 * store keeps them because an artifact compiled last month quotes their ids.
 */
export function findClaimsFor(
  subjectKeys: readonly string[],
): Map<string, EvidenceClaimRecord[]> {
  const byKey = new Map<string, EvidenceClaimRecord[]>();
  if (subjectKeys.length === 0) return byKey;

  try {
    const unique = [...new Set(subjectKeys)];
    /**
     * Chunked, because SQLite refuses a statement with more than 999 bound
     * parameters and a broad city legitimately researches more subjects than a
     * small number.
     */
    for (let start = 0; start < unique.length; start += 400) {
      const chunk = unique.slice(start, start + 400);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = getDb()
        .prepare(
          `SELECT id, payload_json FROM evidence_claims
            WHERE subject_key IN (${placeholders})
            ORDER BY last_seen_at DESC LIMIT 2000`,
        )
        .all(...chunk) as SourceRow[];

      for (const row of rows) {
        const parsed = parseRow(
          row,
          evidenceClaimRecordSchema.parse.bind(evidenceClaimRecordSchema),
          (id) => deleteRow('evidence_claims', 'id', id),
        );
        if (!parsed) continue;
        byKey.set(parsed.subjectKey, [...(byKey.get(parsed.subjectKey) ?? []), parsed]);
      }
    }
  } catch (error) {
    console.error('Could not read evidence claims', error);
  }
  return byKey;
}

/**
 * Mark claims a newer observation replaced.
 *
 * An update rather than a delete, and the distinction is the whole point: an
 * artifact built last month names a fact id, and that fact must stay explicable
 * after the world moved on. What supersession buys is that the *resolver* stops
 * seeing it, not that it stops existing.
 */
export function markClaimsSuperseded(ids: readonly string[], now: Date): number {
  if (ids.length === 0) return 0;
  try {
    const db = getDb();
    const update = db.prepare(
      `UPDATE evidence_claims
          SET superseded = 1,
              payload_json = json_set(payload_json, '$.superseded', json('true')),
              last_seen_at = ?
        WHERE id = ? AND superseded = 0`,
    );
    let changed = 0;
    db.transaction(() => {
      for (const id of ids) changed += update.run(now.toISOString(), id).changes;
    })();
    return changed;
  } catch (error) {
    console.error('Could not supersede evidence claims', error);
    return 0;
  }
}

/**
 * Record what was observed.
 *
 * `ON CONFLICT … DO UPDATE SET last_seen_at` is the anti-duplication rule made
 * concrete: a claim's id is a hash of its subject, its question, the bytes it
 * came from, the contract that read them and its normalised answer, so
 * re-reading an unchanged page under an unchanged contract lands on the row that
 * is already there and moves one timestamp. `first_seen_at` never moves — a
 * second sighting is new information *about* an existing claim, not a new one.
 */
export function saveClaims(claims: readonly EvidenceClaimRecord[]): void {
  if (claims.length === 0) return;
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO evidence_claims
       (id, subject_key, fact_path, source_id, document_version_id, content_digest,
        extraction_key, origin, payload_json, first_seen_at, last_seen_at, supersedes_claim_id,
        superseded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at`,
  );

  try {
    db.transaction(() => {
      for (const claim of claims) {
        const parsed = evidenceClaimRecordSchema.parse(claim);
        insert.run(
          parsed.id,
          parsed.subjectKey,
          parsed.factPath,
          parsed.sourceId,
          parsed.documentVersionId,
          parsed.contentDigest,
          parsed.extractionKey ?? null,
          parsed.origin,
          JSON.stringify(parsed),
          parsed.firstSeenAt,
          parsed.lastSeenAt,
          parsed.supersedesClaimId ?? null,
          parsed.superseded ? 1 : 0,
        );
      }
    })();
  } catch (error) {
    console.error('Could not store evidence claims', error);
  }
}

// ---------------------------------------------------------------------------
// Research attempts
// ---------------------------------------------------------------------------

/** Attempts already made for these subjects, by `researchAttemptKey`. */
export function findAttempts(subjectKeys: readonly string[]): Map<string, ResearchAttempt> {
  const found = new Map<string, ResearchAttempt>();
  if (subjectKeys.length === 0) return found;
  try {
    const unique = [...new Set(subjectKeys)];
    for (let start = 0; start < unique.length; start += 400) {
      const chunk = unique.slice(start, start + 400);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = getDb()
        .prepare(
          `SELECT key AS id, payload_json FROM evidence_research_attempts
            WHERE subject_key IN (${placeholders})`,
        )
        .all(...chunk) as SourceRow[];
      for (const row of rows) {
        const parsed = parseRow(row, researchAttemptSchema.parse.bind(researchAttemptSchema), (id) =>
          deleteRow('evidence_research_attempts', 'key', id),
        );
        if (parsed) found.set(row.id, parsed);
      }
    }
  } catch (error) {
    console.error('Could not read research attempts', error);
  }
  return found;
}

/**
 * Record that we looked.
 *
 * Replaced rather than appended: what matters is *when we last asked*, and a
 * history of asking is not something anybody would read.
 */
export function saveAttempts(attempts: readonly ResearchAttempt[]): void {
  if (attempts.length === 0) return;
  try {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO evidence_research_attempts
         (key, subject_key, contract, payload_json, attempted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         payload_json = excluded.payload_json,
         attempted_at = excluded.attempted_at`,
    );
    db.transaction(() => {
      for (const attempt of attempts) {
        const parsed = researchAttemptSchema.parse(attempt);
        insert.run(
          researchAttemptKey(parsed),
          parsed.subjectKey,
          parsed.contract,
          JSON.stringify(parsed),
          parsed.attemptedAt,
        );
      }
    })();
  } catch (error) {
    console.error('Could not record research attempts', error);
  }
}

// ---------------------------------------------------------------------------
// Resolved fact sets
// ---------------------------------------------------------------------------

/**
 * Answers resolved once, for questions whose answer is the same for everybody.
 *
 * Keyed on the exact claim set behind the answer, so a new claim mints a new key
 * and a stale answer cannot be served for a set that has since grown. Nothing
 * dated reaches this table — the allow-list is in `CONTEXT_INDEPENDENT_PATHS`
 * and it is closed.
 */
export function findFactSets(keys: readonly string[]): Map<string, ResolvedFact> {
  const found = new Map<string, ResolvedFact>();
  if (keys.length === 0) return found;
  try {
    const unique = [...new Set(keys)];
    for (let start = 0; start < unique.length; start += 400) {
      const chunk = unique.slice(start, start + 400);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = getDb()
        .prepare(
          `SELECT key AS id, payload_json FROM evidence_fact_sets WHERE key IN (${placeholders})`,
        )
        .all(...chunk) as SourceRow[];
      for (const row of rows) {
        const parsed = parseRow(row, resolvedFactSchema.parse.bind(resolvedFactSchema), (id) =>
          deleteRow('evidence_fact_sets', 'key', id),
        );
        if (parsed) found.set(row.id, parsed);
      }
    }
  } catch (error) {
    console.error('Could not read resolved fact sets', error);
  }
  return found;
}

export function saveFactSets(
  entries: readonly { key: string; subjectKey: string; resolved: ResolvedFact }[],
  now: Date,
): void {
  if (entries.length === 0) return;
  try {
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO evidence_fact_sets (key, subject_key, fact_path, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    );
    db.transaction(() => {
      for (const entry of entries) {
        const parsed = resolvedFactSchema.parse(entry.resolved);
        insert.run(
          entry.key,
          entry.subjectKey,
          parsed.factPath,
          JSON.stringify(parsed),
          now.toISOString(),
        );
      }
    })();
  } catch (error) {
    console.error('Could not store resolved fact sets', error);
  }
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

export function findDiscovery(key: string, now: Date): SourceDiscoveryRecord | null {
  const record = readOne(
    'SELECT key AS id, payload_json FROM evidence_discovery WHERE key = ?',
    [key],
    sourceDiscoveryRecordSchema.parse.bind(sourceDiscoveryRecordSchema),
    (id) => deleteRow('evidence_discovery', 'key', id),
  );
  if (!record) return null;
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    deleteRow('evidence_discovery', 'key', key);
    return null;
  }
  return record;
}

/** How long each kind of discovery answer is worth keeping. */
const DISCOVERY_TTL_MS = {
  /** A found page is stable; the URL of a museum does not move weekly. */
  found: 30 * 24 * 60 * 60 * 1000,
  /** A genuine absence is durable too — but shorter, so a new site is found. */
  absent: 7 * 24 * 60 * 60 * 1000,
  /**
   * A provider that was down is not evidence about the world.
   *
   * Minutes, not days. Caching an outage as "nobody publishes this" is how a
   * five-minute incident becomes a permanent hole in a destination's coverage.
   */
  transient: 10 * 60 * 1000,
} as const;

export function saveDiscovery(input: {
  record: Omit<SourceDiscoveryRecord, 'schemaVersion' | 'expiresAt'>;
  now: Date;
}): SourceDiscoveryRecord {
  const ttl = isTransientDiscoveryOutcome(input.record.outcome)
    ? DISCOVERY_TTL_MS.transient
    : input.record.outcome === 'found'
      ? DISCOVERY_TTL_MS.found
      : DISCOVERY_TTL_MS.absent;

  const parsed = sourceDiscoveryRecordSchema.parse({
    ...input.record,
    schemaVersion: EVIDENCE_STORE_VERSION,
    expiresAt: new Date(input.now.getTime() + ttl).toISOString(),
  });

  try {
    getDb()
      .prepare(
        `INSERT INTO evidence_discovery (key, outcome, provider, payload_json, discovered_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           outcome = excluded.outcome,
           provider = excluded.provider,
           payload_json = excluded.payload_json,
           discovered_at = excluded.discovered_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        parsed.key,
        parsed.outcome,
        parsed.provider,
        JSON.stringify(parsed),
        parsed.discoveredAt,
        parsed.expiresAt,
      );
  } catch (error) {
    console.error('Could not store a source-discovery result', error);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Operation coalescing
// ---------------------------------------------------------------------------

/**
 * How long a claimed operation may go silent before another build may take it.
 *
 * Shorter than a compilation's own heartbeat timeout because these are single
 * network calls rather than whole pipelines: a fetch that has said nothing for
 * twenty seconds is a fetch whose process is gone.
 */
export const OPERATION_HEARTBEAT_TIMEOUT_MS = 20_000;

export type OperationClaim =
  | { kind: 'claimed'; id: string }
  | { kind: 'in_progress'; id: string; startedAt: string };

/**
 * Claim an operation, or discover somebody else already has it.
 *
 * The unique partial index does the work — two processes, two tabs and a retry
 * racing the original all resolve to one winner and the losers wait rather than
 * paying again. An in-memory promise map cannot do this: it dies with the
 * process and does not span two web instances.
 *
 * A stale claim is reclaimed rather than respected, so a killed process cannot
 * wedge a URL forever. That is the same trade `compilation_jobs` makes and for
 * the same reason.
 */
export function claimOperation(operationKey: string, now: Date): OperationClaim {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, started_at, heartbeat_at FROM evidence_operations
        WHERE operation_key = ? AND state = 'running' LIMIT 1`,
    )
    .get(operationKey) as { id: string; started_at: string; heartbeat_at: string } | undefined;

  if (existing) {
    const beat = Date.parse(existing.heartbeat_at);
    const abandoned = Number.isNaN(beat) || now.getTime() - beat > OPERATION_HEARTBEAT_TIMEOUT_MS;
    if (!abandoned) {
      return { kind: 'in_progress', id: existing.id, startedAt: existing.started_at };
    }
    try {
      db.prepare(
        `UPDATE evidence_operations
            SET state = 'abandoned', finished_at = ?, detail = 'The process holding this stopped answering.'
          WHERE id = ?`,
      ).run(now.toISOString(), existing.id);
    } catch {
      /* another process may have just reclaimed it; the insert below decides */
    }
  }

  const id = randomUUID();
  const stamp = now.toISOString();
  try {
    db.prepare(
      `INSERT INTO evidence_operations
         (operation_key, id, state, owner, started_at, heartbeat_at)
       VALUES (?, ?, 'running', ?, ?, ?)`,
    ).run(operationKey, id, `${process.pid}`, stamp, stamp);
    return { kind: 'claimed', id };
  } catch {
    const winner = db
      .prepare(
        `SELECT id, started_at FROM evidence_operations
          WHERE operation_key = ? AND state = 'running' LIMIT 1`,
      )
      .get(operationKey) as { id: string; started_at: string } | undefined;
    if (winner) return { kind: 'in_progress', id: winner.id, startedAt: winner.started_at };
    // Nobody holds it and we could not take it: proceed alone rather than
    // failing. Duplicated work is a cost; a stalled compilation is a defect.
    return { kind: 'claimed', id };
  }
}

export function heartbeatOperation(id: string, now: Date): void {
  try {
    getDb()
      .prepare('UPDATE evidence_operations SET heartbeat_at = ? WHERE id = ?')
      .run(now.toISOString(), id);
  } catch {
    /* a heartbeat that fails is not worth failing the operation for */
  }
}

export function completeOperation(input: {
  id: string;
  now: Date;
  state: 'done' | 'failed';
  resultRef?: string;
  detail?: string;
}): void {
  try {
    getDb()
      .prepare(
        `UPDATE evidence_operations
            SET state = ?, finished_at = ?, result_ref = ?, detail = ?
          WHERE id = ?`,
      )
      .run(
        input.state,
        input.now.toISOString(),
        input.resultRef ?? null,
        input.detail ?? null,
        input.id,
      );
  } catch (error) {
    console.error('Could not close an evidence operation', error);
  }
}

/**
 * Wait for whoever holds this operation to finish, then read what they produced.
 *
 * Bounded, and it returns `null` on a timeout rather than throwing: the caller's
 * fallback is to do the work itself, which is correct — a slow peer should cost
 * a duplicate call, never a failed compilation.
 */
export async function awaitOperation(input: {
  operationKey: string;
  timeoutMs: number;
  now: () => Date;
  pollMs?: number;
}): Promise<'completed' | 'timed_out'> {
  const deadline = Date.now() + input.timeoutMs;
  const poll = input.pollMs ?? 150;
  while (Date.now() < deadline) {
    const row = getDb()
      .prepare(
        `SELECT state, heartbeat_at FROM evidence_operations
          WHERE operation_key = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(input.operationKey) as { state: string; heartbeat_at: string } | undefined;
    if (!row || row.state !== 'running') return 'completed';
    const beat = Date.parse(row.heartbeat_at);
    if (Number.isNaN(beat) || input.now().getTime() - beat > OPERATION_HEARTBEAT_TIMEOUT_MS) {
      return 'timed_out';
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
  return 'timed_out';
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface CleanupPlan {
  discoveryExpired: number;
  operationsSettled: number;
  observationsTrimmed: number;
  documentsSuperseded: number;
  parsesOrphaned: number;
  claimsOrphaned: number;
  /** Replaced, unquoted by any artifact, and past the tracing window. */
  claimsSuperseded: number;
  /** Answers whose claim set no longer exists, so the key can never match again. */
  factSetsStale: number;
  /** Records of looking at subjects we no longer hold anything about. */
  attemptsStale: number;
  extractionsOrphaned: number;
  sourcesOrphaned: number;
}

/**
 * How many versions of one document to keep.
 *
 * Two, for the same reason `region_packs` keeps two: an artifact compiled last
 * week names the version it was built from, and being able to answer "what
 * changed" requires the previous one to still exist.
 */
const DOCUMENT_VERSIONS_PER_SOURCE = 2;

/** Extractions older than this with nothing referring to them are dead weight. */
const EXTRACTION_RETENTION_DAYS = 120;

/**
 * Sweep the store, or report what a sweep would remove.
 *
 * Reference-aware, and the reference that matters is a **claim**: a claim names
 * its document version and its extraction, and a compiled artifact quotes the
 * claim. So anything a live claim points at survives, whatever its age. Nothing
 * here can delete evidence a persisted plan needs, because a persisted plan does
 * not read this store at all — it carries its own copy — and the sweep still
 * respects the chain so that *explaining* an old plan stays possible.
 */
export function sweepEvidenceStore(options: { dryRun: boolean; now: Date }): CleanupPlan {
  const db = getDb();
  const plan: CleanupPlan = {
    discoveryExpired: 0,
    operationsSettled: 0,
    observationsTrimmed: 0,
    documentsSuperseded: 0,
    parsesOrphaned: 0,
    claimsOrphaned: 0,
    claimsSuperseded: 0,
    factSetsStale: 0,
    attemptsStale: 0,
    extractionsOrphaned: 0,
    sourcesOrphaned: 0,
  };

  const stamp = options.now.toISOString();
  const cutoff = new Date(
    options.now.getTime() - EXTRACTION_RETENTION_DAYS * 86_400_000,
  ).toISOString();

  const count = (sql: string, params: unknown[] = []): number => {
    const row = db.prepare(sql).get(...(params as [])) as { n: number } | undefined;
    return row?.n ?? 0;
  };

  try {
    // 1. Expired negative caches and settled operation rows.
    plan.discoveryExpired = count(
      'SELECT COUNT(*) AS n FROM evidence_discovery WHERE expires_at <= ?',
      [stamp],
    );
    plan.operationsSettled = count(
      `SELECT COUNT(*) AS n FROM evidence_operations WHERE state <> 'running'`,
    );
    plan.observationsTrimmed = Math.max(
      0,
      count('SELECT COUNT(*) AS n FROM evidence_retrievals') - MAX_RETRIEVAL_OBSERVATIONS,
    );

    // 2. Document versions past the per-source keep count, excluding any a claim
    //    still points at. A superseded version nothing refers to is dead weight;
    //    one a claim quotes is the evidence behind a fact somebody can read.
    const supersededDocs = `
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY source_id ORDER BY content_observed_at DESC
        ) AS rank FROM evidence_documents
      ) WHERE rank > ${DOCUMENT_VERSIONS_PER_SOURCE}
        AND id NOT IN (SELECT document_version_id FROM evidence_claims)`;
    plan.documentsSuperseded = count(`SELECT COUNT(*) AS n FROM (${supersededDocs})`);

    // 3. Rows whose parent is gone.
    plan.parsesOrphaned = count(
      `SELECT COUNT(*) AS n FROM evidence_parses
        WHERE document_version_id NOT IN (SELECT id FROM evidence_documents)`,
    );
    plan.claimsOrphaned = count(
      `SELECT COUNT(*) AS n FROM evidence_claims
        WHERE document_version_id NOT IN (SELECT id FROM evidence_documents)`,
    );
    /**
     * Superseded claims nobody quotes, past the window in which anybody would
     * trace them.
     *
     * Three conditions, and all three are load-bearing. **Superseded**, because a
     * live claim is current evidence. **Unquoted**, because an artifact naming a
     * fact should be traceable back to the claim it came from — that is what
     * `compiled_region_claims` is for, and it makes the rule exact rather than a
     * guess about age. **Old**, because a claim replaced this morning is exactly
     * the one somebody is about to ask about.
     */
    const supersededClaims = `
      SELECT id FROM evidence_claims
       WHERE superseded = 1
         AND last_seen_at < '${cutoff}'
         AND id NOT IN (SELECT claim_id FROM compiled_region_claims)`;
    plan.claimsSuperseded = count(`SELECT COUNT(*) AS n FROM (${supersededClaims})`);

    /**
     * A shared answer whose claim set has gone.
     *
     * The key is a hash of the claims behind it, so once they are deleted the
     * key can never be recomputed and the row is unreachable rather than merely
     * stale. Removed on that basis, not on age.
     */
    const staleFactSets = `
      SELECT key FROM evidence_fact_sets
       WHERE subject_key NOT IN (SELECT subject_key FROM evidence_claims)`;
    plan.factSetsStale = count(`SELECT COUNT(*) AS n FROM (${staleFactSets})`);

    /** An attempt about a subject we hold nothing for is a record of nothing. */
    const staleAttempts = `
      SELECT key FROM evidence_research_attempts
       WHERE attempted_at < '${cutoff}'
         AND subject_key NOT IN (SELECT subject_key FROM evidence_claims)`;
    plan.attemptsStale = count(`SELECT COUNT(*) AS n FROM (${staleAttempts})`);

    plan.extractionsOrphaned = count(
      `SELECT COUNT(*) AS n FROM evidence_extractions
        WHERE created_at < ? AND key NOT IN
          (SELECT extraction_key FROM evidence_claims WHERE extraction_key IS NOT NULL)`,
      [cutoff],
    );
    plan.sourcesOrphaned = count(
      `SELECT COUNT(*) AS n FROM evidence_sources
        WHERE id NOT IN (SELECT source_id FROM evidence_documents)
          AND id NOT IN (SELECT source_id FROM evidence_claims)
          AND last_seen_at < ?`,
      [cutoff],
    );

    if (options.dryRun) return plan;

    db.transaction(() => {
      db.prepare('DELETE FROM evidence_discovery WHERE expires_at <= ?').run(stamp);
      db.prepare(`DELETE FROM evidence_operations WHERE state <> 'running'`).run();
      db.prepare(
        `DELETE FROM evidence_retrievals WHERE id IN (
           SELECT id FROM evidence_retrievals ORDER BY id DESC LIMIT -1 OFFSET ?)`,
      ).run(MAX_RETRIEVAL_OBSERVATIONS);
      db.prepare(`DELETE FROM evidence_documents WHERE id IN (${supersededDocs})`).run();
      db.prepare(
        `DELETE FROM evidence_parses
          WHERE document_version_id NOT IN (SELECT id FROM evidence_documents)`,
      ).run();
      /**
       * Claims whose document is gone, but never one an artifact quotes.
       *
       * A stored plan carries its own copy of every fact, so removing a claim
       * cannot break it — what it breaks is tracing a fact on somebody's
       * itinerary back to the page behind it, and that is worth keeping.
       */
      db.prepare(
        `DELETE FROM evidence_claims
          WHERE document_version_id NOT IN (SELECT id FROM evidence_documents)
            AND id NOT IN (SELECT claim_id FROM compiled_region_claims)`,
      ).run();
      db.prepare(`DELETE FROM evidence_claims WHERE id IN (${supersededClaims})`).run();
      db.prepare(`DELETE FROM evidence_fact_sets WHERE key IN (${staleFactSets})`).run();
      db.prepare(
        `DELETE FROM evidence_research_attempts WHERE key IN (${staleAttempts})`,
      ).run();
      db.prepare(
        `DELETE FROM evidence_extractions
          WHERE created_at < ? AND key NOT IN
            (SELECT extraction_key FROM evidence_claims WHERE extraction_key IS NOT NULL)`,
      ).run(cutoff);
      db.prepare(
        `DELETE FROM evidence_sources
          WHERE id NOT IN (SELECT source_id FROM evidence_documents)
            AND id NOT IN (SELECT source_id FROM evidence_claims)
            AND last_seen_at < ?`,
      ).run(cutoff);
    })();
  } catch (error) {
    console.error('Could not sweep the evidence store', error);
  }

  return plan;
}

export interface EvidenceStoreSize {
  sources: number;
  documents: number;
  parses: number;
  extractions: number;
  claims: number;
  liveClaims: number;
  factSets: number;
  discovery: number;
  bytes: number;
}

/**
 * Whether the store is big enough to be worth sweeping.
 *
 * `better-sqlite3` is synchronous, so a sweep runs on the event loop and every
 * request behind it waits. Sweeping after every compilation put a growing pile
 * of `NOT IN` subqueries on that loop for a store that had barely grown — so it
 * is now checked with one indexed count and skipped almost always.
 */
export function evidenceStoreNeedsSweep(): boolean {
  try {
    const row = getDb()
      .prepare('SELECT COUNT(*) AS n FROM evidence_documents')
      .get() as { n: number } | undefined;
    return (row?.n ?? 0) > SWEEP_THRESHOLD_DOCUMENTS;
  } catch {
    return false;
  }
}

/** Below this the store is not costing anything worth an event-loop stall. */
const SWEEP_THRESHOLD_DOCUMENTS = 200;

/** Table counts and approximate payload size, for the technical panel. */
export function evidenceStoreSize(): EvidenceStoreSize {
  const db = getDb();
  const one = (sql: string): number => {
    try {
      return (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
    } catch {
      return 0;
    }
  };
  return {
    sources: one('SELECT COUNT(*) AS n FROM evidence_sources'),
    documents: one('SELECT COUNT(*) AS n FROM evidence_documents'),
    parses: one('SELECT COUNT(*) AS n FROM evidence_parses'),
    extractions: one('SELECT COUNT(*) AS n FROM evidence_extractions'),
    claims: one('SELECT COUNT(*) AS n FROM evidence_claims'),
    liveClaims: one('SELECT COUNT(*) AS n FROM evidence_claims WHERE superseded = 0'),
    factSets: one('SELECT COUNT(*) AS n FROM evidence_fact_sets'),
    discovery: one('SELECT COUNT(*) AS n FROM evidence_discovery'),
    bytes:
      one('SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS n FROM evidence_documents') +
      one('SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS n FROM evidence_extractions') +
      one('SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS n FROM evidence_claims'),
  };
}

// ---------------------------------------------------------------------------
// Shared read discipline
// ---------------------------------------------------------------------------

function readOne<T>(
  sql: string,
  params: readonly unknown[],
  parse: (value: unknown) => T,
  onCorrupt: (id: string) => void,
): T | null {
  try {
    const row = getDb().prepare(sql).get(...(params as [])) as SourceRow | undefined;
    if (!row) return null;
    return parseRow(row, parse, onCorrupt);
  } catch (error) {
    console.error('Could not read from the evidence store', error);
    return null;
  }
}

/**
 * Parse one row, and remove it if it will not parse.
 *
 * A corrupted or version-drifted row is treated as absent rather than fatal, and
 * deleted so it stops costing a parse attempt on every read. This is the property
 * that keeps one bad row from corrupting unrelated evidence: nothing here reads
 * across rows, so a failure is contained to the row it is in.
 */
function parseRow<T>(
  row: SourceRow,
  parse: (value: unknown) => T,
  onCorrupt: (id: string) => void,
): T | null {
  try {
    return parse(JSON.parse(row.payload_json));
  } catch {
    onCorrupt(row.id);
    return null;
  }
}

function deleteRow(table: string, column: string, value: string): void {
  try {
    getDb().prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value);
  } catch {
    /* the read path already degrades correctly */
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
