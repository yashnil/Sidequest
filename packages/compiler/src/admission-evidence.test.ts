import { describe, expect, it } from 'vitest';
import {
  assessOperatingHours,
  type CompiledRegion,
  type OperatingCalendar,
  type Place,
} from '@sidequest/core';
import { buildHours, compileRegion } from './compile';
import { deriveScope } from './scope';
import {
  SYNTHETIC_WORLDS,
  syntheticCandidate,
  type FakeResearchOptions,
  type SyntheticWorldSpec,
} from './testing/fakes';
import { packBackedProviders } from './testing/pack-fakes';

/**
 * A MISSING CALENDAR IS NOT PERMISSION.
 *
 * ---
 *
 * **The live evidence class.** `buildHours` shared one `admission` constant
 * between both of its no-calendar branches, and that constant is not a blank:
 * `reservationRequired: false`, `walkInAllowed: true` is the positive claim
 * that you may turn up and walk in. So the *absence* of a published calendar
 * was being spent as permission on every place nobody had looked up. On the
 * `open_ground` branch — which suppresses the hours caution, correctly, because
 * open ground cannot have hours — a gated, ticketed, reservation-heavy site
 * went out on a delivered itinerary as a walk-in with no badge, no booking
 * task and no warning of any kind.
 *
 * **What each test drives.** `compileRegion` over a fixture world, then the
 * artifact's own `operatingHours` — the dataset the planner resolves days
 * against and the board renders cautions from — passed through
 * `assessOperatingHours`, which is the function that turns a calendar into the
 * sentences a traveller reads. Asserting on `buildHours` alone would prove the
 * constant changed; it would not prove the traveller is told.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');

/** A verified claim, so the branch under test is reached rather than the gate before it. */
const BRANCH_CLAIM = { state: 'verified' as const, factPath: 'booking.required' as const };
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

async function compile(
  spec: SyntheticWorldSpec,
  research: FakeResearchOptions = {},
): Promise<CompiledRegion> {
  const result = await compileRegion({
    compilationId: `admission-${spec.id}`,
    scope: deriveScope({
      candidate: syntheticCandidate(spec),
      clarifications: { schemaVersion: 1, questions: [], answers: [] },
      nights: DATES.length,
      revision: 1,
    }),
    dates: [...DATES],
    months: [8],
    providers: packBackedProviders(spec, research),
    now: NOW,
  });
  if (!result.ok) throw new Error(`${spec.id} did not compile: ${result.code} — ${result.message}`);
  return result.region;
}

function calendarsOfKind(region: CompiledRegion, kind: OperatingCalendar['kind']): OperatingCalendar[] {
  return region.operatingHours.calendars.filter((calendar) => calendar.kind === kind);
}

function cautionsFor(region: CompiledRegion, calendar: OperatingCalendar): string[] {
  return assessOperatingHours({ calendar, dates: DATES }).cautions;
}

/**
 * A funnel that confirms a booking requirement and cannot enforce an hours one.
 *
 * The booking claim carries its excerpt; the hours claim does not, so the hours
 * claim is discarded and no calendar can be built from it. That pairing is the
 * production shape the fix is for rather than a contrivance — `buildCalendar`
 * refuses to enforce a schedule off evidence that cannot be cited, which is
 * right — and the subject then fell to a fallback that asserted walk-in entry
 * straight over the top of a reservation rule the same run had verified. Two
 * different facts, two different sources, and only one of them was missing.
 */
const CONFIRMED_BOOKING_UNKNOWN_HOURS: FakeResearchOptions = {
  bookingRequired: true,
  uncitedClaims: true,
};

/** One open-ground place and a scope to hang it on, for the branch test below. */
const BRANCH_SCOPE = deriveScope({
  candidate: syntheticCandidate(SYNTHETIC_WORLDS.remote_road!),
  clarifications: { schemaVersion: 1, questions: [], answers: [] },
  nights: DATES.length,
  revision: 1,
});

function riverPlace(): Place {
  return {
    id: 'branch-open-ground',
    regionId: 'compiled-branch',
    name: 'Sallowbrook Water',
    locality: 'Branchford',
    shortDescription: 'Open water, used to exercise the admission branch.',
    coordinates: SYNTHETIC_WORLDS.remote_road!.center,
    tags: [],
    source: { name: 'Test', kind: 'curated', confidence: 0.9, lastVerified: '2026-01-01' },
    relationship: 'satellite',
    category: 'lake',
    hoursExpectation: 'open_ground',
    interests: ['lakes_and_rivers'],
    typicalDurationMinutes: 60,
    costLevel: 0,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.5,
    hiddenGemScore: 0.5,
    weather: {
      exposure: 'exposed_outdoor',
      precipitation: 'high',
      wind: 'low',
      heat: 'moderate',
      cold: 'moderate',
      visibilityDependent: false,
      poorWeatherBackup: false,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: 'easy',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: 4, driveMinutes: 10, driveIsScenic: false },
  };
}

describe('a place nobody publishes a calendar for', () => {
  it('says the admission terms are unknown instead of asserting walk-in entry', async () => {
    const region = await compile(SYNTHETIC_WORLDS.remote_road!);
    const unknown = calendarsOfKind(region, 'unknown');
    expect(unknown.length).toBeGreaterThan(0);

    for (const calendar of unknown) {
      /*
       * The schema has no third state for a boolean, and `walkInAllowed: false`
       * renders as "there is no walk-up entry" — a false negative that would be
       * a worse lie than the one being fixed. So the ignorance is stated in the
       * field that carries prose, and the assertion is on the sentence a
       * traveller actually gets rather than on the flag.
       */
      expect(cautionsFor(region, calendar)).toContain(
        'Nobody publishes whether this needs a ticket, a booking or a permit, so do not read the absence of one as permission to walk in.',
      );
    }
  });

  it('still refuses to invent a booking requirement out of the same silence', async () => {
    const region = await compile(SYNTHETIC_WORLDS.remote_road!);
    for (const calendar of calendarsOfKind(region, 'unknown')) {
      /*
       * The other half, and it is not symmetrical padding. Absence of evidence
       * may not become permission, and it may not become a refusal either: a
       * fabricated "you must book" sends the traveller to a page that does not
       * exist. Unknown means unknown in both directions.
       */
      expect(calendar.admission.reservationRequired).toBe(false);
      expect(calendar.admission.permitRequired).toBe(false);
      expect(cautionsFor(region, calendar)).not.toContain(
        'There is no walk-up entry — this has to be arranged in advance.',
      );
    }
  });
});

describe('a booking requirement the funnel confirmed, on hours it could not', () => {
  it('survives the calendar it could not build', async () => {
    const region = await compile(SYNTHETIC_WORLDS.remote_road!, CONFIRMED_BOOKING_UNKNOWN_HOURS);
    const booked = region.operatingHours.calendars.filter(
      (calendar) => calendar.admission.reservationRequired,
    );
    expect(
      booked.length,
      'the fixture must confirm a booking requirement for this test to mean anything',
    ).toBeGreaterThan(0);

    for (const calendar of booked) {
      /* Walk-in entry is refused because a source said so, not assumed. */
      expect(calendar.admission.walkInAllowed).toBe(false);
      expect(cautionsFor(region, calendar)).toContain(
        'There is no walk-up entry — this has to be arranged in advance.',
      );
    }
  });

  it('is the reason a subject with unknown hours can still carry one', async () => {
    const region = await compile(SYNTHETIC_WORLDS.remote_road!, CONFIRMED_BOOKING_UNKNOWN_HOURS);
    /*
     * The specific combination the shipped code could not represent: hours
     * unknown *and* admission known. Under the shared constant every `unknown`
     * calendar carried the same fabricated permission, so this set was
     * necessarily empty.
     */
    const both = calendarsOfKind(region, 'unknown').filter(
      (calendar) => calendar.admission.reservationRequired,
    );
    expect(both.length).toBeGreaterThan(0);
  });
});

describe('genuinely open ground', () => {
  it('keeps its positive claim, because an unfenced place really has no gate', async () => {
    const region = await compile(SYNTHETIC_WORLDS.remote_road!);
    /*
     * The artifact's *own* open-ground records, run back through the production
     * hours builder with no published evidence — which is the state this branch
     * exists for.
     *
     * This read `calendarsOfKind(region, 'always_open')` off the finished
     * artifact, and that made the assertion's premise "the enrichment stage
     * happened to leave one of these places un-researched" rather than anything
     * about admission. It was a live premise only by coincidence of fixture
     * size: when a description change moved a single record out of the
     * shortlist, the stage's budget then covered every remaining open-ground
     * place, every calendar came back `scheduled`, and a test of the no-gate
     * claim failed without the no-gate claim changing at all.
     */
    const openGround = region.places.filter((place) => place.hoursExpectation === 'open_ground');
    expect(openGround.length).toBeGreaterThan(0);

    const built = buildHours(BRANCH_SCOPE, openGround, []);
    expect(built.calendars.every((calendar) => calendar.kind === 'always_open')).toBe(true);

    for (const calendar of built.calendars) {
      expect(calendar.admission.walkInAllowed).toBe(true);
      expect(calendar.admission.reservationRequired).toBe(false);
      /*
       * And no unknown-admission caution. "We do not know whether this river
       * takes reservations" is the category error the `open_ground` branch was
       * written to end, and re-introducing it here would trade one defect for
       * the one before it.
       */
      expect(assessOperatingHours({ calendar, dates: DATES }).cautions.join(' ')).not.toContain(
        'needs a ticket',
      );
    }
  });

  it('loses that claim the moment a source publishes an admission rule for it', async () => {
    const region = await compile(SYNTHETIC_WORLDS.remote_road!, CONFIRMED_BOOKING_UNKNOWN_HOURS);
    /*
     * Over the whole artifact: no calendar anywhere may claim `always_open`
     * while carrying a booking requirement. The two are contradictory claims
     * about the same place, and the shared constant made the pair unreachable
     * only by never producing the second half of it.
     */
    const contradicted = region.operatingHours.calendars.filter(
      (calendar) => calendar.admission.reservationRequired,
    );
    expect(contradicted.length).toBeGreaterThan(0);
    for (const calendar of contradicted) {
      expect(calendar.kind).not.toBe('always_open');
    }
  });

  /**
   * The branch itself, at the one function that decides it.
   *
   * The compiles above cannot reach this pairing — the fixture's open ground and
   * its researched subjects are different records — and the pairing is the whole
   * point: a record whose *category* says there is no gate and whose *evidence*
   * says tickets must be booked. The category is a prior; a source is evidence,
   * and a place with a ticket desk also has a closing time, so its hours fall to
   * `unknown` rather than staying `always_open`.
   */
  it('is overruled at the branch by evidence, and by a stated charge', () => {
    const openGround = riverPlace();

    const scope = BRANCH_SCOPE;
    const plain = buildHours(scope, [openGround], []);
    expect(plain.calendars[0]!.kind).toBe('always_open');

    const ticketed = buildHours(scope, [openGround], [], {
      version: 1,
      places: [
        {
          subjectId: openGround.id,
          aliases: [],
          costs: [],
          closures: [],
          safety: [],
          resolved: [],
          booking: {
            reservationRequired: 'yes',
            timedEntry: 'unknown',
            permitRequired: 'unknown',
            guideRequired: 'unknown',
            bookingUrl: 'https://example.org/tickets',
            claim: BRANCH_CLAIM,
          },
        },
      ],
      regionSafety: [],
    });
    expect(ticketed.calendars[0]!.kind).toBe('unknown');
    expect(ticketed.calendars[0]!.admission.walkInAllowed).toBe(false);

    /*
     * And the cheaper form of the same statement. `estimatedDefaults` naming
     * `cost_level` means the number is the archetype's price band and proves
     * nothing; a producer that listed its own guesses and did *not* list this
     * one is a source having published a fee, and a fee implies somewhere to
     * pay it.
     */
    const charging = buildHours(
      scope,
      [{ ...openGround, costLevel: 2, estimatedDefaults: ['access'] }],
      [],
    );
    expect(charging.calendars[0]!.kind).toBe('unknown');
    /* The band alone, still marked as the category's guess, changes nothing. */
    const banded = buildHours(
      scope,
      [{ ...openGround, costLevel: 2, estimatedDefaults: ['access', 'cost_level'] }],
      [],
    );
    expect(banded.calendars[0]!.kind).toBe('always_open');
  });
});
