import { providerRegistry } from '@/lib/providers/registry';
import { modeExplanation, modeLabel } from '@/lib/providers/capabilities.mjs';
import { isDiagnosticsMode } from '@/lib/providers/switches';

/**
 * WHICH WORLD THIS BUILD IS TALKING TO — BEHIND AN EXPLICIT DIAGNOSTICS SWITCH.
 *
 * PRODUCTION LOCK V5 §30. This used to render whenever `NODE_ENV !== 'production'`,
 * which sounds like "developers only" and is not the same thing. The founder
 * plans real personal trips against `npm run dev`, and what they saw at the top
 * of a finished Hong Kong itinerary was a red dashed banner reading:
 *
 *   Live  one Anthropic model call per generation; metered providers: anthropic, google-places
 *
 * A traveller — and the founder is one here — is being shown a model vendor, a
 * places vendor and a billing word, on the page that is supposed to be their
 * holiday. Provider diagnostics are for somebody debugging providers, and that
 * is a decision a person makes, not a property of the build.
 *
 * So the gate is now a switch somebody turns on (`SIDEQUEST_DIAGNOSTICS=on`),
 * off by default in every environment. Production is unchanged: still never
 * rendered there, because the registry may name a credentialed vendor and a
 * shipped page must not.
 *
 * Deliberately NOT covered by this: the fixture-planning badge on the same page.
 * That one says where the *content* came from, and mistaking a fixture draft for
 * the model's work is exactly the error it exists to prevent.
 */
export function EnvironmentPill() {
  if (process.env.NODE_ENV === 'production') return null;
  if (!isDiagnosticsMode()) return null;
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
