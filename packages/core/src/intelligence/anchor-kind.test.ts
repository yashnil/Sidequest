import { describe, expect, it } from 'vitest';
import { anchorKindOf, gatewayIsUnresolved, isGatewayName, isTransferName, lookupPriorityFor, mealSlotOf, verificationApplies } from './anchor-kind';

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

/**
 * V6 §11 — TRANSPORT IS NOT A POI.
 *
 * "Drive Bhopal to Bandhavgarh" was a core anchor, a signature and a "Don't
 * miss" on a live trip; "New Chitose or Asahikawa Airport" was a stop. Both are
 * logistics, and one of them is a decision nobody has made.
 */
describe('transfers and gateways', () => {
  it('movement between two places is a transfer whatever category the model chose', () => {
    expect(anchorKindOf({ name: 'Drive Bhopal to Bandhavgarh', category: 'scenic_drive', role: 'core' })).toBe('transfer');
    expect(anchorKindOf({ name: 'Transfer to Khajuraho', category: 'other' })).toBe('transfer');
    expect(anchorKindOf({ name: 'Flight Sapporo → Kushiro', category: 'other' })).toBe('transfer');
    expect(anchorKindOf({ name: 'Train from Kyoto to Tokyo', category: 'landmark' })).toBe('transfer');
    expect(anchorKindOf({ name: 'Bandhavgarh to Khajuraho drive', category: 'scenic_drive' })).toBe('transfer');
    expect(isTransferName('Ferry to Rottnest Island')).toBe(true);
  });
  it('a scenic route with a name of its own is still a route experience, not a transfer', () => {
    expect(anchorKindOf({ name: 'Slea Head Drive', category: 'scenic_drive' })).toBe('route_experience');
    expect(anchorKindOf({ name: 'Ring of Kerry scenic drive', category: 'scenic_drive' })).toBe('route_experience');
    expect(anchorKindOf({ name: 'Cape Kamui', category: 'viewpoint' })).toBe('named_place');
    expect(isTransferName('Golden Circle loop')).toBe(false);
  });
  it('an airport or station is a gateway, and one that names a choice is unresolved', () => {
    expect(anchorKindOf({ name: 'New Chitose or Asahikawa Airport', category: 'other' })).toBe('gateway');
    expect(anchorKindOf({ name: 'Arrive Kushiro Airport', category: 'other' })).toBe('gateway');
    expect(gatewayIsUnresolved('New Chitose or Asahikawa Airport')).toBe(true);
    expect(gatewayIsUnresolved('New Chitose Airport')).toBe(false);
    expect(isGatewayName('Station quarter market')).toBe(false);
  });
  it('neither is ever looked up or called "not verified"', () => {
    expect(lookupPriorityFor('transfer', 'core')).toBeNull();
    expect(lookupPriorityFor('gateway', 'core')).toBeNull();
    expect(verificationApplies('transfer')).toBe(false);
    expect(verificationApplies('gateway')).toBe(false);
  });
});
