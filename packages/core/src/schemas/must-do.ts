import { z } from 'zod';
import { interestSchema } from './common';
import { activeChips, type InterpretationSet } from './interpretation';
import { researchLevelFor, type DestinationResearchReadiness } from './research-readiness';

/**
 * THE THINGS THE TRAVELLER NAMED THEMSELVES.
 *
 * The composer has asked "anything you would regret missing?" since Phase 11.
 * The answer is free text, and until now the only thing that read it was the
 * preference parser — which maps "we must go hiking" onto an interest and
 * correctly refuses to do anything at all with "Devils Postpile", because there
 * is no geocoder on that path and a place name resolved there would have nothing
 * downstream to check it against.
 *
 * So a traveller could write the one thing their whole trip is about, watch the
 * screen say "noted, and not looked up", and never hear about it again. The
 * readiness contract had a dimension for exactly this — `must_do_coverage` — and
 * nothing supplied its input, so it read `not_applicable` on every trip in the
 * product.
 *
 * This is the vocabulary that closes it. Four rules shape it, and each is a way
 * the obvious implementation goes wrong.
 *
 * **A request is the traveller's own characters.** `quote` is sliced from what
 * they typed and is never paraphrased, expanded or corrected. The same rule
 * `InterpretedChip` already holds to, for the same reason: an interpretation
 * nobody accepted must not become the account of what they said.
 *
 * **Unknown is not a failure and not a success.** `MUST_DO_STATUSES` has seven
 * members because the interesting cases are the ones a boolean flattens. "We
 * found it and it is in the plan", "we found it and it does not fit", "we found
 * three things with that name" and "we found nothing" are four different
 * sentences with four different remedies, and only one of them is a deficit the
 * system can repair on its own.
 *
 * **Nothing is invented to satisfy a request.** A resolution carries the method
 * that produced it, and every method in `MUST_DO_MATCH_METHODS` is a piece of
 * deterministic evidence — a folded name equality, an alias a source published,
 * an identifier, or the traveller's own click. There is no "close enough", and
 * there is deliberately no confidence score, because a score is where a fuzzy
 * match hides.
 *
 * **A decision the traveller took survives.** `MustDoDecision` is the only thing
 * that can move a request out of the system's hands, and it is stored on the
 * trip rather than derived, so a refresh shows what they chose rather than
 * asking again.
 */

export const MUST_DO_VERSION = 1 as const;

/**
 * What kind of thing was named.
 *
 * Two, not five. A place, a landmark, an island and a neighbourhood are all
 * `named_subject` — the resolver looks each of them up the same way, against
 * names the sources published, and inventing a taxonomy the resolution cannot
 * act on would be modelling for its own sake. `experience` is genuinely
 * different: it resolves against the *kind* of thing a candidate is rather than
 * against its name, so it needs its own branch and its own evidence.
 */
export const MUST_DO_KINDS = ['named_subject', 'experience'] as const;
export const mustDoKindSchema = z.enum(MUST_DO_KINDS);
export type MustDoKind = z.infer<typeof mustDoKindSchema>;

/** Where the request came from, so a stored one can be re-derived or trusted. */
export const MUST_DO_SOURCES = ['composer_text', 'confirmed_preference'] as const;
export const mustDoSourceSchema = z.enum(MUST_DO_SOURCES);
export type MustDoSource = z.infer<typeof mustDoSourceSchema>;

export const mustDoRequestSchema = z.object({
  /**
   * Stable across re-runs of the same text.
   *
   * Derived from the source and the span exactly as `chipIdFor` is, so a
   * decision somebody took survives a recompilation and is not resurrected under
   * a new identity by an unrelated edit elsewhere in the box.
   */
  id: z.string().min(1),
  kind: mustDoKindSchema,
  source: mustDoSourceSchema,
  /** Sliced from the traveller's stored string. Never authored. */
  quote: z.string().min(1).max(200),
  /** `[start, end)` into that string, for `composer_text` requests. */
  span: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
  /** The controlled interest an `experience` request resolves against. */
  interest: interestSchema.optional(),
  /**
   * Whether the traveller's own text carries proper-noun evidence.
   *
   * The filter that stops "somewhere we can potter about with no fixed plan"
   * from becoming an unmet requirement on every trip. A span with no
   * proper-noun run is still resolved — if it happens to match a real candidate
   * it is reported as found — but it is dropped rather than reported as a
   * shortfall, because "we could not find *that*" is not a sentence anybody can
   * act on when nobody named a thing.
   */
  namedExplicitly: z.boolean(),
});
export type MustDoRequest = z.infer<typeof mustDoRequestSchema>;

/**
 * What we were able to establish. Seven states, none of them a score.
 *
 * `not_found` is the only one the automatic loop may act on, and even then only
 * by looking again at evidence already bought. Nothing here promotes a
 * semantically similar candidate into a match: a shrine is not a temple, and a
 * system that substitutes one for the other has not satisfied the request, it
 * has hidden the failure behind something plausible.
 */
export const MUST_DO_STATUSES = [
  /** Resolved to something this trip can actually use. */
  'covered',
  /** Resolved, and something about the trip's own shape makes it unusable. */
  'unusable',
  /** More than one thing matched, and nothing in the evidence separates them. */
  'ambiguous',
  /** Nothing we read matches it. */
  'not_found',
  /** Matched something the containment layer placed outside the destination. */
  'outside_area',
  /** The traveller took it off. */
  'withdrawn',
  /** The traveller pointed it at something specific instead. */
  'replaced',
] as const;
export const mustDoStatusSchema = z.enum(MUST_DO_STATUSES);
export type MustDoStatus = z.infer<typeof mustDoStatusSchema>;

/**
 * What a traveller reads. No compiler words: nothing here says candidate,
 * containment, resolution, scope or packet.
 */
export const MUST_DO_STATUS_COPY: Record<MustDoStatus, { label: string; blurb: string }> = {
  covered: {
    label: 'Found and included',
    blurb: 'This is in what we found, and the plan can be built around it.',
  },
  unusable: {
    label: 'Found, but it will not fit',
    blurb: 'We found it. Something about how you are getting around, or when you are here, means we cannot work it into a day.',
  },
  ambiguous: {
    label: 'More than one match',
    blurb: 'Several places here answer to that name and nothing tells them apart. Pick the one you meant.',
  },
  not_found: {
    label: 'Not found yet',
    blurb: 'We could not confidently find this. We would rather say so than hand you something that merely sounds like it.',
  },
  outside_area: {
    label: 'Outside the trip area',
    blurb: 'What we found by that name sits outside the place you asked for.',
  },
  withdrawn: { label: 'You took this off', blurb: 'We are no longer looking for it.' },
  replaced: { label: 'You chose one', blurb: 'We are planning around the one you picked.' },
};

/**
 * How the match was made. Every member is a fact, not a similarity.
 *
 * There is deliberately no `fuzzy_name` and no `nearest_match`. A permissive
 * string comparison over four hundred records will always find something, and
 * the something it finds is the wrong attraction often enough that a traveller
 * cannot trust any of them.
 */
export const MUST_DO_MATCH_METHODS = [
  /** The folded name of a candidate equals the folded request, exactly. */
  'exact_name',
  /** The folded request equals an alternate name the source itself publishes. */
  'published_alias',
  /**
   * A candidate's whole folded name appears as a run of words inside the
   * request, and that run carries at least one word rare enough in this
   * destination to identify a single place. See `distinctive` in the resolver.
   */
  'named_within_request',
  /** The traveller picked it themselves. */
  'traveller_chose',
  /** An `experience` request satisfied by a candidate's own typed interests. */
  'interest_tag',
] as const;
export const mustDoMatchMethodSchema = z.enum(MUST_DO_MATCH_METHODS);
export type MustDoMatchMethod = z.infer<typeof mustDoMatchMethodSchema>;

/** What kind of thing the request landed on. */
export const MUST_DO_MATCH_TARGETS = ['place', 'area'] as const;
export const mustDoMatchTargetSchema = z.enum(MUST_DO_MATCH_TARGETS);
export type MustDoMatchTarget = z.infer<typeof mustDoMatchTargetSchema>;

/**
 * Why something we found cannot be used.
 *
 * Mirrors the removal vocabulary the compiler already writes for every place it
 * drops, rather than inventing a second account of the same events.
 */
export const MUST_DO_OBSTACLES = [
  'closed_on_your_dates',
  'safety_advisory',
  'nothing_confirmed_about_it',
  'no_measurable_journey',
] as const;
export const mustDoObstacleSchema = z.enum(MUST_DO_OBSTACLES);
export type MustDoObstacle = z.infer<typeof mustDoObstacleSchema>;

export const MUST_DO_OBSTACLE_COPY: Record<MustDoObstacle, string> = {
  closed_on_your_dates: 'An official source says it is shut while you are here.',
  safety_advisory: 'There is a safety advisory over it for your dates.',
  nothing_confirmed_about_it: 'We could not confirm enough about it to plan a day around it.',
  no_measurable_journey: 'We could not measure a journey to it in the way you are travelling.',
};

export const mustDoMatchSchema = z.object({
  target: mustDoMatchTargetSchema,
  /** The compiled identifier, so the board and the planner can find the same thing. */
  id: z.string().min(1),
  /** What the source calls it. Rendered, never re-derived. */
  name: z.string().min(1),
  method: mustDoMatchMethodSchema,
});
export type MustDoMatch = z.infer<typeof mustDoMatchSchema>;

export const mustDoResolutionSchema = z.object({
  request: mustDoRequestSchema,
  status: mustDoStatusSchema,
  /** Present on `covered`, `unusable`, `outside_area` and `replaced`. */
  match: mustDoMatchSchema.optional(),
  /**
   * Everything that matched, when more than one did.
   *
   * Bounded, and the bound is the point: a list of forty is not a decision, it
   * is the same ambiguity in a longer form. Beyond the bound the honest answer
   * is that the request is too broad to resolve by name.
   */
  candidates: z.array(mustDoMatchSchema).max(6).default([]),
  obstacle: mustDoObstacleSchema.optional(),
  /** One sentence, ours, with the specifics in it. Never a model's words. */
  detail: z.string().min(1),
});
export type MustDoResolution = z.infer<typeof mustDoResolutionSchema>;

export const mustDoCoverageSchema = z.object({
  schemaVersion: z.literal(MUST_DO_VERSION),
  resolutions: z.array(mustDoResolutionSchema).max(24).default([]),
});
export type MustDoCoverage = z.infer<typeof mustDoCoverageSchema>;

/**
 * A decision only a person can take.
 *
 * Two kinds, because there are two things a traveller can honestly say about a
 * request the system could not settle: "leave it" and "I meant that one". There
 * is no "try harder" — the loop already tried, and a button that re-runs a
 * failed search is a button that lies about what it does.
 */
export const MUST_DO_DECISION_KINDS = ['withdrawn', 'chose'] as const;
export const mustDoDecisionKindSchema = z.enum(MUST_DO_DECISION_KINDS);
export type MustDoDecisionKind = z.infer<typeof mustDoDecisionKindSchema>;

export const mustDoDecisionSchema = z.object({
  /**
   * Bounded, because this is written from a form post and stored on the trip.
   *
   * A request id is `mustdo:span:<n>` or `mustdo:interest:<key>` and a chosen id
   * is a compiled place or area id; neither is ever near this length. The bound
   * is here rather than only at the action, because a schema is a wall and a
   * validation somewhere upstream is a convention.
   */
  requestId: z.string().min(1).max(120),
  kind: mustDoDecisionKindSchema,
  /** Which one they meant. Required in practice for `chose`; see `decisionFor`. */
  chosenId: z.string().min(1).max(200).optional(),
  decidedAt: z.string().min(1).max(40),
});
export type MustDoDecision = z.infer<typeof mustDoDecisionSchema>;

/** The decision covering a request, or nothing. Last one wins. */
export function mustDoDecisionFor(
  decisions: readonly MustDoDecision[] | undefined,
  requestId: string,
): MustDoDecision | undefined {
  if (!decisions) return undefined;
  let found: MustDoDecision | undefined;
  for (const decision of decisions) {
    if (decision.requestId === requestId) found = decision;
  }
  return found;
}

/**
 * Statuses that mean nobody is waiting on anything.
 *
 * A withdrawal and a choice count as accounted for, because they are answers.
 * The point of the contract is that no request is *silently* lost, not that
 * every request is granted.
 */
const ACCOUNTED: readonly MustDoStatus[] = ['covered', 'withdrawn', 'replaced'];

export function mustDoIsAccountedFor(resolution: MustDoResolution): boolean {
  return ACCOUNTED.includes(resolution.status);
}

/** The ones the traveller could still do something about, worst first. */
export function mustDoOutstanding(coverage: MustDoCoverage | undefined): MustDoResolution[] {
  if (!coverage) return [];
  const rank: Record<MustDoStatus, number> = {
    ambiguous: 0,
    not_found: 1,
    outside_area: 2,
    unusable: 3,
    covered: 4,
    withdrawn: 5,
    replaced: 6,
  };
  return coverage.resolutions
    .filter((entry) => !mustDoIsAccountedFor(entry))
    .sort((a, b) => rank[a.status] - rank[b.status] || a.request.id.localeCompare(b.request.id));
}

/** Whether this one is waiting on a person rather than on us. */
export function mustDoNeedsTraveller(resolution: MustDoResolution): boolean {
  return resolution.status === 'ambiguous';
}

// ---------------------------------------------------------------------------
// Applying a decision to a frozen reading
// ---------------------------------------------------------------------------

/**
 * WHAT A DECISION DOES TO A READING THAT WAS ALREADY WRITTEN.
 *
 * Both the coverage and the readiness are frozen onto the compiled artifact, and
 * they must be: a verdict recomputed at render time from whatever happens to be
 * reachable is a different verdict, and a board that explains itself differently
 * on the second look is worse than one that does not explain itself at all.
 *
 * A traveller's decision is not that. It is **new information, explicitly given
 * and durably stored**, and the alternative to applying it here is either
 * re-buying a whole region to change one line — which is a real bill for a
 * button press — or letting the panel say "you took this off" while the reading
 * beside it still counts it as missing. Neither is acceptable, and the second is
 * the ordinary way a product ends up disagreeing with itself on one screen.
 *
 * So: pure, total, and a function of two persisted values. Same artifact plus
 * same decisions always produces the same pair, and with no decisions it returns
 * exactly what it was given.
 */
export function settleMustDoCoverage(input: {
  coverage?: MustDoCoverage | undefined;
  readiness?: DestinationResearchReadiness | undefined;
  decisions?: readonly MustDoDecision[] | undefined;
}): { coverage?: MustDoCoverage; readiness?: DestinationResearchReadiness } {
  const { coverage, readiness } = input;
  const decisions = input.decisions ?? [];
  if (!coverage || decisions.length === 0) {
    return { ...(coverage ? { coverage } : {}), ...(readiness ? { readiness } : {}) };
  }

  const resolutions = coverage.resolutions.map((resolution): MustDoResolution => {
    const decision = mustDoDecisionFor(decisions, resolution.request.id);
    if (!decision) return resolution;
    if (decision.kind === 'withdrawn') {
      return {
        request: resolution.request,
        status: 'withdrawn',
        candidates: [],
        detail: 'You told us to leave this one out.',
      };
    }
    /*
     * A choice is honoured only when it points at something this reading
     * actually offered. Anything else would be planning around an identifier
     * with nothing behind it, so the request falls back to whatever the build
     * established and the traveller is asked again.
     */
    const chosen =
      resolution.candidates.find((entry) => entry.id === decision.chosenId) ??
      (resolution.match?.id === decision.chosenId ? resolution.match : undefined);
    if (!chosen) return resolution;
    return {
      request: resolution.request,
      status: 'replaced',
      match: { ...chosen, method: 'traveller_chose' },
      candidates: [],
      detail: `You picked ${chosen.name}.`,
    };
  });

  const settledCoverage: MustDoCoverage = { ...coverage, resolutions };
  if (!readiness) return { coverage: settledCoverage };

  const asked = resolutions.length;
  const accounted = resolutions.filter((entry) => mustDoIsAccountedFor(entry)).length;
  const outstanding = Math.max(0, asked - accounted);
  const needsTraveller = resolutions.filter((entry) => mustDoNeedsTraveller(entry)).length;

  const dimensions = readiness.dimensions.map((entry) => {
    if (entry.dimension !== 'must_do_coverage') return entry;
    if (asked === 0) return entry;
    return outstanding === 0
      ? {
          ...entry,
          state: 'met' as const,
          observed: accounted,
          expected: asked,
          detail: `All ${asked} ${asked === 1 ? 'thing' : 'things'} you named ${asked === 1 ? 'is' : 'are'} accounted for.`,
        }
      : {
          ...entry,
          state: 'unmet' as const,
          observed: accounted,
          expected: asked,
          detail:
            needsTraveller > 0
              ? `${outstanding} of the ${asked} things you named ${outstanding === 1 ? 'is' : 'are'} still open, and ${needsTraveller === 1 ? 'one needs' : `${needsTraveller} need`} you to pick which you meant.`
              : `${outstanding} of the ${asked} things you named ${outstanding === 1 ? 'is' : 'are'} still unaccounted for.`,
        };
  });

  const binding = dimensions
    .filter((entry) => entry.required && entry.state === 'unmet')
    .map((entry) => entry.dimension);
  /*
   * A repair aimed at a deficit that no longer binds is not on offer. Only the
   * must-do repair is filtered, because only the must-do dimension can change
   * here — nothing a traveller decides makes a ferry timetable exist.
   */
  const repairs = binding.includes('must_do_coverage')
    ? readiness.repairs
    : readiness.repairs.filter((repair) => repair !== 'targeted_subject_query');

  return {
    coverage: settledCoverage,
    readiness: {
      ...readiness,
      dimensions,
      binding,
      repairs,
      level: researchLevelFor(binding, repairs, dimensions),
    },
  };
}

// ---------------------------------------------------------------------------
// Extraction, from what the traveller already typed
// ---------------------------------------------------------------------------

/**
 * A run of capitalised words, which is the only evidence available at composer
 * time that somebody named a thing.
 *
 * Deliberately conservative, and the conservatism is asymmetric on purpose. A
 * false positive costs one line on a panel saying "we could not find this",
 * which is annoying; a rule loose enough to catch every phrasing would make
 * every ordinary sentence a named requirement and put a shortfall on every trip
 * in the product, which is worse than the gap it closes.
 *
 * The clause-initial word is skipped when it stands alone, because sentence case
 * capitalises it whatever it is. It counts when the word after it is capitalised
 * too: "Ghibli Museum" opens a clause and is plainly a name, while "We must go
 * hiking" is plainly not.
 */
export function namesSomething(clause: string): boolean {
  const words = clause.trim().split(/\s+/).filter((word) => word.length > 0);
  const capitalised = words.map((word) => /^[\p{Lu}][\p{L}\p{M}’'-]{1,}$/u.test(word));
  for (let index = 0; index < capitalised.length; index += 1) {
    if (!capitalised[index]) continue;
    // Not the first word on its own — that is sentence case, not a name.
    if (index > 0) return true;
    if (capitalised[1]) return true;
  }
  return false;
}

/**
 * Turn what the traveller wrote into typed requests, before anything is compiled.
 *
 * Two sources, and they are genuinely different questions:
 *
 * - **A clause in the must-do box that names something.** Proper-noun evidence
 *   in the traveller's own characters is the only signal available at composer
 *   time, and it is read off *every* clause rather than only the ones the phrase
 *   table failed on. That matters more than it sounds: "the Ghibli Museum"
 *   matches the word `museum`, so the parser resolves it to an interest and
 *   records no leftover at all — and a rule that only looked at leftovers would
 *   lose exactly the requests most worth keeping. A clause can be both a
 *   preference and a named thing, and it is treated as both.
 * - **Confirmed `must_have` chips.** "We came here for the hot springs" is a
 *   requirement too, and one the traveller has explicitly accepted. It resolves
 *   against what a candidate *is* rather than against its name — but only when
 *   the clause names nothing, because a named place is the more specific request
 *   and listing the same sentence twice helps nobody.
 *
 * The `avoid` box contributes nothing. A refusal is not a requirement, and the
 * one thing worse than losing a must-do is manufacturing one out of a dislike.
 *
 * Pure, and total over a missing interpretation: a trip whose composer nobody
 * filled in has no must-dos, which is the ordinary case and reads correctly as
 * "you did not name anything specific".
 */
export function mustDoRequestsFrom(
  interpretation: InterpretationSet | undefined,
): MustDoRequest[] {
  if (!interpretation) return [];
  const requests: MustDoRequest[] = [];
  /** Spans already claimed as a named subject, so a clause yields one request. */
  const named = new Set<number>();

  const claim = (span: readonly [number, number], quote: string, looksLikeAName: boolean) => {
    if (named.has(span[0])) return;
    if (!looksLikeAName && !namesSomething(quote)) return;
    named.add(span[0]);
    requests.push({
      id: `mustdo:span:${span[0]}`,
      kind: 'named_subject',
      source: 'composer_text',
      quote,
      span: [span[0], span[1]],
      /*
       * Always true here, because a clause with no proper-noun evidence never
       * reaches this branch. The field stays on the type because a stored
       * request from another intake path may not carry the evidence, and a
       * resolver that assumed it would be silently wrong about that one.
       */
      namedExplicitly: true,
    });
  };

  for (const entry of interpretation.unresolved) {
    if ((entry.field ?? 'mustDo') !== 'mustDo') continue;
    claim(entry.span, entry.quote, entry.looksLikeAName);
  }
  for (const chip of interpretation.chips) {
    if (chip.field !== 'mustDo') continue;
    claim(chip.span, chip.quote, false);
  }

  for (const chip of activeChips(interpretation)) {
    if (chip.field !== 'mustDo') continue;
    if (chip.strength !== 'must_have') continue;
    if (chip.target.kind !== 'interest') continue;
    // The clause already produced a named request; that is the sharper one.
    if (named.has(chip.span[0])) continue;
    requests.push({
      id: `mustdo:interest:${chip.target.value}`,
      kind: 'experience',
      source: 'confirmed_preference',
      quote: chip.quote,
      interest: chip.target.value,
      /*
       * A confirmed chip is an explicit statement rather than a guess at one, so
       * it is always reportable — the traveller pressed a button that said this
       * must happen.
       */
      namedExplicitly: true,
    });
  }

  // Deterministic order, and unique ids: two identical chips would otherwise
  // produce two rows that a decision could not tell apart.
  const seen = new Set<string>();
  return requests
    .filter((request) => (seen.has(request.id) ? false : (seen.add(request.id), true)))
    .sort((a, b) => a.id.localeCompare(b.id));
}
