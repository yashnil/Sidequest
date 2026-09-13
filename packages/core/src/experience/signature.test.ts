import { describe, expect, it } from 'vitest';
import { selectSignatureExperiences, type SignatureCandidate } from './signature';

/**
 * The founder's Kyrgyzstan trip, as its anchors actually stood. Four fit
 * travellers, intense hiking, wildlife and scenery. The product answered
 * "the trip is built around" with days 1, 2 and 3.
 */
const KYRGYZSTAN: SignatureCandidate[] = [
  { id: 'a1', name: 'Ala-Too Square', dayNumber: 1, category: 'landmark', minutes: 75, physicalIntensity: 'easy', onEdgeDay: true },
  { id: 'a2', name: 'Osh Bazaar', dayNumber: 1, category: 'market', minutes: 75, physicalIntensity: 'easy', onEdgeDay: true },
  { id: 'a3', name: 'Issyk-Kul north shore', dayNumber: 2, category: 'viewpoint', minutes: 0, physicalIntensity: 'easy' },
  { id: 'a4', name: 'Karakol Sunday/daily market', dayNumber: 3, category: 'market', minutes: 75, physicalIntensity: 'easy' },
  { id: 'a5', name: 'Przhevalsky Museum area walk', dayNumber: 3, category: 'museum', minutes: 40, physicalIntensity: 'easy' },
  { id: 'a6', name: 'Altyn-Arashan valley', dayNumber: 4, category: 'hiking', minutes: 180, physicalIntensity: 'moderate', withinExperience: 'Ala-Kul & Altyn-Arashan trek' },
  { id: 'a7', name: 'Ala-Kul Pass', dayNumber: 5, category: 'hiking', minutes: 180, physicalIntensity: 'strenuous', withinExperience: 'Ala-Kul & Altyn-Arashan trek', routeCritical: true },
  { id: 'a8', name: 'Ala-Kul Lake', dayNumber: 5, category: 'lake', minutes: 90, physicalIntensity: 'strenuous', withinExperience: 'Ala-Kul & Altyn-Arashan trek' },
  { id: 'a9', name: 'Jeti-Oguz canyon', dayNumber: 7, category: 'scenery', minutes: 90, physicalIntensity: 'easy' },
  { id: 'a10', name: 'Song-Kol Lake', dayNumber: 8, category: 'lake', minutes: 90, physicalIntensity: 'moderate', withinExperience: 'Song-Kol yurt stay', routeCritical: true },
  { id: 'a11', name: 'Jailoo horseback ride', dayNumber: 8, category: 'wildlife', minutes: 150, physicalIntensity: 'moderate', withinExperience: 'Song-Kol yurt stay' },
  { id: 'a12', name: 'Skazka Canyon (Fairy Tale Canyon)', dayNumber: 10, category: 'scenery', minutes: 180, physicalIntensity: 'moderate' },
];

const HIKING_TRAVELLER = ['hiking', 'scenery', 'wildlife', 'photography'];

describe('V11 §7 — the trip is built around what it is actually built around', () => {
  const picked = selectSignatureExperiences({
    candidates: KYRGYZSTAN,
    statedSignatures: ['Ala-Kul Pass crossing', 'Song-Kol yurt and horseback', 'Altyn-Arashan'],
    travellerInterests: HIKING_TRAVELLER,
    travellerWantsEffort: true,
  });
  const names = picked.map((p) => p.name);

  it('picks three', () => {
    expect(picked).toHaveLength(3);
  });

  it('does not answer with days 1, 2 and 3', () => {
    expect(names).not.toEqual(['Osh Bazaar', 'Issyk-Kul north shore', 'Karakol Sunday/daily market']);
  });

  it('ranks the trek and the yurt expedition above every incidental market and viewpoint', () => {
    expect(names).not.toContain('Osh Bazaar');
    expect(names).not.toContain('Karakol Sunday/daily market');
    expect(names).not.toContain('Issyk-Kul north shore');
    expect(names.some((n) => n.startsWith('Ala-Kul'))).toBe(true);
    expect(names.some((n) => n.startsWith('Song-Kol') || n === 'Jailoo horseback ride')).toBe(true);
  });

  it('names both defining experiences rather than three stops of one of them', () => {
    const experiences = new Set(picked.map((p) => KYRGYZSTAN.find((c) => c.id === p.id)?.withinExperience).filter(Boolean));
    expect(experiences.size).toBeGreaterThanOrEqual(2);
  });

  it('presents them in trip order, so the list reads as a trip and not a ranking', () => {
    expect(picked.map((p) => p.dayNumber)).toEqual([...picked.map((p) => p.dayNumber)].sort((a, b) => a - b));
  });

  it('explains each pick with the signals that carried it', () => {
    for (const pick of picked) expect(pick.reasons.length).toBeGreaterThan(0);
    expect(picked.find((p) => p.name === 'Ala-Kul Pass')?.reasons).toContain('statedByPlan');
  });
});

/** The Canadian Rockies list, which opened with a 90-minute riverside walk taken to fill the arrival evening. */
const ROCKIES: SignatureCandidate[] = [
  { id: 'r1', name: 'Bow Falls', dayNumber: 1, category: 'waterfall', minutes: 90, physicalIntensity: 'easy', onEdgeDay: true },
  { id: 'r2', name: 'Banff Gondola', dayNumber: 1, category: 'viewpoint', minutes: 40, physicalIntensity: 'easy', onEdgeDay: true },
  { id: 'r3', name: 'Lake Louise', dayNumber: 2, category: 'lake', minutes: 90, physicalIntensity: 'easy', routeCritical: true },
  { id: 'r4', name: 'Plain of Six Glaciers Trail', dayNumber: 2, category: 'hiking', minutes: 300, physicalIntensity: 'strenuous' },
  { id: 'r5', name: 'Moraine Lake', dayNumber: 3, category: 'lake', minutes: 40, physicalIntensity: 'easy', constrained: true, routeCritical: true },
  { id: 'r6', name: 'Athabasca Glacier', dayNumber: 4, category: 'glacier', minutes: 90, physicalIntensity: 'moderate', routeCritical: true },
  { id: 'r7', name: 'Sunshine Meadows', dayNumber: 10, category: 'hiking', minutes: 240, physicalIntensity: 'strenuous' },
];

describe('V11 §7 — the Canadian Rockies list', () => {
  const picked = selectSignatureExperiences({
    candidates: ROCKIES,
    statedSignatures: [],
    travellerInterests: ['hiking', 'scenery', 'wildlife', 'road trips'],
    travellerWantsEffort: true,
  });
  const names = picked.map((p) => p.name);

  it('does not open with the arrival-evening filler', () => {
    expect(names).not.toContain('Bow Falls');
    expect(names).not.toContain('Banff Gondola');
  });

  it('finds the day the trip is actually for', () => {
    expect(names).toContain('Plain of Six Glaciers Trail');
  });

  it('works with no stated signatures at all', () => {
    expect(picked).toHaveLength(3);
  });
});

describe('V11 §7 — the scorer has no opinion about markets as such', () => {
  it('ranks a market first for a traveller who ranked food and markets, on the same anchors', () => {
    const foodTraveller = selectSignatureExperiences({
      candidates: [
        { id: 'm1', name: 'A city market', dayNumber: 2, category: 'market', minutes: 180, physicalIntensity: 'easy' },
        { id: 'm2', name: 'A long ridge walk', dayNumber: 3, category: 'hiking', minutes: 300, physicalIntensity: 'strenuous' },
      ],
      travellerInterests: ['food', 'market', 'culture'],
      limit: 1,
    });
    expect(foodTraveller[0]!.name).toBe('A city market');
  });

  it('and the walk first for a hiker, from exactly the same candidates', () => {
    const hiker = selectSignatureExperiences({
      candidates: [
        { id: 'm1', name: 'A city market', dayNumber: 2, category: 'market', minutes: 180, physicalIntensity: 'easy' },
        { id: 'm2', name: 'A long ridge walk', dayNumber: 3, category: 'hiking', minutes: 300, physicalIntensity: 'strenuous' },
      ],
      travellerInterests: ['hiking', 'scenery'],
      travellerWantsEffort: true,
      limit: 1,
    });
    expect(hiker[0]!.name).toBe('A long ridge walk');
  });

  it('never names two experiences of one category when a third kind is available', () => {
    const picked = selectSignatureExperiences({
      candidates: [
        { id: 'x1', name: 'Lake one', dayNumber: 1, category: 'lake', minutes: 120, physicalIntensity: 'easy' },
        { id: 'x2', name: 'Lake two', dayNumber: 2, category: 'lake', minutes: 120, physicalIntensity: 'easy' },
        { id: 'x3', name: 'A canyon walk', dayNumber: 3, category: 'scenery', minutes: 110, physicalIntensity: 'easy' },
      ],
      travellerInterests: ['scenery'],
      limit: 2,
    });
    expect(picked).toHaveLength(2);
    expect(picked.filter((p) => p.name.startsWith('Lake'))).toHaveLength(1);
  });

  it('returns nothing rather than inventing something when there are no candidates', () => {
    expect(selectSignatureExperiences({ candidates: [] })).toEqual([]);
  });
});
