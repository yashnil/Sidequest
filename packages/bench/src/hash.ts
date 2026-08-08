/**
 * Stable content hashing, and the canonical JSON it needs.
 *
 * `JSON.stringify` preserves insertion order, so two objects that are equal as
 * values hash differently if they were built in a different order. Every use of
 * a hash here — the single-flight operation identity, the immutable plan's
 * content address, the proof that both systems received the same correction
 * text — is a claim about the *value*, so the key order has to be removed first.
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== 'object') {
    // A non-finite number would serialise as `null` and silently become
    // indistinguishable from an absent value — the exact corruption the metric
    // schema exists to prevent, caught here too because a hash is where it would
    // stop being noticeable.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Refusing to hash a non-finite number.');
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    out[key] = canonicalise(record[key]);
  }
  return out;
}

/**
 * FNV-1a, 128 bits, as four 32-bit lanes rendered hex.
 *
 * Not a cryptographic hash and not used as one: nothing here defends against a
 * chosen-collision attacker, because the only writer is this application. What
 * it must be is stable across processes and platforms, which rules out anything
 * derived from object identity or from Node's crypto being present — this module
 * is imported by pure package code that must run anywhere.
 */
export function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  const primes = [16777619, 2246822519, 3266489917, 374761393];

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    for (let lane = 0; lane < 4; lane += 1) {
      // Each lane advances with its own prime and its own offset into the
      // string, so two texts that differ only by a transposition do not collide
      // the way a single-lane FNV can.
      lanes[lane] = Math.imul((lanes[lane] ?? 0) ^ (code + lane * 7 + index), primes[lane] ?? 16777619) >>> 0;
    }
  }

  return lanes.map((lane) => (lane >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * The identity a durable single-flight claim is keyed on.
 *
 * Everything that could change the answer is in here. The session id in
 * particular is not optional: without it, two sessions running the same request
 * would collide on one operation, and the second would be handed the first's
 * result — which is a cross-session leak wearing a cache's clothes.
 */
export function operationKey(input: {
  sessionId: string;
  requestVersion: number;
  inputHash: string;
  promptVersion: string;
  schemaVersion: number;
  model: string;
  locale: string;
  operation: string;
}): string {
  return stableHash([
    input.sessionId,
    input.requestVersion,
    input.inputHash,
    input.promptVersion,
    input.schemaVersion,
    input.model,
    input.locale,
    input.operation,
  ].join('|'));
}
