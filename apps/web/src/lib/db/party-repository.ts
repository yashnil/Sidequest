import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  DIETARY_NEED_LABELS,
  FUNCTIONAL_NEED_LABELS,
  dietaryRulesOf,
  mergePartyDiet,
  travelerSchema,
  tripPartyMemberSchema,
  AGE_GROUP_LABELS,
  INTEREST_LABELS,
  PARTY_ROLE_LABELS,
  type ContractPartyMember,
  type Traveler,
  type TravelerBriefPartyMember,
  type TravelerProfile,
  type TripPartyMember,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * TRAVELLERS AND TRIP PARTIES.
 *
 * V6 §3. A traveller row belongs to an account (`user_id`) or, before
 * sign-in, to the browser that made it (`owner_token`); claiming a browser's
 * trips claims its travellers too. A party row says a traveller is on a trip.
 *
 * The payload is the whole `Traveler` as JSON, re-validated on read: a row
 * that fails the schema is dropped from the result rather than crashing a
 * page, and logged once.
 */

interface TravelerRow {
  id: string;
  user_id: string | null;
  owner_token: string | null;
  display_name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  trip_id: string;
  traveler_id: string;
  role: string;
  preferences_apply: number;
  constraints_apply: number;
  participation: string;
  position: number;
}

function rowToTraveler(row: TravelerRow): Traveler | null {
  try {
    return travelerSchema.parse({ ...JSON.parse(row.payload_json), id: row.id, displayName: row.display_name, createdAt: row.created_at, updatedAt: row.updated_at });
  } catch (error) {
    console.error('A stored traveller could not be read and was skipped', { id: row.id, message: error instanceof Error ? error.message : 'unknown' });
    return null;
  }
}

export interface TravelerOwner {
  userId: string | null;
  ownerToken: string | null;
}

export function createTraveler(owner: TravelerOwner, input: Omit<Traveler, 'id' | 'version' | 'createdAt' | 'updatedAt'>, now: Date = new Date()): Traveler {
  const at = now.toISOString();
  const traveler = travelerSchema.parse({ ...input, id: randomUUID(), version: 1, createdAt: at, updatedAt: at });
  getDb()
    .prepare('INSERT INTO travelers (id, user_id, owner_token, display_name, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(traveler.id, owner.userId, owner.userId ? null : owner.ownerToken, traveler.displayName, JSON.stringify(traveler), at, at);
  return traveler;
}

export function updateTraveler(id: string, patch: Partial<Omit<Traveler, 'id' | 'version' | 'createdAt' | 'updatedAt'>>, now: Date = new Date()): Traveler | null {
  const existing = getTraveler(id);
  if (!existing) return null;
  const at = now.toISOString();
  const next = travelerSchema.parse({ ...existing, ...patch, id, version: 1, updatedAt: at });
  getDb().prepare('UPDATE travelers SET display_name = ?, payload_json = ?, updated_at = ? WHERE id = ?').run(next.displayName, JSON.stringify(next), at, id);
  return next;
}

export function getTraveler(id: string): Traveler | null {
  const row = getDb().prepare('SELECT * FROM travelers WHERE id = ?').get(id) as TravelerRow | undefined;
  return row ? rowToTraveler(row) : null;
}

/** Who owns a traveller — the authorisation boundary for editing one. */
export function travelerOwner(id: string): TravelerOwner | null {
  const row = getDb().prepare('SELECT user_id, owner_token FROM travelers WHERE id = ?').get(id) as { user_id: string | null; owner_token: string | null } | undefined;
  return row ? { userId: row.user_id, ownerToken: row.owner_token } : null;
}

export function deleteTraveler(id: string): void {
  getDb().prepare('DELETE FROM travelers WHERE id = ?').run(id);
}

/** Every traveller the account (or, unclaimed, the browser) has described. */
export function listTravelers(owner: TravelerOwner): Traveler[] {
  const rows = owner.userId
    ? (getDb().prepare('SELECT * FROM travelers WHERE user_id = ? ORDER BY created_at ASC').all(owner.userId) as TravelerRow[])
    : owner.ownerToken
      ? (getDb().prepare('SELECT * FROM travelers WHERE owner_token = ? AND user_id IS NULL ORDER BY created_at ASC').all(owner.ownerToken) as TravelerRow[])
      : [];
  return rows.map(rowToTraveler).filter((t): t is Traveler => t !== null);
}

/** Move every unclaimed traveller a browser made onto an account. Idempotent; returns how many moved. */
export function claimTravelers(userId: string, ownerToken: string): number {
  return getDb().prepare('UPDATE travelers SET user_id = ?, owner_token = NULL WHERE owner_token = ? AND user_id IS NULL').run(userId, ownerToken).changes;
}

export function setPartyMember(member: TripPartyMember): void {
  const parsed = tripPartyMemberSchema.parse(member);
  getDb()
    .prepare(
      `INSERT INTO trip_party_members (trip_id, traveler_id, role, preferences_apply, constraints_apply, participation, position)
       VALUES (@trip_id, @traveler_id, @role, @preferences_apply, @constraints_apply, @participation, @position)
       ON CONFLICT(trip_id, traveler_id) DO UPDATE SET role = excluded.role, preferences_apply = excluded.preferences_apply,
         constraints_apply = excluded.constraints_apply, participation = excluded.participation, position = excluded.position`,
    )
    .run({
      trip_id: parsed.tripId,
      traveler_id: parsed.travelerId,
      role: parsed.role,
      preferences_apply: parsed.preferencesApply ? 1 : 0,
      constraints_apply: parsed.constraintsApply ? 1 : 0,
      participation: parsed.participation,
      position: parsed.position,
    });
}

export function removePartyMember(tripId: string, travelerId: string): void {
  getDb().prepare('DELETE FROM trip_party_members WHERE trip_id = ? AND traveler_id = ?').run(tripId, travelerId);
}

export function listPartyMembers(tripId: string): (TripPartyMember & { traveler: Traveler })[] {
  const rows = getDb()
    .prepare('SELECT m.*, t.id AS t_id, t.user_id, t.owner_token, t.display_name, t.payload_json, t.created_at, t.updated_at FROM trip_party_members m JOIN travelers t ON t.id = m.traveler_id WHERE m.trip_id = ? ORDER BY m.position ASC, t.created_at ASC')
    .all(tripId) as (MemberRow & TravelerRow & { t_id: string })[];
  const members: (TripPartyMember & { traveler: Traveler })[] = [];
  for (const row of rows) {
    const traveler = rowToTraveler({ id: row.t_id, user_id: row.user_id, owner_token: row.owner_token, display_name: row.display_name, payload_json: row.payload_json, created_at: row.created_at, updated_at: row.updated_at });
    if (!traveler) continue;
    members.push({
      tripId: row.trip_id,
      travelerId: row.traveler_id,
      role: row.role as TripPartyMember['role'],
      preferencesApply: row.preferences_apply === 1,
      constraintsApply: row.constraints_apply === 1,
      participation: (row.participation === 'invited' ? 'invited' : 'described') as TripPartyMember['participation'],
      position: row.position,
      traveler,
    });
  }
  return members;
}

/**
 * The party as the contract reads it: names, hard dietary rules and functional
 * needs per person, and whether each person's preferences and constraints
 * bind. Private notes never leave this function.
 */
export function listPartyMembersForContract(tripId: string): ContractPartyMember[] {
  return listPartyMembers(tripId).map((member) => ({
    id: member.travelerId,
    displayName: member.traveler.displayName,
    ...(member.traveler.ageGroup ? { ageGroup: member.traveler.ageGroup } : {}),
    dietary: dietaryRulesOf(member.traveler.diet, DIETARY_NEED_LABELS)
      .filter((rule) => rule.strict)
      .map((rule) => rule.label),
    needs: member.traveler.needs.map((need) => FUNCTIONAL_NEED_LABELS[need]),
    preferencesApply: member.preferencesApply,
    constraintsApply: member.constraintsApply,
  }));
}

/**
 * The party as the composition brief reads it. Planning-relevant fields only;
 * `privateNotes` never leaves the row. `needsNotes` are the traveller's own
 * words about what to plan around and are the one free-text field that does
 * reach the composition, because a plan cannot honour what it was not told.
 */
export function listPartyMembersForBrief(tripId: string, groupInterests: Record<string, string> = {}): TravelerBriefPartyMember[] {
  return listPartyMembers(tripId).map((member) => {
    const t = member.traveler;
    const rules = dietaryRulesOf(t.diet, DIETARY_NEED_LABELS);
    const differences: string[] = [];
    for (const [interest, level] of Object.entries(t.profile.interests)) {
      const group = groupInterests[interest];
      if (group && group === level) continue;
      const label = (INTEREST_LABELS as Record<string, string>)[interest] ?? interest;
      if (level === 'core') differences.push(`${label} is the heart of the trip for them`);
      else if (level === 'frequent') differences.push(`wants ${label.toLowerCase()} often`);
      else if (level === 'avoid') differences.push(`would rather avoid ${label.toLowerCase()}`);
    }
    if (t.profile.sleepRhythm === 'early') differences.push('early riser');
    if (t.profile.sleepRhythm === 'late') differences.push('late riser');
    for (const comfort of t.profile.transportComfort) if (comfort === 'drives') differences.push('can share the driving');
    return {
      displayName: t.displayName,
      ...(t.ageGroup ? { ageGroup: AGE_GROUP_LABELS[t.ageGroup].toLowerCase() } : {}),
      ...(t.relationship ? { relationship: PARTY_ROLE_LABELS[t.relationship].toLowerCase() } : {}),
      dietaryHard: rules.filter((r) => r.strict).map((r) => r.label),
      dietarySoft: rules.filter((r) => !r.strict).map((r) => r.label),
      needs: t.needs.map((need) => FUNCTIONAL_NEED_LABELS[need].toLowerCase()),
      differences,
      ...(t.profile.physicalCapability ? { physicalCapability: t.profile.physicalCapability } : {}),
      ...(t.needsNotes?.trim() ? { notes: t.needsNotes.trim() } : {}),
      preferencesApply: member.preferencesApply,
      constraintsApply: member.constraintsApply,
    };
  });
}

/** V6 §6 — the party as the question selector reads it. Undefined when nobody was described. */
export function partyFactsFor(tripId: string): { members: number; needs: string[]; drivers: number | null; dietsRecorded: boolean } | undefined {
  const members = listPartyMembers(tripId);
  if (members.length === 0) return undefined;
  const binding = members.filter((m) => m.constraintsApply);
  const needs = [...new Set(binding.flatMap((m) => m.traveler.needs))];
  const anyDrivingSaid = members.some((m) => m.traveler.profile.transportComfort.includes('drives') || m.traveler.needs.includes('cannot_drive'));
  const drivers = anyDrivingSaid ? members.filter((m) => m.traveler.profile.transportComfort.includes('drives') && !m.traveler.needs.includes('cannot_drive')).length : null;
  const dietsRecorded = members.every((m) => m.traveler.diet.needs.length > 0 || Boolean(m.traveler.diet.notes));
  return { members: members.length, needs, drivers, dietsRecorded };
}

/**
 * V6 — the profile Sidequest's own checks read: the stored profile with the
 * party's kitchen rule merged in (`mergePartyDiet`). Never for the brief.
 */
export function profileWithPartyDiet<P extends Pick<TravelerProfile, 'food'>>(profile: P, tripId: string): P {
  return mergePartyDiet(profile, listPartyMembers(tripId).map((member) => ({ constraintsApply: member.constraintsApply, diet: member.traveler.diet })));
}
