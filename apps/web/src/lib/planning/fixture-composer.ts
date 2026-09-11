import type { z } from 'zod';
import type { StructuredModel } from '@/lib/providers/interpretation-model';
import type { CompositionContext } from './composition';
import { tripDraftSchema, type AnchorCategory, type DraftAnchor, type DraftDay, type TripDraft } from './trip-draft';

/**
 * THE FIXTURE COMPOSER — A DETERMINISTIC STAND-IN FOR THE FRONTIER MODEL.
 *
 * Exactly the same seam the real model fills (`StructuredModel.structured`),
 * so the whole canonical path — composition, raw-draft persistence,
 * verification, reconciliation, persistence, rendering — runs end to end in
 * the browser suite and the integration tests with zero model calls. Reached
 * only through `SIDEQUEST_COMPOSER_PROVIDER=fixture` (`providers/switches.ts`);
 * a production build never constructs one.
 *
 * It composes the way a capable model would from the same context: a base
 * structure that follows the traveller's stated base count, two to three
 * experiences a day drawn from whatever real names it was hinted (the
 * compiled region's own places, when a trip has one), meal intent, and the
 * full trip package. It also always names one place nothing can verify —
 * "A Quiet Overlook Nobody Documented" — because the product property under
 * test is that such a proposal survives as an honestly-unverified stop rather
 * than vanishing.
 *
 * The draft it returns is validated against the *caller's* schema, so a
 * schema change breaks this double loudly instead of letting it drift.
 */
export interface FixtureComposerHints {
  placeNames: readonly { name: string; category?: string }[];
  baseNames: readonly string[];
  /** Draft `FIXTURE_UNLISTED_VENUE` too — a venue the board does not carry — so a recorded places fixture can answer for it. */
  unlistedVenue?: boolean;
}

export const FIXTURE_UNVERIFIABLE_ANCHOR = 'A Quiet Overlook Nobody Documented';
/** A business venue the board does not carry; only drafted when a recorded places fixture is configured (`unlistedVenue`). */
export const FIXTURE_UNLISTED_VENUE = 'The Old Mill Museum';

function categoryFor(kind: string | undefined): AnchorCategory {
  const text = (kind ?? '').toLowerCase();
  if (text.includes('hike') || text.includes('trail')) return 'hike';
  if (text.includes('lake') || text.includes('river') || text.includes('water')) return 'water';
  if (text.includes('view') || text.includes('vista') || text.includes('peak')) return 'viewpoint';
  if (text.includes('museum') || text.includes('gallery')) return 'museum';
  if (text.includes('hot') || text.includes('geo') || text.includes('volcan')) return 'geothermal';
  if (text.includes('town') || text.includes('village')) return 'town';
  if (text.includes('beach')) return 'beach';
  if (text.includes('park') || text.includes('nature') || text.includes('forest')) return 'nature';
  if (text.includes('food') || text.includes('market')) return 'market';
  return 'landmark';
}

export function fixtureDraftFor(context: CompositionContext, hints: FixtureComposerHints): TripDraft {
  const { envelope, brief } = context;
  const facts = context.planningFacts ?? { carAvailable: true, desiredBaseCount: 1, budgetBand: 'midrange' };
  const nights = brief.tripFacts.nights;
  const dayCount = brief.tripFacts.days;
  const desiredBases = Math.max(1, Math.min(facts.desiredBaseCount, Math.max(1, hints.baseNames.length), Math.max(1, Math.floor(nights / 2)) || 1));
  const baseNames = hints.baseNames.length > 0 ? hints.baseNames.slice(0, desiredBases) : [envelope.name];
  const bases = baseNames.map((name, i) => {
    const share = Math.floor(nights / baseNames.length) + (i < nights % baseNames.length ? 1 : 0);
    return {
      id: `base-${i + 1}`,
      name,
      nights: share,
      why: i === 0 ? `The natural gateway for ${envelope.name}, with the widest choice of lodging.` : `Puts the later days within easy reach instead of a long drive back.`,
      lodgingArea: i === 0 ? 'central, walkable to dinner' : 'near the main road out',
      lodgingStyle: facts.budgetBand === 'budget' ? 'guesthouse or hostel' : 'mid-range hotel or guesthouse',
    };
  });

  // Discovery Board signals shape the draft the way a real composer would use
  // them: what the traveller excluded never appears, what they included leads.
  const avoid = new Set((context.boardSignals?.avoid ?? []).map((n) => n.toLowerCase()));
  const wanted = new Set((context.boardSignals?.mustInclude ?? []).map((n) => n.toLowerCase()));
  const pool = [...hints.placeNames]
    .filter((p) => !avoid.has(p.name.toLowerCase()))
    .sort((a, b) => Number(wanted.has(b.name.toLowerCase())) - Number(wanted.has(a.name.toLowerCase())));
  let poolIndex = 0;
  const nextPlace = (): { name: string; category?: string } | null => (poolIndex < pool.length ? pool[poolIndex++]! : null);
  const generic = ['old quarter walk', 'central market morning', 'riverside promenade', 'sunset lookout', 'local museum', 'harbour stroll'];
  let genericIndex = 0;

  const days: DraftDay[] = [];
  let baseIndex = 0;
  let nightsIntoBase = 0;
  for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
    const relocation = dayNumber > 1 && nightsIntoBase >= (bases[baseIndex]?.nights ?? 0) && baseIndex < bases.length - 1;
    if (relocation) {
      baseIndex += 1;
      nightsIntoBase = 0;
    }
    if (dayNumber <= nights) nightsIntoBase += 1;
    const edge = dayNumber === 1 || dayNumber === dayCount;
    const count = edge ? 2 : 3;
    const anchors: DraftAnchor[] = [];
    for (let i = 0; i < count; i += 1) {
      const place = nextPlace();
      if (place) {
        anchors.push({
          name: place.name,
          category: categoryFor(place.category),
          // A place the traveller marked "include" is core wherever it lands —
          // the composition instruction asks the real model for the same.
          role: wanted.has(place.name.toLowerCase()) ? 'core' : i === 0 ? 'core' : i === 1 ? 'secondary' : 'optional',
          estimatedDurationMinutes: i === 0 ? 120 : 75,
          transport: facts.carAvailable ? 'car' : 'walk',
          why: i === 0 ? `Anchors the day; a strong match for what you said you enjoy.` : `Close to the day's anchor, worth it if the timing works.`,
        });
      } else {
        const label = generic[genericIndex % generic.length]!;
        genericIndex += 1;
        anchors.push({
          name: `${envelope.name} ${label}`,
          category: label.includes('museum') ? 'museum' : label.includes('market') ? 'market' : 'neighbourhood',
          role: i === 0 ? 'core' : 'secondary',
          estimatedDurationMinutes: 90,
          transport: 'walk',
          why: 'A low-effort way to get the feel of the place between bigger days.',
        });
      }
    }
    if (dayNumber === Math.min(3, dayCount) && hints.unlistedVenue) {
      anchors.push({ name: FIXTURE_UNLISTED_VENUE, locality: envelope.name, category: 'museum', role: 'secondary', estimatedDurationMinutes: 90, transport: 'walk', why: 'A small museum locals rate; hours vary, so Sidequest checks them.' });
    }
    if (dayNumber === Math.min(2, dayCount)) {
      anchors.push({
        name: FIXTURE_UNVERIFIABLE_ANCHOR,
        locality: envelope.name,
        category: 'viewpoint',
        // Secondary, not optional: on a full day the optional board stop gives
        // way first, so the unverifiable stop the browser suite looks for stays.
        role: 'secondary',
        estimatedDurationMinutes: 30,
        transport: 'walk',
        why: 'A quiet spot locals mention; worth a look if you pass it.',
      });
    }
    days.push({
      dayNumber,
      baseId: bases[baseIndex]!.id,
      theme: edge ? (dayNumber === 1 ? 'Arrive and settle in' : 'Last morning and departure') : `Day ${dayNumber} around ${bases[baseIndex]!.name}`,
      intensity: edge ? 'light' : dayNumber % 2 === 0 ? 'moderate' : 'intense',
      ...(relocation ? { relocation: true } : {}),
      anchors,
      meals: {
        ...(dayNumber > 1 ? { breakfast: 'at your lodging or a nearby bakery' } : {}),
        lunch: 'something quick near the day’s first stop',
        ...(dayNumber < dayCount ? { dinner: `a local place near ${bases[baseIndex]!.name}` } : {}),
      },
      whyItFits: edge ? 'Kept light so travel days stay easy.' : 'Alternates a bigger outing with an easier one.',
    });
  }

  return tripDraftSchema.parse({
    archetype: bases.length > 1 ? 'moving_route' : 'single_base',
    purpose: `A ${dayCount}-day ${envelope.name} trip built around what you said you enjoy, with easy days between the big ones.`,
    routeRationale: bases.length > 1 ? 'Bases follow the natural direction of travel so no day doubles back.' : 'One base keeps every evening simple and the days flexible.',
    assumptions: ['You have a rough idea of arrival and departure times.', `Prices and opening hours in ${envelope.name} should be checked before you go.`],
    tradeoffs: ['Fewer bases means some longer day trips.'],
    bases,
    days,
    omissions: [{ name: `${envelope.name} far outer district`, reason: 'Too far for this trip length; worth its own visit.' }],
    unresolved: ['Confirm current access and hours for every outdoor stop before you set out.'],
    package: {
      foodStrategy: ['Breakfast at your lodging, a quick lunch near the day’s stops, one relaxed dinner near base each evening.', 'Carry snacks and water on outdoor days.'],
      transport: {
        summary: facts.carAvailable ? 'A hire car, picked up on arrival and returned on the last day.' : 'On foot and by local transport; no car needed.',
        notes: ['Book transport for the first and last day in advance.', 'Allow extra time on relocation days.'],
      },
      beforeYouGo: ['Verify official entry requirements for your nationality.', 'Book your lodging at each base.', 'Check opening hours for any museum or timed attraction.'],
      packing: ['Comfortable walking shoes', 'Layers for changeable weather', 'Rain jacket', 'Refillable water bottle', 'Sunscreen and a hat', 'Phone charger and adapter', 'Travel documents and insurance details'],
      backups: [{ trigger: 'Heavy rain on an outdoor day', alternative: 'Swap in the museum or market day and move the outdoor stops to the next clear morning.' }],
    },
  });
}

export class FixtureComposer implements StructuredModel {
  private calls = 0;
  readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

  constructor(
    private readonly context: CompositionContext,
    private readonly hints: FixtureComposerHints,
    private readonly maxCalls = 1,
  ) {}

  get callsRemaining(): number {
    return Math.max(0, this.maxCalls - this.calls);
  }

  async structured<T>(input: { schema: z.ZodType<T>; normalize?: (raw: unknown) => { value: unknown; normalizedFields: readonly string[] } }): Promise<T> {
    this.calls += 1;
    this.usage.calls += 1;
    /*
     * V8 — two fixture-only behaviours the browser suite needs and no real
     * model has: a composition that fails, and one that takes long enough to
     * reload the build screen while it runs. Keyed on words in the destination
     * the traveller typed, because this class exists only under
     * `SIDEQUEST_COMPOSER_PROVIDER=fixture` and the suite creates its own trips.
     * A real destination never contains either token.
     */
    const name = this.context.envelope.name;
    if (/\bunbuildable\b/i.test(name)) throw new Error('The fixture composer refused this trip, as asked.');
    if (/\bslowbuild\b/i.test(name)) await new Promise((resolve) => setTimeout(resolve, 8_000));
    const draft = fixtureDraftFor(this.context, this.hints);
    const normalized = input.normalize ? input.normalize(draft).value : draft;
    // The seam now receives the wire schema (what the model is asked to emit) with a loose validation
    // schema; the fixture answers in canonical shape, which `normalizeTripDraftWire` accepts as an alias.
    void input.schema;
    return tripDraftSchema.parse(normalized) as unknown as T;
  }
}
