'use client';

import { useEffect, useState, type ReactNode } from 'react';

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

export function PlanSubnav({ panels, badges = {}, summaries = {}, initial = 'stays' }: { panels: Record<PlanSectionId, ReactNode>; badges?: Partial<Record<PlanSectionId, number>>; /** The one figure each section is about, read under its name (the index as a figure table). */ summaries?: Partial<Record<PlanSectionId, string>>; initial?: PlanSectionId }) {
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
      {/*
        SURVEY ATLAS — the section index is the plan's figure table: a number,
        the section's name and the one figure it is about, in cells that share
        their borders. The figure is aria-hidden so each tab is still named by
        its section alone.
      */}
      <div role="tablist" aria-label="Plan sections" className="hv-tabs -mx-4 px-4 sm:mx-0 sm:px-0">
        {PLAN_SECTIONS.map((section, index) => {
          const on = section.id === active;
          const badge = badges[section.id];
          const summary = summaries[section.id];
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
              className="hv-tab pressable focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-pine"
            >
              <span aria-hidden="true" className="coordbar text-ink-faint">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="hv-tab-label inline-flex items-center gap-1.5">
                {section.label}
                {badge ? <span className="type-figure border border-current px-1 font-sans text-[10.5px] leading-4">{badge}</span> : null}
              </span>
              {summary ? (
                <span aria-hidden="true" className="hv-tab-sum">
                  {summary}
                </span>
              ) : null}
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
