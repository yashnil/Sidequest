import { describe, expect, it } from 'vitest';
import { buildNextActions, buildTripStateGraph, dayState, itinerarySchema, type Itinerary } from '@sidequest/core';
import { activities, overLimitItinerary as overLimit } from './acceptance/travel-limit-world';
import { applyTravelLimitChoice, travelLimitDayViews } from './travel-limit-choices';

/**
 * 2026-11 — THE DAILY-TRAVEL-LIMIT CHOICES DO WHAT THEY SAY.
 *
 * Only executable choices are options; each states its numbers; applying one
 * changes the day (or the decision) and nothing else, never re-measures a leg,
 * and every surface that reads the plan — the state graph, the next actions,
 * the feasibility verdict, the day's items the map draws — agrees afterwards.
 */
function graphOf(itinerary: Itinerary) {
  return buildTripStateGraph({ itinerary, intelligence: null, booked: [], now: new Date('2026-06-01T12:00:00Z') });
}

describe('which choices are offered', () => {
  it('offers keep-the-day and drop-the-pick as options with their numbers, and a stay change only as information', async () => {
    const { itinerary } = await overLimit();
    const [view] = travelLimitDayViews(itinerary);
    expect(view!.dayNumber).toBe(2);
    expect(view!.options.map((o) => o.kind)).toEqual(['accept_long_day', 'drop_stop']);
    const drop = view!.options.find((o) => o.kind === 'drop_stop')!;
    expect(drop.label).toBe('Drop Far Lookout');
    expect(drop.effect).toMatch(/saves about 2 h 40 of travel: day 2 goes from about 3 h 20 to about 40 min, inside your limit/);
    expect(view!.options[0]!.effect).toMatch(/about 3 h 20 of travel, 1 h 50 past your 1 h 30 a day/);
    expect(view!.information.map((i) => i.kind)).toEqual(['stay_on']);
    expect(view!.information[0]!.detail).toMatch(/not something Sidequest can apply here/);
  });

  it('never offers to drop a booked or locked stop: that is information, and applying it is refused', async () => {
    const { itinerary, farId } = await overLimit();
    for (const context of [{ bookedPlaceIds: new Set([farId]) }, { lockedPlaceIds: new Set([farId]) }]) {
      const [view] = travelLimitDayViews(itinerary, context);
      expect(view!.options.map((o) => o.kind)).toEqual(['accept_long_day']);
      expect(view!.information.some((i) => i.kind === 'drop_stop')).toBe(true);
      const refused = applyTravelLimitChoice(itinerary, `drop_stop:2:${farId}`, context);
      expect(refused).toMatchObject({ ok: false });
    }
  });

  it('offers nothing under Sidequest’s own default limit: there is nothing for the traveller to decide', async () => {
    const { itinerary } = await overLimit({ hard: false });
    expect(travelLimitDayViews(itinerary)).toEqual([]);
    expect(applyTravelLimitChoice(itinerary, 'accept_long_day:2').ok).toBe(false);
  });

  it('refuses an id the plan never offered', async () => {
    const { itinerary } = await overLimit();
    for (const id of ['', 'accept_long_day:3', 'drop_stop:2:nowhere', 'drop_stop:2', 'stay_on:2', 'accept_long_day:2:x']) expect(applyTravelLimitChoice(itinerary, id).ok).toBe(false);
  });
});

describe('keeping the long day', () => {
  it('moves nothing, records the choice, and turns the open decision into a caution the traveller owns', async () => {
    const { itinerary } = await overLimit();
    expect(itinerary.package!.feasibility!.verdict).toBe('unresolved_major_dependency');
    expect(dayState(graphOf(itinerary), 2).state).toBe('needs_decision');
    const result = applyTravelLimitChoice(itinerary, 'accept_long_day:2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.itinerary;
    expect(itinerarySchema.safeParse(after).success).toBe(true);
    expect(after.days).toEqual(itinerary.days);
    const record = after.package!.planning!.travelLimit!;
    expect(record.days[0]).toMatchObject({ dayNumber: 2, accepted: true });
    expect(record.choices.filter((c) => c.dayNumber === 2)).toEqual([]);
    expect(record.decisions).toEqual([{ dayNumber: 2, kind: 'accept_long_day', travelMinutesBefore: 200, travelMinutesAfter: 200 }]);
    const item = after.package!.feasibility!.items.find((i) => i.dayNumber === 2 && i.area === 'transport')!;
    expect(item.severity).toBe('caution');
    expect(item.detail).toMatch(/you chose to keep it as planned/);
    expect(after.package!.feasibility!.verdict).not.toBe('unresolved_major_dependency');
    expect(after.status).not.toBe('needs_decision');
    /* The day no longer asks for a decision anywhere the state graph reaches. */
    const graph = graphOf(after);
    expect(dayState(graph, 2).state).not.toBe('needs_decision');
    const actions = buildNextActions({ graph, lifecycle: 'planning', daysUntilTrip: 60, now: new Date('2026-06-01T12:00:00Z') });
    expect(actions.actions.some((a) => a.kind === 'decide' && /Day 2/.test(`${a.title} ${a.why}`))).toBe(false);
    /* And the day shows the decision, not the options. */
    const [view] = travelLimitDayViews(after);
    expect(view!.options).toEqual([]);
    expect(view!.decided).toMatch(/You chose to keep day 2 as planned/);
    expect(applyTravelLimitChoice(after, 'accept_long_day:2').ok).toBe(false);
  });
});

describe('dropping the pick that takes the day over', () => {
  it('takes that stop off that day only, never re-measures, and brings the record, notes and verdict into line', async () => {
    const { itinerary, farId } = await overLimit();
    const result = applyTravelLimitChoice(itinerary, `drop_stop:2:${farId}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = result.itinerary;
    expect(result.dropPlaceId).toBe(farId);
    expect(itinerarySchema.safeParse(after).success).toBe(true);
    /* The map, the PDF and Today read the days: the stop is gone from day 2 and only day 2 changed. */
    expect(activities(after, 2).map((i) => i.title)).toEqual(['River Walk']);
    expect(after.days[0]).toEqual(itinerary.days[0]);
    expect(after.days[2]).toEqual(itinerary.days[2]);
    const day2 = after.days[1]!;
    expect(day2.items.some((i) => i.kind === 'travel' && (i.travel?.toId === farId || i.travel?.fromId === farId))).toBe(false);
    /* Nothing is newly measured: every leg is either untouched from before or honestly unmeasured after the edit. */
    const beforeLegs = new Map(itinerary.days[1]!.items.filter((i) => i.kind === 'travel').map((i) => [i.id, i.travel!] as const));
    for (const leg of day2.items.filter((i) => i.kind === 'travel')) {
      const was = beforeLegs.get(leg.id);
      expect(was, `leg ${leg.id} existed before`).toBeDefined();
      if (leg.travel!.provenance !== was!.provenance) expect(leg.travel!.unmeasuredReason).toBe('not_remeasured_after_edit');
    }
    expect(after.unscheduled.some((u) => u.name === 'Far Lookout')).toBe(true);
    const record = after.package!.planning!.travelLimit!;
    expect(record).toMatchObject({ daysOver: 0, days: [], choices: [] });
    expect(record.decisions).toEqual([{ dayNumber: 2, kind: 'drop_stop', subject: 'Far Lookout', placeId: farId, travelMinutesBefore: 200, travelMinutesAfter: 40 }]);
    expect(after.package!.planning!.dayNotes!.some((n) => n.dayNumber === 2 && n.code === 'travel_over_limit')).toBe(false);
    expect(after.package!.feasibility!.items.some((i) => i.dayNumber === 2 && i.area === 'transport' && /minutes of travel/.test(i.detail))).toBe(false);
    expect(dayState(graphOf(after), 2).state).not.toBe('needs_decision');
    expect(result.changed).toMatch(/You dropped Far Lookout from day 2: about 3 h 20 of travel becomes about 40 min, inside your limit/);
    const [view] = travelLimitDayViews(after);
    expect(view!.decided).toMatch(/You dropped Far Lookout from day 2/);
    expect(view!.options).toEqual([]);
  });

  it('a drop that leaves the day still over keeps only keep-the-day, at the new figure', async () => {
    const { itinerary, farId } = await overLimit();
    const record = itinerary.package!.planning!.travelLimit!;
    const stillOver: Itinerary = { ...itinerary, package: { ...itinerary.package!, planning: { ...itinerary.package!.planning!, travelLimit: { ...record, choices: record.choices.map((c) => (c.kind === 'drop_stop' ? { ...c, travelMinutes: 120 } : c)) } } } };
    const result = applyTravelLimitChoice(stillOver, `drop_stop:2:${farId}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.itinerary.package!.planning!.travelLimit!;
    expect(next.days).toEqual([{ dayNumber: 2, travelMinutes: 120, cause: 'traveller_pick' }]);
    expect(next.choices.map((c) => c.kind)).toEqual(['accept_long_day']);
    const [view] = travelLimitDayViews(result.itinerary);
    expect(view!.options.map((o) => o.kind)).toEqual(['accept_long_day']);
    expect(view!.options[0]!.effect).toMatch(/about 2 h of travel, 30 min past/);
    expect(view!.history).toMatch(/You dropped Far Lookout from day 2: about 3 h 20 of travel became about 2 h/);
    expect(result.itinerary.package!.feasibility!.verdict).toBe('unresolved_major_dependency');
  });
});
