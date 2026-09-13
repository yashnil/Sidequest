import { describe, expect, it } from 'vitest';
import { definingSetIsWeak, scoreExperienceValue } from './value';

/**
 * V10 §12 — the founder's Iceland signature set, scored.
 *
 * The point of the test is not that a church scores low in the abstract. It is
 * that for an adventurous traveller who ranked hiking, glaciers and landscape,
 * a city church and a museum are a *weak defining set* — which
 * `signatureCoverage: 1.0` reported as perfect.
 */
const ADVENTUROUS = ['hiking', 'glaciers', 'scenic_drives', 'waterfalls', 'photography'];

describe('experience value', () => {
  const hallgrimskirkja = scoreExperienceValue({ name: 'Hallgrímskirkja', tags: ['architecture', 'landmark'], travellerInterests: ADVENTUROUS, genericAnywhere: true, minutes: 45, detourKm: 2, verification: 'partially_verified' });
  const museum = scoreExperienceValue({ name: 'National Museum of Iceland', tags: ['museums', 'history'], travellerInterests: ADVENTUROUS, genericAnywhere: true, minutes: 90, detourKm: 3, verification: 'partially_verified' });
  const jokulsarlon = scoreExperienceValue({ name: 'Jökulsárlón glacier lagoon', tags: ['glaciers', 'photography'], travellerInterests: ADVENTUROUS, destinationTypical: true, minutes: 120, detourKm: 8, inSeason: true, verification: 'partially_verified' });
  const landmannalaugar = scoreExperienceValue({ name: 'Landmannalaugar', tags: ['hiking', 'scenic_drives'], travellerInterests: ADVENTUROUS, destinationTypical: true, minutes: 480, detourKm: 120, inSeason: true, verification: 'partially_verified' });

  it('ranks a glacier lagoon above a city church for this traveller', () => {
    expect(jokulsarlon.score).toBeGreaterThan(hallgrimskirkja.score);
    expect(landmannalaugar.score).toBeGreaterThan(museum.score);
  });

  it('names which signal was weak rather than only lowering a number', () => {
    expect(hallgrimskirkja.weakest.map((w) => w.signal)).toContain('uniqueness');
    expect(hallgrimskirkja.weakest[0]!.why).toMatch(/most cities have|match much of what you ranked/);
  });

  it('does not punish popularity: a glacier lagoon is a famous thing and scores well', () => {
    expect(jokulsarlon.signals.uniqueness).toBe(1);
    expect(jokulsarlon.score).toBeGreaterThan(0.7);
  });

  it("calls the founder's opening set weak, and the landscape set strong", () => {
    const weak = definingSetIsWeak({ values: [hallgrimskirkja, museum, scoreExperienceValue({ name: 'Sky Lagoon', tags: ['wellness'], travellerInterests: ADVENTUROUS, genericAnywhere: true, minutes: 120, detourKm: 10, verification: 'partially_verified' })] });
    expect(weak.weak).toBe(true);
    expect(weak.detail).toMatch(/most destinations have|strongest thing/);

    const strong = definingSetIsWeak({ values: [jokulsarlon, landmannalaugar, scoreExperienceValue({ name: 'Skógafoss', tags: ['waterfalls', 'photography'], travellerInterests: ADVENTUROUS, destinationTypical: true, minutes: 60, detourKm: 4, inSeason: true, verification: 'verified' })] });
    expect(strong.weak).toBe(false);
    expect(strong.detail).toContain('defining set');
  });

  it('scores an avoided tag at zero fit rather than a low one', () => {
    const nightlife = scoreExperienceValue({ name: 'Late bar crawl', tags: ['nightlife'], travellerInterests: ADVENTUROUS, avoidances: ['nightlife'], minutes: 180 });
    expect(nightlife.signals.travellerFit).toBe(0);
    expect(nightlife.weakest.some((w) => w.signal === 'travellerFit')).toBe(true);
  });

  it('treats an out-of-season experience as nearly worthless and an unknown season as neutral', () => {
    const offSeason = scoreExperienceValue({ name: 'Highland F-road loop', tags: ['scenic_drives'], travellerInterests: ADVENTUROUS, destinationTypical: true, inSeason: false, minutes: 300 });
    const unknownSeason = scoreExperienceValue({ name: 'Highland F-road loop', tags: ['scenic_drives'], travellerInterests: ADVENTUROUS, destinationTypical: true, minutes: 300 });
    expect(offSeason.signals.seasonality).toBeLessThan(0.2);
    expect(unknownSeason.signals.seasonality).toBe(0.5);
    expect(unknownSeason.score).toBeGreaterThan(offSeason.score);
  });

  it('penalises the fourth waterfall, not the first', () => {
    const first = scoreExperienceValue({ name: 'Skógafoss', tags: ['waterfalls'], travellerInterests: ADVENTUROUS, destinationTypical: true, siblingsWithSameTag: 1 });
    const fourth = scoreExperienceValue({ name: 'Another waterfall', tags: ['waterfalls'], travellerInterests: ADVENTUROUS, destinationTypical: true, siblingsWithSameTag: 4 });
    expect(first.signals.distinctiveness).toBe(1);
    expect(fourth.signals.distinctiveness).toBeLessThan(0.5);
  });

  it('V10 — a vocabulary that does not meet is unknown, not zero', () => {
    /*
     * The defect a live build exposed: the only tag a draft anchor carries is its
     * coarse category (`nature`, `viewpoint`), the traveller's interests are
     * interview keys (`hiking`, `glaciers`), nothing overlaps, and a glacier-led
     * set for a traveller who asked for glaciers was reported as weak.
     */
    const coarse = ['Solheimajokull glacier walk', 'Skaftafell glacier hike', 'Reynisfjara black sand beach'].map((name) =>
      scoreExperienceValue({ name, tags: ['nature'], travellerInterests: ADVENTUROUS, verification: 'partially_verified' }),
    );
    for (const value of coarse) expect(value.signals.travellerFit).toBe(0.5);
    const verdict = definingSetIsWeak({ values: coarse });
    expect(verdict.weak).toBe(false);
    expect(verdict.detail).toContain('Not enough is known');

    /* An avoided tag is still zero: that is the one thing that genuinely means it. */
    expect(scoreExperienceValue({ name: 'A bar crawl', tags: ['nightlife'], travellerInterests: ADVENTUROUS, avoidances: ['nightlife'] }).signals.travellerFit).toBe(0);
    /* And an experience with no tags at all is unknown rather than unwanted. */
    expect(scoreExperienceValue({ name: 'Something unlabelled', tags: [], travellerInterests: ADVENTUROUS }).signals.travellerFit).toBe(0.5);
  });

  it('says the plan does not state what it is built around, rather than scoring nothing', () => {
    expect(definingSetIsWeak({ values: [] })).toEqual({ weak: true, detail: 'The plan does not say what it is built around.' });
  });
});
