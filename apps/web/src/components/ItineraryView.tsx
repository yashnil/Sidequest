import Link from 'next/link';
import {
  BOOKING_KIND_LABELS,
  DIETARY_EVIDENCE_COPY,
  DIETARY_NEED_LABELS,
  FOOD_SERVICE_TYPE_LABELS,
  formatMinuteOfDay,
  ITINERARY_STATUS_COPY,
  MEAL_SLOT_LABELS,
  PLACE_CATEGORY_LABELS,
  PRICE_BAND_LABELS,
  PRICE_BAND_WORDS,
  PRICE_EVIDENCE_COPY,
  RECHECK_WINDOW_LABELS,
  RESERVATION_LABELS,
  TRANSPORT_MODE_LABELS,
  type DailyWindow,
  type FoodPlan,
  type FoodStopKind,
  decodePolyline,
  type RecheckManifest,
  type TodayView,
  type Itinerary,
  type ItineraryDay,
  type ItineraryItem,
  type TransportStrategy,
  type TravelSegment,
  type TripPackage,
  type VerificationState,
  PREPARATION_KIND_COPY,
  groupPreparation,
  croppable,
  imageryFallbackFor,
  type DestinationImage as ImageRecord,
  type PlaceCategory,
  type PreparationItem,
  type DisplayName,
} from '@sidequest/core';
import { Badge, PLATE_HUE, Panel, buttonClass, cx, type BadgeTone, PlaceName } from './ui';
import { DestinationImage, ImageCredit } from './DestinationImage';
import { DayMap } from './DayMap';
import { TripOverviewMap } from './TripOverviewMap';
import { PackingChecklist } from './PackingChecklist';
import type { MapConnector, MapMarker } from './InteractiveMap';
import { dayMapModel } from './day-map-legs';
import type { MapBasemap } from './map-adapter';
import { plannedOffByDay } from '../lib/planning/planned-off';
import {dayRouteLinks, mapModeFor} from '@/lib/maps';
import { PrintButton } from './PrintButton';
import { HubShell, type HubViewId } from './hub/HubShell';
import { DayRail } from './hub/DayRail';
import { BaseCards, CautionsCard, CONVENIENCE_LABELS, CONVENIENCE_TONE, STRESS_LABELS, STRESS_TONE, TimingCard, TransportCard } from './hub/OverviewCards';
import { fixNumberArticles, sameSentence } from './hub/article';
import { DAY_PART_LABEL, groupByDayPart, partsAreMeaningful } from './hub/day-parts';
import { clock, firstSentence, humanDate, span, timelineClock, travelSpan } from './hub/plan-format';
import type { MapWorkspaceSheet } from './hub/MapWorkspace';
import { DayFocusMap, DayFocusProvider, DayFocusTarget, StopFocusHandle, type DayFocusModel } from './hub/DayFocus';
import { TripConfidence, CONFIDENCE_WORD as VERIFICATION_CHIP_WORD } from './hub/TripConfidence';
import { BookView } from './hub/BookView';
import { FreshnessBanner } from './hub/FreshnessBanner';
import { SplitPlanCard } from './hub/SplitPlanCard';
import { NextActionCard } from './hub/NextActionCard';
import { DecisionCard } from './hub/DecisionCard';
import { PreflightView } from './hub/PreflightView';
import { StateBadge } from './hub/StateBadge';
import { FEASIBILITY_WORDS, humanize, verificationNeedsChip } from './hub/HumanWords';
import { PrintAppendix } from './PrintAppendix';
import type { BookedAffectedScope } from '@/lib/intelligence/booked-reconcile';
import type { BookingImport } from '@/lib/db/execution-repository';
import { assuranceSummary, dayPartFor, dayState, feasibilityHeadline, normalizeStays, splitPlanFor, type AnchorKind, type BookingResolution, type FactObservation, type NextActions, type Preflight, type TripDecision, type TripLedger, type TripLifecycle, type TripStateGraph, type VolatileFact } from '@sidequest/core';
import { AtlasBand, atlasButtonClass, type AtlasFact } from './hub/AtlasBand';
import { BaseSequence, type BaseSequenceStop } from './hub/BaseSequence';
import { MapWorkspace } from './hub/MapWorkspace';
import { PlanSubnav } from './hub/PlanSubnav';
import { PlaceSheetProvider, PlaceSheetTrigger, type PlaceSheetDetail, type PlaceSheetNote } from './hub/PlaceSheet';
import { SignatureExperiences, type SignatureExperience } from './hub/SignatureExperiences';
import { BackupsSection, BeforeYouGoSection, BookFirstSection, BookingProgressLine, BudgetSection, CritiquePanel, FoodSection, HubUrgent, PackSection, StaysSection, TodaySection, TransportSection, VerifySection } from './hub/TripHub';
import { AddStopForm, FixDayButton, StopDayControls } from '@/app/(product)/trips/[id]/itinerary/live-controls';
import { placeNavigationLinks } from '@/lib/navigation-links';
import type { BookedPlanItem, TravelIntelligence, TravelReadinessProfile } from '@sidequest/core';
/*
 * The editing controls live beside the server actions they call, in the
 * itinerary route directory, rather than in the shared component folder: they
 * are meaningless anywhere but on this page.
 */
import {
  EaseDayButton,
  PrintExpand,
  RegenerateButton,
  StopEditMenu,
} from '@/app/(product)/trips/[id]/itinerary/edit-controls';
import { ShareControl } from '@/app/(product)/trips/[id]/itinerary/share-controls';
import { isMachineWeatherLabel, travellerVoice } from './plan-language';

/**
 * WHY THESE ARE NOT IN THE PLAN, SAID BY WHAT ACTUALLY STOPPED THEM.
 *
 * The heading was a constant — "Left off for room", over a blurb reading "there
 * were not the hours for them" — while the reason on each card comes from the
 * planner. On a live Tokyo plan the two disagreed outright: both entries read
 * "We have no travel time recorded to this place, so we cannot fit it into a
 * day honestly", which is not a statement about hours at all, under a heading
 * insisting it was. A traveller reading that learns the wrong thing about their
 * own trip — that the day was too full, when the truth is that we could not
 * measure the way there.
 *
 * So the heading is derived. Room is claimed only when room is what every entry
 * says; otherwise the section says what it can always say truthfully, and the
 * cards carry the specifics — which they already did.
 */
const ROOM_CODES: ReadonlySet<string> = new Set([
  'no_time_left',
  'lower_priority',
  'frequency_reached',
  'exceeds_daily_travel',
  'exceeds_intensity',
]);

function allAboutRoom(dropped: readonly { reasonCode: string }[]): boolean {
  return dropped.every((entry) => ROOM_CODES.has(entry.reasonCode));
}

function droppedHeading(dropped: readonly { reasonCode: string }[]): string {
  return allAboutRoom(dropped) ? 'Left off for room' : 'Left off, and why';
}

function droppedBlurb(dropped: readonly { reasonCode: string }[]): string {
  return allAboutRoom(dropped)
    ? 'These were on your board but there were not the hours for them. Nothing is hidden.'
    : 'These were on your board and are not in the plan. Each one says what stopped it — nothing is hidden.';
}


const KIND_STYLE: Record<ItineraryItem['kind'], { rail: string; label: string }> = {
  activity: { rail: 'bg-pine', label: '' },
  travel: { rail: 'bg-slate-blue', label: '' },
  meal: { rail: 'bg-amber', label: 'Meal' },
  rest: { rail: 'bg-amber', label: 'Rest' },
  free_time: { rail: 'bg-rule', label: 'Free' },
};

/**
 * What a food block actually is, said in the row's own eyebrow.
 *
 * A packed lunch is not a restaurant visit and a shop is not a meal, and using
 * one word for all three is how a plan reads as though it has booked something
 * it has not.
 */
const FOOD_STOP_LABEL: Record<FoodStopKind, string> = {
  venue: '',
  grocery: 'Supplies',
  packed: 'Carried',
  unplanned: 'Time held',
};

/**
 * When "on foot" is worth a chip.
 *
 * Under half an hour it is the walk between a car park and a gate, which is not
 * a property of the day. Over it, it is the day.
 */
const WALKING_DAY_MINUTES = 30;

/**
 * WHAT THE PAGE KNOWS ABOUT A SCHEDULED STOP THAT THE STORED PLAN DOES NOT.
 *
 * A stored itinerary is immutable and records what to do and when. Everything
 * here is re-derived at render time from the compiled region the plan was built
 * against — the same board the traveller chose from — and it exists because the
 * plan's own per-stop `reason` is one template with an interest name substituted
 * into it, so eleven stops on a real plan read "Matches your interest in X" and
 * the product's stated differentiator is invisible on its only deliverable.
 *
 * Nothing here is invented and nothing overrides the plan: where the region no
 * longer holds a card for a stop, the row falls back to the plan's own sentence
 * exactly as before.
 */
export interface StopRationale {
  /**
   * The place's name as the board showed it — English or romanised where a
   * source published one, with the native form beside it.
   *
   * The planner materialises `ItineraryItem.title` as a plain string at plan
   * time, so the naming work that landed on the board never reached the plan:
   * a traveller picked "Sumida River" on the board and the document they take
   * on holiday said 隅田川, on a page declaring `lang="en"`. Re-resolved here
   * because a stored plan is immutable and rewriting one to fix a heading would
   * be editing somebody's trip.
   *
   * Presentation only, and only for the *place* rows. A travel leg's title is a
   * composed sentence and stays exactly as the planner wrote it.
   */
  name?: string;
  /** The fit model's own sentence about this place, in the traveller's words. */
  why?: string;
  /** What kind of place it is. Sets the day's colour and nothing else. */
  category?: PlaceCategory;
  /**
   * Short facts that differ between stops — "quiet find", "sheltered if it
   * rains", "18 min from your base". At most two are rendered.
   */
  facets?: readonly string[];
}


export function ItineraryView({
  itinerary,
  preparation,
  tripId,
  dateLabel,
  renderedAt,
  baseNames,
  destinationName,
  boardAvailable = true,
  timeZone,
  attributions = [],
  coordinates = {},
  lockedPlaceIds = [],
  worthSkipping = [],
  lodgingAreas = [],
  images = {},
  livePhotos = {},
  rationale = {},
  tiles = null,
  personality = null,
  intelligence = null,
  today = null,
  recheck = null,
  checks = { packing: [], checklist: [] },
  booked = [],
  bookedHonored = [],
  bookedConflicts = [],
  readinessProfile = null,
  printAppendix = false,
  initialView = 'overview',
  graph = null,
  nextActions = null,
  preflight = null,
  decisions = [],
  ledger = null,
  resolutions = [],
  observations = [],
  volatile = [],
  changedHeadline = null,
  affected = null,
  pendingImports = [],
  lastCheckedAt = null,
  savedToAccount = false,
  partyDifferences = false,
}: {
  /**
   * V9 — THE EXECUTION LAYER, DERIVED ONCE IN THE VIEW MODEL.
   *
   * The state graph, the next actions, Preflight, the decisions, the ledger
   * and the freshness list all read the same applied itinerary and the same
   * intelligence snapshot. Every one is optional here so a plan rendered
   * without them (a test, a legacy caller) is the plan it always was.
   */
  graph?: TripStateGraph | null;
  nextActions?: NextActions | null;
  preflight?: Preflight | null;
  decisions?: readonly TripDecision[];
  ledger?: TripLedger | null;
  resolutions?: readonly BookingResolution[];
  observations?: readonly FactObservation[];
  volatile?: readonly VolatileFact[];
  changedHeadline?: string | null;
  lifecycle?: TripLifecycle;
  daysUntilTrip?: number;
  affected?: BookedAffectedScope | null;
  /** Never on the shared copy: the share page passes none. */
  pendingImports?: readonly BookingImport[];
  /** When the last recheck ran, for the freshness banner. */
  lastCheckedAt?: string | null;
  /** The trip is on an account, so the band can say it is kept. Passed by the owner page only. */
  savedToAccount?: boolean;
  /** V9 §17 — the party has a recorded difference, so a split may be suggested. */
  partyDifferences?: boolean;
  itinerary: Itinerary;
  /** PRODUCTION UI V1 — `?appendix=1`: the evidence appendix prints with the packet. */
  printAppendix?: boolean;
  /** Which of the five hub views opens first (the hash still wins on the client). */
  initialView?: HubViewId;
  /** The travel-intelligence layer. Null only for a plan built before it existed. */
  intelligence?: TravelIntelligence | null;
  /** LIVE WORLD V1 — Today mode; inactive outside the trip's dates. */
  today?: TodayView | null;
  /** LIVE WORLD V1 — the recheck manifest for the Verify section. */
  recheck?: RecheckManifest | null;
  checks?: { packing: string[]; checklist: string[] };
  booked?: readonly BookedPlanItem[];
  bookedHonored?: readonly string[];
  bookedConflicts?: readonly string[];
  readinessProfile?: TravelReadinessProfile | null;
  /** Present when the caller spreads the view model; the applied itinerary is passed as `itinerary`. */
  appliedItinerary?: Itinerary;
  /** A basemap tile source resolved on the server; null draws positions only. */
  tiles?: MapBasemap | null;
  /** The trip in one sentence, from the traveller's profile. Null on a shared copy or when no profile exists. */
  personality?: string | null;
  /**
   * ODbL attribution strings, verbatim, from the compiled region's licences.
   *
   * Required on this page: the plan is made of OpenStreetMap-derived records and
   * this is the surface a traveller prints. Passed as the licence's own text so
   * no component here can paraphrase it into non-compliance.
   */
  attributions?: readonly string[];
  /**
   * Where each place is, keyed by the id the timeline already carries.
   *
   * Only used to build a map link. A place missing from this map simply does not
   * appear in the link, and the link says how many stops it carries.
   */
  coordinates?: Record<string, { lat: number; lng: number }>;
  /**
   * Derived on the server from this plan and the evidence it was built on.
   *
   * Empty is the common case and is not a failure: a region with no researched
   * evidence has nothing to prepare for beyond what the days already say.
   */
  preparation: PreparationItem[];
  /**
   * The trip's id — or nothing, and the absence is the read-only mode.
   *
   * Every owner surface is addressed by this id: the board, the questionnaire,
   * the calendar export, the per-stop edits. The share page therefore does not
   * pass it, and everything owner-only below is gated on its presence — so the
   * shared document *cannot* contain the key to the owner surfaces, rather
   * than merely choosing not to show it. A separate `readOnly` flag would be
   * a second thing to keep true; the id's absence is the fact itself.
   */
  tripId?: string;
  dateLabel: string;
  /**
   * The base's resolved name, read from the compiled region at render time.
   *
   * Deliberately *not* stored on the itinerary. A stored plan is immutable, and
   * migrating one to change how a heading reads would be rewriting somebody's
   * trip to fix a presentation bug. The compiled region is the artifact that
   * owns names; this reads it, and an old region without one falls back to the
   * plain `baseName` exactly as before.
   */
  baseNames?: DisplayName;
  /** QUALITY V1 — the trip as the traveller named it; the hero uses it when the plan moves between bases. */
  destinationName?: string;
  /** Whether a Discovery Board exists for this trip; without one the secondary link returns to the interview. */
  boardAvailable?: boolean;
  /**
   * When the server rendered this page, as epoch milliseconds.
   *
   * Passed in rather than read here so every day on the page judges the same
   * forecast against the same instant, and so the check is a pure function of
   * its props — a component that reads the clock during render can show two
   * different answers for one plan.
   */
  renderedAt: number;
  /**
   * The IANA zone the trip's base sits in, read from the compiled region.
   *
   * Threaded rather than assumed. This used to be `America/Los_Angeles`, hard
   * coded, on every itinerary in the world — a leftover from the phase when
   * there was one region, and one that printed the wrong hour for every
   * traveller outside California without anything on screen looking wrong.
   *
   * Absent is a real state: an artifact compiled before bases carried a zone has
   * none, and the honest answer then is UTC with the offset named, rather than a
   * local-looking time in somebody else's day.
   */
  timeZone?: string;
  /**
   * Stops the traveller has pinned to their day. Display state only — the
   * pins themselves live in the database and are read by the rebuild.
   */
  lockedPlaceIds?: readonly string[];
  /**
   * Board supply the fit model marked "probably skip", from the same compiled
   * region this plan drew on. Empty when the board holds none, and the
   * section then simply does not render — never fabricated to fill space.
   */
  worthSkipping?: readonly { name: string; reason: string }[];
  /**
   * Where to stay, and why — but only for bases whose lodging is *sourced*.
   *
   * The caller filters on that, and the filter is the point: a base is a
   * geographic recommendation, and a region that knows a town exists does not
   * thereby know anybody rents rooms in it. Omitting the section is the honest
   * treatment of unknown; an empty list renders nothing rather than a heading
   * over a shrug.
   */
  lodgingAreas?: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[];
  /**
   * Licensed photographs by place id, read from the same table the board reads.
   *
   * A row lookup and never a resolution: the identity of every one of these was
   * established while the traveller was choosing on the board, and this page
   * only draws what is already on disk. Empty is the ordinary state for a
   * destination nothing licensable was found for, and the day headers then carry
   * no photograph rather than a stand-in.
   */
  images?: Record<string, ImageRecord>;
  /**
   * MVP V3 — where a request-time photograph can be fetched for a stop, by place
   * id. Empty unless the build has `SIDEQUEST_PLACE_PHOTOS=google`; a URL on
   * this origin, so the credential stays on the server and nothing is stored.
   */
  livePhotos?: Record<string, string>;
  /** What the fit model says about each scheduled stop. See `StopRationale`. */
  rationale?: Record<string, StopRationale>;
}) {
  const baseEntity = {
    name: itinerary.baseName,
    ...(baseNames ? { names: baseNames } : {}),
  };
  const multiBase = (itinerary.package?.bases.length ?? 0) > 1;
  const status = ITINERARY_STATUS_COPY[itinerary.status];
  /* V6 §12 — the deterministic feasibility report, read by the band and by the packet's last page. */
  const feasibility = itinerary.package?.feasibility;
  const conflicts = itinerary.unscheduled.filter((entry) => entry.wasManual);
  const dropped = itinerary.unscheduled.filter((entry) => !entry.wasManual);
  const openIssues = itinerary.issues.filter((issue) => issue.severity !== 'info');
  /*
   * What Sidequest could establish about each model-authored stop, keyed by
   * the item id the timeline carries. Empty on a plan the deterministic
   * planner built, where every stop was a verified board card by construction.
   */
  const verificationByItemId: Record<string, VerificationState> = {};
  /* LIVE WORLD V1 — package roles by item id and place id, for the day controls. */
  const anchorRoles: Record<string, 'core' | 'secondary' | 'optional' | 'flex'> = {};
  for (const anchor of itinerary.package?.anchors ?? []) {
    anchorRoles[anchor.id] = anchor.role;
    if (anchor.placeId) anchorRoles[anchor.placeId] = anchor.role;
  }
  for (const anchor of itinerary.package?.anchors ?? []) verificationByItemId[anchor.id] = anchor.verification;
  /* What each day was for, when the day ended up empty (`planned-off.ts`). */
  const plannedOffByDayNumber = plannedOffByDay(itinerary);
  /* PRODUCTION UI V1 — what kind of thing each stop is; only a named place is ever called "not verified". */
  const anchorKinds: Record<string, AnchorKind> = {};
  for (const anchor of itinerary.package?.anchors ?? []) if (anchor.anchorKind) anchorKinds[anchor.id] = anchor.anchorKind;
  /* The sticky desktop map's per-day drawings, computed once on the server. */
  const dayFocusModels: DayFocusModel[] = itinerary.days.map((day) => {
    const model = dayMapModel({ day, coordinates, nameOf: (placeId, fallback) => rationale[placeId]?.name ?? fallback });
    return { dayNumber: day.dayNumber, date: day.date, theme: day.theme, baseName: day.baseName, base: model.base, markers: model.markers, connectors: model.connectors, omitted: model.omitted };
  });
  const openBookFirst = intelligence ? intelligence.bookings.items.filter((b) => b.priority === 'book_first' && b.status === 'open' && !b.memberIds).length + (intelligence.bookings.items.some((b) => b.memberIds && b.status === 'open') ? 1 : 0) : 0;
  const stopCount = itinerary.days.reduce((sum, day) => sum + day.items.filter((item) => item.kind === 'activity').length, 0);

  /* EXPERIENCE V2 — the base sequence, each base linked to the first day that sleeps there. */
  const baseSequence: BaseSequenceStop[] = (itinerary.package?.bases ?? []).map((base) => {
    const first = itinerary.days.find((day) => day.baseId === base.id || day.baseName === base.name || (base.displayName !== undefined && day.baseName === base.displayName));
    return { id: base.id, name: base.name, nights: base.nights, firstDay: first?.dayNumber ?? null, ...(base.insertedBySidequest ? { insertedBySidequest: true } : {}) };
  });
  /*
   * V6 — THE SIGNATURE EXPERIENCES.
   *
   * The core anchors the reconciler kept, at most three, each with the reason
   * it is on this trip and — where one of this trip's own places has a licensed
   * photograph — a picture of it. `preserved*` and `retained_unverified` are
   * the dispositions that mean "this is on the plan"; everything folded into a
   * meal, a transfer or a terminal is movement or a table, not a signature.
   */
  const itemsById = new Map<string, { item: ItineraryItem; dayNumber: number }>();
  for (const day of itinerary.days) for (const item of day.items) itemsById.set(item.id, { item, dayNumber: day.dayNumber });
  /*
   * V11 §7 — THE CHOICE IS MADE AT BUILD TIME AND READ HERE.
   *
   * This used to be `.slice(0, 3)` over the anchors in day order, so "the trip
   * is built around" meant "whatever happens first" — a bazaar and two markets
   * on a trek, an arrival-evening riverside walk in the Rockies. The selection
   * needs the draft, the profile and the episodes, none of which this component
   * has, so it is scored in the reconciler and persisted on the package.
   * `signatureOrder` is the fallback for trips built before V11, which have no
   * `package.signatures` and must keep rendering something.
   */
  const chosenSignatures = itinerary.package?.signatures;
  const signatureOrder = new Map((chosenSignatures ?? []).map((entry, index) => [entry.id, index] as const));
  const signatureExperiences: SignatureExperience[] = (itinerary.package?.anchors ?? [])
    .filter(
      (anchor) =>
        anchor.role === 'core' &&
        (anchor.disposition.startsWith('preserved') || anchor.disposition === 'retained_unverified' || anchor.disposition.startsWith('moved')) &&
        anchor.anchorKind !== 'meal' &&
        anchor.anchorKind !== 'transfer' &&
        anchor.anchorKind !== 'gateway',
    )
    .filter((anchor) => (chosenSignatures ? signatureOrder.has(anchor.id) : true))
    .sort((a, b) => (chosenSignatures ? (signatureOrder.get(a.id) ?? 0) - (signatureOrder.get(b.id) ?? 0) : 0))
    .slice(0, 3)
    .map((anchor) => {
      const hit = itemsById.get(anchor.id) ?? (anchor.placeId ? [...itemsById.values()].find((entry) => entry.item.placeId === anchor.placeId) : undefined);
      const why = (anchor.placeId ? rationale[anchor.placeId]?.why : undefined) ?? hit?.item.reason ?? anchor.note ?? '';
      const image = anchor.placeId ? placeFrame(anchor.placeId, (anchor.placeId ? rationale[anchor.placeId]?.name : undefined) ?? anchor.name, images, livePhotos, rationale, '4 / 3') : null;
      return {
        id: anchor.id,
        name: (anchor.placeId ? rationale[anchor.placeId]?.name : undefined) ?? anchor.name,
        dayNumber: hit?.dayNumber ?? anchor.scheduledDayNumber ?? anchor.dayNumber,
        why: firstSentence(why),
        ...(image ? { image } : {}),
      };
    });
  const bookSoon = intelligence ? intelligence.bookings.items.filter((b) => b.priority === 'book_first' && b.status === 'open' && !b.memberIds) : [];
  /*
   * V9 §9 — WHAT CHANGED SINCE THE PLAN IS THE OWNER'S TO ACT ON.
   *
   * A reader with a link gets the plan and where each day stands, never the
   * observations a recheck wrote (they lead to proposals through Ask, which
   * the shared copy does not have). The share page strips the observation
   * rows at its door; the graph and the actions built from them are filtered
   * here so no sentence from a recheck reaches the shared document either.
   */
  const visibleGraph = graph && !tripId ? { ...graph, nodes: graph.nodes.filter((node) => !node.id.startsWith('changed:')) } : graph;
  const visibleActions = nextActions && !tripId ? { ...nextActions, actions: nextActions.actions.filter((action) => !action.nodeId.startsWith('changed:')) } : nextActions;
  /* V9 — the Book badge counts every required need still open; Prepare's counts what Preflight says needs attention. */
  const openRequired = intelligence ? intelligence.bookings.items.filter((b) => b.status === 'open' && !b.memberIds && (b.necessity === 'required' || b.necessity === 'strongly_recommended')).length : 0;
  const attentionCount = preflight ? preflight.attention.length : openBookFirst;
  /* V9 §17 — a split day as a structure; the booked things on that date name what needs assigning. */
  const bookedOn = (date: string) => booked.filter((b) => b.status === 'booked' && (b.date === date || (b.type === 'lodging' && b.date && b.endDate && b.date <= date && date <= b.endDate))).map((b) => b.title);

  const days = (
    <PlaceSheetProvider>
    <DayFocusProvider initial={itinerary.days[0]?.dayNumber ?? 1}>
      {/*
        V6 — `items-start` shrank the map column to its own content, so the
        sticky map stopped following at the foot of day one and every day after
        it faced two-fifths of empty paper. The column stretches now, so the
        drawing stays beside the day being read for the whole scroll.
      */}
      <div className="lg:grid lg:grid-cols-[minmax(0,58fr)_minmax(320px,42fr)] lg:items-stretch lg:gap-8">
        <div className="min-w-0">
          <div id="itinerary" className="scroll-mt-[calc(var(--chrome-height)+4.5rem)]" />
          <DayRail days={itinerary.days} chapters={itinerary.package?.chapters} />
          <ol className="space-y-10">
            {itinerary.days.map((day) => (
              <li key={day.dayNumber} className="break-inside-avoid">
                <DayFocusTarget dayNumber={day.dayNumber}>
                  <DayCard
                    day={day}
                    episode={itinerary.package?.episodes?.find((e) => e.dayNumbers.includes(day.dayNumber)) ?? null}
                    renderedAt={renderedAt}
                    coordinates={coordinates}
                    tripId={tripId}
                    lockedPlaceIds={new Set(lockedPlaceIds)}
                    images={images}
                    livePhotos={livePhotos}
                    rationale={rationale}
                    verification={verificationByItemId}
                    anchorKinds={anchorKinds}
                    isFirst={day.dayNumber === itinerary.days[0]?.dayNumber}
                    isLast={day.dayNumber === itinerary.days[itinerary.days.length - 1]?.dayNumber}
                    tiles={tiles}
                    dayCount={itinerary.days.length}
                    anchorRoles={anchorRoles}
                    plannedOff={plannedOffByDayNumber[day.dayNumber] ?? []}
                    stateBadge={visibleGraph ? <StateBadge dayNumber={day.dayNumber} {...dayState(visibleGraph, day.dayNumber)} /> : null}
                    split={day.split ? <SplitPlanCard plan={splitPlanFor(day, { bookingsOnDay: bookedOn(day.date) })!} {...(tripId ? { tripId } : {})} {...(partyDifferences ? { canSuggest: true } : {})} /> : null}
                  />
                </DayFocusTarget>
              </li>
            ))}
          </ol>
          {conflicts.length > 0 ? (
            <Panel className="mt-8 border-clay p-5">
              <h2 className="type-section text-clay">
                {conflicts.length === 1 ? 'One thing you picked' : `${conflicts.length} things you picked`} could not be scheduled
              </h2>
              <p className="mt-1 type-small text-ink-muted">We would rather tell you than quietly drop it or break a limit you set.</p>
              <ul className="mt-4 space-y-3">
                {conflicts.map((entry) => (
                  <li key={entry.placeId} className="text-sm">
                    <span className="font-medium text-ink">{entry.name}</span>
                    <span className="block text-ink-muted">{entry.reason}</span>
                    {entry.suggestedRemedy ? <span className="mt-0.5 block text-ink-faint">Smallest fix: {entry.suggestedRemedy}</span> : null}
                  </li>
                ))}
              </ul>
              {tripId ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  <Link href={`/trips/${tripId}/discover`} className={buttonClass('secondary', 'sm')}>
                    Change what is on the board
                  </Link>
                  <Link href={`/trips/${tripId}/questionnaire`} className={buttonClass('secondary', 'sm')}>
                    Change how you are getting around
                  </Link>
                </div>
              ) : null}
            </Panel>
          ) : null}
        </div>
        <DayFocusMap days={dayFocusModels} tiles={tiles} />
      </div>
    </DayFocusProvider>
    </PlaceSheetProvider>
  );

  /*
   * V6 — WHY THESE DATES, AND WHO DECIDED THEM.
   *
   * A window somebody chose and a window Sidequest chose are different facts
   * and a traveller is owed which one they are holding. `timingDecidedBy` is
   * the contract's own record of that; the rationale is the plan's reason.
   */
  const headline = fixNumberArticles(personality ?? itinerary.package?.purpose ?? itinerary.summary);
  const purpose = itinerary.package?.purpose;
  /*
   * The purpose only where it says something the headline has not. Compared
   * with the article and the punctuation set aside: a purpose reading
   * "A 8-day…" under a headline corrected to "An 8-day…" is one sentence, and
   * a page must not print one sentence twice.
   */
  const purposeParagraph = purpose && !sameSentence(purpose, headline) && !sameSentence(firstSentence(purpose), firstSentence(headline)) && !headline.startsWith(purpose) && !purpose.startsWith(headline) ? fixNumberArticles(purpose) : null;
  const timingDecidedBy = itinerary.package?.contract?.timingDecidedBy;
  const timingOwner: 'traveller' | 'sidequest' | null = timingDecidedBy === 'traveller' ? 'traveller' : timingDecidedBy === 'sidequest' ? 'sidequest' : null;
  const overviewModel = overviewMapModel(itinerary, coordinates, rationale);
  const seasonLine = seasonLineFor(itinerary);

  /*
   * V8 — THE OVERVIEW IS AN ARGUMENT MADE WITH OBJECTS.
   *
   * Left: why this trip works (the thesis, the purpose, the route reasoning),
   * the signature experiences as cards, where you sleep as base cards. Right:
   * the whole trip on a map, Book first as a checklist card, the dates and the
   * weather knowledge behind them, the transport reality, and only the
   * cautions that would change a decision. Two columns from `lg`, one below.
   * Nothing here is new information — it is the same facts the audit found in
   * a text wall beside forty per cent of empty paper.
   */
  const routeDecision = decisions.find((d) => d.key === 'route') ?? null;
  const transportDecision = decisions.find((d) => d.key === 'transport') ?? null;
  const timingDecision = decisions.find((d) => d.key === 'timing') ?? null;
  const overview = (
    <div data-testid="hub-overview">
      <div id="overview" className="scroll-mt-[calc(var(--chrome-height)+4.5rem)]" />
      {/*
        V9 §2 — THE NEXT BEST ACTION LEADS THE TRIP.
        One to three things, ranked deterministically, before the argument for
        the trip. Then what changed since the plan was written (the freshness
        banner, owner only — it may call the recheck action once). Then the
        thesis, the route and the bases.
      */}
      {visibleActions ? (
        <div className="mt-6" id="next-action">
          <NextActionCard nextActions={visibleActions} moreHref={visibleActions.phase === 'book' ? '#book' : '#prepare'} />
        </div>
      ) : null}
      {tripId ? <FreshnessBanner tripId={tripId} observations={observations} volatile={volatile} lastCheckedAt={lastCheckedAt} headline={changedHeadline} now={renderedAt} /> : null}
      {intelligence ? <HubUrgent intel={intelligence} /> : null}
      {today?.active ? <TodaySection today={today} minuteLabel={(minute) => formatMinuteOfDay(minute)} {...(tripId ? { tripId } : {})} /> : null}
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(20rem,5fr)] lg:gap-10">
        <div className="min-w-0">
          <section aria-labelledby="trip-thesis" data-testid="trip-thesis">
            <p className="eyebrow">Why this trip works</p>
            <p id="trip-thesis" className="mt-2 max-w-[30ch] font-display text-[clamp(1.625rem,1.3rem+1.1vw,2.375rem)] leading-[1.12] text-ink" data-testid="trip-personality-line">
              {headline}
            </p>
            {/*
              The purpose only where it says something the headline has not. On a
              trip whose profile sentence and whose draft purpose are the same
              sentence, printing both put one paragraph twice under itself.
            */}
            {purposeParagraph ? <p className="mt-4 max-w-[62ch] type-body text-ink-muted">{purposeParagraph}</p> : null}
            {itinerary.package?.routeRationale ? <p className="mt-3 max-w-[62ch] type-body text-ink-muted" data-testid="route-rationale">{itinerary.package.routeRationale}</p> : null}
          </section>

          {signatureExperiences.length > 0 ? (
            <div className="mt-10">
              <SignatureExperiences experiences={signatureExperiences} />
            </div>
          ) : null}

          {itinerary.package ? (
            <section className="mt-10" aria-labelledby="route-overview" data-testid="route-overview">
              <p className="eyebrow">Where you sleep</p>
              <h2 id="route-overview" className="mt-1 type-section text-ink">
                {baseSequence.length <= 1 ? 'One base for the whole trip' : `${baseSequence.length} bases, in order`}
              </h2>
              <div className="mt-4" data-testid="route-bases">
                <BaseCards bases={baseSequence} />
              </div>
              {multiBase ? (
                <div className="mt-4">
                  <BaseSequence bases={baseSequence} />
                </div>
              ) : null}
            </section>
          ) : null}
          {/*
            V9 §3 — THE DECISIONS THE DAYS HANG OFF, AS RECORDS.
            The route, how the trip moves and when it happens: each says what
            was chosen and, behind "Why this?", why, the facts that drove it,
            the tradeoffs as figures and what else was on the table. The chips
            are controlled alternatives through Ask Sidequest — owner only,
            because the shared copy has no Ask.
          */}
          {routeDecision || transportDecision || timingDecision ? (
            <section className="mt-10" aria-labelledby="decisions-heading" id="decisions" data-testid="decisions">
              <p className="eyebrow">Why it is shaped this way</p>
              <h2 id="decisions-heading" className="mt-1 type-section text-ink">
                The decisions behind the days
              </h2>
              <div className="mt-4 grid gap-3">
                {routeDecision ? <DecisionCard decision={routeDecision} askable={Boolean(tripId)} /> : null}
                {transportDecision ? <DecisionCard decision={transportDecision} askable={Boolean(tripId)} /> : null}
                {timingDecision ? <DecisionCard decision={timingDecision} askable={false} /> : null}
              </div>
            </section>
          ) : null}
        </div>
        <div className="min-w-0 space-y-4">
          {overviewModel.markers.length > 0 ? <TripSnapshot itinerary={itinerary} coordinates={coordinates} rationale={rationale} tiles={tiles} /> : null}
          {/*
            One statement of what is left to arrange, not two. A "Book soon"
            card listing the same three items sat directly above the booking
            progress that already names the next one, on the same screen.
          */}
          {intelligence ? (
            <div data-testid="overview-book-first">
              <BookingProgressLine intel={intelligence} />
              {bookSoon.length > 0 ? (
                <a href="#book" className="mt-2 inline-block type-small text-accent-strong underline underline-offset-4">
                  Everything to arrange
                </a>
              ) : null}
            </div>
          ) : null}
          <TimingCard dateLabel={dateLabel} decidedBy={timingOwner} rationale={itinerary.package?.timingRationale ?? null} seasonLine={seasonLine} />
          <TransportCard strategy={itinerary.transportStrategy} />
          {feasibility ? <CautionsCard items={feasibility.items} /> : null}
        </div>
      </div>
    </div>
  );

  /*
   * V8 — A PRESSED MARKER OPENS THE STOP, NOT JUST ITS DAY.
   *
   * The sheet details are assembled here, on the server, from the same rows
   * the Days view renders — one per placed stop — so the map and the timeline
   * describe a place in the same words. The picture, where one is licensed,
   * travels with it.
   */
  const mapSheets: Record<string, MapWorkspaceSheet> = {};
  const mapFrames: Record<string, React.ReactNode> = {};
  for (const day of itinerary.days) {
    const precisionByItem = timePrecisionByItem(day);
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId || !coordinates[item.placeId] || mapSheets[item.placeId]) continue;
      const point = coordinates[item.placeId]!;
      const verification = verificationByItemId[item.id];
      mapSheets[item.placeId] = {
        dayNumber: day.dayNumber,
        detail: buildPlaceSheet({
          item,
          precision: precisionByItem[item.id] ?? 'measured',
          dayLabel: `Day ${day.dayNumber} · ${humanDate(day.date)}`,
          neighbours: {},
          ...(rationale[item.placeId] ? { rationale: rationale[item.placeId]! } : {}),
          ...(verification ? { verification } : {}),
          ...(anchorKinds[item.id] ? { anchorKind: anchorKinds[item.id]! } : {}),
          ...(verification && verification !== 'unverified' ? { navigation: placeNavigationLinks({ ...point, name: item.title }) } : {}),
          ...(item.hours ? { hours: item.hours } : {}),
        }),
      };
      const frame = placeFrame(item.placeId, rationale[item.placeId]?.name ?? item.title, images, livePhotos, rationale, '16 / 9');
      if (frame) mapFrames[item.placeId] = frame;
    }
  }
  const mapView = (
    <div className="pt-4" data-testid="hub-map-view">
      <PlaceSheetProvider>
        <MapWorkspace
          markers={overviewModel.markers}
          connectors={overviewModel.connectors}
          primaryBase={overviewModel.primaryBase}
          days={dayFocusModels.map((d) => ({ dayNumber: d.dayNumber, theme: d.theme, baseName: d.baseName, base: d.base, markers: d.markers, connectors: d.connectors }))}
          tiles={tiles}
          summary={overviewModel.summary}
          sheets={mapSheets}
          frames={mapFrames}
        />
      </PlaceSheetProvider>
    </div>
  );

  const plan = (
    /*
     * A measure, not a canvas. Stays with one base put a half-width card in a
     * 1,400-pixel column and left the rest of the screen cream; the logistics
     * sections are prose and lists, and prose wants a column.
     */
    <div className="mx-auto max-w-5xl pt-2">
      <PlanSubnav
        initial="stays"
        badges={{ ...(bookSoon.length > 0 ? { bookings: bookSoon.length } : {}) }}
        panels={{
          stays: (
            /* The first section in a panel does not need the separation a stacked one does. */
            <div className="[&>section:first-child]:mt-8">
              {intelligence ? <StaysSection intel={intelligence} {...(tripId ? { tripId } : {})} itinerary={itinerary} coordinates={coordinates} /> : null}
              {!itinerary.package && lodgingAreas.length > 0 ? <WhereToStayLegacy areas={lodgingAreas} /> : null}
            </div>
          ),
          transport: (
            <section className="mt-6 scroll-mt-[calc(var(--chrome-height)+4.5rem)]" id="getting-around" data-testid="hub-getting-around">
              <TransportPlan strategy={itinerary.transportStrategy} />
              {intelligence ? <TransportSection intel={intelligence} /> : null}
            </section>
          ),
          food: (
            <section className="mt-6 scroll-mt-[calc(var(--chrome-height)+4.5rem)]" id="food" data-testid="hub-food-section">
              <FoodPlanPanel plan={itinerary.foodPlan} {...(itinerary.package ? { strategy: itinerary.package.foodStrategy } : {})} {...(intelligence ? { intel: intelligence } : {})} />
              {intelligence ? <FoodSection intel={intelligence} {...(tripId ? { tripId } : {})} itinerary={itinerary} coordinates={coordinates} /> : null}
            </section>
          ),
          budget: intelligence ? <BudgetSection intel={intelligence} /> : <p className="mt-6 type-small text-ink-muted">No budget was estimated for this plan.</p>,
          bookings: intelligence ? (
            <div>
              {/* V9 — arranging the trip lives on Book; this panel keeps the by-kind reading and points there. */}
              <p className="mt-6 type-small text-ink-muted">
                Everything to arrange, with what is booked and what it cost, is on{' '}
                <a href="#book" className="text-accent-strong underline underline-offset-4" data-testid="plan-bookings-to-book">
                  Book
                </a>
                .
              </p>
              <BookFirstSection intel={intelligence} {...(tripId ? { tripId } : {})} booked={booked} itinerary={itinerary} honored={bookedHonored} conflicts={bookedConflicts} resolutions={resolutions} view="bookings" />
            </div>
          ) : (
            <p className="mt-6 type-small text-ink-muted">Nothing to book was identified for this plan.</p>
          ),
        }}
      />
    </div>
  );

  /*
   * V9 §5/§6/§16 — BOOK: the needs with their actions, what is booked, the
   * import centre and the ledger. One view, owned by the bookings work; the
   * shared copy gets it without a trip id and therefore without a control, a
   * reference or an import.
   */
  const book = (
    <div className="mx-auto max-w-5xl pt-2">
      {intelligence && ledger && affected ? (
        <BookView {...(tripId ? { tripId } : {})} intel={intelligence} booked={booked} itinerary={itinerary} honored={bookedHonored} conflicts={bookedConflicts} resolutions={resolutions} ledger={ledger} affected={affected} pendingImports={tripId ? pendingImports : []} />
      ) : intelligence ? (
        <section className="pt-6" data-testid="hub-book">
          <BookFirstSection intel={intelligence} {...(tripId ? { tripId } : {})} booked={booked} itinerary={itinerary} honored={bookedHonored} conflicts={bookedConflicts} resolutions={resolutions} view="book-first" />
        </section>
      ) : (
        <section className="pt-6" data-testid="hub-book">
          <p className="type-body text-ink-muted">Nothing to book was identified for this plan.</p>
        </section>
      )}
    </div>
  );

  /* V7 §12 — the local operational set-up compiled for this destination: apps, payments, permits, connectivity. */
  const localSetup = intelligence?.readiness.entries.filter((entry) => entry.kind === 'local_setup') ?? [];
  const prepare = (
    <div className="mx-auto max-w-5xl pt-6">
      {/* V9 §7 — Preflight leads: the verdict, how far away, and ready / needs attention / can wait. */}
      {preflight ? (
        <div id="preflight" className="scroll-mt-[calc(var(--chrome-height)+4.5rem)]">
          <PreflightView preflight={preflight} {...(tripId ? { tripId } : {})} />
        </div>
      ) : (
        <div className="card border-pine/40 bg-pine-soft/50 p-5" data-testid="prepare-top">
          <p className="type-body text-ink">Nothing on this trip needs arranging right now. The sections below are here when you want them.</p>
        </div>
      )}
      {localSetup.length > 0 ? (
        <section className="card mt-8 p-5" aria-labelledby="local-setup-heading" data-testid="local-setup">
          <p className="eyebrow">Apps and set-up</p>
          <h2 id="local-setup-heading" className="mt-1 type-section text-ink">Set these up before you land</h2>
          <p className="mt-1.5 text-sm text-ink-muted">What day-to-day life needs where you are going. Reference material compiled by Sidequest with a date on it; confirm at the official source before you rely on it.</p>
          <ol className="mt-4 divide-y divide-rule">
            {localSetup.map((entry) => (
              <li key={entry.title} className="py-3" data-testid="local-setup-item">
                <p className="font-medium text-ink">
                  {entry.title}
                  {entry.tier === 'primary' ? <span className="eyebrow ml-2 rounded-sm bg-clay-soft px-1.5 py-0.5 !text-clay">Essential</span> : null}
                </p>
                <p className="mt-0.5 text-sm text-ink-muted">{entry.summary}</p>
                {entry.action ? <p className="mt-1 text-sm text-ink">{entry.action}</p> : null}
                {entry.links.length > 0 ? (
                  <p className="mt-1.5 flex flex-wrap gap-x-3 text-sm">
                    {entry.links.map((link) => (
                      <a key={link.url} href={link.url} target="_blank" rel="noreferrer nofollow" className="text-accent underline underline-offset-4">
                        {link.name}
                      </a>
                    ))}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {intelligence ? <BookFirstSection intel={intelligence} {...(tripId ? { tripId } : {})} booked={booked} itinerary={itinerary} honored={bookedHonored} conflicts={bookedConflicts} resolutions={resolutions} view="book-first" /> : null}
      {intelligence ? <BeforeYouGoSection intel={intelligence} {...(tripId ? { tripId } : {})} readinessProfile={readinessProfile} checks={checks.checklist} /> : null}
      {intelligence ? <PackSection intel={intelligence} {...(tripId ? { tripId } : {})} checks={checks.packing} /> : null}
      <section className="mt-14" aria-labelledby="backups" data-testid="hub-backups-section">
        <div className="rule-strong pt-5 scroll-mt-[calc(var(--chrome-height)+4.5rem)]" id="backups">
          <h2 className="display-md text-ink">Backups</h2>
          <p className="mt-1.5 max-w-2xl type-small text-ink-muted">Plan A is the day as written. Each day carries its own fallback, the stops that can move, and the moment to decide.</p>
        </div>
        <div data-print="appendix">
          <WeatherPlan itinerary={itinerary} {...(timeZone ? { timeZone } : {})} />
        </div>
        {intelligence ? (
          <div data-testid="backups">
            <BackupsSection intel={intelligence} />
          </div>
        ) : null}
        <KeepFlexible itinerary={itinerary} />
      </section>
      {/*
        V6 — THE LAST PAGE OF THE PACKET.
        Everything the plan itself says has to be settled or looked at again,
        in one place, on paper as well as on screen. The band carries the first
        two; this carries all of them, with the dates worth a second look.
      */}
      <CriticalChecks feasibility={feasibility} manifest={recheck} />
      <div data-print="appendix">{intelligence ? <CritiquePanel intel={intelligence} /> : null}</div>
      {/*
        * PRODUCTION LOCK V5 §27 — CONFIDENCE IS RENDERED ONCE.
        *
        * A standalone `TripConfidence` used to sit directly above
        * `VerifySection`, which renders its own. Both printed, fifteen lines
        * apart, with different numbers — "0 / 13" here and "0 / 0" there,
        * because the second was passed no package. Two counts of the same thing
        * is worse than either count alone: a reader cannot tell which is real.
        *
        * `VerifySection` is the one place now, and it is given the package.
        * Where there is no intelligence yet there is nothing to be confident
        * about, so nothing renders — which is also why the bare
        * `TripConfidence` had no reason to exist.
        */}
      <section className="mt-14 rule-strong pt-5" aria-labelledby="verify" data-testid="hub-verify-section" data-print="appendix">
        <div id="verify" className="scroll-mt-[calc(var(--chrome-height)+4.5rem)]" />
        {intelligence ? <VerifySection intel={intelligence} manifest={recheck} pkg={itinerary.package} /> : <TripConfidence pkg={itinerary.package} intel={null} compact />}
      </section>
      {/* EXPERIENCE V2 — everything evaluative or archival is one disclosure, never eight open sections. */}
      <details className="mt-10 rule-top pt-4" data-testid="prepare-notes-disclosure" data-print="appendix">
        <summary className="min-h-11 cursor-pointer list-none type-body text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="font-display text-xl text-ink">Notes, alternatives and what was left out</span>
          <span className="ml-3 type-small">the plan's own notes, places considered, and what did not fit</span>
        </summary>
        {worthSkipping.length > 0 ? (
          <section className="mt-8 rule-top pt-6" data-print="appendix">
            <h2 className="type-section text-ink">Worth skipping</h2>
            <p className="mt-1 type-small text-ink-muted">Popular or nearby, and still a poor match for how you said you travel. Skipping them is a decision, not an oversight.</p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {worthSkipping.map((entry) => (
                <li key={entry.name} className="rule-top pt-3 text-sm">
                  <span className="font-medium text-ink">{entry.name}</span>
                  <span className="mt-0.5 block text-ink-muted">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <PreparationHub itinerary={itinerary} preparation={preparation} verifiedAreas={lodgingAreas} hasIntelligence={Boolean(intelligence)} />
        {itinerary.package ? <ConsideredPanel pkg={itinerary.package} /> : null}
        {dropped.length > 0 ? (
          <section className="mt-14 rule-top pt-8" data-print="appendix">
            <h2 className="type-section text-ink">{droppedHeading(dropped)}</h2>
            <p className="mt-1 type-small text-ink-muted">{droppedBlurb(dropped)}</p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {dropped.map((entry) => (
                <li key={entry.placeId} className="rule-top pt-3 text-sm">
                  <span className="font-medium text-ink">{entry.name}</span>
                  <span className="mt-0.5 block text-ink-muted">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {openIssues.length > 0 ? (
          <section className="mt-14 rule-top pt-8" data-print="appendix">
            <h2 className="type-section text-ink">Worth reading</h2>
            <ul className="mt-4 space-y-2">
              {openIssues.map((issue, index) => (
                <li key={`${issue.code}-${index}`} className="flex gap-2 text-sm">
                  <span aria-hidden="true" className={cx(issue.severity === 'error' ? 'text-clay' : 'text-amber')}>
                    ▲
                  </span>
                  <span className="text-ink-muted">
                    {issue.message}
                    {issue.wasResolvedByRemoval ? <span className="text-ink-faint"> We took it off the plan rather than leave it in — nothing above depends on it.</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {itinerary.diagnostics.revisions.length > 0 ? (
          <footer className="mt-14 rule-top pt-6 text-xs leading-relaxed text-ink-faint" data-print="appendix">
            Adjusted {itinerary.diagnostics.revisions.length} {itinerary.diagnostics.revisions.length === 1 ? 'time' : 'times'} while planning:{' '}
            {itinerary.diagnostics.revisions.map((revision) => revision.description).join(' ')}
          </footer>
        ) : null}
      </details>
      {/* V9 §14 — the paper packet's last pages: addresses, map links as text, booking status, never a reference. Print only. */}
      <PrintAppendix itinerary={itinerary} booked={booked} intelligence={intelligence ?? null} coordinates={coordinates} resolutions={tripId ? resolutions : []} {...(tripId ? { tripId } : {})} />
    </div>
  );

  /*
   * PRODUCTION LOCK V5 §31 — THE HERO NAMES THE DESTINATION, NOT THE BED.
   *
   * A live Hong Kong build titled the finished trip "Sheung Wan / Central, Hong
   * Kong Island", because a single-base trip used its base as the headline. That
   * is where the traveller sleeps; it is not where they are going, and it is not
   * what they typed. Nobody tells a friend they are going to Sheung Wan.
   *
   * So the destination leads whenever there is one, single-base or not, and the
   * base moves to the subline where it already lives ("Based in …"). The base is
   * still the title for a trip with no destination name at all — a shared plan,
   * or a row from before the destination was recorded — because a heading has to
   * say something.
   */
  const titleNode = destinationName ? destinationName : <PlaceName entity={baseEntity} />;
  const eyebrow = (
    <>
      {tripId ? null : <>Shared with you · </>}
      {dateLabel} · {itinerary.days.length} days · {stopCount} stops
      {multiBase ? <> · {itinerary.package!.bases.length} bases</> : null}
      {tripId && savedToAccount ? (
        <span data-testid="saved-to-account"> · Saved to your Sidequest account</span>
      ) : null}
    </>
  );
  /*
   * V6 §12 — THE BAND SAYS WHAT THE FEASIBILITY REPORT SAYS.
   *
   * "Ready" used to be a function of the stored itinerary status, which is a
   * function of how much was verified. The deterministic report asks a
   * different question of every day — can it be done — and its four words are
   * the only ones the band may use when it has one. V11 §9: the band takes the
   * verdict's sentence and nothing else -- the items it used to list are on
   * Prepare, where they can be acted on rather than only read.
   */
  /*
   * V11 §4 §39 — the headline asks whose work is outstanding. "Needs a decision"
   * is right for a choice and wrong for a geocoder that has not answered, which
   * is what a founder trip put under that word three times.
   */
  const verdict = feasibility ? feasibilityHeadline(feasibility) : null;
  const statusTone: 'ready' | 'caution' | 'blocked' | 'neutral' = feasibility
    ? feasibility.verdict === 'feasible'
      ? 'ready'
      : feasibility.verdict === 'feasible_with_cautions'
        ? 'caution'
        : 'blocked'
    : itinerary.status === 'ready'
      ? 'ready'
      : itinerary.status === 'ready_with_cautions'
        ? 'caution'
        : itinerary.status === 'needs_decision'
          ? 'blocked'
          : 'neutral';
  /*
   * V11 §9 — THE HERO STATES THE TRIP'S CONDITION AND STOPS.
   *
   * The band used to list the first two feasibility items in full — a
   * diagnostic list inside a masthead, which is §9's "do not dump every warning
   * into the hero" and part of why the baseline measured it at 440 px on a
   * desktop and 763 px on a 780 px phone. It now carries the verdict's own
   * sentence and nothing else: the Prepare tab already shows the count as a
   * badge, and the items themselves are on Prepare, where they can be acted on.
   */

  /*
   * WHO IS GOING, from the one place on this page that counts the party. The
   * readiness layer raises the minors question only when somebody under age is
   * travelling, so it is the honest signal for "with children" without this
   * component reaching into the trip record.
   */
  const travellerCount = intelligence?.budget.travellers ?? null;
  const withChildren = intelligence?.readiness.entries.some((entry) => entry.kind === 'minor_documents') ?? false;
  const heroFacts: AtlasFact[] = [];
  if (travellerCount) heroFacts.push({ label: 'Who', value: `${travellerCount} ${travellerCount === 1 ? 'traveller' : 'travellers'}${withChildren ? ', with children' : ''}` });
  /*
   * The band states what kind of trip this is — unless the overview's headline
   * is already that same sentence, which is what happens when a traveller's
   * profile line and the draft's purpose coincide. One page must not print one
   * sentence twice, and the overview owns the big statement.
   */
  if (purpose && !sameSentence(firstSentence(purpose), firstSentence(headline))) heroFacts.push({ label: 'The trip', value: fixNumberArticles(firstSentence(purpose)) });

  /* A photograph of somewhere on this trip, as the band's ground. Never a stock picture. */
  const bandHero = itinerary.days.map((day) => dayIdentity(day, images, rationale, livePhotos).hero).find((entry) => entry !== null) ?? null;
  const bandFigure = bandHero
    ? placeFrame(bandHero.placeId, bandHero.name, images, livePhotos, rationale, '16 / 9', {
        credit: false,
        className: 'atlas-figure-fill h-full',
      })
    : null;

  return (
    <div className="mx-auto max-w-[1600px] px-5 pt-4 pb-8 sm:px-6 sm:pt-5 sm:pb-10">
      <AtlasBand
        eyebrow={eyebrow}
        title={
          <a href="#overview" className="hover:underline hover:underline-offset-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-route-bright)]" data-testid="hub-overview-link">
            {titleNode}
          </a>
        }
        subline={multiBase ? <>{itinerary.transportStrategy.headline}</> : <>Based in <PlaceName entity={baseEntity} showLocal={false} /> · {itinerary.transportStrategy.headline}</>}
        route={multiBase ? <BaseSequence bases={baseSequence} variant="atlas" testId="hero-route" /> : undefined}
        facts={heroFacts}
        {...(bandFigure ? { figure: bandFigure } : {})}
        {...(verdict?.blurb ? { attention: { heading: verdict.blurb, items: [] } } : {})}
        status={{ label: verdict?.label ?? status.label, tone: statusTone }}
        actions={
          /*
           * V11 §9 — ONE ACTION IN THE HERO, AND ONE PLACE FOR THE REST.
           *
           * The band carried seven buttons of identical weight — Print, Take it
           * with you, Calendar, Share, Back to the board, Regenerate, More — so
           * it had no primary action at all, and the baseline walk measured the
           * hero at 440 px with twenty-one actions above the fold on this page.
           * A traveller opening a finished plan wants one thing, and which one
           * depends on whether the trip has started: Today while they are on it,
           * otherwise the copy they take with them.
           *
           * Nothing is removed. The other six move into the `More` menu that
           * already existed for exactly this purpose — a `<details>`, so the
           * overflow needs no client state and works before hydration.
           */
          <>
            {tripId && today?.active ? (
              <Link href={`/trips/${tripId}/today`} className={atlasButtonClass('primary')} data-testid="open-today">
                Today
              </Link>
            ) : tripId ? (
              <Link href={`/trips/${tripId}/pack`} className={atlasButtonClass('primary')} data-testid="open-pack">
                Take it with you
              </Link>
            ) : null}
            {tripId ? (
              <details className="relative">
                <summary className={cx(atlasButtonClass(), 'list-none cursor-pointer [&::-webkit-details-marker]:hidden')}>More</summary>
                <div className="absolute right-0 z-10 mt-1 flex min-w-60 flex-col gap-1 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-2 text-ink shadow-[var(--shadow-panel)] sm:left-0 sm:right-auto">
                  {today?.active ? (
                    <Link href={`/trips/${tripId}/pack`} className={buttonClass('ghost', 'sm')} data-testid="open-pack">
                      Take it with you
                    </Link>
                  ) : null}
                  <PrintButton />
                  <a href={`/trips/${tripId}/itinerary/calendar`} download className={buttonClass('ghost', 'sm')}>
                    Calendar file (.ics)
                  </a>
                  <ShareControl tripId={tripId} />
                  {boardAvailable ? (
                    <Link href={`/trips/${tripId}/discover`} className={buttonClass('ghost', 'sm')}>
                      Back to the board
                    </Link>
                  ) : null}
                  <Link href={`/trips/${tripId}/questionnaire`} className={buttonClass('ghost', 'sm')}>
                    Change my answers
                  </Link>
                  {itinerary.package ? <RegenerateButton tripId={tripId} /> : null}
                  <a href={`/trips/${tripId}/itinerary?appendix=1`} className={buttonClass('ghost', 'sm')}>
                    Print with evidence appendix
                  </a>
                </div>
              </details>
            ) : (
              <PrintButton />
            )}
          </>
        }
      />
      {/* Opens every disclosure marked for the packet before print, closes them after. */}
      <PrintExpand />

      <HubShell
        views={{ overview, days, map: mapView, plan, book, prepare }}
        badges={{ days: itinerary.days.length, ...(openRequired > 0 ? { book: openRequired } : {}), ...(attentionCount > 0 ? { prepare: attentionCount } : {}) }}
        printAppendix={printAppendix}
        initialView={initialView}
        askSlot={Boolean(tripId)}
      />

      {attributions.length > 0 ? (
        <p data-testid="itinerary-attribution" className="mt-10 rule-top pt-6 text-xs leading-relaxed text-ink-faint">
          {attributions.join(' · ')}. Place data is normalised from these sources; the plan, the timings and the reasoning are ours.
        </p>
      ) : null}
    </div>
  );
}

function overviewMapModel(itinerary: Itinerary, coordinates: Record<string, { lat: number; lng: number }>, rationale: Record<string, StopRationale>) {
  const markers: (MapMarker & { dayNumber: number })[] = [];
  const seen = new Set<string>();
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      const point = coordinates[item.placeId];
      if (!point || seen.has(item.placeId)) continue;
      seen.add(item.placeId);
      markers.push({ id: item.placeId, name: rationale[item.placeId]?.name ?? item.title, coordinates: point, kind: 'place', chosen: true, dayNumber: day.dayNumber });
    }
  }
  const baseIds = [...new Set(itinerary.days.map((day) => day.baseId))];
  const bases = baseIds.map((id) => ({ id, name: itinerary.days.find((day) => day.baseId === id)?.baseName ?? 'base', point: coordinates[id] ?? null }));
  for (const base of bases) {
    if (base.point && !seen.has(base.id)) {
      seen.add(base.id);
      markers.push({ id: base.id, name: base.name, coordinates: base.point, kind: 'base', dayNumber: itinerary.days.find((day) => day.baseId === base.id)?.dayNumber ?? 1 });
    }
  }
  const connectors: MapConnector[] = [];
  for (let i = 1; i < bases.length; i += 1) {
    const from = bases[i - 1]!.point;
    const to = bases[i]!.point;
    if (!from || !to) continue;
    const transferItems = itinerary.days
      .filter((day) => day.baseId === bases[i]!.id)
      .flatMap((day) => day.items)
      .filter((item) => item.kind === 'travel' && item.travel?.role === 'transfer');
    const transfer = (transferItems.find((item) => item.travel!.provenance === 'measured' || item.travel!.provenance === 'estimated') ?? transferItems[0])?.travel;
    const path = transfer?.provenance === 'measured' && transfer.geometry ? decodeShape(transfer.geometry) : undefined;
    /* V7 §14 — a move by boat, train or air is drawn as one, whether or not a router could time it. */
    const style: MapConnector['style'] =
      transfer?.episodeMode === 'boat' || transfer?.mode === 'ferry' || transfer?.hint === 'ferry'
        ? 'boat'
        : transfer?.hint === 'flight'
          ? 'flight'
          : transfer?.episodeMode === 'rail' || transfer?.mode === 'rail' || transfer?.hint === 'high_speed_rail'
            ? 'rail'
            : !transfer || transfer.provenance === 'unmeasured'
              ? 'unmeasured'
              : transfer.provenance === 'estimated'
                ? 'estimated'
                : transfer.mode === 'walk'
                  ? 'measured_walk'
                  : transfer.mode === 'public_bus'
                    ? 'measured_transit'
                    : 'measured_drive';
    connectors.push({ id: `move-${i}`, from, to, style, ...(path ? { path } : {}) });
  }
  const primaryBase = bases[0]?.point ? { name: bases[0].name, coordinates: bases[0].point } : null;
  const summary = `${markers.filter((m) => m.kind === 'place').length} placed stops across ${itinerary.days.length} days${bases.length > 1 ? `, moving between ${bases.length} bases` : ''}.`;
  return { markers, connectors, primaryBase, summary };
}

function WhereToStayLegacy({ areas }: { areas: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[] }) {
  return (
    <section className="mt-14 rule-top pt-8">
      <h2 className="display-md text-ink">Where to stay</h2>
      <p className="mt-1 type-small text-ink-muted">Areas, not hotels. Which part of the map puts you closest to the days above.</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {areas.map((area) => (
          <li key={area.name} className="rule-top pt-3 text-sm">
            <span className="font-medium text-ink">{area.name}</span>
            <span className="mt-0.5 block text-ink-muted">{area.rationale}</span>
            {area.tradeoffs.length > 0 ? <span className="mt-1.5 block text-ink-muted">{area.tradeoffs.join(' · ')}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}


/**
 * The trip's transportation position.
 *
 * Reads as an editorial page rather than a dashboard: a recommendation, the
 * reasoning behind it, what it costs, and what to check. The numbers are
 * deliberately coarse and the disclosure is not tucked away, because a modelled
 * drive time presented with a dashboard's confidence is worse than no number.
 */
/**
 * The trip's weather position, in one panel.
 *
 * Its only real job is to name the kind of knowledge behind the plan before the
 * traveller reads a single number. A trip planned three days out and one planned
 * six months out are both perfectly useful and they are not the same product:
 * the first can say Thursday is the day for the ridge, the second can only say
 * what Augusts here are like. Rendering them identically would make the second
 * one a lie.
 */
function WeatherPlan({ itinerary, timeZone }: { itinerary: Itinerary; timeZone?: string }) {
  const days = itinerary.days;
  const kinds = [...new Set(days.map((day) => day.weather.evidence))];
  /*
   * AN ATTRIBUTION BELONGS TO A SOURCE, NOT TO A DAY.
   *
   * This took the first day carrying *any* attribution, which on almost every
   * trip is day 1 — the arrival day, usually `evidence: 'unavailable'`, whose
   * attribution is the sentence "nothing here has been checked against the
   * weather". So a plan that had just listed three things the forecast moved
   * printed "Nothing here has been checked against the weather" directly
   * underneath them.
   *
   * The distinct attributions of the days that were actually checked, joined;
   * and the not-checked sentence only when no day was checked at all, which is
   * the one case where it is true.
   */
  const checked = days.filter((day) => day.weather.evidence !== 'unavailable');
  const attributions = [
    ...new Set(
      (checked.length > 0 ? checked : days)
        .map((day) => day.weather.attribution)
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  const attribution = attributions.length > 0 ? attributions.join(' · ') : undefined;
  const points = [
    ...new Set(days.map((day) => day.weather.locationLabel).filter(Boolean)),
  ] as string[];
  const fetchedAt = days.find((day) => day.weather.fetchedAt)?.weather.fetchedAt;
  const decisions = days.flatMap((day) => day.weather.decisions);
  const label =
    kinds.length > 1
      ? /* V11 §20 */ 'Some checked, some not'
      : kinds[0] === 'forecast'
        ? 'Forecast'
        : kinds[0] === 'historical_pattern'
          ? 'Historical pattern'
          : 'No weather data';

  return (
    <Panel className="card mt-6 p-6" as="section">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 className="type-section text-ink">Weather</h2>
        <Badge tone={kinds.includes('forecast') ? 'blue' : 'neutral'}>{label}</Badge>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        {/*
          Branching on what is actually mixed, not merely on there being more
          than one kind. A five-day trip wholly inside the horizon with one date
          the provider skipped is `['forecast','unavailable']` — and telling that
          traveller "part of this trip is beyond the forecast window" is untrue
          and, worse, hides the real problem, which is a missing day.
        */}
        {kinds.includes('historical_pattern') && kinds.includes('forecast')
          ? 'Part of this trip is inside the forecast window and part of it is not. The days that have a forecast are marked as such; the rest carry what this time of year usually does, which is not the same thing.'
          : kinds.length > 1 && kinds.includes('unavailable')
            ? 'We could not get weather for every day of this trip. The days we could are marked; the rest have not been checked against anything, and we have not guessed.'
            : kinds[0] === 'forecast'
            ? 'Your dates are inside the forecast window, so the days below were placed against an actual forecast for each one.'
            : kinds[0] === 'historical_pattern'
              ? 'Your dates are too far out for a forecast. The days below carry what this period has historically done here — useful for what to pack and what to have in reserve, and no help at all in telling one of your days from another. We have not moved anything on the strength of it.'
              : 'We could not reach a weather source for your dates, so nothing in this plan has been placed against one. Rebuild closer to the time.'}
      </p>

      {/*
        Only where there is weather to explain. With none, this paragraph is a
        lecture about elevation attached to four days of "we do not know".
      */}
      {points.length > 0 && kinds.some((kind) => kind !== 'unavailable') ? (
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          {/*
            The count is real information — the region was not treated as one
            number — and it stays. The *names* are only printed when they name
            something: the forecast layer mints "Forecast point 3", an index a
            traveller cannot put on a map, and a live plan listed two of them
            here verbatim. See `isMachineWeatherLabel`.
          */}
          Taken at {points.length === 1 ? 'one point' : `${points.length} separate points`}
          {(() => {
            const named = points.filter((point) => !isMachineWeatherLabel(point));
            return named.length > 0 ? `: ${named.join(', ')}` : ' across the area';
          })()}
          . Somewhere that spans a range of elevations or a coastline
          can differ by several degrees across it, so one number for the whole region would
          be wrong at both ends.
        </p>
      ) : null}

      {decisions.length > 0 ? (
        <div className="mt-5 rounded-lg bg-paper-sunk p-4">
          <p className="text-xs font-medium text-ink">What the weather changed</p>
          <ul className="mt-1 space-y-1 text-sm leading-relaxed text-ink-muted">
            {decisions.map((decision) => (
              <li key={decision}>{decision}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-5 type-meta">
        {travellerVoice(attribution ?? 'No weather source was reached for this trip.')}
        {fetchedAt ? ` Read ${formatReadAt(fetchedAt, timeZone)}.` : ''} Conditions change; we
        have not checked today.
      </p>
    </Panel>
  );
}

/**
 * When the forecast was read, in the wall-clock time of the place it describes.
 *
 * `toUTCString()` printed "Thu, 30 Jul 2026 22:12:00 GMT" on a product whose
 * entire time model is wall-clock where you are standing — but the fix for that
 * was a hard-coded Californian zone, which is the same defect pointed the other
 * way. The zone comes from the trip's own base now, and a trip whose artifact
 * predates that says UTC rather than pretending.
 */
function formatReadAt(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: timeZone ?? 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TransportPlan({ strategy }: { strategy: TransportStrategy }) {
  const { totals } = strategy;

  return (
    /*
      ONE RULE, NOT TWO.

      The trip header already closes with `border-b`, and this section opened
      with `border-t` 36 pixels below it — two hairlines with nothing between
      them but whitespace, on screen and on paper. A rule is punctuation; two in
      a row is a stammer. The header's rule is the one that stays, because it is
      the one that belongs to a thing (the header) rather than to a gap.
    */
    <section className="mt-10" aria-labelledby="transport-plan">
      <h2 id="transport-plan" className="font-display text-xl text-ink">
        Getting around
      </h2>
      <p className="mt-2 max-w-2xl text-ink-muted">{strategy.headline}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Badge tone="pine">{TRANSPORT_MODE_LABELS[strategy.primaryMode]}</Badge>
        {strategy.secondaryMode ? (
          <Badge tone="blue">plus {TRANSPORT_MODE_LABELS[strategy.secondaryMode].toLowerCase()}</Badge>
        ) : (
          <Badge>no practical alternative</Badge>
        )}
        {/*
          Words, not enum values. "low stress" happened to read as English;
          "low convenience" read as a verdict delivered in machine, about a plan
          the traveller was just handed, with nothing to act on. Each label says
          what the value means for their days.
        */}
        <Badge tone={STRESS_TONE[strategy.stress]}>{STRESS_LABELS[strategy.stress]}</Badge>
        <Badge tone={CONVENIENCE_TONE[strategy.convenience]}>
          {CONVENIENCE_LABELS[strategy.convenience]}
        </Badge>
      </div>

      {/*
        A METRIC ONLY WHERE THERE IS SOMETHING TO MEASURE.

        These four used to render unconditionally, so a traveller who told us
        they had no car opened their finished plan and read "At the wheel: 0 min"
        and "Road distance: 0 km" — two confident measurements of a mode they
        explicitly declined, in a row that reads as a dashboard. `formatMinutes(0)`
        returns "0 min", which is a number, and a number is a claim.

        The rule is the one the progress screen already follows: a figure nobody
        measured is absent, not zero.
      */}
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        {totals.driveMinutes > 0 ? (
          <Metric label="At the wheel">{travelSpan(totals.driveMinutes)}</Metric>
        ) : null}
        {totals.transitMinutes + totals.waitMinutes > 0 ? (
          <Metric label="Riding & waiting">
            {travelSpan(totals.transitMinutes + totals.waitMinutes)}
          </Metric>
        ) : null}
        {totals.walkMinutes > 0 ? (
          <Metric label="On foot to reach things">{travelSpan(totals.walkMinutes)}</Metric>
        ) : null}
        {/*
          THE MINUTES THAT BELONG TO NO MODE.

          This panel read "ON FOOT TO REACH THINGS 6 hr 10 min" on a trip whose
          long legs were every one of them a walking figure standing in for a
          train nobody could time — the same total the day headers, the split
          line and the trip summary all repeated, to a traveller who had said
          they would walk twenty-five minutes. Those minutes are real and the
          plan holds them, so they are still measured here; what they are not is
          a mode, and this is the row that says so instead of the one above.
        */}
        {totals.unverifiedMinutes > 0 ? (
          <Metric label="Held for unverified journeys">{travelSpan(totals.unverifiedMinutes)}</Metric>
        ) : null}
        {totals.driveKm >= 0.5 ? (
          <Metric label="Road distance">{Math.round(totals.driveKm)} km</Metric>
        ) : null}
      </dl>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium text-ink">Why this way</h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {strategy.rationale.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        {strategy.tradeoffs.length > 0 ? (
          <div>
            <h3 className="text-sm font-medium text-ink">What it costs you</h3>
            <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
              {strategy.tradeoffs.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <dl className="mt-6 space-y-3 text-sm">
        <Detail label="Parking">{strategy.parkingSummary}</Detail>
        <Detail label="Public transport">{strategy.transitSummary}</Detail>
        {strategy.withoutPrimary ? (
          <Detail label="Without a car">{strategy.withoutPrimary}</Detail>
        ) : null}
      </dl>

      {strategy.seasonalWarnings.length > 0 ? (
        <div className="mt-5 rounded-lg bg-amber-soft p-4">
          <h3 className="text-sm font-medium text-ink">Seasonal limits</h3>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-muted">
            {strategy.seasonalWarnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {strategy.verifyBeforeTravel.length > 0 ? (
        <div className="mt-3 rounded-lg border border-clay p-4">
          <h3 className="text-sm font-medium text-clay">Check these before you book</h3>
          <p className="mt-1 text-xs text-ink-faint">
            These change year to year. We have not checked today&rsquo;s conditions.
          </p>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
            {strategy.verifyBeforeTravel.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        The same disclosure, addressed to the traveller rather than to whoever
        maintains the routing layer. `travellerVoice` never removes a caveat —
        see `plan-language.ts`.
      */}
      <p className="mt-4 text-xs leading-relaxed text-ink-faint">
        {travellerVoice(strategy.dataDisclosure)}
      </p>
    </section>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * What to say about where a leg's duration came from.
 *
 * One sentence per provenance, and the important one is the last. "Estimated
 * travel time" was previously printed against a constant that no source stood
 * behind, and a traveller cannot tell that apart from "roughly measured" — so a
 * leg nobody timed now says nobody timed it, and says what would fix that.
 */
function travelProvenanceLabel(travel: TravelSegment): string {
  /*
   * Asked before the provenance, because on this one leg the provenance is
   * about the wrong journey. "Modelled travel time" is true of the walk and
   * says nothing about the scheduled route the walk stands in for — and the
   * walking figure is the one real number on the row, so what it needs is the
   * question it answers, not the confidence behind it.
   */
  if (travel.unverifiedScheduled) {
    return 'route not verified — the walking time shown is the upper bound we hold for it';
  }
  switch (travel.provenance) {
    case 'measured':
      return 'measured travel time';
    case 'official':
      return 'published timetable';
    case 'modelled':
      return 'modelled travel time';
    case 'estimated':
      return 'estimated travel time';
    case 'unmeasured':
      switch (travel.unmeasuredReason) {
        case 'mode_not_routed':
          return 'travel time not measured — we have no route data for this way of travelling';
        case 'no_route_found':
          return 'travel time not measured — no route was found between these two points';
        case 'operator_unpublished':
          return 'travel time not measured — the operator does not publish one';
        default:
          return 'travel time not measured';
      }
  }
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sm:flex sm:gap-4">
      <dt className="shrink-0 text-ink-faint sm:w-40">{label}</dt>
      <dd className="text-ink-muted">{children}</dd>
    </div>
  );
}

/**
 * The day's transport as a sequence, not a table.
 *
 * "Drive → park → shuttle → walk → back" is the thing a traveller actually has
 * to execute, and reading it as one line is worth more than four accurate
 * numbers. The numbers sit underneath for anyone who wants them.
 */
function DayTransport({ day }: { day: ItineraryDay }) {
  const sequence = accessSequence(day);
  const { totals, transport } = day;
  const split = [
    totals.driveMinutes > 0 ? `${travelSpan(totals.driveMinutes)} driving` : null,
    totals.transitMinutes > 0 ? `${travelSpan(totals.transitMinutes)} riding` : null,
    totals.walkMinutes > 0 ? `${travelSpan(totals.walkMinutes)} walking there` : null,
    totals.waitMinutes > 0 ? `${travelSpan(totals.waitMinutes)} waiting` : null,
    /*
     * Its own clause, in the day's own breakdown, because the breakdown is
     * where a reader goes to find out what the travelling figure above is made
     * of. A day that held two hours for journeys nobody could price read "2 hr
     * walking there" here, which is the one thing those minutes are not.
     */
    totals.unverifiedMinutes > 0
      ? `${travelSpan(totals.unverifiedMinutes)} held for journeys we could not verify`
      : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <div className="mt-2">
      {/*
        A real list, so a screen reader announces "list, 6 items" and reads them
        one at a time. As bare spans with an aria-hidden arrow between them the
        steps ran together into a single unpunctuated phrase.
      */}
      {sequence.length > 1 ? (
        <ol
          aria-label={`How this day moves: ${sequence.join(', then ')}`}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-muted"
        >
          {sequence.map((step, index) => (
            <li key={`${step}-${index}`} className="flex items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden="true" className="text-ink-faint">
                  →
                </span>
              ) : null}
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {/*
        The split, as a sentence rather than four more chips.

        The day header now promotes one travel figure; this is the breakdown of
        it, and a breakdown is reference material. Four badges here made the
        header's own two badges indistinguishable from them.
      */}
      {split.length > 0 ? <p className="mt-1 text-xs text-ink-muted">{split.join(' · ')}</p> : null}

      {transport.lastReturnNote ? (
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{transport.lastReturnNote}</p>
      ) : null}
      {transport.parkingNotes.map((note) => (
        <p key={note} className="mt-1 text-xs leading-relaxed text-ink-faint">
          {travellerVoice(note)}
        </p>
      ))}
      {/*
        The rules' own prose — fares, boarding points, the exceptions that let you
        drive in. Folded away because it is long and only some of it applies on
        any given day, but present, because it is the part a traveller reads on
        the morning itself.
      */}
      {/* V6 §5 — a split day: who does what instead, and where everyone is together again. */}
      {day.split ? (
        <p className="mt-2 rounded-md border border-rule bg-paper-raised p-2.5 text-sm leading-relaxed text-ink" data-testid={`day-split-${day.dayNumber}`}>
          <span className="font-medium">{day.split.who}</span> {day.split.does}
          {day.split.rejoin ? <span className="text-ink-muted"> · Back together: {day.split.rejoin}</span> : null}
        </p>
      ) : null}
      {transport.accessNotes.length > 0 ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ink-faint hover:text-ink">
            How the access works ({transport.accessNotes.length})
          </summary>
          <ul className="mt-2 space-y-1 leading-relaxed text-ink-muted">
            {transport.accessNotes.map((note) => (
              <li key={note}>{travellerVoice(note)}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {transport.verifyBeforeTravel.length > 0 ? (
        <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
          {/*
            Through `travellerVoice`, because these sentences are stored on the
            artifact in the data layer's own words — a live plan printed "We
            know a routing engine can reach this" here. The translation keeps
            every claim and re-addresses it to the person travelling.
          */}
          Check before you go:{' '}
          {transport.verifyBeforeTravel.map((note) => travellerVoice(note)).join(' ')}
        </p>
      ) : null}
    </div>
  );
}

/** Collapses the day's legs into the shape of the journey, without repeats. */
function accessSequence(day: ItineraryDay): string[] {
  const steps: string[] = [];
  const push = (label: string) => {
    if (steps[steps.length - 1] !== label) steps.push(label);
  };

  for (const item of day.items) {
    if (item.kind === 'activity') {
      push('visit');
      continue;
    }
    if (item.kind !== 'travel' || !item.travel) continue;
    const { mode, role } = item.travel;
    /*
     * A leg whose mode is a stand-in has no step name in the mode vocabulary,
     * so it takes the mode-free one. The strip is read as the thing to execute
     * — "walk → visit → walk back" told somebody to set off on foot for a
     * journey the row above it had just said nobody could price.
     */
    if (item.travel.unverifiedScheduled) push(role === 'return' ? 'travel back' : 'travel');
    else if (role === 'wait') push('board');
    else if (role === 'walk') push('walk');
    // "back" comes from the leg's own role, not from whether anything has been
    // visited yet — otherwise every hop between two stops reads as a return.
    else if (role === 'return') push(`${TRANSPORT_MODE_LABELS[mode].toLowerCase()} back`);
    else push(TRANSPORT_MODE_LABELS[mode].toLowerCase());
  }
  return steps;
}

/**
 * What the day's opening hours did to its shape.
 *
 * Renders nothing at all on a day where nothing had a closing time, which is
 * most of them here. When it does render, the anchor comes first: "be at this
 * one by four, everything else can move" is the sentence a traveller can act on,
 * and it beats four rows of times for them to reconcile themselves.
 */
function DayHours({ day }: { day: ItineraryDay }) {
  const { availability } = day;
  /**
   * Only the two things the day as a whole can say that a single stop cannot:
   * which stop fixes its shape, and what has to be arranged before it works.
   *
   * The cautions and the verification notes live on the stops themselves, a few
   * centimetres below. Printing them here as well put the same sentence on the
   * screen twice, which reads as a template rather than as advice — they are
   * still persisted with the plan, for the day an export or a digest needs them
   * without the timeline.
   */
  const hasSomething = availability.anchorNote !== undefined || availability.bookings.length > 0;
  if (!hasSomething) return null;

  return (
    <section className="mt-3 border-t border-rule pt-3" aria-label={`Opening hours on day ${day.dayNumber}`}>
      {availability.anchorNote ? (
        <p className="text-sm leading-relaxed text-ink-muted">{availability.anchorNote}</p>
      ) : null}

      {availability.bookings.length > 0 ? (
        <div className="mt-2 rounded-md border border-clay/40 p-2.5">
          <p className="text-xs font-medium text-clay">
            {availability.bookings.length === 1
              ? 'One thing here needs arranging'
              : `${availability.bookings.length} things here need arranging`}
          </p>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
            {availability.bookings.map((booking) => (
              <li key={booking.placeId}>
                <span className="font-medium text-ink">{booking.name}</span> —{' '}
                {BOOKING_KIND_LABELS[booking.kind].toLowerCase()}. We have not made it for you.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The weather tone map, in the house vocabulary.
 *
 * pine = confirmed good, blue = an alternative worth knowing about, amber =
 * caution, clay = blocking. `workable` earns nothing at all, which is the point:
 * most days most of the time are simply fine, and a badge on every row is a
 * badge nobody reads.
 */
const WEATHER_TONE: Record<string, BadgeTone> = {
  favorable: 'pine',
  poor: 'amber',
  incompatible: 'clay',
  unknown: 'neutral',
  workable: 'neutral',
};

const WEATHER_BADGE: Record<string, string> = {
  favorable: 'Good weather for it',
  poor: 'Weather against it',
  incompatible: 'Not in this weather',
  unknown: 'No weather data',
  workable: '',
};

/**
 * What the weather did to this day, and where else to go if it turns.
 *
 * The evidence label is the load-bearing part and it is never omitted. "Forecast"
 * and "Historical pattern" are different claims — one is about Thursday, the
 * other about Augusts — and a reader who cannot tell which they are looking at
 * has been given a number without its meaning. So the label leads, the numbers
 * follow, and the attribution sits underneath in the same quiet type the
 * transport data disclosure uses.
 */
function DayWeather({ day, renderedAt }: { day: ItineraryDay; renderedAt: number }) {
  const { weather } = day;
  const stale =
    weather.evidence === 'forecast' && weather.fetchedAt
      ? renderedAt - Date.parse(weather.fetchedAt) > (weather.staleAfterMinutes ?? 360) * 60_000
      : false;
  if (weather.evidence === 'unavailable' && weather.backups.length === 0 && !weather.noBackupReason) return null;
  /*
   * PRODUCTION UI V1 — ONE COMPACT LINE PER DAY.
   * "≈ 14–16 °C historical · rain-prone · light until 21:20", with the trip's
   * seasonal paragraph said once under Prepare, not under every day. The
   * details (decisions, backups, attribution) stay behind a disclosure.
   */
  const temp = weather.temperatureMaxC !== undefined && weather.temperatureMinC !== undefined ? `${weather.evidence === 'forecast' ? '' : '≈ '}${Math.round(weather.temperatureMinC)}–${Math.round(weather.temperatureMaxC)} °C${weather.evidence === 'forecast' ? '' : ' historical'}` : null;
  const wet = weather.evidence === 'forecast' && weather.precipitationProbabilityPercent !== null && weather.precipitationProbabilityPercent !== undefined ? `${weather.precipitationProbabilityPercent}% rain` : weather.evidence === 'historical_pattern' && /(\d+)% of days in this period wet/.exec(weather.summary) ? (Number(/(\d+)% of days in this period wet/.exec(weather.summary)![1]) >= 35 ? 'rain-prone' : Number(/(\d+)% of days in this period wet/.exec(weather.summary)![1]) >= 15 ? 'some rain' : 'mostly dry') : null;
  // A sunset at or past 23:30 is polar light or a fixture; saying "light until 23:59" tells a traveller nothing.
  const light = weather.sunsetMinute !== undefined && weather.sunsetMinute < 23 * 60 + 30 ? `light until ${clock(weather.sunsetMinute, 'earlier')}` : null;
  const line = [temp, wet, light].filter(Boolean).join(' · ');
  const hasDetail = weather.decisions.length > 0 || weather.backups.length > 0 || Boolean(weather.noBackupReason);
  return (
    <section className="mt-3 rule-top pt-3" aria-label={`Weather on day ${day.dayNumber}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ink-muted">
        {/*
          V11 §8 — the basis is a word in the sentence, not a chip.

          Every day carried a "Typical" or "Forecast" pill saying the same thing
          as every other day, which is a chip that never varies within a trip and
          therefore carries no decision. It stays visible — a traveller must know
          whether a temperature is a forecast or a climate record — as the first
          words of the line it qualifies.
        */}
        <span className={cx('text-xs font-medium', weather.evidence === 'forecast' ? 'text-slate-blue' : 'text-ink-faint')}>
          {weather.evidence === 'forecast' ? 'Forecast' : weather.evidence === 'historical_pattern' ? 'Typical' : 'No weather data'}
        </span>
        {line ? <span className="numeral">{line}</span> : <span>{weather.summary}</span>}
        {weather.locationLabel && !isMachineWeatherLabel(weather.locationLabel) ? <span className="text-xs text-ink-faint">{weather.locationLabel}</span> : null}
        {stale ? <Badge tone="amber">Read a while ago</Badge> : null}
      </div>
      {hasDetail ? (
        <details className="mt-1.5">
          <summary className="min-h-9 cursor-pointer text-xs text-ink-faint hover:text-ink">What the weather changes on this day</summary>
          {weather.decisions.length > 0 ? (
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
              {weather.decisions.map((decision) => (
                <li key={decision}>{decision}</li>
              ))}
            </ul>
          ) : null}
          {weather.backups.length > 0 ? (
            <div className="mt-2 rounded-md border border-slate-blue/40 p-2.5">
              <p className="text-xs font-medium text-slate-blue">{weather.backups.length === 1 ? 'If it turns' : 'If it turns, either of these'}</p>
              <ul className="mt-1 space-y-1.5 text-xs leading-relaxed text-ink-muted">
                {weather.backups.map((backup) => (
                  <li key={backup.placeId}>
                    <span className="font-medium text-ink">{backup.name}</span> — {backup.why} {backup.openingSummary} {backup.accessSummary}
                    {backup.caution ? <span className="text-ink-faint"> {backup.caution}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {weather.noBackupReason ? (
            <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
              <span className="font-medium text-ink">No strong fallback for this one.</span> {weather.noBackupReason}
            </p>
          ) : null}
          <p className="mt-2 type-meta">{travellerVoice(weather.attribution)}</p>
        </details>
      ) : null}
    </section>
  );
}

/** V7 §9 — how an episode kind reads on a day. */
const EPISODE_KIND_WORD: Record<string, string> = {
  cruise: 'Cruise',
  trek: 'Trek',
  safari: 'Safari',
  sleeper_train: 'Sleeper train',
  expedition_boat: 'Expedition boat',
  guided_overland: 'Guided overland',
  road_trip_segment: 'Road trip',
  resort_stay: 'Resort stay',
  bike_tour: 'Bike tour',
  hut_to_hut: 'Hut to hut',
};

function DayCard({
  day,
  episode = null,
  renderedAt,
  coordinates,
  tripId,
  lockedPlaceIds,
  images,
  livePhotos = {},
  rationale,
  verification = {},
  isFirst,
  isLast,
  tiles = null,
  dayCount = 1,
  anchorRoles = {},
  anchorKinds = {},
  plannedOff = [],
  stateBadge = null,
  split = null,
}: {
  day: ItineraryDay;
  /** V9 §1 — where the day stands, read off the state graph. Null without a graph. */
  stateBadge?: React.ReactNode;
  /** V9 §17 — the day's split as a structure, when the day carries one. */
  split?: React.ReactNode;
  /** V7 §9 — the cruise, trek or safari this day sits inside, if any. */
  episode?: { name: string; kind: string; dayNumbers: number[]; mode: string } | null;
  renderedAt: number;
  coordinates: Record<string, { lat: number; lng: number }>;
  tiles?: MapBasemap | null;
  /** PRODUCTION UI V1 — what kind of thing each stop is; only a named place carries a verification chip. */
  anchorKinds?: Record<string, AnchorKind>;
  /** What the plan wanted on THIS day and could not schedule, with the reason. See `plannedOffByDay`. */
  plannedOff?: readonly { name: string; reason: string }[];
  /** LIVE WORLD V1 — how many days the plan has, for "move to day". */
  dayCount?: number;
  /** LIVE WORLD V1 — package roles by item/place id, for must-keep/optional. */
  anchorRoles?: Record<string, 'core' | 'secondary' | 'optional' | 'flex'>;
  /** What Sidequest could establish about each stop, by item id. See `TripPackage.anchors`. */
  verification?: Record<string, VerificationState>;
  /** Absent on the shared, read-only copy. See `ItineraryView`. */
  tripId?: string;
  lockedPlaceIds: ReadonlySet<string>;
  /** Licensed photographs by place id, read from a table by the page. */
  images: Record<string, ImageRecord>;
  /** MVP V3 — request-time place photographs by place id; empty unless configured. */
  livePhotos?: Record<string, string>;
  /** What the fit model said about each stop, by place id. See `StopRationale`. */
  rationale: Record<string, StopRationale>;
  /** Whether this is the arrival or the departure day, for the empty-day copy. */
  isFirst: boolean;
  isLast: boolean;
}) {
  /*
   * Empty means empty. A day carrying a meal, a transfer or a stop the
   * reconciler placed is not "nothing scheduled", whatever its activity total
   * says — the stale copy printed beside real content was a live defect.
   */
  const isEmpty = day.items.every((item) => item.kind === 'free_time');

  /**
   * The day's stops, in the order the plan puts them, for a map link.
   *
   * Built from the timeline rather than from the candidate list, so the link
   * follows the route that was actually scheduled. A stop whose coordinates the
   * compiled region does not carry is left out — and `dayRouteLinks` reports how
   * many, so the label can say the link is short rather than imply it is whole.
   */
  const stops = day.items
    .filter((item) => item.kind === 'activity' && item.placeId !== undefined)
    .map((item) => {
      const point = coordinates[item.placeId!];
      /*
       * The resolved name in the map link too. A link labelled in a script the
       * traveller cannot read is a link they cannot check.
       */
      const name = rationale[item.placeId!]?.name ?? item.title;
      return point ? { id: item.placeId!, name, ...point } : null;
    })
    .filter((stop): stop is { id: string; name: string; lat: number; lng: number } => stop !== null);

  /*
   * A day holding a journey nobody could price asks the map for transit.
   *
   * `day.transport.modes` carries no mode for such a leg — there is none to
   * carry — and the fallback below is walking, which would hand the traveller
   * an hour of walking directions for the exact journey this page has just told
   * them we could not time. A map app can price that route live, which is the
   * one thing this build could not do; asking it for the network we believe is
   * there beats asking it to route somebody on foot around it.
   */
  const links = dayRouteLinks(
    stops,
    day.totals.unverifiedMinutes > 0 ? 'transit' : mapModeFor(day.transport.modes),
  );

  /*
   * Everything the day needs in order to look like itself rather than like the
   * day above it. All of it derived from what is already scheduled — nothing is
   * fetched, nothing is invented, and a day with none of it renders none of it.
   */
  const identity = dayIdentity(day, images, rationale, livePhotos);
  const placedStops = stops.map((stop) => ({
    id: stop.id,
    name: stop.name,
    coordinates: { lat: stop.lat, lng: stop.lng },
  }));
  /*
   * The number on the map, by place. Numbered over the *placed* stops rather
   * than over every activity, because a drawing that skips a stop it cannot
   * position must not also skip a number — "1, 2, 4" on a map is a reader
   * hunting for a mark that was never drawn.
   */
  const mapNumbers: Record<string, number> = {};
  placedStops.forEach((stop, index) => {
    mapNumbers[stop.id] = index + 1;
  });
  const mapModel = dayMapModel({ day, coordinates, nameOf: (placeId, fallback) => rationale[placeId]?.name ?? fallback });
  const precisionByItem = timePrecisionByItem(day);
  const drivingMinutes = day.totals.driveMinutes + (day.transport.primaryMode === 'drive' || day.transport.modes.includes('drive') ? day.totals.estimatedMinutes : 0);
  const travelApprox = day.totals.estimatedMinutes > 0 || day.totals.allowanceMinutes > 0;
  const meaningfulStops = day.items.filter((item) => item.kind === 'activity').length;
  const weatherSensitive = day.items.some((item) => item.kind === 'activity' && item.weatherSensitive);

  /*
   * V6 — WHAT COMES BEFORE AND AFTER, AND HOW YOU GET THERE.
   *
   * The place sheet answers "where does this sit in my day", which needs the
   * two stops either side of it and the leg that reaches it. Both are read off
   * the timeline that is already on screen; nothing is fetched.
   */
  const sheetStops = day.items.filter((item) => item.kind === 'activity' || item.kind === 'meal');
  const nameOfItem = (item: ItineraryItem) => (item.placeId ? (rationale[item.placeId]?.name ?? item.title) : item.title);
  const neighbours: Record<string, { previous?: string; next?: string }> = {};
  sheetStops.forEach((item, index) => {
    const previous = sheetStops[index - 1];
    const next = sheetStops[index + 1];
    neighbours[item.id] = { ...(previous ? { previous: nameOfItem(previous) } : {}), ...(next ? { next: nameOfItem(next) } : {}) };
  });
  const arrivalLeg: Record<string, string> = {};
  {
    let pending: ItineraryItem | undefined;
    for (const item of day.items) {
      if (item.kind === 'travel') {
        pending = item;
        continue;
      }
      if (pending?.travel) arrivalLeg[item.id] = travelLine(pending);
      pending = undefined;
    }
  }

  /*
   * ONE CAVEAT PER DAY, SAID ONCE.
   *
   * The reconciler writes a sentence per uncertainty and the day used to print
   * every one of them in an amber strip: "3 stops on this day have not been
   * fully verified", "2 travel legs on this day are unmeasured", one under the
   * other, on eight days running. A traveller who reads that eight times has
   * learned to skip it. `compactWarnings` already separates the recurring
   * counts from the warnings that change what somebody does; the counts become
   * one line and the sentences keep their words.
   */
  const compacted = compactWarnings(day.warnings);
  const hoursUnchecked = day.items.filter((item) => item.kind === 'activity' && item.placeId && !item.hours && !item.operational).length;
  const caveat =
    compacted.badges.length > 0
      ? compacted.badges.map((badge) => badge.label).join(' · ')
      : hoursUnchecked > 0
        ? `Hours not checked for ${hoursUnchecked} ${hoursUnchecked === 1 ? 'stop' : 'stops'}`
        : null;

  const groups = groupByDayPart(day.items);
  const headed = partsAreMeaningful(groups);

  const row = (item: ItineraryItem) => (
    <li key={item.id}>
      <StopFocusHandle placeId={item.kind === 'activity' ? item.placeId : undefined}>
        <TimelineRow
          item={item}
          window={day.window}
          precision={precisionByItem[item.id] ?? 'measured'}
          {...(anchorKinds[item.id] ? { anchorKind: anchorKinds[item.id]! } : {})}
          {...(verification[item.id] ? { verification: verification[item.id]! } : {})}
          stopNumber={item.placeId ? (mapNumbers[item.placeId] ?? null) : null}
          dayNumber={day.dayNumber}
          dayLabel={`Day ${day.dayNumber} · ${humanDate(day.date)}`}
          neighbours={neighbours[item.id] ?? {}}
          {...(arrivalLeg[item.id] ? { arrival: arrivalLeg[item.id]! } : {})}
          frame={item.placeId ? placeFrame(item.placeId, rationale[item.placeId]?.name ?? item.title, images, livePhotos, rationale, '16 / 9') : null}
          /*
           * V8 — a licensed picture of the place beside its row, where one
           * exists and it is not already the day's own hero above. A fixed
           * square, so a row without one is the same height as a row with.
           */
          thumb={item.kind === 'activity' && item.placeId && item.placeId !== identity.hero?.placeId ? placeFrame(item.placeId, rationale[item.placeId]?.name ?? item.title, images, livePhotos, rationale, '1 / 1', { credit: false, className: 'w-14 overflow-hidden rounded-[var(--radius-control)] sm:w-16' }) : null}
          {...(item.placeId && coordinates[item.placeId] && verification[item.id] && verification[item.id] !== 'unverified'
            ? { navigation: placeNavigationLinks({ ...coordinates[item.placeId]!, name: item.title }) }
            : {})}
          {...(item.placeId && rationale[item.placeId] ? { rationale: rationale[item.placeId]! } : {})}
          menu={
            /*
             * Every stop is editable, including a model-authored one
             * nothing could verify (no `placeId`): the reconciled-plan
             * edits address a stop by its item id where it has no place.
             */
            tripId && item.kind === 'activity' && (item.placeId || verification[item.id]) ? (
              <StopEditMenu tripId={tripId} dayNumber={day.dayNumber} placeId={item.placeId ?? item.id} title={item.title} locked={item.placeId ? lockedPlaceIds.has(item.placeId) : false} />
            ) : undefined
          }
        />
        <RowHandoff item={item} coordinates={coordinates} verification={verification[item.id]} {...(tripId ? { tripId } : {})} dayNumber={day.dayNumber} dayCount={dayCount} role={anchorRoles[item.placeId ?? ''] ?? anchorRoles[item.id]} />
      </StopFocusHandle>
    </li>
  );

  return (
    <article className="card overflow-hidden" data-testid={`day-card-${day.dayNumber}`}>
      {/*
        THE DAY'S OWN COLOUR, ACROSS THE TOP OF IT.

        Eight days of identical cream panels is the §18 pattern applied to the
        one artifact a traveller actually carries. The hue is not decoration and
        is not a hash: it is `PLATE_HUE` for whatever kind of place the day is
        mostly made of, the same table the board's plates use — so a day of lakes
        is the colour lakes are on the board, and two days that are genuinely the
        same kind of day look the same on purpose. A day with nothing scheduled
        has no dominant anything and gets the rule colour.
      */}
      <div
        aria-hidden="true"
        className="h-1.5 w-full"
        style={
          identity.hue === null
            ? { background: 'var(--color-rule)' }
            : ({ '--plate-hue': identity.hue, background: 'hsl(var(--plate-hue) 30% 42%)' } as React.CSSProperties)
        }
      />
      {/*
        The anchor the day rail jumps to, with room above it for the two sticky
        elements — the product chrome and the rail itself — so a jump lands on
        the heading rather than under it.
      */}
      <div id={`day-${day.dayNumber}`} className="scroll-mt-[calc(var(--chrome-height)+4.5rem)]">
        {/*
          V8 — THE DAY AS A SCANNABLE CARD. Number and date as figures, the
          theme in the display face, where you sleep, the two chips that decide
          a day (how hard, how much moving), the day's own controls as real
          buttons, and — where one of the day's places has a licensed picture —
          that picture at a fixed ratio beside the header, never a stand-in.
        */}
        <div className={cx('grid gap-5 p-5 sm:p-6', identity.hero && 'md:grid-cols-[minmax(0,1fr)_13rem] lg:grid-cols-1 xl:grid-cols-[minmax(0,1fr)_13rem]')}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              {/*
                A separator that is part of the accessible name, not decoration.
                `Day 1` followed by `2026-08-12` with only a margin between them
                announced as "Day 12026-08-12". The middle dot is real text for
                exactly that reason, and the ISO value lives on the `<time>`
                where a machine can still read it.
              */}
              <h2 className="font-display text-3xl leading-none text-ink sm:text-4xl">
                Day {day.dayNumber}
                <span className="font-normal text-ink-faint">{' · '}</span>
                <time dateTime={day.date} className="type-figure text-base font-medium text-ink-muted">
                  {humanDate(day.date)}
                </time>
              </h2>
              <span className="type-figure text-sm text-ink-muted">
                {clock(day.window.startMinute, 'later')} – {clock(day.window.endMinute, 'earlier')}
              </span>
            </div>
            {/*
              The theme *and where you are sleeping*. On a multi-base trip the base
              is the single most consequential fact about a day and it appeared
              nowhere on the day — only in the trip header, which claims one base
              for the whole plan.
            */}
            <p className="mt-3 font-display text-xl leading-snug text-ink">{day.theme}</p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 type-small text-ink-muted">
              <span>
                <span aria-hidden="true" className="mr-1 text-ink-faint">⌂</span>
                {episode?.mode === 'boat' ? 'on board' : 'based in'} {day.baseName}
              </span>
              {/* V7 §9 — a day inside a cruise, trek or safari says so, and says which day of it this is. */}
              {episode ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-pine/40 bg-pine-soft px-2.5 py-0.5 text-xs font-medium text-pine-strong" data-testid={`day-episode-${day.dayNumber}`} data-episode-kind={episode.kind}>
                  {EPISODE_KIND_WORD[episode.kind] ?? episode.kind.replace(/_/g, ' ')} · day {episode.dayNumbers.indexOf(day.dayNumber) + 1} of {episode.dayNumbers.length} · {episode.name}
                </span>
              ) : null}
            </p>

            {/*
              V11 §8 — ONE LINE OF FACTS, NOT A CHIP CLUSTER.

              This was up to six chips — state, intensity, stops, travel,
              weather-sensitive, times-approximate — over a separate totals line,
              on every day. Five days of that is thirty-six chips before a
              traveller has read a single thing they will actually do, and the
              baseline walk counted **72 pills** on this surface.

              Chips are now reserved for the two facts that carry a decision: the
              day's own state, and a base move nobody could time — which is a
              blocker, not a nuance, and reads as one. Everything else is the
              sentence a person would say: "Intense · 2 stops · 1 hr 10 min
              drive · 3 hr at stops". Nothing is deleted; `title` keeps the
              precise wording on the two that had one, and the weather and
              timing detail live in the day's own uncertainty line and behind
              "How this day moves and eats".
            */}
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`day-facts-${day.dayNumber}`}>
              {stateBadge}
              {day.totals.unmeasuredMajorTransfer ? (
                <Badge tone="amber" title="This day moves base and the main transfer has not been measured, so the day cannot be timed yet">
                  main transfer not timed
                </Badge>
              ) : null}
              <p className="type-small text-ink-muted">
                {[
                  day.intensity,
                  meaningfulStops > 0 ? `${meaningfulStops} ${meaningfulStops === 1 ? 'stop' : 'stops'}` : null,
                  !day.totals.unmeasuredMajorTransfer && day.totals.travelMinutes > 0
                    ? `${travelApprox ? '≈' : ''}${travelSpan(drivingMinutes > 0 ? drivingMinutes : day.totals.travelMinutes)} ${drivingMinutes > 0 ? 'driving' : 'travelling'}`
                    : null,
                  day.totals.activityMinutes > 0 ? `${span(day.totals.activityMinutes)} at stops` : null,
                  day.totals.freeMinutes > 0 ? `${span(day.totals.freeMinutes)} free` : null,
                  day.totals.walkMinutes >= WALKING_DAY_MINUTES ? `${travelSpan(day.totals.walkMinutes)} on foot` : null,
                  weatherSensitive ? 'weather matters here' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>

            {/*
              One honest verb, only on days it can act on. A light day offered
              "make this easier" is a button that can only apologise.
            */}
            {tripId && ((day.intensity !== 'light' && day.totals.activityMinutes > 0) || itineraryHasPackage(day)) ? (
              <div className="mt-3 flex flex-wrap items-center gap-1 print:hidden" data-testid={`day-controls-${day.dayNumber}`}>
                {day.intensity !== 'light' && day.totals.activityMinutes > 0 ? <EaseDayButton tripId={tripId} dayNumber={day.dayNumber} /> : null}
                {itineraryHasPackage(day) ? <FixDayButton tripId={tripId} dayNumber={day.dayNumber} /> : null}
              </div>
            ) : null}
          </div>

          {identity.hero ? (
            /*
              A licensed photograph of one of the day's own stops, read from the
              same table the board reads. A fixed 4:3 plate so the header keeps
              its shape whether the picture has loaded, and never a generated
              stand-in for a specific place.
            */
            <figure className="m-0 min-w-0 self-start">
              <DestinationImage
                image={identity.hero.image}
                fallback={imageryFallbackFor({ kind: 'candidate', id: identity.hero.placeId, name: identity.hero.name })}
                ratio="4 / 3"
                credit="none"
                {...(identity.hero.livePhotoHref ? { livePhoto: { href: identity.hero.livePhotoHref, credit: 'Photo © Google' } } : {})}
                {...(identity.hero.category ? { category: identity.hero.category } : {})}
              />
              <figcaption className="mt-1.5 text-xs leading-snug text-ink-faint">
                {identity.hero.name}, on this day. {identity.hero.image ? <ImageCredit image={identity.hero.image} as="span" className="mt-0 inline" /> : identity.hero.livePhotoHref ? <span>Photo &copy; Google</span> : null}
              </figcaption>
            </figure>
          ) : null}
        </div>
        {split ? <div className="px-5 pb-5 sm:px-6">{split}</div> : null}

        <div className="border-t border-rule bg-paper-sunk/50 px-5 py-3 sm:px-6">
          <DayHours day={day} />
          <DayWeather day={day} renderedAt={renderedAt} />
          {day.window.note ? <p className="mt-2 type-small text-ink-muted">{day.window.note}</p> : null}
          {/*
            EXPERIENCE V2 — the working detail of the day (how it moves, the meals)
            waits behind one disclosure; the timeline is what a traveller reads
            first. The packet prints it open.
          */}
          {day.totals.travelMinutes > 0 || day.items.some((item) => item.food) ? (
            <details className="mt-2" data-print="open" data-testid={`day-notes-${day.dayNumber}`}>
              <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 type-small text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                <span aria-hidden="true" className="text-xs">▸</span> How this day moves and eats
              </summary>
              {day.totals.travelMinutes > 0 ? <DayTransport day={day} /> : null}
              <DayFood day={day} />
            </details>
          ) : null}
          {/*
            The drawing of the day, below `lg` where the sticky map is not
            rendered. It draws only stops whose position a source published.
          */}
          {placedStops.length > 0 ? (
            <div className="mt-3 lg:hidden print:hidden">
              <DayMap base={mapModel.base} markers={mapModel.markers} connectors={mapModel.connectors} omitted={mapModel.omitted} dayNumber={day.dayNumber} tiles={tiles} />
            </div>
          ) : null}
        </div>
      </div>

      {isEmpty ? (
        /*
          AN EMPTY DAY IS EXPLAINED BY WHICH DAY IT IS.

          This sentence was unconditional, so a completely blank Saturday in the
          middle of a five-day trip was captioned "on an arrival or departure day
          that is usually the honest answer" — a false statement about the day it
          was printed on. A mid-trip blank is a different fact and deserves a
          different sentence.
        */
        <div className="border-t border-rule p-5 text-sm text-ink-muted sm:p-6">
          <p>
            {isFirst || isLast
              ? 'Nothing scheduled. On an arrival or departure day that is usually the honest answer.'
              : 'Nothing scheduled, and this is not an arrival or departure day. Everything you picked fitted better on another day or could not be reached on this one — the hours are yours. What was left off, and why, is at the foot of this plan.'}
          </p>
          {plannedOff.length > 0 ? (
            /*
              THE DAY'S OWN HEADING MUST NOT PROMISE WHAT THE DAY DOES NOT HOLD.
              A day themed "Departure drive" that then reads "Nothing scheduled"
              tells the traveller two different things; the reasons are said
              here, on the card that raised the question.
            */
            <div className="mt-3">
              <p className="text-ink">What this day was for, and why it is not here:</p>
              <ul className="mt-2 flex flex-col gap-2">
                {plannedOff.map((entry) => (
                  <li key={entry.name}>
                    <span className="text-ink">{entry.name}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        /*
          V8 — THE TIMELINE IN THREE PARTS. Morning, midday and evening headings
          where the day actually spans them, so eight rows scan as the shape of
          a day rather than a list. A travel row sits with the stop it leads to.
        */
        <div className="border-t border-rule">
          {groups.map((group) => (
            <div key={group.part} data-day-part={group.part}>
              {headed ? (
                <p className="flex items-center gap-3 border-b border-rule bg-paper-sunk/40 px-5 py-2 sm:px-6">
                  <span className="eyebrow">{DAY_PART_LABEL[group.part]}</span>
                  <span aria-hidden="true" className="route-rule h-0.5 flex-1 opacity-60" />
                </p>
              ) : null}
              <ol className="divide-y divide-rule">{group.items.map(row)}</ol>
            </div>
          ))}
        </div>
      )}
      {tripId && itineraryHasPackage(day) ? <AddStopForm tripId={tripId} dayNumber={day.dayNumber} /> : null}

      {/*
        RECURRING UNCERTAINTY AS A BADGE ROW; SPECIFIC WARNINGS AS SENTENCES.
        "N stops have not been fully verified" and "N legs are unmeasured"
        appeared as paragraphs under every day. They are still true and still
        here — as one compact line — while the warnings that change what a
        traveller does keep their words.
      */}
      {caveat || compacted.sentences.length > 0 ? (
        <div className="border-t border-rule bg-amber-soft/40 px-5 py-3 text-sm leading-relaxed text-ink-muted sm:px-6" data-testid={`day-warnings-${day.dayNumber}`}>
          {caveat ? <p data-testid={`day-caveat-${day.dayNumber}`}>{caveat}.</p> : null}
          {compacted.sentences.length > 0 ? (
            <ul className={cx(caveat && 'mt-1.5')}>
              {compacted.sentences.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {links ? (
        <div className="border-t border-rule p-4 print:hidden sm:px-6">
          <a href={links.google} target="_blank" rel="noreferrer noopener" className={buttonClass('secondary', 'sm')} data-testid={`day-route-${day.dayNumber}`}>
            Open day {day.dayNumber} in Google Maps
          </a>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            {links.omitted > 0
              ? `The link carries the first ${links.included} stops of this day — a maps URL will not hold more. The remaining ${links.omitted} are on the plan above.`
              : `${links.included} of the day's places to visit, in order. Meals and stops without a location are not in the link.`}{' '}
            <a href={links.apple} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
              Apple Maps
            </a>{' '}
            takes one destination at a time, so that link runs from the first stop straight to the last and skips what is in between.
          </p>
        </div>
      ) : null}
    </article>
  );
}

/**
 * V6 — A PICTURE OF ONE PLACE, OR NOTHING AT ALL.
 *
 * The same gate the board and the day hero apply, in one function so the band,
 * the signature experiences and the place sheet cannot disagree about what
 * counts as a photograph of somewhere: a stored open-licensed file whose
 * subject match is better than `weak`, or — where the build is configured for
 * it and there is no durable file — the place's own picture, fetched when the
 * frame is looked at and never stored. A place with neither gets no frame; a
 * generated stand-in for a specific place is a picture of nowhere.
 */
function placeFrame(
  placeId: string,
  name: string,
  images: Record<string, ImageRecord>,
  livePhotos: Record<string, string>,
  rationale: Record<string, StopRationale>,
  ratio: string,
  options: { crop?: boolean; className?: string; credit?: boolean } = {},
): React.ReactNode {
  const stored = images[placeId];
  const durable = stored && stored.subjectConfidence !== 'weak' ? stored : null;
  const live = durable ? undefined : livePhotos[placeId];
  if (!durable && !live) return null;
  const category = rationale[placeId]?.category;
  const { crop = true, className, credit = true } = options;
  const fallback = imageryFallbackFor({ kind: 'candidate', id: placeId, name });
  /*
   * Cropping is a licence decision and the prop type enforces it: a share-alike
   * file never becomes `CroppableImage`, so a frame that wanted to crop one
   * shows the whole file rescaled instead. See `DestinationImage`.
   */
  const cropSafe = crop ? (durable ? croppable(durable) : null) : null;
  return (
    <div className={cx('min-w-0', className)}>
      {crop && (cropSafe || !durable) ? (
        <DestinationImage
          image={cropSafe}
          fallback={fallback}
          ratio={ratio}
          crop
          credit="none"
          {...(live ? { livePhoto: { href: live, credit: 'Photo © Google' } } : {})}
          {...(category ? { category } : {})}
        />
      ) : (
        <DestinationImage
          image={durable}
          fallback={fallback}
          ratio={ratio}
          credit="none"
          {...(live ? { livePhoto: { href: live, credit: 'Photo © Google' } } : {})}
          {...(category ? { category } : {})}
        />
      )}
      {credit ? (
        <p className="mt-1.5 text-xs leading-snug text-ink-faint">
          {durable ? <ImageCredit image={durable} as="span" className="mt-0 inline" /> : <span>Photo &copy; Google</span>}
        </p>
      ) : null}
    </div>
  );
}

/**
 * WHAT MAKES ONE DAY LOOK LIKE ITSELF.
 *
 * Two things, both read off what is already scheduled:
 *
 *   - the **hue**, from the kind of place the day is mostly made of, taken from
 *     the same `PLATE_HUE` table the board's plates use so a lakes day is the
 *     colour lakes are throughout the product;
 *   - the **hero**, the first stop on the day for which a licensed photograph
 *     has already been resolved and stored. First rather than best: the day runs
 *     in an order and the morning is what a reader is looking at.
 *
 * Both are null on a day that has neither, and the header then simply renders
 * neither. A generated stand-in for a day would be a picture of nowhere.
 */
function dayIdentity(
  day: ItineraryDay,
  images: Record<string, ImageRecord>,
  rationale: Record<string, StopRationale>,
  livePhotos: Record<string, string> = {},
): {
  hue: number | null;
  /**
   * MVP V3 — a hero is a durable open-licensed photograph, or, when there is
   * none and the traveller's build has request-time photos configured, the
   * place's own picture fetched when the frame is looked at. `image` is null in
   * the second case and `livePhotoHref` carries it.
   */
  hero: { placeId: string; name: string; image: ImageRecord | null; livePhotoHref?: string; category?: PlaceCategory } | null;
} {
  const stops = day.items.filter((item) => item.kind === 'activity' && item.placeId !== undefined);

  const counts = new Map<PlaceCategory, number>();
  for (const stop of stops) {
    const category = rationale[stop.placeId!]?.category;
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  let hue: number | null = null;
  let best = 0;
  for (const [category, count] of counts) {
    if (count > best) {
      best = count;
      hue = PLATE_HUE[category];
    }
  }

  let hero: ReturnType<typeof dayIdentity>['hero'] = null;
  for (const stop of stops) {
    const image = images[stop.placeId!];
    /*
     * The same gate the board applies: a `weak` subject match is a file found by
     * searching a name, and a picture of a different waterfall in the same
     * valley is a claim, and it is wrong.
     */
    if (!image || image.subjectConfidence === 'weak') continue;
    const category = rationale[stop.placeId!]?.category;
    hero = {
      placeId: stop.placeId!,
      name: rationale[stop.placeId!]?.name ?? stop.title,
      image,
      ...(category ? { category } : {}),
    };
    break;
  }
  /*
   * No open-licensed photograph of any stop on this day. If the place itself
   * publishes one and the build is configured for it, that is a better frame
   * than a generated graphic — and it is fetched when somebody looks, never
   * stored. The durable image still wins whenever there is one.
   */
  if (!hero) {
    for (const stop of stops) {
      const href = livePhotos[stop.placeId!];
      if (!href) continue;
      const category = rationale[stop.placeId!]?.category;
      hero = {
        placeId: stop.placeId!,
        name: rationale[stop.placeId!]?.name ?? stop.title,
        image: null,
        livePhotoHref: href,
        ...(category ? { category } : {}),
      };
      break;
    }
  }

  return { hue, hero };
}

/**
 * What this day's food plan is, as a day rather than as a list of meals.
 *
 * Renders nothing at all on an ordinary day, which is most of them: everything a
 * meal row can say for itself, it says for itself. What is left is what only a
 * day can say — that lunch has to be carried, that the shopping happened this
 * morning for tomorrow, that a table needs booking.
 */
function DayFood({ day }: { day: ItineraryDay }) {
  const { food } = day;
  if (food.notes.length === 0 && food.reservations.length === 0) return null;

  return (
    <section
      className="mt-3 border-t border-rule pt-3"
      aria-label={`Food on day ${day.dayNumber}`}
    >
      <h4 className="eyebrow">Eating</h4>
      {food.notes.length > 0 ? (
        <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
          {food.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {food.reservations.length > 0 ? (
        <p className="mt-2 rounded-md border border-clay/40 p-2.5 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-clay">
            {food.reservations.length === 1
              ? 'One table to book'
              : `${food.reservations.length} tables to book`}
            .
          </span>{' '}
          {food.reservations.map((entry) => entry.venueName).join(', ')}. We have not booked
          anything.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The trip's food position.
 *
 * Deliberately short, and deliberately without a total. Four venues in this
 * whole region publish prices, so a trip food cost would be a guess with a
 * currency symbol on it — and the one number everybody would then plan around.
 */
function FoodPlanPanel({ plan, strategy = [], intel = null }: { plan: FoodPlan; strategy?: readonly string[]; intel?: TravelIntelligence | null }) {
  const food = intel?.food;
  const facts: { label: string; value: string }[] = [];
  if (plan.specialMealBudget > 0) {
    facts.push({
      label: 'Meals meant to be an event',
      value: `${plan.specialMealsPlanned} of ${plan.specialMealBudget}`,
    });
  }
  if (plan.groceryDayNumbers.length > 0) {
    facts.push({ label: 'Shopping days', value: plan.groceryDayNumbers.join(', ') });
  }
  if (plan.packedDayNumbers.length > 0) {
    facts.push({ label: 'Carrying lunch', value: `Day ${plan.packedDayNumbers.join(', ')}` });
  }
  if (plan.daysWithoutVerifiedOption.length > 0) {
    facts.push({
      label: 'Days you pick yourself',
      value: plan.daysWithoutVerifiedOption.join(', '),
    });
  }

  return (
    <section className="mt-6" aria-labelledby="food-plan">
      <h2 className="type-title text-ink" id="food-plan">
        Eating
      </h2>
      {food && food.foodPriority === 'high' ? (
        <div className="mt-4 rounded-[var(--radius-card)] bg-accent-soft/60 p-4" data-testid="food-highlights">
          <p className="label text-accent-strong">Food is a priority on this trip</p>
          <ul className="mt-2 space-y-1 type-small text-ink">
            {food.strategy.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {food.highlights ? (
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {food.highlights.markets.length > 0 ? (
                <div>
                  <dt className="type-meta">Markets</dt>
                  <dd className="text-ink">{food.highlights.markets.map((m) => `${m.name} (day ${m.dayNumber})`).join(', ')}</dd>
                </div>
              ) : null}
              {food.highlights.foodTowns.length > 0 ? (
                <div>
                  <dt className="type-meta">Food towns</dt>
                  <dd className="text-ink">{food.highlights.foodTowns.map((t) => t.name).join(', ')}</dd>
                </div>
              ) : null}
              {food.highlights.specialDinner ? (
                <div>
                  <dt className="type-meta">The one to book</dt>
                  <dd className="text-ink">
                    Day {food.highlights.specialDinner.dayNumber}, {food.highlights.specialDinner.baseName}: {food.highlights.specialDinner.intent}
                  </dd>
                </div>
              ) : null}
              {food.highlights.specialties.length > 0 ? (
                <div>
                  <dt className="type-meta">Specialities named</dt>
                  <dd className="text-ink">{food.highlights.specialties.join(', ')}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{plan.headline}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{plan.style}</p>
      {strategy.length > 1 ? (
        <ul className="mt-3 space-y-1 text-sm text-ink" data-testid="food-strategy">
          {strategy.slice(1).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {facts.length > 0 ? (
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt className="eyebrow">
                {fact.label}
              </dt>
              <dd className="mt-0.5 text-sm text-ink tabular-nums">{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {plan.localSpecialties.length > 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          Worth ordering:{' '}
          <span className="text-ink">{plan.localSpecialties.join(', ')}</span>.
        </p>
      ) : null}

      {plan.dietaryDisclosure ? (
        <p className="mt-4 rounded-md bg-amber-soft p-3 text-xs leading-relaxed text-ink-muted">
          <span className="font-medium text-ink">
            {plan.dietaryNeeds.map((need) => DIETARY_NEED_LABELS[need]).join(', ')}.
          </span>{' '}
          {plan.dietaryDisclosure}
        </p>
      ) : null}

      {plan.unusedChoices.length > 0 ? (
        <div className="mt-4 rounded-md border border-clay/40 p-3">
          <p className="text-xs font-medium text-clay">
            {plan.unusedChoices.length === 1
              ? 'One place you asked for is not on the plan'
              : `${plan.unusedChoices.length} places you asked for are not on the plan`}
          </p>
          <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
            {plan.unusedChoices.map((choice) => (
              <li key={choice.venueId}>
                <span className="font-medium text-ink">{choice.name}</span> — {choice.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-4 type-meta">
        {travellerVoice(plan.dataDisclosure)}
      </p>
    </section>
  );
}

/** The three traveller-facing states, said once in `TripConfidence` and titled from there. */
const VERIFICATION_TITLE: Record<VerificationState, string> = {
  verified: VERIFICATION_CHIP_WORD.verified.blurb,
  partially_verified: VERIFICATION_CHIP_WORD.partially_verified.blurb,
  unverified: VERIFICATION_CHIP_WORD.unverified.blurb,
};
const ANCHOR_KIND_WORD: Record<AnchorKind, string> = { named_place: '', area_experience: 'Area', route_experience: 'Route', generic_experience: 'Experience', meal: 'Meal', flex: 'Flexible', transfer: 'Transfer', gateway: 'Arrival or departure' };
type TimePrecisionWord = 'fixed' | 'measured' | 'estimated' | 'band';

/**
 * PRODUCTION UI V1 — TIME PRECISION FOLLOWS THE LEGS.
 *
 * A stop after a measured leg reads 10:15; after an estimated leg ≈10:15;
 * after a leg nobody could time or estimate, "Late morning". The precision
 * only ever loosens through the day, because a later clock time is only as
 * certain as the least certain leg before it. A booked item stays fixed. One
 * function, read by the day card and by the map's sheets, so the two never
 * disagree about how sure a clock is.
 */
function timePrecisionByItem(day: ItineraryDay): Record<string, TimePrecisionWord> {
  const precisionByItem: Record<string, TimePrecisionWord> = {};
  let state: TimePrecisionWord = 'measured';
  const rank: Record<TimePrecisionWord, number> = { fixed: 0, measured: 0, estimated: 1, band: 2 };
  for (const item of [...day.items].sort((a, b) => a.startMinute - b.startMinute || (a.kind === 'travel' ? -1 : 1))) {
    if (item.kind === 'travel') {
      const own = item.timing?.precision ?? (item.travel?.provenance === 'measured' ? 'measured' : item.travel?.provenance === 'estimated' ? 'estimated' : item.travel && item.travel.fromId !== item.travel.toId ? 'band' : 'measured');
      if (rank[own] > rank[state]) state = own;
      precisionByItem[item.id] = own;
      continue;
    }
    precisionByItem[item.id] = item.timing?.precision === 'fixed' ? 'fixed' : state;
  }
  return precisionByItem;
}

/**
 * V8 — WHAT KIND OF FIGURE A TRANSFER CARRIES, IN ONE WORD.
 *
 * Measured against the road or a timetable; estimated from map distance;
 * on the operator's timing where no road can be routed; or an allowance
 * because nobody could time it. Never zero, never a road figure for a boat.
 * The same four words the Plan view and the map legend use.
 */
function travelState(travel: TravelSegment): { word: string; tone: BadgeTone } {
  if (travel.unverifiedScheduled) return { word: 'timing to confirm', tone: 'amber' };
  switch (travel.provenance) {
    case 'measured':
      return { word: travel.basis === 'scheduled' ? 'timetable' : 'measured', tone: 'pine' };
    case 'official':
      return { word: 'timetable', tone: 'pine' };
    case 'estimated':
      return { word: 'estimated', tone: 'blue' };
    case 'modelled':
      return { word: 'modelled', tone: 'blue' };
    case 'unmeasured':
      return travel.unmeasuredReason === 'mode_not_routed' || travel.unmeasuredReason === 'operator_unpublished' ? { word: 'operator-timed', tone: 'blue' } : { word: 'allowance — not timed', tone: 'amber' };
    default:
      return { word: 'not timed', tone: 'neutral' };
  }
}

/** The one-line travel row: the rounded duration, then the leg's own title ("Walk to Quarter Market"), then what kind of figure it is. */
function travelLine(item: ItineraryItem): string {
  const travel = item.travel!;
  if (travel.unverifiedScheduled && travel.minutes !== null) return `${travelSpan(travel.minutes)} ${item.title} · timing to confirm`;
  if (travel.provenance === 'measured' && travel.minutes !== null) {
    return `${travelSpan(travel.minutes)} ${item.title}${travel.km !== null && travel.km > 0 ? ` · ${Math.round(travel.km)} km` : ''}${travel.basis === 'traffic_aware' ? ' · with traffic' : travel.basis === 'scheduled' ? ' · timetable' : ''}${travel.viaBases ? ' · base to base' : ''}`;
  }
  if (travel.minutes !== null && travel.provenance !== 'unmeasured') {
    return `${travel.provenance === 'estimated' ? '≈' : ''}${travelSpan(travel.minutes)} ${item.title} · ${travel.provenance === 'estimated' ? `estimate${travel.estimate?.approxKm ? ` (~${travel.estimate.approxKm} km)` : ''}` : travelProvenanceLabel(travel)}`;
  }
  if (travel.unmeasuredReason === 'mode_not_routed') return `${item.title} · timing from the operator`;
  return `${item.title} · timing to confirm`;
}

/**
 * WHAT A PRINTED DAY STILL HAS TO CARRY.
 *
 * A traveller holding the packet and nothing else needs the access caution, the
 * booking still in their hands, the daylight limit and the fact worth checking
 * on the morning. The reasoning, the alternatives and the sources belong to the
 * sheet on screen and to the appendix on paper.
 */
function printableCautions(item: ItineraryItem): string[] {
  const lines: string[] = [];
  if (item.accessWarning && !/could not be independently confirmed/i.test(item.accessWarning)) lines.push(item.accessWarning);
  if (item.seasonalNote && item.seasonalNote !== item.accessWarning) lines.push(item.seasonalNote);
  if (item.booking) lines.push(`You arrange this yourself. ${item.booking.note ?? 'Nothing has been booked for you.'}`);
  if (item.verifyBeforeTravel) lines.push(`Check its hours. ${item.verifyBeforeTravel}`);
  if (item.daylightOnly) {
    lines.push(
      item.daylight
        ? `Signed for daylight use only; placed inside ${clock(item.daylight.sunriseMinute, 'later')}–${clock(item.daylight.sunsetMinute, 'earlier')} for this date.`
        : 'Signed for daylight use only, and sunrise and sunset could not be worked out for this one.',
    );
  }
  return lines;
}

/**
 * V6 — EVERYTHING THE PLACE SHEET SHOWS, ASSEMBLED FROM THE ROW.
 *
 * A pure function of the stored item, the fit model's card and the day around
 * it. Nothing here is fetched and nothing is invented: a fact that is not on
 * the plan is simply not in the sheet.
 */
function buildPlaceSheet({
  item,
  rationale,
  verification,
  anchorKind,
  precision,
  dayLabel,
  neighbours,
  arrival,
  navigation,
  hours,
}: {
  item: ItineraryItem;
  rationale?: StopRationale;
  verification?: VerificationState;
  anchorKind?: AnchorKind;
  precision: TimePrecisionWord;
  dayLabel?: string;
  neighbours: { previous?: string; next?: string };
  arrival?: string;
  navigation?: { google: string; apple: string };
  hours?: ItineraryItem['hours'];
}): PlaceSheetDetail {
  const kindLabel = item.food
    ? [MEAL_SLOT_LABELS[item.food.slot], FOOD_STOP_LABEL[item.food.stopKind]].filter(Boolean).join(' · ')
    : anchorKind && anchorKind !== 'named_place' && anchorKind !== 'flex'
      ? ANCHOR_KIND_WORD[anchorKind]
      : rationale?.category
        ? PLACE_CATEGORY_LABELS[rationale.category]
        : undefined;

  const facts: { label: string; value: string }[] = [];
  if (dayLabel) facts.push({ label: 'When', value: `${dayLabel} · ${precision === 'band' ? dayPartFor(item.startMinute) : `${precision === 'estimated' ? '≈' : ''}${timelineClock(item.startMinute, 'later')}`}` });
  if (item.durationMinutes > 0) facts.push({ label: 'How long', value: span(item.durationMinutes) });
  if (item.physicalIntensity && item.physicalIntensity !== 'none') facts.push({ label: 'Effort', value: item.physicalIntensity });
  if (item.weather && item.weather.suitability !== 'workable' && WEATHER_BADGE[item.weather.suitability]) {
    facts.push({ label: 'Weather', value: WEATHER_BADGE[item.weather.suitability]! });
  } else if (item.weatherSensitive) {
    facts.push({ label: 'Weather', value: 'Sensitive to the weather' });
  }
  if (hours) {
    facts.push({
      label: 'Hours',
      value: `${clock(hours.openMinute, 'later')}–${clock(hours.closeMinute, 'earlier')}${hours.lastAdmissionMinute !== undefined ? ` · last entry ${clock(hours.lastAdmissionMinute, 'earlier')}` : ''}`,
    });
  }

  const notes: PlaceSheetNote[] = [];
  if (item.operational && item.operational.outcome !== 'not_applicable') notes.push({ body: `${item.operational.note} ${item.operational.attribution}` });
  if (item.accessWarning && !/could not be independently confirmed/i.test(item.accessWarning)) notes.push({ body: item.accessWarning, tone: 'caution' });
  if (item.seasonalNote && item.seasonalNote !== item.accessWarning) notes.push({ body: item.seasonalNote });
  if (item.verifyBeforeTravel) notes.push({ title: 'Check its hours.', body: item.verifyBeforeTravel, tone: 'caution' });
  if (item.booking) notes.push({ title: 'You arrange this yourself.', body: item.booking.note ?? 'Nothing has been booked for you.', tone: 'booking' });
  if (item.daylightOnly) {
    notes.push({
      body: item.daylight
        ? `Signed for daylight use only. Placed inside ${clock(item.daylight.sunriseMinute, 'later')}–${clock(item.daylight.sunsetMinute, 'earlier')} for this date.`
        : 'Signed for daylight use only, and sunrise and sunset could not be worked out for this one. Check the light yourself.',
    });
  }
  if (item.food?.hoursUnknown) notes.push({ body: 'Nobody publishes hours for this that we could read. Check before you go.' });
  if (item.food) {
    for (const claim of item.food.dietary.filter((entry) => entry.evidence !== 'unknown')) {
      notes.push({ title: `${DIETARY_NEED_LABELS[claim.need]} —`, body: `${DIETARY_EVIDENCE_COPY[claim.evidence]}. ${claim.note}` });
    }
    /*
     * A twenty-minute shop is not a meal. Asking a supermarket to confirm how
     * it handles an allergy — in the one place a traveller can read every label
     * themselves — is the kind of caution that teaches people to skip cautions.
     */
    if (item.food.dietaryUnverified.length > 0 && item.food.stopKind !== 'grocery') {
      notes.push({
        title: 'Nobody has confirmed this either way.',
        body: `${item.food.venueName ?? 'This place'} has nothing on record about ${item.food.dietaryUnverified.map((need) => DIETARY_NEED_LABELS[need].toLowerCase()).join(', ')}. Ring them before you count on it.`,
        tone: 'caution',
      });
    }
    if (item.food.reservation && (item.food.reservation.requirement === 'required' || item.food.reservation.requirement === 'recommended')) {
      notes.push({ title: 'You have to book this yourself.', body: item.food.reservation.note ?? 'Nothing has been booked for you.', tone: 'booking' });
    }
  }
  if (item.food && item.food.alternatives.length > 0) {
    notes.push({ title: 'Other options here:', body: item.food.alternatives.map((option) => `${option.name} — ${option.tradeoff}`).join(' · ') });
  }
  if (hours) {
    notes.push({
      body: `${hours.sourceKind === 'official' ? 'Hours from' : 'Hours written from'} ${hours.sourceName}${hours.lastVerified ? `, read ${hours.lastVerified}` : ''}. We have not checked today.`,
    });
  }

  const links: { label: string; href: string }[] = [];
  if (item.booking?.url) links.push({ label: 'Book with the operator', href: item.booking.url });
  if (hours?.sourceUrl) links.push({ label: hours.sourceName, href: hours.sourceUrl });
  if (item.food?.reservation?.bookingUrl) links.push({ label: 'Their booking page', href: item.food.reservation.bookingUrl });

  const why = rationale?.why ?? item.reason;
  return {
    id: item.id,
    name: rationale?.name ?? item.title,
    ...(kindLabel ? { kindLabel } : {}),
    ...(verification && (anchorKind === undefined || anchorKind === 'named_place') ? { confidenceLabel: VERIFICATION_CHIP_WORD[verification].label } : {}),
    ...(why ? { why } : {}),
    ...(rationale?.why && item.reason !== rationale.why ? { planReason: item.reason } : {}),
    facts,
    route: { ...neighbours, ...(arrival ? { arrive: arrival } : {}) },
    ...(rationale?.facets && rationale.facets.length > 0 ? { facets: rationale.facets } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(navigation ? { navigation } : {}),
  };
}

function TimelineRow({
  item,
  window,
  menu,
  stopNumber = null,
  rationale,
  verification,
  dayNumber,
  dayLabel,
  neighbours = {},
  arrival,
  frame = null,
  thumb = null,
  navigation,
  precision = 'measured',
  anchorKind,
}: {
  item: ItineraryItem;
  window: DailyWindow;
  /** V8 — a small licensed picture of the place, beside the row, or null. */
  thumb?: React.ReactNode;
  /** PRODUCTION UI V1 — how the clock may be read for this row. */
  precision?: TimePrecisionWord;
  /** What kind of thing this stop is; only a named place carries a verification chip. */
  anchorKind?: AnchorKind;
  /** So the day map can find this row when its stop is pressed. */
  dayNumber?: number;
  /** "Day 2 · Thu 13 Aug", for the sheet. */
  dayLabel?: string;
  /** The stops either side of this one in the day's order, for the sheet's route section. */
  neighbours?: { previous?: string; next?: string };
  /** The leg that reaches this stop, already written as the timeline writes it. */
  arrival?: string;
  /** A picture of this place, or null. Rendered in the sheet, never in the row. */
  frame?: React.ReactNode;
  /** Navigation handoff, only where the position is established evidence. */
  navigation?: { google: string; apple: string };
  /** What Sidequest could establish about this stop. Absent on legacy plans and on non-stop rows. */
  verification?: VerificationState;
  /** The quiet per-stop edit control, supplied only where editing applies. */
  menu?: React.ReactNode;
  /** Which mark on the day's map this row is. Null on anything not drawn. */
  stopNumber?: number | null;
  /** What the fit model says about this stop. See `StopRationale`. */
  rationale?: StopRationale;
}) {
  const style = KIND_STYLE[item.kind];
  /**
   * Hours are shown only when they bear on this day. A site posted 06:00 to
   * 22:00 on a day that runs 07:30 to 19:00 has constrained nothing, and saying
   * so on every stop is how a traveller learns to skip the line that matters.
   */
  const hours =
    item.hours &&
    (item.hours.openMinute > window.startMinute ||
      item.hours.closeMinute < window.endMinute ||
      item.hours.lastAdmissionMinute !== undefined)
      ? item.hours
      : undefined;

  const sheet = item.kind === 'travel' || item.kind === 'free_time' ? null : buildPlaceSheet({ item, rationale, verification, anchorKind, precision, dayLabel, neighbours, arrival, navigation, hours: item.hours });

  return (
    <div
      className={cx('flex gap-2.5 px-3 sm:gap-4 sm:px-5 target:bg-pine-soft focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-[-2px]', item.kind === 'travel' ? 'py-2.5 sm:py-3' : 'py-3.5 sm:py-4')}
      data-row-kind={item.kind}
      {...(item.placeId ? { 'data-timeline-place': item.placeId, tabIndex: -1 } : {})}
      {...(dayNumber !== undefined ? { 'data-day': dayNumber } : {})}
    >
      <div className="w-12 shrink-0 pt-0.5 text-right sm:w-16">
        {precision === 'band' && item.kind !== 'travel' ? (
          <span className="block text-xs font-medium leading-tight text-ink-muted" title="A leg before this stop could not be timed, so the clock is a part of the day">
            {dayPartFor(item.startMinute)}
          </span>
        ) : item.kind === 'travel' ? (
          <span aria-hidden="true" className="block text-sm text-ink-faint">
            ↳
          </span>
        ) : (
          <time className={cx('type-figure block text-sm text-ink', precision === 'estimated' && 'approx')} title={precision === 'estimated' ? 'Estimated: the leg before this stop was estimated from map distance' : precision === 'fixed' ? 'Fixed by a booking or timetable' : undefined}>
            {/* V11 §1 — an item may sit past midnight on a day that overruns; the clock says so rather than reading as morning. */}
            {timelineClock(item.startMinute, 'later')}
          </time>
        )}
        {item.kind !== 'travel' ? <span className="type-figure mt-0.5 block text-xs font-medium text-ink-faint">{span(item.durationMinutes)}</span> : null}
      </div>

      {/*
        The rail, or the map's own number where this row is drawn on it.

        Two surfaces showing the same day have to be tied together or they are
        two documents about one thing: a numbered mark on the drawing above
        answers "where is that" only if the row says which number it is.
      */}
      {stopNumber === null ? (
        <span aria-hidden="true" className={cx('mt-1.5 w-1 shrink-0 rounded-full', style.rail)} />
      ) : (
        <span
          aria-hidden="true"
          data-testid="stop-number"
          className="type-figure mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-xs text-paper"
        >
          {stopNumber}
        </span>
      )}

      {thumb ? <div className="hidden shrink-0 sm:block">{thumb}</div> : null}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {item.travel ? (
            /*
             * PRODUCTION UI V1 — THE TRAVEL ROW IS ONE LINE.
             *   ↳ 1h 42m drive · 126 km            (measured)
             *   ↳ ≈1h 45m drive · estimate         (estimated from map distance)
             *   ↳ Drive to Kilkenny · timing to confirm
             * The paragraph that used to explain unknown semantics under every
             * leg is gone; the legend on the map says it once.
             */
            <>
              <h3 className="text-sm text-ink-muted" title={travelProvenanceLabel(item.travel) || item.reason}>
                {travelLine(item)}
              </h3>
              {/*
                V11 §8 — A GOOD LEG NEEDS NO BADGE.

                Every travel row used to carry a chip, and on a healthy plan
                almost every one of them said "measured" — a badge on the normal
                case, repeated twice per day, which is the same thing V11 already
                settled for `partially_verified`: a label that appears on
                everything conveys nothing and costs a line on every row.

                The chip now appears only when the timing is *not* the ordinary
                measured kind — an estimate, an allowance, an operator's own
                hours, a timetable to confirm — which is exactly when a traveller
                needs to know. The measured case keeps its precise wording in the
                row's `title` and in the transfers table on Getting around.
              */}
              {travelState(item.travel).word === 'measured' ? null : (
                <Badge tone={travelState(item.travel).tone} title={travelProvenanceLabel(item.travel)}>
                  {travelState(item.travel).word}
                </Badge>
              )}
            </>
          ) : (
            <h3 className={cx('text-ink', item.kind === 'activity' ? 'font-display text-xl leading-snug sm:text-[1.375rem]' : 'text-base font-medium')}>
              {sheet ? (
                <PlaceSheetTrigger detail={sheet} image={frame} actions={menu}>
                  {rationale?.name ?? item.title}
                </PlaceSheetTrigger>
              ) : (
                (rationale?.name ?? item.title)
              )}
            </h3>
          )}
          {item.travel ? null : item.food ? (
            <span className="eyebrow">
              {[MEAL_SLOT_LABELS[item.food.slot], FOOD_STOP_LABEL[item.food.stopKind]]
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : style.label ? (
            <span className="eyebrow">
              {style.label}
            </span>
          ) : null}
          {item.food?.serviceType && item.food.stopKind === 'venue' ? (
            <Badge>{FOOD_SERVICE_TYPE_LABELS[item.food.serviceType]}</Badge>
          ) : null}
          {item.food?.priceBand ? (
            <Badge title={`${PRICE_BAND_WORDS[item.food.priceBand]} — ${item.food.priceEvidence ? PRICE_EVIDENCE_COPY[item.food.priceEvidence] : ''}`}>
              {PRICE_BAND_LABELS[item.food.priceBand]}
            </Badge>
          ) : null}
          {item.food?.isSpecialMeal ? <Badge tone="pine">Your one big one</Badge> : null}
          {item.food?.reservation &&
          (item.food.reservation.requirement === 'required' ||
            item.food.reservation.requirement === 'recommended') ? (
            <Badge tone="amber">{RESERVATION_LABELS[item.food.reservation.requirement]}</Badge>
          ) : null}
          {item.physicalIntensity && item.physicalIntensity !== 'none' ? (
            <Badge>{item.physicalIntensity}</Badge>
          ) : null}
          {item.weather && item.weather.suitability !== 'workable' ? (
            <Badge tone={WEATHER_TONE[item.weather.suitability]}>
              {WEATHER_BADGE[item.weather.suitability]}
            </Badge>
          ) : null}
          {item.booking ? (
            <Badge tone="amber">{BOOKING_KIND_LABELS[item.booking.kind]}</Badge>
          ) : null}
          {/*
            V11 §8 — the chip is for the states that mean something is
            outstanding. See `verificationNeedsChip`: "Confirmed" and "Planned"
            are the normal case and appeared on nearly every stop of a healthy
            plan. The tier is still stated in full, with its blurb, in the place
            sheet this row's name opens, and counted on the confidence panel.
          */}
          {verification && verificationNeedsChip(verification) && (anchorKind === undefined || anchorKind === 'named_place') ? (
            <Badge tone={VERIFICATION_CHIP_WORD[verification].tone} title={VERIFICATION_TITLE[verification]}>
              {VERIFICATION_CHIP_WORD[verification].label}
            </Badge>
          ) : anchorKind && anchorKind !== 'named_place' && anchorKind !== 'flex' ? (
            <span className="eyebrow">{ANCHOR_KIND_WORD[anchorKind]}</span>
          ) : null}
        </div>

        {/*
          V6 — ONE LINE, THEN A SHEET.

          The row carries the name, the clock, the chips and one short reason.
          Everything else about the stop — the picture, the full fit sentence,
          the plan's own reason, opening hours and their source, the booking
          note, weather and daylight cautions, the food detail, where it sits in
          the day — is in the place sheet, which the name opens. Nine grey
          "Why this, and the details" accordions down one page was nine
          accordions and no hierarchy.
        */}
        {hours ? (
          <p className="type-figure mt-1 text-xs font-medium text-ink-faint">
            Open {clock(hours.openMinute, 'later')}–{clock(hours.closeMinute, 'earlier')}
            {hours.lastAdmissionMinute !== undefined ? ` · arrive before ${clock(hours.lastAdmissionMinute, 'earlier')}` : ''}
            {hours.periodLabel ? ` · ${hours.periodLabel}` : ''}
          </p>
        ) : null}
        {item.kind !== 'travel' ? (
          <p className="mt-1 type-small text-ink-muted" data-testid={rationale?.why ? 'stop-why' : 'stop-reason'}>
            {firstSentence(rationale?.why ?? item.reason)}
          </p>
        ) : item.travel?.unverifiedScheduled || item.travel?.provenance === 'modelled' ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">{item.reason} {travelProvenanceLabel(item.travel)}</p>
        ) : null}
        {item.travel && item.travel.modeCorrectedFrom ? (
          <p className="mt-0.5 text-xs text-ink-faint">The plan said {TRANSPORT_MODE_LABELS[item.travel.modeCorrectedFrom].toLowerCase()}; the distance says otherwise.</p>
        ) : null}
        {item.booking ? (
          <p className="mt-1 text-sm font-medium text-clay">You arrange this yourself{item.booking.url ? ' · link below' : ''}.</p>
        ) : null}
        {item.operational && item.operational.outcome !== 'not_applicable' ? (
          <p className="mt-1 hidden text-xs text-ink-faint print:block" data-testid="stop-operational" data-outcome={item.operational.outcome}>
            {item.operational.note} <span className="text-ink-faint/80">{item.operational.attribution}</span>
          </p>
        ) : null}
        {/*
          THE PACKET STILL CARRIES WHAT SOMEBODY HAS TO ACT ON.
          A traveller with the printed plan and no phone still needs the access
          caution, the booking they have to make and the daylight limit. The
          reasoning, the sources and the alternatives are the sheet's and the
          appendix's; these four are the day's.
        */}
        {printableCautions(item).length > 0 ? (
          <ul className="mt-1 hidden text-xs leading-relaxed text-ink-muted print:block" data-testid="stop-print-cautions">
            {printableCautions(item).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {menu ? <div className="shrink-0 self-start print:hidden">{menu}</div> : null}
    </div>
  );
}


/**
 * V6 — THE CRITICAL CHECKS, AND WHEN TO MAKE THEM.
 *
 * The feasibility report's own items — every decision the plan depends on and
 * every caution worth reading — and the dates the recheck manifest says are
 * worth a second look. Deliberately the last section of the packet: it is what
 * somebody reads before they commit money, and it is the one page that has to
 * survive a print with no appendix.
 *
 * Never a count. A plan with nothing outstanding renders nothing, which is the
 * honest empty state and not an achievement worth a badge.
 */
const SEVERITY_WORD: Record<'blocker' | 'dependency' | 'caution', { word: string; tone: BadgeTone }> = FEASIBILITY_WORDS;

function CriticalChecks({ feasibility, manifest }: { feasibility: NonNullable<TripPackage['feasibility']> | undefined; manifest: RecheckManifest | null }) {
  const items = feasibility?.items ?? [];
  const rechecks = manifest?.items ?? [];
  if (items.length === 0 && rechecks.length === 0) return null;
  return (
    <section className="mt-14 rule-strong pt-5" aria-labelledby="critical-checks" data-testid="critical-checks">
      <h2 id="critical-checks" className="display-md text-ink">
        Before you commit
      </h2>
      <p className="mt-1.5 max-w-2xl type-small text-ink-muted">{feasibility?.summary ?? 'What is worth a second look before you book, and when to look.'}</p>
      {items.length > 0 ? (
        <ul className="mt-5 divide-y divide-rule border-y border-rule">
          {items.map((item, index) => (
            <li key={`${item.area}-${index}`} className="flex items-start gap-3 py-3" data-testid="critical-check" data-severity={item.severity} data-area={item.area}>
              <Badge tone={SEVERITY_WORD[item.severity].tone}>{SEVERITY_WORD[item.severity].word}</Badge>
              <span className="min-w-0 flex-1 type-small text-ink">
                {item.dayNumber ? <span className="text-ink-faint">Day {item.dayNumber} · </span> : null}
                {humanize(item.detail)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {rechecks.length > 0 ? (
        <>
          <h3 className="mt-6 type-section text-ink">Look again nearer the date</h3>
          <ul className="mt-2 divide-y divide-rule" data-testid="critical-recheck">
            {rechecks.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 type-small">
                <span className="text-ink">{item.title}</span>
                <span className="text-ink-faint">{RECHECK_WINDOW_LABELS[item.window]}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * WHAT TO KEEP FLEXIBLE (§17), DERIVED FROM THE PLAN'S OWN EVIDENCE.
 *
 * Nothing is invented for this list: a stop appears because the plan itself
 * records a reason to hold it loosely — the weather bears on it, its details
 * change without notice, or somebody still has to book it. A plan with nothing
 * volatile in it renders no section, which is the honest empty state.
 */
function KeepFlexible({ itinerary }: { itinerary: Itinerary }) {
  const entries: { key: string; name: string; day: number; why: string }[] = [];
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (item.kind !== 'activity' || !item.placeId) continue;
      const why = item.weatherSensitive
        ? 'the weather on that day works against it — have the backup in mind'
        : item.verifyBeforeTravel
          ? `check before travel: ${item.verifyBeforeTravel}`
          : item.booking
            ? 'it needs a booking you have to make yourself'
            : null;
      if (!why) continue;
      entries.push({
        key: `${day.dayNumber}-${item.placeId}`,
        name: item.title,
        day: day.dayNumber,
        why,
      });
    }
  }
  if (entries.length === 0) return null;

  return (
    <section className="mt-14 border-t border-rule pt-8" data-print="appendix">
      <h2 className="display-md text-ink">Keep these flexible</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Each of these carries something the plan cannot promise — weather, details still to confirm, or
        a booking still in your hands. Hold them loosely and the trip bends instead of breaking.
      </p>
      <ul className="mt-4 space-y-2">
        {entries.map((entry) => (
          <li key={entry.key} className="text-sm">
            <span className="font-medium text-ink">{entry.name}</span>
            <span className="text-ink-faint"> · day {entry.day} — </span>
            <span className="text-ink-muted">{entry.why}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * BEFORE YOU GO.
 *
 * High on the page, above the days, because everything in it has a deadline that
 * the days do not: a permit sold out, a ticket that has to be bought online, a
 * phone call that is free today and impossible on the morning.
 *
 * Grouped by what the traveller has to *do* rather than by which place it came
 * from — somebody packing a bag wants one list of things to bring, not four
 * lists of one thing each. Every line carries how well established it is and,
 * where it exists, the page to do it on. Nothing here is generated prose: each
 * item is a sentence a source published or a statement that nobody published
 * one.
 */
function BeforeYouGo({ items, fromPlan = [] }: { items: readonly PreparationItem[]; fromPlan?: readonly string[] }) {
  if (items.length === 0 && fromPlan.length === 0) return null;
  const groups = groupPreparation(items);

  return (
    <Panel className="card p-5" as="section" labelledBy="before-you-go">
        <h3 id="before-you-go" className="type-section text-ink">
          Before you go
        </h3>
        <p className="mt-1 text-sm text-ink-muted">
          {items.length > 0
            ? `${items.length} ${items.length === 1 ? 'thing' : 'things'} worth doing while you still can, taken from what the places themselves publish${fromPlan.length > 0 ? ', plus what your plan itself recommends' : ''}.`
            : 'What your plan recommends arranging before you leave. Nothing here has been booked or checked against an official source.'}
        </p>

        {fromPlan.length > 0 ? (
          <ul className="mt-4 space-y-1.5 text-sm text-ink" data-testid="before-you-go-plan">
            {fromPlan.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden="true" className="text-ink-faint">
                  •
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-5 space-y-6">
          {groups.map((group) => (
            <div key={group.kind}>
              <h3 className="text-sm font-medium text-ink">
                {PREPARATION_KIND_COPY[group.kind].title}
              </h3>
              <p className="mt-0.5 text-xs text-ink-faint">
                {PREPARATION_KIND_COPY[group.kind].blurb}
              </p>
              <ul className="mt-2.5 space-y-2">
                {group.items.map((item, index) => (
                  <li key={`${item.subjectId}-${index}`} className="text-sm leading-relaxed">
                    <span className="font-medium text-ink">{item.subjectName}</span>
                    <span className="text-ink-muted"> — {item.text}</span>
                    {item.url ? (
                      <>
                        {' '}
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer nofollow"
                          className="underline underline-offset-2 hover:text-ink"
                        >
                          official page
                        </a>
                      </>
                    ) : null}
                    {item.confidence ? (
                      <span className="ml-1 text-xs text-ink-faint">({item.confidence})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
    </Panel>
  );
}


/* ------------------------------------------------------------------ *
 * THE TRIP PACKAGE — MODEL-AUTHORED, SIDEQUEST-VERIFIED CONTENT THAT IS
 * NOT A TIMELINE ROW. Rendered only when the plan carries one.
 * ------------------------------------------------------------------ */

/* V11 §21 — the four-word vocabulary, lower-cased for use mid-sentence. */
const VERIFICATION_WORD: Record<VerificationState, string> = {
  verified: 'confirmed',
  partially_verified: 'planned',
  unverified: 'still being checked',
};

/** Bases and nights, in order — the shape of the trip, before the days. */
/** Lodging guidance per base from the plan, with verified areas from the compiled region where they exist. */
function WhereToStay({
  pkg,
  verifiedAreas,
}: {
  pkg: TripPackage;
  verifiedAreas: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[];
}) {
  /*
   * V11 §5 — THE LIST IS THE STAY SEQUENCE, NOT THE BASE ROWS.
   *
   * The founder's Kyrgyzstan trip listed "7 bases, in order" with Karakol twice
   * in a row for one night each, and a trek camp among them as an ordinary place
   * to book. `normalizeStays` folds the duplicate and attributes the camp to the
   * experience that owns it; the row keeps the first constituent base's own
   * verification and rationale, because those are facts about the place and the
   * fold does not change them.
   */
  const stays = normalizeStays({ bases: pkg.bases, episodes: pkg.episodes })
    .stays.map((stay) => ({ stay, base: pkg.bases.find((candidate) => candidate.id === stay.id) }))
    .filter((entry): entry is { stay: (typeof entry)['stay']; base: NonNullable<(typeof entry)['base']> } => entry.base !== undefined);
  return (
    <Panel className="p-5" as="section" testId="where-to-stay">
      <h3 className="font-display text-lg text-ink">Where to stay</h3>
      <p className="mt-1 text-sm text-ink-muted">
        Areas and styles, not hotels. Nothing here is booked, and no hotel is named as a promise.
      </p>
      <ul className="mt-3 grid gap-3">
        {stays.map(({ stay, base }) => (
          <li key={stay.id} className="rounded-lg border border-rule p-3 text-sm">
            <span className="font-medium text-ink">{stay.name}</span>
            <span className="text-ink-faint">
              {' '}
              · {stay.nights} night{stay.nights === 1 ? '' : 's'} · {VERIFICATION_WORD[base.verification]}
            </span>
            {stay.withinExperience ? <span className="mt-0.5 block text-ink-faint">Part of {stay.withinExperience} — the operator arranges these nights.</span> : null}
            <span className="mt-0.5 block text-ink-muted">{base.why}</span>
            {base.area || base.style ? (
              <span className="mt-1 block text-ink-muted">
                {[base.area ? `Stay ${base.area}` : null, base.style].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {verifiedAreas.length > 0 ? (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {verifiedAreas.map((area) => (
            <li key={area.name} className="rounded-lg border border-pine/40 p-3 text-sm">
              <span className="font-medium text-ink">{area.name}</span>
              <span className="text-ink-faint"> · lodging evidence on record</span>
              <span className="mt-0.5 block text-ink-muted">{area.rationale}</span>
              {area.tradeoffs.length > 0 ? <span className="mt-1.5 block text-ink-muted">{area.tradeoffs.join(' · ')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}


/** What was weighed and left out, what Sidequest changed on evidence, and what is still open. */
function ConsideredPanel({ pkg }: { pkg: TripPackage }) {
  const leftOut = pkg.anchors.filter((anchor) => anchor.disposition.startsWith('rejected') || anchor.disposition === 'unscheduled_capacity');
  const moved = pkg.anchors.filter((anchor) => anchor.disposition === 'moved_other_day');
  return (
    <>
      {pkg.omissions.length > 0 || leftOut.length > 0 || moved.length > 0 || pkg.tradeoffs.length > 0 || pkg.unresolved.length > 0 || pkg.preservation ? (
        <section className="mt-14 border-t border-rule pt-8" data-testid="considered-and-left-out" data-print="appendix">
          <h2 className="display-md text-ink">Considered, and decided</h2>
          <p className="mt-1 text-sm text-ink-muted">
            What was weighed and left out on purpose, what Sidequest changed on evidence, and what is still open.
          </p>
          {pkg.preservation ? (
            <p className="mt-3 text-sm text-ink" data-testid="preservation-summary" data-silent-loss={pkg.preservation.silentLoss}>
              {pkg.preservation.summary}
              {pkg.preservation.silentLoss > 0 ? ' Some proposals reached no decision; treat this plan with care.' : ''}
            </p>
          ) : null}
          {pkg.quality && !pkg.quality.passed ? (
            <ul className="mt-3 space-y-1 text-sm text-clay" data-testid="quality-notes">
              {pkg.quality.checks
                .filter((check) => !check.ok && check.severity === 'error')
                .map((check) => (
                  <li key={check.id}>{check.detail.charAt(0).toUpperCase() + check.detail.slice(1)}.</li>
                ))}
            </ul>
          ) : null}
          {pkg.bookingPriorities && pkg.bookingPriorities.length > 0 ? (
            <div className="mt-4" data-testid="booking-priorities">
              <h3 className="font-display text-lg text-ink">Book first, in the planner's judgement</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink">
                {pkg.bookingPriorities.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {pkg.omissions.length > 0 ? (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {pkg.omissions.map((omission) => (
                <li key={omission.name} className="rounded-lg border border-rule p-3 text-sm">
                  <span className="font-medium text-ink">{omission.name}</span>
                  <span className="mt-0.5 block text-ink-muted">{omission.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {moved.length > 0 || leftOut.length > 0 ? (
            <ul className="mt-4 space-y-1.5 text-sm" data-testid="dispositions">
              {moved.map((anchor) => (
                <li key={anchor.id}>
                  <span className="font-medium text-ink">{anchor.name}</span>
                  <span className="text-ink-muted"> — moved from day {anchor.dayNumber} to day {anchor.scheduledDayNumber}. {anchor.note ?? ''}</span>
                </li>
              ))}
              {leftOut.map((anchor) => (
                <li key={anchor.id}>
                  <span className="font-medium text-ink">{anchor.name}</span>
                  <span className="text-ink-muted">
                    {' '}
                    — proposed for day {anchor.dayNumber},{' '}
                    {anchor.disposition === 'rejected_contradiction'
                      ? /* V11 §20 */ 'taken off because what we found contradicted it'
                      : anchor.disposition === 'rejected_hard_constraint'
                        ? 'taken off to respect a limit you set'
                        : 'left off for room'}
                    . {anchor.note ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {pkg.tradeoffs.length > 0 || pkg.assumptions.length > 0 ? (
            <p className="mt-4 text-sm text-ink-muted">{[...pkg.tradeoffs, ...pkg.assumptions].join(' ')}</p>
          ) : null}
          {pkg.unresolved.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm text-ink-muted">
              {pkg.unresolved.map((line) => (
                <li key={line}>Still open: {line}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/**
 * RECURRING UNCERTAINTY, COMPACTED.
 *
 * The reconciler writes two sentences on almost every day — how many stops
 * are not fully verified and how many legs are unmeasured. Both become chips;
 * everything else stays a sentence.
 */
export function compactWarnings(warnings: readonly string[]): { badges: { label: string; title: string }[]; sentences: string[] } {
  const badges: { label: string; title: string }[] = [];
  const sentences: string[] = [];
  let unresolvedPlaces = 0;
  let unresolvedLegs = 0;
  const titles: string[] = [];
  for (const warning of warnings) {
    const unverified = /^(\d+) stops? on this day (?:has|have) not been fully verified/.exec(warning);
    const unmeasured = /^(\d+) travel legs? on this day (?:is|are) unmeasured/.exec(warning);
    if (unverified) {
      unresolvedPlaces += Number(unverified[1]);
      titles.push(humanize(warning));
    } else if (unmeasured) {
      unresolvedLegs += Number(unmeasured[1]);
      titles.push(humanize(warning));
    } else sentences.push(humanize(warning));
  }
  /*
   * V11 §21 — ONE SENTENCE FOR THE DAY, NOT A BADGE PER KIND.
   *
   * Two chips saying "3 still being checked" and "2 legs not yet timed" are two
   * things to read about the same fact: Sidequest has not finished. The whole
   * of `assuranceSummary` is that it composes them into the sentence a person
   * would say, and returns nothing at all when there is nothing to say — which
   * is the common case, and the reason a good day now carries no chip at all
   * where it used to carry two.
   */
  const summary = assuranceSummary({ unresolvedLegs, unresolvedPlaces, toCheck: 0 });
  if (summary) badges.push({ label: summary, title: titles.join(' ') });
  return { badges, sentences };
}

/**
 * THE TRIP AT A GLANCE: a photograph of somewhere on it, the facts that shape
 * it, and the whole route on one map. Built only from what the plan holds —
 * a day's own licensed photograph, the package's bases, the strategy's
 * headline, the weather evidence the days carry — never a stock image.
 */
function seasonLineFor(itinerary: Itinerary): string | null {
  const kinds = [...new Set(itinerary.days.map((day) => day.weather.evidence))];
  if (kinds.includes('forecast')) return 'Placed against a forecast for your dates.';
  if (kinds.includes('historical_pattern')) return 'Planned on what these dates usually do here, not a forecast.';
  return null;
}

function TripSnapshot({
  itinerary,
  coordinates,
  rationale,
  tiles,
}: {
  itinerary: Itinerary;
  coordinates: Record<string, { lat: number; lng: number }>;
  rationale: Record<string, StopRationale>;
  tiles: MapBasemap | null;
}) {
  const pkg = itinerary.package;
  const { markers, connectors, primaryBase, summary } = overviewMapModel(itinerary, coordinates, rationale);
  if (markers.length === 0) return null;
  const bases = pkg?.bases ?? [];

  /*
   * V6 — THE MAP, AND WHAT THE BAND HAS NOT ALREADY SAID.
   *
   * This used to carry a photograph the band now carries, a personality line
   * the overview's own headline now carries, and a "why these dates" the
   * overview's timing card answers. What is left is the drawing of the whole
   * trip, as a card, with a way into the Map view.
   */
  return (
    <section aria-labelledby="trip-snapshot" data-testid="trip-snapshot" className="card overflow-hidden p-3">
      <div className="flex items-baseline justify-between gap-3 px-1 pb-2">
        <h2 id="trip-snapshot" className="eyebrow">
          The whole trip
        </h2>
        <a href="#map" className="type-small text-accent-strong underline underline-offset-4">
          Open the map
        </a>
      </div>
      <div data-bases={bases.length}>
        <TripOverviewMap markers={markers} connectors={connectors} base={primaryBase} tiles={tiles} summary={summary} width={1120} height={560} />
      </div>
    </section>
  );
}

const DOCUMENT_WORDS = /\b(visa|passport|entry requirement|entry requirements|insurance|document|documents|permit|licen[cs]e|vaccin)/i;

/**
 * PREPARATION, ORGANISED: book first · documents · transport · where to stay ·
 * food · packing · weather backups · local notes. Every card reads from the
 * plan's own package or the evidence the places publish; a card with nothing
 * to say is not rendered.
 */
function PreparationHub({
  itinerary,
  preparation,
  hasIntelligence = false,
  verifiedAreas,
}: {
  itinerary: Itinerary;
  preparation: readonly PreparationItem[];
  verifiedAreas: readonly { name: string; rationale: string; tradeoffs: readonly string[] }[];
  /** PRODUCTION UI V1 — when the intelligence layer renders stays, food, packing and backups, this hub keeps only the plan's own notes. */
  hasIntelligence?: boolean;
}) {
  const pkg = itinerary.package;
  const fromPlan = pkg?.beforeYouGo ?? [];
  const documents = fromPlan.filter((line) => DOCUMENT_WORDS.test(line));
  const bookFirst = fromPlan.filter((line) => !DOCUMENT_WORDS.test(line));
  const localNotes = [...(pkg?.unresolved ?? []), ...itinerary.transportStrategy.verifyBeforeTravel, ...itinerary.transportStrategy.seasonalWarnings];
  const hasAnything = preparation.length > 0 || fromPlan.length > 0 || pkg;
  if (!hasAnything) return null;
  return (
    <section className="mt-14 rule-top pt-8" aria-labelledby="prepare-notes" data-testid="prepare" {...(hasIntelligence ? { 'data-print': 'appendix' } : {})}>
      <h2 id="prepare-notes" className="font-display text-xl text-ink">
        {hasIntelligence ? 'Notes from the plan' : 'Prepare'}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{hasIntelligence ? 'What the composed plan itself said to arrange and check, kept in its own words.' : 'What to arrange, carry and check before you leave. Nothing here has been booked for you.'}</p>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="contents" data-testid="before-you-go">
          <BeforeYouGo items={preparation} fromPlan={bookFirst} />
          {documents.length > 0 ? (
            <PrepCard title="Documents & entry" blurb="Verify each of these against the official source for your nationality." testId="prepare-documents">
              <PlainList items={documents} />
            </PrepCard>
          ) : null}
        </div>
        {pkg ? (
          <PrepCard title="Transport" blurb={pkg.transport.summary} testId="transport-notes">
            <PlainList items={pkg.transport.notes} />
          </PrepCard>
        ) : null}
        {pkg && !hasIntelligence ? <WhereToStay pkg={pkg} verifiedAreas={verifiedAreas} /> : null}
        {pkg && pkg.foodStrategy.length > 0 && !hasIntelligence ? (
          <PrepCard title="Food" blurb="The plan's own eating strategy; venues are named on the days where the data exists." testId="prepare-food">
            <PlainList items={pkg.foodStrategy} />
          </PrepCard>
        ) : null}
        {pkg && pkg.packing.length > 0 && !hasIntelligence ? (
          <PrepCard title="Packing" blurb="For this destination, this season and these days. Ticks stay in this tab only." testId="packing-list">
            <PackingChecklist items={pkg.packing} />
          </PrepCard>
        ) : null}
        {pkg && pkg.backups.length > 0 && !hasIntelligence ? (
          <PrepCard title="If the weather turns" blurb="Backups the plan itself suggests. Check they are open before you swap." testId="backups">
            <ul className="mt-3 space-y-2">
              {pkg.backups.map((backup) => (
                <li key={backup.trigger} className="text-sm">
                  <span className="font-medium text-ink">{backup.trigger}</span>
                  <span className="text-ink-muted"> — {backup.alternative}</span>
                </li>
              ))}
            </ul>
          </PrepCard>
        ) : null}
        {localNotes.length > 0 ? (
          <PrepCard title="Local practical notes" blurb="Things to confirm on the ground; none of them has been checked against a live source." testId="prepare-local-notes">
            <PlainList items={[...new Set(localNotes)]} />
          </PrepCard>
        ) : null}
      </div>
    </section>
  );
}

function PrepCard({ title, blurb, testId, children }: { title: string; blurb: string; testId: string; children: React.ReactNode }) {
  return (
    <Panel className="card p-5" as="section" testId={testId}>
      <h3 className="type-section text-ink">{title}</h3>
      <p className="mt-1 text-sm text-ink-muted">{blurb}</p>
      {children}
    </Panel>
  );
}

function PlainList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5 text-sm text-ink">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span aria-hidden="true" className="text-ink-faint">
            •
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function decodeShape(geometry: string): { lat: number; lng: number }[] | undefined {
  try {
    const decoded = decodePolyline(geometry);
    return decoded.length > 1 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** A reconciled (model-draft) day carries draft ids; the legacy planner's days do not. The day controls apply only to the former. */
function itineraryHasPackage(day: ItineraryDay): boolean {
  return day.items.some((item) => item.id.startsWith(`d${day.dayNumber}-`));
}

/**
 * LIVE WORLD V1 — MAP → NAVIGATION HANDOFF AND THE DAY CONTROLS.
 *
 * "Open in Maps" appears under a stop only when its position is verified
 * evidence; "Directions" under a leg only when the leg was measured between
 * two known points. An unverified stop gets no link rather than a link to a
 * guess. The controls to move, re-time and keep a stop sit beside them, only
 * on the owner's page.
 */
function RowHandoff({ item, coordinates, verification, tripId, dayNumber, dayCount, role }: { item: ItineraryItem; coordinates: Record<string, { lat: number; lng: number }>; verification?: VerificationState; tripId?: string; dayNumber: number; dayCount: number; role?: 'core' | 'secondary' | 'optional' | 'flex' }) {
  const linkClass = 'inline-flex min-h-9 items-center text-xs text-ink-muted underline underline-offset-4 hover:text-ink';
  /*
   * V11 §7 — ONE NAVIGATION AFFORDANCE PER STOP, NOT TWO.
   *
   * A measured leg used to carry "Directions: Google Maps · Apple Maps" and the
   * stop immediately beneath it carried "Open in Google Maps · Apple Maps" —
   * the same two apps, for the same destination, twice within about a hundred
   * and fifty pixels, on every leg-and-stop pair of every day. On a five-stop
   * day that is ten link rows for five places.
   *
   * The stop's own links survive because that is where a traveller looks for
   * them (and `stop-navigation` is what the browser suite checks); the leg's
   * duplicate is gone. Nothing navigable is lost: every destination the leg
   * could open is the stop directly below it.
   */
  if (item.kind === 'travel') return null;
  if (item.kind !== 'activity') return null;
  const point = item.placeId ? coordinates[item.placeId] : undefined;
  const navigable = point && verification && verification !== 'unverified';
  if (!navigable && !tripId) return null;
  return (
    <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pb-3 text-xs text-ink-faint print:hidden">
      {navigable ? (
        <span className="inline-flex items-center gap-x-2" data-testid="stop-navigation">
          <span>Open in</span>
          <a href={placeNavigationLinks({ ...point, name: item.title }).google} target="_blank" rel="noreferrer noopener" className={linkClass}>
            Google Maps
          </a>
          <span aria-hidden="true">·</span>
          <a href={placeNavigationLinks({ ...point, name: item.title }).apple} target="_blank" rel="noreferrer noopener" className={linkClass}>
            Apple Maps
          </a>
        </span>
      ) : null}
      {tripId && item.id.startsWith(`d${dayNumber}-`) ? <StopDayControls tripId={tripId} dayNumber={dayNumber} stopId={item.placeId ?? item.id} title={item.title} dayCount={dayCount} {...(role ? { role } : {})} /> : null}
    </div>
  );
}
