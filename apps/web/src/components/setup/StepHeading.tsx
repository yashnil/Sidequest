import type { ReactNode, RefObject } from 'react';

/**
 * The head of every setup screen: the kicker, one display sentence, and the
 * giant light numeral as texture at the right edge. The same frame the
 * interview's questions use, because they are the same conversation.
 *
 * The numeral used to sit at the left, directly under the kicker, and the two
 * collided ("NEW TRIP · WHERE" printed across the strokes of "01"). It now
 * sits flush right, behind the headline only, where it reads as a page number
 * rather than as type somebody has to read through.
 */
export function StepHeading({ number, kicker, headingRef, children }: { number: number; kicker: string; headingRef: RefObject<HTMLHeadingElement | null>; children: ReactNode }) {
  return (
    <div className="relative pt-[clamp(1.5rem,0.6rem+3vw,3.5rem)]">
      <QuestionNumeral value={String(number).padStart(2, '0')} />
      <div className="relative">
        <p className="sheet-label inline-flex items-center gap-2 text-accent">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
          {kicker}
        </p>
        <h1 ref={headingRef} tabIndex={-1} className="ob-headline mt-3 max-w-[18ch] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
          <span className="mask-rise pb-[0.14em]">
            <span>{children}</span>
          </span>
        </h1>
      </div>
    </div>
  );
}

/** The light page number behind a question — decoration, never read. */
export function QuestionNumeral({ value }: { value: string }) {
  return (
    <span aria-hidden="true" className="numeral-giant ob-numeral pointer-events-none absolute -top-2 right-0 select-none leading-[0.8]">
      {value}
    </span>
  );
}

/**
 * A filled flare action that is not available yet.
 *
 * The shared accent button fades to 50 % when disabled, which on cream turned
 * the one primary action into a washed-out salmon pill that looked broken
 * rather than waiting. Not-yet-available is drawn as a quiet outlined pill
 * instead: clearly a button, clearly not pressable, no flare until it can be.
 */
export const ACCENT_WAITING =
  'disabled:opacity-100! disabled:bg-transparent disabled:text-ink-faint disabled:shadow-none disabled:ring-1 disabled:ring-inset disabled:ring-ink/20';
