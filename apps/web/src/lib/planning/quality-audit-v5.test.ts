import { describe, expect, it } from 'vitest';
import { boardWorld, draftOf } from './acceptance/harness';
import { reconcileTripDraft } from './reconcile';
import { auditItinerary, type QualityAudit, type QualityCheckId } from './quality-audit';
import type { TripDraft } from './trip-draft';
import type { Trip } from '@sidequest/core';

/**
 * THE V5 STRUCTURAL CHECKS, EACH SHOWN CATCHING THE THING IT EXISTS FOR.
 *
 * PRODUCTION LOCK V5 §53. Every check here was written from a real defect in one
 * of the founder's two live trips, and each test is in two halves: the shape that
 * must pass, and the shape that must fail. A check that only ever passes is a
 * check nobody can trust — that is how `no_zero_minute_travel` would have looked
 * before the Ireland build proved it necessary.
 *
 * These are structural, never taste. None of them says a trip is good; each says
 * a trip is not internally contradictory.
 */

const TRIP_BASE = {
  mode: 'known_destination' as const,
  destinationInput: 'Mammoth Lakes',
  regionId: 'eastern-sierra',
  startDate: '2026-08-01',
  endDate: '2026-08-04',
  arrivalTime: '10:00',
  departureTime: '17:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

async function auditOf(draft: TripDraft, overrides: Partial<Trip['basics']> = {}): Promise<QualityAudit> {
  const context = boardWorld();
  const result = await reconcileTripDraft({ draft, context });
  const trip: Trip = { id: 'audit-v5', basics: { ...TRIP_BASE, ...context.basics, ...overrides }, status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  return auditItinerary({ draft, itinerary: result.itinerary, profile: context.profile, trip });
}

function check(audit: QualityAudit, id: QualityCheckId) {
  const found = audit.checks.find((entry) => entry.id === id);
  if (!found) throw new Error(`the audit no longer runs ${id}`);
  return found;
}

const THREE_DAYS = [
  { base: 'base', anchors: [{ name: 'Convict Lake' }] },
  { base: 'base', anchors: [{ name: 'Mono Lake' }] },
  { base: 'base', anchors: [{ name: 'Hot Creek' }] },
];

describe('§9 — signature experiences', () => {
  it('passes when every named signature appears in the days', async () => {
    const audit = await auditOf(draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }], days: THREE_DAYS, signatures: ['Mono Lake'] }));
    expect(check(audit, 'signatures_present').ok).toBe(true);
  });

  it('fails when the trip names something central and never delivers it', async () => {
    const audit = await auditOf(draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }], days: THREE_DAYS, signatures: ['A Four-Day Traverse Of The High Sierra'] }));
    const result = check(audit, 'signatures_present');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/absent from every day/);
  });

  it('accepts a signature the days name in a different form, in either direction', async () => {
    /*
     * The false-positive case this check must not produce. "The Ala-Kul
     * Traverse" is delivered by days whose `partOf` reads "Ala-Kul Traverse",
     * and the shorter name "Convict Lake" is delivered by the activity of the
     * same name. Both directions of containment count.
     */
    const longer = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [
          { base: 'base', anchors: [{ name: 'Convict Lake' }], partOf: 'Ala-Kul Traverse' },
          { base: 'base', anchors: [{ name: 'Mono Lake' }], partOf: 'Ala-Kul Traverse' },
          { base: 'base', anchors: [{ name: 'Hot Creek' }] },
        ],
        signatures: ['The Ala-Kul Traverse'],
      }),
    );
    expect(check(longer, 'signatures_present').ok).toBe(true);

    const shorter = await auditOf(draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }], days: THREE_DAYS, signatures: ['Convict'] }));
    expect(check(shorter, 'signatures_present').ok).toBe(true);
  });

  it('says so, without failing, when a draft names no signature at all', async () => {
    const audit = await auditOf(draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }], days: THREE_DAYS }));
    const result = check(audit, 'signatures_present');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/names no signature/);
  });
});

describe('§13 — time-of-day intent', () => {
  /**
   * The scheduler now holds a time-dependent stop back to its part of the day
   * (`reconcile.ts`, PRODUCTION LOCK V5 §13), so the ordinary case is that this
   * check passes because the plan is right — not because nothing looks.
   */
  it('the scheduler holds a sunset experience back to late afternoon', async () => {
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [
          { base: 'base', anchors: [{ name: 'Convict Lake', timeOfDay: 'sunset' }] },
          ...THREE_DAYS.slice(1),
        ],
      }),
    );
    expect(check(audit, 'time_intent_respected').ok).toBe(true);
  });

  it('judges only what was scheduled, and never invents a breach for a stop that was not', async () => {
    /*
     * The departure day cannot reach the evening, and the reconciler does not
     * extend the last day to try (that would push somebody past their flight).
     * The stop is simply not scheduled, and a check that reported a breach for
     * something the traveller was never sent to would be reporting on nothing.
     *
     * The stop is not lost either: preservation accounts for every draft anchor
     * and the day says why it holds nothing. That is `no_silent_loss`'s job, not
     * this check's.
     */
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [...THREE_DAYS.slice(0, 2), { base: 'base', anchors: [{ name: 'Hot Creek', timeOfDay: 'night' }] }],
      }),
    );
    const result = check(audit, 'time_intent_respected');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/sit in their part of the day/);
  });

  it('passes when the same experience asks for the afternoon it actually gets', async () => {
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [{ base: 'base', anchors: [{ name: 'Convict Lake', timeOfDay: 'afternoon' }] }, ...THREE_DAYS.slice(1)],
      }),
    );
    expect(check(audit, 'time_intent_respected').ok).toBe(true);
  });

  /*
   * An edge day's window is cut by the flight, not by the plan. A "morning"
   * stop pushed to 13:45 by a 10:00 arrival is the arrival doing that, and this
   * check must not fire on it — otherwise it fires on almost every trip and
   * stops being read. The hour-critical intents are exempt from the exemption.
   */
  it('does not blame the plan for a soft intent squeezed by the arrival', async () => {
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [{ base: 'base', anchors: [{ name: 'Convict Lake', timeOfDay: 'morning' }] }, ...THREE_DAYS.slice(1)],
      }),
    );
    expect(check(audit, 'time_intent_respected').ok).toBe(true);
  });

  it('holds an evening experience back to the evening', async () => {
    /*
     * `evening` rather than `night` here for a reason worth stating: this
     * fixture world's days end at 19:00, and an 18:00 floor plus the stop's own
     * duration does not fit inside that. The floor is only applied when the day
     * can still hold the stop — a stop that cannot reach its hour keeps its
     * place rather than being pushed off the end — so the honest way to exercise
     * the mechanism here is an hour the day can actually reach.
     */
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [THREE_DAYS[0]!, { base: 'base', anchors: [{ name: 'Mono Lake', timeOfDay: 'evening' }] }, THREE_DAYS[2]!],
      }),
    );
    expect(check(audit, 'time_intent_respected').ok).toBe(true);
  });
});

describe('§10 — a multi-day experience is one continuous thing', () => {
  it('passes for consecutive days', async () => {
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [
          { base: 'base', anchors: [{ name: 'Convict Lake' }], partOf: 'The High Route' },
          { base: 'base', anchors: [{ name: 'Mono Lake' }], partOf: 'The High Route' },
          { base: 'base', anchors: [{ name: 'Hot Creek' }] },
        ],
      }),
    );
    expect(check(audit, 'multi_day_continuous').ok).toBe(true);
  });

  it('fails when a trek pauses for a day and resumes', async () => {
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [
          { base: 'base', anchors: [{ name: 'Convict Lake' }], partOf: 'The High Route' },
          { base: 'base', anchors: [{ name: 'Mono Lake' }] },
          { base: 'base', anchors: [{ name: 'Hot Creek' }], partOf: 'The High Route' },
        ],
      }),
    );
    const result = check(audit, 'multi_day_continuous');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/interrupted: The High Route on days 1, 3/);
  });
});

describe('§15 — transport arrangement invariants', () => {
  const withAdvice = (driving: TripDraft['driving'], notes: string[]) =>
    draftOf({
      bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
      days: THREE_DAYS,
      driving,
      package: { foodStrategy: ['Simple local meals.'], transport: { summary: 'Getting around.', notes }, beforeYouGo: ['Verify official entry requirements.'], packing: ['Layers'], backups: [{ trigger: 'Rain', alternative: 'The museum.' }] },
    });

  it('fails when a private-driver trip is given rental and parking advice', async () => {
    const audit = await auditOf(withAdvice('private_driver', ['Bring your International Driving Permit for the rental desk.', 'Parking in town is metered.']));
    const result = check(audit, 'transport_arrangement_consistent');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/driving is private_driver but the traveller is told about/);
    expect(result.detail).toMatch(/parking/);
  });

  it('passes when the same advice sits on a self-drive trip', async () => {
    const audit = await auditOf(withAdvice('rental_self_drive', ['Bring your International Driving Permit for the rental desk.', 'Parking in town is metered.']));
    const result = check(audit, 'transport_arrangement_consistent');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/self-drive advice is warranted/);
  });

  it('passes for a transit trip that says nothing about cars', async () => {
    const audit = await auditOf(withAdvice('none', ['A single transit pass covers every day.']));
    expect(check(audit, 'transport_arrangement_consistent').ok).toBe(true);
  });
});

describe('§11 — lodging character on a moving trip', () => {
  const moving = (styles: string[]) =>
    draftOf({
      bases: styles.map((style, index) => ({ id: `b${index}`, name: ['Mammoth Lakes', 'June Lake', 'Bishop'][index] ?? `Base ${index}`, nights: 1, style })),
      days: styles.map((_, index) => ({ base: `b${index}`, anchors: [{ name: ['Convict Lake', 'Mono Lake', 'Hot Creek'][index] ?? 'Convict Lake' }] })),
    });

  it('warns when three bases all describe the same lodging', async () => {
    const audit = await auditOf(moving(['mid-range guesthouse', 'mid-range guesthouse', 'mid-range guesthouse']));
    const result = check(audit, 'lodging_has_character');
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('warning');
    expect(result.detail).toMatch(/all 3 bases describe the same lodging/);
  });

  it('passes when the lodging follows the trip', async () => {
    const audit = await auditOf(moving(['small hotel near the lake', 'mountain hut on the ridge', 'guesthouse in town']));
    expect(check(audit, 'lodging_has_character').ok).toBe(true);
  });
});

describe('§22 — meals are decisions', () => {
  const withMeals = (meals: { lunch?: string; dinner?: string }[]) =>
    draftOf({
      bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
      days: THREE_DAYS.map((day, index) => ({ ...day, meals: meals[index] ?? {} })),
    });

  it('fails a trip whose every meal is a placeholder', async () => {
    const audit = await auditOf(withMeals([{ lunch: 'lunch near base' }, { lunch: 'near base', dinner: 'somewhere local' }, { dinner: 'dinner at the hotel' }]));
    const result = check(audit, 'meals_are_decisions');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/say nothing a traveller could act on/);
  });

  it('passes a trip whose meals name something specific', async () => {
    const audit = await auditOf(
      withMeals([
        { lunch: 'the trout place at the lake landing', dinner: 'the taqueria on Main Street' },
        { lunch: 'packed lunch from the bakery before the pass', dinner: 'the old hotel dining room in Lee Vining' },
        { dinner: 'the ramen counter behind the market' },
      ]),
    );
    expect(check(audit, 'meals_are_decisions').ok).toBe(true);
  });
});

describe('§25 — backups belong to a day they can help on', () => {
  const withBackups = (backups: { trigger: string; alternative: string; day?: number }[]) =>
    draftOf({
      bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
      days: THREE_DAYS,
      package: { foodStrategy: ['Simple local meals.'], transport: { summary: 'Getting around.', notes: [] }, beforeYouGo: ['Verify official entry requirements.'], packing: ['Layers'], backups },
    });

  it('warns about a backup on the departure day, where there is nothing left to fall back from', async () => {
    const audit = await auditOf(withBackups([{ trigger: 'The pass is closed', alternative: 'The lower lake loop.', day: 3 }]));
    const result = check(audit, 'backups_are_local');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/a day they cannot help/);
  });

  it('passes a backup scoped to a day in the middle of the trip', async () => {
    const audit = await auditOf(withBackups([{ trigger: 'The pass is closed', alternative: 'The lower lake loop.', day: 2 }]));
    const result = check(audit, 'backups_are_local');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/1 of 1 backup\(s\) name the day they cover/);
  });
});

describe('§7 — no invented edge time is ever stated', () => {
  it('passes for an unknown departure, and the detail says the time is not set', async () => {
    const audit = await auditOf(
      draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }], days: THREE_DAYS }),
      { departureTime: '11:00', departurePrecision: undefined, arrivalPrecision: undefined, arrivalTime: '15:00' },
    );
    const result = check(audit, 'edge_times_not_invented');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/time not set yet/);
  });

  it('names both edges when they are real', async () => {
    const audit = await auditOf(
      draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }], days: THREE_DAYS }),
      { arrivalPrecision: 'exact', departurePrecision: 'exact' },
    );
    const result = check(audit, 'edge_times_not_invented');
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/arrival at \d\d:\d\d, departure at \d\d:\d\d/);
  });
});

/**
 * §9 — THE FALSE POSITIVE A LIVE BUILD PRODUCED.
 *
 * The Hong Kong build named its signatures as descriptions and delivered them as
 * named activities. Substring matching found nothing and the audit reported all
 * three central experiences as absent from a trip that plainly contained them.
 */
describe('§9 — a signature described one way and delivered another', () => {
  it('accepts a descriptive signature the days deliver under shorter names', async () => {
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: [
          { base: 'base', anchors: [{ name: 'Convict Lake' }], theme: 'Dim sum crawl and old quarter' },
          { base: 'base', anchors: [{ name: 'Mono Lake' }], theme: 'Graham Street Market morning' },
          { base: 'base', anchors: [{ name: 'Hot Creek' }] },
        ],
        signatures: ['Dim sum and wet market crawl through Sheung Wan and Central'],
      }),
    );
    /* "dim", "sum", "market", "crawl" all appear; "wet", "sheung", "wan", "central" do not. Over half is enough. */
    expect(check(audit, 'signatures_present').ok).toBe(true);
  });

  it('still fails a signature the trip genuinely never delivers', async () => {
    const audit = await auditOf(
      draftOf({
        bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }],
        days: THREE_DAYS,
        signatures: ['Overnight yurt camp beside the glacier lagoon'],
      }),
    );
    const result = check(audit, 'signatures_present');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/absent from every day/);
  });
});

/**
 * §15/§22/§26 — ADVICE THAT ONLY MAKES SENSE FOR ANOTHER TRIP.
 *
 * Both of these came out of the live Hong Kong build. Neither is a crash and
 * neither is caught by a schema; both are a traveller reading a sentence about
 * somebody else's holiday on the page that is supposed to be theirs.
 */
describe('§15 — parking advice belongs to a trip with a car in it', () => {
  const cityDraft = (driving: TripDraft['driving']) =>
    draftOf({ bases: [{ id: 'base', name: 'Mammoth Lakes', nights: 3 }], days: THREE_DAYS, driving });

  it('a trip nobody drives is told there is no parking to arrange', async () => {
    const context = boardWorld();
    const result = await reconcileTripDraft({ draft: cityDraft('none'), context });
    expect(result.itinerary.transportStrategy.parkingSummary).toMatch(/No parking to arrange/);
    expect(result.itinerary.transportStrategy.parkingSummary).not.toMatch(/check at each stop/);
  });

  it('a private-driver trip is told the same, because the car is not theirs', async () => {
    const context = boardWorld();
    const result = await reconcileTripDraft({ draft: cityDraft('private_driver'), context });
    expect(result.itinerary.transportStrategy.parkingSummary).toMatch(/No parking to arrange/);
  });

  it('a self-drive trip still gets the parking caution', async () => {
    const context = boardWorld();
    const result = await reconcileTripDraft({ draft: cityDraft('rental_self_drive'), context });
    expect(result.itinerary.transportStrategy.parkingSummary).toMatch(/check at each stop/);
  });
});
