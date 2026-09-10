import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './client';

/**
 * ACCOUNTS AND SIGNED-IN SESSIONS.
 *
 * V6 §21/§22/§50. A `users` row is minted the first time a provider vouches
 * for a subject (Google's `sub`, or the fixture provider's email in a test
 * deployment). A session is a random 256-bit token in an httpOnly cookie;
 * only its SHA-256 is stored, so the table is worthless to anyone who reads
 * it, and revoking a session is deleting a row.
 *
 * Claiming: an anonymous browser owns its trips through `trips.owner_token`.
 * When that browser signs in, `claimBrowserResources` moves every unclaimed
 * trip, traveller, evidence row and saved idea *that this cookie owns* onto
 * the account in one transaction. Nothing else is ever claimed: the statement
 * is scoped to the cookie the request presented, so a browser cannot claim
 * another browser's trips by guessing.
 */

export interface UserRecord {
  id: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  pictureUrl: string | null;
  provider: string;
  providerSubject: string;
  homeAirport: string | null;
  profile: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
}

interface UserRow {
  id: string;
  email: string | null;
  email_verified: number;
  display_name: string | null;
  picture_url: string | null;
  provider: string;
  provider_subject: string;
  home_airport: string | null;
  profile_json: string;
  created_at: string;
  last_seen_at: string;
}

function rowToUser(row: UserRow): UserRecord {
  const profile = parseProfile(row.profile_json);
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified === 1,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    provider: row.provider,
    providerSubject: row.provider_subject,
    homeAirport: row.home_airport,
    profile,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function parseProfile(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const SESSION_LIFETIME_DAYS = 90;
export const AUTH_STATE_LIFETIME_MINUTES = 10;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Find or create the account a provider vouched for. Email is refreshed from the provider on every sign-in. */
export function upsertUser(input: { provider: string; subject: string; email?: string | null; emailVerified?: boolean; displayName?: string | null; pictureUrl?: string | null }, now: Date = new Date()): UserRecord {
  const db = getDb();
  const at = now.toISOString();
  const existing = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_subject = ?').get(input.provider, input.subject) as UserRow | undefined;
  if (existing) {
    db.prepare('UPDATE users SET email = COALESCE(?, email), email_verified = ?, display_name = COALESCE(?, display_name), picture_url = COALESCE(?, picture_url), last_seen_at = ? WHERE id = ?').run(
      input.email ?? null,
      input.emailVerified ? 1 : existing.email_verified,
      input.displayName ?? null,
      input.pictureUrl ?? null,
      at,
      existing.id,
    );
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id) as UserRow);
  }
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, email, email_verified, display_name, picture_url, provider, provider_subject, home_airport, profile_json, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)').run(
    id,
    input.email ?? null,
    input.emailVerified ? 1 : 0,
    input.displayName ?? null,
    input.pictureUrl ?? null,
    input.provider,
    input.subject,
    '{}',
    at,
    at,
  );
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow);
}

export function getUser(id: string): UserRecord | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function updateUserProfile(id: string, patch: { displayName?: string | null; homeAirport?: string | null; profile?: Record<string, unknown> }, now: Date = new Date()): void {
  const existing = getUser(id);
  if (!existing) return;
  getDb()
    .prepare('UPDATE users SET display_name = ?, home_airport = ?, profile_json = ?, last_seen_at = ? WHERE id = ?')
    .run(patch.displayName === undefined ? existing.displayName : patch.displayName, patch.homeAirport === undefined ? existing.homeAirport : patch.homeAirport, JSON.stringify(patch.profile ?? existing.profile), now.toISOString(), id);
}

/** Mint a session; returns the raw token for the cookie. Only the hash is stored. */
export function createSession(userId: string, options: { userAgent?: string | null; now?: Date } = {}): { token: string; expiresAt: string } {
  const now = options.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_DAYS * 86_400_000).toISOString();
  getDb()
    .prepare('INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), userId, hashSessionToken(token), now.toISOString(), expiresAt, now.toISOString(), options.userAgent?.slice(0, 200) ?? null);
  return { token, expiresAt };
}

/** The user a raw session token belongs to, or null when unknown, expired or revoked. Touches `last_seen_at` at most once a day. */
export function userForSessionToken(token: string, now: Date = new Date()): UserRecord | null {
  if (!token || token.length > 128) return null;
  const db = getDb();
  const row = db.prepare('SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hashSessionToken(token)) as (UserRow & { session_id: string; expires_at: string; last_seen_at: string }) | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now.getTime()) {
    db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  if (now.getTime() - Date.parse(row.last_seen_at) > 86_400_000) {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.session_id);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  }
  return rowToUser(row);
}

export function revokeSession(token: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashSessionToken(token));
}

export function revokeAllSessions(userId: string): number {
  return getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId).changes;
}

/** One OAuth round trip's state. Ten minutes, single use. */
export function createAuthState(input: { provider: string; codeVerifier: string; returnTo: string | null; ownerToken: string | null }, now: Date = new Date()): string {
  const state = randomBytes(24).toString('base64url');
  const db = getDb();
  db.prepare('DELETE FROM auth_states WHERE expires_at <= ?').run(now.toISOString());
  db.prepare('INSERT INTO auth_states (state, provider, code_verifier, return_to, owner_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    state,
    input.provider,
    input.codeVerifier,
    input.returnTo,
    input.ownerToken,
    now.toISOString(),
    new Date(now.getTime() + AUTH_STATE_LIFETIME_MINUTES * 60_000).toISOString(),
  );
  return state;
}

/** Consume a state: returned once, then gone. Null when unknown or expired. */
export function consumeAuthState(state: string, now: Date = new Date()): { provider: string; codeVerifier: string; returnTo: string | null; ownerToken: string | null } | null {
  if (!state || state.length > 128) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM auth_states WHERE state = ?').get(state) as { provider: string; code_verifier: string; return_to: string | null; owner_token: string | null; expires_at: string } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM auth_states WHERE state = ?').run(state);
  if (Date.parse(row.expires_at) <= now.getTime()) return null;
  return { provider: row.provider, codeVerifier: row.code_verifier, returnTo: row.return_to, ownerToken: row.owner_token };
}

/** How many unclaimed trips a browser cookie owns — what the "save your trips" offer counts. */
export function countUnclaimedTrips(ownerToken: string | null): number {
  if (!ownerToken) return 0;
  return (getDb().prepare('SELECT COUNT(*) AS n FROM trips WHERE owner_token = ? AND user_id IS NULL').get(ownerToken) as { n: number }).n;
}

/**
 * Move everything this browser made onto the account, atomically.
 *
 * Scoped to the cookie the request presented and to rows nobody owns yet; a
 * row already on an account is never moved, and another browser's rows are
 * never touched because the statement cannot name them.
 */
export function claimBrowserResources(userId: string, ownerToken: string): { trips: number; travelers: number; evidence: number; ideas: number } {
  const db = getDb();
  const run = db.transaction(() => {
    const trips = db.prepare('UPDATE trips SET user_id = ?, updated_at = ? WHERE owner_token = ? AND user_id IS NULL').run(userId, new Date().toISOString(), ownerToken).changes;
    const travelers = db.prepare('UPDATE travelers SET user_id = ?, owner_token = NULL WHERE owner_token = ? AND user_id IS NULL').run(userId, ownerToken).changes;
    const evidence = db.prepare('UPDATE preference_evidence SET user_id = ?, owner_token = NULL WHERE owner_token = ? AND user_id IS NULL').run(userId, ownerToken).changes;
    const ideas = db.prepare('UPDATE saved_ideas SET user_id = ?, owner_token = NULL WHERE owner_token = ? AND user_id IS NULL').run(userId, ownerToken).changes;
    return { trips, travelers, evidence, ideas };
  });
  return run();
}

export function deleteUser(userId: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
}
