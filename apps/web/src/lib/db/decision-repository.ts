import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  destinationShortlistSchema,
  tripComposerAnswersSchema,
  type DestinationShortlist,
  type TripComposerAnswers,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * A DECISION, BEFORE THERE IS A TRIP.
 *
 * Somebody with dates and no destination has nothing to attach their answers to.
 * `trips` requires a destination, and a placeholder one would sit on their
 * dashboard as a trip to nowhere until they chose.
 *
 * So the session is the durable artifact, exactly as `compilation_jobs` is the
 * durable artifact of a compilation: written on every answer, read back on every
 * render, and survivable across a refresh or a closed laptop. Picking a
 * destination creates a normal trip from these answers — the same
 * `TripComposerAnswers` the known-destination path uses, so there is one
 * preference vocabulary rather than two that could disagree.
 */

export interface DecisionSession {
  id: string;
  answers: TripComposerAnswers;
  /** Null until a shortlist has been built. Different from "empty shortlist". */
  shortlist: DestinationShortlist | null;
  /** Set once, when they chose. Never cleared. */
  resolvedTripId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  answers_json: string;
  shortlist_json: string | null;
  resolved_trip_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A stored shortlist that no longer parses is treated as absent.
 *
 * The same policy `parseLenient` applies to the composer and the preflight, and
 * for the same reason: losing a panel is cheaper than losing the answers behind
 * it. The answers themselves parse strictly — a session whose answers we cannot
 * read is not a session, and pretending otherwise would rank against defaults
 * nobody chose.
 */
function toSession(row: Row): DecisionSession | null {
  const answers = tripComposerAnswersSchema.safeParse(JSON.parse(row.answers_json));
  if (!answers.success) return null;

  let shortlist: DestinationShortlist | null = null;
  if (row.shortlist_json) {
    const parsed = destinationShortlistSchema.safeParse(JSON.parse(row.shortlist_json));
    shortlist = parsed.success ? parsed.data : null;
  }

  return {
    id: row.id,
    answers: answers.data,
    shortlist,
    resolvedTripId: row.resolved_trip_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDecisionSession(answers: TripComposerAnswers, now: Date): string {
  const id = randomUUID();
  const stamp = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO decision_sessions (id, schema_version, answers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, 1, JSON.stringify(answers), stamp, stamp);
  return id;
}

export function getDecisionSession(id: string): DecisionSession | null {
  const row = getDb()
    .prepare<[string], Row>('SELECT * FROM decision_sessions WHERE id = ?')
    .get(id);
  if (!row) return null;
  try {
    return toSession(row);
  } catch {
    return null;
  }
}

/**
 * Save answers, and drop any shortlist they invalidate.
 *
 * Dropped rather than kept-and-labelled, because a shortlist built from
 * different answers is not stale — it is an answer to a different question, and
 * leaving it on screen beside the new answers is the screen disagreeing with
 * itself. The traveller presses the button again; that is one click, and it is
 * honest.
 */
export function saveDecisionAnswers(id: string, answers: TripComposerAnswers, now: Date): void {
  getDb()
    .prepare(
      `UPDATE decision_sessions
          SET answers_json = ?, shortlist_json = NULL, updated_at = ?
        WHERE id = ? AND resolved_trip_id IS NULL`,
    )
    .run(JSON.stringify(answers), now.toISOString(), id);
}

export function saveDecisionShortlist(id: string, shortlist: DestinationShortlist, now: Date): void {
  getDb()
    .prepare('UPDATE decision_sessions SET shortlist_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(shortlist), now.toISOString(), id);
}

/**
 * Record which trip a decision became.
 *
 * Set once. A second `INSERT`-shaped guard rather than an update, so a
 * double-submitted form cannot produce two trips from one decision — the same
 * duplicate-click discipline `compilation_jobs` enforces with its partial unique
 * index, at the scale this table needs.
 */
export function resolveDecisionSession(id: string, tripId: string, now: Date): boolean {
  const result = getDb()
    .prepare(
      `UPDATE decision_sessions
          SET resolved_trip_id = ?, updated_at = ?
        WHERE id = ? AND resolved_trip_id IS NULL`,
    )
    .run(tripId, now.toISOString(), id);
  return result.changes > 0;
}
