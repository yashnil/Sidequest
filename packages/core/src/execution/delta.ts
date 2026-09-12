/**
 * V9 §4 — THE DETERMINISTIC DELTA.
 *
 * Before Apply, a proposal shows what the patched draft does to the shape of
 * the trip — bases, hotel changes, stops, signature stops kept, the days that
 * change, driving legs — computed from the drafts themselves, never from the
 * model's prose. After Apply, the measured delta compares the two persisted
 * `package.metrics` records. Both are pure.
 */
export interface DeltaDraftShape {
  bases: readonly { id: string; name: string; nights: number }[];
  days: readonly { dayNumber: number; baseId?: string; anchors: readonly { name: string; role?: string; transport?: string; kind?: string }[] }[];
}

export interface DeltaLine {
  label: string;
  before: string;
  after: string;
  /** Positive is "more", negative "less"; null for a non-numeric line. */
  change: number | null;
  /** Whether the change reads as an improvement for the traveller on this line, when that is knowable. */
  tone: 'better' | 'worse' | 'neutral';
}

export interface DraftDelta {
  lines: DeltaLine[];
  daysChanged: number[];
  signatureKept: { kept: number; total: number };
  headline: string;
}

function norm(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function line(label: string, before: number, after: number, lowerIsBetter: boolean | null, format: (n: number) => string = String): DeltaLine {
  const change = after - before;
  const tone: DeltaLine['tone'] = change === 0 || lowerIsBetter === null ? 'neutral' : (change < 0) === lowerIsBetter ? 'better' : 'worse';
  return { label, before: format(before), after: format(after), change, tone };
}

function baseChanges(shape: DeltaDraftShape): number {
  const sequence = shape.days.map((d) => d.baseId).filter((b): b is string => Boolean(b));
  if (sequence.length > 0) return sequence.filter((b, i) => i > 0 && b !== sequence[i - 1]).length;
  return Math.max(0, shape.bases.filter((b) => b.nights > 0).length - 1);
}

export function draftDelta(before: DeltaDraftShape, after: DeltaDraftShape): DraftDelta {
  const lines: DeltaLine[] = [];
  const basesBefore = before.bases.filter((b) => b.nights > 0).length;
  const basesAfter = after.bases.filter((b) => b.nights > 0).length;
  if (basesBefore !== basesAfter) lines.push(line('Bases', basesBefore, basesAfter, null));
  const churnBefore = baseChanges(before);
  const churnAfter = baseChanges(after);
  if (churnBefore !== churnAfter) lines.push(line('Hotel changes', churnBefore, churnAfter, true));

  const stops = (shape: DeltaDraftShape) => shape.days.reduce((n, d) => n + d.anchors.length, 0);
  if (stops(before) !== stops(after)) lines.push(line('Stops', stops(before), stops(after), null));

  const drives = (shape: DeltaDraftShape) => shape.days.reduce((n, d) => n + d.anchors.filter((a) => a.transport === 'drive' || a.transport === 'car').length, 0);
  if (drives(before) !== drives(after)) lines.push(line('Driving legs', drives(before), drives(after), true));

  const signature = before.days.flatMap((d) => d.anchors.filter((a) => a.role === 'core').map((a) => norm(a.name)));
  const afterNames = new Set(after.days.flatMap((d) => d.anchors.map((a) => norm(a.name))));
  const kept = signature.filter((name) => afterNames.has(name)).length;
  const signatureKept = { kept, total: signature.length };
  if (signature.length > 0) lines.push({ label: 'Signature stops kept', before: `${signature.length}`, after: `${kept}/${signature.length}`, change: kept - signature.length, tone: kept === signature.length ? 'better' : 'worse' });

  const daysChanged: number[] = [];
  const beforeDays = new Map(before.days.map((d) => [d.dayNumber, d] as const));
  for (const day of after.days) {
    const prior = beforeDays.get(day.dayNumber);
    const a = prior ? prior.anchors.map((x) => norm(x.name)).join('|') + `#${prior.baseId ?? ''}` : '';
    const b = day.anchors.map((x) => norm(x.name)).join('|') + `#${day.baseId ?? ''}`;
    if (!prior || a !== b) daysChanged.push(day.dayNumber);
  }
  for (const day of before.days) if (!after.days.some((d) => d.dayNumber === day.dayNumber)) daysChanged.push(day.dayNumber);
  daysChanged.sort((x, y) => x - y);
  const dayList = daysChanged.length === 0 ? 'No day changes' : daysChanged.length === 1 ? `Day ${daysChanged[0]} changes` : `Days ${daysChanged.join(', ').replace(/, ([^,]*)$/, ' and $1')} change`;
  lines.push({ label: 'Days', before: '', after: dayList, change: null, tone: 'neutral' });
  const headline = lines.filter((l) => l.change !== null && l.change !== 0).map((l) => `${l.label} ${l.before} → ${l.after}`).slice(0, 3).join(' · ') || dayList;
  return { lines, daysChanged, signatureKept, headline };
}

/** `package.metrics` after an Apply, compared with the version before it. */
export function metricsDelta(before: Record<string, number | null>, after: Record<string, number | null>, dayCount: number): DeltaLine[] {
  const lines: DeltaLine[] = [];
  const num = (m: Record<string, number | null>, key: string) => (typeof m[key] === 'number' ? (m[key] as number) : null);
  const minutes = (n: number) => {
    const sign = n < 0 ? '−' : n > 0 ? '+' : '';
    const abs = Math.abs(n);
    const h = Math.floor(abs / 60);
    const m = Math.round(abs % 60);
    return `${sign}${h > 0 ? `${h} h ` : ''}${m} min`.trim();
  };
  const b = num(before, 'travelBurdenMinutesPerDay');
  const a = num(after, 'travelBurdenMinutesPerDay');
  if (b !== null && a !== null && a !== b) lines.push({ label: 'Travel across the trip', before: minutes(b * dayCount), after: minutes(a * dayCount), change: (a - b) * dayCount, tone: a < b ? 'better' : 'worse' });
  for (const [key, label, lowerIsBetter] of [
    ['hotelChurn', 'Hotel changes', true],
    ['unmeasuredMajorTransfers', 'Transfers not yet timed', true],
    ['freeMinutesPerDay', 'Free time per day', false],
    ['unverifiedCriticalDependencies', 'Open dependencies', true],
  ] as const) {
    const x = num(before, key);
    const y = num(after, key);
    if (x !== null && y !== null && x !== y) lines.push(line(label, x, y, lowerIsBetter, key === 'freeMinutesPerDay' ? (n) => minutes(n).replace(/^\+/, '') : String));
  }
  return lines;
}
