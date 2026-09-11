import type { Metadata } from 'next';
import { SetupFlow } from '@/components/setup/SetupFlow';
import { resolveMapBasemap } from '@/components/map-adapter';
import { destinationPrefillFrom } from '@/components/setup/destination-prefill';
import { SETUP_STEPS, type SetupStepId } from '@/components/setup/setup-draft';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Start a trip — Sidequest',
};

function isoDate(daysFromNow: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

/**
 * THE FIRST SCREEN OF ONE CONTINUOUS INTERVIEW.
 *
 * Not a form any more (MVP V3, Stage 4). `SetupFlow` asks where, when, how many
 * nights, who and what is already fixed — one question per screen, each a real
 * history entry so the browser's own Back works, and each carrying the same
 * progress path the adaptive interview uses. What follows it is the next
 * question, not a different product.
 *
 * The third homepage intent — "I already have a plan" — still arrives here with
 * `?have=plan`, and still means one thing: the places somebody already has are
 * asked for early, because the must-do pipeline is what genuinely acts on them.
 *
 * V8 — `?destination=<text>` prefills the field with what the home page's
 * example prompts carry, and the flow places it exactly as it would place the
 * traveller's own typing. It is a convenience, never a gate.
 */
export default async function NewTripPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const improving = params.have === 'plan';
  const rawStep = typeof params.step === 'string' ? params.step : undefined;
  const initialStep = rawStep && (SETUP_STEPS as readonly string[]).includes(rawStep) ? (rawStep as SetupStepId) : undefined;
  const prefill = destinationPrefillFrom(params);

  return (
    <SetupFlow
      defaults={{ startDate: isoDate(30), endDate: isoDate(36) }}
      intent={improving ? 'has_plan' : 'new'}
      tiles={resolveMapBasemap(process.env)}
      {...(initialStep ? { initialStep } : {})}
      {...(prefill ? { initialDestination: prefill } : {})}
    />
  );
}
