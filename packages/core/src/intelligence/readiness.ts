import { z } from 'zod';
import { languageName, sharesLanguage, type CountryFacts } from '../reference/countries';
import { claim, type SourceClaim } from './claims';

/**
 * COUNTRY READINESS: DOCUMENTS, HEALTH, SAFETY, THE PRACTICAL LAYER.
 *
 * The one rule above all others here: legal and medical facts come from
 * official current sources or they are marked unverified. Sidequest knows the
 * *questions* — passport validity, visa, transit, health documents, driving
 * papers — and knows where the official answers live. It does not answer them
 * from memory.
 */

// ---------------------------------------------------------------------------
// The optional, minimal, private profile
// ---------------------------------------------------------------------------

const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');

export const AGE_CATEGORIES = ['adult', 'senior', 'minor_travelling', 'mixed_with_minors'] as const;
export const ageCategorySchema = z.enum(AGE_CATEGORIES);

/**
 * Only what changes a requirement. No passport number, no scans, no dates of
 * birth. Expiry as a month is enough to say "renew before you go".
 */
export const travelReadinessProfileSchema = z.object({
  citizenship: countryCodeSchema.optional(),
  residence: countryCodeSchema.optional(),
  /** YYYY-MM or YYYY-MM-DD. */
  passportExpiry: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(),
  ageCategory: ageCategorySchema.optional(),
  origin: countryCodeSchema.optional(),
  transitCountries: z.array(countryCodeSchema).max(6).default([]),
  drivingLicenceCountry: countryCodeSchema.optional(),
  updatedAt: z.string().datetime().optional(),
});
export type TravelReadinessProfile = z.infer<typeof travelReadinessProfileSchema>;

// ---------------------------------------------------------------------------
// The official-source registry (fixture-backed; no live calls)
// ---------------------------------------------------------------------------

export const OFFICIAL_SOURCE_KINDS = ['foreign_affairs_advice', 'immigration_authority', 'iata_travel_centre', 'public_health', 'embassy_finder', 'driving_authority', 'park_authority', 'operator', 'tourism_board'] as const;
export type OfficialSourceKind = (typeof OFFICIAL_SOURCE_KINDS)[number];

export const READINESS_COVERAGE_CLASSES = ['full_official_advisory', 'official_entry_links_only', 'generic_official_source', 'unsupported'] as const;
export type ReadinessCoverageClass = (typeof READINESS_COVERAGE_CLASSES)[number];

export const READINESS_COVERAGE_LABELS: Record<ReadinessCoverageClass, string> = {
  full_official_advisory: 'Your government’s own travel advice is linked',
  official_entry_links_only: 'Official entry-requirement links are available; no advisory adapter for your country',
  generic_official_source: 'A generic official entry point (IATA, WHO) is available',
  unsupported: 'No country-specific adapter for your passport country',
};

export interface OfficialSourceEntry {
  kind: OfficialSourceKind;
  name: string;
  url: string;
  /** The date this link was last confirmed to resolve, in fixtures — never a live crawl. */
  verifiedOn?: string;
  /** What the link covers. */
  scope?: 'traveller_country' | 'destination' | 'global';
  /** The traveller country this advice is written for, when it is country-specific. */
  forTravellersFrom?: string;
  /** The destination this source governs, when it is destination-specific. */
  forDestination?: string;
  note?: string;
}

/**
 * Seed entries. Every URL is a government or intergovernmental entry point,
 * stable for years, and is offered as *where to check* — never as the answer.
 * Coverage is honest: traveller-country advice exists for the countries listed
 * and for nobody else; a traveller from elsewhere gets the generic IATA entry.
 */
export const OFFICIAL_SOURCE_SEED: readonly OfficialSourceEntry[] = [
  { kind: 'foreign_affairs_advice', name: 'U.S. Department of State — Travel Advisories', url: 'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html', forTravellersFrom: 'US' },
  { kind: 'foreign_affairs_advice', name: 'UK Foreign, Commonwealth & Development Office — Foreign travel advice', url: 'https://www.gov.uk/foreign-travel-advice', forTravellersFrom: 'GB' },
  { kind: 'foreign_affairs_advice', name: 'Government of Canada — Travel advice and advisories', url: 'https://travel.gc.ca/travelling/advisories', forTravellersFrom: 'CA' },
  { kind: 'foreign_affairs_advice', name: 'Australian Government — Smartraveller', url: 'https://www.smartraveller.gov.au/destinations', forTravellersFrom: 'AU' },
  { kind: 'foreign_affairs_advice', name: 'New Zealand Government — SafeTravel', url: 'https://www.safetravel.govt.nz/destinations', forTravellersFrom: 'NZ' },
  { kind: 'foreign_affairs_advice', name: 'Ireland — Department of Foreign Affairs travel advice', url: 'https://www.ireland.ie/en/dfa/overseas-travel/advice/', forTravellersFrom: 'IE' },
  { kind: 'foreign_affairs_advice', name: 'Auswärtiges Amt — Reise- und Sicherheitshinweise', url: 'https://www.auswaertiges-amt.de/de/ReiseUndSicherheit/reise-und-sicherheitshinweise', forTravellersFrom: 'DE' },
  { kind: 'foreign_affairs_advice', name: 'France Diplomatie — Conseils aux voyageurs', url: 'https://www.diplomatie.gouv.fr/fr/conseils-aux-voyageurs/', forTravellersFrom: 'FR' },
  { kind: 'iata_travel_centre', name: 'IATA Travel Centre — passport, visa and health requirements', url: 'https://www.iatatravelcentre.com/', note: 'Sidequest is not configured with Timatic; use the public checker.' },
  { kind: 'public_health', name: 'CDC Travelers’ Health', url: 'https://wwwnc.cdc.gov/travel', forTravellersFrom: 'US' },
  { kind: 'public_health', name: 'NHS Fit for Travel', url: 'https://www.fitfortravel.nhs.uk/destinations', forTravellersFrom: 'GB' },
  { kind: 'public_health', name: 'World Health Organization — International travel and health', url: 'https://www.who.int/travel-advice' },
  { kind: 'embassy_finder', name: 'Your country’s embassy or consulate (foreign-affairs listing)', url: 'https://www.iatatravelcentre.com/', note: 'The listing lives on your own foreign-affairs site; the IATA page is the neutral entry point.' },
];

export class OfficialTravelSourceRegistry {
  constructor(private readonly entries: readonly OfficialSourceEntry[] = OFFICIAL_SOURCE_SEED.map((e) => ({ verifiedOn: '2026-09-04', scope: e.forTravellersFrom ? 'traveller_country' : e.forDestination ? 'destination' : 'global', ...e }))) {}

  /** How well this deployment covers a traveller of this citizenship. Honest, never global. */
  coverageFor(citizenship: string | undefined): ReadinessCoverageClass {
    if (!citizenship) return 'generic_official_source';
    if (this.foreignAffairsFor(citizenship)) return 'full_official_advisory';
    if (this.entries.some((e) => e.kind === 'public_health' && e.forTravellersFrom === citizenship)) return 'official_entry_links_only';
    return this.entries.some((e) => e.kind === 'iata_travel_centre') ? 'generic_official_source' : 'unsupported';
  }

  /** Every entry, for the doctor and the Verify section. */
  all(): readonly OfficialSourceEntry[] {
    return this.entries;
  }

  /** Advice written for a traveller of this citizenship, or null when uncovered. */
  foreignAffairsFor(citizenship: string | undefined): OfficialSourceEntry | null {
    if (!citizenship) return null;
    return this.entries.find((e) => e.kind === 'foreign_affairs_advice' && e.forTravellersFrom === citizenship) ?? null;
  }

  publicHealthFor(citizenship: string | undefined): OfficialSourceEntry {
    const own = citizenship ? this.entries.find((e) => e.kind === 'public_health' && e.forTravellersFrom === citizenship) : undefined;
    return own ?? this.entries.find((e) => e.kind === 'public_health' && !e.forTravellersFrom)!;
  }

  iata(): OfficialSourceEntry {
    return this.entries.find((e) => e.kind === 'iata_travel_centre')!;
  }

  embassyFinder(): OfficialSourceEntry {
    return this.entries.find((e) => e.kind === 'embassy_finder')!;
  }

  immigrationFor(destinationCountry: string | undefined): OfficialSourceEntry | null {
    if (!destinationCountry) return null;
    return this.entries.find((e) => e.kind === 'immigration_authority' && e.forDestination === destinationCountry) ?? null;
  }

  /** The countries this deployment carries traveller-country advice for. */
  coveredTravellerCountries(): string[] {
    return [...new Set(this.entries.filter((e) => e.kind === 'foreign_affairs_advice' && e.forTravellersFrom).map((e) => e.forTravellersFrom!))].sort();
  }
}

// ---------------------------------------------------------------------------
// The packet
// ---------------------------------------------------------------------------

export const READINESS_ENTRY_KINDS = [
  'passport_validity',
  'visa',
  'transit',
  'health_document',
  'driving_document',
  'minor_documents',
  'advisory',
  'local_law',
  'emergency',
  'insurance',
  'activity_insurance',
  'medication',
  'currency_payment',
  'connectivity',
  'electricity',
  'language',
] as const;
export const readinessEntryKindSchema = z.enum(READINESS_ENTRY_KINDS);
export type ReadinessEntryKind = z.infer<typeof readinessEntryKindSchema>;

export const READINESS_SECTIONS = ['entry_documents', 'safety', 'health_insurance', 'practical'] as const;
export type ReadinessSection = (typeof READINESS_SECTIONS)[number];

export const READINESS_SECTION_OF: Record<ReadinessEntryKind, ReadinessSection> = {
  passport_validity: 'entry_documents',
  visa: 'entry_documents',
  transit: 'entry_documents',
  health_document: 'entry_documents',
  driving_document: 'entry_documents',
  minor_documents: 'entry_documents',
  advisory: 'safety',
  local_law: 'safety',
  emergency: 'safety',
  insurance: 'health_insurance',
  activity_insurance: 'health_insurance',
  medication: 'health_insurance',
  currency_payment: 'practical',
  connectivity: 'practical',
  electricity: 'practical',
  language: 'practical',
};

export const READINESS_SECTION_LABELS: Record<ReadinessSection, string> = {
  entry_documents: 'Entry and documents',
  safety: 'Safety',
  health_insurance: 'Health and insurance',
  practical: 'Practical',
};

export const readinessEntrySchema = z.object({
  kind: readinessEntryKindSchema,
  title: z.string().min(1),
  state: z.enum(['confirmed', 'unverified', 'not_applicable', 'needs_input', 'problem']),
  /** What Sidequest can honestly say. */
  summary: z.string().min(1),
  /** What the traveller should do. */
  action: z.string().min(1).optional(),
  links: z.array(z.object({ name: z.string().min(1), url: z.string().url() })).default([]),
  blocking: z.boolean().default(false),
  /** When in the run-up this belongs. */
  phase: z.enum(['do_now', 'do_before_booking', 'one_month_out', 'one_week_out', 'day_before', 'keep_offline']),
  claimId: z.string().min(1).optional(),
  /**
   * PRODUCT RECOVERY V1 — `primary` entries are the three to seven things this
   * traveller on this trip actually needs to see; `more` is the generic
   * international checklist, kept complete behind "More travel checks".
   */
  tier: z.enum(['primary', 'more']).default('primary'),
  /** Reference facts behind the entry (currency, driving side, emergency number) — bundled reference data, labelled as such. */
  facts: z.array(z.string().min(1)).optional(),
});
export type ReadinessEntry = z.infer<typeof readinessEntrySchema>;

export const tripReadinessPacketSchema = z.object({
  international: z.enum(['yes', 'no', 'unknown']),
  coverage: z.enum(READINESS_COVERAGE_CLASSES).default('generic_official_source'),
  coverageLabel: z.string().min(1).optional(),
  destinationCountry: z.string().optional(),
  profileProvided: z.boolean(),
  coverageNote: z.string().min(1),
  entries: z.array(readinessEntrySchema),
  blockingCount: z.number().int().min(0),
});
export type TripReadinessPacket = z.infer<typeof tripReadinessPacketSchema>;

export interface ReadinessInput {
  destinationCountry?: string;
  destinationName: string;
  tripStart: string;
  tripEnd: string;
  profile?: TravelReadinessProfile | null;
  /** Whether the itinerary involves driving, remote areas, strenuous or water activity. */
  drives: boolean;
  remote: boolean;
  strenuous: boolean;
  water: boolean;
  registry?: OfficialTravelSourceRegistry;
  now: Date;
  /** PRODUCT RECOVERY V1 — bundled reference facts for the destination country (`data/countries.ts`), when known. */
  destinationFacts?: CountryFacts | null;
  /** Reference facts for the traveller's home country, when a citizenship or residence is known. */
  homeFacts?: CountryFacts | null;
  /** Languages the traveller speaks (ISO 639-1), when stated; absent means unknown. */
  travellerLanguages?: readonly string[];
  /** Whether the destination is English-speaking enough that no translation aid is needed by default. */
  daysUntilTrip?: number;
}

function monthsBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso.length === 7 ? `${fromIso}-01` : fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  return (to.getTime() - from.getTime()) / (30.44 * 86_400_000);
}

/**
 * BUILD THE PACKET.
 *
 * Domestic when the destination country is the traveller's citizenship or
 * residence. Unknown when nobody said. Every legal entry is either
 * `not_applicable`, `needs_input`, `unverified` with the official links, or
 * `problem` where arithmetic on the traveller's own statement shows it — a
 * passport that expires before the trip ends. Nothing here is ever `confirmed`
 * on the model's say-so.
 */
export function buildReadinessPacket(input: ReadinessInput): { packet: TripReadinessPacket; claims: SourceClaim[] } {
  const registry = input.registry ?? new OfficialTravelSourceRegistry();
  const profile = input.profile ?? null;
  const citizenship = profile?.citizenship;
  const home = new Set([profile?.citizenship, profile?.residence].filter(Boolean) as string[]);
  const international: TripReadinessPacket['international'] = !input.destinationCountry || home.size === 0 ? 'unknown' : home.has(input.destinationCountry) ? 'no' : 'yes';
  const checkedAt = input.now.toISOString();
  const claims: SourceClaim[] = [];
  const entries: z.input<typeof readinessEntrySchema>[] = [];
  const fa = registry.foreignAffairsFor(citizenship);
  const iata = registry.iata();
  const health = registry.publicHealthFor(citizenship);
  const immigration = registry.immigrationFor(input.destinationCountry);
  const officialLinks = [...(fa ? [{ name: fa.name, url: fa.url }] : []), ...(immigration ? [{ name: immigration.name, url: immigration.url }] : []), { name: iata.name, url: iata.url }];
  // Prose names the destination as the traveller knows it; the code is for matching, not for sentences.
  const country = input.destinationName;

  // Passport validity ---------------------------------------------------------
  if (international === 'no') {
    entries.push({ kind: 'passport_validity', title: 'Passport', state: 'not_applicable', summary: 'A domestic trip on what you told us — no passport check needed, but carry the photo ID your carrier asks for.', links: [], blocking: false, phase: 'day_before' });
  } else if (!profile?.passportExpiry) {
    entries.push({ kind: 'passport_validity', title: 'Passport validity', state: 'needs_input', summary: 'Tell Sidequest the month your passport expires and it will flag a renewal in time. Many countries require validity well beyond your return date; the exact rule is the destination’s.', action: 'Add your passport expiry month.', links: officialLinks, blocking: false, phase: 'do_now' });
  } else {
    const monthsAfterReturn = monthsBetween(input.tripEnd, profile.passportExpiry);
    const expiresBeforeReturn = monthsAfterReturn < 0;
    const id = 'claim:passport-validity';
    claims.push(
      claim({
        id,
        kind: 'passport_validity',
        subject: 'trip',
        claim: expiresBeforeReturn ? `Passport expires before the trip ends (${profile.passportExpiry}).` : `Passport is valid for about ${Math.floor(monthsAfterReturn)} months after the trip ends.`,
        authority: 'traveller_stated',
        sourceName: 'Entered by you',
        state: 'confirmed',
        checkedAt,
        blocking: expiresBeforeReturn,
        notes: ['The number of months a destination requires is its own rule; check the official source.'],
      }),
    );
    entries.push({
      kind: 'passport_validity',
      title: 'Passport validity',
      state: expiresBeforeReturn ? 'problem' : 'unverified',
      summary: expiresBeforeReturn
        ? `Your passport expires ${profile.passportExpiry}, before this trip ends. Renew it before anything else.`
        : `Your passport runs about ${Math.floor(monthsAfterReturn)} months past your return. Many destinations require three or six months; confirm ${country}’s rule at the official source.`,
      action: expiresBeforeReturn ? 'Renew your passport now.' : 'Confirm the validity rule for your destination.',
      links: officialLinks,
      blocking: expiresBeforeReturn,
      phase: 'do_now',
      claimId: id,
    });
  }

  // Visa / entry --------------------------------------------------------------
  if (international === 'no') {
    entries.push({ kind: 'visa', title: 'Visa or entry permission', state: 'not_applicable', summary: 'Not needed for a domestic trip.', links: [], blocking: false, phase: 'do_now' });
  } else if (international === 'unknown') {
    const destinationUnknown = !input.destinationCountry && home.size > 0;
    entries.push({ kind: 'visa', title: 'Visa or entry permission', state: 'needs_input', summary: destinationUnknown ? `Sidequest could not resolve which country ${input.destinationName} is in, so it cannot tell whether this trip crosses a border. Check the official source for your citizenship directly.` : 'Whether you need a visa, an electronic travel authorisation or nothing depends on your citizenship. Sidequest never guesses it.', action: destinationUnknown ? 'Check the entry rule at the official source.' : 'Add your citizenship, or check the official source directly.', links: officialLinks, blocking: false, phase: 'do_now' });
  } else {
    const id = 'claim:entry-visa';
    claims.push(claim({ id, kind: 'entry_visa', subject: country, claim: `Entry requirements for ${country} for a ${citizenship} passport holder have not been independently verified by Sidequest.`, authority: 'model_proposal', sourceName: 'Sidequest', state: 'unverified', checkedAt, blocking: false, notes: ['Only an official current source may confirm entry rules.'] }));
    entries.push({
      kind: 'visa',
      title: 'Visa or entry permission',
      state: 'unverified',
      summary: `Sidequest has not independently verified whether a ${citizenship} passport holder needs a visa or electronic authorisation for ${country}. Rules change; check the official source and note any application lead time.`,
      action: 'Check the entry rule for your citizenship and apply early if one is needed.',
      links: officialLinks,
      blocking: false,
      phase: 'do_now',
      claimId: id,
    });
  }

  // Transit -------------------------------------------------------------------
  if (profile && profile.transitCountries.length > 0) {
    entries.push({ kind: 'transit', title: 'Transit countries', state: 'unverified', summary: `You pass through ${profile.transitCountries.join(', ')}. Airside transit rules differ from entry rules and are not verified by Sidequest.`, action: 'Check transit requirements for each connection.', links: [{ name: iata.name, url: iata.url }], blocking: false, phase: 'do_before_booking', tier: 'more' });
  }

  // Health documents ----------------------------------------------------------
  if (international !== 'no') {
    const id = 'claim:health-document';
    claims.push(claim({ id, kind: 'health_document', subject: country, claim: `Vaccination or health-document requirements for ${country} are not verified by Sidequest.`, authority: 'model_proposal', sourceName: 'Sidequest', state: 'unverified', checkedAt }));
    entries.push({ kind: 'health_document', title: 'Vaccinations and health documents', state: 'unverified', summary: `Some destinations require proof of vaccination or health declarations. Sidequest has not verified ${country}’s requirements.`, action: 'Check the official travel-health source for your destination, ideally six weeks before you go.', links: [{ name: health.name, url: health.url }], blocking: false, phase: 'one_month_out', claimId: id, tier: 'more' });
  }

  // Driving documents ---------------------------------------------------------
  if (input.drives) {
    const licence = profile?.drivingLicenceCountry;
    const domesticLicence = licence && input.destinationCountry && licence === input.destinationCountry;
    const facts = input.destinationFacts ?? null;
    const home = input.homeFacts ?? null;
    const sideDiffers = facts && home ? facts.drivingSide !== home.drivingSide : null;
    const sideFact = facts ? `Traffic drives on the ${facts.drivingSide} in ${country}${sideDiffers === true ? ` — the opposite side from ${home!.name}` : sideDiffers === false ? ', the same side as at home' : ''}.` : null;
    entries.push({
      kind: 'driving_document',
      title: 'Driving',
      state: domesticLicence ? 'not_applicable' : international === 'no' ? 'not_applicable' : 'unverified',
      summary: domesticLicence || international === 'no'
        ? 'Your own licence covers driving here. Carry it, plus the rental agreement.'
        : `Whether ${country} accepts your licence alone or requires an International Driving Permit is not verified by Sidequest. Rental desks set their own minimum age and licence-age rules, and the excess (deductible) on the rental is worth deciding before you book.${sideFact ? ` ${sideFact}` : ''}`,
      action: domesticLicence || international === 'no' ? undefined : 'Confirm licence and IDP rules; decide the rental excess cover.',
      links: fa ? [{ name: fa.name, url: fa.url }] : [{ name: iata.name, url: iata.url }],
      blocking: false,
      phase: 'do_before_booking',
      tier: 'primary',
      ...(sideFact ? { facts: [sideFact] } : {}),
    });
  }

  // Minors --------------------------------------------------------------------
  if (profile?.ageCategory === 'minor_travelling' || profile?.ageCategory === 'mixed_with_minors') {
    entries.push({ kind: 'minor_documents', title: 'Travelling with minors', state: 'unverified', summary: 'Some borders ask for consent letters or birth certificates when a child travels without both parents. Sidequest has not verified the rule for this route.', action: 'Check the destination and airline rules for children’s documents.', links: officialLinks, blocking: false, phase: 'do_before_booking' });
  }

  // Safety --------------------------------------------------------------------
  if (international !== 'no') {
    entries.push({
      kind: 'advisory',
      title: 'Official travel advisory',
      state: 'unverified',
      summary: fa ? `Read your government’s current advice for ${country} before you commit. Sidequest shows the source rather than summarising it, because advisories change.` : `Sidequest doesn’t yet have a country-specific advisory adapter for your passport country${citizenship ? ` (${citizenship})` : ''}. Verify entry requirements through your government’s official foreign-travel service and the destination’s immigration authority; the IATA and WHO entry points apply everywhere.`,
      action: 'Read the current advisory.',
      links: fa ? [{ name: fa.name, url: fa.url }] : [{ name: iata.name, url: iata.url }],
      blocking: false,
      phase: 'do_now',
      tier: 'more',
    });
    entries.push({ kind: 'local_law', title: 'Local laws and customs', state: 'unverified', summary: 'Rules that surprise visitors — drones, medication, dress, photography, alcohol — are listed in the official advice for the destination.', links: fa ? [{ name: fa.name, url: fa.url }] : [], blocking: false, phase: 'one_week_out', tier: 'more' });
  }
  {
    const facts = input.destinationFacts ?? null;
    const number = facts ? `${facts.emergency}${facts.emergencyNotes ? ` (${facts.emergencyNotes})` : ''}` : null;
    entries.push({
      kind: 'emergency',
      title: 'Emergency',
      state: facts ? 'confirmed' : 'unverified',
      summary: number
        ? `Emergency number in ${country}: ${number}. Save it with the address of where you sleep each night${international === 'no' ? '.' : ', and the nearest consulate for your country.'}`
        : international === 'no'
          ? 'Save the local emergency number and the address of where you are sleeping each night.'
          : `Save the local emergency number for ${country} and the nearest consulate for your country. Sidequest has not resolved the consulate address for this trip.`,
      action: 'Save these on your phone and on paper.',
      links: international === 'no' ? [] : [{ name: registry.embassyFinder().name, url: registry.embassyFinder().url }],
      blocking: false,
      phase: 'keep_offline',
      tier: 'primary',
      ...(number ? { facts: [`Emergency number ${number} (reference data).`] } : {}),
    });
  }

  // Health / insurance ----------------------------------------------------------
  entries.push({ kind: 'insurance', title: 'Travel medical insurance', state: 'unverified', summary: international === 'no' ? 'Check whether your usual cover applies away from home, especially for outdoor activity and cancellations.' : 'Your home health cover rarely applies abroad. Arrange travel medical insurance that covers cancellation, medical evacuation and the activities on this plan.', action: 'Arrange or confirm cover.', links: [], blocking: false, phase: 'one_month_out', tier: international === 'yes' ? 'primary' : 'more' });
  if (input.strenuous || input.water || input.remote) {
    entries.push({ kind: 'activity_insurance', title: 'Activity cover', state: 'unverified', summary: `This plan includes ${[input.strenuous ? 'strenuous hiking' : null, input.water ? 'water activity' : null, input.remote ? 'remote areas' : null].filter(Boolean).join(', ')}. Many policies exclude these unless added.`, action: 'Check the activity exclusions on your policy.', links: [], blocking: false, phase: 'one_month_out', tier: 'more' });
  }
  entries.push({ kind: 'medication', title: 'Medicines', state: 'unverified', summary: 'Bring any prescription medicines you need in their original packaging, with enough for delays, and verify destination restrictions on controlled substances. Sidequest never infers what you take.', links: [{ name: health.name, url: health.url }], blocking: false, phase: 'one_week_out', tier: 'more' });

  // Practical -------------------------------------------------------------------
  {
    const facts = input.destinationFacts ?? null;
    const home = input.homeFacts ?? null;
    const sameCurrency = facts && home ? facts.currency === home.currency : null;
    entries.push({
      kind: 'currency_payment',
      title: 'Money',
      state: facts ? 'confirmed' : 'unverified',
      summary: international === 'no'
        ? 'Your usual cards work. Carry some cash for places that do not take them.'
        : facts
          ? `${country} uses the ${facts.currency}${sameCurrency === true ? ', the same as at home' : ''}. Tell your bank you are travelling, and carry some ${facts.currency} cash for small places and rural stops.`
          : 'Confirm card acceptance and ATM availability for your destination, tell your bank you are travelling, and carry some local cash for small places.',
      links: [],
      blocking: false,
      phase: 'one_week_out',
      tier: international === 'no' || sameCurrency === true ? 'more' : 'primary',
      ...(facts ? { facts: [`Currency ${facts.currency} (reference data).`] } : {}),
    });
    entries.push({ kind: 'connectivity', title: 'Staying connected', state: 'unverified', summary: input.remote ? 'Parts of this plan are remote. Download offline maps and the plan itself; do not rely on a signal.' : international === 'no' ? 'Download offline maps for the areas you will be in.' : 'Decide between roaming, a local SIM or an eSIM before you land, and download offline maps.', links: [], blocking: false, phase: 'one_week_out', tier: input.remote ? 'primary' : 'more' });
    if (international !== 'no') {
      const plugDiffers = facts && home ? !facts.plugs.some((p) => home.plugs.includes(p)) || Math.abs(facts.voltage - home.voltage) > 30 : null;
      entries.push({
        kind: 'electricity',
        title: 'Plugs and voltage',
        state: facts ? 'confirmed' : 'unverified',
        summary: facts ? `${country} uses type ${facts.plugs.join('/')} sockets at ${facts.voltage} V${plugDiffers === true ? ` — different from ${home!.name}; bring an adapter${Math.abs(facts.voltage - home!.voltage) > 30 ? ' and check your chargers accept the voltage' : ''}.` : plugDiffers === false ? '; your plugs fit.' : '.'}` : 'Check the plug type and voltage for your destination.',
        links: [],
        blocking: false,
        phase: 'day_before',
        tier: plugDiffers === true ? 'primary' : 'more',
        ...(facts ? { facts: [`Plugs ${facts.plugs.join('/')}, ${facts.voltage} V (reference data).`] } : {}),
      });
      const shared = sharesLanguage(facts, input.travellerLanguages ?? (home ? home.languages : undefined));
      const englishSpoken = facts?.languages.includes('en') ?? false;
      entries.push({
        kind: 'language',
        title: 'Language',
        state: facts ? 'confirmed' : 'unverified',
        summary: facts
          ? shared === true || (englishSpoken && shared === null)
            ? `${facts.languages.map(languageName).join(' and ')} ${facts.languages.length === 1 ? 'is' : 'are'} spoken in ${country}; you will get by without a translation aid.`
            : `${facts.languages.map(languageName).join(' and ')} ${facts.languages.length === 1 ? 'is' : 'are'} spoken in ${country}. Download an offline translation pack for ${languageName(facts.languages[0]!)} if it is not one you speak.`
          : 'Download an offline translation pack for the local language if it is not one you speak.',
        links: [],
        blocking: false,
        phase: 'day_before',
        tier: facts && (shared === true || (englishSpoken && shared === null)) ? 'more' : 'primary',
        ...(facts ? { facts: [`Languages ${facts.languages.map(languageName).join(', ')} (reference data).`] } : {}),
      });
    }
  }

  const coverage = registry.coverageFor(citizenship);
  const packet: TripReadinessPacket = {
    international,
    coverage,
    coverageLabel: READINESS_COVERAGE_LABELS[coverage],
    ...(input.destinationCountry ? { destinationCountry: input.destinationCountry } : {}),
    profileProvided: profile !== null,
    coverageNote: `Traveller-country advisories are carried for ${registry.coveredTravellerCountries().join(', ')}. Destination immigration authorities are not resolved automatically; the IATA checker is the neutral entry point. Nothing legal or medical here is confirmed by Sidequest.`,
    entries: entries.map((e) => readinessEntrySchema.parse(e)),
    blockingCount: entries.filter((e) => e.blocking).length,
  };
  return { packet: tripReadinessPacketSchema.parse(packet), claims };
}
