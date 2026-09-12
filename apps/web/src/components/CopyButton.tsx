'use client';

import { useState } from 'react';
import { buttonClass, cx } from './ui';

/**
 * COPY, HONESTLY.
 *
 * The clipboard is not available everywhere this app renders — an HTTP dev
 * origin, an embedded browser, a permission a traveller declined — and a
 * button whose only output is "Copied" would then lie. When the write fails
 * the text is shown selected in a field so the traveller can copy it
 * themselves, and the button says so.
 */
export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  variant = 'secondary',
  size = 'sm',
  className,
  testId,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  testId?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'blocked'>('idle');
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={cx(buttonClass(variant, size), className)}
        aria-live="polite"
        data-state={state}
        {...(testId ? { 'data-testid': testId } : {})}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState('copied');
          } catch {
            setState('blocked');
          }
        }}
      >
        {state === 'copied' ? copiedLabel : label}
      </button>
      {state === 'blocked' ? (
        <input
          readOnly
          aria-label="Copy this yourself"
          value={text}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
        />
      ) : null}
    </span>
  );
}
