import 'server-only';
import {
  IMAGERY_RETRY_REJECTED_DAYS,
  IMAGERY_REVALIDATE_DAYS,
  imageryOutcomeSchema,
  imagerySubjectKey,
  type DestinationImage,
  type ImageryOutcome,
  type ImageSubject,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * IMAGERY METADATA, PERSISTED — AND THE READ PATH THE RENDER USES.
 *
 * Two properties this file exists to hold, and both of them are about *when*
 * work happens rather than about SQL.
 *
 * **Nothing here reaches a network.** A page render calls `acceptedImagesFor`
 * and gets rows or nothing. Resolving an image identity is somebody else's job,
 * done once, in a server action or during compilation — because a render that
 * could fetch is a render that fetches on every back button, on every refresh,
 * and once per card on a board of forty.
 *
 * **Nothing here is load-bearing.** The same rule the evidence store follows: a
 * corrupted row, a failed parse or an emptied table costs a page its photograph
 * and costs a stored trip nothing. Every read degrades to "we do not have that",
 * and a row that will not parse is deleted on the way past rather than left to
 * fail the next render too.
 *
 * The table is **traveller-independent** and deliberately not keyed on a trip. A
 * photograph of a mountain is a photograph of a mountain: two people planning
 * the same place share one lookup, one licence check and one obligation.
 */

interface Row {
  subject_key: string;
  file_title: string;
  accepted: number;
  payload_json: string;
  retrieved_at: string;
  revalidate_after: string;
}

/**
 * A stored outcome, plus whether it is old enough to be worth re-checking.
 *
 * `staleness` is separate from the record because it is a fact about *now* and
 * the record is a fact about the past. A caller deciding whether to spend a
 * request needs both; a caller rendering a page needs only the first and must
 * not be handed a reason to go and do something about the second.
 */
export interface StoredImagery {
  outcome: ImageryOutcome;
  retrievedAt: string;
  /** True once `revalidate_after` has passed. Never blocks a render. */
  dueForRevalidation: boolean;
}

/**
 * A stored row, or nothing. **Never a write.**
 *
 * This used to `DELETE` any row it could not parse, and it is reached from two
 * page renders. One version bump would therefore have issued up to forty
 * synchronous deletes on the first paint of a board — on a synchronous driver,
 * blocking the event loop, contending with any compilation in flight — which is
 * exactly the class of render-time work the rest of this phase removed.
 *
 * An unreadable row now reads as absent and is left where it is. The write path
 * already upserts on the primary key, so a stale row is overwritten by the next
 * resolution rather than blocking it, and the sweep is where reclaiming space
 * belongs.
 */
function parseRow(row: Row, now: Date): StoredImagery | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  const parsed = imageryOutcomeSchema.safeParse(payload);
  if (!parsed.success) return null;
  return {
    outcome: parsed.data,
    retrievedAt: row.retrieved_at,
    dueForRevalidation: row.revalidate_after <= now.toISOString(),
  };
}

/**
 * The title a refusal is stored under when there was no file to name.
 *
 * The primary key is `(subject_key, file_title)`, so a subject we looked for and
 * found nothing at all for still needs a row — otherwise "we looked and there
 * was nothing" is indistinguishable from "nobody has looked", and every build
 * re-looks. A sentinel rather than an empty string, because an empty string in a
 * key column reads as a bug to everybody who later opens the table.
 */
const NO_FILE = '(no file)';

function rowKeyFor(outcome: ImageryOutcome): string {
  return outcome.status === 'accepted'
    ? outcome.image.fileTitle
    : (outcome.rejection.fileTitle ?? NO_FILE);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Store what a resolution decided — acceptance or refusal, both of them.
 *
 * Storing refusals is the point of the table as much as storing acceptances. A
 * file refused for its licence that is not written down is a file every
 * subsequent build fetches, checks and refuses again: wasted volunteer bandwidth
 * on their side, an unexplained absence on ours, and a request budget spent on
 * an answer we already had.
 *
 * A transient outage is the one thing that is **not** written. `provider_unavailable`
 * is a fact about this minute; persisting it for ninety days would mean one bad
 * afternoon costing a destination its photograph until somebody noticed.
 */
export function saveImageryOutcome(outcome: ImageryOutcome, now: Date): void {
  if (outcome.status === 'rejected' && outcome.rejection.reason === 'provider_unavailable') return;

  const subject = outcome.status === 'accepted' ? outcome.image.subject : outcome.rejection.subject;
  const key = imagerySubjectKey(subject);
  const days = outcome.status === 'accepted' ? IMAGERY_REVALIDATE_DAYS : IMAGERY_RETRY_REJECTED_DAYS;
  const revalidateAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  try {
    getDb()
      .prepare(
        `INSERT INTO destination_images
           (subject_key, file_title, schema_version, provider, accepted, rejected_reason,
            licence_id, payload_json, retrieved_at, revalidate_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_key, file_title) DO UPDATE SET
           schema_version = excluded.schema_version,
           provider = excluded.provider,
           accepted = excluded.accepted,
           rejected_reason = excluded.rejected_reason,
           licence_id = excluded.licence_id,
           payload_json = excluded.payload_json,
           retrieved_at = excluded.retrieved_at,
           revalidate_after = excluded.revalidate_after`,
      )
      .run(
        key,
        rowKeyFor(outcome),
        outcome.status === 'accepted' ? outcome.image.schemaVersion : outcome.rejection.schemaVersion,
        outcome.status === 'accepted' ? outcome.image.provider : outcome.rejection.provider,
        outcome.status === 'accepted' ? 1 : 0,
        outcome.status === 'accepted' ? null : outcome.rejection.reason,
        outcome.status === 'accepted' ? outcome.image.licenceId : null,
        JSON.stringify(outcome),
        outcome.status === 'accepted' ? outcome.image.retrievedAt : outcome.rejection.retrievedAt,
        revalidateAfter,
      );
  } catch (error) {
    /*
     * Never fatal. Failing to cache a photograph must not fail the action that
     * happened to be resolving one — a shortlist that could not be saved because
     * an image row would not write would be an absurd way to lose somebody's
     * afternoon of answers.
     */
    console.error('Could not store imagery metadata', { key, error });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Everything stored for these subjects, keyed by subject key.
 *
 * Batched by design. The shortlist asks about eight destinations and the board
 * about forty candidates, and a per-card read is how a page acquires forty
 * queries nobody notices until the table is large.
 */
export function storedImageryFor(subjectKeys: readonly string[], now: Date): Map<string, StoredImagery> {
  const found = new Map<string, StoredImagery>();
  const unique = [...new Set(subjectKeys)].filter((key) => key.length > 0);
  if (unique.length === 0) return found;

  try {
    const placeholders = unique.map(() => '?').join(',');
    const rows = getDb()
      .prepare(
        `SELECT subject_key, file_title, accepted, payload_json, retrieved_at, revalidate_after
           FROM destination_images
          WHERE subject_key IN (${placeholders})
          ORDER BY accepted DESC, retrieved_at DESC`,
      )
      .all(...unique) as Row[];

    for (const row of rows) {
      // Ordered acceptances first, so a subject with both a stored acceptance
      // and an older refusal resolves to the picture rather than to the excuse.
      if (found.has(row.subject_key)) continue;
      const parsed = parseRow(row, now);
      if (parsed) found.set(row.subject_key, parsed);
    }
  } catch (error) {
    console.error('Could not read imagery metadata', { error });
  }
  return found;
}

/**
 * The render-path read: subject key to displayable image, and nothing else.
 *
 * Returns only acceptances. A refusal is operational history and has no business
 * reaching a component — a component handed "this exists but you may not show
 * it" is a component with a branch that will eventually show it.
 */
export function acceptedImagesFor(
  subjects: readonly Pick<ImageSubject, 'kind' | 'id' | 'wikidataId'>[],
  now: Date = new Date(),
): Record<string, DestinationImage> {
  const byKey = storedImageryFor(subjects.map(imagerySubjectKey), now);
  const images: Record<string, DestinationImage> = {};
  for (const subject of subjects) {
    const stored = byKey.get(imagerySubjectKey(subject));
    /*
     * Past its revalidation date is past its licence check, so it does not
     * render.
     *
     * The thirty-day window was bounding the *cache* and not the *display*: a
     * subject resolved once during a compilation was never resolved again, so a
     * file Commons later deleted as a copyright violation kept being shown, under
     * a credit asserting a licence that had been found never to exist. The
     * fallback graphic is a designed object, so degrading costs a photograph and
     * nothing else, and the next resolution re-checks.
     */
    if (stored?.outcome.status === 'accepted' && !stored.dueForRevalidation) {
      images[subject.id] = stored.outcome.image;
    }
  }
  return images;
}

/**
 * The cache interface the provider takes, backed by the table.
 *
 * The store *is* the cache — there is no second in-memory layer, because the
 * expensive thing was never the round trip. It is asking a volunteer-run service
 * a question somebody already answered and wrote down.
 *
 * A record past its revalidation date is treated as a miss, which is how the
 * thirty-day licence re-check happens without a scheduled job: the next
 * resolution that touches the subject pays for it. That is a compliance control
 * rather than a performance one — Commons files do get deleted as copyright
 * violations after the fact, and this bounds how long we could still be showing
 * one.
 */
export function imageryCache(now: Date = new Date()) {
  return {
    read: (key: string): ImageryOutcome | null => {
      const stored = storedImageryFor([key], now).get(key);
      if (!stored || stored.dueForRevalidation) return null;
      return stored.outcome;
    },
    write: (_key: string, value: ImageryOutcome): void => {
      // The key is derived from the record's own subject, so it is not taken
      // from the caller: a mismatch between the two would put a photograph of
      // one place under another place's key, which is the one corruption this
      // table must not be able to hold.
      saveImageryOutcome(value, now);
    },
  };
}
