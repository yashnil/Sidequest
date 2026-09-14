/**
 * V8 — THE REVIEW AS A TRIP BRIEF: THE PURE PARTS.
 *
 * What the portrait band states, which glance lines are also hard rules, and
 * which understanding lines are short enough to be chips. Kept out of the
 * component so each claim has a unit test, and so the review never invents a
 * fact: every value here is read from the interview context, the ledger or the
 * accepted window — nothing is derived from a place name.
 */

export interface BriefFact {
  id: 'length' | 'party' | 'timing' | 'shape' | 'pace' | 'priorities';
  label: string;
  value: string;
  /** Sidequest's read rather than the traveller's own statement. */
  assumed: boolean;
  /** Set as a figure (tabular, semibold) when the value is a number the eye reads at a glance. */
  figure: boolean;
}

export function reviewFacts(input: {
  nights: number;
  tripDays: number;
  adults: number;
  children: number;
  /** The window the traveller accepted on this trip, when there is one. */
  acceptedWindow: { label: string } | null;
  /** True while Sidequest has been asked to choose the dates and no window is accepted. */
  timingOpen: boolean;
  shapeLabel: string;
  shapeOpen: boolean;
  shapeAssumed: boolean;
  /*
   * V11 §H — the two facts the band was missing.
   *
   * §H names seven things "Sidequest understands" has to state, and pace and
   * priorities were both a scroll further down, inside cards that also carried
   * four other answers. They come in as already-rendered ledger values rather
   * than being derived here, because the ledger is the one place an answer is
   * turned into a sentence and a second rendering is a second thing to keep
   * true. Absent when the interview never asked.
   */
  pace?: { value: string; assumed: boolean } | null;
  priorities?: { value: string; assumed: boolean } | null;
}): BriefFact[] {
  const nights = `${input.nights} ${input.nights === 1 ? 'night' : 'nights'}`;
  const adults = `${input.adults} ${input.adults === 1 ? 'adult' : 'adults'}`;
  const party = input.children > 0 ? `${adults}, ${input.children} ${input.children === 1 ? 'child' : 'children'}` : adults;
  const timing = input.acceptedWindow ? { value: input.acceptedWindow.label, assumed: false } : input.timingOpen ? { value: 'Sidequest picks the window', assumed: true } : { value: 'Your dates', assumed: false };
  return [
    { id: 'length', label: 'Length', value: `${nights} · ${input.tripDays} ${input.tripDays === 1 ? 'day' : 'days'}`, assumed: false, figure: true },
    { id: 'party', label: 'Who', value: party, assumed: false, figure: true },
    { id: 'timing', label: 'When', value: timing.value, assumed: timing.assumed, figure: /\d/.test(timing.value) },
    { id: 'shape', label: 'Shape', value: input.shapeOpen ? 'Not decided yet' : input.shapeLabel, assumed: input.shapeAssumed || input.shapeOpen, figure: false },
    ...(input.pace ? [{ id: 'pace' as const, label: 'Pace', value: input.pace.value, assumed: input.pace.assumed, figure: false }] : []),
    ...(input.priorities ? [{ id: 'priorities' as const, label: 'Going for', value: input.priorities.value, assumed: input.priorities.assumed, figure: false }] : []),
  ];
}

/**
 * CROSS-SURFACE CONSISTENCY: A RULE IS A RULE WHEREVER IT IS SHOWN.
 *
 * A hard food rule appears under Food *and* under Hard rules, and under Food it
 * must not read as a preference. The glance lines and the ledger's hard
 * entries are two renderings of the same answers, so a glance line whose words
 * match a hard entry is tagged as the rule it is. Matching is on shared words
 * rather than equality because the two describe the same answer in different
 * registers ("Dietary needs are absolute: Vegetarian" / "Vegetarian ·
 * requirements, not preferences").
 */
export function isHardLine(text: string, hard: readonly { label: string }[]): boolean {
  if (hard.length === 0) return false;
  if (/requirements?, not preferences?|\(hard\)/i.test(text)) return true;
  const words = (value: string) => new Set(value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((word) => word.length > 3));
  const mine = words(text);
  if (mine.size === 0) return false;
  return hard.some((entry) => {
    const theirs = [...words(entry.label)];
    if (theirs.length === 0) return false;
    const shared = theirs.filter((word) => mine.has(word)).length;
    return shared >= Math.min(2, theirs.length) && shared / theirs.length >= 0.5;
  });
}

/** The longest line that still reads as a chip rather than a sentence. */
const CHIP_MAX = 40;

/**
 * THE UNDERSTANDING SCREEN'S CHIPS: SHORT FACTS ONLY.
 *
 * The screening's lines are a mix — a scale word, a few trait names, and the
 * odd whole sentence about heat or winter access. The chips row carries the
 * short ones; the assumption sentence is set once as prose and never repeated
 * here (it used to print twice, as a chip and as the paragraph).
 */
export function understandingChips(lines: readonly string[], assumptionSentence: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === assumptionSentence?.trim()) continue;
    if (line.length > CHIP_MAX || /[.!?]$/.test(line)) continue;
    if (seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
  }
  return out;
}
