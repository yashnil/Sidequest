/**
 * ASK FOR A CAPABILITY, NOT FOR A VENDOR.
 *
 * The compiler already has good provider seams — a resolver, a place source, a
 * router, three research stages — and they are not what this replaces. What was
 * missing sits one level up: **nothing could answer "can this build do X?"**
 * without importing the thing that does X and inspecting it.
 *
 * That gap has a cost, and it is the founder-test one. A traveller finished a
 * composer and a questionnaire before meeting "compiling new destinations is
 * switched off in this build", because the only way to find out was to try. And
 * a capability that is *absent* looked exactly like one that is *unsupported*,
 * which is how walking came to stand in for transit: nothing could distinguish
 * "no transit provider is configured" from "this region has no transit".
 *
 * So the registry is a declaration, not a dispatcher. Providers register what
 * they can answer for and under what terms; consumers ask before spending, and
 * — the part that matters most — a capability nobody registered is reported as
 * **unavailable rather than assumed**.
 *
 * Three rules it exists to enforce:
 *
 * 1. **A missing capability is a stated fact.** Never a silent fallback to a
 *    different capability that happens to return a number.
 * 2. **Terms travel with the capability.** Whether an answer may be *stored* is
 *    a property of the source, not of the caller — and getting that wrong is a
 *    licensing problem rather than a bug. See `persistence`.
 * 3. **It costs nothing to ask.** This module imports nothing, exactly like the
 *    provider switches it complements, so a render path can consult it without
 *    pulling a socket into its import graph.
 */

/**
 * What Sidequest can want to know about the world.
 *
 * Deliberately shorter than the contract's full list. A capability nothing can
 * supply and nothing consumes is an enum entry pretending to be a feature —
 * every one of these is either registered by a real adapter today or read by a
 * real consumer that has to know it is missing.
 */
export const TRAVEL_CAPABILITIES = [
  'destination_identity',
  'administrative_membership',
  'place_inventory',
  'place_details',
  'place_images',
  'opening_hours',
  'seasonal_access',
  'route_drive',
  'route_walk',
  /**
   * Scheduled public transport between two points.
   *
   * Listed while unsupplied, and that is the point of listing it. A walking
   * matrix over a dense city measures walking, and walking reachability is not
   * evidence about a rail network — so the honest state is a named capability
   * with no provider, which readiness reads and reports as a deficit.
   */
  'route_transit',
  'transit_schedule',
  /**
   * The real civil clock a destination keeps.
   *
   * Its own capability rather than a corner of `destination_identity`, because it
   * is answered by a different kind of source and fails independently: a geocoder
   * that knows exactly where somewhere is very often does not publish what time
   * it is there. Everything downstream that formats an opening hour, a sunrise or
   * a departure needs to know whether this was *answered* or approximated.
   */
  'civil_time_zone',
  'route_ferry',
  'gateway_discovery',
  'travel_time_matrix',
  'food_near_anchor',
  'weather_forecast',
  'climate_normals',
  'daylight',
  'official_web_research',
  'local_context',
] as const;
export type TravelCapability = (typeof TRAVEL_CAPABILITIES)[number];

export const TRAVEL_CAPABILITY_LABELS: Record<TravelCapability, string> = {
  destination_identity: 'Working out what a typed destination is',
  administrative_membership: 'Deciding whether a place is inside the destination',
  place_inventory: 'Finding what is there',
  place_details: 'Filling in detail on a shortlisted place',
  place_images: 'Pictures of a place',
  opening_hours: 'When somewhere is open',
  seasonal_access: 'Whether somewhere is reachable this season',
  route_drive: 'Driving times',
  route_walk: 'Walking times',
  route_transit: 'Public transport times',
  transit_schedule: 'How often public transport runs',
  civil_time_zone: 'What time it is where you are going',
  route_ferry: 'Ferry crossings',
  gateway_discovery: 'Stations, terminals and airports',
  travel_time_matrix: 'Travel times between many points',
  food_near_anchor: 'Somewhere to eat near a stop',
  weather_forecast: 'The forecast for your dates',
  climate_normals: 'What the weather is usually like',
  daylight: 'Sunrise and sunset',
  official_web_research: 'Reading an operator’s own pages',
  local_context: 'Background on how a place works',
};

/**
 * How much a source's word is worth, in the order it is worth taking.
 *
 * The same vocabulary the evidence layer already uses for facts, applied to the
 * provider rather than the claim — because "who is speaking" is decidable
 * before a call is made and is exactly what a broker chooses on.
 */
export const CAPABILITY_AUTHORITIES = [
  'managing_authority',
  'operator',
  'government',
  'open_structured_database',
  'structured_provider',
  'model_inference',
] as const;
export type CapabilityAuthority = (typeof CAPABILITY_AUTHORITIES)[number];

/** How long an answer stays worth believing. */
export const CAPABILITY_FRESHNESS = ['live', 'daily', 'seasonal', 'static'] as const;
export type CapabilityFreshness = (typeof CAPABILITY_FRESHNESS)[number];

/**
 * WHETHER AN ANSWER MAY BE KEPT.
 *
 * A field rather than a convention, because getting it wrong is a licensing
 * problem rather than a bug, and because this repository already has a written
 * blocker about exactly that: one major provider's terms permit storing a place
 * id indefinitely, coordinates for thirty days, and *nothing else* — not names,
 * not hours, not a travel duration. An architecture whose durable artifacts are
 * made of those fields cannot use it, however good the data is.
 *
 * So a consumer that wants to persist an answer has to read this first, and a
 * provider that cannot be persisted is usable only for a decision taken in the
 * same request.
 */
export const CAPABILITY_PERSISTENCE = [
  /** May be stored in a durable artifact, with attribution. */
  'storable',
  /** May be cached for a bounded window and no longer. */
  'time_limited',
  /** May inform a decision in this request and must not be written down. */
  'transient_only',
] as const;
export type CapabilityPersistence = (typeof CAPABILITY_PERSISTENCE)[number];

export interface CapabilityRegistration {
  /** The adapter's own name, as it appears in provenance. */
  provider: string;
  capability: TravelCapability;
  authority: CapabilityAuthority;
  freshness: CapabilityFreshness;
  persistence: CapabilityPersistence;
  /**
   * Where this provider can answer. `'global'`, or ISO country codes.
   *
   * A list rather than a boolean because a park service that speaks
   * authoritatively about one country's parks must not be read as evidence
   * about another's — a real failure mode for exactly the kind of official
   * source most worth having.
   */
  coverage: 'global' | readonly string[];
  /** Whether this build has what it needs to call the provider. */
  configured: boolean;
  /** Named configuration this provider needs and does not have. Never values. */
  missing?: readonly string[];
  /** The licence or attribution an answer carries. */
  attribution?: string;
  /** One sentence, for the diagnostic. */
  note?: string;
}

export interface CapabilityVerdict {
  capability: TravelCapability;
  available: boolean;
  /**
   * Why not, when not — and the three reasons are genuinely different answers.
   *
   * `unsupported` means nothing in this deployment can ever answer it;
   * `unconfigured` means something could, if somebody set it up;
   * `out_of_coverage` means the provider exists and does not speak for here.
   * Collapsing them is how "we have no transit data for this city" and "this
   * city has no transit" became the same sentence.
   */
  reason?: 'unsupported' | 'unconfigured' | 'out_of_coverage';
  providers: CapabilityRegistration[];
  missing: string[];
}

/**
 * The broker.
 *
 * Deliberately dumb: it holds registrations and answers questions about them.
 * Choosing *between* two providers that both answer is a decision with cost and
 * latency in it, and it belongs to the stage making the call — a registry that
 * also dispatched would be a place for that decision to hide.
 */
export class TravelCapabilityRegistry {
  private readonly registrations: CapabilityRegistration[] = [];

  register(registration: CapabilityRegistration): this {
    this.registrations.push(registration);
    return this;
  }

  /**
   * Can this build answer this, here?
   *
   * `countryCode` is optional and its absence means "anywhere" — a caller that
   * does not know where it is asking about gets the optimistic answer, which is
   * correct: the coverage check exists to stop a regional source being read as
   * global, not to refuse a question nobody has located yet.
   */
  assess(capability: TravelCapability, countryCode?: string): CapabilityVerdict {
    const forCapability = this.registrations.filter(
      (entry) => entry.capability === capability,
    );
    if (forCapability.length === 0) {
      return { capability, available: false, reason: 'unsupported', providers: [], missing: [] };
    }

    const inCoverage = forCapability.filter((entry) => covers(entry, countryCode));
    if (inCoverage.length === 0) {
      return {
        capability,
        available: false,
        reason: 'out_of_coverage',
        providers: forCapability,
        missing: [],
      };
    }

    const configured = inCoverage.filter((entry) => entry.configured);
    if (configured.length === 0) {
      return {
        capability,
        available: false,
        reason: 'unconfigured',
        providers: inCoverage,
        missing: [...new Set(inCoverage.flatMap((entry) => entry.missing ?? []))].sort(),
      };
    }

    /*
     * Most authoritative first, then freshest. A caller that wants the cheapest
     * or the fastest reorders this itself — see the note on the class.
     */
    const ranked = [...configured].sort(
      (a, b) =>
        CAPABILITY_AUTHORITIES.indexOf(a.authority) - CAPABILITY_AUTHORITIES.indexOf(b.authority) ||
        CAPABILITY_FRESHNESS.indexOf(a.freshness) - CAPABILITY_FRESHNESS.indexOf(b.freshness) ||
        a.provider.localeCompare(b.provider),
    );
    return { capability, available: true, providers: ranked, missing: [] };
  }

  /** Whether an answer to this may be written into a durable artifact. */
  mayPersist(capability: TravelCapability, countryCode?: string): boolean {
    const verdict = this.assess(capability, countryCode);
    if (!verdict.available) return false;
    return verdict.providers[0]?.persistence === 'storable';
  }

  /** Every capability, with its verdict. What the diagnostic prints. */
  report(countryCode?: string): CapabilityVerdict[] {
    return TRAVEL_CAPABILITIES.map((capability) => this.assess(capability, countryCode));
  }
}

function covers(registration: CapabilityRegistration, countryCode?: string): boolean {
  if (registration.coverage === 'global') return true;
  if (countryCode === undefined) return true;
  return registration.coverage.includes(countryCode.toUpperCase());
}
