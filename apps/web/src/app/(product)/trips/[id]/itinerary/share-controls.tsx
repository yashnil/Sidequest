'use client';

import { useRef, useState, useTransition } from 'react';
import { buttonClass } from '@/components/ui';
import { createShareLinkAction } from './actions';

/**
 * THE SHARE AFFORDANCE: ONE BUTTON, THEN THE LINK ITSELF.
 *
 * Beside the server action it calls, like `edit-controls`, because it is
 * meaningless anywhere but on the owner's itinerary page. The link is shown in
 * a plain input rather than silently copied: a control whose only output is a
 * toast leaves the traveller unable to *see* what they are about to send, and
 * the clipboard is not available in every context this page renders in. Copy
 * is offered on top, and when the clipboard refuses, the link is selected and
 * the button says so — the honest fallback rather than a lying "Copied".
 *
 * The path comes back relative and is completed with the browser's own origin,
 * so the link a traveller copies always points at the deployment they are
 * looking at.
 */
export function ShareControl({ tripId }: { tripId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  if (url === null) {
    return (
      <>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setStatus(null);
            startTransition(async () => {
              const result = await createShareLinkAction(tripId);
              if (!result.ok || !result.path) {
                setStatus(result.error ?? 'We could not make a link just then. Try again.');
                return;
              }
              setUrl(`${window.location.origin}${result.path}`);
            });
          }}
          className={buttonClass('secondary', 'sm')}
        >
          {pending ? 'Making a link…' : 'Share this plan'}
        </button>
        {status ? (
          <p role="alert" className="w-full text-xs leading-relaxed text-clay">
            {status}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        readOnly
        aria-label="Share link"
        value={url}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 rounded-lg border border-rule bg-paper-raised px-3 py-2 text-xs text-ink"
      />
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setStatus(null);
          } catch {
            inputRef.current?.select();
            setCopied(false);
            setStatus('Copying is blocked here — the link is selected, so copy it yourself.');
          }
        }}
        className={buttonClass('secondary', 'sm')}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
      {status ? (
        <p role="alert" className="w-full text-xs leading-relaxed text-clay">
          {status}
        </p>
      ) : null}
      <p className="w-full text-xs leading-relaxed text-ink-faint">
        Anyone with this link can read the plan — and only read it. Your board and controls stay
        yours.
      </p>
    </div>
  );
}
