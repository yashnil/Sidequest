import { describe, expect, it } from 'vitest';
import { anchorKindOf, lookupPriorityFor, mealSlotOf, verificationApplies } from './anchor-kind';

describe('anchor semantics', () => {
  it('named places resolve; areas, routes, generic experiences and meals do not pretend to', () => {
    expect(anchorKindOf({ name: 'Kilkenny Castle', category: 'historic' })).toBe('named_place');
    expect(anchorKindOf({ name: 'Rock of Cashel', category: 'historic' })).toBe('named_place');
    expect(anchorKindOf({ name: 'Cliffs of Moher', category: 'viewpoint' })).toBe('named_place');
    expect(anchorKindOf({ name: 'English Market', category: 'market' })).toBe('named_place');
    expect(anchorKindOf({ name: 'Kylemore Abbey', category: 'landmark' })).toBe('named_place');
    expect(anchorKindOf({ name: "St Canice's Cathedral and round tower", category: 'historic' })).toBe('named_place');
    expect(anchorKindOf({ name: 'Temple Bar and Grafton Street', category: 'neighbourhood' })).toBe('named_place');
    expect(anchorKindOf({ name: 'Kinsale town walk and harbour', category: 'neighbourhood' })).toBe('area_experience');
    expect(anchorKindOf({ name: 'Galway Latin Quarter evening walk', category: 'neighbourhood' })).toBe('area_experience');
    expect(anchorKindOf({ name: 'Slea Head Drive', category: 'scenic_drive' })).toBe('route_experience');
    expect(anchorKindOf({ name: 'Ring of Kerry scenic drive', category: 'scenic_drive' })).toBe('route_experience');
    expect(anchorKindOf({ name: 'Traditional pub with live music', category: 'food', role: 'optional' })).toBe('meal');
    expect(anchorKindOf({ name: 'Killarney town pub dinner', category: 'food' })).toBe('meal');
    expect(anchorKindOf({ name: 'Dingle town food stop', category: 'food' })).toBe('meal');
    expect(anchorKindOf({ name: 'Evening stroll near Dublin base', category: 'neighbourhood', role: 'flex' })).toBe('flex');
    expect(anchorKindOf({ name: 'Short walk near hotel', category: 'neighbourhood', role: 'flex' })).toBe('flex');
    expect(anchorKindOf({ name: 'Local café and short walk near base', category: 'neighbourhood', role: 'flex' })).toBe('flex');
    expect(anchorKindOf({ name: 'Dublin evening stroll and Guinness Storehouse area', category: 'landmark' })).toBe('area_experience');
  });
  it('a named food venue is still a place', () => {
    expect(anchorKindOf({ name: 'Dingle Distillery tour', category: 'food' })).toBe('named_place');
    expect(anchorKindOf({ name: 'Chapter One', category: 'food' })).toBe('named_place');
  });
  it('lookup priority: core named first, secondary named next, areas and routes for the map, nothing for meals and generic experiences', () => {
    expect(lookupPriorityFor('named_place', 'core')).toBe(1);
    expect(lookupPriorityFor('named_place', 'secondary')).toBe(2);
    expect(lookupPriorityFor('area_experience', 'core')).toBe(3);
    expect(lookupPriorityFor('meal', 'core')).toBeNull();
    expect(lookupPriorityFor('generic_experience', 'secondary')).toBeNull();
  });
  it('"not verified" only applies to a named place', () => {
    expect(verificationApplies('named_place')).toBe(true);
    expect(verificationApplies('generic_experience')).toBe(false);
    expect(verificationApplies(undefined)).toBe(true);
  });
  it('meal slot from wording', () => {
    expect(mealSlotOf('Killarney town pub dinner')).toBe('dinner');
    expect(mealSlotOf('Dingle town food stop')).toBe('dinner');
    expect(mealSlotOf('Coffee and pastry near hotel')).toBe('breakfast');
    expect(mealSlotOf('Market lunch')).toBe('lunch');
  });
});
