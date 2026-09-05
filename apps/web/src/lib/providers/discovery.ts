import 'server-only';
import { capability } from './registry';
import { discoverNearby, type DiscoveredProperty } from './google-places';
import { ProviderFailure } from '@sidequest/core';

/**
 * TARGETED DISCOVERY — ON REQUEST, NEVER ON RENDER, NEVER PERSISTED.
 *
 * "Find stays near this base" and "Find somewhere for this meal" are server
 * actions a traveller presses. Each is one bounded lookup (≤3 properties per
 * base, ≤5 venues per meal) answered for display only: the repository's
 * terms review forbids storing Google business names, so nothing here is
 * saved, cached or fed to the plan. Live room prices and availability are
 * never shown because no inventory provider supplies them, and the result
 * says so in words. With the fixture compiler, fixture results stand in.
 */
export interface DiscoveryResult {
  available: boolean;
  provider: string | null;
  reason?: string;
  attribution?: string;
  items: DiscoveredProperty[];
  /** Always true; nothing here quotes a price or a room. */
  noLivePricing: true;
}

const FIXTURE_STAYS: Omit<DiscoveredProperty, 'coordinates' | 'distanceKm'>[] = [
  { providerRef: 'fixture:stay:1', name: 'Harbourside Guesthouse', types: ['lodging'], priceLevel: 'moderate', rating: 4.6, ratingCount: 212, attribution: 'Fixture data' },
  { providerRef: 'fixture:stay:2', name: 'Old Mill Inn', types: ['lodging'], priceLevel: 'inexpensive', rating: 4.3, ratingCount: 88, attribution: 'Fixture data' },
  { providerRef: 'fixture:stay:3', name: 'The Ridge Hotel', types: ['lodging'], priceLevel: 'expensive', rating: 4.8, ratingCount: 501, attribution: 'Fixture data' },
];
const FIXTURE_FOOD: Omit<DiscoveredProperty, 'coordinates' | 'distanceKm'>[] = [
  { providerRef: 'fixture:food:1', name: 'Fjord Kitchen', types: ['restaurant'], priceLevel: 'moderate', rating: 4.5, ratingCount: 340, attribution: 'Fixture data' },
  { providerRef: 'fixture:food:2', name: 'Bakery on the Square', types: ['bakery', 'cafe'], priceLevel: 'inexpensive', rating: 4.4, ratingCount: 120, attribution: 'Fixture data' },
];

function fixtureNear(base: Omit<DiscoveredProperty, 'coordinates' | 'distanceKm'>[], near: { lat: number; lng: number }): DiscoveredProperty[] {
  return base.map((p, i) => ({ ...p, coordinates: { lat: near.lat + 0.004 * (i + 1), lng: near.lng - 0.003 * (i + 1) }, distanceKm: Math.round((0.5 + i * 0.4) * 10) / 10 }));
}

export async function discoverStaysNear(input: { near: { lat: number; lng: number }; radiusKm?: number; query?: string }, env: Record<string, string | undefined> = process.env): Promise<DiscoveryResult> {
  const cap = capability('lodging.discovery', env);
  const fixture = capability('places.identity', env)?.fixture ?? false;
  if (fixture) return { available: true, provider: 'fixture', attribution: 'Fixture data', items: fixtureNear(FIXTURE_STAYS, input.near), noLivePricing: true };
  if (!cap?.configured || cap.provider !== 'google-places') return { available: false, provider: null, reason: 'No accommodation discovery provider is configured. Sidequest recommends areas; look for properties in your booking site of choice.', items: [], noLivePricing: true };
  try {
    const items = await discoverNearby({ kind: 'lodging', near: input.near, radiusKm: input.radiusKm ?? 5, ...(input.query ? { query: input.query } : {}), maxResults: 3 });
    return { available: true, provider: 'google-places', attribution: items[0]?.attribution ?? 'Place data © Google', items, noLivePricing: true };
  } catch (error) {
    const reason = error instanceof ProviderFailure ? error.reason : 'provider_error';
    return { available: false, provider: 'google-places', reason: `The lookup did not complete (${reason.replace(/_/g, ' ')}). Nothing was guessed instead.`, items: [], noLivePricing: true };
  }
}

export async function discoverFoodNear(input: { near: { lat: number; lng: number }; radiusKm?: number; query?: string }, env: Record<string, string | undefined> = process.env): Promise<DiscoveryResult> {
  const cap = capability('food.discovery', env);
  if (cap?.fixture) return { available: true, provider: 'fixture', attribution: 'Fixture data', items: fixtureNear(FIXTURE_FOOD, input.near), noLivePricing: true };
  if (!cap?.configured || cap.provider !== 'google-places') return { available: false, provider: cap?.provider ?? null, reason: 'No targeted food lookup is configured beyond the region’s own food data.', items: [], noLivePricing: true };
  try {
    const items = await discoverNearby({ kind: 'food', near: input.near, radiusKm: input.radiusKm ?? 2, ...(input.query ? { query: input.query } : {}), maxResults: 5 });
    return { available: true, provider: 'google-places', attribution: items[0]?.attribution ?? 'Place data © Google', items, noLivePricing: true };
  } catch (error) {
    const reason = error instanceof ProviderFailure ? error.reason : 'provider_error';
    return { available: false, provider: 'google-places', reason: `The lookup did not complete (${reason.replace(/_/g, ' ')}). The meal keeps its role.`, items: [], noLivePricing: true };
  }
}
