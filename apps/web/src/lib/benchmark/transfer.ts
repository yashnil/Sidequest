import type { BenchmarkQuestion, BenchmarkTripRequest, ProducingSystem } from '@sidequest/bench';

/**
 * MOVING AN ANSWER TO THE SYSTEM THAT DID NOT ASK FOR IT.
 *
 * A follow-up question is free information. A benchmark in which one system got
 * to ask three clarifying questions and keep the answers to itself would be
 * measuring who asked first rather than who planned better, and the goal names
 * that failure explicitly: neither system may win because it silently received
 * more traveller information.
 *
 * So every confirmed answer is offered to both arms, and this module is the
 * whole of what "offered" means. It is deliberately small and deliberately
 * concept-based:
 *
 * **Nothing here knows a destination.** Each rule keys on the question's own
 * concept — an unstated arrival time, a region wider than one base, whether
 * lunch can be carried — and none of them looks at where the trip is. A
 * destination-specific transfer would be benchmark logic branching on a place,
 * which this phase forbids.
 *
 * **A concept with no counterpart is recorded, not forced.** Four of the eight
 * questions the rules can ask have nowhere to land in the deterministic
 * pipeline: whether to include places whose hours nobody published, whether to
 * plan around an unverifiable dietary claim, whether to build around an
 * unmatched must-do, and whether to front-load the outdoor days. Inventing a
 * field for them would put an answer somewhere the planner does not read and
 * report parity that does not exist. They come back `not_representable`, which
 * is a finding rather than a silence.
 *
 * **The transfer applies to the *request*, wherever it can.** Rewriting the
 * shared request and letting the existing adapter map it is what keeps this from
 * becoming a second, divergent copy of the request mapping. Only the one concept
 * with no request field — carrying lunch — needs its own channel, and it is a
 * single named override rather than a general escape hatch.
 */

export const TRANSFER_VERDICTS = ['applied', 'not_representable', 'unanswered'] as const;
export type TransferVerdict = (typeof TRANSFER_VERDICTS)[number];

export interface TransferEntry {
  /** The concept, not the wording. Stable across prompt edits. */
  concept: string;
  askedBy: ProducingSystem;
  toSystem: ProducingSystem;
  verdict: TransferVerdict;
  /** Where it landed, or why nothing carried it. Never boilerplate. */
  detail: string;
}

/** The one Sidequest answer no field of the shared request can express. */
export interface QuestionnaireOverrides {
  willPackLunch?: boolean;
}

export interface TransferResult {
  request: BenchmarkTripRequest;
  overrides: QuestionnaireOverrides;
  report: TransferEntry[];
}

/**
 * Recover the concept a stored question came from.
 *
 * The stored id is a one-way hash — a question id is a string the asking system
 * chose and may name itself, so it never reaches the browser and never comes
 * back. What survives is the question's own text, so the concept is matched on
 * a marker phrase rather than on an id.
 *
 * Matching on prose is fragile and is the lesser evil: the alternative is
 * storing the raw id, which is the leak the hash exists to prevent. Every marker
 * below is asserted against the question the rule actually produces, so an edit
 * to the wording breaks a test rather than silently stopping a transfer.
 */
const CONCEPT_MARKERS: readonly { concept: string; marker: string }[] = [
  { concept: 'arrival-window', marker: 'what time do you expect to arrive' },
  { concept: 'departure-window', marker: 'what time do you need to leave' },
  { concept: 'second-base', marker: 'would you move to a second place to sleep' },
  { concept: 'carry-lunch', marker: 'happy to carry lunch' },
  { concept: 'seasonal-shift', marker: 'is that worth moving them for' },
  { concept: 'dietary-unverified', marker: 'publishes what it can accommodate' },
  { concept: 'unverified-hours', marker: 'could not confirm opening hours' },
  { concept: 'must-do-unmatched', marker: 'does not appear in the place data' },
  { concept: 'weather-sensitive-placement', marker: 'too far out for a forecast' },
];

export function conceptOf(questionText: string): string | null {
  const text = questionText.toLowerCase();
  return CONCEPT_MARKERS.find((entry) => text.includes(entry.marker))?.concept ?? null;
}

/** Exported so a test can hold every rule's wording to its marker. */
export const TRANSFERABLE_CONCEPTS = CONCEPT_MARKERS.map((entry) => entry.concept);

const EDGE_PRECISIONS = new Set(['morning', 'afternoon', 'evening']);

/**
 * The shared request as it stands once the traveller's answers are honoured.
 *
 * Total over the answered questions: every one produces exactly one report row,
 * so a concept that stops transferring shows up as a row that changed rather
 * than as a report that got shorter.
 */
export function transferAnswers(
  request: BenchmarkTripRequest,
  questions: readonly BenchmarkQuestion[],
): TransferResult {
  const report: TransferEntry[] = [];
  const overrides: QuestionnaireOverrides = {};
  let next: BenchmarkTripRequest = request;

  for (const question of questions) {
    const concept = conceptOf(question.questionText);
    const other: ProducingSystem = question.askedBy === 'sidequest' ? 'baseline' : 'sidequest';
    const answer = (question.answerValues ?? [])[0]?.trim().toLowerCase() ?? '';

    if (concept === null) {
      report.push({
        concept: 'unrecognised',
        askedBy: question.askedBy,
        toSystem: other,
        verdict: 'not_representable',
        detail:
          'This question did not come from one of the standing rules, so no concept could be matched to a field.',
      });
      continue;
    }

    const say = (verdict: TransferVerdict, detail: string): void => {
      report.push({ concept, askedBy: question.askedBy, toSystem: other, verdict, detail });
    };

    if (question.answeredAt === null || answer.length === 0) {
      say('unanswered', 'The traveller did not answer, so there was nothing to pass on.');
      continue;
    }

    switch (concept) {
      case 'arrival-window': {
        if (!EDGE_PRECISIONS.has(answer)) {
          say('not_representable', 'The answer was not one of the three arrival windows.');
          break;
        }
        next = {
          ...next,
          arrival: { ...next.arrival, precision: answer as 'morning' | 'afternoon' | 'evening' },
        };
        say('applied', 'Carried as the arrival precision, which both systems read.');
        break;
      }
      case 'departure-window': {
        if (!EDGE_PRECISIONS.has(answer)) {
          say('not_representable', 'The answer was not one of the three departure windows.');
          break;
        }
        next = {
          ...next,
          departure: { ...next.departure, precision: answer as 'morning' | 'afternoon' | 'evening' },
        };
        say('applied', 'Carried as the departure precision, which both systems read.');
        break;
      }
      case 'second-base': {
        if (answer === 'move') {
          next = {
            ...next,
            movement: {
              ...next.movement,
              desiredBaseCount: Math.max(2, next.movement.desiredBaseCount),
              maxBaseChanges: Math.max(1, next.movement.maxBaseChanges),
            },
          };
          say('applied', 'Carried as a second base, which sets the scope strategy on one arm.');
        } else if (answer === 'stay') {
          next = {
            ...next,
            movement: { ...next.movement, desiredBaseCount: 1, maxBaseChanges: 0 },
          };
          say('applied', 'Carried as one base and no moves, which sets the scope strategy.');
        } else {
          say('not_representable', 'The answer was neither of the two base strategies.');
        }
        break;
      }
      case 'carry-lunch': {
        if (answer !== 'yes' && answer !== 'no') {
          say('not_representable', 'The answer was not a yes or a no.');
          break;
        }
        overrides.willPackLunch = answer === 'yes';
        say('applied', 'Carried as whether lunch can be packed, which the food planner reads.');
        break;
      }
      case 'seasonal-shift': {
        /*
         * The answer is real and there is no honest place to put it.
         *
         * "Yes, move the dates" would mean re-dating the trip, which changes the
         * world both arms were given and the questions that came from it. That
         * is a new comparison rather than a transferred answer, so the request
         * stands and the fact is recorded.
         */
        say(
          'not_representable',
          'Shifting the dates would change the world both arms were given, so it is recorded and not applied.',
        );
        break;
      }
      default: {
        say(
          'not_representable',
          'The deterministic pipeline has no field for this, so the answer reaches one arm only and the asymmetry is recorded here.',
        );
        break;
      }
    }
  }

  return { request: next, overrides, report };
}
