export type CostClass = 'free' | 'metered' | 'self_hosted' | 'none';

export interface Capability {
  id: string;
  group: string;
  configured: boolean;
  available: boolean;
  provider: string | null;
  costClass: CostClass;
  freshness: string;
  coverage: string;
  limitations: string[];
  fixture: boolean;
  /** The canonical seam that consumes this capability; null when the adapter exists but nothing on the product path uses it. */
  consumer: string | null;
  /** Implemented as an adapter, intentionally not offered to the canonical runtime. */
  adapterOnly: boolean;
}

export const CONSUMERS: Record<string, string | null>;

export type ProviderMode = 'fixture' | 'mixed' | 'live' | 'off';

export interface CapabilityRegistry {
  mode: ProviderMode;
  composition: 'anthropic' | 'fixture' | 'off';
  capabilities: Capability[];
  byId: Record<string, Capability>;
}

export function capabilityRegistry(env?: Record<string, string | undefined>): CapabilityRegistry;
export function modeLabel(mode: ProviderMode): string;
export function modeExplanation(registry: CapabilityRegistry): string;
