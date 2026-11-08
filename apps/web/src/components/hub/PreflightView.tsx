'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { Preflight, TravelReadinessProfile } from '@sidequest/core';
import { setCheckAction } from '@/app/(product)/trips/[id]/itinerary/actions';
import { cx } from '../ui';
import s from './prepare/prepare.module.css';
import { ReadinessProfileForm } from './HubForms';
import type { KnowRow, PackGroup, PrepareModel, PrepareRow, TickTarget } from './prepare/prepare-model';

/**
 * PREPARE — A CHECKLIST ORGANISED AROUND ACTIONS (2026-11).
 *
 * Five short sections in the order a traveller acts: before you book, the week
 * or two before, pack, install, and what to know. The head says how many
 * things are left — one number, the same rows the sections hold, packing
 * counted separately and said so — and when the trip leaves, in words.
 *
 * Every tick is a persisted act (`trip_checks`, through `setCheckAction`): a
 * readiness row writes the Preflight check the state graph reads, the packing
 * list writes the packing list, and the few checks that are Prepare's own (the
 * forecast, the re-checks, reconfirming) write the checklist list. A booking
 * is never ticked here — it is settled in Bookings, and its row reads the
 * booking's own status.
 *
 * The ids and attributes the browser suite knows (`preflight`,
 * `preflight-verdict`, `prepare-top`, `preflight-item` with its kind, state,
 * check and bucket, `preflight-tick`, `hub-before-you-go`, `hub-pack`,
 * `hub-packing-list`, `packing-list`) stay on the things that replaced them.
 */
type Verdict = Preflight['verdict'];

export function PrepareChecklist({ model, tripId, startDate, readinessProfile, drives, verdict: given }: { model: PrepareModel; tripId?: string; startDate?: string; readinessProfile: TravelReadinessProfile | null; drives: boolean; verdict?: Verdict }) {
  const reduced = useReducedMotion();
  /* Ticks made in this render, so the head and the section counts move with the press rather than after a reload. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isDone = (row: PrepareRow) => overrides[row.key] ?? row.done;
  const actionable = [...model.book, ...model.weeks, ...model.install];
  const open = actionable.filter((row) => !isDone(row)).length;
  const packRows = model.pack.flatMap((group) => group.rows);
  const packed = packRows.filter(isDone).length;
  const verdict: Verdict = given ?? (open === 0 ? 'ready' : open <= 2 ? 'nearly' : 'not_yet');
  const headline = open === 0 ? 'Ready to go' : `${open} ${open === 1 ? 'thing' : 'things'} to do before you go`;
  const ctx: RowContext = { tripId, isDone, onTick: (key, done) => setOverrides((current) => ({ ...current, [key]: done })), reduced: Boolean(reduced), readinessProfile, drives };
  const total = actionable.length;
  const progress = total === 0 ? 1 : (total - open) / total;

  return (
    <section aria-labelledby="preflight-heading" data-testid="preflight" data-verdict={verdict}>
      <header className={s.head} data-testid="prepare-top">
        <p className={cx("sheet-label", "text-ink-muted")}>Before you go</p>
        <h2 id="preflight-heading" className={s.title} data-testid="preflight-verdict" data-verdict={verdict}>
          {headline}
        </h2>
        <p className={s.lede} data-testid="preflight-days">
          {departureLine(startDate, model.daysUntilTrip)}
        </p>
        <div className={s.progress} aria-hidden="true">
          <motion.span className={s.progressFill} initial={false} animate={{ scaleX: progress }} transition={{ duration: reduced ? 0 : 0.4, ease: [0.2, 0.7, 0.2, 1] }} />
        </div>
        <p className={s.meta}>
          {total - open} of {total} done{packRows.length > 0 ? ` · ${packed} of ${packRows.length} packed` : ''}
        </p>
      </header>

      <div className={s.body} data-testid="hub-checklist">
        <nav className={s.nav} aria-label="Prepare sections">
          <ol>
            {SECTIONS.filter((section) => sectionSize(model, section.id) > 0).map((section) => {
              const left = sectionLeft(model, section.id, isDone);
              return (
                <li key={section.id}>
                  <a href={`#prepare-${section.id}`} className={s.navLink}>
                    <span>{section.title}</span>
                    <span className={s.navCount}>{section.id === 'know' ? '' : left === 0 ? '✓' : `${left}`}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className={s.sections} data-testid="readiness-list">
          {model.book.length > 0 ? (
            <Section id="book" title="Before you book" blurb="Arrange these first; the rest of the trip hangs on them." rows={model.book} ctx={ctx} testId="hub-before-you-go" anchor="before-you-go" />
          ) : (
            <div id="before-you-go" data-testid="hub-before-you-go" className={"sr-only"}>
              Nothing to arrange before booking.
            </div>
          )}
          {model.weeks.length > 0 ? <Section id="weeks" title="One to two weeks before" blurb="Things that change: weather, hours, cover." rows={model.weeks} ctx={ctx} testId="prepare-weeks" /> : null}
          {model.pack.length > 0 ? <PackSection groups={model.pack} ctx={ctx} basis={model.packBasis} /> : null}
          {model.install.length > 0 ? <Section id="install" title="Install and download" blurb="Set these up before you land." rows={model.install} ctx={ctx} testId="local-setup" /> : null}
          {model.know.length > 0 ? <KnowSection rows={model.know} /> : null}
        </div>
      </div>
    </section>
  );
}

const SECTIONS = [
  { id: 'book', title: 'Before you book' },
  { id: 'weeks', title: '1–2 weeks before' },
  { id: 'pack', title: 'Pack' },
  { id: 'install', title: 'Install' },
  { id: 'know', title: 'Know before you go' },
] as const;

function sectionRows(model: PrepareModel, id: (typeof SECTIONS)[number]['id']): PrepareRow[] {
  if (id === 'pack') return model.pack.flatMap((group) => group.rows);
  if (id === 'know') return [];
  return model[id];
}

function sectionSize(model: PrepareModel, id: (typeof SECTIONS)[number]['id']): number {
  return id === 'know' ? model.know.length : sectionRows(model, id).length;
}

function sectionLeft(model: PrepareModel, id: (typeof SECTIONS)[number]['id'], isDone: (row: PrepareRow) => boolean): number {
  return sectionRows(model, id).filter((row) => !isDone(row)).length;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Leaves 12 September, in about ten months." — the distance in words, never a giant figure. */
export function departureLine(startDate: string | undefined, days: number | null): string {
  const date = startDate && /^\d{4}-\d{2}-\d{2}/.test(startDate) ? `${Number(startDate.slice(8, 10))} ${MONTHS[Number(startDate.slice(5, 7)) - 1]}` : null;
  if (days === null) return date ? `Leaves ${date}.` : 'Work down the list; ticks are saved to this trip.';
  if (days < 0) return 'Under way — what is left still matters on the road.';
  if (days === 0) return 'Leaves today.';
  const when = days === 1 ? 'tomorrow' : days < 14 ? `in ${days} days` : days < 60 ? `in ${Math.round(days / 7)} weeks` : `in about ${Math.round(days / 30.44)} months`;
  return date ? `Leaves ${date}, ${when}.` : `Leaves ${when}.`;
}

interface RowContext {
  tripId: string | undefined;
  isDone: (row: PrepareRow) => boolean;
  onTick: (key: string, done: boolean) => void;
  reduced: boolean;
  readinessProfile: TravelReadinessProfile | null;
  drives: boolean;
}

function SectionHead({ id, title, blurb, done, total }: { id: string; title: string; blurb?: string; done?: number; total?: number }) {
  return (
    <div className={s.sectionHead}>
      <h3 id={`prepare-${id}-heading`} className={s.sectionTitle}>
        {title}
      </h3>
      {total !== undefined && total > 0 ? (
        <p className={s.sectionCount} aria-label={`${done} of ${total} done`}>
          {done}/{total}
        </p>
      ) : null}
      {blurb ? <p className={s.sectionBlurb}>{blurb}</p> : null}
    </div>
  );
}

function Section({ id, title, blurb, rows, ctx, testId, anchor }: { id: string; title: string; blurb: string; rows: readonly PrepareRow[]; ctx: RowContext; testId: string; anchor?: string }) {
  return (
    <section id={`prepare-${id}`} className={s.section} aria-labelledby={`prepare-${id}-heading`} data-testid={testId}>
      {anchor ? <span id={anchor} className={s.anchor} /> : null}
      <SectionHead id={id} title={title} blurb={blurb} done={rows.filter(ctx.isDone).length} total={rows.length} />
      <ol className={s.list}>
        {rows.map((row) => (
          <CheckRow key={row.key} row={row} ctx={ctx} />
        ))}
      </ol>
    </section>
  );
}

function PackSection({ groups, ctx, basis }: { groups: readonly PackGroup[]; ctx: RowContext; basis: string | null }) {
  const rows = groups.flatMap((group) => group.rows);
  return (
    <section id="prepare-pack" className={s.section} aria-labelledby="prepare-pack-heading" data-testid="hub-pack">
      <span id="pack" className={s.anchor} />
      <SectionHead id="pack" title="Pack" blurb={basis ? `Only what this trip asks for. ${basis}` : 'Only what this trip asks for, and why.'} done={rows.filter(ctx.isDone).length} total={rows.length} />
      <div data-testid="packing-list">
        <div data-testid="hub-packing-list" className={s.packGrid}>
          {groups.map((group) => (
            <div key={group.key} className={s.packGroup} data-group={group.key}>
              <p className={s.packTitle}>{group.title}</p>
              <ol className={s.list}>
                {group.rows.map((row) => (
                  <CheckRow key={row.key} row={row} ctx={ctx} compact />
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function KnowSection({ rows }: { rows: readonly KnowRow[] }) {
  return (
    <section id="prepare-know" className={s.section} aria-labelledby="prepare-know-heading" data-testid="prepare-know">
      <SectionHead id="know" title="Know before you go" />
      <dl className={s.know}>
        {rows.map((row) => (
          <div key={row.key} className={s.knowRow}>
            <dt>{row.title}</dt>
            <dd>
              {row.detail}
              {row.links.length > 0 ? <Links links={row.links} /> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Links({ links }: { links: readonly { name: string; url: string }[] }) {
  return (
    <span className={s.links}>
      {links.map((link) => (
        <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener">
          {link.name}
        </a>
      ))}
    </span>
  );
}

function CheckRow({ row, ctx, compact = false }: { row: PrepareRow; ctx: RowContext; compact?: boolean }) {
  const done = ctx.isDone(row);
  const [pending, startTransition] = useTransition();
  const tickable = Boolean(ctx.tripId && row.tick && row.tick.length > 0);
  const preflight = row.preflight;

  const press = () => {
    const next = !done;
    ctx.onTick(row.key, next);
    startTransition(async () => {
      const results = await Promise.all(writesFor(row.tick ?? [], next).map((t) => setCheckAction(ctx.tripId!, t.list, t.id, next)));
      if (results.some((result) => !result.ok)) ctx.onTick(row.key, !next);
    });
  };

  return (
    <li
      className={cx(s.row, compact && s.rowCompact)}
      data-done={done ? 'true' : 'false'}
      data-urgent={row.urgent && !done ? 'true' : undefined}
      data-testid={preflight ? 'preflight-item' : 'prepare-item'}
      {...(preflight
        ? {
            'data-category': preflight.category,
            'data-bucket': done ? 'ready' : preflight.bucket,
            ...(preflight.checkId ? { 'data-check': preflight.checkId } : {}),
            ...(preflight.readinessKind ? { 'data-kind': preflight.readinessKind } : {}),
            ...(preflight.readinessState ? { 'data-state': preflight.readinessState } : {}),
          }
        : {})}
      {...(row.bookingKind ? { 'data-booking-kind': row.bookingKind } : {})}
    >
      {tickable ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-busy={pending}
          aria-label={row.title}
          data-testid={preflight ? 'preflight-tick' : 'prepare-tick'}
          onClick={press}
          className={s.hit}
        >
          <Box done={done} reduced={ctx.reduced} />
          <span className={"sr-only"} aria-live="polite">
            {pending ? 'Saving…' : ''}
          </span>
        </button>
      ) : (
        <span className={s.hit} aria-hidden="true">
          {row.href ? <span className={cx(s.status, done && s.statusDone)}>{done ? <Tick reduced /> : null}</span> : <Box done={done} reduced muted />}
        </span>
      )}
      <div className={s.rowBody}>
        <p className={s.rowTitle}>
          {row.href && !tickable ? (
            <a href={row.href} className={s.rowLink}>
              {row.title}
            </a>
          ) : (
            row.title
          )}
        </p>
        {row.detail ? <p className={s.rowDetail}>{row.detail}</p> : null}
        {row.links.length > 0 ? <Links links={row.links} /> : null}
        {row.more ? (
          <details className={s.more} data-print="open">
            <summary>More</summary>
            <p>{row.more}</p>
          </details>
        ) : null}
        {row.profileForm && ctx.tripId ? (
          <div className={"mt-3"}>
            <ReadinessProfileForm tripId={ctx.tripId} current={ctx.readinessProfile} drives={ctx.drives} />
          </div>
        ) : null}
      </div>
      {row.href && row.hrefLabel ? (
        <a href={row.href} className={s.rowAction} aria-label={`${row.hrefLabel}: ${row.title}`}>
          {row.hrefLabel} <span aria-hidden="true">→</span>
        </a>
      ) : null}
    </li>
  );
}

/** Unticking a readiness row clears both lists Preflight reads it from; ticking writes the list the row names. */
function writesFor(targets: readonly TickTarget[], next: boolean): TickTarget[] {
  if (next) return [...targets];
  const out = [...targets];
  for (const target of targets) if (target.list === 'preflight' && target.id.startsWith('readiness:')) out.push({ list: 'checklist', id: target.id });
  return out;
}

function Box({ done, reduced, muted = false }: { done: boolean; reduced: boolean; muted?: boolean }): ReactNode {
  return (
    <span className={cx(s.box, done && s.boxDone, muted && s.boxMuted)}>
      {done ? <Tick reduced={reduced} /> : null}
    </span>
  );
}

function Tick({ reduced }: { reduced: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <motion.path d="M3.2 8.4 6.5 11.5 12.8 4.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduced ? 0 : 0.22, ease: 'easeOut' }} />
    </svg>
  );
}
