import { describe, expect, it } from 'vitest';
import { discoverFoodNear, discoverStaysNear } from './discovery';

const near = { lat: 64.1472, lng: -21.9397 };

describe('LIVE WORLD V1 — targeted discovery', () => {
  it('with the fixture compiler, fixture properties are returned and never a price or a room', async () => {
    const result = await discoverStaysNear({ near }, { SIDEQUEST_COMPILER_PROVIDER: 'fixture' });
    expect(result.available).toBe(true);
    expect(result.provider).toBe('fixture');
    expect(result.items).toHaveLength(3);
    expect(result.noLivePricing).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/tonight|rooms available|availability/i);
  });
  it('without a provider, the answer is an honest sentence, not a guess', async () => {
    const stays = await discoverStaysNear({ near }, { SIDEQUEST_COMPILER_PROVIDER: 'off' });
    expect(stays.available).toBe(false);
    expect(stays.items).toHaveLength(0);
    expect(stays.reason).toMatch(/No accommodation discovery provider/);
    const food = await discoverFoodNear({ near }, { SIDEQUEST_COMPILER_PROVIDER: 'off', SIDEQUEST_FOOD_PROVIDER: 'off' });
    expect(food.available).toBe(false);
  });
  it('a Google key alone never triggers a lookup here without the explicit compiler choice and never leaks the key', async () => {
    const result = await discoverStaysNear({ near }, { SIDEQUEST_COMPILER_PROVIDER: 'fixture', GOOGLE_MAPS_API_KEY: 'AIzaSECRET' });
    expect(result.provider).toBe('fixture');
    expect(JSON.stringify(result)).not.toContain('AIzaSECRET');
  });
});
