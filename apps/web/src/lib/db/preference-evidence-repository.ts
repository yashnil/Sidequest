import 'server-only';
import { randomUUID } from 'node:crypto';
import { featureIsLearnable, learnPreferences, learnedHints, type LearnedPreference, type PreferenceEvidenceRow } from '@sidequest/core';
import { getDb } from './client';

/**
 * THE PREFERENCE EVIDENCE LEDGER, PERSISTED.
 *
 * V6 §18. Rows are appended, never edited; a feature the ledger must not
 * learn (a diet, a need, a religion) is refused at the door. Reads are by
 * account, or by browser cookie for an unclaimed history; claiming a
 * browser moves its rows with its trips.
 */

interface Row {
  id: string;
  user_id: string | null;
  owner_token: string | null;
  traveler_id: string | null;
  trip_id: string | null;
  scope: string;
  signal: string;
  feature: string;
  polarity: number;
  strength: number;
  source: string;
  context_json: string;
  created_at: string;
}

function parseContext(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToEvidence(row: Row): PreferenceEvidenceRow {
  const context = parseContext(row.context_json);
  return {
    id: row.id,
    userId: row.user_id,
    ownerToken: row.owner_token,
    travelerId: row.traveler_id,
    tripId: row.trip_id,
    scope: row.scope as PreferenceEvidenceRow['scope'],
    signal: row.signal as PreferenceEvidenceRow['signal'],
    feature: row.feature,
    polarity: row.polarity >= 0 ? 1 : -1,
    strength: row.strength,
    source: row.source as PreferenceEvidenceRow['source'],
    context,
    createdAt: row.created_at,
  };
}

export function recordPreferenceEvidence(rows: readonly Omit<PreferenceEvidenceRow, 'id'>[] | readonly PreferenceEvidenceRow[]): number {
  const db = getDb();
  const insert = db.prepare('INSERT INTO preference_evidence (id, user_id, owner_token, traveler_id, trip_id, scope, signal, feature, polarity, strength, source, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let written = 0;
  const run = db.transaction(() => {
    for (const row of rows) {
      if (!featureIsLearnable(row.feature)) continue;
      const id = 'id' in row && row.id ? row.id : randomUUID();
      insert.run(id, row.userId, row.userId ? null : row.ownerToken, row.travelerId, row.tripId, row.scope, row.signal, row.feature, row.polarity, row.strength, row.source, JSON.stringify(row.context ?? {}), row.createdAt);
      written += 1;
    }
  });
  run();
  return written;
}

export function listPreferenceEvidence(owner: { userId: string | null; ownerToken: string | null }, limit = 500): PreferenceEvidenceRow[] {
  const db = getDb();
  if (owner.userId) return (db.prepare('SELECT * FROM preference_evidence WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(owner.userId, limit) as Row[]).map(rowToEvidence);
  if (owner.ownerToken) return (db.prepare('SELECT * FROM preference_evidence WHERE owner_token = ? AND user_id IS NULL ORDER BY created_at DESC LIMIT ?').all(owner.ownerToken, limit) as Row[]).map(rowToEvidence);
  return [];
}

export function listTripEvidence(tripId: string): PreferenceEvidenceRow[] {
  return (getDb().prepare('SELECT * FROM preference_evidence WHERE trip_id = ? ORDER BY created_at ASC').all(tripId) as Row[]).map(rowToEvidence);
}

/** What the account has taught Sidequest, as weights and as brief-ready hints. Account-scoped rows only: a trip-local lean does not travel. */
export function learnedForOwner(owner: { userId: string | null; ownerToken: string | null }, now: Date = new Date()): { learned: LearnedPreference[]; hints: string[] } {
  const rows = listPreferenceEvidence(owner).filter((row) => row.scope === 'account' || row.source === 'post_trip' || row.source === 'explicit');
  const learned = learnPreferences(rows, now);
  return { learned, hints: learnedHints(learned) };
}
