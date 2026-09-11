'use client';

import { useState, useTransition } from 'react';
import { ErrorNote, FieldLabel, buttonClass } from '@/components/ui';
import { saveProfileAction } from './actions';

const INPUT =
  'mt-1.5 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';
const AREA =
  'mt-1.5 w-full resize-y rounded-[var(--radius-control)] border border-rule bg-paper px-3 py-2.5 text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

/**
 * THE PROFILE FORM — TWO FACTS AND FOUR PREFERENCES, NOT A SETTINGS PAGE.
 *
 * Two cards so the eye can tell the halves apart: who you are (a name, the
 * airport you leave from), then how you usually travel. The save state is a
 * real confirmation rather than a grey word — a form that says "Saved." in
 * caption type is a form people press twice.
 */
export function ProfileForm({ initial, email }: { initial: { displayName: string; homeAirport: string; usual: { budgetStyle?: string; pace?: string; drives?: boolean; foodNotes?: string; lodgingNotes?: string } }; email: string | null }) {
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [homeAirport, setHomeAirport] = useState(initial.homeAirport);
  const [budgetStyle, setBudgetStyle] = useState(initial.usual.budgetStyle ?? '');
  const [pace, setPace] = useState(initial.usual.pace ?? '');
  const [drives, setDrives] = useState(initial.usual.drives ?? true);
  const [foodNotes, setFoodNotes] = useState(initial.usual.foodNotes ?? '');
  const [lodgingNotes, setLodgingNotes] = useState(initial.usual.lodgingNotes ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const touched = () => {
    if (saved) setSaved(false);
    if (error) setError(null);
  };

  return (
    <form
      className="mt-8 grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const result = await saveProfileAction({ displayName, homeAirport, usual: { budgetStyle: budgetStyle || undefined, pace: pace || undefined, drives, foodNotes: foodNotes || undefined, lodgingNotes: lodgingNotes || undefined } });
          if (!result.ok) setError(result.error);
          else setSaved(true);
        });
      }}
    >
      <section className="card rounded-[var(--radius-panel)] p-5 sm:p-6" aria-labelledby="profile-you">
        <h2 id="profile-you" className="type-section text-ink">
          You
        </h2>
        {email ? <p className="mt-1 type-small text-ink-muted">Signed in as {email}</p> : null}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="profile-name">Name</FieldLabel>
            <input id="profile-name" value={displayName} onChange={(e) => { touched(); setDisplayName(e.target.value); }} maxLength={60} className={INPUT} data-testid="profile-name" />
          </div>
          <div>
            <FieldLabel htmlFor="profile-airport">Home airport</FieldLabel>
            <input id="profile-airport" value={homeAirport} onChange={(e) => { touched(); setHomeAirport(e.target.value); }} maxLength={12} placeholder="e.g. SFO" className={INPUT} data-testid="profile-airport" />
          </div>
        </div>
      </section>

      <section className="card rounded-[var(--radius-panel)] p-5 sm:p-6" aria-labelledby="profile-usual">
        <h2 id="profile-usual" className="type-section text-ink">
          How you usually travel
        </h2>
        <p className="mt-1 type-small text-ink-muted">A starting point for a new trip, never a rule.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="profile-budget">Usual budget</FieldLabel>
            <select id="profile-budget" value={budgetStyle} onChange={(e) => { touched(); setBudgetStyle(e.target.value); }} className={INPUT}>
              <option value="">Not set</option>
              <option value="budget">Budget</option>
              <option value="midrange">Mid-range</option>
              <option value="premium">Premium</option>
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="profile-pace">Usual pace</FieldLabel>
            <select id="profile-pace" value={pace} onChange={(e) => { touched(); setPace(e.target.value); }} className={INPUT}>
              <option value="">Not set</option>
              <option value="slow">Slow</option>
              <option value="balanced">Balanced</option>
              <option value="fast">Fast</option>
            </select>
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink sm:col-span-2">
            <input type="checkbox" checked={drives} onChange={(e) => { touched(); setDrives(e.target.checked); }} className="h-5 w-5 accent-[var(--color-accent)]" />
            Comfortable driving on trips
          </label>
          <div className="sm:col-span-2">
            <FieldLabel htmlFor="profile-food">Food, in your words</FieldLabel>
            <textarea id="profile-food" value={foodNotes} onChange={(e) => { touched(); setFoodNotes(e.target.value); }} maxLength={400} rows={2} placeholder="What you look for, and what you avoid." className={AREA} />
          </div>
          <div className="sm:col-span-2">
            <FieldLabel htmlFor="profile-lodging">Where you like to stay</FieldLabel>
            <textarea id="profile-lodging" value={lodgingNotes} onChange={(e) => { touched(); setLodgingNotes(e.target.value); }} maxLength={400} rows={2} placeholder="The kind of place, and where in a town." className={AREA} />
          </div>
        </div>
      </section>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('accent')} data-testid="profile-save">
          {pending ? 'Saving…' : 'Save profile'}
        </button>
        <p aria-live="polite" className="type-small text-pine">
          {saved ? 'Saved. New trips will start from this.' : ''}
        </p>
      </div>
    </form>
  );
}
