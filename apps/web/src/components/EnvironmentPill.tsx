import { providerRegistry } from '@/lib/providers/registry';
import { modeExplanation, modeLabel } from '@/lib/providers/capabilities.mjs';

/**
 * DEV-ONLY: WHICH WORLD THIS BUILD IS TALKING TO.
 *
 * Fixture, Mixed or Live, from the one capability registry `npm run doctor`
 * reads. Never rendered in a production build, so nobody mistakes a fixture
 * plan for the live model or the other way round.
 */
export function EnvironmentPill() {
  if (process.env.NODE_ENV === 'production') return null;
  const registry = providerRegistry();
  const real = registry.capabilities.filter((c) => c.configured && !c.fixture && c.provider && c.provider !== 'sidequest' && c.provider !== 'official-source-registry' && c.costClass !== 'none').map((c) => c.id);
  const tone = registry.mode === 'live' ? 'border-clay text-clay bg-clay-soft' : registry.mode === 'mixed' ? 'border-amber text-amber bg-amber-soft' : 'border-rule text-ink-muted bg-paper-sunk';
  return (
    <p className="mx-auto max-w-4xl px-5 pt-3 sm:px-8 print:hidden">
      <span className={`inline-flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1 text-xs ${tone}`} data-testid="environment-pill" data-mode={registry.mode} title={real.length > 0 ? `Real providers: ${real.join(', ')}` : 'No real provider is configured.'}>
        <span className="font-medium">{modeLabel(registry.mode)}</span>
        <span>{modeExplanation(registry)}</span>
      </span>
    </p>
  );
}
