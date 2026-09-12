'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRefresh } from '../use-refresh';
import { BOOKED_ITEM_TYPES, BOOKED_ITEM_TYPE_LABELS, type BookedItemType, type ExtractedConfirmation } from '@sidequest/core';
import type { BookingImport } from '@/lib/db/execution-repository';
import { ErrorNote, buttonClass, cx } from '../ui';
import { confirmImportAction, discardImportAction, importConfirmationAction, previewImportAction, readImportWithSidequestAction, type ImportActionResult, type ImportCandidate } from '@/app/(product)/trips/[id]/itinerary/actions';
import { CONFIDENCE_WORD, IMPORT_FIELD_LABEL, PAID_WORD, REFUNDABLE_WORD } from './booking-copy';

/**
 * V9 §6 — THE IMPORT CENTRE.
 *
 * Paste a confirmation or choose a file; Sidequest reads it without a model
 * and shows every fact it found with how sure it is and the words it came
 * from. The traveller corrects the lines, sees what confirming would change
 * on the plan, and only then confirms — nothing on the trip changes before
 * that press. "Ask Sidequest to read it" is a separate, explicit press that
 * spends one bounded reading; it is never automatic.
 *
 * The document itself lives only in this component's state for as long as the
 * review is open, so the explicit press can send it again; the row on disk
 * holds the redacted facts and nothing else.
 */
const FIELD = 'mt-1 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine';
const GHOST = buttonClass('ghost', 'sm');
const MAX_FILE_BYTES = 4 * 1024 * 1024;

interface ImportSource {
  kind: 'text' | 'file';
  text?: string;
  fileBase64?: string;
  filename?: string;
}

interface Review {
  importId: string;
  extracted: ExtractedConfirmation;
  summary: string;
  photo: boolean;
  modelUsed: boolean;
  /** The document, kept only so the explicit press can send it; absent for an import resumed from disk. */
  source: ImportSource | null;
}

export interface ImportCenterProps {
  tripId: string;
  tripStart: string;
  tripEnd: string;
  pendingImports: readonly BookingImport[];
  bases: readonly { id: string; name: string }[];
}

function candidateFrom(extracted: ExtractedConfirmation): ImportCandidate {
  return {
    type: extracted.type,
    title: extracted.title ?? '',
    ...(extracted.date ? { date: extracted.date } : {}),
    ...(extracted.endDate ? { endDate: extracted.endDate } : {}),
    ...(extracted.startTime ? { startTime: extracted.startTime } : {}),
    ...(extracted.endTime ? { endTime: extracted.endTime } : {}),
    ...(extracted.timeZone ? { timeZone: extracted.timeZone } : {}),
    ...(extracted.location ? { location: extracted.location } : {}),
    ...(extracted.provider ? { provider: extracted.provider } : {}),
    ...(extracted.confirmationRef ? { confirmationRef: extracted.confirmationRef } : {}),
    ...(extracted.cost ? { cost: extracted.cost } : {}),
    ...(extracted.cancellationDeadline ? { cancellationDeadline: extracted.cancellationDeadline } : {}),
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^;]*;base64,/, ''));
    reader.readAsDataURL(file);
  });
}

export function ImportCenter({ tripId, tripStart, tripEnd, pendingImports, bases }: ImportCenterProps) {
  const refresh = useRefresh();
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ base64: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = (result: ImportActionResult, source: ImportSource | null) => {
    if (!result.ok || !result.importId || !result.extracted) {
      setError(result.error ?? 'That could not be read.');
      return;
    }
    setError(null);
    setReview({ importId: result.importId, extracted: result.extracted, summary: result.summary ?? '', photo: Boolean(result.photo), modelUsed: Boolean(result.modelUsed), source });
  };

  function submit() {
    setError(null);
    const source: ImportSource = file ? { kind: 'file', fileBase64: file.base64, filename: file.name } : { kind: 'text', text };
    if (source.kind === 'text' && text.trim().length === 0) {
      setError('Paste the confirmation, or choose a file.');
      return;
    }
    startTransition(async () => accept(await importConfirmationAction(tripId, source), source));
  }

  async function chooseFile(chosen: File | null) {
    setError(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    if (chosen.size > MAX_FILE_BYTES) {
      setError('That file is larger than Sidequest reads (4 MB). Paste the text instead.');
      setFile(null);
      return;
    }
    try {
      setFile({ base64: await fileToBase64(chosen), name: chosen.name });
    } catch {
      setError('That file could not be read from this device.');
      setFile(null);
    }
  }

  const reset = () => {
    setReview(null);
    setText('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    refresh();
  };

  return (
    <section className="card mt-8 p-5 print:hidden" aria-labelledby="import-center-heading" data-testid="import-center">
      <h3 id="import-center-heading" className="type-section text-ink">
        Add a confirmation
      </h3>
      <p className="mt-1 text-sm text-ink-muted">Paste the e-mail, or choose the file. Sidequest reads the booking out of it, shows you what it found, and changes nothing until you confirm. Card numbers, phone numbers and e-mail addresses are removed before anything is kept.</p>
      {review ? (
        <ImportReview key={review.importId} tripId={tripId} review={review} tripStart={tripStart} tripEnd={tripEnd} bases={bases} onDone={reset} onReplace={(next) => setReview(next)} />
      ) : (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="text-sm text-ink">
            Confirmation text
            <textarea name="text" value={text} onChange={(e) => setText(e.target.value)} rows={6} maxLength={600_000} placeholder="Paste the whole confirmation e-mail here" className={cx(FIELD, 'font-mono text-xs leading-relaxed')} data-testid="import-text" />
          </label>
          <label className="text-sm text-ink">
            Or a file <span className="text-ink-faint">(.eml, .pdf, or a photo up to 4 MB)</span>
            <input ref={fileInput} name="file" type="file" accept=".eml,.pdf,.png,.jpg,.jpeg,message/rfc822,application/pdf,image/png,image/jpeg" onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)} className={cx(FIELD, 'py-2 file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-paper-sunk file:px-3 file:py-1.5 file:text-sm')} data-testid="import-file" />
          </label>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={pending} className={buttonClass('primary', 'sm')} data-testid="import-submit">
              {pending ? 'Reading…' : 'Read this confirmation'}
            </button>
            {file ? <span className="text-sm text-ink-muted">{file.name}</span> : null}
          </div>
          {pendingImports.length > 0 ? (
            <div className="mt-2 border-t border-rule pt-3" data-testid="import-pending">
              <p className="type-meta">Waiting for your review</p>
              <ul className="mt-1 divide-y divide-rule text-sm">
                {pendingImports.map((imp) => (
                  <li key={imp.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="text-ink">
                      {imp.extracted.title ?? BOOKED_ITEM_TYPE_LABELS[imp.extracted.type]}
                      {imp.extracted.date ? <span className="text-ink-muted"> · {imp.extracted.date}</span> : null}
                    </span>
                    <button type="button" className={GHOST} onClick={() => setReview({ importId: imp.id, extracted: imp.extracted, summary: '', photo: imp.sourceKind === 'image', modelUsed: imp.modelUsed, source: null })} data-testid="import-resume">
                      Review
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

function ImportReview({ tripId, review, tripStart, tripEnd, bases, onDone, onReplace }: { tripId: string; review: Review; tripStart: string; tripEnd: string; bases: readonly { id: string; name: string }[]; onDone: () => void; onReplace: (next: Review) => void }) {
  /* Mounted fresh per reading (`key={review.importId}` above), so the candidate starts from what was read. */
  const [candidate, setCandidate] = useState<ImportCandidate>(() => candidateFrom(review.extracted));
  /* The preview, remembered with the input it answered; a stale answer is simply not shown. */
  const [preview, setPreview] = useState<{ key: string; summary: string; conflicts: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [reading, startReading] = useTransition();
  const lodging = candidate.type === 'lodging';

  /* What confirming would change, computed once the candidate is complete enough to apply. */
  const previewKey = `${candidate.type}|${candidate.title}|${candidate.date ?? ''}|${candidate.endDate ?? ''}|${candidate.startTime ?? ''}|${candidate.endTime ?? ''}|${candidate.baseId ?? ''}|${candidate.location ?? ''}`;
  const complete = Boolean(candidate.title && candidate.date);
  const affected = preview && preview.key === previewKey ? preview : null;
  useEffect(() => {
    if (!complete) return;
    let live = true;
    void previewImportAction(tripId, candidate).then((result) => {
      if (!live || !result.ok) return;
      setPreview({ key: previewKey, summary: result.summary ?? '', conflicts: result.conflicts ?? [] });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, previewKey, complete]);

  const set = <K extends keyof ImportCandidate>(key: K, value: ImportCandidate[K] | undefined) => setCandidate((c) => {
    const next = { ...c };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    return next;
  });

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await confirmImportAction(tripId, review.importId, candidate);
      if (!result.ok) {
        setError(result.error ?? 'That could not be saved.');
        return;
      }
      onDone();
    });
  };
  const discard = () => {
    setError(null);
    startTransition(async () => {
      await discardImportAction(tripId, review.importId);
      onDone();
    });
  };
  const askSidequest = () => {
    if (!review.source) return;
    setError(null);
    startReading(async () => {
      const result = await readImportWithSidequestAction(tripId, review.importId, review.source);
      if (!result.ok || !result.importId || !result.extracted) {
        setError(result.error ?? 'Sidequest could not read that just now.');
        return;
      }
      onReplace({ importId: result.importId, extracted: result.extracted, summary: result.summary ?? '', photo: false, modelUsed: true, source: review.source });
    });
  };

  return (
    <div className="mt-4" data-testid="import-review" data-model-used={review.modelUsed ? 'yes' : 'no'}>
      <p className="text-sm text-ink">{review.summary || 'Check each line before confirming.'}</p>
      {review.extracted.fields.length > 0 ? (
        <ul className="mt-3 divide-y divide-rule text-sm" data-testid="import-fields">
          {review.extracted.fields.map((field) => (
            <li key={`${field.key}:${field.value}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2" data-testid="import-field" data-key={field.key} data-confidence={field.confidence}>
              <span className="text-ink">
                <span className="font-medium">{IMPORT_FIELD_LABEL[field.key] ?? field.key}</span> · {field.value}
              </span>
              <span className={cx('text-xs', field.confidence === 'high' ? 'text-pine' : field.confidence === 'medium' ? 'text-amber' : 'text-clay')}>{CONFIDENCE_WORD[field.confidence]}</span>
              <span className="basis-full type-meta">from “{field.evidence.slice(0, 140)}”</span>
            </li>
          ))}
        </ul>
      ) : null}
      {review.extracted.gaps.length > 0 ? <p className="mt-2 text-sm text-ink-muted">Not found: {review.extracted.gaps.join(' · ')}.</p> : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-ink">
          Kind
          <select value={candidate.type} onChange={(e) => set('type', e.target.value as BookedItemType)} className={FIELD} data-testid="import-edit-type">
            {BOOKED_ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {BOOKED_ITEM_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink">
          Name
          <input value={candidate.title} maxLength={160} onChange={(e) => set('title', e.target.value)} className={FIELD} data-testid="import-edit-title" />
        </label>
        <label className="text-sm text-ink">
          {lodging ? 'Check-in' : 'Date'}
          <input type="date" value={candidate.date ?? ''} min={tripStart} max={tripEnd} onChange={(e) => set('date', e.target.value)} className={FIELD} data-testid="import-edit-date" />
        </label>
        {lodging ? (
          <label className="text-sm text-ink">
            Check-out
            <input type="date" value={candidate.endDate ?? ''} min={tripStart} max={tripEnd} onChange={(e) => set('endDate', e.target.value)} className={FIELD} data-testid="import-edit-end-date" />
          </label>
        ) : (
          <label className="text-sm text-ink">
            Starts
            <input type="time" value={candidate.startTime ?? ''} onChange={(e) => set('startTime', e.target.value)} className={FIELD} />
          </label>
        )}
        {!lodging ? (
          <label className="text-sm text-ink">
            Ends
            <input type="time" value={candidate.endTime ?? ''} onChange={(e) => set('endTime', e.target.value)} className={FIELD} />
          </label>
        ) : null}
        {lodging && bases.length > 0 ? (
          <label className="text-sm text-ink">
            Which base it covers
            <select value={candidate.baseId ?? ''} onChange={(e) => set('baseId', e.target.value)} className={FIELD} data-testid="import-edit-base">
              <option value="">Let the dates decide</option>
              {bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="text-sm text-ink">
          {lodging ? 'Town or area' : 'Where'}
          <input value={candidate.location ?? ''} maxLength={160} onChange={(e) => set('location', e.target.value)} className={FIELD} />
        </label>
        <label className="text-sm text-ink">
          Booked with
          <input value={candidate.provider ?? ''} maxLength={80} onChange={(e) => set('provider', e.target.value)} className={FIELD} />
        </label>
        <label className="text-sm text-ink">
          Confirmation reference
          <input value={candidate.confirmationRef ?? ''} maxLength={80} autoComplete="off" onChange={(e) => set('confirmationRef', e.target.value)} className={FIELD} data-testid="import-edit-ref" />
        </label>
        <label className="text-sm text-ink">
          Amount
          <span className="mt-1 flex gap-2">
            <input type="number" min={0} step={1} value={candidate.cost?.amount ?? ''} onChange={(e) => set('cost', e.target.value === '' ? undefined : { amount: Number(e.target.value), currency: candidate.cost?.currency ?? 'USD' })} className={cx(FIELD, 'mt-0')} aria-label="Amount" />
            <input value={candidate.cost?.currency ?? 'USD'} maxLength={8} onChange={(e) => set('cost', { amount: candidate.cost?.amount ?? 0, currency: e.target.value.toUpperCase() })} className={cx(FIELD, 'mt-0 w-24 uppercase')} aria-label="Currency" />
          </span>
        </label>
        <label className="text-sm text-ink">
          Paid
          <select value={candidate.paid ?? ''} onChange={(e) => set('paid', (e.target.value || undefined) as ImportCandidate['paid'])} className={FIELD}>
            <option value="">Not recorded</option>
            <option value="paid">{PAID_WORD.paid}</option>
            <option value="deposit">{PAID_WORD.deposit}</option>
            <option value="unpaid">{PAID_WORD.unpaid}</option>
          </select>
        </label>
        <label className="text-sm text-ink">
          Refund terms
          <select value={candidate.refundable ?? ''} onChange={(e) => set('refundable', (e.target.value || undefined) as ImportCandidate['refundable'])} className={FIELD}>
            <option value="">Not recorded</option>
            <option value="refundable">{REFUNDABLE_WORD.refundable}</option>
            <option value="non_refundable">{REFUNDABLE_WORD.non_refundable}</option>
          </select>
        </label>
        <label className="text-sm text-ink">
          Free cancellation until
          <input type="date" value={candidate.cancellationDeadline ?? ''} onChange={(e) => set('cancellationDeadline', e.target.value)} className={FIELD} />
        </label>
      </div>

      <p className="mt-3 text-sm text-ink-muted" data-testid="import-affected">
        <span className="font-medium text-ink">What this would change: </span>
        {affected ? affected.summary : complete ? 'Working it out…' : 'Give it a name and a date to see what it would change.'}
        {affected && affected.conflicts.length > 0 ? <span className="block text-clay">{affected.conflicts.join(' ')}</span> : null}
      </p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" disabled={pending || reading || !candidate.title || candidate.title.trim().length === 0} onClick={confirm} className={buttonClass('accent', 'sm')} data-testid="import-confirm">
          {pending ? 'Saving…' : 'Confirm this booking'}
        </button>
        <button type="button" disabled={pending || reading} onClick={discard} className={GHOST} data-testid="import-discard">
          Discard
        </button>
        {review.source && !review.modelUsed ? (
          <button type="button" disabled={pending || reading} onClick={askSidequest} className={buttonClass('secondary', 'sm')} data-testid="import-read-with-sidequest" title="One reading by Sidequest, only when you press this">
            {reading ? 'Sidequest is reading…' : review.photo ? 'Ask Sidequest to read the photo' : 'Ask Sidequest to read it'}
          </button>
        ) : review.modelUsed ? (
          <span className="text-sm text-ink-muted">Read by Sidequest.</span>
        ) : (
          <span className="text-sm text-ink-faint">Paste it again to have Sidequest read it.</span>
        )}
      </div>
    </div>
  );
}
