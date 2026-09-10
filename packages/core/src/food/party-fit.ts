import { DIETARY_NEED_LABELS, type DietaryNeed } from '../schemas/food';

/**
 * FOOD INTELLIGENCE V4 — DOES THIS PLACE WORK FOR EACH PERSON?
 *
 * V6 §16. A party's kitchen rules do not average: A eats no beef or pork, B is
 * vegetarian with eggs, C has a severe peanut allergy. For any venue the
 * answer is per person and three-valued — fits, unknown, conflicts — and an
 * allergy is never "fits" on inference: only a published claim about the
 * kitchen can say so, and even then it is a published claim, not safety.
 *
 * Inputs are what a places provider or a food record actually carries: the
 * venue's cuisine types and any published dietary claims (`vegetarian`,
 * `vegan`, `halal`, `gluten_free_options`, `nut_free`). Absence of a claim is
 * unknown, never a conflict; a cuisine that is *defined* by an excluded
 * ingredient (a steakhouse for no-beef, a seafood counter for no-shellfish)
 * is a conflict.
 */

export type PersonFit = 'fits' | 'unknown' | 'conflict';

export interface PartyMemberDiet {
  name: string;
  needs: readonly DietaryNeed[];
  /** True when the needs are absolute for this person. */
  strict: boolean;
  /** Free text, only ever echoed back — never interpreted into a rule. */
  notes?: string;
}

export interface VenueDietaryEvidence {
  /** Provider or record types: `steak_house`, `seafood_restaurant`, `vegetarian_restaurant`, `bbq`, … */
  types: readonly string[];
  /** Published claims about the kitchen, when the source carries them. */
  claims?: readonly ('vegetarian' | 'vegan' | 'halal' | 'kosher' | 'gluten_free_options' | 'nut_free' | 'dairy_free_options')[];
}

export interface PersonVenueFit {
  name: string;
  fit: PersonFit;
  /** One clause: why. */
  why: string;
  /** True when the verdict rests on a published claim rather than on cuisine type. */
  publishedEvidence: boolean;
}

export interface PartyVenueFit {
  perPerson: PersonVenueFit[];
  /** The worst per-person verdict: the party's. */
  overall: PersonFit;
  /** True when any strict need is `unknown` — the kitchen has to be asked. */
  askTheKitchen: boolean;
}

const DEFINED_BY: Partial<Record<DietaryNeed, RegExp>> = {
  no_beef: /steak|churrasc|bbq|barbecue|burger|yakiniku|beef/i,
  no_pork: /pork|tonkatsu|bbq|barbecue|charcuter|schnitzel/i,
  no_shellfish: /seafood|oyster|crab|lobster|shrimp|prawn|sushi/i,
  vegetarian: /steak|bbq|barbecue|yakiniku|churrasc|seafood|burger/i,
  vegan: /steak|bbq|barbecue|yakiniku|churrasc|seafood|burger|cheese|creamer|dairy/i,
  pescatarian: /steak|bbq|barbecue|yakiniku|churrasc|burger/i,
  no_alcohol: /\bbar\b|pub|brewery|winery|izakaya|taproom/i,
};

const SATISFIED_BY: Partial<Record<DietaryNeed, readonly NonNullable<VenueDietaryEvidence['claims']>[number][]>> = {
  vegetarian: ['vegetarian', 'vegan'],
  vegan: ['vegan'],
  pescatarian: ['vegetarian', 'vegan'],
  /* A kitchen that publishes no meat, or halal/kosher handling, has answered the beef and pork questions. */
  no_beef: ['vegetarian', 'vegan'],
  no_pork: ['vegetarian', 'vegan', 'halal', 'kosher'],
  no_shellfish: ['vegetarian', 'vegan', 'kosher'],
  halal: ['halal'],
  kosher: ['kosher'],
  gluten_free: ['gluten_free_options'],
  dairy_free: ['dairy_free_options', 'vegan'],
  nut_allergy: ['nut_free'],
};

const ALLERGIES = new Set<DietaryNeed>(['nut_allergy']);

export function personVenueFit(member: PartyMemberDiet, venue: VenueDietaryEvidence): PersonVenueFit {
  if (member.needs.length === 0) return { name: member.name, fit: 'fits', why: 'no stated rules', publishedEvidence: false };
  const typeText = venue.types.join(' ');
  const claims = new Set(venue.claims ?? []);
  let worst: PersonFit = 'fits';
  const reasons: string[] = [];
  let published = false;
  for (const need of member.needs) {
    const label = DIETARY_NEED_LABELS[need];
    const defining = DEFINED_BY[need];
    if (defining && defining.test(typeText)) {
      worst = 'conflict';
      reasons.push(`the place is built around what ${label.toLowerCase()} rules out`);
      continue;
    }
    const satisfiedBy = SATISFIED_BY[need];
    if (satisfiedBy && satisfiedBy.some((claim) => claims.has(claim))) {
      published = true;
      reasons.push(`a published ${label.toLowerCase()} claim`);
      continue;
    }
    if (ALLERGIES.has(need)) {
      /* An allergy is never inferred fine. Without a published claim it is unknown, and the kitchen must be asked. */
      if (worst !== 'conflict') worst = 'unknown';
      reasons.push(`no published ${label.toLowerCase()} handling — ask the kitchen`);
      continue;
    }
    if (member.strict || need === 'halal' || need === 'kosher' || need === 'jain') {
      if (worst !== 'conflict') worst = 'unknown';
      reasons.push(`nothing published about ${label.toLowerCase()}`);
      continue;
    }
    /* A soft preference at a place not defined by the exclusion: fits, by default, and says so. */
    reasons.push(`nothing here rules out ${label.toLowerCase()}`);
  }
  return { name: member.name, fit: worst, why: reasons.join('; '), publishedEvidence: published };
}

export function partyVenueFit(members: readonly PartyMemberDiet[], venue: VenueDietaryEvidence): PartyVenueFit {
  const perPerson = members.map((member) => personVenueFit(member, venue));
  const overall: PersonFit = perPerson.some((p) => p.fit === 'conflict') ? 'conflict' : perPerson.some((p) => p.fit === 'unknown') ? 'unknown' : 'fits';
  const askTheKitchen = members.some((m, i) => (m.strict || m.needs.some((n) => ALLERGIES.has(n))) && perPerson[i]!.fit === 'unknown');
  return { perPerson, overall, askTheKitchen };
}

/** A sentence for a meal card: who is fine, who is unknown, who cannot eat here. */
export function describePartyFit(fit: PartyVenueFit): string {
  const conflicts = fit.perPerson.filter((p) => p.fit === 'conflict').map((p) => p.name);
  const unknown = fit.perPerson.filter((p) => p.fit === 'unknown').map((p) => p.name);
  if (conflicts.length > 0) return `Not for ${conflicts.join(' or ')}: ${fit.perPerson.find((p) => p.fit === 'conflict')!.why}.`;
  if (unknown.length > 0) return `Ask the kitchen for ${unknown.join(' and ')}: ${fit.perPerson.find((p) => p.fit === 'unknown')!.why}.`;
  return fit.perPerson.some((p) => p.publishedEvidence) ? 'Works for everyone on published claims — still say so when you order.' : 'Nothing here rules anyone out.';
}
