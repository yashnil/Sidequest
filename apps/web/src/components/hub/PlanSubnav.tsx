'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cx } from '../ui';

/**
 * EXPERIENCE V2 — ONE LOGISTICS SECTION AT A TIME.
 *
 * Stays, Transport, Food, Budget and Bookings used to stack down one long
 * page under 2-px rules. They are one segmented control now; every panel stays
 * in the document (print and search see all of them), only the selected one is
 * displayed. Legacy anchors (`#stays`, `#getting-around`, `#food`, `#budget`,
 * `#bookings`) still land on the right segment.
 */
export const PLAN_SECTIONS = [
  { id: 'stays', label: 'Stays', anchors: ['stays'] },
  { id: 'transport', label: 'Transport', anchors: ['getting-around', 'transport'] },
  { id: 'food', label: 'Food', anchors: ['food'] },
  { id: 'budget', label: 'Budget', anchors: ['budget'] },
  { id: 'bookings', label: 'Bookings', anchors: ['bookings'] },
] as const;
export type PlanSectionId = (typeof PLAN_SECTIONS)[number]['id'];

export function planSectionForHash(hash: string): PlanSectionId | null {
  const raw = hash.replace(/^#/, '');
  for (const section of PLAN_SECTIONS) if ((section.anchors as readonly string[]).includes(raw) || section.id === raw) return section.id;
  return null;
}

export function PlanSubnav({ panels, badges = {}, initial = 'stays' }: { panels: Record<PlanSectionId, ReactNode>; badges?: Partial<Record<PlanSectionId, number>>; initial?: PlanSectionId }) {
  const [active, setActive] = useState<PlanSectionId>(initial);
  useEffect(() => {
    const apply = () => {
      const next = planSectionForHash(window.location.hash);
      if (next) setActive(next);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);
  return (
    <div data-testid="plan-subnav" data-plan-section={active}>
      <div role="tablist" aria-label="Plan sections" className="no-scrollbar -mx-5 flex gap-1 overflow-x-auto border-b border-rule px-5 sm:mx-0 sm:px-0">
        {PLAN_SECTIONS.map((section) => {
          const on = section.id === active;
          const badge = badges[section.id];
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              id={`plan-tab-${section.id}`}
              aria-selected={on}
              aria-controls={`plan-panel-${section.id}`}
              data-testid={`plan-tab-${section.id}`}
              onClick={() => {
                setActive(section.id);
                window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${section.anchors[0]}`);
              }}
              className={cx(
                'pressable relative inline-flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-pine',
                on ? 'text-ink after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:bg-[var(--color-route)]' : 'text-ink-muted hover:text-ink',
              )}
            >
              {section.label}
              {badge ? <span className="type-figure rounded-full bg-paper-sunk px-1.5 text-xs leading-5 text-ink-muted">{badge}</span> : null}
            </button>
          );
        })}
      </div>
      {PLAN_SECTIONS.map((section) => (
        <section key={section.id} id={`plan-panel-${section.id}`} role="tabpanel" aria-labelledby={`plan-tab-${section.id}`} className="plan-panel" data-active={section.id === active ? 'true' : 'false'} data-plan-panel={section.id}>
          {panels[section.id]}
        </section>
      ))}
    </div>
  );
}
