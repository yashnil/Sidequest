export * from './providers';
export * from './backbone/pack';
export * from './backbone/partition';
export * from './backbone/link';
export * from './backbone/taxonomy';
/**
 * The role-eligibility layer.
 *
 * Derived, never persisted, and deliberately so: half of what it decides —
 * duplicate, permanently closed, insufficient identity — is not a property of a
 * category and cannot be known when a region pack is built. Freezing a
 * per-compilation judgement into a shared traveller-independent artifact is what
 * the pack/region split exists to prevent, so this layer sits above the pack and
 * `planningRoleOf` maps back to the stored vocabulary for anything that has to
 * round-trip.
 */
export * from './backbone/eligibility';
/**
 * The candidate portfolio: which slots a relationship and a role may occupy, and
 * the supply verdict that stops board size standing in for supply.
 *
 * `containment` reaches the barrel through `backbone/pack`, which re-exports it,
 * so it is not listed again here — two `export *` paths to one module are fine
 * for TypeScript and confusing for a reader.
 */
export * from './backbone/balance';
export * from './backbone/overlay';
export * from './backbone/inventory';
export * from './backbone/assemble';
export * from './budget';
export * from './clarify';
export * from './routing';
export * from './scope';
export * from './dedupe';
export * from './coverage';
export * from './compile';
export * from './provisional';
export * from './source';
export * from './evidence-store';
export * from './claims';
