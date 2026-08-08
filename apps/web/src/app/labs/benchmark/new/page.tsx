import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY, redactForbidden } from '@/components/benchmark/copy';
import { FixtureSeed } from '@/components/benchmark/FixtureSeed';
import { RequestComposer } from '@/components/benchmark/RequestComposer';
import { benchmarkModeIsLive } from '@/lib/benchmark/budget';
import { createComparisonAction, seedFixtureComparisonAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The screen that starts one comparison.
 *
 * The case titles are redacted on the way through. Seventeen of them describe
 * real travellers and one is called "with a prompt-injection payload in the free
 * text" — a perfectly good name for a test case and a banned word on a screen
 * that has to stay neutral. Filtering it here rather than renaming the case
 * keeps the case library readable for the people who maintain it.
 */
export default async function NewComparisonPage() {
  const cases = BENCHMARK_CASES.map((entry) => ({
    caseId: entry.caseId,
    title: redactForbidden(entry.title),
  }));

  return (
    <div className="mx-auto max-w-4xl px-3 py-8 sm:px-8 sm:py-12">
      <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {LABS_COPY.newTitle}
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">{LABS_COPY.newLede}</p>

      {/*
        Minted per render, and the page is dynamic, so two reviewers who open
        this screen never hold the same one. It is what tells a retried POST
        apart from a second person starting the same library case in the same
        minute — the two used to be indistinguishable, and the second person was
        silently given the first person's comparison.
      */}
      <div className="mt-8">
        <RequestComposer
          submit={createComparisonAction}
          cases={cases}
          submissionNonce={crypto.randomUUID()}
        />
      </div>

      {/*
        The fixture door, and only where it can do no harm.

        Hidden entirely in a live build rather than merely refused, because a
        control that is visible and then declines is a control somebody will
        press during a pilot and then wonder about. The action refuses as well;
        this is the affordance, that is the guarantee.
      */}
      {benchmarkModeIsLive() ? null : (
        <div className="mt-10">
          <FixtureSeed seed={seedFixtureComparisonAction} cases={cases} />
        </div>
      )}
    </div>
  );
}
