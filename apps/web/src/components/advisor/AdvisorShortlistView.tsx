import { Fragment } from 'react';
import {
  DESTINATION_KIND_LABELS,
  imageryFallbackFor,
  WORLD_REGION_LABELS,
  type AdvisorPick,
  type AdvisorShortlist,
  type DestinationImage as ImageRecord,
} from '@sidequest/core';
import { DestinationImage } from '@/components/DestinationImage';
import { cx } from '@/components/ui';
import { comparedSentence, formatCount, provenanceOf, provenanceShort, sourceReference } from './advisor-copy';
import { DataAttribution } from './DataAttribution';
import { WorldDots } from './WorldDots';
import { AdvisorPickActions, AdvisorRefineBar } from './AdvisorControls';

/**
 * THE SHORTLIST: THREE DIFFERENT ANSWERS, EACH ARGUED FOR.
 *
 * Built from the stored `AdvisorShortlist` only — no ranking, no provider and
 * no model at render. Each card says what kind of place it is, whose reading
 * it is (ours, or open data nobody has checked — and how much that data says),
 * why it fits *this* traveller, what they'd actually do, when it is good for
 * what they want to do, for how long, how hard and how far, what it costs on
 * the ground, what's worse about it, and what we have not checked. Internal
 * numbers appear only inside "How we ranked these", where they are labelled.
 *
 * A photograph is shown only when the imagery gate accepted one for the
 * destination's own Wikidata item; otherwise the card says where it is on a
 * real world map and does not pretend to have a picture.
 */

const MATCH_WORDS: Record<AdvisorPick['match'], string> = {
  strong: 'Strong match',
  good: 'Good match',
  possible: 'Worth considering',
};

function coverageWords(pick: AdvisorPick): string {
  const asked = pick.factors.filter((factor) => factor.value !== null).length;
  return `${asked} of ${pick.factors.length} checks could be made`;
}

function kindWords(pick: AdvisorPick): string | null {
  return DESTINATION_KIND_LABELS[pick.kind] ?? null;
}

const mark = (pick: AdvisorPick) => ({ id: pick.id, lat: pick.center.lat, lng: pick.center.lng });

function Fact({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx('min-w-0 py-2.5', wide && 'sm:col-span-2')}>
      <dt className="sheet-label text-ink-muted">{label}</dt>
      <dd className="mt-1 text-sm leading-snug [overflow-wrap:anywhere] text-ink">{children}</dd>
    </div>
  );
}

/** Whose reading this is, in a sentence — and, for open data, how much it had to go on. */
function Provenance({ pick, className }: { pick: AdvisorPick; className?: string }) {
  const provenance = provenanceOf(pick);
  return (
    <p data-testid="advisor-provenance" className={cx('text-[0.8125rem] leading-snug text-ink-muted', className)}>
      {provenance.suggested ? <span className="block">{provenance.suggested}.</span> : null}
      <span className="block">
        {provenance.reading}
        {provenance.documentation ? ` · ${provenance.documentation}` : ''}.
      </span>
    </p>
  );
}

function Sources({ pick }: { pick: AdvisorPick }) {
  if (pick.references.length === 0) return null;
  return (
    <p className="mt-4 text-sm leading-snug [overflow-wrap:anywhere] text-ink-muted">
      <span className="sheet-label mr-2">Sources</span>
      {pick.references.map((reference, index) => {
        const source = sourceReference(reference);
        return (
          <Fragment key={reference}>
            {index > 0 ? ' · ' : null}
            {source.href ? (
              <a href={source.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-ink">
                {source.text}
                <span className="sr-only">
                  {source.generic ? ` for ${pick.name}` : ''} (opens in a new tab)
                </span>
              </a>
            ) : (
              source.text
            )}
          </Fragment>
        );
      })}
    </p>
  );
}

function Locator({ pick }: { pick: AdvisorPick }) {
  return (
    <div className="survey-night relative flex aspect-[16/9] flex-col justify-between p-4 text-bone">
      <WorldDots highlighted={[mark(pick)]} tone="night" className="absolute inset-0 m-auto h-full w-full p-3 opacity-90" label={`${pick.name} on a world map`} />
      <p className="sheet-label relative text-bone/60">{WORLD_REGION_LABELS[pick.worldRegion]}</p>
    </div>
  );
}

function PickCard({ pick, index, image, sessionId }: { pick: AdvisorPick; index: number; image: ImageRecord | null; sessionId: string }) {
  const kind = kindWords(pick);
  const editorial = pick.basis === 'editorial';
  return (
    <article data-testid="advisor-pick" className="fade-up flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-ink/15 bg-paper-raised" style={{ ['--d' as string]: `${index * 90}ms` }} aria-labelledby={`pick-${pick.id}`}>
      {image ? (
        <DestinationImage
          image={image}
          ratio="16 / 9"
          fallback={imageryFallbackFor({ kind: 'destination', id: `advisor:${pick.id}`, name: pick.name, coordinates: pick.center })}
        />
      ) : (
        <Locator pick={pick} />
      )}
      <div className="flex min-w-0 flex-1 flex-col p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="sheet-label text-accent">
            <span className="font-semibold text-flare">{index + 1}</span> · {MATCH_WORDS[pick.match]}
          </p>
          <p className="type-meta text-ink-faint" title="How many of the things we score were measured for you">{coverageWords(pick)}</p>
        </div>
        <h3 id={`pick-${pick.id}`} className="mt-2 font-display text-[clamp(1.7rem,1.3rem+1.2vw,2.3rem)] leading-[1.02] font-[360] tracking-[-0.02em] [overflow-wrap:anywhere] text-ink">
          {pick.name}
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          {kind ? <span data-testid="advisor-kind">{kind}</span> : null}
          {kind && pick.context ? ' · ' : null}
          {pick.context}
        </p>
        <Provenance pick={pick} className="mt-2" />
        <p className="mt-4 text-[1.02rem] leading-snug text-ink">{pick.why}</p>
        {pick.differsBy ? <p className="mt-2 text-sm text-ink-muted italic">{pick.differsBy}</p> : null}

        <ul className="mt-4 space-y-1.5">
          {pick.experiences.map((line) => (
            <li key={line} className="flex gap-2 text-sm leading-snug text-ink">
              <span aria-hidden="true" className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-flare" />
              {line}
            </li>
          ))}
        </ul>

        <dl className="ruled mt-5 grid grid-cols-1 border-t border-ink/15 sm:grid-cols-2 sm:gap-x-5 [&>*+*]:border-t-0 sm:[&>*]:border-b sm:[&>*]:border-ink/10">
          <Fact label="Best time" wide={Boolean(pick.seasonNote)}>
            {pick.seasonNote ? (
              <>
                <span className="font-medium">{pick.window.label}</span>
                {/* The season by activity: when it is good for what this traveller wants to do there. */}
                <span data-testid="advisor-season" className="mt-1 block">
                  {pick.seasonNote}
                </span>
              </>
            ) : (
              pick.window.label
            )}
          </Fact>
          <Fact label="Trip length">
            About {pick.nights.suggested} nights <span className="text-ink-muted">({pick.nights.min}–{pick.nights.max} works)</span>
          </Fact>
          <Fact label="Character">{pick.character}</Fact>
          <Fact label="Costs">
            {pick.cost.label}
            {pick.cost.versusBudget ? <span className="text-ink-muted"> · {pick.cost.versusBudget.toLowerCase()}</span> : null}
            {pick.cost.rooms ? <span className="mt-1 block text-ink-muted">{pick.cost.rooms}</span> : null}
          </Fact>
          <Fact label="Getting there">{pick.gettingThere}</Fact>
          <Fact label="Getting around">{pick.gettingAround}</Fact>
          <Fact label="Where you’d stay">{pick.bases.join(' · ')}</Fact>
          <Fact label="Weather check">
            <span className={cx(pick.climate.status === 'differs' && 'text-warning')}>{pick.climate.note}</span>
          </Fact>
        </dl>

        {pick.tradeoffs.length > 0 ? (
          <div className="mt-5">
            <p className="sheet-label text-ink-muted">The catch</p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink">
              {pick.tradeoffs.map((line) => (
                <li key={line}>— {line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <Sources pick={pick} />
        <details className="mt-2 text-sm">
          <summary className="min-h-11 cursor-pointer py-2 text-ink-muted hover:text-ink">Not checked yet</summary>
          <ul className="mt-1 space-y-1 text-ink-muted">
            {pick.unverified.map((line) => (
              <li key={line}>· {line}</li>
            ))}
            <li>
              ·{' '}
              {editorial
                ? 'Our reading of this place is editorial, written from the sources above.'
                : 'Nobody at Sidequest has reviewed this place. What we say about it is worked out from the sources above.'}
            </li>
          </ul>
        </details>

        <div className="mt-auto pt-6">
          <AdvisorPickActions sessionId={sessionId} pickId={pick.id} name={pick.name} primary />
        </div>
      </div>
    </article>
  );
}

function AlternateCard({ pick, sessionId }: { pick: AdvisorPick; sessionId: string }) {
  const kind = kindWords(pick);
  return (
    <article className="flex min-w-0 flex-col rounded-[var(--radius-card)] border border-ink/15 p-4" aria-labelledby={`alt-${pick.id}`}>
      <p className="sheet-label text-ink-muted">
        {WORLD_REGION_LABELS[pick.worldRegion]}
        {kind ? ` · ${kind}` : ''}
      </p>
      <h3 id={`alt-${pick.id}`} className="mt-1.5 font-display text-xl leading-tight [overflow-wrap:anywhere] text-ink">
        {pick.name}
      </h3>
      <p className="text-xs text-ink-muted">{pick.context}</p>
      <p className="mt-2 text-sm leading-snug text-ink">{pick.why}</p>
      <p className="type-meta mt-2 text-ink-faint">
        {pick.window.label} · ~{pick.nights.suggested} nights · {pick.cost.label.toLowerCase()}
      </p>
      {pick.seasonNote ? <p className="mt-1 text-[0.8125rem] leading-snug text-ink-muted">{pick.seasonNote}</p> : null}
      <Provenance pick={pick} className="mt-2" />
      <div className="mt-auto pt-4">
        <AdvisorPickActions sessionId={sessionId} pickId={pick.id} name={pick.name} />
      </div>
    </article>
  );
}

function CompareTable({ picks }: { picks: AdvisorPick[] }) {
  const rows: [string, (pick: AdvisorPick) => string][] = [
    ['Where', (pick) => pick.context],
    ['What it is', (pick) => kindWords(pick) ?? '—'],
    ['Strong for', (pick) => pick.strongFor.join(', ') || '—'],
    ['Best time', (pick) => pick.window.label],
    ['Nights', (pick) => `~${pick.nights.suggested} (${pick.nights.min}–${pick.nights.max})`],
    ['Character', (pick) => pick.character],
    ['Costs', (pick) => pick.cost.label],
    ['Getting there', (pick) => (pick.distanceKm !== null ? `~${(Math.round(pick.distanceKm / 100) * 100).toLocaleString('en-US')} km` : pick.gettingThere.split('(')[0]!.trim())],
    ['Getting around', (pick) => pick.gettingAround],
    ['Weather check', (pick) => ({ verified: 'Matches records', differs: 'Records differ', unavailable: 'Unchecked', not_checked: 'Unchecked' })[pick.climate.status]],
    ['Whose reading', (pick) => provenanceShort(pick)],
  ];
  return (
    <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b-2 border-ink">
            <th scope="col" className="sheet-label w-32 py-2 pr-3 text-ink-muted">
              <span className="sr-only">Detail</span>
            </th>
            {picks.map((pick) => (
              <th key={pick.id} scope="col" className="py-2 pr-4 font-display text-base font-[400] text-ink">
                {pick.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, read]) => (
            <tr key={label} className="border-b border-ink/10 align-top">
              <th scope="row" className="sheet-label py-2.5 pr-3 text-ink-muted">
                {label}
              </th>
              {picks.map((pick) => (
                <td key={pick.id} className="py-2.5 pr-4 text-ink">
                  {read(pick)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdvisorShortlistView({
  sessionId,
  shortlist,
  images,
  dots,
  sampleComplete,
  summary,
}: {
  sessionId: string;
  shortlist: AdvisorShortlist;
  images: Record<string, ImageRecord>;
  /** Path data for the header map: a server-thinned sample of real destination centres. */
  dots: string;
  /** True when the dots are every destination rather than a sample. */
  sampleComplete: boolean;
  summary: string[];
}) {
  const all = [...shortlist.picks, ...shortlist.alternates];
  const { readout, stats } = shortlist;
  const setAside = Object.values(stats.excluded).reduce((a, b) => a + b, 0);
  return (
    <div data-testid="advisor-shortlist">
      <header className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-end">
        <div className="min-w-0">
          <p className="sheet-label inline-flex items-center gap-2 text-accent">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
            Your shortlist
          </p>
          <h1 className="mt-3 max-w-[20ch] font-display text-[clamp(2.3rem,1.5rem+2.8vw,4rem)] leading-[1] font-[340] tracking-[-0.03em] text-balance text-ink">
            {shortlist.picks.length === 0
              ? 'Nothing fits all of that yet.'
              : shortlist.picks.length === 1
                ? 'One place fits.'
                : shortlist.picks.length === 2
                  ? 'Two places that fit.'
                  : new Set(shortlist.picks.map((pick) => pick.worldRegion)).size === 3
                    ? 'Three places, three different trips.'
                    : 'Three places that fit.'}
          </h1>
          {readout.spread ? <p className="measure mt-4 type-body text-ink-muted">{readout.spread}</p> : null}
          {shortlist.changes.length > 0 ? (
            <p role="status" className="mt-4 inline-block rounded-full bg-accent-soft px-3.5 py-1.5 text-sm text-accent-strong">
              {shortlist.changes.join(' ')}
            </p>
          ) : null}
          {readout.relaxation ? <p className="measure mt-4 rounded-[var(--radius-card)] border border-warning/40 bg-amber-soft px-4 py-3 text-sm text-ink">{readout.relaxation}</p> : null}
        </div>
        <figure className="survey-night min-w-0 rounded-[var(--radius-card)] p-3">
          <WorldDots
            dots={dots}
            highlighted={shortlist.picks.map(mark)}
            tone="night"
            className="h-auto w-full"
            label={
              shortlist.picks.length > 0
                ? `World map marking ${shortlist.picks.map((pick) => pick.name).join(', ')}. The faint dots are ${sampleComplete ? 'the' : 'a sample of the'} destinations we compared.`
                : `World map of ${sampleComplete ? 'the' : 'a sample of the'} destinations we compared`
            }
          />
          <figcaption className="mt-1 text-[0.7rem] text-bone/45">{sampleComplete ? 'Each faint dot is a real destination centre.' : 'Faint dots are a sample of real destination centres.'}</figcaption>
        </figure>
      </header>

      <section className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]" aria-label="What this is based on">
        <div className="min-w-0">
          <p className="sheet-label text-ink-muted">Ranked on</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {readout.drivers.map((driver) => (
              <li key={driver} className="rounded-full bg-paper-sunk px-3 py-1 text-sm text-ink">
                {driver}
              </li>
            ))}
          </ul>
          {readout.assumptions.length > 0 ? (
            <p className="mt-3 text-sm text-ink-muted">
              <span className="font-medium text-ink">Assumed: </span>
              {readout.assumptions.join(' ')}
            </p>
          ) : null}
        </div>
        {readout.openQuestions.length > 0 ? (
          <div>
            <p className="sheet-label text-ink-muted">Would sharpen this</p>
            <p className="mt-2 text-sm text-ink">{readout.openQuestions.join(' · ')}</p>
            <a href={`/decide/${sessionId}?edit=1`} className="mt-2 inline-flex min-h-11 items-center text-sm text-ink underline underline-offset-4 hover:text-pine">
              Answer more
            </a>
          </div>
        ) : null}
      </section>

      {summary.length > 0 ? <p className="sr-only">Your answers: {summary.join(', ')}</p> : null}

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {shortlist.picks.map((pick, index) => (
          <PickCard key={pick.id} pick={pick} index={index} image={images[`advisor:${pick.id}`] ?? null} sessionId={sessionId} />
        ))}
      </div>

      <section className="mt-12" aria-labelledby="refine-heading">
        <h2 id="refine-heading" className="font-display text-2xl text-ink">
          Not quite? Nudge it.
        </h2>
        <p className="mt-1 text-sm text-ink-muted">Everything you’ve said stays. One tap re-ranks.</p>
        <div className="mt-4">
          <AdvisorRefineBar sessionId={sessionId} applied={shortlist.changes.length > 0} />
        </div>
      </section>

      {shortlist.alternates.length > 0 ? (
        <section className="mt-12" aria-labelledby="alternates-heading">
          <h2 id="alternates-heading" className="font-display text-2xl text-ink">
            Also worth a look
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shortlist.alternates.map((pick) => (
              <AlternateCard key={pick.id} pick={pick} sessionId={sessionId} />
            ))}
          </div>
        </section>
      ) : null}

      {all.length > 1 ? (
        <details className="mt-12 rounded-[var(--radius-card)] border border-ink/15 p-4 sm:p-5">
          <summary className="min-h-11 cursor-pointer font-display text-xl text-ink">Compare side by side</summary>
          <div className="mt-4">
            <CompareTable picks={all} />
          </div>
        </details>
      ) : null}

      <details className="mt-4 rounded-[var(--radius-card)] border border-ink/15 p-4 sm:p-5">
        <summary className="min-h-11 cursor-pointer font-display text-xl text-ink">How we ranked these</summary>
        <div className="mt-3 space-y-4 text-sm text-ink-muted">
          <p>
            {comparedSentence(stats)} Each card says whether its reading is ours or comes from open travel guides and map data.{' '}
            {setAside > 0 ? `${formatCount(setAside)} were set aside for breaking something you said (wrong season, too far, too demanding…). ` : ''}
            The rest were scored on the factors below; anything you haven’t told us is left out of the score rather than guessed. Then we chose places that are good{' '}
            <em>and</em> different from each other. Fame is never a bonus.
          </p>
          {readout.closeCalls.length > 0 ? <p>Close behind: {readout.closeCalls.join(', ')}.</p> : null}
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-ink/30">
                  <th scope="col" className="py-1.5 pr-3 font-medium text-ink">
                    Factor
                  </th>
                  {shortlist.picks.map((pick) => (
                    <th key={pick.id} scope="col" className="py-1.5 pr-3 font-medium text-ink">
                      {pick.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shortlist.picks[0]?.factors.map((factor) => (
                  <tr key={factor.id} className="border-b border-ink/10 align-top">
                    <th scope="row" className="py-1.5 pr-3 font-normal text-ink">
                      {factor.label}
                    </th>
                    {shortlist.picks.map((pick) => {
                      const mine = pick.factors.find((entry) => entry.id === factor.id);
                      return (
                        <td key={pick.id} className="py-1.5 pr-3">
                          {mine?.value === null || mine === undefined ? <span className="text-ink-faint">not asked</span> : <span className="font-mono text-ink">{Math.round(mine.value * 100)}</span>}
                          {mine && mine.value !== null ? <span className="block text-xs text-ink-faint">{mine.basis}</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs">
            Atlas edition {shortlist.catalogVersion} · built in {formatCount(shortlist.elapsedMs)} ms · weather checked for {stats.climateChecked} of {all.length}, matching our reading for{' '}
            {stats.climateVerified}.
          </p>
        </div>
      </details>

      <footer className="mt-10 rule-top pt-5" aria-label="How this list was made">
        <p data-testid="advisor-readout" className="type-small text-ink-muted">
          {comparedSentence(stats)}
          {stats.research ? ` ${stats.research.note}` : ''}
        </p>
        <DataAttribution className="mt-2 text-[0.8125rem] leading-snug text-ink-muted" />
      </footer>
    </div>
  );
}
