import { describe, expect, it } from 'vitest';
import { buildBudgetIntelligence, type BudgetInput } from './budget';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';

/**
 * V11 §36 — THE BUDGET UNDERSTANDS AN OPERATED EXPERIENCE.
 *
 * The founder's Kyrgyzstan trip carried a three-day guided trek with camp
 * support and a two-day yurt-and-horse expedition — both of which its own
 * Book-first page listed as trip-critical, with fixed departures — and priced
 * the pair at nothing. Its only "Guides and tours" line read *"3 days with a
 * hired car and driver, 180–420 for the party"*, and the four expedition nights
 * were billed as ordinary hotel nights.
 */
function profile() {
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: 11 });
  return buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 11 });
}

function input(episodes: unknown[]): BudgetInput {
  return {
    itinerary: {
      days: Array.from({ length: 11 }, (_, index) => ({ dayNumber: index + 1, items: [], weather: {} })),
      transportStrategy: { primaryMode: 'private_transfer', totals: { driveKm: 0 } },
    },
    pkg: { episodes, bases: [], anchors: [] },
    profile: profile(),
    travellers: 4,
    international: 'yes',
    permitCount: 0,
    guideDays: 0,
    legs: [],
    booked: [],
    driving: 'private_driver',
    selfDrives: false,
  } as unknown as BudgetInput;
}

const TREK = { name: 'A three-day traverse', kind: 'trek', dayNumbers: [4, 5, 6], baseIds: ['b3'], mode: 'walk', timing: 'operator', meals: 'included', entryLeg: 'present', exitLeg: 'present' };
const YURT = { name: 'A two-day yurt stay', kind: 'guided_overland', dayNumbers: [8, 9], baseIds: ['b6'], mode: 'horse', timing: 'operator', meals: 'included', entryLeg: 'present', exitLeg: 'present' };

describe('V11 §36 — operator-run multi-day experiences are priced', () => {
  const withEpisodes = buildBudgetIntelligence(input([TREK, YURT]));
  const guides = withEpisodes.lines.filter((line) => line.category === 'guides_tours');

  it('gives the two experiences a cost line of their own', () => {
    expect(guides.length).toBeGreaterThan(0);
    const bundle = guides.find((line) => line.bundle);
    expect(bundle).toBeDefined();
    expect(bundle!.basis).toContain('A three-day traverse');
    expect(bundle!.basis).toContain('A two-day yurt stay');
  });

  it('prices them per person, over the days they actually run', () => {
    const bundle = guides.find((line) => line.bundle)!;
    expect(bundle.perPerson).toBe(true);
    /* Five operated days at the midrange band. */
    expect(bundle.low).toBeGreaterThan(400);
  });

  it('is honest that nobody looked up a price', () => {
    expect(guides.find((line) => line.bundle)!.precision).toBe('unknown');
  });

  it('does not bill the expedition nights twice', () => {
    const lodging = withEpisodes.lines.find((line) => line.category === 'lodging')!;
    const without = buildBudgetIntelligence(input([])).lines.find((line) => line.category === 'lodging')!;
    /* Ten nights become six hotel nights: four belong to the two experiences. */
    expect(lodging.low).toBeLessThan(without.low);
    expect(lodging.basis).toMatch(/priced with the experience/);
  });

  it('moves the total materially, which is the whole point', () => {
    const withOut = buildBudgetIntelligence(input([]));
    expect(withEpisodes.total.high).toBeGreaterThan(withOut.total.high);
  });

  it('adds nothing at all to a trip with no operated experience', () => {
    const plain = buildBudgetIntelligence(input([]));
    expect(plain.lines.some((line) => line.bundle)).toBe(false);
  });

  it('never bundles a self-timed multi-day segment: nobody is selling it', () => {
    const selfDriven = buildBudgetIntelligence(input([{ ...TREK, timing: 'self' }]));
    expect(selfDriven.lines.some((line) => line.bundle)).toBe(false);
  });
});
