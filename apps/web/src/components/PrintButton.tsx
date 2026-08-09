'use client';

import { useSyncExternalStore } from 'react';
import { buttonClass } from './ui';

/**
 * "Has this component hydrated?", asked the way React wants it asked.
 *
 * `useSyncExternalStore` with a server snapshot of `false` and a client snapshot
 * of `true` is the sanctioned hydration probe: it needs no effect, no state
 * write during render, and no second pass. A `useState` + `useEffect` pair does
 * the same job and trips `react-hooks/set-state-in-effect`, which is right to
 * complain — this is what it is pointing at.
 */
const subscribe = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * Print, or save as a PDF — one button, because on every current browser they
 * are the same dialog.
 *
 * A client leaf on an otherwise server-rendered page. `ItineraryView` has no
 * `'use client'` and should not gain one: it is a large, entirely static render
 * tree, and turning the whole plan into a client component to get one
 * `window.print()` would ship the itinerary twice.
 *
 * Deliberately the platform's own print path rather than a generated document.
 * A server-rendered PDF would be a second renderer to keep true to the first,
 * and everything that makes this page worth printing — the evidence lines, the
 * "we have not checked today", the legs nobody measured — is already on it. The
 * print stylesheet in `globals.css` does the rest.
 *
 * It renders nothing until the component has mounted. That is not a hydration
 * dodge: a control that says it will print, rendered into HTML that cannot yet
 * respond to a press, is the same defect that swallowed the benchmark pilot's
 * start button for twenty minutes. If the button is on screen, it works.
 */
export function PrintButton() {
  const ready = useSyncExternalStore(subscribe, onClient, onServer);

  /*
   * Present from the first paint, inert until it can work.
   *
   * Returning null before hydration avoided a dead control and introduced a
   * layout shift instead: the two buttons beside it rendered first and were
   * pushed sideways when this appeared, on the product's primary output page. A
   * disabled button of the same size holds the space and is honest about why it
   * is not pressable yet.
   */
  return (
    <button
      type="button"
      className={buttonClass('primary', 'sm')}
      disabled={!ready}
      {...(ready ? {} : { 'aria-disabled': true })}
      onClick={() => window.print()}
    >
      Print or save as PDF
    </button>
  );
}
