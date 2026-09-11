'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AGE_GROUPS,
  AGE_GROUP_LABELS,
  DIETARY_NEED_KINDS,
  DIETARY_NEED_KIND_LABELS,
  DIETARY_NEED_LABELS,
  FUNCTIONAL_NEEDS,
  FUNCTIONAL_NEED_LABELS,
  PARTY_ROLE_LABELS,
  PARTY_ROLES,
  dietaryNeedsOfKind,
  type Traveler,
  type TripPartyMember,
} from '@sidequest/core';
import { ErrorNote, FOCUS_RING, FieldLabel, buttonClass, cx, selectableCardClass } from '@/components/ui';
import { Glyph } from '@/components/interview/glyphs';
import { PORTRAIT_S, timing } from '@/components/interview/choreography';
import { addPersonAction, attachPersonAction, removePersonAction, updatePersonAction, type PersonInput } from './actions';
import { PARTY_NOTE_SUGGESTIONS, appendPhrase, hasPhrase, personFacts } from './party-suggestions';

type Member = TripPartyMember & { traveler: Traveler };

const INPUT =
  'mt-1.5 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 py-2 text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

/**
 * A chip that is a checkbox.
 *
 * `sr-only` on the input means the label is the only target, so the label has to
 * carry both the 44px height WCAG 2.5.5 asks for and the focus ring the hidden
 * input cannot paint. `FOCUS_RING` is the `:has(:focus-visible)` treatment
 * `ui.tsx` keeps for exactly this pattern. V8 — a chosen chip is filled, edged
 * and marked, in the colour of what it is: clay for a rule, accent for a taste.
 */
const CHIP = 'pressable inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm transition-colors';
const CHIP_OFF = 'border-rule bg-paper-raised text-ink hover:border-ink-faint';
const CHIP_ACCENT = 'border-accent bg-accent-soft font-medium text-accent-strong shadow-[inset_0_0_0_1px_var(--color-accent)]';
const CHIP_CLAY = 'border-clay bg-clay-soft font-medium text-clay shadow-[inset_0_0_0_1px_var(--color-clay)]';

/** A checkbox row that is a real target rather than a 13px square with words beside it. */
const CHECK_ROW = 'flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-ink';
const CHECK_BOX = 'h-5 w-5 shrink-0 accent-[var(--color-accent)]';

function inputFrom(traveler: Traveler | null, member: Member | null): PersonInput {
  return {
    displayName: traveler?.displayName ?? '',
    ...(traveler?.ageGroup ? { ageGroup: traveler.ageGroup } : {}),
    ...(traveler?.relationship ? { relationship: traveler.relationship } : {}),
    dietaryNeeds: traveler?.diet.needs ?? [],
    dietaryStrict: traveler?.diet.strict ?? false,
    ...(traveler?.diet.notes ? { dietaryNotes: traveler.diet.notes } : {}),
    needs: traveler?.needs ?? [],
    ...(traveler?.needsNotes ? { needsNotes: traveler.needsNotes } : {}),
    ...(traveler?.profile.physicalCapability ? { physicalCapability: traveler.profile.physicalCapability } : {}),
    ...(traveler?.profile.sleepRhythm ? { sleepRhythm: traveler.profile.sleepRhythm } : {}),
    drives: traveler?.profile.transportComfort.includes('drives') ?? false,
    preferencesApply: member?.preferencesApply ?? true,
    constraintsApply: member?.constraintsApply ?? true,
  };
}

/**
 * V8 — THE PARTY EDITOR: A CARD PER PERSON.
 *
 * Each person is a portrait disc, a name, a role and age line, and three
 * clearly separated groups — hard requirements (clay), preferences, and
 * private notes — sorted by `personFacts`. The form beneath asks planning
 * consequences and never a diagnosis; every test id the browser suite reads
 * stays on the same kind of element.
 */
export function PartyEditor({ tripId, members, available }: { tripId: string; members: Member[]; available: { id: string; displayName: string; relationship: string | null }[] }) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [adding, setAdding] = useState(members.length === 0);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? 'That did not save. Nothing was changed.');
        return;
      }
      after?.();
      router.refresh();
    });
  };

  return (
    <div className="mt-8" data-testid="party-editor">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <ul className="grid gap-4">
        <AnimatePresence initial={false}>
          {members.map((member) => (
            <motion.li key={member.travelerId} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={timing(PORTRAIT_S, reduced)}>
              {editing === member.travelerId ? (
                <PersonForm
                  initial={inputFrom(member.traveler, member)}
                  pending={pending}
                  onCancel={() => setEditing(null)}
                  onSubmit={(input) => run(() => updatePersonAction(tripId, member.travelerId, input), () => setEditing(null))}
                />
              ) : (
                <PersonCard member={member} pending={pending} onEdit={() => setEditing(member.travelerId)} onRemove={() => run(() => removePersonAction(tripId, member.travelerId))} />
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      {available.length > 0 ? (
        <div className="mt-6 flex min-w-0 flex-wrap items-center gap-2" data-testid="party-available">
          <span className="type-small text-ink-muted">People you have described before:</span>
          {available.map((person) => (
            <button key={person.id} type="button" className={buttonClass('secondary', 'sm')} disabled={pending} onClick={() => run(() => attachPersonAction(tripId, person.id))}>
              + {person.displayName}
            </button>
          ))}
        </div>
      ) : null}

      {adding ? (
        <div className="mt-6">
          <PersonForm initial={inputFrom(null, null)} pending={pending} onCancel={members.length > 0 ? () => setAdding(false) : undefined} onSubmit={(input) => run(() => addPersonAction(tripId, input), () => setAdding(false))} />
        </div>
      ) : (
        <button type="button" className={cx(buttonClass('secondary'), 'mt-6')} onClick={() => setAdding(true)} data-testid="party-add">
          <Glyph id="group" className="h-4 w-4" />
          Add a person
        </button>
      )}
    </div>
  );
}

function PersonCard({ member, pending, onEdit, onRemove }: { member: Member; pending: boolean; onEdit: () => void; onRemove: () => void }) {
  const t = member.traveler;
  const facts = personFacts(t, member);
  const subtitle = [t.relationship ? PARTY_ROLE_LABELS[t.relationship] : null, t.ageGroup ? AGE_GROUP_LABELS[t.ageGroup] : null].filter(Boolean).join(' · ') || 'Traveller';
  return (
    <article className="card p-4 sm:p-5" data-testid="party-member">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="plate inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full font-display text-xl text-ink" style={{ '--plate-hue': 28 } as React.CSSProperties}>
            {t.displayName.trim().charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <h2 className="font-display text-xl leading-tight text-ink">{t.displayName}</h2>
            <p className="type-small text-ink-muted">{subtitle}</p>
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <button type="button" className={buttonClass('ghost', 'sm')} onClick={onEdit} data-testid="party-edit">
            Edit
          </button>
          <button type="button" className={buttonClass('ghost', 'sm')} disabled={pending} onClick={onRemove} data-testid="party-remove">
            Remove from trip
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <FactGroup tone="clay" glyph="lock" title="Hard requirements" empty="None — nothing here binds the plan." items={facts.hard} />
        <FactGroup tone="neutral" glyph="compass" title="Preferences" empty="Nothing stated." items={facts.preferences} />
        <FactGroup tone="pencil" glyph="pen" title="Private notes" empty="Nothing written." items={facts.privateNotes} note="Planned around, never shared." quoted />
      </div>
    </article>
  );
}

function FactGroup({ tone, glyph, title, items, empty, note, quoted = false }: { tone: 'clay' | 'neutral' | 'pencil'; glyph: 'lock' | 'compass' | 'pen'; title: string; items: string[]; empty: string; note?: string; quoted?: boolean }) {
  return (
    <section className={cx('min-w-0 rounded-[var(--radius-card)] p-3', tone === 'clay' ? 'bg-clay-soft/40 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-clay)_35%,transparent)]' : 'bg-paper-sunk/60')}>
      <h3 className={cx('flex items-center gap-1.5 text-sm font-semibold', tone === 'clay' ? 'text-clay' : 'text-ink')}>
        <Glyph id={glyph} className="h-4 w-4" />
        {title}
      </h3>
      {note ? <p className="type-meta mt-0.5">{note}</p> : null}
      {items.length === 0 ? (
        <p className="type-small mt-2 text-ink-faint">{empty}</p>
      ) : quoted ? (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item} className="font-display text-base italic leading-snug text-ink-muted">
              “{item}”
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item} className={cx('rounded-full border px-2.5 py-1 text-sm', tone === 'clay' ? 'border-clay/40 bg-paper-raised text-clay' : 'border-rule bg-paper-raised text-ink')}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One titled part of the form: a heading, a line on what it changes, the controls. */
function FormSection({ title, hint, glyph, tone = 'neutral', children }: { title: string; hint?: string; glyph?: 'lock' | 'compass' | 'pen' | 'plate' | 'walk' | 'clock' | 'group'; tone?: 'neutral' | 'clay' | 'pencil'; children: ReactNode }) {
  return (
    <section className="rule-top pt-5">
      <h3 className={cx('flex items-center gap-2 text-base font-semibold', tone === 'clay' ? 'text-clay' : 'text-ink')}>
        {glyph ? <Glyph id={glyph} className="h-4 w-4" /> : null}
        {title}
      </h3>
      {hint ? <p className="type-small mt-1 text-ink-muted">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function PersonForm({ initial, pending, onCancel, onSubmit }: { initial: PersonInput; pending: boolean; onCancel?: () => void; onSubmit: (input: PersonInput) => void }) {
  const [form, setForm] = useState<PersonInput>(initial);
  const notesId = useId();
  const toggle = <T extends string>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const initial_ = form.displayName.trim().charAt(0).toUpperCase();
  return (
    <form
      className="card-raised p-4 sm:p-6"
      data-testid="party-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="flex items-start gap-4">
        <span aria-hidden="true" className="plate inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full font-display text-xl text-ink" style={{ '--plate-hue': 28 } as React.CSSProperties}>
          {initial_ || '·'}
        </span>
        <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-3">
          <div>
            <FieldLabel htmlFor="person-name">Name</FieldLabel>
            <input id="person-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} maxLength={60} placeholder="Mum, Ravi, me…" className={INPUT} data-testid="person-name" required />
          </div>
          <div>
            <FieldLabel htmlFor="person-role">Who they are</FieldLabel>
            <select id="person-role" value={form.relationship ?? ''} onChange={(e) => setForm({ ...form, relationship: (e.target.value || undefined) as PersonInput['relationship'] })} className={INPUT} data-testid="person-role">
              <option value="">Not said</option>
              {PARTY_ROLES.map((role) => (
                <option key={role} value={role}>
                  {PARTY_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="person-age">Age group</FieldLabel>
            <select id="person-age" value={form.ageGroup ?? ''} onChange={(e) => setForm({ ...form, ageGroup: (e.target.value || undefined) as PersonInput['ageGroup'] })} className={INPUT} data-testid="person-age">
              <option value="">Not said</option>
              {AGE_GROUPS.map((group) => (
                <option key={group} value={group}>
                  {AGE_GROUP_LABELS[group]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <FormSection title="Activity and mornings" hint="How full a day can be for this person, and when it can start." glyph="walk">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <FieldLabel htmlFor="person-capacity">Activity level</FieldLabel>
              <select id="person-capacity" value={form.physicalCapability ?? ''} onChange={(e) => setForm({ ...form, physicalCapability: (e.target.value || undefined) as PersonInput['physicalCapability'] })} className={INPUT}>
                <option value="">Not said</option>
                <option value="low">Takes it easy</option>
                <option value="moderate">Average</option>
                <option value="high">Very fit</option>
              </select>
            </div>
            <div>
              <FieldLabel htmlFor="person-sleep">Mornings</FieldLabel>
              <select id="person-sleep" value={form.sleepRhythm ?? ''} onChange={(e) => setForm({ ...form, sleepRhythm: (e.target.value || undefined) as PersonInput['sleepRhythm'] })} className={INPUT}>
                <option value="">Not said</option>
                <option value="early">Early riser</option>
                <option value="normal">Normal</option>
                <option value="late">Late riser</option>
              </select>
            </div>
            <label className={cx(CHECK_ROW, 'sm:self-end sm:pb-1')}>
              <input type="checkbox" className={CHECK_BOX} checked={form.drives} onChange={(e) => setForm({ ...form, drives: e.target.checked })} />
              Can drive on this trip
            </label>
          </div>
        </FormSection>

        <FormSection title="Mobility and access" hint="Only what changes the plan. Nothing here is a diagnosis." glyph="lock" tone="clay">
          <fieldset>
            <legend className="sr-only">Needs to plan around</legend>
            <div className="flex flex-wrap gap-2">
              {FUNCTIONAL_NEEDS.map((need) => {
                const on = form.needs.includes(need);
                return (
                  <label key={need} className={cx(CHIP, FOCUS_RING, on ? CHIP_CLAY : CHIP_OFF)}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={() => setForm({ ...form, needs: toggle(form.needs, need) })} data-testid={`person-need-${need}`} />
                    <span aria-hidden="true" className={cx('inline-block h-2 w-2 rounded-full', on ? 'bg-clay' : 'border border-ink-faint')} />
                    {FUNCTIONAL_NEED_LABELS[need]}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <BindSwitch checked={form.constraintsApply} onChange={(constraintsApply) => setForm({ ...form, constraintsApply })} label="Their needs bind the plan" detail="Off, and the needs above are noted but a day may still be planned that crosses them." />
        </FormSection>

        <FormSection title="Food" hint="A way of eating, things they do not eat, allergies. An allergy is always a rule." glyph="plate">
          <div className="space-y-4">
            {DIETARY_NEED_KINDS.map((kind) => {
              const needs = dietaryNeedsOfKind(kind);
              if (needs.length === 0) return null;
              const clay = kind === 'allergy';
              return (
                <fieldset key={kind}>
                  <legend className="type-small font-medium text-ink">{DIETARY_NEED_KIND_LABELS[kind]}</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {needs.map((need) => {
                      const on = form.dietaryNeeds.includes(need);
                      return (
                        <label key={need} className={cx(CHIP, FOCUS_RING, on ? (clay ? CHIP_CLAY : CHIP_ACCENT) : CHIP_OFF)}>
                          <input type="checkbox" className="sr-only" checked={on} onChange={() => setForm({ ...form, dietaryNeeds: toggle(form.dietaryNeeds, need) })} data-testid={`person-diet-${need}`} />
                          <span aria-hidden="true" className={cx('inline-block h-2 w-2 rounded-full', on ? (clay ? 'bg-clay' : 'bg-accent') : 'border border-ink-faint')} />
                          {DIETARY_NEED_LABELS[need]}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
            {form.dietaryNeeds.length > 0 ? <BindSwitch checked={form.dietaryStrict} onChange={(dietaryStrict) => setForm({ ...form, dietaryStrict })} label="This is a cannot, not a would-rather-not" detail="Say yes and “nobody has confirmed it” stops being good enough for a meal." testId="person-diet-strict" /> : null}
            <input value={form.dietaryNotes ?? ''} onChange={(e) => setForm({ ...form, dietaryNotes: e.target.value || undefined })} maxLength={400} placeholder="Anything else about food, in your words" aria-label="Anything else about food" className={INPUT} />
          </div>
        </FormSection>

        <FormSection title="Private notes" hint="In your own words. Planned around, never shared." glyph="pen" tone="pencil">
          <label htmlFor={notesId} className="sr-only">
            Private notes
          </label>
          <textarea id={notesId} rows={3} value={form.needsNotes ?? ''} onChange={(e) => setForm({ ...form, needsNotes: e.target.value || undefined })} maxLength={600} placeholder="e.g. “can’t do much downhill after a long day”" className={cx(INPUT, 'resize-y')} data-testid="person-needs-notes" />
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Suggested phrases">
            {PARTY_NOTE_SUGGESTIONS.map((phrase) => {
              const on = hasPhrase(form.needsNotes, phrase);
              return (
                <button key={phrase} type="button" aria-pressed={on} disabled={on} onClick={() => setForm({ ...form, needsNotes: appendPhrase(form.needsNotes, phrase) })} className={cx(CHIP, FOCUS_RING, 'disabled:cursor-default', on ? 'border-rule bg-paper-sunk text-ink-muted' : 'border-dashed border-rule bg-transparent text-ink-muted hover:border-ink-faint hover:text-ink')} data-testid="party-note-suggestion">
                  <span aria-hidden="true">{on ? '✓' : '+'}</span>
                  {phrase}
                </button>
              );
            })}
          </div>
        </FormSection>

        <section className="rule-top pt-5">
          <label className={CHECK_ROW}>
            <input type="checkbox" className={CHECK_BOX} checked={form.preferencesApply} onChange={(e) => setForm({ ...form, preferencesApply: e.target.checked })} />
            Their tastes shape the plan
          </label>
        </section>
      </div>

      <div className="mt-6 flex min-w-0 flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || form.displayName.trim().length === 0} className={buttonClass('primary')} data-testid="person-save">
          {pending ? 'Saving…' : 'Save'}
        </button>
        {onCancel ? (
          <button type="button" className={buttonClass('ghost')} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** "This binds the plan": a switch drawn as the serious thing it is, in clay when on. */
function BindSwitch({ checked, onChange, label, detail, testId }: { checked: boolean; onChange: (checked: boolean) => void; label: string; detail: string; testId?: string }) {
  return (
    <label className={selectableCardClass(false, cx('mt-3 flex cursor-pointer gap-3 border-l-4 p-3.5 transition-colors', checked ? 'border-l-clay bg-clay-soft/60' : 'border-l-rule'))}>
      <input type="checkbox" role="switch" aria-checked={checked} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-clay)]" {...(testId ? { 'data-testid': testId } : {})} />
      <span>
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          <Glyph id="lock" className="h-4 w-4 text-clay" />
          {label}
        </span>
        <span className="type-small mt-0.5 block text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}
