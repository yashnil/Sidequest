import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/client';

/**
 * WHY A SESSION TOKEN HAS TO BE SOMETHING THE SERVER CAN PROVE IT ISSUED.
 *
 * `sidequest_session` does two jobs. As an **ownership credential** its value
 * is opaque and unguessable, which is all that job needs: whatever the browser
 * presents is compared against `trips.owner_token`, and a value nobody issued
 * matches nothing. As a **budget identity** it is the key the daily model-call
 * and live-compilation ceilings are charged against — and there the same
 * property is exactly wrong, because the value is *chosen by the client*.
 *
 * `sessionToken` read the jar and returned whatever was in it. So a caller who
 * sends `sidequest_session=<a fresh random string>` on every request opens a
 * fresh per-caller bucket on every request, and `PER_CALLER_SHARE` — the
 * control that exists so one visitor cannot drain the deployment's day — is
 * defeated at zero cost. `daily-ceiling`'s own header already names the failure
 * it was trying to avoid ("minting an identity per request would hand every
 * request a fresh personal allowance, which is worse than having none") and
 * then inherited it anyway, because it trusted a value it had not issued.
 *
 * So a token now carries a signature over its own random half, and only a token
 * whose signature verifies is treated as an identity. Everything else — a
 * forged value, a value from another deployment, a cookie minted before this
 * existed — falls into the shared unattributed pool, which is the honest
 * reading of "we cannot tell who this is" and is exactly where an anonymous
 * caller who declines the cookie already lands. Nothing about **ownership**
 * changes: the whole string is still the owner token, still compared verbatim,
 * so a browser holding an older unsigned cookie keeps every trip it made.
 *
 * The signature is not a security boundary around trip data. It is a boundary
 * around *spend*, and the property it needs is only that a client cannot
 * manufacture identities. A forged token buys the shared pool; it never buys
 * somebody else's trip, because guessing a signature does not help you guess
 * the random half that a real trip is keyed on.
 */

/** Hex characters of HMAC kept. 16 is 64 bits, which nobody is brute-forcing for a rate bucket. */
const SIGNATURE_LENGTH = 16;

const SECRET_TABLE_SQL = `CREATE TABLE IF NOT EXISTS server_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

const SECRET_NAME = 'session_token_hmac';

/**
 * The signing key: an operator's if they set one, otherwise one this deployment
 * generated for itself and kept.
 *
 * Persisted rather than held in memory because the worker process and the web
 * process are different processes and a restart must not invalidate every
 * traveller's identity. Generated rather than defaulted because a shipped
 * constant is not a secret, and a deployment that has not been configured must
 * still get a working control rather than a decorative one.
 */
let cached: string | null = null;

export function sessionSigningKey(): string | null {
  const configured = process.env.SIDEQUEST_SESSION_SECRET?.trim();
  if (configured) return configured;
  if (cached) return cached;
  try {
    const db = getDb();
    db.exec(SECRET_TABLE_SQL);
    const row = db.prepare('SELECT value FROM server_secrets WHERE name = ?').get(SECRET_NAME) as
      | { value: string }
      | undefined;
    if (row?.value) {
      cached = row.value;
      return cached;
    }
    const minted = randomBytes(32).toString('hex');
    db.prepare(
      'INSERT OR IGNORE INTO server_secrets (name, value, created_at) VALUES (?, ?, ?)',
    ).run(SECRET_NAME, minted, new Date().toISOString());
    const stored = db.prepare('SELECT value FROM server_secrets WHERE name = ?').get(SECRET_NAME) as
      | { value: string }
      | undefined;
    cached = stored?.value ?? minted;
    return cached;
  } catch {
    /*
     * No database — a unit test, a worker without storage. Absent means the
     * signature cannot be checked, and `isSignedSessionToken` then refuses
     * every token rather than accepting every token: a control that fails open
     * is the control that was already there.
     */
    return null;
  }
}

function signatureFor(random: string, key: string): string {
  return createHmac('sha256', key).update(random).digest('hex').slice(0, SIGNATURE_LENGTH);
}

/** A token this server can later recognise as its own. */
export function mintSessionToken(random: string): string {
  const key = sessionSigningKey();
  return key === null ? random : `${random}.${signatureFor(random, key)}`;
}

/**
 * Whether this deployment issued this token.
 *
 * Constant-time on the signature comparison — not because a rate bucket is
 * worth a timing attack, but because writing the other version teaches the
 * pattern to the next person who copies it for something that is.
 */
export function isSignedSessionToken(token: string): boolean {
  const key = sessionSigningKey();
  if (key === null) return false;
  const cut = token.lastIndexOf('.');
  if (cut <= 0) return false;
  const random = token.slice(0, cut);
  const offered = token.slice(cut + 1);
  if (offered.length !== SIGNATURE_LENGTH) return false;
  const expected = signatureFor(random, key);
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Test seam: forget the cached key so a fresh database mints a fresh one. */
export function resetSessionSigningKeyCache(): void {
  cached = null;
}
