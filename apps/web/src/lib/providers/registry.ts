import { capabilityRegistry, modeExplanation, modeLabel, type Capability, type CapabilityRegistry, type ProviderMode } from './capabilities.mjs';

/**
 * The TypeScript face of the capability registry. The logic lives in
 * `capabilities.mjs` so `scripts/doctor.mjs` reads the identical answer.
 */
export type { Capability, CapabilityRegistry, ProviderMode };

export function providerRegistry(env: Record<string, string | undefined> = process.env): CapabilityRegistry {
  return capabilityRegistry(env);
}

export function capability(id: string, env: Record<string, string | undefined> = process.env): Capability | null {
  return capabilityRegistry(env).byId[id] ?? null;
}

export function capabilityAvailable(id: string, env: Record<string, string | undefined> = process.env): boolean {
  return capability(id, env)?.available ?? false;
}

export function providerMode(env: Record<string, string | undefined> = process.env): { mode: ProviderMode; label: string; explanation: string } {
  const registry = capabilityRegistry(env);
  return { mode: registry.mode, label: modeLabel(registry.mode), explanation: modeExplanation(registry) };
}
