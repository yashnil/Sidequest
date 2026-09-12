'use server';

import { z } from 'zod';
import {
  concreteWindow,
  monthsBetween,
  recommendDateWindows,
  seasonMonths,
  type ConcreteWindow,
  type DateWindow,
} from '@sidequest/core';
import { geographicScaleOf, regionalClimate } from '@/lib/climate/regional';
import { destinationEntryById } from '@/lib/db/destination-index-repository';
import { isClimateEnabled } from '@/lib/providers/switches';
import { guardAction } from '@/lib/net/caller';

/**
 * "TELL ME WHEN THIS PLACE IS AT ITS BEST" — ANSWERED, OR HONESTLY DECLINED.
 *
 * MVP V3, Stages 5, 6 and 46. The only new capability here is the *shape* of
 * the answer: a period a person can act on ("Late May to mid-June"), the
 * reasons, the tradeoffs, and a named runner-up. Everything it says comes from
 * `recommendDateWindows`, which is twenty years of climate normals and locally
 * computed daylight and nothing else — no crowd data, no prices, no festivals,
 * because none of those is sourced.
 *
 * Three rules this action holds:
 *
 * - **No destination is ever a special case.** The input is a coordinate.
 * - **No climate records, no recommendation.** `unavailable` comes back with the
 *   reason, and the screen asks for dates instead of inventing them.
 * - **It costs nothing repeatable.** Climate normals are cached for a month
 *   (`climate/cache.ts`), so a traveller flicking between months pays for at
 *   most one lookup per destination.
 */

const inputSchema = z.object({
  entryId: z.string().max(120).nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  nights: z.number().int().min(1).max(30),
  /** Restrict the ranking: the months a traveller named, a season, or a free window. */
  months: z.array(z.number().int().min(1).max(12)).max(12).default([]),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).nullable().default(null),
  earliest: z.string().max(10).nullable().default(null),
  latest: z.string().max(10).nullable().default(null),
  /**
   * V8.1 — the destination's extent and scale, when the semantic gate placed
   * it as an area. A region is read at several points inside its box rather
   * than at one coordinate; a place with no box or below regional scale is
   * read at its centre as before. An unrecognised scale reads as a place.
   */
  bounds: z
    .object({ southWest: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }), northEast: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }) })
    .nullable()
    .default(null),
  scale: z.string().max(20).nullable().default(null),
});
export type TimingInput = z.input<typeof inputSchema>;

export interface TimingWindowView {
  label: string;
  startDate: string;
  endDate: string;
  month: number;
  year: number;
  reasons: string[];
  tradeoffs: string[];
}

export type TimingResult =
  | {
      ok: true;
      pick: TimingWindowView;
      alternatives: TimingWindowView[];
      /** Named rather than omitted: the dimensions this answer does not cover. */
      unknowns: string[];
      attribution: string;
      sampleYears: string;
      /** V8.1 — how many points across the destination the normals were read at. One for a place; up to three for a region. */
      sampledPoints: number;
      /** The sentence about what a regional average hides, when there is one. Also the first entry of `unknowns`. */
      regionalNote: string | null;
    }
  /**
   * NOT YET, RATHER THAN NOT AT ALL (§5).
   *
   * The traveller asked Sidequest to choose the window. Sidequest cannot compare
   * months for a point it does not have yet — and the honest answer to that is
   * "later", not "pick your own dates", which is what this used to say. Their
   * requested planning mode is not rewritten by a piece of missing evidence: the
   * intent is already carried to the server as `wantsDateRecommendation`, the
   * composition reads it, and the window is chosen with the trip.
   */
  | { ok: false; deferred: true; note: string }
  | { ok: false; deferred?: false; note: string };

function view(window: DateWindow, placed: ConcreteWindow): TimingWindowView {
  return {
    label: placed.label,
    startDate: placed.startDate,
    endDate: placed.endDate,
    month: placed.month,
    year: placed.year,
    reasons: [...window.reasons].slice(0, 3),
    tradeoffs: [...window.tradeoffs].slice(0, 3),
  };
}

export async function recommendTimingAction(raw: TimingInput): Promise<TimingResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, note: 'We could not read that destination well enough to look at its seasons.' };
  const input = parsed.data;

  // A lookup that can reach a provider takes a token, like every other one.
  const refusal = await guardAction('timing_recommendation');
  if (refusal) return { ok: false, note: refusal };

  if (!isClimateEnabled()) {
    /*
     * MVP V3 — WHAT THE TRAVELLER LACKS, NOT WHAT THE DEPLOYMENT LACKS.
     *
     * This read "Climate records are switched off in this build", which is a
     * fact about a configuration nobody planning a holiday has heard of. The
     * honest traveller sentence is the same refusal without the machinery:
     * Sidequest has no climate record to reason from, so it will not name a
     * month, and here is what to do instead.
     */
    return { ok: false, deferred: true, note: 'Sidequest will choose the best window once it understands the trip. You can also pick your own dates or a rough month.' };
  }

  const entry = input.entryId ? destinationEntryById(input.entryId) : null;
  const centre = entry?.center ?? (input.lat !== null && input.lng !== null ? { lat: input.lat, lng: input.lng } : null);
  if (!centre) {
    /*
     * No coordinate *yet*. `place-actions.ts` resolves typed text when the
     * traveller leaves the destination step, so this is the window between the
     * two — or a deployment with no geocoder and a destination the bundled
     * country reference does not cover. Either way the answer is "later".
     */
    return { ok: false, deferred: true, note: "We'll choose the best window once we understand the trip." };
  }

  const now = new Date();
  /* An index pick carries its own box; a typed destination's box and scale arrive from the setup draft. */
  const extent = entry?.bounds ?? input.bounds ?? null;
  const climate = await regionalClimate({ center: centre, bounds: extent, scale: geographicScaleOf(input.scale) }, now);
  if (!climate.profile) {
    /*
     * A climate archive that did not answer is not a place without seasons. The
     * one distinction worth making to a traveller is whether waiting helps: a
     * rate-limited archive answers a minute later, an unavailable one does not.
     */
    return {
      ok: false,
      deferred: true,
      note:
        climate.reason === 'provider_rate_limited'
          ? 'The climate records are busy this minute. Try again shortly, or carry on and Sidequest will choose the window with the plan.'
          : 'We could not read the climate records just now, so Sidequest will choose the window with the plan.',
    };
  }
  const profile = climate.profile;

  /*
   * What the traveller has already narrowed to. A free window is converted to
   * the months it spans, so "I am free 20 June to 10 August" ranks exactly the
   * three months it can actually contain.
   */
  const onlyMonths =
    input.months.length > 0
      ? input.months
      : input.season
        ? [...seasonMonths(input.season, centre.lat)]
        : input.earliest && input.latest
          ? monthsBetween(input.earliest, input.latest)
          : [];

  const guidance = recommendDateWindows({
    profile,
    nights: input.nights,
    onlyMonths,
    year: now.getUTCFullYear(),
    limit: 3,
    now,
  });
  if (guidance.kind !== 'recommended' || guidance.windows.length === 0) {
    return { ok: false, note: guidance.kind === 'unavailable' ? guidance.note : 'We could not compare this destination’s seasons.' };
  }

  const bounds = { ...(input.earliest ? { earliest: input.earliest } : {}), ...(input.latest ? { latest: input.latest } : {}) };
  const placed = guidance.windows
    .map((window, index) => {
      const spot = concreteWindow({ windows: guidance.windows, choose: index, nights: input.nights, ...bounds });
      return spot ? view(window, spot) : null;
    })
    .filter((entryView): entryView is TimingWindowView => entryView !== null);

  const pick = placed[0];
  if (!pick) return { ok: false, note: 'We could not place a window on the calendar for this destination.' };

  return {
    ok: true,
    pick,
    alternatives: placed.slice(1),
    unknowns: [...(climate.note ? [climate.note] : []), ...guidance.windows[0]!.unknowns],
    attribution: climate.sampled > 1 ? `${guidance.attribution}, read at ${climate.sampled} points across the destination` : guidance.attribution,
    sampleYears: `${guidance.sampleYearFrom}–${guidance.sampleYearTo}`,
    sampledPoints: climate.sampled,
    regionalNote: climate.note,
  };
}
