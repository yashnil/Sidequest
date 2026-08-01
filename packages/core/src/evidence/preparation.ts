import { isEnforceable, FACT_VERIFICATION_LABELS } from '../schemas/source-fact';
import type { PlaceEvidence, RegionEvidence } from '../schemas/evidence';

/**
 * BEFORE YOU GO.
 *
 * Derived, never authored, and derived only from the places the plan actually
 * contains. That is the constraint that makes it useful: a checklist assembled
 * from everything in the region would list a permit for a trail nobody is
 * walking, and a checklist a model wrote could list anything at all.
 *
 * Four kinds of item, in the order a traveller acts on them:
 *
 * 1. **Book** — something that will be gone if they wait.
 * 2. **Bring** — kit a source explicitly names.
 * 3. **Check** — a fact that matters and that nobody published, so the plan is
 *    running on an assumption they should confirm.
 * 4. **Know** — a dated caution that changes nothing they must do but that they
 *    would rather have read.
 *
 * The third category is the one that would be easiest to leave out and is the
 * most honest thing here. A plan that silently schedules a museum whose hours
 * nobody could find has made a bet on the traveller's behalf; saying so turns it
 * into a five-minute phone call.
 */

export const PREPARATION_KINDS = ['book', 'bring', 'check', 'know'] as const;
export type PreparationKind = (typeof PREPARATION_KINDS)[number];

export const PREPARATION_KIND_COPY: Record<PreparationKind, { title: string; blurb: string }> = {
  book: {
    title: 'Book or buy before you leave',
    blurb: 'These will not be available on the day if you turn up without them.',
  },
  bring: {
    title: 'Bring',
    blurb: 'Named by whoever runs the place, not by us.',
  },
  check: {
    title: 'Worth a phone call',
    blurb: 'The plan assumes these and nobody publishes them. Five minutes now saves a wasted morning.',
  },
  know: {
    title: 'Worth knowing',
    blurb: 'Dated cautions from official sources. Conditions change; we have not checked today.',
  },
};

export interface PreparationItem {
  kind: PreparationKind;
  /** The place this is about, so a traveller can tie it to a day. */
  subjectId: string;
  subjectName: string;
  text: string;
  /** Where to do it, where a source published one. */
  url?: string;
  /** How well established this is, rendered verbatim beside the item. */
  confidence?: string;
  /** When the source was read, for the dated items. */
  asOf?: string;
}

export interface PreparationInput {
  evidence: RegionEvidence | undefined;
  /** Place and venue ids the plan actually schedules. Nothing else is listed. */
  scheduledSubjectIds: readonly string[];
  /** Names, so the list reads like a list rather than like a database. */
  namesById: ReadonlyMap<string, string>;
  /**
   * Subjects the plan schedules whose opening hours are unknown.
   *
   * Passed in rather than re-derived, because the planner already knows this and
   * two implementations of "did we verify the hours?" is one too many.
   */
  unverifiedHoursSubjectIds?: readonly string[];
}

export function buildPreparation(input: PreparationInput): PreparationItem[] {
  const scheduled = new Set(input.scheduledSubjectIds);
  const items: PreparationItem[] = [];
  const nameOf = (id: string): string => input.namesById.get(id) ?? id;

  for (const place of input.evidence?.places ?? []) {
    if (!scheduled.has(place.subjectId)) continue;
    items.push(...itemsForPlace(place, nameOf(place.subjectId)));
  }

  for (const subjectId of input.unverifiedHoursSubjectIds ?? []) {
    if (!scheduled.has(subjectId)) continue;
    items.push({
      kind: 'check',
      subjectId,
      subjectName: nameOf(subjectId),
      text: 'Nobody publishes opening hours for this that we could read. Confirm before the day depends on it.',
    });
  }

  /**
   * Region-wide cautions come last and only once.
   *
   * An advisory about a road or a season applies to the trip rather than to a
   * stop, and repeating it under every place it touches would bury the
   * place-specific items that are actually actionable.
   */
  for (const caution of input.evidence?.regionSafety ?? []) {
    if (caution.severity === 'informs') continue;
    items.push({
      kind: 'know',
      subjectId: 'region',
      subjectName: caution.appliesTo ?? 'This region',
      text: caution.statement,
      confidence: FACT_VERIFICATION_LABELS[caution.claim.state],
    });
  }

  return dedupe(items);
}

function itemsForPlace(place: PlaceEvidence, name: string): PreparationItem[] {
  const items: PreparationItem[] = [];
  const booking = place.booking;

  if (booking) {
    const needs: string[] = [];
    if (booking.permitRequired === 'yes') needs.push('a permit');
    if (booking.timedEntry === 'yes') needs.push('a timed-entry slot');
    else if (booking.reservationRequired === 'yes') needs.push('a reservation');
    if (booking.guideRequired === 'yes') needs.push('a guide');

    if (needs.length > 0) {
      const lead =
        booking.leadTimeDays !== undefined
          ? ` The operator suggests booking about ${booking.leadTimeDays} ${booking.leadTimeDays === 1 ? 'day' : 'days'} ahead.`
          : '';
      items.push({
        kind: 'book',
        subjectId: place.subjectId,
        subjectName: name,
        text: `Needs ${listOf(needs)}.${lead}`,
        ...(booking.bookingUrl ? { url: booking.bookingUrl } : {}),
        confidence: FACT_VERIFICATION_LABELS[booking.claim.state],
      });
    }
  }

  /**
   * Advance-purchase prices are a booking item, not a price item.
   *
   * "Twelve euros, and only online" is one sentence and one action; splitting it
   * across a price chip and a booking line makes the traveller assemble it.
   */
  for (const cost of place.costs) {
    if (cost.advancePurchaseRequired !== 'yes') continue;
    items.push({
      kind: 'book',
      subjectId: place.subjectId,
      subjectName: name,
      text: cost.free
        ? 'Free, but entry must be reserved in advance.'
        : 'Tickets have to be bought in advance rather than at the door.',
      ...(place.booking?.bookingUrl ? { url: place.booking.bookingUrl } : {}),
      confidence: FACT_VERIFICATION_LABELS[cost.claim.state],
    });
  }

  for (const safety of place.safety) {
    for (const requirement of safety.requires) {
      items.push({
        kind: 'bring',
        subjectId: place.subjectId,
        subjectName: name,
        text: requirement,
        confidence: FACT_VERIFICATION_LABELS[safety.claim.state],
      });
    }
    if (safety.severity !== 'informs' && safety.requires.length === 0) {
      items.push({
        kind: 'know',
        subjectId: place.subjectId,
        subjectName: name,
        text: safety.statement,
        confidence: FACT_VERIFICATION_LABELS[safety.claim.state],
      });
    }
  }

  for (const closure of place.closures) {
    // A blocking closure has already removed the place from the plan, so an
    // item about it here would be advice about somewhere nobody is going.
    if (closure.severity === 'blocks') continue;
    items.push({
      kind: 'know',
      subjectId: place.subjectId,
      subjectName: name,
      text: closure.statement,
      confidence: FACT_VERIFICATION_LABELS[closure.claim.state],
      ...(closure.from ? { asOf: closure.from } : {}),
    });
  }

  /**
   * A fact that matters, that a source disagreed with itself about, is a check
   * rather than a caution: we are not entitled to tell them which version is
   * true, only that they should find out.
   */
  for (const fact of place.resolved) {
    if (fact.state !== 'conflicted') continue;
    items.push({
      kind: 'check',
      subjectId: place.subjectId,
      subjectName: name,
      text: `Sources disagree about this. ${fact.rationale}`,
    });
  }

  for (const fact of place.resolved) {
    if (fact.state !== 'stale') continue;
    if (!isEnforceable(fact.state)) {
      items.push({
        kind: 'check',
        subjectId: place.subjectId,
        subjectName: name,
        text: `What we hold about this was read a while ago and is worth confirming. ${fact.rationale}`,
      });
    }
  }

  return items;
}

function listOf(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

/** One line per (place, sentence). Two sources saying the same thing is one job. */
function dedupe(items: readonly PreparationItem[]): PreparationItem[] {
  const seen = new Set<string>();
  const out: PreparationItem[] = [];
  for (const item of items) {
    const key = `${item.kind}|${item.subjectId}|${item.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function groupPreparation(
  items: readonly PreparationItem[],
): { kind: PreparationKind; items: PreparationItem[] }[] {
  return PREPARATION_KINDS.map((kind) => ({
    kind,
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}
