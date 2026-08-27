import 'server-only';
import type { StopRationale } from '@/components/ItineraryView';
import { acceptedImagesFor } from '@/lib/db/imagery-repository';
import { formatMinutes } from '@/lib/format';
import { getProfile } from '@/lib/db/repository';
import { boardFor, resolveTripRegion } from '@/lib/region';
import {
  REACH_MODE_PHRASE,
  displayNameOf,
  findOperatingCalendar,
  buildPreparation,
  licence,
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
  preparation: PreparationItem[];
  baseNames?: DisplayName;
  timeZone?: string;
  attributions: readonly string[];
  coordinates: Record<string, { lat: number; lng: number }>;
  worthSkipping: { name: string; reason: string }[];
  lodgingAreas: { name: string; rationale: string; tradeoffs: readonly string[] }[];
  images: Record<string, DestinationImageRecord>;
  rationale: Record<string, StopRationale>;
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
          for (const candidate of board.candidates) {
            const why = candidate.fit.reasons.find((reason) => !used.has(reason))
              ?? candidate.fit.reasons[0];
            if (why) used.add(why);
            rationale[candidate.place.id] = {
              /*
               * The name the board showed, so the plan and the board agree on
               * what a place is called. See `StopRationale.name`.
               */
              name: displayNameOf(candidate.place),
              ...(why ? { why } : {}),
              category: candidate.place.category,
              facets: stopFacets(candidate),
            };
          }
        } catch (error) {
          console.error('Worth-skipping supply could not be derived', error);
        }
      }
      const base = resolved.context.compiled.bases.find((entry) => entry.id === itinerary.baseId);
      baseNames = base?.names;
      timeZone = base?.timeZone;
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

  return {
    preparation,
    baseNames,
    timeZone,
    attributions,
    coordinates: Object.fromEntries(coordinates),
    worthSkipping,
    lodgingAreas,
    images,
    rationale,
  };
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
  if (candidate.reach.status === 'measured' && candidate.reach.travelMinutes > 0) {
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
