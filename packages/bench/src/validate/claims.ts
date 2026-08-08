import type { BenchmarkGroundTruth } from '../ground-truth';
import { type BenchFinding, type BenchSubject } from '../schemas/finding';
import { type BenchmarkPlan, type EvidenceRef, type PlanBlock, type PlanDay } from '../schemas/plan';
import { report, safeArray, subjectOf, unresolved, type CheckContext } from './context';

/**
 * WHAT THE PLAN ASSERTS ABOUT THE WORLD.
 *
 * The highest false-positive risk in the whole validator, and the design is
 * shaped almost entirely by that.
 *
 * Two stages, graded differently on purpose.
 *
 * **Stage A** takes the plan's own structured evidence and asks the ground-truth
 * port whether the source behind it says what the plan says it says. A source
 * that contradicts the claim is `major`: the plan did the work of citing and
 * cited something that does not hold. A port that cannot answer is `unknown`,
 * never a defect.
 *
 * **Stage B** sweeps the prose for exact values — times, money, durations,
 * distances, closures, permits — and flags the ones sitting on a block with no
 * evidence at all. It is `minor`, and the reason is asymmetry: prose length is
 * not a defect, and at `major` this check would systematically punish whichever
 * system wrote the more useful notes while rewarding one that said "visit the
 * lake" and nothing else. A benchmark that pushes both competitors toward vaguer
 * writing has broken the thing it was measuring.
 *
 * Five mitigations run before anything is flagged, and each exists because
 * without it the sweep fires on writing that is not making a claim at all:
 *
 *  (a) a clock time that is the block's *own* start, end or stated window, and a
 *      duration that is the block's *own* length or stated journey time, are the
 *      block describing its schedule rather than asserting a fact about the
 *      world;
 *  (b) a hedge in front of a number — "about ninety minutes" — is the writer
 *      being honest about precision, so it drops to informational;
 *  (c) a bare number is never a claim; a unit or a currency must be adjacent;
 *  (d) dates, day labels and road designators carry digits that mean nothing
 *      numerically, and `US-395` is a name;
 *  (e) a range is one claim, not two.
 *
 * Evidence excuses a claim by *kind*, not wholesale. A citation to an opening
 * timetable vouches for the clock times and the closures around it and says
 * nothing about a distance or a price, so exempting a block's entire note
 * because it carried one hours reference would hand a blanket immunity to
 * whichever system happens to cite hours — which is both of them, on the one
 * fact they both look up. The same rule runs over the trip-level prose, using
 * the union of what the plan's own citations vouch for, rather than the old test
 * of whether the run retrieved anything at all: that test was satisfied by
 * essentially every run of one arm and essentially no run of the other, so it
 * decided the sweep on provenance instead of on evidence.
 *
 * The findings are counts rather than a rate per thousand words, and that is
 * deliberate. A finding names a subject a reviewer can go and look at; a density
 * names nothing, cannot be re-derived from one plan and one truth, and cannot be
 * placed on a block. The asymmetry a rate would have corrected — a longer note
 * has more chances to trip — is instead handled by grading the whole sweep
 * `minor`, so that prose length moves the number a benchmark reports last rather
 * than the number it reports first.
 */

/* ------------------------------------------------------------------ *
 * The vocabulary of an exact value
 * ------------------------------------------------------------------ */

const CLOCK_SOURCE = String.raw`(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]\.?m\.?)?|(?:1[0-2]|[1-9])\s?[ap]\.?m\.?)`;

/**
 * Exported so the tests can target each sweep independently, and so a reviewer
 * disputing a finding can see exactly what matched rather than inferring it.
 */
export const CLAIM_PATTERNS = {
  clock: new RegExp(CLOCK_SOURCE, 'gi'),
  money: /(?:[$£€¥]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|jpy|dollars?|euros?|pounds?|yen)\b)/gi,
  duration: /\b\d+(?:\.\d+)?\s?(?:minutes?|mins?\b|hours?|hrs?\b|nights?|days?)\b/gi,
  distance: /\b\d+(?:\.\d+)?\s?(?:km\b|kilometres?|kilometers?|miles?\b|mi\b|metres?|meters?|ft\b|feet)\b/gi,
  closure: /\b(?:closed|closes|shut|shuts)\s+(?:on|every|during|for|in|all)\s+[a-z]+\b/gi,
  requirement:
    /\b(?:permits?|reservations?|bookings?|timed entry|tickets?)\s+(?:are|is)?\s*(?:required|needed|mandatory|essential)\b|\b(?:requires?|need)\s+(?:a\s+)?(?:permit|reservation|booking|ticket)s?\b/gi,
} as const;

export type ClaimTokenKind = keyof typeof CLAIM_PATTERNS;

/**
 * Zones whose digits are not quantities.
 *
 * A road number is a name, a date is a label, and "day 3" is a position in the
 * plan. Every one of these would otherwise match the numeric sweeps, and every
 * one of them appears constantly in real itinerary prose.
 */
export const CLAIM_EXCLUSION_PATTERNS: readonly RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\bday\s?\d+\b/gi,
  /\b(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)[a-z]*\.?\s*\d{1,2}\b/gi,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
  /\b(?:US|CA|SR|Hwy|Highway|Route|Interstate)[- ]?\d+\b/g,
];

/**
 * Words that turn a number into an estimate.
 *
 * A writer who says "about two hours" has told the truth about their own
 * precision, and treating that as an unsupported exact value would push both
 * systems toward stating numbers with more confidence than they have — the
 * opposite of what this benchmark wants to reward.
 */
export const HEDGE_WORDS: readonly string[] = [
  'about',
  'around',
  'roughly',
  'approximately',
  'approx',
  'typically',
  'usually',
  'up to',
  'or so',
  'circa',
  'nearly',
  'close to',
  'give or take',
  'estimated',
  'perhaps',
  'maybe',
  '~',
];

export interface ProseToken {
  kind: ClaimTokenKind;
  text: string;
  start: number;
  end: number;
  hedged: boolean;
  /** Every clock time the token names, in minutes past midnight. */
  minutes: readonly number[];
  /** Every span the token names, in minutes, where the unit converts to one. */
  durationMinutes: readonly number[];
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

export function scanProse(text: string): ProseToken[] {
  const source = String(text ?? '');
  if (source.length === 0) return [];

  const excluded = exclusionZones(source);
  const raw: ProseToken[] = [];

  for (const kind of Object.keys(CLAIM_PATTERNS) as ClaimTokenKind[]) {
    for (const match of source.matchAll(CLAIM_PATTERNS[kind])) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (excluded.some((zone) => start < zone.end && end > zone.start)) continue;
      raw.push({ kind, text: match[0], start, end, hedged: false, minutes: [], durationMinutes: [] });
    }
  }

  // Equal elements compare equal. A comparator returning 1 for a tie is not a
  // total order, and the order it produces depends on the sort implementation —
  // which would make the findings a function of the engine rather than of the
  // plan, and this report is required to be byte-identical for one plan.
  raw.sort(
    (a, b) =>
      a.start - b.start || b.end - a.end || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );

  // One claim, one token: overlapping matches from two sweeps are the same
  // assertion seen twice, and a range is a single statement about the world.
  const merged: ProseToken[] = [];
  for (const token of raw) {
    const previous = merged[merged.length - 1];
    if (previous && token.start < previous.end) continue;
    if (previous && previous.kind === token.kind && joinsAsRange(source.slice(previous.end, token.start))) {
      merged[merged.length - 1] = {
        ...previous,
        text: source.slice(previous.start, token.end),
        end: token.end,
      };
      continue;
    }
    merged.push(token);
  }

  return merged.map((token) => ({
    ...token,
    hedged: isHedged(source, token),
    minutes: clockMinutesIn(token.text),
    durationMinutes: durationMinutesIn(token.text),
  }));
}

function exclusionZones(source: string): { start: number; end: number }[] {
  const zones: { start: number; end: number }[] = [];
  for (const pattern of CLAIM_EXCLUSION_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const start = match.index ?? 0;
      zones.push({ start, end: start + match[0].length });
    }
  }
  return zones;
}

function joinsAsRange(between: string): boolean {
  return /^\s*(?:-|–|—|to|until|till)\s*$/i.test(between);
}

const HEDGE_LOOKBEHIND = 26;

function isHedged(source: string, token: ProseToken): boolean {
  const before = source.slice(Math.max(0, token.start - HEDGE_LOOKBEHIND), token.start).toLowerCase();
  const after = source.slice(token.end, token.end + HEDGE_LOOKBEHIND).toLowerCase();
  if (/\bor so\b/.test(after)) return true;
  return HEDGE_WORDS.some((hedge) => {
    if (hedge === '~') return before.trimEnd().endsWith('~') || source[token.start - 1] === '~';
    // Immediately preceding: the hedge has to be attached to this number, not
    // merely somewhere in the sentence.
    return new RegExp(`\\b${hedge.replace(/ /g, '\\s+')}\\s*$`).test(before);
  });
}

function clockMinutesIn(text: string): number[] {
  const minutes: number[] = [];
  for (const match of text.matchAll(new RegExp(CLOCK_SOURCE, 'gi'))) {
    const parsed = parseClock(match[0]);
    if (parsed !== null) minutes.push(parsed);
  }
  return minutes;
}

/**
 * Every span in the token, converted to minutes.
 *
 * Only the units that convert without an assumption. A night is not a fixed
 * number of minutes and a day of sightseeing is not twenty-four hours, so those
 * are left unparsed and a token naming them is never suppressed as
 * self-description — which is the safe direction, since suppression is what
 * stops a finding rather than what starts one.
 */
function durationMinutesIn(text: string): number[] {
  const spans: number[] = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s?(minutes?|mins?|hours?|hrs?)\b/gi)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const unit = (match[2] ?? '').toLowerCase();
    spans.push(unit.startsWith('h') ? Math.round(value * 60) : Math.round(value));
  }
  return spans;
}

function parseClock(text: string): number | null {
  const normalised = text.toLowerCase().replace(/[.\s]/g, '');
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(normalised);
  const rawHours = match?.[1];
  if (rawHours === undefined) return null;
  let hours = Number(rawHours);
  const minutes = Number(match?.[2] ?? '0');
  const meridiem = match?.[3];
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

export function checkClaims(
  plan: BenchmarkPlan,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const sourceCount = safeArray(plan.sources).length;
  const planCoverage = new Set<ClaimTokenKind>();

  for (const day of safeArray(plan.days)) {
    safeArray(day.blocks).forEach((block, index) => {
      const subject = subjectOf(day, { blockIndex: index, entityId: block.place?.entityId ?? null });
      const coverage = coverageOf(evidenceOn(block));
      for (const kind of coverage) planCoverage.add(kind);
      findings.push(...checkStructuredEvidence(block, subject, sourceCount, truth, ctx));
      findings.push(...sweepBlockProse(day, block, index, coverage, ctx));
    });
  }

  findings.push(...sweepPlanProse(plan, planCoverage, ctx));
  return findings;
}

function evidenceOn(block: PlanBlock): EvidenceRef[] {
  const refs = [...safeArray(block.evidence)];
  const opening = block.opening?.evidence;
  if (opening) refs.push(opening);
  return refs;
}

/* ------------------------------------------------------------------ *
 * What a citation vouches for
 * ------------------------------------------------------------------ */

/**
 * The join between the fact a citation names and the kinds of claim it settles.
 *
 * Ordered, and the order matters where a word belongs to two families: an
 * "admission" in an hours path is a time and in a price path is a sum, so the
 * timetable rule is consulted first. Exported so a disputed suppression can be
 * traced to the row that granted it rather than argued about.
 */
export const FACT_PATH_COVERAGE: readonly { pattern: RegExp; kinds: readonly ClaimTokenKind[] }[] = [
  { pattern: /hour|opening|open|clos|admission|schedule|timetable|season/i, kinds: ['clock', 'closure'] },
  { pattern: /price|cost|fee|fare|charge|budget/i, kinds: ['money'] },
  { pattern: /duration|minutes|length|dwell/i, kinds: ['duration'] },
  { pattern: /distance|km|kilometre|kilometer|mile|elevation|gain/i, kinds: ['distance'] },
  { pattern: /permit|reservation|booking|ticket|entry/i, kinds: ['requirement'] },
];


/**
 * Which kinds of claim a set of citations can answer for.
 *
 * Two readings, in order. The fact path is the plan saying what it looked up.
 * Failing that, the quoted value is scanned with the same vocabulary the prose
 * is — a citation quoting `09:00-17:30` has told us it is about the clock as
 * plainly as one naming `hours.weekly`.
 *
 * ---
 *
 * A CITATION THAT SAYS NOTHING NOW VOUCHES FOR NOTHING.
 *
 * It used to vouch for everything, and the note here argued that was the
 * generous reading, symmetric because "the rule depends on what the citation
 * says, never on which system wrote it". The rule was symmetric. Its inputs were
 * not: one converter can only ever emit a bare `sourceIndex`, and the other
 * always attaches a `factPath`. So the blanket immunity was available to exactly
 * one arm — and through `sweepPlanProse`, which unions block coverage, a single
 * bare citation anywhere immunised that arm's entire summary and warning list
 * against the whole unsupported-value sweep, while the other arm's summary stayed
 * exposed for every kind but the clock.
 *
 * Two identical plans, one converted each way, scored differently on a check
 * about what a *plan* asserts. That is the failure mode this module exists to
 * prevent, arriving through the door marked generosity.
 *
 * The generous reading is now unavailable to both rather than to neither: a
 * citation with no fact path and no quoted value has not shown which sentence it
 * supports, and the sweep is about exactly that. Both converters can say what a
 * citation is for, and both now have to.
 */
function coverageOf(refs: readonly EvidenceRef[]): Set<ClaimTokenKind> {
  const kinds = new Set<ClaimTokenKind>();
  for (const ref of refs) {
    const factPath = ref.factPath;
    const statedValue = ref.statedValue;
    if (factPath === undefined && statedValue === undefined) continue;
    if (factPath !== undefined) {
      for (const rule of FACT_PATH_COVERAGE) {
        if (rule.pattern.test(factPath)) {
          for (const kind of rule.kinds) kinds.add(kind);
          break;
        }
      }
    }
    if (statedValue !== undefined) {
      for (const token of scanProse(statedValue)) kinds.add(token.kind);
    }
  }
  return kinds;
}

function checkStructuredEvidence(
  block: PlanBlock,
  subject: BenchSubject,
  sourceCount: number,
  truth: BenchmarkGroundTruth,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];

  for (const ref of evidenceOn(block)) {
    const index = ref.sourceIndex;
    /*
     * THE ONLY INDEX CHECK.
     *
     * A pointer past the end of the plan's own source list is checkable without
     * any world data, and it is the one form of citation that is definitely
     * wrong. It is settled here, against the list the plan itself published, and
     * nowhere else: an implementation of the port that also range-checked would
     * be answering with its own count of what a run retrieved, so a plan citing
     * its fifth source would be convicted of an unsupported claim because the
     * harness happened to record four — a major finding decided by a number that
     * has nothing to do with the plan.
     */
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= sourceCount) {
      ctx.decided();
      findings.push(
        report(
          'unsupported_factual_claim',
          'major',
          subject,
          `"${block.title}" cites a source the plan does not list.`,
          'plan.sources',
          { observed: { sourceIndex: typeof index === 'number' ? index : null, sourceCount } },
        ),
      );
      continue;
    }

    /*
     * The port answers one question — does this source say this — and it needs
     * a value to be asked about. A citation quoting nothing cannot be confirmed
     * or contradicted, so it is undecided rather than either. Asking anyway
     * would invite an implementation to answer about the index instead, which is
     * the confusion the block above exists to end.
     */
    if (ref.statedValue === undefined) {
      ctx.undecided();
      findings.push(
        unresolved(
          'unsupported_factual_claim',
          subject,
          `"${block.title}" cites a source without quoting what it takes from it, so nothing can confirm or deny it.`,
          'plan.days[].blocks[].evidence',
          'evidence_absent',
          { observed: { sourceIndex: index, factPath: ref.factPath ?? null } },
        ),
      );
      continue;
    }

    const supported = truth.supportsClaim(index, ref.factPath, ref.statedValue);
    if (supported === null) {
      ctx.undecided();
      findings.push(
        unresolved(
          'unsupported_factual_claim',
          subject,
          `Nothing retrieved during the run can confirm or deny what "${block.title}" cites.`,
          'truth.supportsClaim',
          'evidence_absent',
          { observed: { sourceIndex: index, factPath: ref.factPath ?? null } },
        ),
      );
      continue;
    }

    ctx.decided();
    if (supported) continue;
    findings.push(
      report(
        'unsupported_factual_claim',
        'major',
        subject,
        `"${block.title}" states ${ref.statedValue ?? 'something'} and the source it cites does not say that.`,
        'truth.supportsClaim',
        {
          observed: { sourceIndex: index, statedValue: ref.statedValue ?? null, factPath: ref.factPath ?? null },
          expected: { supported: true },
        },
      ),
    );
  }

  return findings;
}

function sweepBlockProse(
  day: PlanDay,
  block: PlanBlock,
  index: number,
  coverage: ReadonlySet<ClaimTokenKind>,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const note = String(block.note ?? '');
  if (note.length === 0) return findings;

  const ownTimes = selfDescribedMinutes(block);
  const ownSpans = selfDescribedSpans(block);
  const subject = subjectOf(day, { blockIndex: index, entityId: block.place?.entityId ?? null });

  for (const token of scanProse(note)) {
    // (a) Describing your own schedule is not a claim about the world — neither
    // when the number is a time the block already keeps, nor when it is the
    // length of the block itself.
    if (describesItself(token, ownTimes, ownSpans)) continue;

    ctx.decided();
    // Evidence excuses the kinds of claim it actually vouches for, and no more.
    if (coverage.has(token.kind)) continue;
    findings.push(
      report(
        'unsupported_exact_value',
        token.hedged ? 'informational' : 'minor',
        subject,
        token.hedged
          ? `"${block.title}" gives ${token.text.trim()} as an estimate, with nothing behind it.`
          : `"${block.title}" states ${token.text.trim()} with no source behind it.`,
        'plan.days[].blocks[].evidence',
        { observed: { value: token.text.trim(), kind: token.kind, hedged: token.hedged } },
      ),
    );
  }

  return findings;
}

/**
 * Whether the token is the block talking about itself.
 *
 * Both halves are all-or-nothing on purpose: a token naming one time the block
 * keeps and one it does not — "arrive at 09:00, ranger talk at 14:30" — is still
 * asserting the second, and suppressing it because of the first would let any
 * claim be smuggled in beside a self-description.
 */
function describesItself(
  token: ProseToken,
  ownTimes: ReadonlySet<number>,
  ownSpans: ReadonlySet<number>,
): boolean {
  if (token.minutes.length > 0 && token.minutes.every((minute) => ownTimes.has(minute))) return true;
  if (token.durationMinutes.length > 0 && token.durationMinutes.every((span) => ownSpans.has(span))) {
    return true;
  }
  return false;
}

/** Every minute the block itself puts on the record about its own timing. */
function selfDescribedMinutes(block: PlanBlock): Set<number> {
  const minutes = new Set<number>();
  if (typeof block.startMinute === 'number') minutes.add(block.startMinute);
  if (typeof block.endMinute === 'number') minutes.add(block.endMinute);
  const opening = block.opening;
  if (opening) {
    if (typeof opening.openMinute === 'number') minutes.add(opening.openMinute);
    if (typeof opening.closeMinute === 'number') minutes.add(opening.closeMinute);
    if (typeof opening.lastAdmissionMinute === 'number') minutes.add(opening.lastAdmissionMinute);
  }
  return minutes;
}

/**
 * Every span the block itself puts on the record about its own length.
 *
 * Its own slot on the clock, and the journey time it states where it is a leg.
 * Without this, a forty-five minute travel block whose note reads "forty-five
 * minutes on the road" was flagged for asserting the very thing the timeline
 * beside it already says — which charged the systems that annotate their legs
 * and left alone the ones that write nothing.
 */
function selfDescribedSpans(block: PlanBlock): Set<number> {
  const spans = new Set<number>();
  const start = block.startMinute;
  const end = block.endMinute;
  if (typeof start === 'number' && typeof end === 'number' && end >= start) spans.add(end - start);
  const travelMinutes = block.travel?.minutes;
  if (typeof travelMinutes === 'number') spans.add(travelMinutes);
  return spans;
}

/**
 * The trip-level prose.
 *
 * A summary cannot carry an evidence reference — the schema puts those on
 * blocks — so what stands in for one is the union of what the plan's own
 * citations vouch for, read by exactly the rule the blocks are read by. That is
 * the same generosity a cited block gets and no more: a plan that looked up
 * opening hours may state a time in its summary without being charged for it,
 * and may not thereby state a price.
 *
 * The rule it replaces — any source at all exempts the whole summary — was not a
 * measure of evidence. One arm retrieves sources on essentially every run and
 * the other on essentially none, so the exemption tracked which system had
 * written the plan.
 */
function sweepPlanProse(
  plan: BenchmarkPlan,
  coverage: ReadonlySet<ClaimTokenKind>,
  ctx: CheckContext,
): BenchFinding[] {
  const findings: BenchFinding[] = [];
  const prose = [String(plan.summary ?? ''), ...safeArray(plan.warnings).map((entry) => String(entry ?? ''))];

  for (const text of prose) {
    for (const token of scanProse(text)) {
      ctx.decided();
      if (coverage.has(token.kind)) continue;
      findings.push(
        report(
          'unsupported_exact_value',
          token.hedged ? 'informational' : 'minor',
          {},
          `The plan states ${token.text.trim()} and cites nothing that speaks to it.`,
          'plan.sources',
          { observed: { value: token.text.trim(), kind: token.kind, hedged: token.hedged } },
        ),
      );
    }
  }

  return findings;
}
