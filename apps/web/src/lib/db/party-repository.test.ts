import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * V6 §3/§4 — a described person is stored whole, read back whole by its owner,
 * and reaches the composition without its private notes.
 */
let dir: string;
function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}
beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-party-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});
afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const BASICS = { mode: 'known_destination' as const, destinationInput: 'Hokkaido', regionId: 'dynamic', startDate: '2027-06-13', endDate: '2027-06-20', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [] };

describe('the party repository', () => {
  it('stores a person, puts them on a trip, and hands the brief and the contract only what plans', async () => {
    const { createTrip } = await import('./repository');
    const { createTraveler, listPartyMembers, listPartyMembersForBrief, listPartyMembersForContract, partyFactsFor, setPartyMember, claimTravelers, listTravelers } = await import('./party-repository');
    const trip = createTrip(BASICS, 'owner-a', null);
    const mum = createTraveler(
      { userId: null, ownerToken: 'owner-a' },
      { displayName: 'Mum', relationship: 'parent', ageGroup: 'senior', diet: { needs: ['no_beef', 'nut_allergy'], strict: true, allergyCrossContamination: true }, needs: ['avoid_steep_descents'], needsNotes: 'Cannot do much downhill after knee surgery.', privateNotes: 'Diagnosis: osteoarthritis — never share', profile: { interests: { markets_and_street_food: 'core' }, transportComfort: [], lodgingNeeds: [], sleepRhythm: 'early' }, privacy: { hideFromPrint: false } },
    );
    setPartyMember({ tripId: trip.id, travelerId: mum.id, role: 'parent', preferencesApply: true, constraintsApply: true, participation: 'described', position: 0 });
    expect(listPartyMembers(trip.id)).toHaveLength(1);
    const brief = listPartyMembersForBrief(trip.id, {});
    expect(brief[0]?.displayName).toBe('Mum');
    expect(brief[0]?.dietaryHard).toEqual(['No beef', 'Nut allergy']);
    expect(brief[0]?.needs).toEqual(['avoid steep descents']);
    expect(brief[0]?.notes).toMatch(/knee surgery/);
    expect(JSON.stringify(brief)).not.toMatch(/osteoarthritis|never share/);
    const contract = listPartyMembersForContract(trip.id);
    expect(contract[0]?.needs).toEqual(['Avoid steep descents']);
    expect(JSON.stringify(contract)).not.toMatch(/osteoarthritis|knee surgery/);
    expect(partyFactsFor(trip.id)).toEqual({ members: 1, needs: ['avoid_steep_descents'], drivers: null, dietsRecorded: true, differences: true });
    /* Claiming the browser moves the person to the account. */
    const { upsertUser } = await import('./auth-repository');
    const user = upsertUser({ provider: 'fixture', subject: 'a@example.com', email: 'a@example.com' });
    expect(claimTravelers(user.id, 'owner-a')).toBe(1);
    expect(listTravelers({ userId: user.id, ownerToken: null })).toHaveLength(1);
    expect(listTravelers({ userId: null, ownerToken: 'owner-a' })).toHaveLength(0);
  });
});
