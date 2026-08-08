/**
 * RANDOMNESS AS A PORT, NEVER AS AN AMBIENT CALL.
 *
 * This repository contains no `Math.random()` anywhere, and an architecture test
 * bans it: a compiler that could read a random number would produce a different
 * artifact for the same input, and reproducibility is the property everything
 * else rests on. Where variety is needed, it is derived from a hash of something
 * stable.
 *
 * A blind benchmark genuinely needs randomness, though — an assignment a
 * reviewer could predict is not a blind assignment. So it arrives the way the
 * clock does: injected at a write boundary, drawn exactly once, and stored.
 *
 * Live sessions get `systemEntropy()`. Offline tests get `seededEntropy(seed)`,
 * which makes the "A on the left" and "B on the left" fixtures two fixed seeds
 * rather than two flaky runs. The stored assignment records which was used, so
 * a fixture session can never be pooled with a live one in an aggregate.
 */

export interface Entropy {
  /** A uniform draw in [0, 1). Called once per decision, at session creation. */
  next(): number;
}

/**
 * The live source.
 *
 * `crypto.getRandomValues` rather than `Math.random` for one reason that is not
 * about cryptography: this module is the only place in the codebase permitted to
 * be non-deterministic, and giving it a distinct call makes the architecture
 * test that enforces that a one-line grep.
 */
export function systemEntropy(): Entropy {
  return {
    next(): number {
      const buffer = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buffer);
      // 2**32. Dividing a uint32 by it lands in [0, 1) without ever reaching 1.
      return (buffer[0] ?? 0) / 4294967296;
    },
  };
}

/**
 * The deterministic source.
 *
 * A 64-bit SplitMix-style chain seeded from a string hash. Not a good generator
 * for anything that matters statistically — it is not used for anything that
 * does. Its job is that the same seed produces the same session, every run, on
 * every machine.
 */
export function seededEntropy(seed: string): Entropy {
  let state = hashToUint32(seed);
  return {
    next(): number {
      // SplitMix32. Chosen over a linear congruential generator because the
      // low bits of an LCG are notoriously non-uniform, and the first draw here
      // decides the whole assignment.
      state = (state + 0x9e3779b9) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      z = (z ^ (z >>> 15)) >>> 0;
      return z / 4294967296;
    },
  };
}

function hashToUint32(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
