'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AGE_GROUPS, DIETARY_NEEDS, FUNCTIONAL_NEEDS, PARTY_ROLES, PHYSICAL_CAPABILITIES, SLEEP_RHYTHMS, type Traveler } from '@sidequest/core';
import { currentUserId } from '@/lib/auth/session';
import { createTraveler, getTraveler, listPartyMembers, removePartyMember, setPartyMember, travelerOwner, updateTraveler } from '@/lib/db/party-repository';
import { sessionToken } from '@/lib/net/caller';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * THE PARTY'S ACTIONS — DESCRIBE A PERSON, PUT THEM ON THE TRIP, TAKE THEM OFF.
 *
 * V6 §3/§4. Every action asks the trip's ownership seam first, and a traveller
 * row is edited only by the account (or, unclaimed, the browser) that made it.
 * Nothing here infers anything: the needs are the traveller's own ticks and
 * words, stored as planning inputs, never turned into a diagnosis.
 */

export type PartyResult = { ok: true; travelerId?: string } | { ok: false; error: string };

const tripId = z.string().min(1).max(80);

const personSchema = z.object({
  displayName: z.string().trim().min(1, 'Give them a name, even just "Mum".').max(60),
  ageGroup: z.enum(AGE_GROUPS).optional(),
  relationship: z.enum(PARTY_ROLES).optional(),
  dietaryNeeds: z.array(z.enum(DIETARY_NEEDS)).max(16).default([]),
  dietaryStrict: z.boolean().default(false),
  dietaryNotes: z.string().trim().max(400).optional(),
  needs: z.array(z.enum(FUNCTIONAL_NEEDS)).max(20).default([]),
  needsNotes: z.string().trim().max(600).optional(),
  physicalCapability: z.enum(PHYSICAL_CAPABILITIES).optional(),
  sleepRhythm: z.enum(SLEEP_RHYTHMS).optional(),
  drives: z.boolean().default(false),
  preferencesApply: z.boolean().default(true),
  constraintsApply: z.boolean().default(true),
});
export type PersonInput = z.infer<typeof personSchema>;

function travelerPatchFrom(input: PersonInput): Omit<Traveler, 'id' | 'version' | 'createdAt' | 'updatedAt'> {
  return {
    displayName: input.displayName,
    ...(input.ageGroup ? { ageGroup: input.ageGroup } : {}),
    ...(input.relationship ? { relationship: input.relationship } : {}),
    diet: { needs: input.dietaryNeeds, strict: input.dietaryStrict, allergyCrossContamination: input.dietaryNeeds.includes('nut_allergy'), ...(input.dietaryNotes ? { notes: input.dietaryNotes } : {}) },
    needs: input.needs,
    ...(input.needsNotes ? { needsNotes: input.needsNotes } : {}),
    profile: {
      interests: {},
      ...(input.physicalCapability ? { physicalCapability: input.physicalCapability } : {}),
      ...(input.sleepRhythm ? { sleepRhythm: input.sleepRhythm } : {}),
      transportComfort: input.drives ? ['drives'] : [],
      lodgingNeeds: [],
    },
    privacy: { hideFromPrint: false },
  };
}

async function ownsTraveler(travelerId: string): Promise<boolean> {
  const owner = travelerOwner(travelerId);
  if (!owner) return false;
  const userId = await currentUserId();
  if (owner.userId) return owner.userId === userId;
  const token = await sessionToken({ mint: false });
  return Boolean(owner.ownerToken && token && owner.ownerToken === token);
}

export async function addPersonAction(id: string, input: PersonInput): Promise<PartyResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  const parsed = personSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Something in that form was not right.' };
  const owner = { userId: await currentUserId(), ownerToken: await sessionToken({ mint: true }) };
  const traveler = createTraveler(owner, travelerPatchFrom(parsed.data));
  const position = listPartyMembers(id).length;
  setPartyMember({ tripId: id, travelerId: traveler.id, role: parsed.data.relationship ?? 'other', preferencesApply: parsed.data.preferencesApply, constraintsApply: parsed.data.constraintsApply, participation: 'described', position });
  revalidatePath(`/trips/${id}/party`);
  return { ok: true, travelerId: traveler.id };
}

export async function updatePersonAction(id: string, travelerId: string, input: PersonInput): Promise<PartyResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  if (!(await ownsTraveler(travelerId))) return { ok: false, error: 'That person was described by somebody else, so only they can change it.' };
  const parsed = personSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Something in that form was not right.' };
  const existing = getTraveler(travelerId);
  if (!existing) return { ok: false, error: 'That person is no longer on record.' };
  updateTraveler(travelerId, { ...travelerPatchFrom(parsed.data), profile: { ...existing.profile, ...travelerPatchFrom(parsed.data).profile, interests: existing.profile.interests } });
  const member = listPartyMembers(id).find((m) => m.travelerId === travelerId);
  setPartyMember({ tripId: id, travelerId, role: parsed.data.relationship ?? member?.role ?? 'other', preferencesApply: parsed.data.preferencesApply, constraintsApply: parsed.data.constraintsApply, participation: member?.participation ?? 'described', position: member?.position ?? 0 });
  revalidatePath(`/trips/${id}/party`);
  return { ok: true, travelerId };
}

/** Put a person the account already described onto this trip. */
export async function attachPersonAction(id: string, travelerId: string): Promise<PartyResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  if (!(await ownsTraveler(travelerId))) return { ok: false, error: 'That person was described by somebody else.' };
  const traveler = getTraveler(travelerId);
  if (!traveler) return { ok: false, error: 'That person is no longer on record.' };
  setPartyMember({ tripId: id, travelerId, role: traveler.relationship ?? 'other', preferencesApply: true, constraintsApply: true, participation: 'described', position: listPartyMembers(id).length });
  revalidatePath(`/trips/${id}/party`);
  return { ok: true, travelerId };
}

export async function removePersonAction(id: string, travelerId: string): Promise<PartyResult> {
  if (!tripId.safeParse(id).success) return { ok: false, error: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(id);
  if (refusal) return { ok: false, error: refusal };
  removePartyMember(id, travelerId);
  revalidatePath(`/trips/${id}/party`);
  return { ok: true };
}
