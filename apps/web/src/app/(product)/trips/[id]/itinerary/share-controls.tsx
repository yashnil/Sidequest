'use client';

import { useRef, useState, useTransition } from 'react';
import { buttonClass } from '@/components/ui';
import { createShareLinkAction } from './actions';
import { revokeShareLinkAction, rotateShareLinkAction } from './share-actions';

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
 *
 * V9 §24 — the link can be taken back. Revoke asks twice (the second press
 * is the confirmation, on the same button) and then says exactly what
 * happened: the old link now opens nothing. "Make a new link" replaces the
 * token in one statement, so the old copy dies the instant the new one lives.
 */
export function ShareControl({ tripId, initialPath }: { tripId: string; initialPath?: string | null }) {
  const [url, setUrl] = useState<string | null>(() => (initialPath && typeof window !== 'undefined' ? `${window.location.origin}${initialPath}` : null));
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  if (revoked) {
    return (
      <div className="flex w-full flex-wrap items-center gap-2" data-testid="share-revoked">
        <p className="w-full type-small text-ink">Link revoked. Anyone with the old link now sees nothing.</p>
        <button
          type="button"
          disabled={pending}
          className={buttonClass('secondary', 'sm')}
          data-testid="share-regenerate"
          onClick={() => {
            setStatus(null);
            startTransition(async () => {
              const result = await rotateShareLinkAction(tripId);
              if (!result.ok) {
                setStatus(result.error);
                return;
              }
              setUrl(`${window.location.origin}${result.path}`);
              setCopied(false);
              setRevoked(false);
            });
          }}
        >
          {pending ? 'Making a new link…' : 'Make a new link'}
        </button>
        {status ? (
          <p role="alert" className="w-full text-sm leading-relaxed text-clay">
            {status}
          </p>
        ) : null}
      </div>
    );
  }

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
          <p role="alert" className="w-full text-sm leading-relaxed text-clay">
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
        className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
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
      <button
        type="button"
        disabled={pending}
        aria-pressed={confirming}
        className={buttonClass('ghost', 'sm')}
        data-testid="share-revoke"
        data-confirming={confirming ? 'true' : 'false'}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            setStatus(null);
            return;
          }
          startTransition(async () => {
            const result = await revokeShareLinkAction(tripId);
            setConfirming(false);
            if (!result.ok) {
              setStatus(result.error);
              return;
            }
            setUrl(null);
            setCopied(false);
            setRevoked(true);
          });
        }}
      >
        {pending ? 'Revoking…' : confirming ? 'Press again to revoke this link' : 'Revoke link'}
      </button>
      {confirming ? (
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setConfirming(false)} data-testid="share-revoke-cancel">
          Keep the link
        </button>
      ) : null}
      {status ? (
        <p role="alert" className="w-full text-sm leading-relaxed text-clay">
          {status}
        </p>
      ) : null}
      <p className="w-full text-xs leading-relaxed text-ink-muted">
        Anyone with this link can read the plan — and only read it. Your board and controls stay
        yours. Revoke it and the link opens nothing from that moment.
      </p>
    </div>
  );
}
