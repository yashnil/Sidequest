'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AGE_GROUPS, AGE_GROUP_LABELS, DIETARY_NEED_LABELS, DIETARY_NEEDS, FUNCTIONAL_NEEDS, FUNCTIONAL_NEED_LABELS, PARTY_ROLE_LABELS, PARTY_ROLES, type Traveler, type TripPartyMember } from '@sidequest/core';
import { Badge, ErrorNote, FOCUS_RING, FieldLabel, buttonClass, cx } from '@/components/ui';
import { addPersonAction, attachPersonAction, removePersonAction, updatePersonAction, type PersonInput } from './actions';

type Member = TripPartyMember & { traveler: Traveler };

const INPUT =
  'mt-1.5 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 py-2 text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

/**
 * A chip that is a checkbox.
 *
 * `sr-only` on the input means the label is the only target, so the label has to
 * carry both the 44px height WCAG 2.5.5 asks for and the focus ring the hidden
 * input cannot paint. `FOCUS_RING` is the `:has(:focus-visible)` treatment
 * `ui.tsx` keeps for exactly this pattern.
 */
const CHIP = 'pressable inline-flex min-h-11 cursor-pointer items-center rounded-full border px-3.5 text-sm transition-colors';

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

export function PartyEditor({ tripId, members, available }: { tripId: string; members: Member[]; available: { id: string; displayName: string; relationship: string | null }[] }) {
  const router = useRouter();
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
        {members.map((member) => (
          <li key={member.travelerId}>
            {editing === member.travelerId ? (
              <PersonForm
                initial={inputFrom(member.traveler, member)}
                pending={pending}
                onCancel={() => setEditing(null)}
                onSubmit={(input) => run(() => updatePersonAction(tripId, member.travelerId, input), () => setEditing(null))}
              />
            ) : (
              <div className="rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4 sm:p-5" data-testid="party-member">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-paper-sunk font-display text-lg text-ink">
                      {member.traveler.displayName.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <h2 className="font-display text-xl leading-tight text-ink">{member.traveler.displayName}</h2>
                      <p className="type-small text-ink-muted">
                        {[member.traveler.relationship ? PARTY_ROLE_LABELS[member.traveler.relationship] : null, member.traveler.ageGroup ? AGE_GROUP_LABELS[member.traveler.ageGroup] : null].filter(Boolean).join(' · ') || 'Traveller'}
                      </p>
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setEditing(member.travelerId)} data-testid="party-edit">
                      Edit
                    </button>
                    <button type="button" className={buttonClass('ghost', 'sm')} disabled={pending} onClick={() => run(() => removePersonAction(tripId, member.travelerId))} data-testid="party-remove">
                      Remove from trip
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {member.traveler.diet.needs.map((need) => (
                    <Badge key={need} tone={member.traveler.diet.strict || need === 'nut_allergy' ? 'clay' : 'neutral'}>
                      {DIETARY_NEED_LABELS[need]}
                    </Badge>
                  ))}
                  {member.traveler.needs.map((need) => (
                    <Badge key={need} tone="amber">
                      {FUNCTIONAL_NEED_LABELS[need]}
                    </Badge>
                  ))}
                  {!member.preferencesApply ? <Badge tone="neutral">tastes do not shape the plan</Badge> : null}
                  {!member.constraintsApply ? <Badge tone="neutral">needs do not bind the plan</Badge> : null}
                </div>
                {member.traveler.needsNotes ? <p className="mt-2.5 font-display text-base italic text-ink-muted">“{member.traveler.needsNotes}”</p> : null}
              </div>
            )}
          </li>
        ))}
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
          Add a person
        </button>
      )}
    </div>
  );
}

function PersonForm({ initial, pending, onCancel, onSubmit }: { initial: PersonInput; pending: boolean; onCancel?: () => void; onSubmit: (input: PersonInput) => void }) {
  const [form, setForm] = useState<PersonInput>(initial);
  const toggle = <T extends string>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  return (
    <form
      className="rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4 sm:p-5"
      data-testid="party-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
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

      <fieldset className="mt-5">
        <legend className="label text-ink-faint">Food they cannot or would rather not eat</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {DIETARY_NEEDS.map((need) => {
            const on = form.dietaryNeeds.includes(need);
            return (
              <label key={need} className={cx(CHIP, FOCUS_RING, on ? 'border-accent bg-accent-soft text-accent-strong' : 'border-rule bg-paper text-ink-muted hover:text-ink')}>
                <input type="checkbox" className="sr-only" checked={on} onChange={() => setForm({ ...form, dietaryNeeds: toggle(form.dietaryNeeds, need) })} data-testid={`person-diet-${need}`} />
                {DIETARY_NEED_LABELS[need]}
              </label>
            );
          })}
        </div>
        {form.dietaryNeeds.length > 0 ? (
          <label className={cx(CHECK_ROW, 'mt-2')}>
            <input type="checkbox" className={CHECK_BOX} checked={form.dietaryStrict} onChange={(e) => setForm({ ...form, dietaryStrict: e.target.checked })} data-testid="person-diet-strict" />
            This is a cannot, not a would-rather-not
          </label>
        ) : null}
        <input value={form.dietaryNotes ?? ''} onChange={(e) => setForm({ ...form, dietaryNotes: e.target.value || undefined })} maxLength={400} placeholder="Anything else about food, in your words" className={cx(INPUT, 'mt-3')} />
      </fieldset>

      <fieldset className="mt-5">
        <legend className="label text-ink-faint">Anything to plan around?</legend>
        <p className="mt-1 type-small text-ink-muted">Only what changes the plan. Nothing here is a diagnosis.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {FUNCTIONAL_NEEDS.map((need) => {
            const on = form.needs.includes(need);
            return (
              <label key={need} className={cx(CHIP, FOCUS_RING, on ? 'border-amber bg-amber-soft text-ink' : 'border-rule bg-paper text-ink-muted hover:text-ink')}>
                <input type="checkbox" className="sr-only" checked={on} onChange={() => setForm({ ...form, needs: toggle(form.needs, need) })} data-testid={`person-need-${need}`} />
                {FUNCTIONAL_NEED_LABELS[need]}
              </label>
            );
          })}
        </div>
        <input value={form.needsNotes ?? ''} onChange={(e) => setForm({ ...form, needsNotes: e.target.value || undefined })} maxLength={600} placeholder="In your own words — e.g. “can’t do much downhill after knee surgery”" className={cx(INPUT, 'mt-3')} data-testid="person-needs-notes" />
      </fieldset>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <div>
          <FieldLabel htmlFor="person-capacity">Physical capacity</FieldLabel>
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

      <div className="mt-5 flex min-w-0 flex-wrap gap-x-6 rule-top pt-3">
        <label className={CHECK_ROW}>
          <input type="checkbox" className={CHECK_BOX} checked={form.preferencesApply} onChange={(e) => setForm({ ...form, preferencesApply: e.target.checked })} />
          Their tastes shape the plan
        </label>
        <label className={CHECK_ROW}>
          <input type="checkbox" className={CHECK_BOX} checked={form.constraintsApply} onChange={(e) => setForm({ ...form, constraintsApply: e.target.checked })} />
          Their needs bind the plan
        </label>
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
