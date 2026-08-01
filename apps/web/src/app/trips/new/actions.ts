'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { tripBasicsSchema, TRAVELER_NEEDS } from '@sidequest/core';
import { resolveRegion } from '@sidequest/core/data';
import { createTrip } from '@/lib/db/repository';
import { saveDestinationQuery } from '@/lib/db/compiler-repository';
import { DYNAMIC_REGION_ID } from '@/lib/region';

export interface NewTripState {
  error?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
}

const formSchema = z.object({
  destinationInput: z.string().trim().min(2, 'Tell us where you are going'),
  startDate: z.string().min(1, 'Pick a start date'),
  endDate: z.string().min(1, 'Pick an end date'),
  arrivalTime: z.string().min(1, 'When do you arrive?'),
  departureTime: z.string().min(1, 'When do you leave?'),
  adults: z.coerce.number().int().min(1, 'At least one traveller').max(12),
  children: z.coerce.number().int().min(0).max(12),
});

export async function createTripAction(
  _previous: NewTripState,
  formData: FormData,
): Promise<NewTripState> {
  const raw = {
    destinationInput: String(formData.get('destinationInput') ?? ''),
    startDate: String(formData.get('startDate') ?? ''),
    endDate: String(formData.get('endDate') ?? ''),
    arrivalTime: String(formData.get('arrivalTime') ?? ''),
    departureTime: String(formData.get('departureTime') ?? ''),
    adults: String(formData.get('adults') ?? '2'),
    children: String(formData.get('children') ?? '0'),
  };
  const values = { ...raw };

  const parsedForm = formSchema.safeParse(raw);
  if (!parsedForm.success) {
    return { fieldErrors: fieldErrorsFrom(parsedForm.error), values };
  }

  /**
   * Two doors, and which one a destination goes through is decided here.
   *
   * A string that names a region we already hold in full keeps the journey it has
   * always had: straight to the questionnaire, against authored data. Anything
   * else goes to the compiler, which reads it, asks what it needs to, and builds
   * a region. The traveller sees a different next screen; nothing else differs.
   */
  const region = resolveRegion(parsedForm.data.destinationInput);
  const travelerNeeds = TRAVELER_NEEDS.filter((need) => formData.get(`need-${need}`) === 'on');

  const parsedBasics = tripBasicsSchema.safeParse({
    mode: 'known_destination',
    regionId: region?.id ?? DYNAMIC_REGION_ID,
    travelerNeeds,
    ...parsedForm.data,
  });
  if (!parsedBasics.success) {
    return { fieldErrors: fieldErrorsFrom(parsedBasics.error), values };
  }

  let tripId: string;
  try {
    tripId = createTrip(parsedBasics.data).id;
    if (!region) {
      // The typed string is the durable artifact from here on: the compiler
      // reads it, and a refresh on the next screen resumes from it.
      saveDestinationQuery(tripId, 'known_destination', parsedForm.data.destinationInput);
    }
  } catch (error) {
    console.error('Failed to create trip', error);
    return {
      error: 'We could not save that trip. Nothing was lost — try again.',
      values,
    };
  }

  redirect(region ? `/trips/${tripId}/questionnaire` : `/trips/${tripId}/plan`);
}

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}
