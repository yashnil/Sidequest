import { z } from 'zod';
import type { Itinerary } from '../schemas/itinerary';
import type { TripReadinessPacket } from './readiness';

/**
 * SAFETY WITHOUT FEAR.
 *
 * Three buckets that are never mixed: what an official source says (shown as
 * a link, not paraphrased), practical cautions the plan's own evidence raised
 * (a seasonal road, a daylight-only trail, an untimed leg), and what is
 * unknown. No crime heuristics, no personalisation on sensitive identity.
 */
export const safetyEntrySchema = z.object({
  bucket: z.enum(['official', 'practical', 'unknown']),
  title: z.string().min(1),
  detail: z.string().min(1),
  sourceName: z.string().min(1).optional(),
  sourceUrl: z.string().url().optional(),
  dayNumbers: z.array(z.number().int().min(1)).default([]),
});
export type SafetyEntry = z.infer<typeof safetyEntrySchema>;

export const safetyIntelligenceSchema = z.object({
  official: z.array(safetyEntrySchema),
  practical: z.array(safetyEntrySchema),
  unknown: z.array(safetyEntrySchema),
});
export type SafetyIntelligence = z.infer<typeof safetyIntelligenceSchema>;

export function buildSafety(input: { itinerary: Itinerary; readiness: TripReadinessPacket; remote: boolean }): SafetyIntelligence {
  const official: SafetyEntry[] = [];
  const practical: SafetyEntry[] = [];
  const unknown: SafetyEntry[] = [];
  const advisory = input.readiness.entries.find((e) => e.kind === 'advisory');
  if (advisory && advisory.links[0]) official.push(safetyEntrySchema.parse({ bucket: 'official', title: advisory.title, detail: advisory.summary, sourceName: advisory.links[0].name, sourceUrl: advisory.links[0].url }));
  else if (advisory) unknown.push(safetyEntrySchema.parse({ bucket: 'unknown', title: advisory.title, detail: advisory.summary }));
  const emergency = input.readiness.entries.find((e) => e.kind === 'emergency');
  if (emergency) (emergency.links[0] ? official : unknown).push(safetyEntrySchema.parse({ bucket: emergency.links[0] ? 'official' : 'unknown', title: emergency.title, detail: emergency.summary, ...(emergency.links[0] ? { sourceName: emergency.links[0].name, sourceUrl: emergency.links[0].url } : {}) }));

  for (const warning of input.itinerary.transportStrategy.seasonalWarnings) practical.push(safetyEntrySchema.parse({ bucket: 'practical', title: 'Seasonal road or route limit', detail: warning }));
  for (const day of input.itinerary.days) {
    for (const item of day.items) {
      if (item.accessWarning) practical.push(safetyEntrySchema.parse({ bucket: 'practical', title: item.title, detail: item.accessWarning, dayNumbers: [day.dayNumber] }));
      if (item.daylightOnly) practical.push(safetyEntrySchema.parse({ bucket: 'practical', title: `${item.title}: daylight only`, detail: item.daylight ? `Signed for daylight use; placed inside sunrise to sunset for the date.` : 'Signed for daylight use; sunrise and sunset were not resolved — check the light.', dayNumbers: [day.dayNumber] }));
    }
    for (const caution of day.weather.cautions) practical.push(safetyEntrySchema.parse({ bucket: 'practical', title: `Day ${day.dayNumber} weather`, detail: caution, dayNumbers: [day.dayNumber] }));
  }
  if (input.remote) practical.push(safetyEntrySchema.parse({ bucket: 'practical', title: 'Remote sections', detail: 'Tell someone your route for the remote days, carry water and a charged phone, and do not count on signal.' }));
  const unmeasuredDays = input.itinerary.days.filter((d) => d.totals.unmeasuredLegCount > 0);
  if (unmeasuredDays.length > 0) unknown.push(safetyEntrySchema.parse({ bucket: 'unknown', title: 'Untimed transfers', detail: `${unmeasuredDays.length} day${unmeasuredDays.length === 1 ? '' : 's'} carry a leg nobody could time. Leave slack around them.`, dayNumbers: unmeasuredDays.map((d) => d.dayNumber) }));
  const dedupe = (list: SafetyEntry[]) => list.filter((e, i, all) => all.findIndex((x) => x.title === e.title && x.detail === e.detail) === i);
  return safetyIntelligenceSchema.parse({ official: dedupe(official), practical: dedupe(practical).slice(0, 12), unknown: dedupe(unknown) });
}
