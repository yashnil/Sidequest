import {
  scopeFingerprint,
  type CompiledRegion,
  type RegionRequest,
  type RegionSource,
  type RegionSourceResult,
} from '@sidequest/core';
import { compileRegion, type CompileInput } from './compile';
import type { CompilerProviders } from './providers';

/**
 * The dynamic compiler, wearing the same interface as the authored fixture.
 *
 * This is the payoff for the whole boundary: adding open-world compilation to
 * the application is one more entry in its list of region sources, not a change
 * to any page, action or planner.
 */
export interface DynamicRegionSourceOptions {
  providers: CompilerProviders;
  /** Injected, so a compiled artifact is reproducible and tests are stable. */
  now: () => Date;
  /** Injected for the same reason: an id derived from the request, not random. */
  compilationId?: (request: RegionRequest) => string;
  /** Cache lookup, so a refresh does not silently recompile. */
  lookup?: (fingerprint: string) => CompiledRegion | null;
  store?: (region: CompiledRegion) => void;
}

export function createDynamicRegionSource(
  options: DynamicRegionSourceOptions,
): RegionSource {
  return {
    name: 'dynamic-compiler',

    /**
     * Requires a confirmed scope, and says so rather than compiling one it
     * invented. Everything downstream is expensive; a scope nobody agreed to is
     * the one input worth refusing.
     */
    supports(request: RegionRequest): boolean {
      return request.scope !== undefined && request.scope.confirmedByUser;
    },

    async getCompiledRegion(request: RegionRequest): Promise<RegionSourceResult> {
      const scope = request.scope;
      /**
       * Both halves of `supports`, restated as a refusal.
       *
       * `supports` is how a caller picks a source; this is what happens when one
       * calls anyway. They have to agree, or an unconfirmed scope reaches the
       * expensive part of the pipeline through the back door.
       */
      if (!scope || !scope.confirmedByUser) {
        return {
          ok: false,
          code: 'scope_not_confirmed',
          message: 'Nothing has been built yet — the region is still yours to confirm.',
        };
      }

      const fingerprint = scopeFingerprint(scope);
      const cached = options.lookup?.(fingerprint) ?? null;
      // A cache hit is the *only* reason a page render may produce a region
      // without spending. Rendering must never recompile: that is how a refresh
      // silently changes somebody's plan.
      if (cached) return { ok: true, region: cached };

      const input: CompileInput = {
        compilationId: options.compilationId?.(request) ?? `compiled-${fingerprint}`,
        scope,
        ...(request.profile ? { profile: request.profile } : {}),
        dates: request.dates,
        months: request.months,
        providers: options.providers,
        now: options.now(),
      };

      const result = await compileRegion(input);
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      options.store?.(result.region);
      return { ok: true, region: result.region };
    },
  };
}
