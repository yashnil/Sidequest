/**
 * The destination field, as the front page sets it and as the trips home
 * repeats it. A plain GET form into the setup flow's own prefill
 * (`?destination=`), so it works before hydration and with JavaScript off.
 *
 * Set as a typed line on a hairline — the way the survey sheet asks a
 * question — with the one flare action at its end. Night ground only.
 */
export function DestinationLine({ id, label = 'Where to?', placeholder = 'Dolomites in July', className = '', size = 'hero' }: { id: string; label?: string; placeholder?: string; className?: string; size?: 'hero' | 'compact' }) {
  return (
    <form action="/trips/new" method="get" className={`group w-full max-w-[34rem] ${className}`} role="search" aria-label="Start a trip">
      <label htmlFor={id} className="sheet-label text-[var(--color-atlas-muted)]">
        {label}
      </label>
      <div className="mt-1 flex min-w-0 items-end gap-3 border-b border-white/30 pb-2 transition-colors duration-[var(--motion-fast)] focus-within:border-[var(--color-flare)] hover:border-white/55">
        <input
          id={id}
          name="destination"
          type="text"
          autoComplete="off"
          placeholder={placeholder}
          className={`min-h-12 min-w-0 flex-1 bg-transparent font-display leading-tight text-[var(--color-atlas-ink)] italic caret-[var(--color-flare)] placeholder:text-[var(--color-atlas-muted)]/70 focus:outline-none ${size === 'hero' ? 'text-[1.65rem] sm:text-[1.9rem]' : 'text-[1.4rem] sm:text-[1.55rem]'}`}
          data-testid={id}
        />
        <button type="submit" className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full bg-[var(--color-flare)] px-5 text-sm font-semibold text-[var(--color-night)] transition-transform duration-[var(--motion-fast)] hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2">
          Start
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </form>
  );
}
