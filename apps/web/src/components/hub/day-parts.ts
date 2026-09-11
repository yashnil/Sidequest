/**
 * V8 — A DAY READ IN THREE PARTS.
 *
 * The timeline rows carry a start minute, and the day card groups them under
 * morning, midday and evening so eight rows scan as a shape rather than a
 * list. The boundaries match `dayPartFor` in the core (`Late morning` closes
 * at 13:30 there; the coarser grouping here folds it into midday), so a row
 * banded "Late morning" never sits under an "Evening" heading. A travel row
 * belongs to the part of the stop it leads to.
 */
export type DayPartGroup = 'morning' | 'midday' | 'evening';

export const DAY_PART_LABEL: Record<DayPartGroup, string> = {
  morning: 'Morning',
  midday: 'Midday',
  evening: 'Evening',
};

export function dayPartGroupFor(minute: number): DayPartGroup {
  if (minute < 11 * 60 + 30) return 'morning';
  if (minute < 17 * 60) return 'midday';
  return 'evening';
}

export interface DayPartSection<T> {
  part: DayPartGroup;
  items: T[];
}

export function groupByDayPart<T extends { kind: string; startMinute: number }>(items: readonly T[]): DayPartSection<T>[] {
  const groups: DayPartSection<T>[] = [];
  let pendingTravel: T[] = [];
  for (const item of items) {
    if (item.kind === 'travel') {
      pendingTravel.push(item);
      continue;
    }
    const part = dayPartGroupFor(item.startMinute);
    let group = groups[groups.length - 1];
    if (!group || group.part !== part) {
      group = { part, items: [] };
      groups.push(group);
    }
    group.items.push(...pendingTravel, item);
    pendingTravel = [];
  }
  if (pendingTravel.length > 0) {
    const last = groups[groups.length - 1];
    if (last) last.items.push(...pendingTravel);
    else groups.push({ part: dayPartGroupFor(pendingTravel[0]!.startMinute), items: pendingTravel });
  }
  return groups;
}

/** Headings earn their space only when the day actually spans more than one part. */
export function partsAreMeaningful(groups: readonly DayPartSection<unknown>[]): boolean {
  return groups.length > 1;
}
