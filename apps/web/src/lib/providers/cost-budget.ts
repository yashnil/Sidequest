/**
 * PER-GENERATION PROVIDER BUDGETS.
 *
 * Nothing scales with all POIs × all days × all pairs. Each budget names the
 * ceiling for one build; an exhausted budget marks the rest "verify later"
 * and never triggers a retry or a model call.
 */
export const BUDGET_KINDS = ['place_identity', 'place_operational', 'place_media', 'route_confirmation', 'route_matrix_elements', 'traffic', 'lodging_discovery', 'food_discovery', 'fx'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export interface BudgetCeilings {
  place_identity: number;
  place_operational: number;
  place_media: number;
  route_confirmation: number;
  route_matrix_elements: number;
  traffic: number;
  lodging_discovery: number;
  food_discovery: number;
  fx: number;
}

export function ceilingsFor(input: { anchors: number; days: number; bases: number; mealsNeedingVenue: number }): BudgetCeilings {
  return {
    place_identity: input.anchors,
    place_operational: Math.min(input.anchors, 2 * input.days),
    place_media: 0,
    route_confirmation: Math.max(0, input.bases - 1) + 2 + input.days,
    route_matrix_elements: input.days * 36,
    traffic: 4,
    lodging_discovery: input.bases * 3,
    food_discovery: input.mealsNeedingVenue,
    fx: 1,
  };
}

export class ProviderBudget {
  private readonly spent: Record<BudgetKind, number> = { place_identity: 0, place_operational: 0, place_media: 0, route_confirmation: 0, route_matrix_elements: 0, traffic: 0, lodging_discovery: 0, food_discovery: 0, fx: 0 };
  private readonly refused: Record<BudgetKind, number> = { ...this.spent };

  constructor(readonly ceilings: BudgetCeilings) {}

  /** Take `amount` units if the ceiling allows; false means "verify later", never "retry". */
  take(kind: BudgetKind, amount = 1): boolean {
    if (this.spent[kind] + amount > this.ceilings[kind]) {
      this.refused[kind] += 1;
      return false;
    }
    this.spent[kind] += amount;
    return true;
  }

  remaining(kind: BudgetKind): number {
    return Math.max(0, this.ceilings[kind] - this.spent[kind]);
  }

  report(): { spent: Record<BudgetKind, number>; refused: Record<BudgetKind, number>; ceilings: BudgetCeilings } {
    return { spent: { ...this.spent }, refused: { ...this.refused }, ceilings: this.ceilings };
  }
}

/** Run at most `limit` tasks at once, and stop starting new ones once `deadline()` is true. */
export async function boundedAll<T, R>(items: readonly T[], limit: number, deadline: () => boolean, run: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      if (deadline()) {
        results[index] = null;
        continue;
      }
      try {
        results[index] = await run(items[index]!);
      } catch {
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
