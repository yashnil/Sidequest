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
  /** V1 convergence — fixture switches in use and whether production refuses them. */
  fixtureGuard: FixtureGuard;
  /** V1 convergence — the operator's hard problems, in words (switch names allowed; never traveller copy). */
  problems: string[];
}

export interface FixtureGuard {
  production: boolean;
  optedIn: boolean;
  switches: string[];
  refused: boolean;
}

export const FIXTURES_OPT_IN: 'SIDEQUEST_FIXTURES';
export function fixtureSwitchesInUse(env?: Record<string, string | undefined>): string[];
export function productionFixtureRefusal(env?: Record<string, string | undefined>): FixtureGuard;
export function deploymentProblems(env?: Record<string, string | undefined>): string[];

export function capabilityRegistry(env?: Record<string, string | undefined>): CapabilityRegistry;
export function modeLabel(mode: ProviderMode): string;
export function modeExplanation(registry: CapabilityRegistry): string;
