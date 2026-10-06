import { describe, expect, it } from 'vitest';
import { buildTravelReality, crowdPeriodsTouching } from './build';
import { movementFromReality } from './interview';
import { modeStatusFor } from './schema';
import { JURISDICTIONS } from './jurisdictions';

/**
 * V7 §3 — THE REALITY LAYER, HELD TO THE PRODUCTION REGRESSION.
 *
 * Nothing here asserts a place name in the logic under test; the Chongqing
 * case is "a city-region in a country whose row says self-drive is friction",
 * and every other case is another row or no row at all.
 */
const CAPS = { roadRouting: true, transit: false };

describe('buildTravelReality', () => {
  it('a city-region in China: metro, walking and ride-hailing in the city; rail and a driver between regions; never a hire car', () => {
    const reality = buildTravelReality({ label: 'Chongqing', countries: ['CN'], crossBorder: false, entityType: 'municipality', traits: ['dense_urban', 'city_region', 'broad_geography', 'multi_base_likely', 'food_dense'], tripDays: 10, party: { size: 4, drivers: null }, capabilities: CAPS });
    expect(reality.destination.urbanity).toBe('urban_plus_region');
    expect(reality.destination.coverage).toBe('full');
    expect(modeStatusFor(reality, 'self_drive')).toBe('friction');
    expect(modeStatusFor(reality, 'rental_car')).toBe('discouraged');
    expect(modeStatusFor(reality, 'metro', 'urban')).toBe('recommended');
    expect(modeStatusFor(reality, 'high_speed_rail', 'regional')).toBe('recommended');
    expect(reality.recommendation).not.toBeNull();
    expect(reality.recommendation!.urban).toEqual(['walking', 'metro', 'rideshare']);
    expect(reality.recommendation!.regional).toEqual(['high_speed_rail', 'private_driver']);
    expect(reality.recommendation!.sentence).toMatch(/In the city: on foot, metro, ride-hailing/);
    expect(reality.recommendation!.sentence).toMatch(/Not a hire car/);
    expect(reality.recommendation!.sentence).not.toMatch(/recommends rent/i);
    expect(movementFromReality(reality)).toBe('rail_transfers');
    /* A road router being configured is not evidence that driving is the answer. */
    expect(reality.modes.find((m) => m.mode === 'self_drive')!.measurable).toBe(true);
    expect(reality.setup.map((s) => s.id)).toEqual(expect.arrayContaining(['cn-setup-pay', 'cn-setup-12306', 'cn-setup-maps', 'cn-setup-esim', 'cn-setup-didi']));
    expect(reality.setup.every((s) => s.authority === 'reference')).toBe(true);
    expect(reality.facts.find((f) => f.id === 'cn-idp')!.authority).toBe('reference');
    expect(reality.facts.find((f) => f.id === 'cn-idp')!.freshness).toBe('regulatory_volatile');
    expect(reality.crowdPeriods.map((p) => p.name)).toContain('National Day Golden Week');
  });

  it('Kenya and Tanzania: guided transfers and flights, self-drive at most friction because of the border, entry set-up for both', () => {
    const reality = buildTravelReality({ label: 'Kenya and Tanzania', countries: ['KE', 'TZ'], crossBorder: true, traits: ['cross_border', 'multi_area', 'broad_geography', 'guide_transfer_likely', 'wilderness'], tripDays: 14, capabilities: CAPS });
    expect(reality.destination.urbanity).toBe('remote');
    expect(reality.destination.coverage).toBe('full');
    expect(modeStatusFor(reality, 'guided_transfer')).toBe('recommended');
    expect(['friction', 'discouraged']).toContain(modeStatusFor(reality, 'self_drive'));
    expect(reality.recommendation!.regional[0]).toBe('guided_transfer');
    expect(reality.recommendation!.regional).toContain('flight');
    expect(movementFromReality(reality)).toBe('guided');
    expect(reality.facts.some((f) => f.id === 'derived-cross-border-hire')).toBe(true);
    expect(reality.setup.map((s) => s.id)).toEqual(expect.arrayContaining(['ke-setup-eta', 'tz-setup-visa', 'ke-setup-guide', 'tz-setup-operator']));
    expect(reality.bookingLeads.some((b) => b.kind === 'safari_lodge')).toBe(true);
  });

  it('a self-drive country with a road-trip shape recommends a hire car', () => {
    const reality = buildTravelReality({ label: 'Iceland', countries: ['IS'], crossBorder: false, entityType: 'country', traits: ['compact_country', 'road_trip_region', 'weather_exposed'], tripDays: 8, capabilities: CAPS });
    expect(reality.recommendation!.regional[0]).toBe('rental_car');
    expect(movementFromReality(reality)).toBe('car');
    expect(reality.setup.map((s) => s.id)).toContain('is-setup-road');
  });

  it('a city and its region in a rail-recommended country stays on the trains, even with a road-trip trait', () => {
    const reality = buildTravelReality({ label: 'A city', countries: ['CH'], crossBorder: false, entityType: 'municipality', traits: ['city_region', 'road_trip_region'], tripDays: 5, capabilities: CAPS });
    expect(reality.recommendation!.regional[0]).toBe('intercity_train');
    expect(movementFromReality(reality)).not.toBe('car');
  });

  it('the same country at regional scale with a road-trip shape still earns the hire car', () => {
    const reality = buildTravelReality({ label: 'Mountain valleys', countries: ['CH'], crossBorder: false, entityType: 'subregion', traits: ['mountain', 'road_trip_region'], tripDays: 7, capabilities: CAPS });
    expect(reality.recommendation!.regional[0]).toBe('rental_car');
  });

  it('nobody drives: the hire car leaves the recommendation and the driving set-up is not offered', () => {
    const reality = buildTravelReality({ label: 'Ireland', countries: ['IE'], crossBorder: false, traits: ['compact_country', 'road_trip_region'], tripDays: 8, party: { size: 2, drivers: 0 }, capabilities: CAPS });
    expect(reality.recommendation!.regional).not.toContain('rental_car');
    expect(reality.recommendation!.regional).not.toContain('self_drive');
    expect(reality.setup.map((s) => s.id)).not.toContain('ie-setup-car');
  });

  it('a country nobody compiled: modes unknown, no recommendation, the gap named', () => {
    const reality = buildTravelReality({ label: 'Patagonia', countries: [], crossBorder: false, traits: ['mountain', 'road_trip_region'], tripDays: 10, capabilities: CAPS });
    expect(reality.destination.coverage).toBe('none');
    expect(reality.recommendation).toBeNull();
    expect(reality.unknowns[0]).toMatch(/not been compiled/);
    expect(modeStatusFor(reality, 'self_drive')).toBe('unknown');
  });

  it('a dense city in a rail country asks for nothing regional and keeps the transit set-up', () => {
    const reality = buildTravelReality({ label: 'Tokyo', countries: ['JP'], crossBorder: false, entityType: 'city', traits: ['dense_urban', 'transit_rich', 'walk_heavy', 'food_dense'], tripDays: 5, capabilities: CAPS });
    expect(reality.destination.urbanity).toBe('dense_urban');
    expect(reality.recommendation!.regional).toEqual([]);
    expect(reality.recommendation!.urban).toEqual(['walking', 'metro']);
    expect(reality.setup.map((s) => s.id)).toContain('jp-setup-ic');
    expect(reality.setup.map((s) => s.id)).not.toContain('jp-setup-idp');
  });

  it('crowd periods touching a window are found, across the year end too', () => {
    const cn = buildTravelReality({ label: 'Chongqing', countries: ['CN'], crossBorder: false, traits: ['dense_urban'], tripDays: 7 });
    expect(crowdPeriodsTouching(cn, '2027-09-28', '2027-10-05').map((p) => p.name)).toEqual(['National Day Golden Week']);
    expect(crowdPeriodsTouching(cn, '2027-10-20', '2027-10-30')).toEqual([]);
    const jp = buildTravelReality({ label: 'Japan', countries: ['JP'], crossBorder: false, traits: [], tripDays: 7 });
    expect(crowdPeriodsTouching(jp, '2026-12-28', '2027-01-04').map((p) => p.name)).toEqual(['New Year']);
  });

  it('every jurisdiction row is internally consistent: facts referenced by rules exist, ids are unique', () => {
    const ids = new Set<string>();
    for (const row of JURISDICTIONS) {
      const own = new Set(row.facts.map((f) => f.id));
      for (const fact of row.facts) {
        expect(ids.has(fact.id), `duplicate fact id ${fact.id}`).toBe(false);
        ids.add(fact.id);
        expect(fact.authority).toBe('reference');
      }
      for (const rule of row.modes) for (const id of rule.facts ?? []) expect(own.has(id), `${row.code} rule ${rule.mode} references ${id}`).toBe(true);
      for (const item of row.setup) for (const id of item.facts ?? []) expect(own.has(id), `${row.code} setup ${item.id} references ${id}`).toBe(true);
    }
  });
});
