import { z } from 'zod';
import { INTERESTS, SCAN_BOOKING, SCAN_EXPOSURES, SCAN_KINDS, SCAN_TIERS, renderTravelerBriefXml, type TravelerBrief } from '@sidequest/core';
import type { DestinationEnvelope } from '../planning/composition';

/**
 * V1 CONVERGENCE — THE DISCOVERY SCAN'S ONE MODEL CALL.
 *
 * The model is asked for a *candidate pool*, never an itinerary: what is worth
 * considering at this destination for this traveller, the places they could
 * sleep, and the soft judgements only travel knowledge supplies. It does not
 * choose days, order, or how many of anything end up in the plan — Sidequest
 * scores, selects, clusters, assigns and orders deterministically afterwards
 * (master prompt §27: the LLM is not the optimizer).
 *
 * Every closed vocabulary is written into the instruction because the provider
 * enforces none of them (CLAUDE.md, V9.1); `normalizeScanProposal` checks each
 * one again on the way back.
 */

export const SCAN_PROMPT_VERSION = 'discovery-scan/2026-10-06.2';
export const SCAN_JSON_TAG = 'scan_proposal';

/** How many candidates to ask for: enough to choose from, never so many the answer runs long. */
export function scanCandidateTarget(days: number): { min: number; max: number } {
  const min = Math.max(18, Math.min(36, days * 4));
  return { min, max: Math.min(45, min + 10) };
}

export const SCAN_INSTRUCTION = `You are Sidequest's destination researcher. A traveller has described themselves and their trip. Your job is to propose a CANDIDATE POOL for their Discovery Board — the experiences worth considering, the towns or neighbourhoods they could sleep in, and the food areas worth knowing — with honest soft attributes for each.

You are NOT writing an itinerary. Do not assign days, order, or a schedule. Sidequest locates every place on a map, measures travel times, scores each candidate against the traveller's answers, lets them choose, and builds the days itself. Propose more than they can do so there is something to choose between.

What a strong pool looks like:
1. Fit first. Lead with what this traveller said they care about, at the frequency they said. Respect every hard rule and avoidance; do not propose what they asked to avoid.
2. A real mix. The destination's defining classics (tier "classic"), genuinely quieter places a knowledgeable local would suggest (tier "hidden_gem"), and worthwhile things a little further out that need a deliberate trip (tier "side_quest"). Match the classic/hidden balance they asked for.
3. The region, not the city limits. Include nearby towns, viewpoints, day trips and scenic detours within the reach their transport and regional-expansion answers allow. Respect a car-free traveller: propose what is reachable by walking and public transport, and say in "caution" when something needs a car or a tour.
4. Weather and season. Mark exposure honestly and include several "rainyDayOk" options. If something is closed or impractical in the trip's months, either leave it out or give its openMonths and a seasonalNote.
5. One place per candidate. Never combine several stops into one candidate ("X to Y to Z"), and never list the same place twice under different names. A day trip is a candidate named by its town ("Kamakura", kind small_town) with the highlights in "why".
6. Real names only. Every candidate and base must be a real, specific, findable place with its proper name and the town or district it is in ("locality"). Never invent a venue. If you are unsure a place exists or is open, leave it out. Where the place's own name is written in another language or script locally, give that name too as "localName" (for example the name on the sign at the entrance); maps in that country often know only it.
7. Honest attributes. durationMinutes is time on site, not travel. intensity is physical effort (none, easy, moderate, strenuous). costLevel is 0 free, 1 cheap, 2 moderate, 3 expensive. booking is "required" only when entry genuinely needs advance booking.
8. Bases. Propose 1 to 5 places to sleep, in the order a traveller arriving would reach them, each with a nightsHint (your suggestion; Sidequest re-allocates nights from what is near each base) and why. A single dense city is usually one base. Respect how willing they are to change hotels.
9. "why" is one sentence about why THIS traveller would want it, grounded in what they told you. No hype words.
10. "skipped": up to 6 famous things you deliberately left out because they do not fit this traveller, each with a one-line reason.
11. "package": short practical prose — how to get around (transportSummary, transportNotes), beforeYouGo, packing (specific to the season and the activities you proposed), foodStrategy, bookingPriorities. Do not state entry, visa or health rules as fact; say what to check and where.

Closed vocabularies (use exactly these strings):
- kind: ${SCAN_KINDS.join(', ')}
- tier: ${SCAN_TIERS.join(', ')}
- intensity: none, easy, moderate, strenuous
- exposure: ${SCAN_EXPOSURES.join(', ')}
- bestTime: sunrise, morning, afternoon, sunset, night, any
- crowd: quiet, moderate, busy, very_busy
- booking: ${SCAN_BOOKING.join(', ')}
- interests (choose 1-3 per candidate): ${INTERESTS.join(', ')}

Output contract: reply with ONE JSON object (if asked to wrap it, inside <${SCAN_JSON_TAG}>…</${SCAN_JSON_TAG}>) and nothing else. Shape:
{"bases":[{"name","locality","nightsHint","why","lodgingArea"}],
 "candidates":[{"name","localName","locality","zone","kind","tier","durationMinutes","intensity","costLevel","exposure","bestTime","crowd","openMonths","seasonalNote","booking","rainyDayOk","interests","why","caution"}],
 "foodAreas":[{"name","locality","specialty","why"}],
 "skipped":[{"name","reason"}],
 "package":{"transportSummary","transportNotes":[],"beforeYouGo":[],"packing":[],"foodStrategy":[],"bookingPriorities":[]}}
Omit optional fields (zone, openMonths, seasonalNote, caution, lodgingArea) rather than writing null. Keep every string short.`;

/** The shape described to the transport. Loose on purpose: the normaliser, not the provider, holds the vocabularies to account. */
export const scanProposalWireSchema = z.object({
  bases: z.array(z.object({ name: z.string(), locality: z.string(), nightsHint: z.number(), why: z.string(), lodgingArea: z.string().optional() })),
  candidates: z.array(
    z.object({
      name: z.string(),
      locality: z.string(),
      localName: z.string().optional(),
      zone: z.string().optional(),
      kind: z.string(),
      tier: z.string(),
      durationMinutes: z.number(),
      intensity: z.string(),
      costLevel: z.number(),
      exposure: z.string(),
      bestTime: z.string(),
      crowd: z.string(),
      openMonths: z.array(z.number()).optional(),
      seasonalNote: z.string().optional(),
      booking: z.string(),
      rainyDayOk: z.boolean(),
      interests: z.array(z.string()),
      why: z.string(),
      caution: z.string().optional(),
    }),
  ),
  foodAreas: z.array(z.object({ name: z.string(), locality: z.string(), specialty: z.string(), why: z.string() })),
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  package: z.object({
    transportSummary: z.string(),
    transportNotes: z.array(z.string()),
    beforeYouGo: z.array(z.string()),
    packing: z.array(z.string()),
    foodStrategy: z.array(z.string()),
    bookingPriorities: z.array(z.string()),
  }),
});

export interface ScanPromptInput {
  envelope: DestinationEnvelope;
  brief: TravelerBrief;
  startDate: string;
  endDate: string;
  days: number;
  /** Must-dos the traveller named in their own words; they lead the pool. */
  namedMustDos: readonly string[];
}

/** Sidequest's own words: the task. The traveller's free text never appears here; it travels in the untrusted payload. */
export function buildScanTask(input: ScanPromptInput): string {
  const { envelope, brief } = input;
  const target = scanCandidateTarget(input.days);
  const lines = [
    `<destination>`,
    `name: ${envelope.name}`,
    ...(envelope.qualifiedName ? [`qualified: ${envelope.qualifiedName}`] : []),
    ...(envelope.countryName ? [`country: ${envelope.countryName}`] : []),
    ...(envelope.scale ? [`scale: ${envelope.scale}`] : []),
    ...(envelope.coverage && envelope.coverage.length > 0
      ? [`areas a trip here can draw on: ${envelope.coverage.map((z) => `${z.label} (${z.role}, ~${Math.round(z.kmFromCentre)} km)`).join('; ')}`]
      : []),
    ...(envelope.gateways && envelope.gateways.length > 0 ? [`gateways (where people arrive; context, not destinations): ${envelope.gateways.join(', ')}`] : []),
    ...(envelope.accessFacts && envelope.accessFacts.length > 0 ? [`operational facts: ${envelope.accessFacts.join(' | ')}`] : []),
    `</destination>`,
    `<dates>${input.startDate} to ${input.endDate} (${input.days} days)</dates>`,
    renderTravelerBriefXml(brief),
    `<task>Propose ${target.min} to ${target.max} candidates, 1 to 5 bases, up to 8 food areas, up to 6 skipped classics, and the package. ${input.namedMustDos.length > 0 ? 'Every place the traveller named as a must-do appears as a candidate unless it is genuinely impossible on these dates (then put it in skipped with the reason).' : ''}</task>`,
  ];
  return lines.join('\n');
}

/**
 * V1 — THE ONE SUPPLEMENT A THIN SCAN MAY ASK FOR.
 *
 * Same destination, same traveller, same output contract; the task names what
 * the first pass already proposed (so nothing repeats) and what the board is
 * missing. Called at most once per scan, only when `scanSufficiency` says the
 * placed pool cannot be planned from.
 */
export function buildScanSupplementTask(input: ScanPromptInput, gap: { already: readonly string[]; count: number; missingInterests: readonly string[] }): string {
  const task = [
    `<task>The first pass proposed too few places that could be found on a map to plan ${input.days} days from. Propose ${gap.count} to ${gap.count + 8} MORE candidates — real, specific, findable places with their proper names and localities — that are NOT in this list: ${gap.already.slice(0, 60).join('; ')}.`,
    gap.missingInterests.length > 0 ? ` Favour what the board does not yet cover: ${gap.missingInterests.map((i) => i.replace(/_/g, ' ')).join(', ')}.` : ' Favour kinds of place the list does not cover yet.',
    ' Repeat the bases from before (at least one). Food areas, skipped classics and the package may be empty.</task>',
  ].join('');
  return buildScanTask(input).replace(/<task>[\s\S]*<\/task>/, task);
}

export function buildScanUntrusted(input: ScanPromptInput): Record<string, unknown> {
  return {
    ...(envelope(input).travellerPhrase ? { destinationAsTyped: envelope(input).travellerPhrase } : {}),
    ...(input.namedMustDos.length > 0 ? { mustDosAsTyped: input.namedMustDos.slice(0, 24) } : {}),
  };
}

function envelope(input: ScanPromptInput): DestinationEnvelope {
  return input.envelope;
}
