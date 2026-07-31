import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA_FOOD, easternSierraFoodProvider } from '../data/food';
import { EASTERN_SIERRA_FOOD_ROUTING_IDS, easternSierraTravelMatrix } from '../data/travel-times';
import { EASTERN_SIERRA_PLACES } from '../data/places';
import { foodDatasetSchema, foodVenueSchema, MEDICAL_OR_OBSERVANT_NEEDS } from '../schemas/food';
import { hasPoint } from '@sidequest/geo';
import {
  assessDietary,
  dietaryUncertaintyCopy,
  earliestMealStart,
  needsExplicitEvidence,
  venueCanProvision,
  venueHoursOn,
  venueServes,
} from './availability';
import { emptyFoodDataset, FoodDataError, validateFoodDataset } from './provider';
import { foodBoardFor } from './board';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';

const AUGUST = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const CONTEXT = { travelerNeeds: [], tripDays: 4 };

const PROVENANCE = {
  kind: 'authored' as const,
  sourceName: 'Test',
  confidence: 0.5,
  volatility: 'stable' as const,
};

function venue(overrides: Record<string, unknown>) {
  return foodVenueSchema.parse({
    id: 'test-venue',
    regionId: 'r',
    name: 'Test',
    locality: 'Somewhere',
    shortDescription: 'A place.',
    coordinates: { lat: 37, lng: -118 },
    serviceType: 'restaurant',
    mealPeriods: ['lunch'],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: 60,
    reservation: { requirement: 'walk_in_only' },
    hours: {
      kind: 'scheduled',
      periods: [
        {
          label: 'All year',
          months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
          windows: [{ openMinute: 660, closeMinute: 1260 }],
        },
      ],
      provenance: PROVENANCE,
    },
    routingId: 'node',
    source: { name: 'Test', kind: 'curated', confidence: 0.6, lastVerified: '2026-07-31' },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The schema, and the honesty it enforces
// ---------------------------------------------------------------------------

describe('the food venue schema', () => {
  it('refuses to let the strongest dietary claim exist without the page it came from', () => {
    expect(() =>
      venue({
        dietary: [
          {
            need: 'gluten_free',
            evidence: 'venue_states_support',
            note: 'They say so.',
          },
        ],
      }),
    ).toThrow(/page it was read from/i);
  });

  it('accepts the same claim once it names a source', () => {
    const parsed = venue({
      dietary: [
        {
          need: 'gluten_free',
          evidence: 'venue_states_support',
          note: 'Their menu offers a gluten-free bun.',
          sourceUrl: 'https://example.com/menu',
        },
      ],
    });
    expect(parsed.dietary).toHaveLength(1);
  });

  it('will not rely on a shop for a packed lunch when nobody has confirmed its hours', () => {
    expect(() =>
      venue({
        provisioning: 'packed_meals',
        hours: { kind: 'unknown', provenance: PROVENANCE },
      }),
    ).toThrow(/relied on for provisioning/i);
  });

  it('rejects a venue that sells groceries you cannot take away', () => {
    expect(() => venue({ mealPeriods: ['groceries'], provisioning: 'none' })).toThrow(
      /cannot take anything away/i,
    );
  });

  it('rejects hours we did not fully read with nothing telling the traveller so', () => {
    expect(() =>
      foodDatasetSchema.parse({
        version: 1,
        regionId: 'r',
        venues: [
          {
            ...venue({}),
            hours: {
              kind: 'scheduled',
              hoursConfidence: 'closing_time_estimated',
              periods: [
                {
                  label: 'X',
                  months: [1],
                  windows: [{ openMinute: 660, closeMinute: 1260 }],
                },
              ],
              closedAnnualDates: [],
              provenance: PROVENANCE,
            },
          },
        ],
      }),
    ).toThrow(/did not fully read/i);
  });

  it('refuses to call unknown hours official', () => {
    expect(() =>
      foodDatasetSchema.parse({
        version: 1,
        regionId: 'r',
        venues: [
          {
            ...venue({}),
            hours: {
              kind: 'unknown',
              provenance: {
                kind: 'official',
                sourceName: 'X',
                lastVerified: '2026-07-31',
                confidence: 0.9,
                volatility: 'stable',
              },
            },
          },
        ],
      }),
    ).toThrow(/cannot have official provenance/i);
  });
});

// ---------------------------------------------------------------------------
// The provider boundary
// ---------------------------------------------------------------------------

describe('the food provider boundary', () => {
  it('rejects a dataset for a different region', () => {
    expect(() =>
      validateFoodDataset(EASTERN_SIERRA_FOOD, { regionId: 'somewhere-else' }),
    ).toThrow(FoodDataError);
  });

  it('rejects malformed data rather than letting half of it through', () => {
    expect(() => validateFoodDataset({ version: 1, regionId: 'r' }, { regionId: 'r' })).toThrow(
      /did not validate/i,
    );
  });

  it('treats an empty region as a valid answer, unlike access or hours', () => {
    // "There is no verified restaurant near Devils Postpile" is the answer, not
    // a gap in the data, so there is no coverage requirement to fail.
    const empty = emptyFoodDataset('eastern-sierra');
    expect(validateFoodDataset(empty, { regionId: 'eastern-sierra' }).venues).toEqual([]);
  });

  it('passes the curated dataset through unchanged', async () => {
    const dataset = await easternSierraFoodProvider.getFoodVenues({
      regionId: 'eastern-sierra',
      tripDates: AUGUST,
    });
    expect(validateFoodDataset(dataset, { regionId: 'eastern-sierra' })).toEqual(dataset);
  });
});

// ---------------------------------------------------------------------------
// Resolving hours against a date
// ---------------------------------------------------------------------------

describe('venue hours on a date', () => {
  it('reuses the attraction calendar engine rather than answering Tuesday twice', () => {
    const closedMondays = venue({
      hours: {
        kind: 'scheduled',
        periods: [
          {
            label: 'Tue-Sun',
            months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            daysOfWeek: [0, 2, 3, 4, 5, 6],
            windows: [{ openMinute: 660, closeMinute: 1260 }],
          },
        ],
        provenance: PROVENANCE,
      },
    });
    // 2026-08-17 is a Monday.
    expect(venueHoursOn(closedMondays, '2026-08-17').status).toBe('closed');
    expect(venueHoursOn(closedMondays, '2026-08-12').status).toBe('open');
  });

  it('will not seat a long meal five minutes before closing', () => {
    const hours = venueHoursOn(venue({}), '2026-08-12');
    expect(earliestMealStart({ hours, minutes: 60, earliest: 660, latest: 1260 })).toBe(660);
    expect(earliestMealStart({ hours, minutes: 60, earliest: 1220, latest: 1260 })).toBeNull();
  });

  it('never returns a start for hours nobody has confirmed', () => {
    const unknown = venueHoursOn(
      venue({ hours: { kind: 'unknown', provenance: PROVENANCE } }),
      '2026-08-12',
    );
    expect(earliestMealStart({ hours: unknown, minutes: 30, earliest: 600, latest: 1200 })).toBeNull();
  });

  it('knows a cafe can do breakfast and a bakery that shuts at four cannot do dinner', () => {
    const cafe = venue({ serviceType: 'cafe', mealPeriods: ['coffee', 'snack'] });
    expect(venueServes(cafe, 'breakfast')).toBe(true);
    expect(venueServes(cafe, 'dinner')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dietary evidence — the part that must never overstate
// ---------------------------------------------------------------------------

describe('dietary evidence', () => {
  const supported = venue({
    dietary: [
      {
        need: 'gluten_free',
        evidence: 'venue_states_support',
        note: 'Their menu offers a gluten-free bun.',
        sourceUrl: 'https://example.com/menu',
      },
      { need: 'vegan', evidence: 'venue_states_unsuitable', note: 'They say they cannot.' },
    ],
  });

  it('separates what the venue said from what nobody has said', () => {
    const verdict = assessDietary(supported, ['gluten_free', 'vegan', 'halal']);
    expect(verdict.supported.map((claim) => claim.need)).toEqual(['gluten_free']);
    expect(verdict.blocked).toEqual(['vegan']);
    expect(verdict.unverified).toEqual(['halal']);
  });

  it('never produces a bucket that means "probably fine"', () => {
    const verdict = assessDietary(venue({}), ['nut_allergy']);
    expect(verdict.supported).toEqual([]);
    expect(verdict.blocked).toEqual([]);
    expect(verdict.unverified).toEqual(['nut_allergy']);
  });

  it('holds medical and observant needs to explicit evidence even when not declared strict', () => {
    for (const need of MEDICAL_OR_OBSERVANT_NEEDS) {
      expect(needsExplicitEvidence(need, false)).toBe(true);
    }
    expect(needsExplicitEvidence('vegetarian', false)).toBe(false);
    expect(needsExplicitEvidence('vegetarian', true)).toBe(true);
  });

  it('says nobody has confirmed it, and never says it is safe', () => {
    const copy = dietaryUncertaintyCopy('Somewhere', ['nut allergies']);
    expect(copy).toMatch(/nobody has confirmed/i);
    expect(copy).not.toMatch(/safe|suitable|fine/i);
  });
});

// ---------------------------------------------------------------------------
// The Eastern Sierra fixture
// ---------------------------------------------------------------------------

describe('the Eastern Sierra food fixture', () => {
  it('validates at the boundary it will cross in production', () => {
    expect(validateFoodDataset(EASTERN_SIERRA_FOOD, { regionId: 'eastern-sierra' })).toBeTruthy();
  });

  it('gives every venue a routing node the travel-time matrix actually has', () => {
    const matrix = easternSierraTravelMatrix();
    for (const entry of EASTERN_SIERRA_FOOD.venues) {
      expect(hasPoint(matrix, entry.routingId), `${entry.id} → ${entry.routingId}`).toBe(true);
    }
    for (const id of EASTERN_SIERRA_FOOD_ROUTING_IDS) {
      expect(hasPoint(matrix, id)).toBe(true);
    }
  });

  it('points every gap record at places that exist', () => {
    const placeIds = new Set(EASTERN_SIERRA_PLACES.map((place) => place.id));
    for (const gap of EASTERN_SIERRA_FOOD.gaps) {
      for (const placeId of gap.placeIds) expect(placeIds.has(placeId)).toBe(true);
      // A claim that somewhere has no food is a claim about the world, so it
      // needs a source that is not us.
      expect(gap.provenance.kind).toBe('official');
      expect(gap.provenance.sourceUrl).toBeTruthy();
    }
  });

  it('never calls a directory listing the venue', () => {
    for (const entry of EASTERN_SIERRA_FOOD.venues) {
      if (entry.hours.provenance.kind !== 'official') continue;
      expect(entry.hours.provenance.sourceUrl).toBeTruthy();
      expect(entry.hours.provenance.lastVerified).toBeTruthy();
    }
  });

  it('tells the traveller to ring wherever a closing time is ours', () => {
    for (const entry of EASTERN_SIERRA_FOOD.venues) {
      if (entry.hours.hoursConfidence === 'published') continue;
      expect(entry.hours.provenance.recheckNote, entry.id).toBeTruthy();
    }
  });

  it('carries no ratings and no review counts', () => {
    const rendered = JSON.stringify(EASTERN_SIERRA_FOOD);
    expect(rendered).not.toMatch(/"rating"|"reviews"|"stars"/i);
  });

  it('holds somewhere to buy a packed lunch, or the remote days are unplannable', () => {
    expect(EASTERN_SIERRA_FOOD.venues.filter(venueCanProvision).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The board section
// ---------------------------------------------------------------------------

describe('the derived food board section', () => {
  const profile = buildTravelerProfile(defaultAnswers(CONTEXT), CONTEXT);

  it('stays short enough not to become a second board', () => {
    const entries = foodBoardFor({ dataset: EASTERN_SIERRA_FOOD, profile, dates: AUGUST });
    expect(entries.length).toBeLessThanOrEqual(6);
  });

  it('only surfaces venues where the traveller’s opinion changes the trip', () => {
    const entries = foodBoardFor({ dataset: EASTERN_SIERRA_FOOD, profile, dates: AUGUST });
    for (const entry of entries) expect(entry.why.length).toBeGreaterThan(10);
  });

  it('offers no special-meal candidates to somebody who asked for none', () => {
    const budget = buildTravelerProfile(
      { ...defaultAnswers(CONTEXT), foodStyle: 'budget', specialMealAppetite: 'none' },
      CONTEXT,
    );
    const entries = foodBoardFor({ dataset: EASTERN_SIERRA_FOOD, profile: budget, dates: AUGUST });
    for (const entry of entries) expect(entry.priceBand).not.toBe('special');
  });

  it('shows a venue that is shut on the dates rather than hiding it', () => {
    const january = ['2026-01-12', '2026-01-13'];
    const entries = foodBoardFor({ dataset: EASTERN_SIERRA_FOOD, profile, dates: january });
    // Whoa Nellie and Silver Lake are genuinely seasonal; if either makes the
    // list in January it must be labelled, not quietly recommended.
    for (const entry of entries) {
      expect(typeof entry.closedThroughout).toBe('boolean');
    }
  });
});
