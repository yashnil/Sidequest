import type { SplitPlan } from '@sidequest/core';

/**
 * V9 §17 — THE ASK REQUEST A SPLIT PROPOSES, IN THE TRAVELLER'S WORDS.
 *
 * Deterministic from the day and, when the day already splits, its groups.
 * A plain module rather than part of the card, so the party page (a server
 * component) can build the same sentence the card dispatches in the browser.
 */
export function splitRequestFor(dayNumber: number, plan?: Pick<SplitPlan, 'groups'> | null): string {
  const who = plan?.groups.map((g) => g.who).filter((w) => w && w !== 'The others').join(' and ');
  return `Plan a split for day ${dayNumber}: ${who ? `${who} take a gentler half while the others keep the day as written` : 'a gentler half for whoever needs it while the others keep the day as written'}, and say where and when everyone meets again.`;
}
