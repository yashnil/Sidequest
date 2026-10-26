import type { KeyboardEvent } from 'react';

/**
 * Arrow keys for a `role="radiogroup"` built from buttons.
 *
 * Native radios move with the arrows on their own; these groups are buttons
 * (they carry test ids and `aria-checked`), so the group does it: an arrow
 * moves focus to the next or previous radio and selects it, wrapping at the
 * ends, exactly as a native group would. Put it on the group's `onKeyDown`
 * and give only the checked radio (or the first, when none is) `tabIndex={0}`.
 */
export function onRadioGroupKeys(event: KeyboardEvent<HTMLElement>): void {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (step === 0) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
  const index = radios.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  event.preventDefault();
  const next = radios[(index + step + radios.length) % radios.length];
  next?.focus();
  next?.click();
}

/** The roving tab stop: the checked radio, or the first when nothing is checked yet. */
export function rovingTabIndex(on: boolean, index: number, anyChecked: boolean): 0 | -1 {
  return on || (!anyChecked && index === 0) ? 0 : -1;
}
