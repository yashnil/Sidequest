import { Panel } from '@/components/ui';

/**
 * The plan route does real server work before it renders — it reads the trip,
 * the intent, the job and the stage observations, and decides which of eight
 * steps to show. With no `loading.tsx` that was a blank page for as long as it
 * took, on the route a traveller spends the most time on.
 */
export default function PlanLoading() {
  return (
    <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14" data-loading="true">
      <h1 className="font-display text-3xl leading-tight text-ink">Opening your trip</h1>
      <p className="mt-3 text-ink-muted">Reading where you got to.</p>
      <Panel className="mt-8 p-6">
        <div className="h-3 w-2/5 animate-pulse rounded bg-paper-sunk" />
        <div className="mt-4 h-3 w-3/5 animate-pulse rounded bg-paper-sunk" />
        <div className="mt-4 h-3 w-1/3 animate-pulse rounded bg-paper-sunk" />
      </Panel>
    </div>
  );
}
