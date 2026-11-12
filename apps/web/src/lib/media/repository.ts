import 'server-only';
import { IMAGERY_RETRY_REJECTED_DAYS, IMAGERY_REVALIDATE_DAYS } from '@sidequest/core';
import { getDb } from '../db/client';
import { MEDIA_CONTEXTS, type MediaContext } from './frame';
import { mediaSelectionSchema, type MediaSelection, type SelectedMedia } from './select';

/**
 * MEDIA SELECTIONS, STORED IN THE SAME TABLE AS EVERY OTHER IMAGE DECISION.
 *
 * `destination_images` is already the product's image cache: metadata only
 * (never bytes), traveller-independent, acceptances re-checked after thirty
 * days and refusals after ninety, swept by `retention.ts` once past their date.
 * A media selection is one more kind of row in it, keyed
 * `media:v1:<context>:<QID>`, so it inherits all of that — including the
 * compliance rule that a selection past its re-check date does not render.
 *
 * The read path (`selectedMediaFor`) never reaches a network and is safe on a
 * render. Writing happens only after `resolve.ts` ran, in a server action.
 */

const KEY_PREFIX = 'media:v1';
const NO_FILE = '(no file)';

export function mediaKey(context: MediaContext, wikidataId: string): string {
  return `${KEY_PREFIX}:${context}:${wikidataId}`;
}

interface Row {
  subject_key: string;
  payload_json: string;
  revalidate_after: string;
  accepted: number;
  retrieved_at: string;
}

/** Store every context's decision for one place. A transient outage is never stored. */
export function saveMediaSelections(selections: Partial<Record<MediaContext, MediaSelection>>, now: Date): void {
  try {
    const db = getDb();
    const remove = db.prepare('DELETE FROM destination_images WHERE subject_key = ?');
    const insert = db.prepare(
      `INSERT INTO destination_images
         (subject_key, file_title, schema_version, provider, accepted, rejected_reason,
          licence_id, payload_json, retrieved_at, revalidate_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = db.transaction(() => {
      for (const selection of Object.values(selections)) {
        if (!selection || !selection.wikidataId) continue;
        if (selection.status === 'none' && (selection.reason === 'provider_unavailable' || selection.reason === 'disabled')) continue;
        const key = mediaKey(selection.context, selection.wikidataId);
        const days = selection.status === 'selected' ? IMAGERY_REVALIDATE_DAYS : IMAGERY_RETRY_REJECTED_DAYS;
        /* One row per key: a re-selection replaces the old file rather than sitting beside it. */
        remove.run(key);
        insert.run(
          key,
          selection.status === 'selected' ? selection.image.fileTitle : NO_FILE,
          selection.version,
          selection.status === 'selected' ? selection.image.provider : 'wikimedia-commons/media-v1',
          selection.status === 'selected' ? 1 : 0,
          selection.status === 'selected' ? null : selection.reason,
          selection.status === 'selected' ? selection.image.licenceId : null,
          JSON.stringify(selection),
          now.toISOString(),
          new Date(now.getTime() + days * 86_400_000).toISOString(),
        );
      }
    });
    write();
  } catch (error) {
    console.error('Could not store media selections', { error: error instanceof Error ? error.name : 'unknown' });
  }
}

export interface StoredMedia {
  selection: MediaSelection;
  dueForRevalidation: boolean;
}

/** Everything stored for these places in these contexts, keyed by `mediaKey`. Never a write. */
export function storedMediaFor(wikidataIds: readonly string[], contexts: readonly MediaContext[] = MEDIA_CONTEXTS, now: Date = new Date()): Map<string, StoredMedia> {
  const found = new Map<string, StoredMedia>();
  const keys = [...new Set(wikidataIds.filter((id) => /^Q\d+$/.test(id)))].flatMap((id) => contexts.map((context) => mediaKey(context, id)));
  if (keys.length === 0) return found;
  try {
    const rows = getDb()
      .prepare(
        `SELECT subject_key, payload_json, revalidate_after, accepted, retrieved_at
           FROM destination_images WHERE subject_key IN (${keys.map(() => '?').join(',')})
          ORDER BY accepted DESC, retrieved_at DESC`,
      )
      .all(...keys) as Row[];
    for (const row of rows) {
      if (found.has(row.subject_key)) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const parsed = mediaSelectionSchema.safeParse(payload);
      if (!parsed.success) continue;
      found.set(row.subject_key, { selection: parsed.data, dueForRevalidation: row.revalidate_after <= now.toISOString() });
    }
  } catch (error) {
    console.error('Could not read media selections', { error: error instanceof Error ? error.name : 'unknown' });
  }
  return found;
}

/**
 * The render read: QID → the selected photograph for this context, or nothing.
 * A selection past its licence re-check does not render (the fallback does).
 */
export function selectedMediaFor(wikidataIds: readonly string[], context: MediaContext, now: Date = new Date()): Record<string, SelectedMedia> {
  const stored = storedMediaFor(wikidataIds, [context], now);
  const out: Record<string, SelectedMedia> = {};
  for (const id of wikidataIds) {
    const entry = stored.get(mediaKey(context, id));
    if (entry && !entry.dueForRevalidation && entry.selection.status === 'selected') out[id] = entry.selection;
  }
  return out;
}

/** Places nobody has looked at for these contexts yet, or whose answer is due a re-check. Order kept. */
export function unresolvedMediaIds(wikidataIds: readonly string[], contexts: readonly MediaContext[], now: Date = new Date()): string[] {
  const stored = storedMediaFor(wikidataIds, contexts, now);
  return [...new Set(wikidataIds)].filter((id) =>
    /^Q\d+$/.test(id) && contexts.some((context) => {
      const entry = stored.get(mediaKey(context, id));
      return !entry || entry.dueForRevalidation;
    }),
  );
}
