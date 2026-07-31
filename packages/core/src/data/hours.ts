import type { OperatingHoursProvider } from '../hours/provider';
import {
  OPERATING_HOURS_DATASET_VERSION,
  operatingHoursDatasetSchema,
  type OperatingCalendar,
  type OperatingHoursDataset,
} from '../schemas/hours';
import type { SourceProvenance } from '../schemas/provenance';

/**
 * WHEN THE EASTERN SIERRA IS OPEN.
 *
 * Read this before changing anything in it.
 *
 * 1. **Most of this region has no opening hours at all.** A trailhead, a lake
 *    shore, a highway pull-out and a scenic drive are open whenever the road is
 *    open, and the road is `data/access.ts`'s business. Several Forest Service
 *    pages say so in as many words ("Open 24 hours/day"), and several others
 *    have no hours field whatsoever — which is a meaningful absence, not a gap
 *    in the research. Giving them a synthetic "00:00–24:00" schedule would put a
 *    badge on seventeen of twenty-three cards and teach people to ignore the badge
 *    that matters. They are `always_open`, which the UI renders as nothing.
 *
 * 2. **Three kinds of gate, and only the first is a staffed closing time.**
 *    - *Staffed*: a human opens a door and enforces a closing time. Bodie, the
 *      Manzanar visitor centre, the Panorama Gondola. These can ruin a day.
 *    - *Posted day-use hours*: a published regulation with no gate and nobody
 *      to enforce it — Hot Creek and Earthquake Fault at 06:00–22:00. Real, so
 *      they are typed, but they are wide enough never to bind in practice.
 *    - *Seasonal road gate*: the road is the gate, not the site. Not modelled
 *      here at all; `data/access.ts` owns it.
 *
 * 3. **`unknown` is a legitimate answer and is never upgraded by guessing.**
 *    Inventing "probably 09:00 to 17:00" would be worse than admitting the gap,
 *    because a fabricated schedule looks exactly like a verified one.
 *
 * 4. **Nothing dated goes in here.** One season's construction schedule, this
 *    year's opening date, an emergency forest order or a temporary staffing
 *    reduction is a `recheckNote` on `dynamic` provenance, never a recurring
 *    period. See the block comment above `manzanar-historic-site`, which is the
 *    hardest case in the file and the one to reason from.
 *
 * Everything below was checked against the managing agency's own page on the
 * `lastVerified` date. Where two official pages disagree, the more conservative
 * reading is encoded and the disagreement is recorded in the note.
 */

const VERIFIED_ON = '2026-07-30';

function official(
  sourceName: string,
  sourceUrl: string,
  overrides: Partial<SourceProvenance> = {},
): SourceProvenance {
  return {
    kind: 'official',
    sourceName,
    sourceUrl,
    lastVerified: VERIFIED_ON,
    confidence: 0.9,
    volatility: 'stable',
    ...overrides,
  };
}

/**
 * Written from general knowledge rather than read off a page. Deliberately
 * carries no `lastVerified`: a verification date on something nobody verified is
 * worse than no date at all.
 */
function authored(sourceName: string, overrides: Partial<SourceProvenance> = {}): SourceProvenance {
  return {
    kind: 'authored',
    sourceName,
    confidence: 0.7,
    volatility: 'stable',
    ...overrides,
  };
}

const NO_ADMISSION = {
  reservationRequired: false,
  timedEntry: false,
  permitRequired: false,
  walkInAllowed: true,
  capacityLimited: false,
} as const;

/**
 * A place with no gate, no desk and no closing time.
 *
 * `daylightOnly` is for the handful that are signed for daylight use without
 * being staffed. It is a marker, not a window — see the schema.
 */
function alwaysOpen(
  placeId: string,
  provenance: SourceProvenance,
  note?: string,
  daylightOnly = false,
): OperatingCalendar {
  return {
    kind: 'always_open',
    placeId,
    admission: { ...NO_ADMISSION },
    daylightOnly,
    ...(note ? { note } : {}),
    provenance,
  };
}

/** A place whose hours nobody has confirmed. Flagged, never assumed. */
function hoursUnknown(
  placeId: string,
  provenance: SourceProvenance,
  note: string,
): OperatingCalendar {
  return {
    kind: 'unknown',
    placeId,
    admission: { ...NO_ADMISSION },
    daylightOnly: false,
    note,
    provenance,
  };
}

const INYO = 'Inyo National Forest';
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/** Posted Forest Service day use: "open 6:00 a.m. to 10:00 p.m." */
const DAY_USE_6_TO_22 = [{ openMinute: 6 * 60, closeMinute: 22 * 60 }];

export const EASTERN_SIERRA_HOURS: OperatingHoursDataset = operatingHoursDatasetSchema.parse({
  version: OPERATING_HOURS_DATASET_VERSION,
  regionId: 'eastern-sierra',
  calendars: [
    // -----------------------------------------------------------------------
    // Staffed places with a closing time that can waste a day
    // -----------------------------------------------------------------------

    /**
     * Bodie is the reason this whole layer exists: staffed, ticketed, closing in
     * the afternoon, and eighty minutes plus thirteen miles of unsurfaced road
     * from base. A plan that arrives at 16:30 has thrown away a day. Those
     * closing times were already in the repository as prose inside an access
     * rule; they are typed here and the prose there now points at this calendar.
     *
     * Two decisions worth knowing about.
     *
     * *The summer boundary is conservative.* California State Parks publishes it
     * twice and contradicts itself: the park page says summer runs from 1 May,
     * the trip-planning page says from Memorial Day. Same authority, unresolved.
     * June is the first month wholly inside both readings, so June to August
     * gets the long day and May keeps the short one. Being wrong towards the
     * earlier closing time costs an afternoon; being wrong the other way leaves
     * someone at a locked gate.
     *
     * *The entry cutoff is modelled as a last admission.* The park does not
     * publish a "last admission" as such — it publishes "visitors who arrive 15
     * minutes prior to the park closing will not be able to visit". That is the
     * same constraint under a different name, and it is the one that decides
     * whether a visit is legal, so it is typed rather than left in prose.
     */
    {
      kind: 'scheduled',
      placeId: 'bodie-state-historic-park',
      periods: [
        {
          label: 'Summer',
          months: [6, 7, 8],
          windows: [
            { openMinute: 9 * 60, closeMinute: 18 * 60, lastAdmissionMinute: 17 * 60 + 45 },
          ],
        },
        {
          label: 'Rest of the year',
          months: [1, 2, 3, 4, 5, 9, 10, 11, 12],
          windows: [
            { openMinute: 9 * 60, closeMinute: 16 * 60, lastAdmissionMinute: 15 * 60 + 45 },
          ],
        },
      ],
      closedAnnualDates: [],
      daylightOnly: false,
      admission: {
        ...NO_ADMISSION,
        note: 'Adult entry $8, youth $5, under 3 free. Paid at the entrance kiosk; no booking.',
      },
      note: 'Nobody is admitted in the last 15 minutes before closing. The museum and the stamp mill tours keep shorter hours again, and run only from roughly May to October as staffing allows.',
      provenance: official(
        'California State Parks — Bodie State Historic Park',
        'https://www.parks.ca.gov/?page_id=509',
        {
          confidence: 0.85,
          volatility: 'seasonal_recurring',
          recheckNote:
            'Bodie closes early in bad weather, and State Route 270 can stay under snow into May or occasionally June. Confirm the day before you drive out.',
        },
      ),
    },

    /**
     * The hardest judgement in this file, and the pattern to follow for the next
     * one like it.
     *
     * Manzanar's visitor centre currently opens Friday to Monday, 09:00 to
     * 16:30. That is a **staffing reduction**, not the site's historical shape —
     * it ran seven days a week until recently, and the Park Service has moved
     * this schedule repeatedly without labelling any version permanent.
     *
     * So which do we encode? Neither answer is comfortable:
     *
     * - Encoding "daily" is the durable shape and would send someone on a
     *   ninety-minute drive to a locked building on a Wednesday.
     * - Encoding Friday-to-Monday risks claiming a temporary arrangement is
     *   permanent, which is exactly what the rest of this file refuses to do.
     *
     * The resolution is that the *calendar* is our best current knowledge and
     * the *provenance* is where its durability is stated. This is `dynamic` with
     * a recheck note that says in plain words that the pattern is a reduction
     * and has changed before. The traveller is therefore planned conservatively
     * — no Wednesday visit — and told, on the card and in the itinerary, to
     * confirm. What we never do is present it as a settled fact.
     *
     * These hours belong to the centre and to nothing else. The grounds are a
     * separate place with a separate calendar, so a Wednesday traveller loses
     * the exhibits and keeps the site.
     */
    {
      kind: 'scheduled',
      placeId: 'manzanar-visitor-center',
      periods: [
        {
          label: 'Visitor centre',
          months: ALL_MONTHS,
          // 0 = Sunday. Friday, Saturday, Sunday, Monday.
          daysOfWeek: [0, 1, 5, 6],
          windows: [{ openMinute: 9 * 60, closeMinute: 16 * 60 + 30 }],
        },
      ],
      closedAnnualDates: ['12-25'],
      daylightOnly: false,
      admission: { ...NO_ADMISSION },
      note: 'Staffed hours. The exhibits, the oral histories and the film are all inside.',
      provenance: official(
        'National Park Service — Manzanar National Historic Site',
        'https://www.nps.gov/manz/planyourvisit/conditions.htm',
        {
          confidence: 0.8,
          volatility: 'dynamic',
          recheckNote:
            'The Tuesday-to-Thursday closure is a staffing reduction, not a long-standing pattern — Manzanar was open daily until recently and the Park Service has changed this more than once. Check the current hours before you drive down.',
        },
      ),
    },

    /**
     * A commercial lift, and the only place in the region that publishes a real
     * admission cutoff: walk-up ticket sales stop half an hour before the last
     * ride. The season dates move every year and are deliberately not encoded;
     * the months are.
     */
    {
      kind: 'scheduled',
      placeId: 'panorama-gondola',
      periods: [
        {
          label: 'Summer scenic operations',
          months: [6, 7, 8, 9],
          windows: [
            { openMinute: 9 * 60, closeMinute: 16 * 60 + 30, lastAdmissionMinute: 16 * 60 },
          ],
        },
      ],
      closedAnnualDates: [],
      daylightOnly: false,
      admission: {
        ...NO_ADMISSION,
        capacityLimited: false,
        note: 'Walk-up ticket sales stop 30 minutes before closing, and the final ride up is a round trip with no download later.',
      },
      note: 'Summer scenic hours, which are not the winter ski-lift hours often quoted elsewhere.',
      provenance: official(
        'Mammoth Mountain — Hours of Operation',
        'https://www.mammothmountain.com/on-the-mountain/hours-of-operation',
        {
          confidence: 0.8,
          volatility: 'seasonal_recurring',
          // The weather suspension is already on the place record; repeating it
          // here stacked three amber blocks on one stop saying the same thing.
          recheckNote:
            'Mammoth Mountain sets the summer season dates afresh each year, so confirm it is running on your dates.',
        },
      ),
    },

    // -----------------------------------------------------------------------
    // Posted day-use hours: published, unstaffed, wide enough rarely to bind
    // -----------------------------------------------------------------------

    {
      kind: 'scheduled',
      placeId: 'hot-creek-geologic-site',
      periods: [{ label: 'Day use', months: ALL_MONTHS, windows: DAY_USE_6_TO_22 }],
      closedAnnualDates: [],
      daylightOnly: false,
      admission: { ...NO_ADMISSION },
      note: 'Day use only. No fee, vault toilets, no drinking water.',
      provenance: official(
        `${INYO} — Hot Creek Geologic Site`,
        'https://www.fs.usda.gov/r05/inyo/recreation/hot-creek-geologic-site',
        { confidence: 0.95 },
      ),
    },
    {
      kind: 'scheduled',
      placeId: 'earthquake-fault',
      periods: [{ label: 'Day use', months: ALL_MONTHS, windows: DAY_USE_6_TO_22 }],
      closedAnnualDates: [],
      daylightOnly: false,
      admission: { ...NO_ADMISSION },
      note: 'Day use only, on a posted schedule with no gate and nobody to enforce it.',
      provenance: official(
        `${INYO} — Earthquake Fault`,
        'https://www.fs.usda.gov/r05/inyo/recreation/earthquake-fault',
        { confidence: 0.9 },
      ),
    },
    {
      kind: 'scheduled',
      placeId: 'inyo-craters',
      periods: [{ label: 'Day use', months: ALL_MONTHS, windows: DAY_USE_6_TO_22 }],
      closedAnnualDates: [],
      daylightOnly: false,
      admission: { ...NO_ADMISSION },
      note: 'Day use only, on a posted schedule with no gate.',
      /**
       * Stable, deliberately. Inyo National Forest closes this area at short
       * notice for fuel reduction and hazard trees, but that is a closure of the
       * site and its road — an access fact — and hanging it here made the card
       * say "recheck hours" about something that is not the hours. The posted
       * 06:00 to 22:00 does not change.
       */
      provenance: official(
        `${INYO} — Inyo Craters`,
        'https://www.fs.usda.gov/r05/inyo/recreation/inyo-craters',
        { confidence: 0.9 },
      ),
    },

    // -----------------------------------------------------------------------
    // Open around the clock, and said so by the agency that manages them
    // -----------------------------------------------------------------------

    alwaysOpen(
      'convict-lake',
      official(`${INYO} — Convict Lake`, 'https://www.fs.usda.gov/r05/inyo/recreation/convict-lake', {
        confidence: 0.92,
      }),
      'Open 24 hours a day, seven days a week, with no fee.',
    ),
    alwaysOpen(
      'mono-lake-south-tufa',
      official(`${INYO} — South Tufa`, 'https://www.fs.usda.gov/r05/inyo/recreation/south-tufa', {
        confidence: 0.95,
      }),
      'The tufa area is open 24 hours a day; $3 per person per day for anyone 16 or over, payable on site. The Mono Basin Scenic Area Visitor Center up the road keeps its own, much shorter hours.',
    ),
    alwaysOpen(
      'minaret-vista',
      official(
        `${INYO} — Minaret Vista`,
        'https://www.fs.usda.gov/r05/inyo/recreation/minaret-vista',
        { confidence: 0.9 },
      ),
      'Open 24 hours a day. The fee station beside it is only staffed for traffic heading down into the valley.',
    ),
    alwaysOpen(
      'obsidian-dome',
      official(
        `${INYO} — Obsidian Dome`,
        'https://www.fs.usda.gov/r05/inyo/recreation/obsidian-dome',
        { confidence: 0.9 },
      ),
      'Open 24 hours a day. A forest road and a trail, with no gate.',
    ),

    // -----------------------------------------------------------------------
    // No hours published, because there is nothing to open or close
    // -----------------------------------------------------------------------
    // The Forest Service page template has an hours field and these pages leave
    // it empty. That absence is the answer, not a hole in the research.

    alwaysOpen(
      'mammoth-lakes-basin',
      official(
        `${INYO} — Mammoth Lakes Basin`,
        'https://www.fs.usda.gov/r05/inyo/recreation/mammoth-lakes-basin',
        { confidence: 0.85 },
      ),
      'Signed for day use from sunrise to sunset, with no gate and no staff. The constraints that actually bind here are the winter closure of Lake Mary Road and the trolley timetable.',
      true,
    ),
    alwaysOpen(
      'rainbow-falls',
      official(
        `${INYO} — Rainbow Falls Trailhead`,
        'https://www.fs.usda.gov/r05/inyo/recreation/rainbow-falls-trailhead',
        { confidence: 0.9 },
      ),
      'A trail, not a facility. What bounds a visit here is the last shuttle out, not a closing time.',
    ),
    alwaysOpen(
      'mcgee-creek-canyon',
      official(
        `${INYO} — McGee Creek Trailhead`,
        'https://www.fs.usda.gov/r05/inyo/recreation/mcgee-creek-trailhead',
        { confidence: 0.8 },
      ),
      'No hours. Day hiking needs no permit; an overnight does, year round.',
    ),
    alwaysOpen(
      'little-lakes-valley',
      official(
        `${INYO} — Mosquito Flat Trailhead`,
        'https://www.fs.usda.gov/r05/inyo/recreation/mosquito-flat-trailhead',
        { confidence: 0.82 },
      ),
      'No hours. Parking, not opening time, is the thing that will stop you — the lot is full by early morning in summer.',
    ),
    alwaysOpen(
      'sherwin-lakes-trail',
      official(
        `${INYO} — Sherwin Lakes Trailhead`,
        'https://www.fs.usda.gov/r05/inyo/recreation/sherwin-lakes-trailhead',
        { confidence: 0.85 },
      ),
      'No hours. A trailhead with no gate.',
    ),
    alwaysOpen(
      'june-lake-loop',
      authored('Mono County Tourism / Caltrans District 9', { confidence: 0.85 }),
      'A public highway loop with no gate. State Route 158 North closes for the winter; the southern junction stays open.',
    ),
    alwaysOpen(
      'wild-willys-hot-spring',
      authored('Bureau of Land Management — Bishop Field Office', { confidence: 0.7 }),
      'Undeveloped public land with no stated hours, no attendant and no facilities.',
    ),
    /**
     * The other half of Manzanar, and the reason the split was worth doing: the
     * tour route has no gate and no closing time, so it is schedulable on the
     * three days a week the exhibits are not.
     *
     * `daylightOnly` rather than a window. The Park Service signs the grounds
     * sunrise to sunset; Sidequest cannot yet work out when those are, and
     * writing "06:00 to 20:00" would be a guess indistinguishable from a fact.
     */
    alwaysOpen(
      'manzanar-historic-site',
      official(
        'National Park Service — Manzanar National Historic Site',
        'https://www.nps.gov/manz/planyourvisit/conditions.htm',
        { confidence: 0.85 },
      ),
      'The tour route, the reconstructed barracks and the cemetery monument are open every day of the year, on foot or by car. No gate, no staff, no closing time.',
      true,
    ),

    alwaysOpen(
      'alabama-hills',
      authored('Bureau of Land Management — Alabama Hills National Scenic Area', {
        confidence: 0.85,
      }),
      'Public land on a through road, with no stated hours. Camping and drone flying each need a free permit; simply visiting does not.',
    ),
    /**
     * The one place in the region we genuinely could not establish, and it is
     * left saying so.
     *
     * The plaza is outdoors and has no gate, so "always open" is arguably true
     * of the ground. But nobody goes to the Village to stand in it — they go for
     * the restaurants and the shops, and those have hours the operator publishes
     * only behind a page we could not read. Claiming no constraint because the
     * paving is accessible would be technically defensible and practically a
     * lie, so this is `unknown`: schedulable, flagged, and demoted against
     * anywhere we actually checked.
     */
    hoursUnknown(
      'the-village-at-mammoth',
      authored('The Village at Mammoth', {
        confidence: 0.4,
        volatility: 'dynamic',
        recheckNote:
          'The Village’s restaurants and shops each set their own hours and change them by season. Check the ones you are counting on.',
      }),
      'The plaza is open to walk through at any hour, but the restaurants and shops that make it worth a stop keep hours we could not confirm.',
    ),
    alwaysOpen(
      'bishop-town',
      authored('Bishop Visitor Center', { confidence: 0.6 }),
      'A town, not an attraction. Businesses keep their own hours: the bakery opens early and most shops are shut by evening.',
    ),

    /**
     * The monument itself is open around the clock in season and the columns
     * have no gate — the thing that governs a visit here is the mandatory
     * shuttle, which `data/access.ts` owns. Modelling the ranger station's
     * hours as the monument's would be exactly the conflation this file exists
     * to prevent: you can walk to the postpile perfectly legally at 16:00 on a
     * day the ranger station shut at 15:00.
     */
    alwaysOpen(
      'devils-postpile',
      official(
        'National Park Service — Devils Postpile National Monument',
        'https://www.nps.gov/depo/planyourvisit/hours.htm',
        {
          confidence: 0.9,
          volatility: 'seasonal_recurring',
          recheckNote:
            'The monument’s open season moves with the snow, the ranger station keeps its own much shorter hours, and Reds Meadow Road is under multi-year reconstruction. Check all three before you fix a date.',
        },
      ),
      'The monument is open 24 hours a day through its season. The ranger station is staffed only part of the week and for part of the day.',
    ),

    /**
     * Yosemite is open 24 hours a day, 365 days a year, and Tioga Road has no
     * hours — only a season, which the access rules already carry.
     *
     * The reservation system is the interesting part, and it is deliberately
     * *not* encoded as a requirement. Yosemite has run peak-hours entry
     * reservations in some years and not others, and announced none for 2026.
     * Writing `reservationRequired: true` would be wrong today; writing it as
     * permanently false would be wrong the next time the policy flips. It is a
     * dynamic recheck instead, which is the only honest shape for a fact that
     * is re-decided annually.
     */
    alwaysOpen(
      'tioga-pass-tuolumne',
      official(
        'National Park Service — Yosemite National Park',
        'https://www.nps.gov/yose/planyourvisit/hours.htm',
        {
          confidence: 0.9,
          volatility: 'dynamic',
          recheckNote:
            'Yosemite has required a peak-hours entry reservation in some years and not others, and decides afresh each season. Check whether one applies to your dates before you drive over the pass.',
        },
      ),
      'The park is open 24 hours a day, all year; Tioga Road’s constraint is the season, not a closing time. The Tuolumne Meadows visitor centre opens roughly late May to mid-October and does not publish daily hours.',
    ),
  ],
} satisfies OperatingHoursDataset);

/**
 * The offline implementation of the provider seam.
 *
 * It ignores `placeIds` and `dates` and returns the whole region, because a
 * constant has nothing to narrow. A live provider would use both; the signature
 * exists so that swapping one in is not a change to any caller.
 */
export const easternSierraHoursProvider: OperatingHoursProvider = {
  name: 'Eastern Sierra authored hours (offline)',
  async getOperatingHours({ regionId }) {
    if (regionId !== EASTERN_SIERRA_HOURS.regionId) {
      throw new Error(`No opening-hours data for region "${regionId}".`);
    }
    return EASTERN_SIERRA_HOURS;
  },
};
