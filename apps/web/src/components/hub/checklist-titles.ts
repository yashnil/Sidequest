/**
 * V8 — FIVE ROWS TITLED "SET THIS UP BEFORE YOU FLY." ARE FIVE ROWS ABOUT
 * NOTHING.
 *
 * The readiness checklist writes a phase-level phrase as the title of every
 * entry in a phase and puts the substance in the entry's `why`. Five rows in
 * one card carried the same six words as their title, and what each was
 * actually about — an entry authorisation, a visa, the safari operator, cash —
 * sat in the 13-pixel line below. When a title repeats within a phase, each
 * row takes its own subject (the first clause of its reason) as the title and
 * keeps the phrase as the opening of its detail. A title that is unique in its
 * phase is left exactly as written.
 */
export interface ChecklistEntry {
  id: string;
  title: string;
  why: string;
  blocking?: boolean;
  sourceName?: string;
  sourceUrl?: string;
}

export interface ChecklistRow {
  id: string;
  title: string;
  detail: string;
  blocking: boolean;
  sourceName?: string;
  sourceUrl?: string;
}

const SUBJECT_LIMIT = 84;

/** The first clause of a reason, as a title: cut at the first sentence end, semicolon or dash, then at a word boundary if still long. */
export function subjectOf(why: string): string {
  const trimmed = why.trim();
  const match = /^(.*?)(?:[.;!?]\s|\s[—–]\s|:\s|$)/.exec(trimmed);
  let subject = (match?.[1] ?? trimmed).trim().replace(/[.;:,]+$/, '');
  if (subject.length > SUBJECT_LIMIT) {
    const cut = subject.lastIndexOf(' ', SUBJECT_LIMIT);
    subject = `${subject.slice(0, cut > 24 ? cut : SUBJECT_LIMIT).trimEnd()}…`;
  }
  return subject.length > 0 ? subject.charAt(0).toUpperCase() + subject.slice(1) : '';
}

function remainderAfter(why: string, subject: string): string {
  const plain = subject.replace(/…$/, '');
  const index = why.trim().toLowerCase().indexOf(plain.toLowerCase());
  if (index !== 0) return why.trim();
  const rest = why.trim().slice(plain.length).replace(/^[\s.;:,—–-]+/, '');
  return rest.length > 0 ? rest.charAt(0).toUpperCase() + rest.slice(1) : '';
}

export function checklistRows(items: readonly ChecklistEntry[]): ChecklistRow[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
  return items.map((item) => {
    const duplicated = (counts.get(item.title) ?? 0) > 1;
    const subject = duplicated ? subjectOf(item.why) : '';
    if (!subject) {
      return { id: item.id, title: item.title, detail: item.why, blocking: item.blocking ?? false, ...(item.sourceName ? { sourceName: item.sourceName } : {}), ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}) };
    }
    const rest = remainderAfter(item.why, subject);
    const phrase = item.title.trim();
    const detail = rest.length > 0 ? `${phrase} ${rest}` : phrase;
    return { id: item.id, title: subject, detail, blocking: item.blocking ?? false, ...(item.sourceName ? { sourceName: item.sourceName } : {}), ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}) };
  });
}
