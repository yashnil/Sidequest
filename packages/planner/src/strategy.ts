import {
  describeMonths,
  TRANSPORT_MODE_LABELS,
  type AccessDataset,
  type ItineraryDay,
  type Region,
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
}

export function buildTransportStrategy(input: StrategyInput): TransportStrategy {
  const { days, profile, region, dataset, matrixNote, matrixProvenance } = input;

  const totals = days.reduce(
    (acc, day) => ({
      driveMinutes: acc.driveMinutes + day.totals.driveMinutes,
      transitMinutes: acc.transitMinutes + day.totals.transitMinutes,
      walkMinutes: acc.walkMinutes + day.totals.walkMinutes,
      waitMinutes: acc.waitMinutes + day.totals.waitMinutes,
      driveKm: acc.driveKm + day.totals.travelKm,
    }),
    { driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, driveKm: 0 },
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
      'Everything scheduled is within walking distance or on a free town route, so nothing here needs a vehicle.',
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
    headline: headlineFor(primaryMode, secondaryMode, services.length),
    rationale,
    tradeoffs,
    ...(withoutPrimary ? { withoutPrimary } : {}),
    convenience: primaryMode === 'drive' ? 'high' : serviceDays > 0 ? 'moderate' : 'low',
    stress: assessStress(totals, profile, days),
    parkingSummary: parkingSummary(dataset, days, primaryMode),
    transitSummary: transitSummary(services, primaryMode),
    seasonalWarnings: [...new Set(seasonalWarnings)],
    verifyBeforeTravel,
    totals,
    // The matrix note already says it is not measured road data; repeating the
    // phrase around it produced "modelled, not measured road data. Modelled …
    // not measured road data." on the page.
    dataDisclosure: `Driving times are ${matrixProvenance}. ${matrixNote} Service times come from the operators' published timetables on the dates recorded against each one, and are not checked live.`,
  };
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
    return modesUsed.find((mode) => mode === 'shuttle' || mode === 'public_bus') ?? 'shuttle';
  }
  if (totals.walkMinutes > 0) return 'walk';
  return profile.transport.willDrive ? 'drive' : 'walk';
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
): string {
  const lead = TRANSPORT_MODE_LABELS[primary];
  if (primary === 'drive' && serviceCount > 0) {
    return `Drive, and hand over to a shuttle where the road stops being yours`;
  }
  if (primary === 'drive') return 'Drive — there is no practical alternative here';
  if (secondary) return `${lead}, with ${TRANSPORT_MODE_LABELS[secondary].toLowerCase()} filling the gaps`;
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
  if (primary !== 'drive') {
    return 'Nothing on this plan needs a parking space, which removes the one thing that actually spoils a summer morning here.';
  }
  const hard = dataset.points.filter((point) => point.parking.difficulty === 'hard');
  const notes = [...new Set(days.flatMap((day) => day.transport.parkingNotes))];
  if (notes.length > 0) return notes.join(' ');
  if (hard.length > 0) {
    return 'Trailhead and gateway lots fill by mid-morning in summer. An early start is worth more than a clever route.';
  }
  return 'Parking is straightforward at everything scheduled here.';
}

function transitSummary(
  services: readonly { label: string; operatingMonths: number[]; fareNote?: string }[],
  primary: TransportMode,
): string {
  if (services.length === 0) {
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

function formatHours(minutes: number): string {
  const hours = Math.round(minutes / 6) / 10;
  return `${hours} hours`;
}
