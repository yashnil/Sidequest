'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A `<details>` that behaves like a menu once the page has hydrated: pressing
 * elsewhere or Escape closes it.
 *
 * Still a real `<details>`, so it opens and closes before hydration and with no
 * script at all. The band's "More" panel used to stay open over the tab strip
 * until the same word was pressed again, which swallowed the next press on a tab.
 */
export function DismissableDetails({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const element = ref.current;
      if (!element?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details ref={ref} className={className}>
      {children}
    </details>
  );
}
