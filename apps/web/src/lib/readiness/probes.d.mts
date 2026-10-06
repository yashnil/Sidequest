export type ProbeState = 'working' | 'degraded' | 'configured_unverified' | 'not_configured' | 'failing';

export interface ProbeVerdict {
  state: ProbeState;
  reason: string;
  status?: number;
  /** Nothing answered at all (refused, timed out, 5xx on a health route). */
  unreachable?: boolean;
  /** The credential was rejected (401/403). */
  authRejected?: boolean;
  ms?: number;
}

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const PROBE_TIMEOUT_MS: number;
export const DEFAULT_VALHALLA_ENDPOINT: string;
export const DEFAULT_ANTHROPIC_BASE: string;
export function isLoopbackUrl(url: string): boolean;
export function probeValhalla(env: Env, fetchImpl?: FetchLike): Promise<ProbeVerdict>;
export function probeAnthropic(env: Env, fetchImpl?: FetchLike): Promise<ProbeVerdict>;
export function probeWeather(env: Env, fetchImpl?: FetchLike): Promise<ProbeVerdict>;
export function probeClimate(env: Env, fetchImpl?: FetchLike): Promise<ProbeVerdict>;

export type ProbeId = 'routing.local' | 'composition' | 'weather' | 'climate';
export const PROBES: Record<ProbeId, { run: (env: Env, fetchImpl?: FetchLike) => Promise<ProbeVerdict>; ttlMs: number }>;
