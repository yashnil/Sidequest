import { countryFacts } from '../reference/countries';
import { jurisdictionFor } from '../reality/jurisdictions';
import type { Journey } from './journey';
import { TRAVEL_MODE_LABELS } from './vocabulary';

/**
 * V12.1 §23 (finishing V12 §28) — WHAT CHANGES WHEN A JOURNEY CROSSES A BORDER.
 *
 * ── THE RULE THAT SHAPES THIS WHOLE MODULE ──────────────────────────────────
 *
 * §23: *"Do not automatically create traveller warnings for everything. Only
 * surface operationally relevant transitions."*
 *
 * A crossing is not itself news. Two Schengen countries share a currency, an
 * open border and usually a plug, and telling somebody driving from France to
 * Italy that they are "entering a new jurisdiction" is noise that teaches people
 * to stop reading. What is news is the thing that actually **changes**: a new
 * currency, the other side of the road, a vehicle that cannot cross, a network
 * that stops working, formalities at a post.
 *
 * So a transition is computed by **comparing the two jurisdictions** and keeping
 * only the differences. A crossing with nothing behind it produces a transition
 * with no implications, and a caller renders nothing.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * Not a legal source. Entry and visa rules are `official_current` territory
 * (V1's `CONFIRMING_AUTHORITY`) and nothing here confirms one: a land border
 * says *there are formalities here*, never *you may enter*. Currency, driving
 * side and plugs come from the bundled country reference, which is exactly what
 * it is for.
 *
 * Pure: no provider, no clock, no model.
 */

/**
 * Areas where a border crossing is routinely not an event.
 *
 * Data about how countries work, keyed by ISO code — the same class of fact as
 * `jurisdictions.ts` itself, and explicitly the alternative to the thing V7
 * forbids (`if destination === '<place>'`). Membership is what makes a
 * France→Italy drive unremarkable and a Kenya→Tanzania one not.
 *
 * Deliberately small and deliberately about *movement* rather than about
 * politics: what is encoded is "people and vehicles routinely cross here
 * without a formality that shapes a travel day".
 */
export const COMMON_TRAVEL_AREAS: Record<string, readonly string[]> = {
  schengen: ['AT', 'BE', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL', 'PT', 'SE', 'SI', 'SK', 'BG', 'RO'],
  /** Britain and Ireland's Common Travel Area. */
  cta: ['GB', 'IE'],
  /** Trans-Tasman. */
  tasman: ['AU', 'NZ'],
  /*
   * THE EAST AFRICAN COMMUNITY IS DELIBERATELY NOT HERE.
   *
   * It was, and the first run of the corpus showed why it should not be: with
   * `KE`/`TZ` in a common area, a Kenya-to-Tanzania safari crossing produced no
   * formalities at all — the single most operationally significant fact on that
   * trip, silently suppressed by a membership claim.
   *
   * The EAC does run a joint tourist visa for some routes, and that is a fact
   * about *paperwork*, not about whether the crossing shapes a day. It does: a
   * post, a queue, a vehicle that may not cross, a currency. What belongs in
   * this table is only a crossing people and vehicles pass through without one.
   */
  nordic: ['DK', 'FI', 'IS', 'NO', 'SE'],
};

export function sharesTravelArea(from: string, to: string): string | null {
  for (const [area, members] of Object.entries(COMMON_TRAVEL_AREAS)) {
    if (members.includes(from) && members.includes(to)) return area;
  }
  return null;
}

export const TRANSITION_KINDS = ['land_border', 'air', 'sea', 'rail_border'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** What actually changes, each as one sentence a traveller can act on. */
export const TRANSITION_TOPICS = ['formalities', 'currency', 'driving', 'vehicle_handoff', 'connectivity', 'language', 'power', 'emergency'] as const;
export type TransitionTopic = (typeof TRANSITION_TOPICS)[number];

export interface TransitionImplication {
  topic: TransitionTopic;
  /** One sentence. Never a field name, never a legal claim. */
  detail: string;
}

export interface JurisdictionTransition {
  from: string;
  to: string;
  kind: TransitionKind;
  /** The journey that crosses. Named so a day can point at it. */
  journey: Pick<Journey, 'origin' | 'destination' | 'mode'>;
  /** The shared area, when there is one. A crossing inside one is usually unremarkable. */
  commonArea: string | null;
  /** Only what genuinely differs. Empty is a real and common answer. */
  implications: TransitionImplication[];
  /** Whether anything here is worth a traveller's attention at all. */
  worthSurfacing: boolean;
}

function kindFor(mode: Journey['mode']): TransitionKind {
  if (mode === 'flight') return 'air';
  if (mode === 'ferry' || mode === 'boat') return 'sea';
  if (mode === 'rail' || mode === 'urban_transit') return 'rail_border';
  return 'land_border';
}

/**
 * What changes between two countries, as sentences.
 *
 * Every one is a *difference*: a shared currency produces nothing, and two
 * countries that both drive on the right produce nothing about driving. That is
 * the §23 rule expressed as code rather than as a threshold.
 */
export function implicationsBetween(from: string, to: string, kind: TransitionKind, mode: Journey['mode']): TransitionImplication[] {
  const out: TransitionImplication[] = [];
  const a = countryFacts(from);
  const b = countryFacts(to);
  const shared = sharesTravelArea(from, to);

  /* Formalities: what happens at the crossing itself. */
  if (!shared) {
    out.push({
      topic: 'formalities',
      detail:
        kind === 'air'
          ? `Flying into ${b?.name ?? to} means immigration and customs on arrival; allow for it on the day rather than at the gate.`
          : kind === 'sea'
            ? `Arriving in ${b?.name ?? to} by sea means formalities at the port, and the boarding check is earlier than the sailing.`
            : `Crossing into ${b?.name ?? to} means a border post: passports, possibly a queue, and a stop that is part of the day.`,
    });
  }

  if (a && b) {
    if (a.currency !== b.currency) {
      out.push({ topic: 'currency', detail: `Money changes at this crossing: ${a.currency} on one side, ${b.currency} on the other.` });
    }
    if (a.drivingSide !== b.drivingSide) {
      out.push({ topic: 'driving', detail: `Traffic changes sides here — ${a.drivingSide} in ${a.name}, ${b.drivingSide} in ${b.name}.` });
    }
    if (a.emergency !== b.emergency) {
      out.push({ topic: 'emergency', detail: `The emergency number changes: ${a.emergency} in ${a.name}, ${b.emergency} in ${b.name}.` });
    }
    /*
     * LANGUAGE IS NOT A BORDER EVENT.
     *
     * It was one line here, and it made every crossing in Europe "worth
     * surfacing" — France into Italy, Estonia into Finland — which is precisely
     * the noise §23 forbids. What language is spoken where somebody is going is
     * a readiness fact about the destination, already stated once by
     * `readiness.ts` against the jurisdiction, and repeating it at each border
     * teaches people to stop reading borders. The topic stays in the vocabulary
     * for a caller that has a genuine case for it; nothing raises it here.
     */
    const sharedPlug = a.plugs.some((plug) => b.plugs.includes(plug));
    if (!sharedPlug) {
      out.push({ topic: 'power', detail: `The sockets change at this crossing: type ${a.plugs.join('/')} to type ${b.plugs.join('/')}.` });
    }
  }

  /*
   * A VEHICLE IS NOT ALWAYS ALLOWED TO CROSS, AND NEITHER IS A GUIDE.
   *
   * The operationally sharpest fact on a multi-country overland trip and the one
   * a traveller most often discovers at the post. Stated as a thing to arrange
   * rather than as a rule, because whether a particular hire agreement or
   * operator permit crosses is the operator's answer, not ours.
   */
  if (!shared && (mode === 'drive' || mode === 'four_wheel_drive')) {
    out.push({ topic: 'vehicle_handoff', detail: 'A hire car does not automatically cross a border — the paperwork is arranged with the rental company in advance, and some agreements do not allow it at all.' });
  }
  if ((mode === 'private_transfer' || mode === 'operator_transfer') && !shared) {
    out.push({ topic: 'vehicle_handoff', detail: 'Guides and vehicles usually change at a border: expect a handover on the far side rather than the same car all the way.' });
  }

  if (!shared) {
    out.push({ topic: 'connectivity', detail: `A local SIM or a data plan bought in ${a?.name ?? from} will not usually work in ${b?.name ?? to}; a regional eSIM is the simplest way to stay connected across both.` });
  }

  return out;
}

export interface TransitionInput {
  journeys: readonly Journey[];
  /** The ISO country of each endpoint, where it is known. A place with no country produces no transition. */
  countryOf: (placeId: string) => string | null | undefined;
}

/**
 * Every meaningful jurisdiction change on this trip, in route order.
 *
 * A journey whose endpoints are in the same country produces nothing. A journey
 * one of whose endpoints has no country produces nothing either — an unknown is
 * not a crossing, and guessing one would put a border warning on a trip that has
 * none.
 */
export function jurisdictionTransitions(input: TransitionInput): JurisdictionTransition[] {
  const out: JurisdictionTransition[] = [];
  for (const journey of input.journeys) {
    const from = input.countryOf(journey.origin.id)?.toUpperCase();
    const to = input.countryOf(journey.destination.id)?.toUpperCase();
    if (!from || !to || from === to) continue;
    const kind = kindFor(journey.mode);
    const commonArea = sharesTravelArea(from, to);
    const implications = implicationsBetween(from, to, kind, journey.mode);
    out.push({
      from,
      to,
      kind,
      journey: { origin: journey.origin, destination: journey.destination, mode: journey.mode },
      commonArea,
      implications,
      /*
       * A crossing inside a common travel area with nothing else changing is not
       * worth a line. One with a currency change, a side-of-the-road change or a
       * vehicle that may not cross is.
       */
      worthSurfacing: implications.length > 0,
    });
  }
  return out;
}

/** One sentence naming the crossing, for a day that contains one. */
export function transitionHeadline(transition: JurisdictionTransition): string {
  const a = countryFacts(transition.from)?.name ?? transition.from;
  const b = countryFacts(transition.to)?.name ?? transition.to;
  const mode = TRAVEL_MODE_LABELS[transition.journey.mode].toLowerCase();
  return `${a} into ${b}, by ${mode}`;
}

/** Whether the jurisdiction layer holds a compiled row for both sides, so a caller can say what it does not know. */
export function bothSidesCompiled(transition: JurisdictionTransition): boolean {
  return Boolean(jurisdictionFor(transition.from) && jurisdictionFor(transition.to));
}
