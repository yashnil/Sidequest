'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { resolveRegion, tripBasicsSchema, TRAVELER_NEEDS } from '@sidequest/core';
import { createTrip } from '@/lib/db/repository';

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

  // Only one region is seeded, and pretending otherwise would send the traveller
  // into an empty board.
  const region = resolveRegion(parsedForm.data.destinationInput);
  if (!region) {
    return {
      fieldErrors: {
        destinationInput:
          'We only have the Eastern Sierra mapped so far. Try “Mammoth Lakes”, “June Lake” or “Eastern Sierra”.',
      },
      values,
    };
  }

  const travelerNeeds = TRAVELER_NEEDS.filter((need) => formData.get(`need-${need}`) === 'on');

  const parsedBasics = tripBasicsSchema.safeParse({
    mode: 'known_destination',
    regionId: region.id,
    travelerNeeds,
    ...parsedForm.data,
  });
  if (!parsedBasics.success) {
    return { fieldErrors: fieldErrorsFrom(parsedBasics.error), values };
  }

  let tripId: string;
  try {
    tripId = createTrip(parsedBasics.data).id;
  } catch (error) {
    console.error('Failed to create trip', error);
    return {
      error: 'We could not save that trip. Nothing was lost — try again.',
      values,
    };
  }

  redirect(`/trips/${tripId}/questionnaire`);
}

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}
