import 'server-only';
import { loadTripIntelligence } from '@/lib/intelligence/load';
import { renderInstant } from '@/lib/clock';
import { providerRegistry } from '@/lib/providers/registry';
import { buildRecheckManifest, buildTodayView, type RecheckManifest, type TodayView } from '@sidequest/core';
import { buildLedger, buildNextActions, buildPreflight, buildTripStateGraph, deriveDecisions, readLifecycle, summariseObservations, volatileFacts, type BookingResolution, type FactObservation, type NextActions, type Preflight, type TripDecision, type TripLedger, type TripLifecycle, type TripStateGraph, type VolatileFact } from '@sidequest/core';
import { listDecisions, listObservations, listPendingImports, type BookingImport } from '@/lib/db/execution-repository';
import { destinationTimeZone } from '@/lib/execution/destination-zone';
import { lastRecheckAt } from '@/lib/execution/recheck-status';
import { partyFactsFor } from '@/lib/db/party-repository';
import type { BookedAffectedScope } from '@/lib/intelligence/booked-reconcile';
import type { CheckList } from '@/lib/db/intelligence-repository';
import type { BookedPlanItem, TravelIntelligence, TravelReadinessProfile } from '@sidequest/core';
import type { StopRationale } from '@/components/ItineraryView';
import { acceptedImagesFor } from '@/lib/db/imagery-repository';
import { arePlacePhotosEnabled } from '@/lib/providers/switches';
import { formatMinutes } from '@/lib/format';
import { getProfile } from '@/lib/db/repository';
import { getTripDraft } from '@/lib/db/draft-repository';
import { boardFor, resolveTripRegion } from '@/lib/region';
import {
  REACH_MODE_PHRASE,
  displayNameOf,
  findOperatingCalendar,
  buildPreparation,
  licence,
  tripPersonality,
  type DestinationImage as DestinationImageRecord,
  type DiscoveryCandidate,
  type DisplayName,
  type Itinerary,
  type PreparationItem,
  type Trip,
} from '@sidequest/core';

/**
 * EVERYTHING THE FINISHED PLAN'S DOCUMENT DERIVES AT RENDER TIME, IN ONE PLACE.
 *
 * Two pages render the same document now — the owner's itinerary page and the
 * shared, read-only copy at /share/<token> — and a derivation that lived in one
 * of them would quietly drift out of the other: a share link whose plan lacks
 * the photographs, the per-stop reasons or the ODbL notice is a different
 * product wearing the same name. So the assembly moved here wholesale, comments
 * and all, and both pages call it.
 *
 * Everything here is *derived, never stored*. A stored plan is immutable;
 * re-deriving at render time is what ties each sentence to the evidence the
 * plan was built from rather than to whatever the region looks like today. And
 * none of it is load-bearing: a region that will not resolve produces an empty
 * model, which is the honest outcome and never a reason to withhold the
 * itinerary.
 */
export interface ItineraryViewModel {
  /** The canonical itinerary with the traveller's booked facts applied. Render this one. */
  appliedItinerary: Itinerary;
  intelligence: TravelIntelligence;
  /** LIVE WORLD V1 — the trip as it stands at the render instant; inactive outside the trip's dates. */
  today: TodayView;
  /** LIVE WORLD V1 — what to re-check, and when, before departure. */
  recheck: RecheckManifest;
  booked: BookedPlanItem[];
  bookedHonored: string[];
  bookedConflicts: string[];
  checks: Record<CheckList, string[]>;
  readinessProfile: TravelReadinessProfile | null;
  preparation: PreparationItem[];
  baseNames?: DisplayName;
  timeZone?: string;
  attributions: readonly string[];
  coordinates: Record<string, { lat: number; lng: number }>;
  worthSkipping: { name: string; reason: string }[];
  lodgingAreas: { name: string; rationale: string; tradeoffs: readonly string[] }[];
  images: Record<string, DestinationImageRecord>;
  /**
   * MVP V3 — where a request-time photograph can be fetched for a stop, by place
   * id. Empty unless `SIDEQUEST_PLACE_PHOTOS=google` is configured. The value is
   * a URL on this origin: the credential stays on the server and nothing is
   * stored. See `app/api/place-photo/route.ts`.
   */
  livePhotos: Record<string, string>;
  rationale: Record<string, StopRationale>;
  /** The trip in one sentence, from the traveller's profile; null without one. */
  personality: string | null;
  /**
   * V9 — THE EXECUTION LAYER, DERIVED ONCE HERE FOR EVERY SURFACE.
   *
   * The state graph is the one vocabulary; next actions, Preflight, the
   * decisions, the ledger and the freshness list are read off it and off the
   * same intelligence snapshot. Nothing here is stored and nothing here calls
   * a provider or a model.
   */
  lifecycle: TripLifecycle;
  daysUntilTrip: number;
  decisions: TripDecision[];
  graph: TripStateGraph;
  nextActions: NextActions;
  preflight: Preflight;
  ledger: TripLedger;
  resolutions: BookingResolution[];
  observations: FactObservation[];
  changedHeadline: string | null;
  volatile: VolatileFact[];
  affected: BookedAffectedScope;
  /** Confirmations pasted or uploaded and not yet confirmed or discarded. Never on the shared copy. */
  pendingImports: BookingImport[];
  /** V9 §9 — when the last recheck ran, for the freshness banner; null when none has. */
  lastCheckedAt: string | null;
  /** V9 §17 — the party has a recorded difference, so a split may be suggested. */
  partyDifferences: boolean;
}

export async function itineraryViewModel(
  trip: Trip,
  itinerary: Itinerary,
): Promise<ItineraryViewModel> {
  /**
   * The preparation list, derived on the server from the plan that is on screen.
   *
   * Resolving the region again is cheap — it reads the stored artifact — and it
   * is what ties a checklist to the exact evidence the plan was built from
   * rather than to whatever the region looks like today. A region that will not
   * resolve simply produces no checklist, which is the honest outcome and never
   * a reason to withhold the itinerary.
   *
   * "Cheap" is now true. It was not: `resolveTripRegion` fetched a forecast, so
   * opening a *finished, stored* itinerary made an outbound weather request and
   * a page that exists to show somebody a plan they already have depended on a
   * provider being up. Weather is read from the persisted snapshot now, and the
   * two properties that matter here follow from that:
   *
   *   - a stale or absent snapshot changes nothing on this page. The plan on
   *     screen is the plan that was built and stored; a newer forecast is a
   *     reason to look again, never a licence to edit somebody's trip while they
   *     are reading it.
   *   - refreshing the browser starts no provider work at all.
   */
  let preparation: PreparationItem[] = [];
  /*
   * The base's resolved name, read from the compiled region rather than stored
   * on the itinerary. A stored plan is immutable; migrating one to change how a
   * heading reads would be rewriting somebody's trip to fix a presentation bug.
   * An old region with no resolved name leaves this undefined and the view falls
   * back to the itinerary's own `baseName`, exactly as before.
   */
  let baseNames: DisplayName | undefined;
  /**
   * The zone this trip's wall clock runs on, read from the base it was compiled
   * for. Absent for an artifact compiled before bases carried one, and the view
   * says UTC rather than inventing a plausible-looking local hour.
   */
  let timeZone: string | undefined;
  let countryCode: string | undefined;
  /**
   * ODbL attribution for the place data this plan is made of.
   *
   * The board and the plan-detail screen have carried this since the backbone
   * landed; the itinerary — the product's primary output, and the one page a
   * traveller prints and takes with them — did not. `docs/osm-database-boundary.md`
   * names it explicitly, "including any exported form", so this is the
   * prerequisite for the print path rather than a nicety beside it.
   *
   * Rendered from the artifact's own `DataLicence.attribution` strings. A
   * component that writes its own wording has stopped complying.
   */
  let attributions: readonly string[] = [];
  /**
   * Where each scheduled place is, so a day can be handed to a map app.
   *
   * Coordinates live on the compiled region, not on the stored plan — a plan
   * records what to do and when, and duplicating geometry into it would be a
   * second copy to keep true. Read here, on the server, from the region the plan
   * was built against.
   */
  const coordinates = new Map<string, { lat: number; lng: number }>();
  /**
   * The board's "probably skip" supply, for the packet's Worth Skipping
   * section (§17). Derived from the same compiled region the plan drew on, so
   * a skip is a claim about *this* trip's fit model, never a generic list.
   * Empty whenever the board holds none — the section then does not render.
   */
  let worthSkipping: { name: string; reason: string }[] = [];
  /**
   * Lodging-area guidance renders only where the compiled region actually
   * holds lodging evidence (§17: "budget/lodging where evidence supports
   * it"). `lodgingEvidence` defaults to `unknown` and the honest treatment of
   * unknown is omission — a base is a geographic recommendation, and claiming
   * a town has places to stay because it is a town is the unsourced
   * confidence the schema exists to prevent.
   */
  let lodgingAreas: { name: string; rationale: string; tradeoffs: readonly string[] }[] = [];
  /**
   * WHAT THE FIT MODEL SAID ABOUT EACH SCHEDULED STOP.
   *
   * The stored plan's per-stop reason is a template — `Matches your interest in
   * X` — so a finished itinerary reads as eleven copies of one sentence, which
   * is the product's stated differentiator rendered as boilerplate. The fit
   * model computed a specific sentence for every one of these places on the
   * board the traveller chose from, and this re-reads it from the same compiled
   * region the plan was built against.
   *
   * Derived, never stored: a stored plan is immutable, and re-deriving here is
   * what ties the sentence to the evidence rather than to whatever the region
   * looked like on the day the plan was built. Empty whenever the region will
   * not resolve, and the view then renders exactly what it rendered before.
   */
  const rationale: Record<string, StopRationale> = {};
  /**
   * Photographs for the day headers, read out of the local table.
   *
   * A row lookup, never a resolution — the identities were established while the
   * traveller was on the board, and a page that could resolve one would do it
   * per stop, per day, per refresh, for every visitor.
   */
  let images: Record<string, DestinationImageRecord> = {};
  /*
   * Only stops the plan actually resolved to a Google place, and only when the
   * switch is on. A stop resolved by the geocoder or from compiled evidence has
   * no Places id and gets no live photograph — which is correct: there is
   * nothing to ask for.
   */
  const livePhotos: Record<string, string> = {};
  if (arePlacePhotosEnabled()) {
    for (const anchor of itinerary.package?.anchors ?? []) {
      if (!anchor.placeId || anchor.identity?.provider !== 'google-places' || !anchor.identity.providerRef) continue;
      livePhotos[anchor.placeId] = `/api/place-photo?trip=${encodeURIComponent(trip.id)}&anchor=${encodeURIComponent(anchor.id)}`;
    }
  }
  /*
   * PRODUCTION LOCK V5 §28 — THE TRIP'S THESIS COMES FROM THE TRIP.
   *
   * `tripPersonality` derives a sentence from the *profile* alone, and a live
   * Hong Kong build showed what that costs: the traveller had said food,
   * markets and neighbourhoods are the heart of the trip and their days should
   * be intense, the model wrote "A food, market and neighbourhood-led Hong Kong
   * immersion … built around eating, wandering and a few iconic views", and the
   * Overview said:
   *
   *   "Food & towns-led, a mix of famous and quiet, balanced pace over 6 days."
   *
   * Generic in its shape, and wrong about the pace. The draft's own `purpose` is
   * a sentence about *this* trip, written by the thing that designed it, so it
   * leads. The derived headline stays as the fallback for a trip whose draft
   * predates the field or could not be read — never as the first choice.
   */
  let personality: string | null = null;
  try {
    personality = getTripDraft(trip.id)?.draft.purpose?.trim() || null;
  } catch {
    /* An unreadable draft row falls through to the derived headline below. */
  }
  if (!personality) {
    try {
      const profile = getProfile(trip.id);
      if (profile) personality = tripPersonality(profile, itinerary.days.length).headline;
    } catch {
      /* No profile, or an unreadable one: the trip simply has no thesis line. */
    }
  }
  try {
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) {
      lodgingAreas = resolved.context.compiled.bases
        .filter((entry) => entry.lodgingEvidence === 'sourced')
        .map((entry) => ({
          name: entry.names?.display ?? itinerary.baseName,
          rationale: entry.rationale,
          tradeoffs: entry.tradeoffs ?? [],
        }));
      const profile = getProfile(trip.id);
      if (profile) {
        try {
          const board = boardFor(trip, profile, resolved.context);
          /*
           * THE SECTION'S HEADING IS A FIT CLAIM, SO ONLY FIT REASONS GO IN IT.
           *
           * This read `fit.cautions[0]`, and the fit cautions are an hours,
           * season, road and parking list — never a verdict about the match. On
           * a compiled board almost every place carries "We could not confirm
           * its opening hours" as its first caution, so the packet's *Worth
           * skipping* section — headed "Popular or nearby, and still a poor
           * match for how you said you travel" — printed a row of sentences
           * saying we had not checked something, under a heading saying we had
           * weighed it and rejected it.
           *
           * `quality.reason` is the sentence written for this slot ("one
           * sentence a person could argue with"), and `reasonBasis` says which
           * of the three claims it makes. Only the fit judgements are rendered;
           * a card refused over an evidence gap belongs under the board's
           * verification heading and is left out here rather than relabelled.
           * An empty list renders no section at all, which is the correct
           * "say less".
           */
          worthSkipping = (board.groups.find((group) => group.group === 'weak_fit')?.candidates ?? [])
            .filter((candidate) => candidate.quality.reasonBasis === 'fit_judgement')
            .slice(0, 6)
            .map((candidate) => ({
              name: displayNameOf(candidate.place),
              reason: candidate.quality.reason,
            }));

          /*
           * One sentence per stop, and never the same sentence twice in a row.
           *
           * The fit model's reasons are ranked, so the obvious read — always
           * take `reasons[0]` — reproduces the defect it is meant to fix
           * whenever several stops fit for the same reason, which on a themed
           * day is most of them. Taking the first reason nothing has used yet
           * makes the plan say something different about each place while every
           * sentence stays one the model actually computed about *that* place.
           */
          const used = new Set<string>();
          for (const [placeId, entry] of Object.entries(
            stopRationaleFor(board.candidates, used),
          )) {
            rationale[placeId] = entry;
          }
        } catch (error) {
          console.error('Worth-skipping supply could not be derived', error);
        }
      }
      const base = resolved.context.compiled.bases.find((entry) => entry.id === itinerary.baseId);
      baseNames = base?.names;
      timeZone = base?.timeZone;
      countryCode = resolved.context.compiled.scope.countryCode;
      attributions = resolved.context.compiled.sourceManifest.attributions ?? [];
      for (const place of resolved.context.compiled.places) {
        coordinates.set(place.id, {
          lat: place.coordinates.lat,
          lng: place.coordinates.lng,
        });
      }
      for (const entry of resolved.context.compiled.bases) {
        coordinates.set(entry.id, {
          lat: entry.coordinates.lat,
          lng: entry.coordinates.lng,
        });
      }
      const scheduled = new Set<string>();
      const namesById = new Map<string, string>();
      const unverifiedHours: string[] = [];

      for (const place of resolved.context.places) namesById.set(place.id, displayNameOf(place));
      for (const venue of resolved.context.food?.venues ?? []) namesById.set(venue.id, displayNameOf(venue));

      for (const day of itinerary.days) {
        for (const item of day.items) {
          if (item.placeId) scheduled.add(item.placeId);
          if (item.food?.venueId) scheduled.add(item.food.venueId);
        }
      }
      for (const subjectId of scheduled) {
        const calendar = findOperatingCalendar(resolved.context.hours, subjectId);
        if (calendar?.kind === 'unknown') unverifiedHours.push(subjectId);
      }

      preparation = buildPreparation({
        evidence: resolved.context.compiled.evidence,
        scheduledSubjectIds: [...scheduled],
        namesById,
        unverifiedHoursSubjectIds: unverifiedHours,
      });

      /*
       * The subjects are the *scheduled* places only. Reading the whole region
       * would be a query proportional to the destination on a page that shows
       * one plan, and the Wikidata id is what turns the lookup into an identity
       * relationship rather than a name search — a record without one has no row
       * to find and gets no photograph, which is the honest outcome.
       */
      images = acceptedImagesFor(
        resolved.context.compiled.places
          .filter((place) => scheduled.has(place.id) && place.wikidataId !== undefined)
          .map((place) => ({
            kind: 'candidate' as const,
            id: place.id,
            ...(place.wikidataId ? { wikidataId: place.wikidataId } : {}),
          })),
      );
    }
  } catch (error) {
    console.error('Preparation list could not be derived', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * The licence notice does not depend on the region resolving.
   *
   * `attributions` stays empty when `resolveTripRegion` fails or throws, and the
   * view renders the paragraph only when it is non-empty — so a plan built from
   * OpenStreetMap-derived places would render, and print, with no ODbL notice on
   * it. The obligation follows the data, not the success of a lookup we happen to
   * be doing for a checklist, so a plan that reached this page falls back to the
   * required attribution rather than to silence.
   *
   * Read off the licence record, never written here. A component that
   * paraphrases the required text has stopped complying, which is why
   * `docs/osm-database-boundary.md` insists the string come from
   * `DataLicence.attribution` — and why this is a lookup rather than a literal.
   */
  if (attributions.length === 0) {
    attributions = [licence('ODbL-1.0').attribution];
  }

  /* V9 — a trip with no compiled base zone still has a destination zone; Today and the calendar must not fall to UTC. */
  if (!timeZone) timeZone = destinationTimeZone(trip.id);
  const now = new Date(renderInstant());
  const loaded = loadTripIntelligence({ trip, itinerary, ...(timeZone ? { timeZone } : {}), ...(countryCode ? { countryCode } : {}), sourcedAreas: lodgingAreas, worthSkipping, now });
  /*
   * LIVE WORLD V1 — Today mode and the recheck manifest are derived here, on
   * the server, from the same instant every day on the page judges itself
   * against. Pure functions of persisted state: no provider is asked.
   */
  const intel = loaded.intelligence;
  const today = buildTodayView({ itinerary: loaded.itinerary, booked: loaded.booked, backups: intel.backups, now, ...(timeZone ? { timeZone } : {}), warnings: intel.unresolvedCriticals });
  const registry = providerRegistry();
  // Days until departure at this render, not at the cached snapshot's build time.
  const daysUntilTrip = Math.round((Date.parse(`${trip.basics.startDate}T00:00:00Z`) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
  const recheck = buildRecheckManifest({
    claims: intel.sourceRegistry,
    daysUntilTrip,
    tripDays: intel.destinationContext.tripDays,
    drives: intel.destinationContext.drives,
    hasFlights: intel.transport.legs.some((l) => l.mode === 'flight') || loaded.booked.some((b) => b.type === 'flight'),
    hasFerries: intel.transport.legs.some((l) => l.mode === 'ferry') || loaded.booked.some((b) => b.type === 'ferry'),
    capabilities: { forecast: registry.byId['weather.forecast']?.available ?? false, traffic: registry.byId['routing.traffic']?.available ?? false, hours: registry.byId['places.hours']?.available ?? false, transit: registry.byId['routing.transit']?.available ?? false },
  });

  /*
   * V7 §14 — A TRIP WITH NO COMPILED REGION STILL HAS A MAP.
   *
   * Every stop the reconciler placed carries its resolved position on
   * `package.anchors[].identity`, and every base it geocoded carries its own
   * `coordinates`. The map used to read the compiled region alone, so the two
   * live V7 builds — both regionless — said "no stop has a confirmed position"
   * over thirteen positioned stops. The compiled region still wins where it
   * exists; the plan's own identities fill what it does not cover.
   */
  for (const anchor of itinerary.package?.anchors ?? []) {
    if (anchor.placeId && anchor.identity?.coordinates && !coordinates.has(anchor.placeId)) coordinates.set(anchor.placeId, { lat: anchor.identity.coordinates.lat, lng: anchor.identity.coordinates.lng });
  }
  for (const base of itinerary.package?.bases ?? []) {
    if (base.coordinates && !coordinates.has(base.id)) coordinates.set(base.id, { lat: base.coordinates.lat, lng: base.coordinates.lng });
    if (base.placeId && base.coordinates && !coordinates.has(base.placeId)) coordinates.set(base.placeId, { lat: base.coordinates.lat, lng: base.coordinates.lng });
  }
  /* V9 — the execution layer. Persisted acts (decisions, resolutions, observations) plus derivation. */
  const persistedDecisions = listDecisions(trip.id);
  const observations = listObservations(trip.id);
  const decisions = deriveDecisions({ itinerary: loaded.itinerary, intelligence: intel, persisted: persistedDecisions, travellerFacts: personality ? [personality] : [] });
  const graph = buildTripStateGraph({ itinerary: loaded.itinerary, intelligence: intel, booked: loaded.booked, decisions, resolutions: loaded.resolutions, observations, recheck, now });
  const lifecycle = readLifecycle({ trip, itineraryStatus: loaded.itinerary.status, bookedTypes: loaded.booked.filter((b) => b.status === 'booked').map((b) => b.type), hasProfile: getProfile(trip.id) !== null, now }).lifecycle;
  const nextActions = buildNextActions({ graph, lifecycle, daysUntilTrip, now, today });
  const preflight = buildPreflight({ graph, intelligence: intel, booked: loaded.booked, checks: loaded.checks, daysUntilTrip });
  const ledger = buildLedger({ budget: intel.budget, booked: loaded.booked, openNeeds: intel.bookings.items.filter((b) => b.status === 'open' && !b.memberIds) });
  const volatile = volatileFacts({ itinerary: loaded.itinerary, intelligence: intel, booked: loaded.booked, now, capabilities: { forecast: registry.byId['weather.forecast']?.available ?? false, hours: registry.byId['places.hours']?.available ?? false, transit: registry.byId['routing.transit']?.available ?? false } });
  const changedHeadline = summariseObservations(observations).headline;
  let partyDifferences = false;
  try {
    partyDifferences = partyFactsFor(trip.id)?.differences ?? false;
  } catch {
    /* No party rows, or an unreadable one: no split is suggested. */
  }

  return {
    appliedItinerary: loaded.itinerary,
    intelligence: loaded.intelligence,
    today,
    recheck,
    lifecycle,
    daysUntilTrip,
    decisions,
    graph,
    nextActions,
    preflight,
    ledger,
    resolutions: loaded.resolutions,
    observations,
    changedHeadline,
    volatile,
    affected: loaded.affected,
    pendingImports: listPendingImports(trip.id),
    lastCheckedAt: lastRecheckAt(trip.id),
    partyDifferences,
    booked: loaded.booked,
    bookedHonored: loaded.honored,
    bookedConflicts: loaded.conflicts,
    checks: loaded.checks,
    readinessProfile: loaded.readinessProfile,
    preparation,
    baseNames,
    timeZone,
    attributions,
    coordinates: Object.fromEntries(coordinates),
    worthSkipping,
    lodgingAreas,
    images,
    livePhotos,
    rationale,
    personality,
  };
}

/**
 * THE PER-STOP BLOCK EVERY STOP CARD READS, COMPOSED ONCE.
 *
 * Extracted from the body of `itineraryViewModel` so the rendered page can be
 * driven in a test with the same blocks a traveller gets. It was inline, and
 * the page's own catch-all — the one that refuses any sentence billing an
 * unpriceable journey to somebody's feet — was therefore blind to a whole
 * surface: a delivered itinerary printed "57 min on foot from your base" in a
 * stop's facets, between the two sentences that had just qualified the same
 * figure as an unverified journey.
 *
 * `used` is the board's own no-two-cards-say-the-same-thing set, threaded
 * rather than recreated so the page and the board stay in step.
 */
export function stopRationaleFor(
  candidates: readonly DiscoveryCandidate[],
  used: Set<string> = new Set(),
): Record<string, StopRationale> {
  const rationale: Record<string, StopRationale> = {};
  for (const candidate of candidates) {
    const why = candidate.fit.reasons.find((reason) => !used.has(reason)) ?? candidate.fit.reasons[0];
    if (why) used.add(why);
    rationale[candidate.place.id] = {
      /*
       * The name the board showed, so the plan and the board agree on what a
       * place is called. See `StopRationale.name`.
       */
      name: displayNameOf(candidate.place),
      ...(why ? { why } : {}),
      category: candidate.place.category,
      facets: stopFacets(candidate),
    };
  }
  return rationale;
}

/**
 * THE FACTS THAT TELL TWO STOPS APART WHEN THEY FIT FOR THE SAME REASON.
 *
 * Deliberately short and deliberately concrete: how far out it is, whether it is
 * a quiet find, whether it holds up in bad weather, whether it asks something of
 * the legs. Everything comes off the card the board already built, so nothing
 * here can claim more than the board claimed, and a stop the region knows little
 * about produces an empty list rather than filler.
 */
function stopFacets(candidate: DiscoveryCandidate): string[] {
  const facets: string[] = [];
  /*
   * THE ONE FACET THAT COULD CONTRADICT THE ROW ABOVE IT.
   *
   * "57 min on foot from your base" is a plain statement about a walk, and on a
   * car-free trip whose scheduled journeys nobody could time it is a stand-in
   * for a train — which the travel row directly above this card already says,
   * twice, in the words "journey not verified" and "the walking time shown is
   * the upper bound we hold for it". A delivered itinerary printed all three on
   * one screen: two hedged sentences and, between them, a confident one.
   *
   * `journeyProxy` is the fact both surfaces read; the board's own travel
   * phrase was corrected first and this one was missed. A facet exists to tell
   * two stops apart, and a figure the page has just finished qualifying cannot
   * do that — so it is dropped rather than restated, and the row above keeps
   * the whole of the claim.
   */
  if (
    candidate.reach.status === 'measured' &&
    candidate.reach.travelMinutes > 0 &&
    !candidate.journeyProxy
  ) {
    facets.push(
      `${formatMinutes(candidate.reach.travelMinutes)} ${REACH_MODE_PHRASE[candidate.reach.mode]} from your base`,
    );
  }
  if (candidate.place.hiddenGemScore >= 0.6) facets.push('a quiet find');
  if (candidate.place.weather.poorWeatherBackup) facets.push('holds up in poor weather');
  if (
    candidate.place.physicalIntensity === 'strenuous' ||
    candidate.place.physicalIntensity === 'moderate'
  ) {
    facets.push(`${candidate.place.physicalIntensity} going`);
  }
  return facets;
}
