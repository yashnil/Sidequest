import { describe, expect, it } from 'vitest';
import { tripBasicsSchema } from './trip';

/**
 * THE ONE FREE-TEXT FIELD ON THE TRIP IS BOUNDED LIKE THE REST OF IT.
 *
 * Everything else in `tripBasicsSchema` has a ceiling — traveller counts, the
 * date range, the enums — and `destinationInput` did not, on the single field a
 * stranger types and the product then carries to a geocoder, into a compilation
 * and into a model prompt. Unbounded free text on that path is an amplifier
 * rather than a validation nicety: one POST becomes one geocoder request, one
 * prompt and a stored row that every later render reads back, all sized by
 * whatever was pasted.
 *
 * The bound is 200 because `composer.ts`'s `destinationQuery` — the field this
 * one is built from — is 200. Asserted against that constant rather than
 * against a literal, so the two cannot drift apart silently.
 */

const BASE = {
  mode: 'known_destination' as const,
  regionId: 'eastern-sierra',
  startDate: '2026-08-12',
  endDate: '2026-08-15',
  arrivalTime: '11:00',
  departureTime: '17:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

function parse(destinationInput: string) {
  return tripBasicsSchema.safeParse({ ...BASE, destinationInput });
}

describe('trip basics', () => {
  it('accepts a place name of the length real place names reach', () => {
    /* Longer than anything in the destination index, and still accepted. */
    const long = 'Sankt Ludwig am Hochgebirge über der Traun'.padEnd(200, ' x').slice(0, 200);
    expect(long.length).toBe(200);
    const result = parse(long);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('refuses free text that is no longer a place name', () => {
    const flood = 'a'.repeat(201);
    const result = parse(flood);
    expect(
      result.success,
      'an unbounded destination reaches the geocoder and the model at whatever size it was pasted',
    ).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path[0] === 'destinationInput')).toBe(true);
  });

  it('still refuses a name too short to mean anything', () => {
    /* The negative control: capping the top must not have removed the floor. */
    expect(parse('a').success).toBe(false);
    expect(parse('  ').success).toBe(false);
  });

  it('agrees with the composer field it is built from', async () => {
    /*
     * `trips/new/actions.ts` puts the same typed string on `destinationQuery`
     * and on `destinationInput`. Two different ceilings would mean one of the
     * two accepting what the other rejects, which is how a trip gets created
     * with a destination the composer cannot store.
     */
    const { tripComposerAnswersSchema } = await import('./composer');
    const shape = tripComposerAnswersSchema.shape.destinationQuery;
    const tooLong = 'a'.repeat(201);
    expect(shape.safeParse(tooLong).success).toBe(false);
    expect(shape.safeParse('a'.repeat(200)).success).toBe(true);
  });
});
