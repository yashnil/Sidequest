import 'server-only';
import { randomUUID } from 'node:crypto';
import { advisorShortlistSchema, tripComposerAnswersSchema, type AdvisorShortlist, type TripComposerAnswers } from '@sidequest/core';
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
  /**
   * The destination advisor's shortlist. Null until one has been built, which
   * is different from an empty shortlist — and null for a row whose stored
   * list is the previous ranker's (anything without `kind: 'advisor'`): that
   * session keeps its answers and simply re-enters the interview.
   */
  advisor: AdvisorShortlist | null;
  /** Set once, when they chose. Never cleared. */
  resolvedTripId: string | null;
  /**
   * The `sidequest_session` token of the browser that started this decision,
   * or null for a row written before the column existed — which is owned by
   * nobody and therefore shown to nobody, exactly as an unowned trip is.
   * See `lib/net/decision-access`.
   */
  ownerToken: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  answers_json: string;
  shortlist_json: string | null;
  resolved_trip_id: string | null;
  owner_token: string | null;
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
 *
 * The column once held the previous ranker's shortlist too. Those rows are
 * still on disk and there is no reader for them any more, so they fall under
 * the same policy: only a list that says `kind: 'advisor'` and parses is a
 * list; anything else in the column — an old shape, a half-written one, text
 * that is not JSON at all — is "no list yet", never an error.
 */
function toSession(row: Row): DecisionSession | null {
  const answers = tripComposerAnswersSchema.safeParse(JSON.parse(row.answers_json));
  if (!answers.success) return null;

  return {
    id: row.id,
    answers: answers.data,
    advisor: storedAdvisorShortlist(row.shortlist_json),
    resolvedTripId: row.resolved_trip_id,
    ownerToken: row.owner_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storedAdvisorShortlist(json: string | null): AdvisorShortlist | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if ((raw as { kind?: unknown } | null)?.kind !== 'advisor') return null;
  const parsed = advisorShortlistSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The owner is stamped at creation, exactly as `createTrip` stamps a trip.
 *
 * Null is accepted for the internal callers that have no cookie jar — a test,
 * a worker — and a null-owned session is refused to every browser, never
 * handed to the next visitor. See `lib/net/decision-access`.
 */
export function createDecisionSession(
  answers: TripComposerAnswers,
  ownerToken: string | null,
  now: Date,
): string {
  const id = randomUUID();
  const stamp = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO decision_sessions (id, schema_version, answers_json, owner_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, 1, JSON.stringify(answers), ownerToken, stamp, stamp);
  return id;
}

/**
 * The one indexed read the ownership boundary needs, mirroring
 * `tripOwnerToken`: cheap enough to sit in front of every decision action.
 */
export function decisionOwnerToken(id: string): string | null {
  const row = getDb()
    .prepare<[string], { owner_token: string | null }>(
      'SELECT owner_token FROM decision_sessions WHERE id = ?',
    )
    .get(id);
  return row?.owner_token ?? null;
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

export function saveDecisionShortlist(id: string, shortlist: AdvisorShortlist, now: Date): void {
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

/**
 * A refinement changes the answers *and* produces the list those answers rank
 * to, in one write. `saveDecisionAnswers` drops the shortlist on purpose; a
 * refinement must not, or the screen would flash empty between the two.
 */
export function saveDecisionAnswersAndShortlist(id: string, answers: TripComposerAnswers, shortlist: AdvisorShortlist, now: Date): void {
  getDb()
    .prepare(
      `UPDATE decision_sessions
          SET answers_json = ?, shortlist_json = ?, updated_at = ?
        WHERE id = ? AND resolved_trip_id IS NULL`,
    )
    .run(JSON.stringify(answers), JSON.stringify(shortlist), now.toISOString(), id);
}
