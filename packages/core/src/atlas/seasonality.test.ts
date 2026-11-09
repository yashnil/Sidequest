import { describe, expect, it } from 'vitest';
import { climateAt, daylightHours, modelledSnow, seasonModel, travellerSeason, trekAltitude, type ClimatePoint, type SeasonInputs } from './seasonality';

/**
 * The climates below are 1981–2010 normals read out of the atlas for real
 * places (rounded), so the assertions are about the world: the model must say
 * what a traveller who has been there would say.
 */
const point = (elevM: number, tmax: number[], tmin: number[], pr: number[]): ClimatePoint => ({ elevM, tmax, tmin, pr });

/* An alpine valley at 1,000 m under 4,200 m summits (the shape of Chamonix). */
const ALPINE: SeasonInputs = {
  lat: 45.9,
  base: point(1050, [1, 3, 8, 12, 17, 21, 24, 23, 19, 13, 6, 2], [-7, -6, -2, 1, 6, 9, 11, 11, 7, 3, -2, -6], [110, 95, 100, 105, 130, 125, 110, 115, 105, 115, 120, 120]),
  high: point(4170, [-17, -17, -14, -11, -6, -2, 1, 1, -2, -6, -12, -16], [-23, -23, -20, -17, -12, -8, -5, -5, -8, -12, -18, -22], [190, 165, 170, 180, 220, 215, 190, 195, 180, 200, 205, 205]),
  sst: null,
  coastKm: null,
};

/* A tropical island coast (Ko Samui): warm sea all year, a wet season in October–December. */
const GULF_ISLAND: SeasonInputs = {
  lat: 9.5,
  base: point(10, [30, 31, 32, 33, 33, 33, 32, 32, 32, 31, 30, 29], [24, 25, 25, 26, 26, 26, 25, 25, 25, 25, 24, 24], [140, 55, 80, 85, 150, 115, 120, 110, 120, 300, 490, 210]),
  high: null,
  sst: [27.5, 27.8, 28.6, 29.6, 30, 29.6, 29.2, 29.1, 29.2, 29.1, 28.4, 27.7],
  coastKm: 1,
};

/* The opposite coast (Andaman side): the south-west monsoon soaks May–October. */
const ANDAMAN: SeasonInputs = { ...GULF_ISLAND, lat: 7.9, base: point(10, [32, 33, 33, 33, 32, 31, 31, 31, 30, 31, 31, 31], [24, 24, 25, 25, 25, 25, 25, 25, 24, 24, 24, 24], [35, 30, 70, 150, 300, 290, 300, 310, 390, 320, 180, 70]) };

/* A northern Mediterranean coast (Dubrovnik): the sea is cold until June. */
const ADRIATIC: SeasonInputs = {
  lat: 42.6,
  base: point(20, [12, 13, 15, 18, 23, 27, 30, 30, 26, 21, 16, 13], [6, 6, 8, 11, 15, 19, 22, 22, 18, 14, 10, 7], [100, 90, 95, 90, 70, 50, 30, 60, 100, 150, 160, 140]),
  high: null,
  sst: [14.3, 13.8, 14.2, 15.8, 19, 23, 25.5, 25.8, 23.6, 20.6, 17.6, 15.5],
  coastKm: 1,
};

/* A savanna park in southern Africa: rains November–March, bone dry May–September. */
const SAVANNA: SeasonInputs = {
  lat: -24,
  base: point(300, [33, 32, 31, 29, 28, 26, 26, 28, 30, 31, 32, 33], [21, 21, 19, 16, 11, 7, 7, 10, 14, 17, 19, 20], [95, 95, 65, 30, 12, 6, 6, 8, 20, 40, 65, 90]),
  high: null,
  sst: null,
  coastKm: null,
};

const good = (model: ReturnType<typeof seasonModel>, activity: keyof ReturnType<typeof seasonModel>['fit']) => model.fit[activity].map((month, index) => (month.value >= 0.6 ? index + 1 : 0)).filter(Boolean);

describe('activity-specific seasonality', () => {
  it('separates ski season from hiking season in the same mountains', () => {
    const model = seasonModel(ALPINE, 6.9);
    const ski = good(model, 'ski');
    const highTrails = good(model, 'hike_high');
    expect(ski).toContain(2);
    expect(ski).not.toContain(7);
    expect(highTrails).toContain(8);
    expect(highTrails).not.toContain(2);
    /* No month is both the heart of the ski season and good for the high trails. */
    expect(ski.filter((month) => highTrails.includes(month))).toEqual([]);
  });

  it('opens valley walks before the high trails melt out', () => {
    const model = seasonModel(ALPINE, 6.9);
    expect(model.fit.hike_low[4]!.value).toBeGreaterThan(0.6);
    expect(model.fit.hike_high[4]!.value).toBeLessThan(0.3);
    expect(model.fit.hike_high[4]!.limit).toBe('snow_on_trails');
    expect(good(model, 'hike_low').length).toBeGreaterThan(good(model, 'hike_high').length);
  });

  it('reads the two coasts of one country differently in the same month', () => {
    const gulf = seasonModel(GULF_ISLAND, 100);
    const andaman = seasonModel(ANDAMAN, 98.4);
    /* August: the Gulf side is fine, the Andaman side is in the monsoon. */
    expect(gulf.fit.beach[7]!.value).toBeGreaterThan(andaman.fit.beach[7]!.value + 0.2);
    expect(andaman.fit.beach[7]!.limit).toBe('rains');
    /* January: the other way round is not true — both are good, the Andaman side best. */
    expect(andaman.fit.beach[0]!.value).toBeGreaterThan(0.85);
    /* November: the Gulf side has its own rains. */
    expect(gulf.fit.beach[10]!.value).toBeLessThan(gulf.fit.beach[1]!.value);
  });

  it('judges swimming on the sea, not the air', () => {
    const model = seasonModel(ADRIATIC, 18.1);
    /* May: 23 °C in the air, 19 °C in the water — a walk on the coast, a brisk swim. */
    expect(model.fit.beach[4]!.value).toBeLessThan(0.5);
    expect(model.fit.beach[4]!.limit).toBe('sea_too_cold');
    expect(model.fit.scenery[4]!.value).toBeGreaterThan(0.8);
    expect(model.fit.beach[7]!.value).toBeGreaterThan(0.85);
    /* A brisk sea alone does not close a month: June at 23 °C is already a swim, April at 16 °C is not. */
    expect(model.fit.beach[5]!.value).toBeGreaterThan(0.6);
    expect(model.fit.beach[3]!.value).toBeLessThan(0.1);
  });

  it('has no beach month inland', () => {
    const model = seasonModel(ALPINE, 6.9);
    expect(Math.max(...model.fit.beach.map((month) => month.value))).toBe(0);
    expect(model.fit.beach[6]!.limit).toBe('no_sea');
  });

  it('puts game viewing in the dry season', () => {
    const model = seasonModel(SAVANNA, 31.5);
    expect(model.fit.safari[6]!.value).toBeGreaterThan(model.fit.safari[0]!.value);
    expect(good(model, 'safari')).toEqual(expect.arrayContaining([5, 6, 7, 8, 9]));
    expect(model.fit.safari[0]!.limit).toBe('rains');
  });

  it('keeps towns visitable all year while marking the extremes', () => {
    const model = seasonModel(ADRIATIC, 18.1);
    expect(Math.min(...model.fit.city.map((month) => month.value))).toBeGreaterThan(0.5);
  });

  it('weights a traveller’s season by what they want and the place offers', () => {
    const model = seasonModel(ALPINE, 6.9);
    const hiker = travellerSeason(model, { day_hiking: 0.5, high_mountains: 0.5 }, { day_hiking: 3, high_mountains: 3, winter_snow: 3 });
    const skier = travellerSeason(model, { winter_snow: 1 }, { day_hiking: 3, high_mountains: 3, winter_snow: 3 });
    expect(hiker.months[1]!.value).toBeLessThan(0.3);
    expect(skier.months[1]!.value).toBeGreaterThan(0.8);
    expect(hiker.months[7]!.value).toBeGreaterThan(0.8);
    expect(skier.months[7]!.value).toBeLessThan(0.2);
    /* Something wanted that the place does not offer cannot set its season. */
    const beachOnly = travellerSeason(model, { beaches_swimming: 1 }, { day_hiking: 3 });
    expect(beachOnly.drivers[0]).not.toBe('beach');
  });

  it('models a snowpack that builds in winter and melts in summer', () => {
    const high = modelledSnow(climateAt(ALPINE, 2600));
    expect(high[2]!).toBeGreaterThan(150);
    expect(high[7]!).toBeLessThan(25);
    const valley = modelledSnow(ALPINE.base);
    expect(valley[6]!).toBe(0);
    /* A tropical coast never holds snow. */
    expect(Math.max(...modelledSnow(GULF_ISLAND.base))).toBe(0);
  });

  it('runs the high trails below the summits', () => {
    const altitude = trekAltitude(ALPINE);
    expect(altitude).toBeGreaterThan(ALPINE.base.elevM + 800);
    expect(altitude).toBeLessThan(3200);
    /* Under an 8,000 m peak the "trail" is not put on the glacier. */
    const giant = trekAltitude({ base: point(2400, [], [], []), high: point(7400, [], [], []) });
    expect(giant).toBeLessThanOrEqual(4700);
  });

  it('knows the length of the day', () => {
    expect(daylightHours(69, 12)).toBe(0);
    expect(daylightHours(69, 6)).toBe(24);
    expect(daylightHours(0, 3)).toBeGreaterThan(11.5);
    expect(daylightHours(0, 3)).toBeLessThan(12.6);
    const polarNight = seasonModel({ lat: 69, base: point(10, [-3, -3, -1, 3, 7, 12, 16, 14, 10, 4, 0, -2], [-8, -8, -6, -2, 2, 7, 10, 9, 5, 0, -4, -7], [90, 80, 70, 60, 50, 55, 70, 80, 95, 120, 100, 95]), high: null, sst: null, coastKm: null });
    expect(polarNight.fit.hike_low[11]!.value).toBeLessThan(0.2);
    expect(polarNight.fit.sky[11]!.value).toBeGreaterThan(polarNight.fit.sky[5]!.value);
  });
});

describe('sky and sea conditions when they are measured', () => {
  const point = { elevM: 10, tmax: new Array(12).fill(28), tmin: new Array(12).fill(20), pr: new Array(12).fill(40) };
  const coast = { lat: 10, base: point, high: null, sst: new Array(12).fill(27), coastKm: 2 };

  it('takes a cloudy month away from the stars and leaves a clear one', () => {
    const cloud = [10, 10, 10, 10, 10, 10, 85, 85, 85, 10, 10, 10];
    const { fit } = seasonModel({ ...coast, cloud });
    expect(fit.sky[0]!.value).toBeGreaterThan(0.9);
    expect(fit.sky[7]!.value).toBeLessThan(0.3);
    expect(fit.sky[7]!.limit).toBe('cloud');
  });

  it('marks a heavy swell against the beach and the dive boat, and treats sea ice as unknown', () => {
    const waves = [0.5, 0.5, 0.5, 3.5, Number.NaN, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const { fit } = seasonModel({ ...coast, waves });
    expect(fit.beach[0]!.value).toBeGreaterThan(fit.beach[3]!.value);
    expect(fit.beach[3]!.limit).toBe('rough_sea');
    expect(fit.dive[3]!.limit).toBe('rough_sea');
    expect(fit.beach[4]!.value).toBeCloseTo(fit.beach[0]!.value, 5);
  });
});
