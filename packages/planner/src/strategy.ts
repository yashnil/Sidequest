import {
  describeMonths,
  TRANSPORT_MODE_LABELS,
  type AccessDataset,
  type ItineraryDay,
  type Region,
  type TransitEvidence,
  type TransportMode,
  type TransportStrategy,
  type TravelerProfile,
  type UnscheduledPlace,
} from '@sidequest/core';

/**
 * The trip's transportation position, derived from the plan that was actually
 * built.
 *
 * Deterministic and descriptive, never aspirational: every claim here is either
 * a fact from the access dataset or an arithmetic consequence of the scheduled
 * days. There is no cost figure, because without fares, fuel and parking charges
 * a total would be a guess with a currency symbol on it — and a traveller who
 * budgets against a made-up number is worse off than one who was told nothing.
 */
export interface StrategyInput {
  days: readonly ItineraryDay[];
  profile: TravelerProfile;
  region: Region;
  dataset: AccessDataset;
  unscheduled: readonly UnscheduledPlace[];
  matrixNote: string;
  matrixProvenance: 'measured' | 'modelled' | 'estimated';
  /**
   * Which network the matrix measured.
   *
   * Optional so a caller written before this existed still compiles, and
   * defaulting to `car` because that is what the disclosure has always said —
   * the point is that a *pedestrian* trip stops claiming driving times, not
   * that every existing caller has to be revisited at once.
   */
  matrixMode?: 'car' | 'foot' | 'transit';
  /**
   * The compiled transit evidence, so the panel's claims about the ground can
   * be checked against what was actually measured before they are made.
   *
   * Optional, and absent means what the artifact means by absence: the trip
   * was planned around a car and bought no timetables, so nothing here is a
   * claim about scheduled transport at all.
   */
  transit?: TransitEvidence | null;
}

export function buildTransportStrategy(input: StrategyInput): TransportStrategy {
  const { days, profile, region, dataset, matrixNote, matrixProvenance } = input;
  const matrixMode = input.matrixMode ?? 'car';

  /**
   * WHETHER "WALKABLE" IS A CLAIM THIS BUILD IS ENTITLED TO MAKE.
   *
   * A trip that leans on scheduled transport and measured none of it is a trip
   * whose walking totals describe our instruments, not the ground. The
   * compiler signs exactly that state: transit evidence present, zero journeys
   * measured, absence `unsupported` or `budget_exhausted`. A shipped build in
   * that state printed "Walk the whole way" and "Everything here is walkable
   * from your base" over a region whose own evidence records dozens of
   * railway stations — an unverifiable claim stated as fact. When this is
   * true, every walking-first sentence below says the honest version instead:
   * public transport is not verified here yet, and the times shown are on
   * foot because walking is the one thing that was measured.
   *
   * `out_of_coverage` keeps the walking sentences: a provider was asked about
   * this ground and holds nothing, which is the closest thing to "there is no
   * network" a build can attest. `not_needed` and an absent record are trips
   * that never leaned on scheduled transport at all.
   */
  const transitUnverified =
    input.transit !== null &&
    input.transit !== undefined &&
    input.transit.measured === 0 &&
    (input.transit.absence === 'unsupported' || input.transit.absence === 'budget_exhausted');

  const totals = days.reduce(
    (acc, day) => ({
      driveMinutes: acc.driveMinutes + day.totals.driveMinutes,
      transitMinutes: acc.transitMinutes + day.totals.transitMinutes,
      walkMinutes: acc.walkMinutes + day.totals.walkMinutes,
      waitMinutes: acc.waitMinutes + day.totals.waitMinutes,
      /*
       * Carried up beside the four rather than folded into one of them. A trip
       * total is read as a claim about how the trip is made, and these minutes
       * are the one part of it nobody could say that about.
       */
      unverifiedMinutes: acc.unverifiedMinutes + day.totals.unverifiedMinutes,
      driveKm: acc.driveKm + day.totals.travelKm,
    }),
    {
      driveMinutes: 0,
      transitMinutes: 0,
      walkMinutes: 0,
      waitMinutes: 0,
      unverifiedMinutes: 0,
      driveKm: 0,
    },
  );
  totals.driveKm = Math.round(totals.driveKm * 10) / 10;

  const modesUsed = orderedModes(days);
  const serviceIds = [...new Set(days.flatMap((day) => day.transport.serviceIds))].sort();
  const services = serviceIds
    .map((id) => dataset.services.find((service) => service.id === id))
    .filter((service): service is NonNullable<typeof service> => Boolean(service));

  const primaryMode = pickPrimary(totals, modesUsed, profile);
  const secondaryMode = pickSecondary(primaryMode, modesUsed);

  const rationale: string[] = [];
  const tradeoffs: string[] = [];
  const seasonalWarnings: string[] = [];
  const verifyBeforeTravel = [...new Set(days.flatMap((day) => day.transport.verifyBeforeTravel))];

  /*
   * THE TRAVELLER'S OWN ACCESSIBILITY NOTE, VERBATIM AND ATTRIBUTED.
   *
   * The questionnaire's free-text box wrote to `profile.accessibility.notes`
   * and nothing anywhere read it — a placebo control, spending trust on words
   * that were stored and never seen again. The honest consumer is the simplest
   * one: carry the words to the check-before-you-book list every plan renders,
   * say whose words they are, and do not pretend to have understood them.
   * Parsing free text into scheduling behaviour would be the worse dishonesty —
   * acting on a guess about a sentence nobody confirmed. The structured
   * `mobilityLimited` answer is the input that changes the plan;
   * `accessibility-note.test.ts` holds both halves of that line.
   */
  const accessibilityNote = profile.accessibility.notes?.trim();
  if (accessibilityNote) {
    verifyBeforeTravel.push(
      `Your accessibility note, in your own words: “${accessibilityNote}” We have not turned this into assumptions — raise it directly when you book stays, transport or timed entries.`,
    );
  }

  const drivingDays = days.filter((day) => day.totals.driveMinutes > 0).length;
  const serviceDays = days.filter((day) => day.transport.serviceIds.length > 0).length;

  if (primaryMode === 'drive') {
    rationale.push(
      `${region.transportSummary} ${drivingDays} of your ${days.length} days involve driving.`,
    );
    if (serviceDays > 0) {
      rationale.push(
        `${serviceDays === 1 ? 'One day' : `${serviceDays} days`} hands the driving over to a scheduled service, which is not a compromise here — it is the only legal way in.`,
      );
    }
    tradeoffs.push(
      `About ${formatHours(totals.driveMinutes)} at the wheel across the trip, against a limit of ${profile.transport.maxDailyDriveMinutes} min a day.`,
    );
    if (!profile.transport.willUseShuttles) {
      tradeoffs.push(
        'You asked us to leave shuttles out, which closes off anywhere private vehicles are barred in season.',
      );
    }
  } else if (primaryMode === 'walk') {
    rationale.push(
      transitUnverified
        ? 'Public transport is not verified here yet — nothing in this build can measure a scheduled journey — so every leg is priced as the measured walk, and what was scheduled is what fits on foot.'
        : 'Everything scheduled is within walking distance or on a free town route, so nothing here needs a vehicle.',
    );
  } else {
    rationale.push(
      `Without a car, this trip runs on ${services.map((service) => service.label).join(' and ') || 'scheduled services'} and on foot.`,
    );
    tradeoffs.push(
      'Scheduled services set the edges of the day. There is no way to stay for the light, and no way to leave early.',
    );
  }

  if (profile.transport.willDrive && !modesUsed.includes('drive') && days.length > 0) {
    rationale.push('You have a car, but nothing on this plan actually needed it.');
  }

  for (const service of services) {
    if (service.operatingMonths.length < 12) {
      seasonalWarnings.push(
        `${service.label} normally runs ${describeMonths(service.operatingMonths)} only. Outside that window the places it serves change entirely.`,
      );
    }
  }
  const seasonalRules = dataset.rules.filter((rule) => rule.months.length < 12);
  if (seasonalRules.length > 0 && primaryMode === 'drive' && region.seasonalRoadSummary) {
    seasonalWarnings.push(region.seasonalRoadSummary);
  }

  const withoutPrimary =
    primaryMode === 'drive'
      ? noCarConsequence(dataset, days, region)
      : profile.transport.willDrive
        ? undefined
        : region.noVehicleSummary;

  return {
    primaryMode,
    secondaryMode,
    headline: headlineFor(primaryMode, secondaryMode, services.length, transitUnverified),
    rationale,
    tradeoffs,
    ...(withoutPrimary ? { withoutPrimary } : {}),
    convenience: primaryMode === 'drive' ? 'high' : serviceDays > 0 ? 'moderate' : 'low',
    stress: assessStress(totals, profile, days),
    parkingSummary: parkingSummary(dataset, days, primaryMode),
    transitSummary: transitSummary(
      services,
      primaryMode,
      days.some((day) => day.totals.transitMinutes > 0),
      transitUnverified,
    ),
    seasonalWarnings: [...new Set(seasonalWarnings)],
    verifyBeforeTravel,
    totals,
    // The matrix note already says it is not measured road data; repeating the
    // phrase around it produced "modelled, not measured road data. Modelled …
    // not measured road data." on the page.
    /*
     * WHICH TIMES, NAMED FROM THE MATRIX RATHER THAN ASSUMED.
     *
     * This said "Driving times are …" on every plan, including the ones with no
     * driving in them: a car-free traveller on a pedestrian matrix was told the
     * driving times were measured, over a day whose every leg was a walk. The
     * matrix knows which network it measured and is the only thing that does.
     */
    /*
     * The *network* that was measured, not an activity the traveller may not be
     * doing.
     *
     * "Driving times are measured" was printed on a plan whose own transport
     * panel read "Without a car" two lines above it, because the sentence named
     * the mode a road matrix implies rather than the thing that was actually
     * measured. A road matrix is a legitimate and sometimes the only measurement
     * for a car-free region — every non-walking mode travels on roads — so the
     * honest sentence names the road and leaves the traveller's own transport to
     * the panel that knows it.
     */
    dataDisclosure: `${matrixMode === 'foot' ? 'Walking' : 'Road'} times are ${matrixProvenance}. ${matrixNote}${measuredTransitLegs(days) > 0 ? ' Public-transport times were measured against published timetables for a weekday mid-morning departure, so an evening or a Sunday will differ.' : ''} Service times come from the operators' published timetables on the dates recorded against each one, and are not checked live.`,
  };
}

/**
 * How many legs on this plan are journeys somebody read off a timetable.
 *
 * The disclosure had two branches, walking and driving, which was the whole
 * truth while those were the only two networks anything measured. A plan whose
 * days are held together by measured metro journeys was being described by a
 * sentence about the pedestrian network — accurate about the walks and silent
 * about everything else. This is what decides whether the third sentence is owed.
 */
function measuredTransitLegs(days: readonly ItineraryDay[]): number {
  return days.reduce(
    (count, day) =>
      count +
      day.items.filter(
        (item) => item.travel?.provenance === 'official' && item.travel.role !== 'wait',
      ).length,
    0,
  );
}

/** Modes in the order the trip first uses them, so the summary reads as a route. */
function orderedModes(days: readonly ItineraryDay[]): TransportMode[] {
  const seen: TransportMode[] = [];
  for (const day of days) {
    for (const mode of day.transport.modes) {
      if (!seen.includes(mode)) seen.push(mode);
    }
  }
  return seen;
}

/**
 * The mode that carries the trip, by minutes.
 *
 * Walking is excluded from the contest unless it is all there is: five minutes
 * from a car park to a viewpoint is not a transportation strategy, and letting
 * it win would produce "walk" for a trip that is plainly a road trip.
 */
function pickPrimary(
  totals: { driveMinutes: number; transitMinutes: number; walkMinutes: number },
  modesUsed: readonly TransportMode[],
  profile: TravelerProfile,
): TransportMode {
  if (totals.driveMinutes >= totals.transitMinutes && totals.driveMinutes > 0) return 'drive';
  if (totals.transitMinutes > 0) {
    /**
     * The vehicle the trip is actually spent on, and never one it is not.
     *
     * This looked for a shuttle or a bus and **fell back to `'shuttle'`** when it
     * found neither. While every ride in the product came from an authored
     * shuttle service that fallback was unreachable. It stopped being
     * unreachable the moment a measured metro journey could reach a timeline:
     * the trip rode `rail`, the search found no shuttle, and the strategy
     * announced a shuttle no day contained — which the strategy validator
     * catches as `strategy_mode_mismatch` and turns into a refusal to plan.
     *
     * A default that names a mode nobody is on is not a default, it is a guess
     * with a fixed answer. If the trip rides something, that something is in
     * `modesUsed`; if it somehow is not, falling through to the walking and
     * driving branches below says something true instead.
     */
    const riding = modesUsed.find(
      (mode) =>
        mode === 'rail' ||
        mode === 'public_bus' ||
        mode === 'ferry' ||
        mode === 'shuttle' ||
        mode === 'rideshare' ||
        mode === 'private_transfer',
    );
    if (riding) return riding;
  }
  if (totals.walkMinutes > 0) return 'walk';
  /*
   * A last resort that still names something the trip contains.
   *
   * The bare `willDrive ? 'drive' : 'walk'` referred to nothing the days
   * actually did, and `validateStrategy` refuses a plan whose headline mode no
   * day uses — turning a trip with, say, only bicycle legs into a refusal over
   * a fallback rather than over anything real.
   */
  return modesUsed.find((mode) => mode !== 'unsupported') ?? (profile.transport.willDrive ? 'drive' : 'walk');
}

function pickSecondary(
  primary: TransportMode,
  modesUsed: readonly TransportMode[],
): TransportMode | null {
  const alternative = modesUsed.find(
    (mode) => mode !== primary && mode !== 'walk' && mode !== 'unsupported',
  );
  return alternative ?? null;
}

function headlineFor(
  primary: TransportMode,
  secondary: TransportMode | null,
  serviceCount: number,
  transitUnverified: boolean,
): string {
  const lead = TRANSPORT_MODE_LABELS[primary];
  if (primary === 'drive' && serviceCount > 0) {
    return `Drive, and hand over to a shuttle where the road stops being yours`;
  }
  if (primary === 'drive') return 'Drive — there is no practical alternative here';
  if (secondary) return `${lead}, with ${TRANSPORT_MODE_LABELS[secondary].toLowerCase()} filling the gaps`;
  /*
   * "Walk the whole way" is a verdict about the ground; on foot only because
   * nothing measured the alternatives is a fact about this build. The
   * headline is the one line everybody reads, so it is the one place the
   * difference must not be blurred.
   */
  if (primary === 'walk' && transitUnverified) {
    return 'On foot for now — public transport is not verified here yet';
  }
  return `${lead} the whole way`;
}

function assessStress(
  totals: { driveMinutes: number },
  profile: TravelerProfile,
  days: readonly ItineraryDay[],
): TransportStrategy['stress'] {
  const worstDay = days.reduce((max, day) => Math.max(max, day.totals.driveMinutes), 0);
  const share = profile.transport.maxDailyDriveMinutes
    ? worstDay / profile.transport.maxDailyDriveMinutes
    : 0;
  if (share > 0.85) return 'high';
  if (share > 0.5) return 'moderate';
  return 'low';
}

function parkingSummary(
  dataset: AccessDataset,
  days: readonly ItineraryDay[],
  primary: TransportMode,
): string {
  /**
   * Which months this trip is actually in, for the one sentence that mentions
   * a season. "The one thing that actually spoils a summer morning" was
   * printed on a November trip — template copy claiming a season the plan's
   * own dates contradict — so the summer clause is only spoken in summer.
   * Northern-hemisphere months, which is where every seasonal claim in the
   * access data is authored; a trip that is not in them gets the plain fact.
   */
  const months = new Set(days.map((day) => Number(day.date.slice(5, 7))));
  const inSummer = [6, 7, 8].some((month) => months.has(month));

  if (primary !== 'drive') {
    return inSummer
      ? 'Nothing on this plan needs a parking space, which removes the one thing that actually spoils a summer morning here.'
      : 'Nothing on this plan needs a parking space.';
  }
  const hard = dataset.points.filter((point) => point.parking.difficulty === 'hard');
  const notes = [...new Set(days.flatMap((day) => day.transport.parkingNotes))];
  if (notes.length > 0) return notes.join(' ');
  if (hard.length > 0) {
    return inSummer
      ? 'Trailhead and gateway lots fill by mid-morning in summer. An early start is worth more than a clever route.'
      : 'Some lots here fill early in high season. Outside it, arriving mid-morning is usually fine — an early start still buys the quiet.';
  }
  return 'Parking is straightforward at everything scheduled here.';
}

function transitSummary(
  services: readonly { label: string; operatingMonths: number[]; fareNote?: string }[],
  primary: TransportMode,
  /** True when a day actually rides something — measured transit, not authored. */
  ridesTransit: boolean,
  /** True when this trip leaned on scheduled transport and none was measured. */
  transitUnverified: boolean,
): string {
  if (services.length === 0) {
    /*
     * `services` is the *authored* list — shuttles and buses a dataset names.
     * Measured transit journeys arrive by a different door entirely, so a plan
     * can board a train on every day of the trip while this list is empty —
     * and this line then told that traveller "everything here is walkable"
     * directly above a timeline of train legs. The days themselves are the
     * truth about whether anything is ridden, so they are what is asked.
     */
    if (ridesTransit) {
      return 'Public transport does the longer hops here, timed against published timetables.';
    }
    /*
     * "Walkable" is a claim about the ground. When the trip leaned on
     * scheduled transport and nothing could measure a journey, the truthful
     * statement is about the gap — the same sentence the board's own transit
     * disclosure makes — never a verdict the evidence cannot back.
     */
    if (transitUnverified) {
      return 'Public transport is not verified here yet — we cannot check timetables, so the times shown are on foot.';
    }
    return primary === 'drive'
      ? 'No scheduled service reaches anything on this plan. The vehicle is not a convenience, it is the access.'
      : 'Everything here is walkable from your base.';
  }
  return services
    .map(
      (service) =>
        `${service.label} — ${describeMonths(service.operatingMonths)}${service.fareNote ? `, ${service.fareNote.toLowerCase()}` : ''}`,
    )
    .join('. ');
}

/**
 * What a car-free version of this trip would actually look like, stated from the
 * access data rather than from a hunch.
 */
function noCarConsequence(
  dataset: AccessDataset,
  days: readonly ItineraryDay[],
  region: Region,
): string {
  const scheduledPlaceIds = new Set(
    days.flatMap((day) =>
      day.items.filter((item) => item.placeId).map((item) => item.placeId as string),
    ),
  );
  const reachableWithoutCar = new Set(
    dataset.rules
      .filter((rule) => rule.approachMode !== 'drive')
      .flatMap((rule) => rule.placeIds),
  );
  const wouldLose = [...scheduledPlaceIds].filter((id) => !reachableWithoutCar.has(id));

  if (wouldLose.length === 0) {
    return 'Every stop on this plan is also reachable without a car, which is unusual here.';
  }
  const services = dataset.services.map((service) => service.label).sort();
  return `Without a vehicle, ${wouldLose.length} of the ${scheduledPlaceIds.size} stops on this plan become unreachable. What survives is ${region.baseName} itself and whatever ${
    services.length > 0 ? services.join(' or ') : 'a scheduled service'
  } reaches.`;
}

/**
 * "3 hr 20 min", never "3.3 hours". The planner's own summary line switched to
 * hours-and-minutes for exactly this reason and this function was left behind,
 * so the transport panel was the last surface speaking in decimal hours.
 */
function formatHours(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
