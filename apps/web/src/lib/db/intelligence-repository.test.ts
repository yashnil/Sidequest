import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { travelIntelligenceSchema, type TravelIntelligence } from '@sidequest/core';
import { getDb } from './client';
import { createTrip } from './repository';
import {
  addBookedItem,
  clearReadinessProfile,
  getReadinessProfile,
  getTravelIntelligence,
  listBookedItems,
  listChecks,
  removeBookedItem,
  saveReadinessProfile,
  saveTravelIntelligence,
  setCheck,
} from './intelligence-repository';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-intel-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'intel.db');
  const globalForDb = globalThis as unknown as { sidequestDb?: { close(): void } };
  globalForDb.sidequestDb?.close();
  delete globalForDb.sidequestDb;
});

afterEach(() => {
  const globalForDb = globalThis as unknown as { sidequestDb?: { close(): void } };
  globalForDb.sidequestDb?.close();
  delete globalForDb.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function trip() {
  return createTrip({ mode: 'known_destination', destinationInput: 'Somewhere', regionId: 'dynamic', startDate: '2026-06-01', endDate: '2026-06-05', arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] });
}

describe('intelligence persistence', () => {
  it('booked items, the readiness profile and ticks survive a reload of the database', () => {
    const t = trip();
    getDb();
    const item = addBookedItem(t.id, { type: 'lodging', title: 'Hotel B', date: '2026-06-01', endDate: '2026-06-05', location: 'Riverside', confirmationRef: 'ABC123', status: 'booked', locked: true });
    saveReadinessProfile(t.id, { citizenship: 'US', passportExpiry: '2028-01', transitCountries: [] });
    setCheck(t.id, 'packing', 'footwear:boots', true);
    setCheck(t.id, 'checklist', 'readiness:visa', true);

    // A fresh connection to the same file.
    const globalForDb = globalThis as unknown as { sidequestDb?: { close(): void } };
    globalForDb.sidequestDb?.close();
    delete globalForDb.sidequestDb;

    expect(listBookedItems(t.id).map((b) => [b.id, b.title, b.confirmationRef])).toEqual([[item.id, 'Hotel B', 'ABC123']]);
    expect(getReadinessProfile(t.id)?.citizenship).toBe('US');
    expect(listChecks(t.id)).toEqual({ packing: ['footwear:boots'], checklist: ['readiness:visa'], preflight: [] });

    setCheck(t.id, 'packing', 'footwear:boots', false);
    removeBookedItem(t.id, item.id);
    clearReadinessProfile(t.id);
    expect(listChecks(t.id).packing).toEqual([]);
    expect(listBookedItems(t.id)).toEqual([]);
    expect(getReadinessProfile(t.id)).toBeNull();
  });

  it('rejects a booked item that does not fit the schema, and never stores a passport number', () => {
    const t = trip();
    expect(() => addBookedItem(t.id, { type: 'flight', title: '', status: 'booked', locked: true })).toThrow();
    expect(() => saveReadinessProfile(t.id, { citizenship: 'usa', transitCountries: [] } as never)).toThrow();
    // The readiness schema has no field for a passport number; an attempt to smuggle one is dropped.
    const saved = saveReadinessProfile(t.id, { citizenship: 'US', passportNumber: '123456789', transitCountries: [] } as never);
    expect('passportNumber' in saved).toBe(false);
  });

  it('the intelligence snapshot round-trips and is keyed by its fingerprint', () => {
    const t = trip();
    const minimal = {
      version: 1,
      tripId: t.id,
      builtAt: '2026-04-01T00:00:00.000Z',
      itineraryFingerprint: 'abc',
      destinationContext: { name: 'Somewhere', international: 'unknown', tripDays: 5, daysUntilTrip: 61, remote: false, drives: false },
      verification: { anchors: 0, verified: 0, partiallyVerified: 0, unverified: 0, legsMeasured: 0, legsUnmeasured: 0, deadlineReached: false },
      transport: { primaryMode: 'walk', legs: [], terminal: { arrival: { terminalMinute: null, basis: 'unknown', bufferMinutes: 0, bufferLabel: 'n', transferMinutes: null, transferLabel: 'n', vehicleMinutes: 0, boundaryMinute: null, note: 'n' }, departure: { terminalMinute: null, basis: 'unknown', bufferMinutes: 0, bufferLabel: 'n', transferMinutes: null, transferLabel: 'n', vehicleMinutes: 0, boundaryMinute: null, note: 'n' }, arrivalRespected: true, departureRespected: true, violations: [] }, options: [], modeNote: 'n' },
      lodging: { bases: [], shortlist: [], shortlistBasis: 'n', hotelChangeNote: 'n' },
      food: { headline: 'n', days: [], remoteDayNumbers: [], reservations: [], venueDataNote: 'n' },
      bookings: { items: [], booked: [], honored: [], conflicts: [] },
      budget: { currency: 'USD', currencyBasis: 'assumed_reference', conversionNote: 'n', travellers: 2, lines: [], total: { low: 0, high: 0, perPerson: false }, strategy: { saveHere: [], spendHere: [] }, booked: [], precisionNote: 'n' },
      weather: { days: [], packingBasis: 'unknown', providerNote: 'n' },
      access: [],
      readiness: { international: 'unknown', profileProvided: false, coverageNote: 'n', entries: [], blockingCount: 0 },
      safety: { official: [], practical: [], unknown: [] },
      packing: { items: [], basis: 'unknown', basisNote: 'n', modelSuggestions: [] },
      backups: [],
      regret: { dontMiss: [], safeToSkip: [], bookEarly: [], keepFlexible: [], verifyBeforeLeaving: [] },
      checklist: { phases: [], daysUntilTrip: 61 },
      sourceRegistry: [],
      unresolvedCriticals: [],
      freshness: { recheckBeforeDeparture: [], note: 'n' },
    } satisfies Record<string, unknown>;
    const intel: TravelIntelligence = travelIntelligenceSchema.parse(minimal);
    saveTravelIntelligence(intel);
    expect(getTravelIntelligence(t.id)?.itineraryFingerprint).toBe('abc');
    saveTravelIntelligence({ ...intel, itineraryFingerprint: 'def' });
    expect(getTravelIntelligence(t.id)?.itineraryFingerprint).toBe('def');
  });
});
