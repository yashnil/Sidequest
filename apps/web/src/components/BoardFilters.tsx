'use client';

import {
  PHYSICAL_INTENSITIES,
  type CostLevel,
  type DiscoveryCandidate,
  type PhysicalIntensity,
} from '@sidequest/core';
import { FOCUS_RING, OVERLAY_INPUT, buttonClass, cx } from './ui';

/**
 * NARROWING THE BOARD, WITHOUT INVENTING A SINGLE NUMBER.
 *
 * Every facet here reads a field the candidate already carries and that the card
 * already prints: travel time from base, effort, cost, hidden-gem score, and
 * whether the place is actually open across the trip's dates. Nothing is scored,
 * ranked or synthesised for the purpose of filtering — a filter that sorts by a
 * quantity the traveller cannot see on the card is a filter they cannot predict.
 *
 * Three properties this module exists to guarantee.
 *
 * **Filters are a view, never an edit.** `filterCandidates` returns a subset; it
 * touches no selection, writes nothing, and calls no action. Hiding a card the
 * traveller has included does not un-include it, and clearing the filter brings
 * it back marked exactly as it was. That is why the state lives here and the
 * marks live in the board's own optimistic map.
 *
 * **A facet nobody could act on is not rendered.** `facetsFor` reports which
 * facets actually vary across the cards on screen. A board where everything is
 * free has no cost filter, because a control that cannot change the result is
 * indistinguishable from a broken one.
 *
 * **Additive to "Only what I picked".** That control is a filter too, and it is
 * kept in the board's toolbar where it has always been; these compose with it
 * rather than replacing it.
 */

export interface BoardFilterState {
  /**
   * The furthest the traveller wants to travel from base for one stop, in
   * minutes. `null` is "no limit" rather than zero, because zero is a real
   * answer here — a place at the base itself.
   */
  maxTravelMinutes: number | null;
  /** Empty means every level. A subset is a positive choice of those levels. */
  effort: readonly PhysicalIntensity[];
  cost: readonly CostLevel[];
  hiddenGemsOnly: boolean;
  /** Excludes anything shut, or unreachable, across the whole trip. */
  openThroughoutOnly: boolean;
}

export const NO_FILTERS: BoardFilterState = {
  maxTravelMinutes: null,
  effort: [],
  cost: [],
  hiddenGemsOnly: false,
  openThroughoutOnly: false,
};

export function anyFilterActive(filters: BoardFilterState): boolean {
  return (
    filters.maxTravelMinutes !== null ||
    filters.effort.length > 0 ||
    filters.cost.length > 0 ||
    filters.hiddenGemsOnly ||
    filters.openThroughoutOnly
  );
}

/**
 * The travel-time steps.
 *
 * The same four the questionnaire's detour question uses, so the filter speaks
 * the language the traveller already answered in rather than inventing its own
 * buckets.
 */
const TRAVEL_STEPS = [15, 30, 60, 120] as const;

const EFFORT_LABELS: Record<PhysicalIntensity, string> = {
  none: 'No effort',
  easy: 'Easy',
  moderate: 'Moderate',
  strenuous: 'Strenuous',
};

const COST_LABELS: Record<CostLevel, string> = {
  0: 'Free',
  1: 'Cheap',
  2: 'Moderate',
  3: 'Pricey',
};

const COST_LEVELS: readonly CostLevel[] = [0, 1, 2, 3];

/**
 * "Open every day of the trip" as a claim we can actually stand behind.
 *
 * All three gates have to be *known* good: the season, the operator's hours and
 * the way in. `unknown` hours fail this deliberately — the chip promises that
 * the place is open, and a place nobody publishes hours for is one we cannot say
 * that about. Filtering it in and being wrong is the failure mode that costs a
 * traveller a morning.
 */
function openThroughout(candidate: DiscoveryCandidate): boolean {
  return (
    candidate.season.status === 'open' &&
    (candidate.operating.status === 'always_open' ||
      candidate.operating.status === 'open_every_day') &&
    candidate.access.status === 'open'
  );
}

export function filterCandidates(
  candidates: readonly DiscoveryCandidate[],
  filters: BoardFilterState,
): DiscoveryCandidate[] {
  return candidates.filter((candidate) => {
    if (filters.maxTravelMinutes !== null) {
      /*
       * A journey nobody could establish cannot satisfy "under thirty minutes",
       * so a bounded step drops it. That is the honest reading of a filter: it
       * is a positive claim about what is kept, and admitting an unknown would
       * assert a duration we do not have. "Anywhere" — the default — keeps
       * everything, which is where an unroutable card stays visible.
       */
      const minutes = candidate.travelMinutesFromBase;
      if (minutes === null || minutes > filters.maxTravelMinutes) return false;
    }
    if (filters.effort.length > 0 && !filters.effort.includes(candidate.place.physicalIntensity)) {
      return false;
    }
    if (filters.cost.length > 0 && !filters.cost.includes(candidate.place.costLevel)) {
      return false;
    }
    if (filters.hiddenGemsOnly && candidate.place.hiddenGemScore < 0.6) return false;
    if (filters.openThroughoutOnly && !openThroughout(candidate)) return false;
    return true;
  });
}

export interface BoardFacets {
  travelSteps: readonly number[];
  effort: readonly PhysicalIntensity[];
  cost: readonly CostLevel[];
  hiddenGems: boolean;
  restricted: boolean;
}

/**
 * Which facets this particular board can actually discriminate on.
 *
 * A drive step earns its place only when it would both keep something and drop
 * something; an effort or cost level only when at least one card has it and at
 * least one card does not.
 */
export function facetsFor(candidates: readonly DiscoveryCandidate[]): BoardFacets {
  const total = candidates.length;
  const travelSteps = TRAVEL_STEPS.filter((minutes) => {
    const kept = candidates.filter(
      (candidate) =>
        candidate.travelMinutesFromBase !== null && candidate.travelMinutesFromBase <= minutes,
    ).length;
    return kept > 0 && kept < total;
  });
  const effort = PHYSICAL_INTENSITIES.filter((level) => {
    const kept = candidates.filter((c) => c.place.physicalIntensity === level).length;
    return kept > 0 && kept < total;
  });
  const cost = COST_LEVELS.filter((level) => {
    const kept = candidates.filter((c) => c.place.costLevel === level).length;
    return kept > 0 && kept < total;
  });
  const gems = candidates.filter((c) => c.place.hiddenGemScore >= 0.6).length;
  const open = candidates.filter(openThroughout).length;
  return {
    travelSteps,
    effort,
    cost,
    hiddenGems: gems > 0 && gems < total,
    restricted: open > 0 && open < total,
  };
}

/**
 * A chip that is a real checkbox or radio underneath.
 *
 * Overlaid rather than hidden — the same idiom as `Choice` — so tab order,
 * arrow-key traversal inside a radio group, `aria-checked` and the browser's own
 * announcement all come from the platform. The visible chip only borrows the
 * paint, and shows the focus ring the transparent input cannot.
 */
function FilterChip({
  name,
  type,
  checked,
  onChange,
  children,
}: {
  name: string;
  type: 'radio' | 'checkbox';
  checked: boolean;
  onChange: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cx(
        'relative inline-flex min-h-11 cursor-pointer items-center rounded-full border px-3 text-xs font-medium transition-colors',
        FOCUS_RING,
        checked
          ? 'border-pine-strong bg-pine-soft text-pine-strong'
          : 'border-rule bg-paper-raised text-ink-muted hover:border-ink-faint hover:text-ink',
      )}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        className={OVERLAY_INPUT}
      />
      {checked ? (
        <span aria-hidden="true" className="mr-1">
          ✓
        </span>
      ) : null}
      {children}
    </label>
  );
}

function FacetRow({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-xs font-medium text-ink">{legend}</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">{children}</div>
    </fieldset>
  );
}

export function BoardFilterRail({
  facets,
  filters,
  onChange,
  showing,
  total,
}: {
  facets: BoardFacets;
  filters: BoardFilterState;
  onChange: (next: BoardFilterState) => void;
  showing: number;
  total: number;
}) {
  const active = anyFilterActive(filters);
  const nothing =
    facets.travelSteps.length === 0 &&
    facets.effort.length === 0 &&
    facets.cost.length === 0 &&
    !facets.hiddenGems &&
    !facets.restricted;
  // A board every facet is uniform across cannot be narrowed, and a rail of
  // controls that all return the same board is worse than no rail.
  if (nothing) return null;

  function toggle<T>(list: readonly T[], value: T): T[] {
    return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
  }

  return (
    <section
      aria-labelledby="board-filters"
      data-testid="board-filters"
      className="mb-8 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4 print:hidden"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="board-filters" className="text-sm font-medium text-ink">
          Narrow it down
        </h2>
        <p className="text-xs text-ink-muted" data-testid="board-filter-count">
          Showing {showing} of {total}
        </p>
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {facets.travelSteps.length > 0 ? (
          <FacetRow legend="How far from base">
            <FilterChip
              name="board-filter-travel"
              type="radio"
              checked={filters.maxTravelMinutes === null}
              onChange={() => onChange({ ...filters, maxTravelMinutes: null })}
            >
              Anywhere
            </FilterChip>
            {facets.travelSteps.map((minutes) => (
              <FilterChip
                key={minutes}
                name="board-filter-travel"
                type="radio"
                checked={filters.maxTravelMinutes === minutes}
                onChange={() => onChange({ ...filters, maxTravelMinutes: minutes })}
              >
                {minutes >= 60 ? `Under ${minutes / 60} hr` : `Under ${minutes} min`}
              </FilterChip>
            ))}
          </FacetRow>
        ) : null}

        {facets.effort.length > 0 ? (
          <FacetRow legend="Effort">
            {facets.effort.map((level) => (
              <FilterChip
                key={level}
                name={`board-filter-effort-${level}`}
                type="checkbox"
                checked={filters.effort.includes(level)}
                onChange={() => onChange({ ...filters, effort: toggle(filters.effort, level) })}
              >
                {EFFORT_LABELS[level]}
              </FilterChip>
            ))}
          </FacetRow>
        ) : null}

        {facets.cost.length > 0 ? (
          <FacetRow legend="Cost">
            {facets.cost.map((level) => (
              <FilterChip
                key={level}
                name={`board-filter-cost-${level}`}
                type="checkbox"
                checked={filters.cost.includes(level)}
                onChange={() => onChange({ ...filters, cost: toggle(filters.cost, level) })}
              >
                {COST_LABELS[level]}
              </FilterChip>
            ))}
          </FacetRow>
        ) : null}

        {facets.hiddenGems || facets.restricted ? (
          <FacetRow legend="Kind of thing">
            {facets.hiddenGems ? (
              <FilterChip
                name="board-filter-gems"
                type="checkbox"
                checked={filters.hiddenGemsOnly}
                onChange={() => onChange({ ...filters, hiddenGemsOnly: !filters.hiddenGemsOnly })}
              >
                Hidden gems only
              </FilterChip>
            ) : null}
            {facets.restricted ? (
              <FilterChip
                name="board-filter-open"
                type="checkbox"
                checked={filters.openThroughoutOnly}
                onChange={() =>
                  onChange({ ...filters, openThroughoutOnly: !filters.openThroughoutOnly })
                }
              >
                Open every day of the trip
              </FilterChip>
            ) : null}
          </FacetRow>
        ) : null}
      </div>

      {/*
        Only when there is something to clear. A permanently visible "Clear"
        beside an unfiltered board is a control that does nothing, which is the
        one thing this pass is not allowed to add.
      */}
      {active ? (
        <button
          type="button"
          onClick={() => onChange(NO_FILTERS)}
          className={cx(buttonClass('secondary', 'sm'), 'mt-4')}
          data-testid="board-filter-clear"
        >
          Clear filters
        </button>
      ) : null}
    </section>
  );
}
