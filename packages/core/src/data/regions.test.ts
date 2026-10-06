import { describe, expect, it } from 'vitest';
import { resolveRegion } from './regions';

/**
 * REGION ALIASES ARE WHOLE-TOKEN PHRASES, NEVER SUBSTRINGS.
 *
 * `resolveRegion` used a two-way substring test, so "Mammoth Cave National
 * Park", "Mammoth Hot Springs" and a bare "Lake" all resolved to the authored
 * Eastern Sierra region and sent the traveller to California.
 */
describe('resolveRegion', () => {
  it.each([
    'Mammoth Lakes',
    'Mammoth Lakes, California',
    'Mammoth Lakes CA',
    'mammoth lakes, ca',
    'June Lake',
    'June Lake, CA',
    'Eastern Sierra',
    'the Eastern Sierra',
    'eastern-sierra',
    'Mono County, California',
  ])('%s → the Eastern Sierra', (input) => {
    expect(resolveRegion(input)?.id).toBe('eastern-sierra');
  });

  it.each([
    'Mammoth Cave National Park',
    'Mammoth Cave, Kentucky',
    'Mammoth Hot Springs',
    'Mammoth Hot Springs, Wyoming',
    'mammoth',
    'Lake',
    'Lakes',
    'Sierra',
    'Sierra Leone',
    'Sierra Nevada, Spain',
    'Mono',
    'June',
    'County',
    'Monaco',
    'mam',
    'Mammoth Lakes Cave',
    '',
    '   ',
  ])('%s → null', (input) => {
    expect(resolveRegion(input)).toBeNull();
  });

  it('requires a resolved centre to fall inside the region radius when one is given', () => {
    expect(resolveRegion('Mammoth Lakes', { center: { lat: 37.6485, lng: -118.9721 } })?.id).toBe('eastern-sierra');
    // A same-named place on another continent cannot borrow the region by its words.
    expect(resolveRegion('Mammoth Lakes', { center: { lat: 37.187, lng: -86.1 } })).toBeNull();
    expect(resolveRegion('Mammoth Lakes', { center: null })?.id).toBe('eastern-sierra');
  });
});
