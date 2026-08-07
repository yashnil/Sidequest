import {
  MAX_EVIDENCE_EXCERPT_CHARS,
  REGION_EVIDENCE_VERSION,
  assessFreshness,
  operatingCalendarSchema,
  resolveFacts,
  resolutionKey,
  shelfLifeFor,
  type AdvisorySeverity,
  type ClosureEvidence,
  type CostEvidence,
  type EvidenceClaim,
  type FactPath,
  type OperatingCalendar,
  type PlaceEvidence,
  type RegionEvidence,
  type ResolvedFact,
  type SafetyEvidence,
  type SourceFact,
  type SourceVolatility,
  type TriState,
} from '@sidequest/core';
import { z } from 'zod';
import type {
  ExtractedClaim,
  ProviderGap,
  ResearchSubject,
  RetrievedDocument,
} from './providers';

/**
 * FROM PAGES TO FACTS THE PLANNER CAN ENFORCE.
 *
 * The compiler owns this rather than any provider, and that is the point: a
 * provider supplies text, and this decides what the text is worth. Authority,
 * freshness, corroboration and the verification state are all stamped here, from
 * observable properties, by code a person can read.
 *
 * The pipeline in one line:
 *
 *   claims → typed payloads (or dropped) → SourceFacts → resolve → evidence
 *
 * Every arrow can lose things, and losing them is the correct behaviour. A claim
 * whose payload does not validate is dropped rather than coerced; a fact whose
 * sources disagree stays conflicted rather than being picked between; a subject
 * nobody published anything about ends with `unknown` on every path.
 */

export const EXTRACTION_SCHEMA_VERSION = 'enrichment-payloads/1';

// ---------------------------------------------------------------------------
// The typed payloads. Anything that does not parse is not a fact.
// ---------------------------------------------------------------------------

const minuteSchema = z.number().int().min(0).max(1440);

const weeklyHoursPayloadSchema = z.object({
  periods: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        months: z.array(z.number().int().min(1).max(12)).min(1).max(12),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
        windows: z
          .array(
            z.object({
              openMinute: minuteSchema,
              closeMinute: minuteSchema,
              lastAdmissionMinute: minuteSchema.optional(),
            }),
          )
          .min(1)
          .max(4),
      }),
    )
    .min(1)
    .max(6),
  closedAnnualDates: z
    .array(z.string().regex(/^\d{2}-\d{2}$/))
    .max(12)
    .default([]),
});

const closurePayloadSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  severity: z.enum(['blocks', 'cautions', 'informs']),
});

const bookingPayloadSchema = z.object({
  value: z.enum(['yes', 'no']),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  bookingUrl: z.string().max(500).optional(),
});

const costPayloadSchema = z.object({
  free: z.boolean().default(false),
  currency: z.string().length(3).optional(),
  amount: z.number().min(0).max(100_000).optional(),
  maxAmount: z.number().min(0).max(100_000).optional(),
  unit: z
    .enum(['per_person', 'per_vehicle', 'per_group', 'per_day', 'per_reservation'])
    .default('per_person'),
  advancePurchaseRequired: z.enum(['yes', 'no', 'unknown']).default('unknown'),
});

const safetyPayloadSchema = z.object({
  severity: z.enum(['blocks', 'cautions', 'informs']),
  appliesTo: z.string().min(1).max(120).optional(),
  requires: z.array(z.string().min(1).max(80)).max(6).default([]),
});

const durationPayloadSchema = z.object({
  minutes: z.number().int().min(5).max(1440),
});

const seasonPayloadSchema = z.object({
  openMonths: z.array(z.number().int().min(1).max(12)).min(1).max(12),
});

// ---------------------------------------------------------------------------
// Claims → facts
// ---------------------------------------------------------------------------

/** How volatile each kind of fact is, so a calendar carries an honest recheck. */
const VOLATILITY: Partial<Record<FactPath, SourceVolatility>> = {
  'hours.closure': 'dynamic',
  'safety.caution': 'dynamic',
  'hours.weekly': 'seasonal_recurring',
  'hours.seasonal': 'seasonal_recurring',
  'food.hours': 'dynamic',
  'cost.admission': 'seasonal_recurring',
  'cost.parking': 'seasonal_recurring',
};

export interface ToFactsInput {
  claims: readonly ExtractedClaim[];
  documents: readonly RetrievedDocument[];
  promptVersion: string;
  schemaVersion: string;
  modelId?: string;
  now: Date;
}

export interface ToFactsResult {
  facts: SourceFact[];
  /** Payloads that did not validate. Counted, never coerced. */
  discarded: number;
  /** Parsed payloads, keyed by fact id, for the evidence builder. */
  payloads: Map<string, unknown>;
}

/**
 * Turn extracted claims into facts, dropping anything that cannot be defended.
 *
 * Three gates, in order, and each of them drops rather than repairs:
 *
 * 1. the claim must point at a document we actually fetched;
 * 2. a `directly_stated` claim must quote it or point at a structured field;
 * 3. the payload for its path must parse.
 *
 * A model that returns a plausible sentence with no excerpt gets nothing through
 * gate 2, which is the gate that matters: an unquotable fact is one nobody can
 * check, and this system's entire claim is that its facts can be checked.
 */
/**
 * The three gates, in one place, because two callers apply them.
 *
 * `claimsToFacts` builds trip-local facts and `toClaimRecords` builds durable
 * shared claims, and both must drop exactly the same things — a claim that is
 * good enough to store and not good enough to act on, or the reverse, would be
 * a store and a planner disagreeing about what evidence is.
 */
export type ClaimGate =
  | { ok: false }
  | { ok: true; payload: unknown; excerpt: string | undefined; structured: boolean };

export function gateClaim(claim: ExtractedClaim, document: RetrievedDocument | undefined): ClaimGate {
  // 1. It must point at a document we actually fetched, for its own subject.
  if (!document || document.subjectId !== claim.subjectId) return { ok: false };

  // 2. A directly-stated claim must quote the page or name a structured field.
  //    An unquotable fact is one nobody can check, and this system's entire
  //    claim is that its facts can be checked.
  const excerpt = claim.evidenceExcerpt?.trim().slice(0, MAX_EVIDENCE_EXCERPT_CHARS);
  const structured = claim.evidenceField !== undefined;
  if (claim.derivation === 'directly_stated' && !structured && !excerpt) return { ok: false };

  // 3. The payload for its path must parse. Dropped rather than coerced.
  const payload = parsePayload(claim.factPath, claim.payload);
  if (payload === undefined && requiresPayload(claim.factPath)) return { ok: false };

  return { ok: true, payload, excerpt, structured };
}

/** How volatile a path is, and how long a fact on it stays worth believing. */
export function volatilityOf(path: FactPath): SourceVolatility {
  return VOLATILITY[path] ?? 'stable';
}

export { factKindFor };

export function claimsToFacts(input: ToFactsInput): ToFactsResult {
  const facts: SourceFact[] = [];
  const payloads = new Map<string, unknown>();
  let discarded = 0;
  let sequence = 0;

  for (const claim of input.claims) {
    const document = input.documents[claim.documentIndex];
    const gate = gateClaim(claim, document);
    if (!gate.ok || !document) {
      discarded += 1;
      continue;
    }
    const { payload, excerpt, structured } = gate;

    const id = `fact-${document.subjectId}-${claim.factPath}-${sequence}`;
    sequence += 1;
    const volatility = VOLATILITY[claim.factPath] ?? 'stable';
    const recheckRequired = volatility === 'dynamic';

    facts.push({
      id,
      subjectId: claim.subjectId,
      factPath: claim.factPath,
      kind: factKindFor(claim.factPath),
      statement: claim.statement.slice(0, 400),
      authorityKind: document.authority,
      authorityName: document.publisher,
      sourceUrl: document.url,
      ...(document.title ? { sourceTitle: document.title } : {}),
      sourceDomain: document.domain,
      retrievedAt: document.retrievedAt,
      ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
      retrievalStatus: structured ? 'structured_data' : 'fetched',
      ...(excerpt ? { evidenceExcerpt: excerpt } : {}),
      ...(claim.evidenceField ? { evidenceField: claim.evidenceField } : {}),
      contentHash: document.contentHash,
      extractionPromptVersion: input.promptVersion,
      extractionSchemaVersion: input.schemaVersion,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      derivation: claim.derivation,
      volatility,
      shelfLifeDays: shelfLifeFor(claim.factPath),
      recheckRequired,
      ...(recheckRequired
        ? { recheckNote: 'This changes without notice. Check the official page before you go.' }
        : {}),
    });
    if (payload !== undefined) payloads.set(id, payload);
  }

  return { facts, discarded, payloads };
}

function requiresPayload(path: FactPath): boolean {
  return (
    path === 'hours.weekly' ||
    path === 'hours.closure' ||
    path === 'booking.required' ||
    path === 'booking.timedEntry' ||
    path === 'booking.leadTime' ||
    path === 'access.permit' ||
    path.startsWith('cost.') ||
    path.startsWith('safety.') ||
    path === 'duration.typical' ||
    path === 'hours.seasonal'
  );
}

function parsePayload(path: FactPath, payload: unknown): unknown {
  if (payload === undefined || payload === null) return undefined;
  const schema = schemaFor(path);
  if (!schema) return undefined;
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

function schemaFor(path: FactPath): z.ZodType | undefined {
  switch (path) {
    case 'hours.weekly':
    case 'food.hours':
      return weeklyHoursPayloadSchema;
    case 'hours.seasonal':
      return seasonPayloadSchema;
    case 'hours.closure':
      return closurePayloadSchema;
    case 'booking.required':
    case 'booking.timedEntry':
    case 'booking.leadTime':
    case 'access.permit':
    case 'food.reservation':
      return bookingPayloadSchema;
    case 'cost.admission':
    case 'cost.parking':
    case 'cost.transport':
    case 'food.price':
      return costPayloadSchema;
    case 'safety.caution':
    case 'safety.requirement':
      return safetyPayloadSchema;
    case 'duration.typical':
      return durationPayloadSchema;
    default:
      return undefined;
  }
}

function factKindFor(path: FactPath): SourceFact['kind'] {
  if (path.startsWith('hours.')) return path === 'hours.closure' ? 'closure' : 'operating_hours';
  if (path === 'hours.seasonal') return 'seasonal_access';
  if (path.startsWith('booking.') || path === 'access.permit') return 'permit_or_reservation';
  if (path === 'cost.parking') return 'parking';
  if (path.startsWith('cost.') || path === 'food.price') return 'fee';
  if (path.startsWith('safety.')) return 'route_condition';
  if (path === 'duration.typical') return 'minimum_duration';
  if (path === 'food.hours') return 'operating_hours';
  return 'general';
}

// ---------------------------------------------------------------------------
// Facts → evidence
// ---------------------------------------------------------------------------

export interface BuildEvidenceInput {
  subjects: readonly ResearchSubject[];
  facts: readonly SourceFact[];
  payloads: Map<string, unknown>;
  /** Official URLs supplied by an open structured source, before any search. */
  knownOfficialUrls: Map<string, { url: string; authority: string; name: string }>;
  /**
   * The traveller's dates, so a dated fact can be judged against the trip rather
   * than against today.
   *
   * Without them, a closure that ended last month still removes a place, and one
   * that begins the week after somebody leaves does too. Both were happening: a
   * closure blocked on severity alone, with its own dates read only for display.
   */
  dates: readonly string[];
  /**
   * Answers already resolved for exactly this evidence.
   *
   * Only ever supplied for paths whose answer does not depend on the traveller's
   * calendar, and only used when the claim set behind it is identical. The
   * resolver checks that itself — this is a hand-off, not a licence.
   */
  preresolved?: ReadonlyMap<string, ResolvedFact>;
  now: Date;
}

export interface BuildEvidenceResult {
  evidence: RegionEvidence;
  resolved: ResolvedFact[];
  /** Indexed, so a caller can persist the answer for one cell. */
  byKey: Map<string, ResolvedFact>;
  /** How many answers were handed in rather than computed. */
  reusedResolutions: number;
  /** Calendars we are entitled to assert, for the subjects that earned one. */
  calendars: OperatingCalendar[];
  /** Subjects a source says must not be scheduled — the union of the two below. */
  blockedSubjectIds: string[];
  /**
   * Shut on these dates, as distinct from unsafe on them.
   *
   * The two were one set, so both resolved to "An official source says it is shut
   * on your dates" — which is a different claim from the one a safety advisory
   * makes, and a wrong one. Somebody told the road is shut plans around a closure;
   * somebody told the trail is shut when the notice was an avalanche advisory has
   * been told something that is not true about a place that is open.
   */
  closureBlockedSubjectIds: string[];
  safetyBlockedSubjectIds: string[];
  /** The published sentence that caused the block, with the stage that produced it. */
  blockingStatements: Map<string, { text: string; stage: 'availability' | 'safety' }>;
}

export function buildEvidence(input: BuildEvidenceInput): BuildEvidenceResult {
  const wanted = input.subjects.flatMap((subject) =>
    subject.wantedPaths.map((factPath) => ({ subjectId: subject.id, factPath })),
  );
  const { resolved, byKey, reusedResolutions } = resolveFacts({
    facts: input.facts,
    wanted,
    ...(input.preresolved ? { preresolved: input.preresolved } : {}),
    now: input.now,
  });

  const factsById = new Map(input.facts.map((fact) => [fact.id, fact]));
  const places: PlaceEvidence[] = [];
  const calendars: OperatingCalendar[] = [];
  const blocked = new Set<string>();
  const closureBlocked = new Set<string>();
  const safetyBlocked = new Set<string>();
  const blockingStatement = new Map<string, { text: string; stage: 'availability' | 'safety' }>();

  for (const subject of input.subjects) {
    const mine = resolved.filter((entry) => entry.subjectId === subject.id);
    const claimFor = (path: FactPath): EvidenceClaim | undefined => {
      const entry = byKey.get(resolutionKey(subject.id, path));
      if (!entry) return undefined;
      return {
        ...(entry.acceptedFactId ? { factId: entry.acceptedFactId } : {}),
        state: entry.state,
        factPath: path,
      };
    };
    const acceptedPayload = (path: FactPath): unknown => {
      const entry = byKey.get(resolutionKey(subject.id, path));
      if (!entry?.acceptedFactId) return undefined;
      return input.payloads.get(entry.acceptedFactId);
    };

    const known = input.knownOfficialUrls.get(subject.id);
    const officialFromFacts = factsById.get(
      byKey.get(resolutionKey(subject.id, 'identity.officialSite'))?.acceptedFactId ?? '',
    );
    const officialUrl = known?.url ?? officialFromFacts?.sourceUrl ?? subject.knownOfficialUrl;

    const booking = buildBooking(claimFor, acceptedPayload, officialUrl);
    const costs = buildCosts(claimFor, acceptedPayload);
    const closures = buildClosures(subject.id, byKey, factsById, input.payloads, {
      dates: input.dates,
      now: input.now,
    });
    const safety = buildSafety(subject.id, byKey, factsById, input.payloads);

    const durationPayload = acceptedPayload('duration.typical') as
      | { minutes: number }
      | undefined;

    const evidence: PlaceEvidence = {
      subjectId: subject.id,
      ...(officialUrl ? { officialUrl } : {}),
      ...(officialUrl ? { officialUrlClaim: claimFor('identity.officialSite') ?? knownClaim(known) } : {}),
      aliases: [],
      ...(booking ? { booking } : {}),
      costs,
      closures,
      safety,
      ...(durationPayload ? { suggestedDurationMinutes: durationPayload.minutes } : {}),
      ...(durationPayload ? { suggestedDurationClaim: claimFor('duration.typical') } : {}),
      resolved: mine,
    };
    places.push(evidence);

    /**
     * A closure that blocks is the one fact here that removes a candidate.
     *
     * Not a caution and not a demotion: if a source states the place is shut on
     * the dates in question, scheduling it anyway would be the exact failure the
     * whole evidence layer exists to prevent.
     */
    const blockingClosure = closures.find((closure) => closure.severity === 'blocks');
    const blockingSafety = safety.find((entry) => entry.severity === 'blocks');
    if (blockingClosure) {
      blocked.add(subject.id);
      closureBlocked.add(subject.id);
      blockingStatement.set(subject.id, { text: blockingClosure.statement, stage: 'availability' });
    } else if (blockingSafety) {
      /*
       * Closure first when both fire. "Shut on your dates" is the stronger and
       * the more actionable of the two, and a safety notice about a place that is
       * also shut is not the thing to lead with.
       */
      blocked.add(subject.id);
      safetyBlocked.add(subject.id);
      blockingStatement.set(subject.id, { text: blockingSafety.statement, stage: 'safety' });
    }

    const calendar = buildCalendar(subject.id, byKey, factsById, input.payloads, booking);
    if (calendar) calendars.push(calendar);
  }

  return {
    evidence: { version: REGION_EVIDENCE_VERSION, places, regionSafety: [] },
    resolved,
    byKey,
    reusedResolutions,
    calendars,
    blockedSubjectIds: [...blocked].sort(),
    closureBlockedSubjectIds: [...closureBlocked].sort(),
    safetyBlockedSubjectIds: [...safetyBlocked].sort(),
    blockingStatements: blockingStatement,
  };
}

function knownClaim(
  known: { url: string; authority: string; name: string } | undefined,
): EvidenceClaim | undefined {
  if (!known) return undefined;
  return { state: 'single_source', factPath: 'identity.officialSite' };
}

function buildBooking(
  claimFor: (path: FactPath) => EvidenceClaim | undefined,
  payloadFor: (path: FactPath) => unknown,
  officialUrl: string | undefined,
): PlaceEvidence['booking'] {
  const required = payloadFor('booking.required') as z.infer<typeof bookingPayloadSchema> | undefined;
  const timed = payloadFor('booking.timedEntry') as z.infer<typeof bookingPayloadSchema> | undefined;
  const permit = payloadFor('access.permit') as z.infer<typeof bookingPayloadSchema> | undefined;
  const lead = payloadFor('booking.leadTime') as z.infer<typeof bookingPayloadSchema> | undefined;

  if (!required && !timed && !permit && !lead) return undefined;

  const claim =
    claimFor('booking.required') ??
    claimFor('booking.timedEntry') ??
    claimFor('access.permit') ??
    claimFor('booking.leadTime') ?? { state: 'unknown' as const };

  const bookingUrl = firstHttpUrl([required?.bookingUrl, timed?.bookingUrl, lead?.bookingUrl]);

  return {
    reservationRequired: tri(required?.value),
    timedEntry: tri(timed?.value),
    permitRequired: tri(permit?.value),
    guideRequired: 'unknown',
    ...(lead?.leadTimeDays !== undefined ? { leadTimeDays: lead.leadTimeDays } : {}),
    ...(bookingUrl ? { bookingUrl } : officialUrl ? { bookingUrl: officialUrl } : {}),
    claim,
  };
}

function tri(value: 'yes' | 'no' | undefined): TriState {
  return value ?? 'unknown';
}

function firstHttpUrl(candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      /* not a URL; keep looking */
    }
  }
  return undefined;
}

function buildCosts(
  claimFor: (path: FactPath) => EvidenceClaim | undefined,
  payloadFor: (path: FactPath) => unknown,
): CostEvidence[] {
  const costs: CostEvidence[] = [];
  const pairs: { path: FactPath; kind: CostEvidence['kind'] }[] = [
    { path: 'cost.admission', kind: 'admission' },
    { path: 'cost.parking', kind: 'parking' },
    { path: 'cost.transport', kind: 'transport' },
  ];

  for (const pair of pairs) {
    const payload = payloadFor(pair.path) as z.infer<typeof costPayloadSchema> | undefined;
    const claim = claimFor(pair.path);
    if (!payload || !claim) continue;

    /**
     * A price with no currency is not a price.
     *
     * "12" could be dollars, euros or a queue position. Dropping the number and
     * keeping the fact that admission is charged is more useful than showing a
     * figure nobody can spend.
     */
    const hasMoney =
      !payload.free && payload.amount !== undefined && payload.currency !== undefined;

    costs.push({
      kind: pair.kind,
      free: payload.free,
      ...(hasMoney
        ? {
            money: {
              currency: payload.currency!.toUpperCase(),
              amount: payload.amount!,
              ...(payload.maxAmount !== undefined && payload.maxAmount >= payload.amount!
                ? { maxAmount: payload.maxAmount }
                : {}),
              unit: payload.unit,
              estimated: payload.maxAmount !== undefined,
              taxesUncertain: true,
            },
          }
        : {}),
      advancePurchaseRequired: payload.advancePurchaseRequired,
      ...(!payload.free && !hasMoney ? { note: 'There is a charge; the amount was not published in a form we could read.' } : {}),
      claim,
    });
  }
  return costs;
}

function buildClosures(
  subjectId: string,
  byKey: Map<string, ResolvedFact>,
  factsById: Map<string, SourceFact>,
  payloads: Map<string, unknown>,
  when: { dates: readonly string[]; now: Date },
): ClosureEvidence[] {
  const entry = byKey.get(resolutionKey(subjectId, 'hours.closure'));
  if (!entry) return [];

  /**
   * Every closure fact is shown, not only the accepted one.
   *
   * Two operators announcing two different closure windows is exactly the case
   * where picking one is dangerous, and the resolver has already marked it
   * `conflicted`. What it must not do is hide the other window.
   */
  const closures: ClosureEvidence[] = [];
  for (const factId of entry.factIds) {
    const fact = factsById.get(factId);
    const payload = payloads.get(factId) as z.infer<typeof closurePayloadSchema> | undefined;
    if (!fact || !payload) continue;
    /**
     * A conflicted closure cautions rather than blocks.
     *
     * Removing a place because one of two disagreeing sources says it is shut
     * would let the less reliable source win by being the more alarming one.
     */
    /**
     * A closure is judged against the *trip*, not against today.
     *
     * `assessFreshness` answers three questions at once that were previously
     * being answered by severity alone: has this window already ended before the
     * traveller arrives, does it begin after they leave, and is the notice old
     * enough that it may have been lifted without anybody updating the page. A
     * closure failing any of them is shown and never enforced — because removing
     * a place on the strength of a notice that no longer applies is the same
     * class of error as scheduling one that is shut.
     */
    const freshness = assessFreshness({
      factPath: 'hours.closure',
      contentObservedAt: fact.retrievedAt,
      ...(fact.publishedAt ? { publishedAt: fact.publishedAt } : {}),
      ...(payload.from ? { appliesFrom: payload.from } : {}),
      ...(payload.to ? { appliesTo: payload.to } : {}),
      travelDates: when.dates,
      now: when.now,
      ...(fact.shelfLifeDays !== undefined ? { shelfLifeDays: fact.shelfLifeDays } : {}),
    });

    const severity: AdvisorySeverity =
      entry.state === 'conflicted' || entry.state === 'stale' || entry.state === 'inferred'
        ? 'cautions'
        : freshness.enforceable
          ? payload.severity
          : 'informs';
    closures.push({
      statement: fact.statement.slice(0, 300),
      ...(payload.from ? { from: payload.from } : {}),
      ...(payload.to ? { to: payload.to } : {}),
      severity,
      ...(freshness.enforceable
        ? {}
        : { note: freshness.rationale }),
      claim: { factId: fact.id, state: entry.state, factPath: 'hours.closure' },
    });
  }
  return closures.slice(0, 6);
}

function buildSafety(
  subjectId: string,
  byKey: Map<string, ResolvedFact>,
  factsById: Map<string, SourceFact>,
  payloads: Map<string, unknown>,
): SafetyEvidence[] {
  const out: SafetyEvidence[] = [];
  for (const path of ['safety.caution', 'safety.requirement'] as const) {
    const entry = byKey.get(resolutionKey(subjectId, path));
    if (!entry) continue;
    for (const factId of entry.factIds) {
      const fact = factsById.get(factId);
      const payload = payloads.get(factId) as z.infer<typeof safetyPayloadSchema> | undefined;
      if (!fact || !payload) continue;
      /**
       * A safety statement only ever blocks when an official voice states it
       * directly. Everything else cautions.
       *
       * This is the line between "the managing agency has closed the trail" and
       * "a page mentions the trail can be icy". Only the first is a planning
       * rule; treating the second as one would make the product alarmist, which
       * is its own kind of dishonest.
       */
      const severity: AdvisorySeverity =
        payload.severity === 'blocks' && entry.state === 'verified' ? 'blocks' : payload.severity === 'blocks' ? 'cautions' : payload.severity;
      out.push({
        statement: fact.statement.slice(0, 300),
        severity,
        ...(payload.appliesTo ? { appliesTo: payload.appliesTo } : {}),
        requires: payload.requires,
        claim: { factId: fact.id, state: entry.state, factPath: path },
      });
    }
  }
  return out.slice(0, 8);
}

/**
 * A calendar, but only where the evidence is strong enough to enforce one.
 *
 * `conflicted`, `stale` and `inferred` states produce **no calendar**, which
 * leaves the subject on the `unknown` calendar the compiler already writes. That
 * is deliberate: an enforced schedule built on sources that disagree is worse
 * than an honest unknown, because the planner will happily build a day around
 * it.
 */
function buildCalendar(
  subjectId: string,
  byKey: Map<string, ResolvedFact>,
  factsById: Map<string, SourceFact>,
  payloads: Map<string, unknown>,
  booking: PlaceEvidence['booking'],
): OperatingCalendar | null {
  const entry = byKey.get(resolutionKey(subjectId, 'hours.weekly'));
  if (!entry?.acceptedFactId) return null;
  if (entry.state !== 'verified' && entry.state !== 'corroborated' && entry.state !== 'single_source') {
    return null;
  }

  const fact = factsById.get(entry.acceptedFactId);
  const payload = payloads.get(entry.acceptedFactId) as
    | z.infer<typeof weeklyHoursPayloadSchema>
    | undefined;
  if (!fact || !payload) return null;

  const reservationRequired = booking?.reservationRequired === 'yes';
  const permitRequired = booking?.permitRequired === 'yes';
  const timedEntry = booking?.timedEntry === 'yes';

  const candidate = {
    kind: 'scheduled' as const,
    placeId: subjectId,
    admission: {
      reservationRequired: reservationRequired || timedEntry,
      timedEntry,
      permitRequired,
      walkInAllowed: !(reservationRequired || timedEntry),
      capacityLimited: timedEntry,
      ...(booking?.bookingUrl ? { bookingUrl: booking.bookingUrl } : {}),
      ...(reservationRequired || permitRequired || timedEntry
        ? { note: booking?.note ?? 'The operator says you must arrange this in advance.' }
        : {}),
    },
    daylightOnly: false,
    note: fact.statement.slice(0, 200),
    periods: payload.periods.map((period) => ({
      label: period.label,
      months: period.months,
      ...(period.daysOfWeek && period.daysOfWeek.length < 7
        ? { daysOfWeek: period.daysOfWeek }
        : {}),
      windows: period.windows,
    })),
    closedAnnualDates: payload.closedAnnualDates,
    provenance: {
      kind: 'official' as const,
      sourceName: fact.authorityName,
      ...(fact.sourceUrl ? { sourceUrl: fact.sourceUrl } : {}),
      lastVerified: fact.retrievedAt.slice(0, 10),
      /**
       * Confidence from the resolved state, not from anybody's opinion.
       *
       * The numbers are a rendering of the state for the existing schema, which
       * predates it. They are never compared across dimensions and never shown
       * as a percentage.
       */
      confidence:
        entry.state === 'verified' ? 0.9 : entry.state === 'corroborated' ? 0.8 : 0.65,
      volatility: 'seasonal_recurring' as const,
      recheckNote:
        'Published hours change with the season and at short notice. Worth a look before you go.',
    },
  };

  /**
   * The schema is the last gate, and it is allowed to win.
   *
   * `openingWindowSchema` refuses overnight windows, `admissionRequirement`
   * refuses a booking requirement with nowhere to book, and a calendar that
   * fails either is one the app would reject at render time. Better to have no
   * calendar than an artifact that blows up one screen later.
   */
  const parsed = operatingCalendarSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Prioritisation
// ---------------------------------------------------------------------------

export interface PrioritisationInput {
  candidates: readonly {
    id: string;
    name: string;
    kind: string;
    locality: string;
    coordinates: { lat: number; lng: number };
    knownOfficialUrl?: string;
    /** 0–1, from the trip's own scorer. */
    fitScore: number;
    /** True when the kind of place plausibly has staffed hours or a gate. */
    gated: boolean;
    /** True when nothing published gives us hours. */
    hoursUnknown: boolean;
    /** Somewhere to eat rather than somewhere to go. Capped separately. */
    isFood?: boolean;
  }[];
  maxSubjects: number;
}

/**
 * The most of one compilation's research budget that may go on food.
 *
 * Every restaurant scores well on "unknown hours that would change the plan" —
 * they are all gated and almost none publish hours to a map — so an uncapped
 * funnel spends the whole allowance on kitchens. A live New York compilation did
 * exactly that: eighteen of twenty-four researched subjects were food, and not
 * one attraction came back with an official page.
 *
 * The asymmetry that justifies the cap: a meal has a fallback the product
 * already builds — a grocery stop, a packed lunch, an honest gap — and a museum
 * whose hours nobody checked does not.
 */
const MAX_FOOD_SHARE = 0.35;

/**
 * WHO GETS THE RESEARCH BUDGET.
 *
 * Deterministic, and explainable from three numbers a person can check: how well
 * the candidate fits this traveller, whether not knowing its hours would
 * actually change the plan, and whether we already have somewhere to look.
 *
 * The middle term is the one that earns its place. Researching a roadside
 * viewpoint's opening hours is a wasted search — it has none — while researching
 * a museum's is the difference between a plan and a locked door. So the funnel
 * spends where the answer changes something.
 *
 * The model is not consulted here. It may classify a place; it may not decide
 * which places are worth money.
 */
export function prioritiseSubjects(input: PrioritisationInput): {
  id: string;
  score: number;
}[] {
  const scored = input.candidates
    .map((candidate) => ({
      id: candidate.id,
      isFood: candidate.isFood === true,
      score:
        candidate.fitScore * 0.5 +
        (candidate.gated && candidate.hoursUnknown ? 0.35 : 0) +
        (candidate.knownOfficialUrl ? 0.15 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const limit = Math.max(0, input.maxSubjects);
  const foodLimit = Math.floor(limit * MAX_FOOD_SHARE);
  const chosen: { id: string; score: number }[] = [];
  let foodTaken = 0;

  for (const entry of scored) {
    if (chosen.length >= limit) break;
    if (entry.isFood) {
      if (foodTaken >= foodLimit) continue;
      foodTaken += 1;
    }
    chosen.push({ id: entry.id, score: entry.score });
  }

  /**
   * Any slot the cap left empty goes back to food rather than being wasted.
   *
   * The cap exists to stop kitchens crowding out attractions, not to leave
   * research budget unspent in a region with few attractions to research.
   */
  if (chosen.length < limit) {
    const taken = new Set(chosen.map((entry) => entry.id));
    for (const entry of scored) {
      if (chosen.length >= limit) break;
      if (taken.has(entry.id)) continue;
      chosen.push({ id: entry.id, score: entry.score });
    }
  }
  return chosen;
}

/** The gap a subject leaves behind when its budget ran out before its turn. */
export function budgetGap(subjectId: string, counter: string): ProviderGap {
  return {
    subjectId,
    reason: 'budget_exhausted',
    detail: `This trip ran out of ${counter} before we got to this one.`,
  };
}
