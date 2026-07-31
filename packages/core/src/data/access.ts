import {
  accessDatasetSchema,
  type AccessDataset,
  type AccessPoint,
  type AccessProvenance,
  type AccessRule,
  type TransportService,
} from '../schemas/access';
import type { AccessProvider } from '../access/provider';

/**
 * Eastern Sierra access data.
 *
 * WHAT IS ENCODED AND WHAT IS NOT
 *
 * Only facts that recur. "The last bus out of Reds Meadow Valley leaves at 7 pm"
 * has been true for years and is a planning rule. "In 2026 the road is open
 * Thursday to Sunday until 2 September, then weekends only from 21 September"
 * is this year's road-crew schedule; encoding it would make the product
 * confidently wrong in 2027, so it travels as a recheck note instead.
 *
 * The same line is drawn for the 2026 shuttle timetable, the Village boarding
 * point ESTA added for 2026, the Hot Creek Forest Order that expires at the end
 * of 2026, and every snowpack-dependent opening date.
 *
 * WHAT THIS DATASET DELIBERATELY OMITS
 *
 * Places with no rule are not reachable as far as the planner is concerned. That
 * is the point: silence must never read as "you can probably drive there". Every
 * seeded place therefore has an explicit rule, and `uncoveredPlaceIds` fails the
 * build loudly if one is ever added without one.
 *
 * Sources are the managing agencies: the National Park Service for Devils
 * Postpile, Inyo National Forest for the surrounding land, Eastern Sierra
 * Transit Authority for the services it runs, Caltrans District 9 for the
 * highways, California State Parks for Bodie, and the Town of Mammoth Lakes for
 * Lake Mary Road.
 */

const VERIFIED_2026_07_30 = {
  lastVerified: '2026-07-30',
} as const;

function official(
  sourceName: string,
  sourceUrl: string,
  overrides: Partial<AccessProvenance> = {},
): AccessProvenance {
  return {
    kind: 'official',
    sourceName,
    sourceUrl,
    confidence: 0.9,
    volatility: 'stable',
    ...VERIFIED_2026_07_30,
    ...overrides,
  };
}

/**
 * Written from general knowledge and not checked against a source — so it
 * deliberately carries no `lastVerified`. Stamping today's date on unverified
 * data is how "we checked this" becomes indistinguishable from "we wrote this".
 */
function authored(sourceName: string, overrides: Partial<AccessProvenance> = {}): AccessProvenance {
  return {
    kind: 'authored',
    sourceName,
    confidence: 0.7,
    volatility: 'stable',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Access points
// ---------------------------------------------------------------------------

/**
 * `routingId` is the matrix key. Two of these piggy-back on a seeded place —
 * the Main Lodge boarding point sits at the gondola building and the Village
 * transit stop sits at the Village — because a boarding point that is a hundred
 * metres from a place the matrix already knows does not deserve its own drive
 * time. The third, Minaret Vista Station, is the fee gate and shares the vista.
 */
export const EASTERN_SIERRA_ACCESS_POINTS: AccessPoint[] = [
  {
    id: 'ap-main-lodge-gondola',
    name: 'Panorama Gondola Building, Mammoth Mountain Main Lodge',
    locality: 'Mammoth Mountain',
    routingId: 'panorama-gondola',
    parking: {
      available: true,
      difficulty: 'moderate',
      note: 'Free day parking at Main Lodge. It fills on peak summer mornings.',
    },
    provenance: official(
      'National Park Service — Devils Postpile, Getting Around',
      'https://www.nps.gov/depo/planyourvisit/gettingaround.htm',
      { confidence: 0.95 },
    ),
  },
  {
    id: 'ap-village-transit-stop',
    name: 'Canyon Boulevard transit stop, The Village',
    locality: 'Mammoth Lakes',
    routingId: 'the-village-at-mammoth',
    parking: {
      available: true,
      difficulty: 'easy',
      note: 'Village day parking, and the point every free town route passes through.',
    },
    provenance: official(
      'Eastern Sierra Transit Authority — Lakes Basin Trolley',
      'https://www.estransit.com/lakes-basin-trolley',
    ),
  },
  {
    id: 'ap-reds-meadow-valley',
    name: 'Reds Meadow Valley shuttle stops',
    locality: 'Reds Meadow Valley',
    routingId: 'devils-postpile',
    parking: {
      available: false,
      difficulty: 'hard',
      note: 'No general parking in the valley while the shuttle is running.',
    },
    provenance: official(
      'National Park Service — Devils Postpile, Getting Around',
      'https://www.nps.gov/depo/planyourvisit/gettingaround.htm',
    ),
  },
  {
    id: 'ap-lakes-basin-stops',
    name: 'Lakes Basin trolley stops',
    locality: 'Mammoth Lakes Basin',
    routingId: 'mammoth-lakes-basin',
    parking: {
      available: true,
      difficulty: 'hard',
      note: 'Trailhead lots fill by mid-morning in summer; the trolley exists to avoid them.',
    },
    provenance: official(
      'Eastern Sierra Transit Authority — Lakes Basin Trolley',
      'https://www.estransit.com/lakes-basin-trolley',
    ),
  },
  {
    id: 'ap-bishop-stop',
    name: 'Bishop transit stop',
    locality: 'Bishop',
    routingId: 'bishop-town',
    parking: { available: true, difficulty: 'easy' },
    provenance: official(
      'Eastern Sierra Transit Authority — Mammoth Express',
      'https://www.estransit.com/mammoth-express',
    ),
  },
];

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const EASTERN_SIERRA_SERVICES: TransportService[] = [
  {
    id: 'svc-reds-meadow-shuttle',
    label: 'Reds Meadow / Devils Postpile shuttle',
    operator: 'Eastern Sierra Transit Authority, for the National Park Service',
    mode: 'shuttle',
    boardingPointId: 'ap-main-lodge-gondola',
    dropOffPointId: 'ap-reds-meadow-valley',
    // NPS: the season "typically begins in late June (weather permitting) and
    // runs through early September". Month granularity is the honest resolution
    // for a start date that has moved by eight weeks across recorded years.
    operatingMonths: [6, 7, 8, 9],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    window: {
      firstDeparture: 7 * 60 + 30,
      lastOutboundDeparture: 18 * 60 + 15,
      // The one number that decides whether a day in the valley is real. NPS and
      // the operator both publish 7 pm, and it has stood for years.
      lastReturnDeparture: 19 * 60,
    },
    // Modelled from the corridor drive plus stops; neither agency publishes an
    // in-vehicle time. It is long enough that the planner cannot get it wrong in
    // the traveller's favour.
    rideMinutes: 45,
    // Published headways disagree between the operator and the Park Service, so
    // rather than pick a winner this reserves a wait either can absorb.
    transferBufferMinutes: 20,
    fareNote: '$15 per adult, $7 per child for a day pass. Under 2 travel free.',
    bookingNote:
      'Buy at the Panorama Gondola Building. Peak midday departures have been ticketed in advance in recent seasons.',
    provenance: official(
      'National Park Service — Devils Postpile shuttle information',
      'https://www.nps.gov/depo/planyourvisit/reds-meadow-and-devils-postpile-shuttle-information.htm',
      {
        confidence: 0.85,
        volatility: 'seasonal_recurring',
        recheckNote:
          'Start and end dates and the exact timetable are set each spring. Confirm this year’s season and first and last departures before you commit to a date.',
      },
    ),
  },
  {
    id: 'svc-lakes-basin-trolley',
    label: 'Lakes Basin Trolley',
    operator: 'Eastern Sierra Transit Authority, funded by the Town of Mammoth Lakes',
    mode: 'shuttle',
    boardingPointId: 'ap-village-transit-stop',
    dropOffPointId: 'ap-lakes-basin-stops',
    operatingMonths: [6, 7, 8, 9],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    // 09:00-17:30 is the whole service day, which is why the trolley cannot get
    // a car-free traveller to the basin for sunrise or for a sunset over Lake
    // Mary. That is a real limit on a car-free trip, not a rounding error.
    window: {
      firstDeparture: 9 * 60,
      lastOutboundDeparture: 17 * 60,
      lastReturnDeparture: 17 * 60 + 30,
    },
    rideMinutes: 15,
    transferBufferMinutes: 15,
    headwayMinutes: 30,
    fareNote: 'Free.',
    provenance: official(
      'Eastern Sierra Transit Authority — Lakes Basin Trolley',
      'https://www.estransit.com/lakes-basin-trolley',
      {
        volatility: 'seasonal_recurring',
        recheckNote:
          'Runs roughly June to mid-September, every 30 minutes at peak and hourly on shoulder weekdays. Check the current season before relying on it.',
      },
    ),
  },
  {
    id: 'svc-mammoth-express',
    label: 'Mammoth Express (Mammoth Lakes ↔ Bishop)',
    operator: 'Eastern Sierra Transit Authority',
    mode: 'public_bus',
    boardingPointId: 'ap-village-transit-stop',
    dropOffPointId: 'ap-bishop-stop',
    operatingMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    // Four departures each way. Southbound from Mammoth 07:50, 14:15, 17:15,
    // 19:05; northbound from Bishop 06:25, 07:05, 13:00, 18:00 — so 18:00 is
    // the last way home, and the 19:05 southbound is a one-way trip.
    window: {
      firstDeparture: 7 * 60 + 50,
      // The published 17:15 southbound exists, but the last bus home leaves
      // Bishop at 18:00 — you would arrive after it had gone. 14:15 is the last
      // departure you can actually come back from, which is what this field means.
      lastOutboundDeparture: 14 * 60 + 15,
      lastReturnDeparture: 18 * 60,
    },
    rideMinutes: 50,
    transferBufferMinutes: 15,
    fareNote: '$2 to $7 per adult depending on distance. Discounts for over-60s and under-18s.',
    provenance: official(
      'Eastern Sierra Transit Authority — Mammoth Express',
      'https://www.estransit.com/mammoth-express',
      {
        volatility: 'seasonal_recurring',
        recheckNote: 'Does not run on some public holidays. Check the current timetable.',
      },
    ),
  },
];

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * The default for this region: you drive to it, you park, you walk from the car.
 * Written as a helper because saying it twelve times in full would bury the four
 * rules that are actually interesting.
 */
function driveTo(
  id: string,
  placeIds: string[],
  label: string,
  provenance: AccessProvenance,
  overrides: Partial<AccessRule> = {},
): AccessRule {
  return {
    id,
    label,
    placeIds,
    months: ALL_MONTHS,
    approachMode: 'drive',
    privateVehicle: 'allowed',
    serviceRequirement: 'none',
    walkMinutesFromDropOff: 0,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [],
    provenance,
    ...overrides,
  };
}

const CALTRANS_D9 = official(
  'Caltrans District 9 — seasonal highway closures',
  'https://dot.ca.gov/caltrans-near-me/district-9/district-9-popular-links/snow-removal-and-emergency-repair',
  { confidence: 0.95, volatility: 'seasonal_recurring' },
);

export const EASTERN_SIERRA_ACCESS_RULES: AccessRule[] = [
  // --- The Reds Meadow corridor ------------------------------------------
  // The case the whole model exists for. Three places, one road, and two
  // different ways in that meet at the same fee gate.
  {
    id: 'rule-reds-meadow-shuttle',
    label: 'Reds Meadow Valley by shuttle',
    placeIds: ['devils-postpile', 'rainbow-falls'],
    months: [6, 7, 8, 9, 10],
    approachMode: 'drive',
    gatewayPointId: 'ap-main-lodge-gondola',
    // Drivable before 07:00 and after 19:00, and by campers, permit holders and
    // anyone displaying a disability placard. None of those is a day the planner
    // can build, so it plans the shuttle and says the rest in prose.
    privateVehicle: 'prohibited_during_service',
    serviceId: 'svc-reds-meadow-shuttle',
    serviceRequirement: 'required',
    walkMinutesFromDropOff: 10,
    // Rainbow Falls is stop 8, the monument is stops 6 and 9: you ride between
    // them rather than walk the valley floor twice.
    internalTransfer: { mode: 'shuttle', minutes: 15 },
    permitRequired: false,
    notes: [
      'Nearly all visitors must ride the shuttle. You may drive in before 07:00 or after 19:00, or with a campground or lodging reservation, a cartop boat, livestock trailer, or a disability placard or plates — a $10 vehicle fee is collected at the Minaret Vista Station.',
      'Reds Meadow Resort at stop 10 has a cafe and a store. There is nothing else in the valley.',
    ],
    provenance: official(
      'National Park Service — Devils Postpile shuttle information',
      'https://www.nps.gov/depo/planyourvisit/reds-meadow-and-devils-postpile-shuttle-information.htm',
      {
        confidence: 0.95,
        volatility: 'dynamic',
        recheckNote:
          'Reds Meadow Road is under multi-year reconstruction and its open days change through the season. Confirm this year’s open days and shuttle season with Inyo National Forest before you fix a date.',
      },
    ),
  },
  driveTo(
    'rule-minaret-vista',
    ['minaret-vista'],
    'Minaret Vista by car',
    official(
      'Inyo National Forest — Minaret Vista',
      'https://www.fs.usda.gov/r05/inyo/recreation/minaret-vista',
      { confidence: 0.9, volatility: 'seasonal_recurring' },
    ),
    {
      months: [5, 6, 7, 8, 9, 10, 11],
      notes: [
        'The vista sits at the northern edge of the shuttle zone, so it stays open to cars while the valley beyond it does not. Free to park, no pass needed.',
        'Reached on State Route 203, a paved but steep mountain road that Caltrans closes west of Mammoth Mountain for the winter.',
      ],
    },
  ),

  // --- The Lakes Basin: two genuine ways in ------------------------------
  driveTo(
    'rule-lakes-basin-drive',
    ['mammoth-lakes-basin'],
    'Lakes Basin by car',
    official(
      'Town of Mammoth Lakes — roadway conditions',
      'https://www.townofmammothlakes.ca.gov/256/Roadway-Conditions',
      { confidence: 0.85, volatility: 'seasonal_recurring' },
    ),
    {
      months: [5, 6, 7, 8, 9, 10],
      notes: [
        'Lake Mary Road is gated to vehicles for the winter; the Town starts plowing in late April.',
      ],
    },
  ),
  {
    id: 'rule-lakes-basin-trolley',
    label: 'Lakes Basin by trolley',
    placeIds: ['mammoth-lakes-basin'],
    months: [6, 7, 8, 9],
    approachMode: 'walk',
    approachMinutes: 15,
    gatewayPointId: 'ap-village-transit-stop',
    privateVehicle: 'allowed',
    serviceId: 'svc-lakes-basin-trolley',
    serviceRequirement: 'optional',
    walkMinutesFromDropOff: 5,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [
      'The free trolley runs from Canyon Boulevard across from the Village up Lake Mary Road to Twin Lakes, Lake Mary and Horseshoe Lake, and removes the parking problem entirely.',
      'It only runs 09:00 to 17:30, so it cannot get you up there for sunrise or hold a sunset.',
    ],
    provenance: official(
      'Eastern Sierra Transit Authority — Lakes Basin Trolley',
      'https://www.estransit.com/lakes-basin-trolley',
      { volatility: 'seasonal_recurring' },
    ),
  },

  // --- Town, and the one satellite a bus actually reaches ----------------
  {
    id: 'rule-village-walk',
    label: 'The Village on foot',
    placeIds: ['the-village-at-mammoth'],
    months: ALL_MONTHS,
    approachMode: 'walk',
    approachMinutes: 15,
    privateVehicle: 'allowed',
    serviceRequirement: 'none',
    walkMinutesFromDropOff: 0,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [
      'Walkable from most of town, and every free year-round town route passes through it.',
    ],
    provenance: official(
      'Eastern Sierra Transit Authority — Town of Mammoth Lakes routes',
      'https://www.estransit.com/town-of-mammoth-lakes',
      { confidence: 0.85 },
    ),
  },
  driveTo(
    'rule-bishop-drive',
    ['bishop-town'],
    'Bishop by car',
    authored('Sidequest curated', { confidence: 0.75 }),
  ),
  {
    id: 'rule-bishop-bus',
    label: 'Bishop by Mammoth Express',
    placeIds: ['bishop-town'],
    months: ALL_MONTHS,
    approachMode: 'walk',
    approachMinutes: 15,
    gatewayPointId: 'ap-village-transit-stop',
    privateVehicle: 'allowed',
    serviceId: 'svc-mammoth-express',
    serviceRequirement: 'optional',
    walkMinutesFromDropOff: 5,
    internalTransfer: { mode: 'walk', minutes: 0 },
    permitRequired: false,
    notes: [
      'Four buses each way, seven days a week. The last one back to Mammoth leaves Bishop at 18:00 — miss it and there is no other.',
    ],
    provenance: official(
      'Eastern Sierra Transit Authority — Mammoth Express',
      'https://www.estransit.com/mammoth-express',
    ),
  },

  // --- Everything else: your own vehicle, and nothing else ---------------
  driveTo(
    'rule-panorama-gondola',
    ['panorama-gondola'],
    'Panorama Gondola by car',
    official(
      'Mammoth Mountain — Scenic Gondola',
      'https://www.mammothmountain.com/things-to-do/activities/scenic-gondola',
      { confidence: 0.8, volatility: 'seasonal_recurring' },
    ),
    {
      months: [6, 7, 8, 9],
      notes: [
        'Loads in the building across from the Main Lodge west entrance. Operations can close without notice on weather.',
      ],
    },
  ),
  driveTo(
    'rule-convict-lake',
    ['convict-lake'],
    'Convict Lake by car',
    official(
      'Inyo National Forest — Convict Lake',
      'https://www.fs.usda.gov/r05/inyo/recreation/convict-lake',
      { confidence: 0.95 },
    ),
    { notes: ['A paved road in, with no fee and no gate.'] },
  ),
  driveTo(
    'rule-hot-creek',
    ['hot-creek-geologic-site'],
    'Hot Creek by car',
    official(
      'Inyo National Forest — Hot Creek Geologic Site',
      'https://www.fs.usda.gov/r05/inyo/recreation/hot-creek-geologic-site',
      {
        confidence: 0.9,
        volatility: 'dynamic',
        recheckNote:
          'Entering the creek, or coming within ten feet of it, is barred by a Forest Order with a fixed expiry date. Check whether the current order is still in force.',
      },
    ),
    {
      notes: [
        'Two miles of paved road then three of gravel. No fee, vault toilets and no drinking water.',
      ],
    },
  ),
  driveTo(
    'rule-june-lake-loop',
    ['june-lake-loop'],
    'June Lake Loop by car',
    CALTRANS_D9,
    {
      months: [4, 5, 6, 7, 8, 9, 10, 11],
      notes: [
        'State Route 158 North is one of the eight highways Caltrans District 9 closes for the winter, and is usually among the first to reopen in spring.',
      ],
    },
  ),
  driveTo(
    'rule-mono-lake',
    ['mono-lake-south-tufa'],
    'South Tufa by car',
    official(
      'Inyo National Forest — South Tufa',
      'https://www.fs.usda.gov/r05/inyo/recreation/south-tufa',
      { confidence: 0.85 },
    ),
    { notes: ['$3 per person per day for anyone 16 or over, payable on site.'] },
  ),
  driveTo(
    'rule-bodie',
    ['bodie-state-historic-park'],
    'Bodie by car',
    official('California State Parks — Bodie', 'https://www.parks.ca.gov/?page_id=509', {
      confidence: 0.95,
      volatility: 'seasonal_recurring',
    }),
    {
      months: [4, 5, 6, 7, 8, 9, 10, 11],
      notes: [
        'Ten miles of pavement then three of unsurfaced road.',
        'State Route 270 is on the Caltrans District 9 winter closure list.',
      ],
    },
  ),
  driveTo(
    'rule-tioga-pass',
    ['tioga-pass-tuolumne'],
    'Tioga Pass by car',
    CALTRANS_D9,
    { months: [6, 7, 8, 9, 10] },
  ),
  driveTo(
    'rule-drive-only-inyo',
    [
      'wild-willys-hot-spring',
      'earthquake-fault',
      'inyo-craters',
      'obsidian-dome',
      'mcgee-creek-canyon',
      'little-lakes-valley',
      'sherwin-lakes-trail',
    ],
    'Inyo National Forest trailheads by car',
    authored('Sidequest curated', { confidence: 0.7 }),
    {
      notes: ['No scheduled service reaches any of these. A vehicle is the only way in.'],
    },
  ),
  driveTo(
    'rule-owens-valley-south',
    ['manzanar-historic-site', 'manzanar-visitor-center', 'alabama-hills'],
    'Southern Owens Valley by car',
    authored('Sidequest curated', { confidence: 0.7 }),
    {
      notes: [
        'The daily Highway 395 bus passes through but its single round trip does not make a day trip from Mammoth Lakes work.',
      ],
    },
  ),
];

/**
 * Parsed at module load rather than at first use, so a malformed rule fails the
 * build and the test suite instead of one traveller's plan.
 */
export const EASTERN_SIERRA_ACCESS: AccessDataset = accessDatasetSchema.parse({
  regionId: 'eastern-sierra',
  points: EASTERN_SIERRA_ACCESS_POINTS,
  services: EASTERN_SIERRA_SERVICES,
  rules: EASTERN_SIERRA_ACCESS_RULES,
});

/**
 * The offline provider used everywhere today. Async to match the interface a
 * live transit or parking service will implement, so swapping it in is not a
 * signature change.
 */
export const easternSierraAccessProvider: AccessProvider = {
  name: 'eastern-sierra-authored-access',
  async getAccessDataset({ regionId }) {
    if (regionId !== EASTERN_SIERRA_ACCESS.regionId) {
      throw new Error(`No access data for region "${regionId}".`);
    }
    return EASTERN_SIERRA_ACCESS;
  },
};

