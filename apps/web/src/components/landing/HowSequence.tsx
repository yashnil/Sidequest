'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { advance, BASE_INDEX, CHOSEN, HOW_STEPS, HOW_TOUR, STAGE_H, STAGE_W, STILL, stageAt, stagePins, straightLineKm, targetFor, type StageFrame } from './how-sequence';

/**
 * HOW IT WORKS, SCROLLED — one pinned sheet, six steps.
 *
 * Round 3 (2026-10). The section is a tall scroll track holding one panel
 * pinned under the header for its whole length: the step on the left, the
 * stage on the right, both still while the page scrolls. (Round 2 pinned only
 * the stage, which at ~710 px was taller than a laptop window leaves under
 * the header, so the browser could not hold it and it slid with the page —
 * and the captions passed as plain text with nothing between them.) The
 * stage is now sized to the window, never the other way round.
 *
 * Scroll only says which step is being read. The stage then plays to the end
 * of that step on the clock (`advance`, one step per `STEP_SECONDS`), and the
 * step itself changes with an effect: its giant numeral rolls like an
 * odometer, the title and caption leave upward as the next rise in, and the
 * rail beside them fills. Every rail row is a button that scrolls to its
 * step.
 *
 * ## Standing still is the design, not the fallback
 *
 * The server renders `STILL` — every part of the stage — beside the six steps
 * as a list, and that is what a visitor without JavaScript keeps. Reduced
 * motion keeps it too: the tall track, the pin and the panel height are all
 * `motion-safe:` CSS, decided by the media query before any script runs, so
 * under reduced motion the section is simply the list beside the still
 * stage, in the page's flow. The stage is a picture of the product and is
 * hidden from assistive technology; the steps say it.
 */

const STEPS = HOW_STEPS.length;
/* The stage starts a step a little before the panel pins, so it is never empty when it arrives. */
const LEAD = 0.03;

export function HowSequence() {
  const track = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [enhanced, setEnhanced] = useState(false);
  /* What the stage shows (0–1) and where the reader is (0–1, the end of the step being read). */
  const [shown, setShown] = useState(1);
  const [target, setTarget] = useState(1);
  const shownRef = useRef(1);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      const on = !media.matches;
      if (on) {
        /* Arriving mid-page (a reload, a back button) shows the step being read already played — never a replay from empty. */
        const t = targetFor(progressOf(track.current, panel.current) + LEAD);
        shownRef.current = t;
        setShown(t);
        setTarget(t);
      }
      setEnhanced(on);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  /* The reader's place: read from the track on scroll and resize, at most once a frame. */
  useEffect(() => {
    if (!enhanced) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const next = targetFor(progressOf(track.current, panel.current) + LEAD);
      setTarget((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enhanced]);

  /* Play toward the target on the clock, not the scroll wheel: a steady typewriter, pins that land one by one. */
  useEffect(() => {
    if (!enhanced || shownRef.current === target) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const next = advance(shownRef.current, target, Math.min(dt, 0.1));
      shownRef.current = next;
      setShown(next);
      if (next !== target) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enhanced, target]);

  const frame: StageFrame = enhanced ? stageAt(shown) : STILL;
  /* The step being read (the first one until the panel arrives), and how much of it the stage has played. */
  const reading = enhanced ? Math.max(0, Math.round(target * STEPS) - 1) : -1;
  const played = reading < 0 ? 0 : Math.min(1, Math.max(0, shown * STEPS - reading));

  /* A rail row is a door: it scrolls the track to the middle of that step. */
  const goTo = (i: number) => {
    const t = track.current;
    const pn = panel.current;
    if (!t || !pn) return;
    const pin = parseFloat(getComputedStyle(pn).top) || 0;
    const travel = Math.max(1, t.offsetHeight - pn.offsetHeight);
    const top = window.scrollY + t.getBoundingClientRect().top - pin + ((i + 0.5) / STEPS - LEAD) * travel;
    window.scrollTo({ top, behavior: 'smooth' });
  };

  return (
    <div ref={track} className="relative mt-10 sm:mt-12 motion-safe:h-[calc(100svh+6*48svh)]" data-testid="how-sequence" data-enhanced={enhanced ? 'true' : 'false'}>
      <div
        ref={panel}
        className="grid min-w-0 content-center gap-x-14 gap-y-5 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:items-center motion-safe:sticky motion-safe:top-[var(--chrome-height)] motion-safe:h-[calc(100svh-var(--chrome-height)-4.5rem)] motion-safe:overflow-hidden motion-safe:py-4 sm:motion-safe:h-[calc(100svh-var(--chrome-height))] lg:motion-safe:py-8"
      >
        {/* All six steps, in words, for assistive technology — the animated copies below are decoration. */}
        <ol className="sr-only">
          {HOW_STEPS.map((step) => (
            <li key={step.n}>
              {step.title}. {step.caption}
            </li>
          ))}
        </ol>

        {enhanced ? (
          <div aria-hidden="true" className="min-w-0 lg:order-1">
            <StepRail reading={reading} played={played} goTo={goTo} />
            <div className="mt-5 flex min-w-0 items-start gap-5 lg:mt-10 lg:block">
              {/* The numeral rolls: the old one leaves upward as the new one rises from below, inside a clipped window. */}
              <div className="relative h-[4.2rem] w-[5.5rem] shrink-0 overflow-hidden lg:h-[8.5rem] lg:w-auto">
                {HOW_STEPS.map((step, i) => (
                  <span key={step.n} className="numeral-giant absolute top-0 left-0 block text-[4.2rem] leading-none text-flare transition-[transform,opacity] ease-[cubic-bezier(0.2,0.8,0.2,1)] lg:text-[8.5rem]" style={swap(i, reading, 140)}>
                    {step.n}
                  </span>
                ))}
              </div>
              <div className="grid min-w-0 flex-1 lg:mt-6">
                {HOW_STEPS.map((step, i) => (
                  <div key={step.n} className="col-start-1 row-start-1 min-w-0 transition-[transform,opacity] ease-[cubic-bezier(0.2,0.8,0.2,1)]" style={swap(i, reading, 28, 'px')}>
                    <p className="font-display text-[1.9rem] leading-[1.02] tracking-[-0.02em] text-ink sm:text-[2.2rem] lg:text-[3rem]">{step.title}</p>
                    <p className="mt-3 max-w-md type-body text-ink-muted lg:text-lg">{step.caption}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <ol aria-hidden="true" className="min-w-0 border-t-[1.5px] border-ink lg:order-1">
            {HOW_STEPS.map((step) => (
              <li key={step.n} className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] gap-x-4 border-b border-ink/15 py-5">
                <span className="sheet-label pt-1.5 text-ink-faint">{step.n}</span>
                <span className="block min-w-0">
                  <span className="block font-display text-[1.5rem] leading-tight tracking-[-0.015em] text-ink">{step.title}</span>
                  <span className="mt-1 block max-w-sm type-small text-ink-muted">{step.caption}</span>
                </span>
              </li>
            ))}
          </ol>
        )}

        {/* The stage, as large as the window allows: its height is about 0.53 × its width plus 315 px of field and fragments, so its width is set from the panel's height and it is never taller than the screen. */}
        <div className="min-w-0 justify-self-end lg:order-2 lg:w-[min(100%,calc((100svh-var(--chrome-height)-4rem-330px)*1.85))] max-lg:w-full">
          <Stage frame={frame} reading={reading} shown={enhanced ? shown : 1} />
        </div>
      </div>
    </div>
  );
}

/**
 * How a step's numeral or caption enters and leaves. The outgoing one goes
 * up and out quickly; the incoming one rises from below once it has gone, so
 * the two are never legible on top of each other.
 */
function swap(i: number, reading: number, travel: number, unit: '%' | 'px' = '%'): CSSProperties {
  const current = i === reading;
  const offset = i < reading ? -travel : i > reading ? travel : 0;
  return {
    transform: `translateY(${offset}${unit})`,
    opacity: current ? 1 : 0,
    transitionDuration: current ? '620ms' : '260ms',
    transitionDelay: current ? '200ms' : '0ms',
  };
}

/** Where the reader is through the pinned track, 0–1 (below 0 before the panel pins). */
function progressOf(track: HTMLElement | null, panel: HTMLElement | null): number {
  if (!track || !panel) return 0;
  const pin = parseFloat(getComputedStyle(panel).top) || 0;
  const travel = track.offsetHeight - panel.offsetHeight;
  if (travel <= 0) return 1;
  return (pin - track.getBoundingClientRect().top) / travel;
}

/** The six steps as a rail: the one being read is ink with a flare rule filling under it; the rest are doors. */
function StepRail({ reading, played, goTo }: { reading: number; played: number; goTo: (i: number) => void }) {
  return (
    <div className="grid grid-cols-6 gap-1.5 lg:gap-2">
      {HOW_STEPS.map((step, i) => {
        const current = i === reading;
        const done = i < reading;
        return (
          <button key={step.n} type="button" tabIndex={-1} onClick={() => goTo(i)} className="group min-w-0 cursor-pointer pt-2 text-left" aria-label={`Step ${step.n}: ${step.title}`}>
            <span className="relative block h-[2px] overflow-hidden bg-ink/15">
              <span className="absolute inset-0 origin-left bg-flare transition-transform duration-200 ease-linear" style={{ transform: `scaleX(${done ? 1 : current ? played : 0})` }} />
            </span>
            <span className={`mt-2 block font-mono text-[0.68rem] tracking-[0.1em] uppercase transition-colors duration-300 ${current ? 'text-ink' : done ? 'text-ink-muted' : 'text-ink-faint group-hover:text-ink-muted'}`}>
              {step.n}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const PINS = stagePins();
const CHOSEN_SET = new Set<number>(CHOSEN);
const ORDER = CHOSEN.map((i) => PINS[i]!);
const ORDER_POINTS = ORDER.map((p) => `${p.x},${p.y}`).join(' ');

function Stage({ frame, reading, shown }: { frame: StageFrame; reading: number; shown: number }) {
  const pins = PINS;
  const chosen = CHOSEN_SET;
  const typed = HOW_TOUR.prompt.slice(0, frame.chars);
  const typing = frame.chars > 0 && frame.chars < HOW_TOUR.prompt.length;
  const named = frame.chars === HOW_TOUR.prompt.length;
  return (
    <div aria-hidden="true" className="survey-night relative isolate min-w-0 overflow-hidden border border-ink/80 text-[var(--color-atlas-ink)] [--survey-cell:60px] ">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/12 px-4 py-2.5 sm:px-5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="sheet-label shrink-0 text-[var(--color-glacier)]">Live demo</span>
          <span className="coordbar truncate text-[var(--color-atlas-muted)]">{HOW_TOUR.prompt}</span>
        </span>
        <span className="coordbar shrink-0 text-[var(--color-atlas-ink)]">
          {reading >= 0 ? (
            <>
              <span className="max-sm:hidden">{HOW_STEPS[reading]!.doing} · </span>
              {Number(HOW_STEPS[reading]!.n)} of {HOW_STEPS.length}
            </>
          ) : (
            'Six steps'
          )}
        </span>
      </div>

      {/* Where the sequence is: six segments that fill as the stage plays. */}
      <div className="grid grid-cols-6 gap-1 px-4 pt-2.5 sm:px-5">
        {HOW_STEPS.map((step, i) => (
          <span key={step.n} className="relative h-[3px] overflow-hidden bg-white/10">
            <span className="absolute inset-0 origin-left bg-[var(--color-flare)]" style={{ transform: `scaleX(${Math.min(1, Math.max(0, shown * HOW_STEPS.length - i))})` }} />
          </span>
        ))}
      </div>

      {/* 01 — the destination, typed on its hairline. */}
      <div className="px-4 pt-4 sm:px-5">
        <span className="sheet-label text-[var(--color-atlas-muted)]">Where to?</span>
        <div className="mt-1 flex min-w-0 items-end gap-3 border-b border-white/30 pb-1.5">
          <span className="min-h-9 min-w-0 flex-1 truncate font-display text-[1.45rem] leading-tight italic sm:text-[1.7rem]">
            {typed}
            <span className={`ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.18em] bg-[var(--color-flare)] ${typing ? 'animate-pulse' : 'opacity-0'}`} />
            {frame.chars === 0 ? <span className="text-[var(--color-atlas-muted)]/70">Dolomites in July</span> : null}
          </span>
          <span className={`inline-flex min-h-9 shrink-0 items-center rounded-full px-4 text-xs font-semibold transition-colors duration-[var(--motion-base)] ${named ? 'bg-[var(--color-flare)] text-[var(--color-night)]' : 'bg-white/10 text-[var(--color-atlas-muted)]'}`}>Start →</span>
        </div>
      </div>

      {/* 03–05 — the candidates, the choice and the order, on the example's real geography. */}
      <div className="relative mx-2 mt-2 overflow-hidden sm:mx-3" style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}` }}>
        <svg viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} className="absolute inset-0 h-full w-full">
          <defs>
            <mask id="how-route-draw" maskUnits="userSpaceOnUse">
              <polyline points={ORDER_POINTS} fill="none" stroke="#fff" strokeWidth={14} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - frame.route} />
            </mask>
          </defs>
          {/* Survey ticks where the example's towns are: the ground is never blank, and nothing is claimed until a pin lands. */}
          {pins.map((pin, i) => (
            <g key={pin.name} stroke="var(--color-atlas-muted)" strokeWidth={1} opacity={i < frame.pins ? 0 : named ? 0.55 : 0.28} className="transition-opacity duration-500">
              <line x1={pin.x - 5} y1={pin.y} x2={pin.x + 5} y2={pin.y} />
              <line x1={pin.x} y1={pin.y - 5} x2={pin.x} y2={pin.y + 5} />
            </g>
          ))}
          <polyline points={ORDER_POINTS} fill="none" stroke="var(--color-flare)" strokeWidth={2.6} strokeDasharray="0.1 8" strokeLinecap="round" strokeLinejoin="round" mask="url(#how-route-draw)" />
        </svg>
        {/* The one honesty note the demo needs, in plain words. */}
        <span className="coordbar absolute right-2 bottom-1 text-[var(--color-atlas-muted)]">Demo · lines are straight, not roads</span>
        <span className={`pointer-events-none absolute top-1/2 left-1/2 aspect-square w-[46%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--color-glacier)]/50 transition-[opacity,transform] duration-[1400ms] ease-out ${frame.scanning ? 'scale-150 opacity-100' : 'scale-50 opacity-0'}`} />
        {pins.map((pin, i) => {
          const shown = i < frame.pins;
          const state = !frame.chosen ? 'idle' : i === BASE_INDEX ? 'base' : chosen.has(i) ? 'chosen' : 'muted';
          return (
            <span
              key={pin.name}
              className="absolute"
              style={{
                left: `${((pin.x / STAGE_W) * 100).toFixed(2)}%`,
                top: `${((pin.y / STAGE_H) * 100).toFixed(2)}%`,
                /* The pin's own centre sits on the town; the name hangs below it, or above when a neighbour is just below. */
                transform: `translate(-50%, ${pin.labelAbove ? `calc(-100% + ${state === 'muted' ? 7 : 13}px)` : `-${state === 'muted' ? 7 : 13}px`})`,
              }}
            >
              <span className={`flex items-center gap-1 transition-[opacity,transform] duration-[var(--motion-base)] ${pin.labelAbove ? 'flex-col-reverse' : 'flex-col'} ${shown ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}>
                <span className="atlas-pin pointer-events-none" data-state={state === 'idle' ? undefined : state}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className={`font-mono text-[9.5px] tracking-[0.12em] whitespace-nowrap uppercase transition-opacity duration-[var(--motion-base)] ${state === 'muted' ? 'text-[var(--color-atlas-muted)] line-through decoration-white/40' : 'text-[var(--color-atlas-ink)]/85'}`}>{pin.name}</span>
              </span>
            </span>
          );
        })}
        {/* One counter slot: the scan's real-counter while it runs (never a percentage), then what the choice left. */}
        <span className="coordbar absolute bottom-1 left-2 text-[var(--color-atlas-muted)]">
          {frame.scanning ? <span className="text-[var(--color-glacier)]">Finding places · {frame.pins} of {HOW_TOUR.stops.length}</span> : frame.chosen ? `${CHOSEN.length} picked · ${HOW_TOUR.stops.length - CHOSEN.length} skipped` : frame.pins === 0 ? (named ? 'Searching the map…' : 'Type a place to begin') : null}
        </span>
      </div>

      {/* 02 and 06 — the sheet fragments, side by side on a wide screen. */}
      <div className="grid min-w-0 gap-3 px-4 pt-2 pb-4 max-lg:hidden sm:px-5 lg:grid-cols-2">
        <Reveal on={frame.question} label="A question appears here">
          <QuestionFragment answered={frame.answered} />
        </Reveal>
        <Reveal on={frame.day} label="Your day appears here">
          <DayFragment />
        </Reveal>
      </div>
    </div>
  );
}

/** A fragment's slot is drawn before the fragment arrives — an outlined place on the sheet, never a hole. */
function Reveal({ on, label, children }: { on: boolean; label: string; children: ReactNode }) {
  return (
    <div className="relative min-w-0">
      <div className={`absolute inset-0 flex items-start border border-dashed border-white/18 px-3.5 pt-3 transition-opacity duration-[var(--motion-base)] ${on ? 'opacity-0' : 'opacity-100'}`}>
        <span className="coordbar text-[var(--color-atlas-muted)]">{label}</span>
      </div>
      <div className={`min-w-0 transition-[opacity,transform] duration-[var(--motion-figure)] ${on ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}>{children}</div>
    </div>
  );
}

function QuestionFragment({ answered }: { answered: boolean }) {
  return (
    <div className="survey min-w-0 border-t-[1.5px] border-ink bg-paper-raised px-3.5 pt-3 pb-3.5 text-ink [--survey-cell:32px]">
      <p className="coordbar text-ink-muted">A quick question</p>
      <p className="mt-2 font-display text-[1.3rem] leading-[1.08] tracking-[-0.015em]">How full should a day feel?</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {['Easy', 'Balanced', 'Full'].map((word) => (
          <span key={word} className={`chip-in px-2.5 transition-colors duration-[var(--motion-fast)] ${word === 'Balanced' && answered ? '!border-flare bg-flare text-night' : 'text-ink'}`}>
            {word}
          </span>
        ))}
      </div>
    </div>
  );
}

function DayFragment() {
  const [a, b] = [HOW_TOUR.stops[1]!, HOW_TOUR.stops[2]!];
  const km = straightLineKm(a, b);
  return (
    <div className="min-w-0 border-t-[1.5px] border-ink bg-paper-raised px-3.5 pt-3 pb-3.5 text-ink">
      <div className="flex min-w-0 items-end gap-3">
        <span className="numeral-giant shrink-0 text-[3.4rem] leading-[0.8]">02</span>
        <p className="min-w-0 truncate pb-0.5 font-display text-[1.15rem] leading-tight">
          {a.name} <span className="text-ink-faint">→</span> {b.name}
        </p>
      </div>
      <ol className="mt-3 grid gap-1.5 text-sm">
        <li className="flex min-w-0 items-center gap-2.5">
          <span className="atlas-pin pointer-events-none shrink-0 scale-90" data-state="chosen">
            02
          </span>
          <span className="truncate">{a.name}</span>
        </li>
        <li className="flex min-w-0 items-center gap-2.5 pl-3">
          <span className="inline-block h-5 w-0 shrink-0 border-l-2 border-dashed border-[var(--color-route)]" />
          <span className="coordbar min-w-0 !whitespace-normal text-ink-muted">about {km} km · drive time estimated</span>
        </li>
        <li className="flex min-w-0 items-center gap-2.5">
          <span className="atlas-pin pointer-events-none shrink-0 scale-90" data-state="chosen">
            03
          </span>
          <span className="truncate">{b.name}</span>
        </li>
      </ol>
    </div>
  );
}
