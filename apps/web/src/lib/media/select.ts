import { z } from 'zod';
import {
  destinationImageSchema,
  evaluateImageCandidate,
  IMAGERY_CONTRACT_VERSION,
  type ImageSubject,
  type RawLicenceMetadata,
  type SubjectMatchBasis,
} from '@sidequest/core';
import {
  CENTRE,
  COMMONS_STANDARD_WIDTHS,
  cropLoss,
  MEDIA_CONTEXT_SPECS,
  MEDIA_CONTEXTS,
  srcsetWidthsFor,
  standardWidthAtMost,
  type FocalPoint,
  type MediaContext,
} from './frame';

/**
 * CHOOSING THE PHOTOGRAPH FOR ONE FRAME — PURE, AND ONLY FROM FILES TIED TO THE PLACE.
 *
 * The thin fetcher (`resolve.ts`) collects candidate files and hands them here
 * with how each one is tied to the Wikidata item. This module decides, per
 * visual context, which one (if any) is shown. No network, no clock, no
 * environment — so the decision can be tested against recorded answers.
 *
 * WRONG-SUBJECT PROTECTION IS STRUCTURAL. A candidate exists only if the item
 * states the file (P18 image, P948 Wikivoyage banner, P8592 aerial view) or the
 * file's own structured data states it depicts the item (P180). There is no
 * free-text search anywhere on this path, because a search returns "a picture
 * of something with this name", and a photograph of the wrong place is worse
 * than no photograph.
 *
 * TWO GATES, IN ORDER:
 *
 *  1. The licence and safety gate every photograph in the product already goes
 *     through (`evaluateImageCandidate` in `@sidequest/core`): allow-listed
 *     licence, nameable creator, Commons host, raster type, sanitised text.
 *     Not reimplemented here — a second opinion of what "licensed" means is how
 *     an allow-list quietly widens.
 *  2. The visual gate below, which is new: JPEG only, not a map or a flag or a
 *     painting, big enough for the frame, and the right shape for it.
 *
 * Survivors are ranked; the best one per context wins. Every refusal is kept
 * with its reason so "why does this place have no picture" has an answer.
 */

export const MEDIA_SOURCES = ['P18', 'P948', 'P8592', 'P180'] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

export const MEDIA_SOURCE_LABELS: Record<MediaSource, string> = {
  P18: 'the place’s own record names this photograph',
  P948: 'the place’s travel-guide banner',
  P8592: 'the place’s own record names this aerial view',
  P180: 'the photograph’s own record says it depicts this place',
};

/** One file the fetcher found, before any judgement. */
export interface MediaCandidate {
  fileTitle: string;
  source: MediaSource;
  /** Position in the source's own listing (0 = first). Breaks ties towards the editors' order. */
  order: number;
  filePageUrl: string;
  /** The original file's URL. */
  originalUrl: string;
  /** A thumbnail URL the API returned (any standard width), from which other standard widths are derived. */
  thumbUrl: string | null;
  /** The ORIGINAL file's dimensions. */
  width: number;
  height: number;
  mediaType: string;
  metadata: RawLicenceMetadata;
  /** The file's Commons categories, for the map/flag/diagram screen. */
  categories: readonly string[];
  /** Where the file says it was taken (camera or object location), when it says. */
  coordinates: readonly { lat: number; lng: number }[];
}

export interface MediaSubject {
  wikidataId: string;
  name: string;
  /** A region is better served by an aerial view than a town is. */
  scale?: 'region' | 'place';
  /** The place's centre and extent, for the location cross-check. */
  center?: { lat: number; lng: number };
  radiusKm?: number;
}

export const MEDIA_REJECTION_REASONS = [
  /** The licence/safety gate refused it; `detail` carries that gate's reason. */
  'licence_gate',
  'not_jpeg',
  /** A map, diagram, flag, coat of arms, logo, plan, chart, seal, painting… — not a photograph of the place. */
  'not_a_photograph',
  /** The original is too small for this frame; showing it would mean upscaling. */
  'too_small',
  /** The original is the wrong shape for this frame (a portrait in a hero, a 7:1 banner in a card). */
  'wrong_shape',
  /** The file says it was taken somewhere outside the place's extent. */
  'outside_place',
  /** A depicts-only tie with no location and no mention of the place to corroborate it. */
  'unverified_location',
] as const;
export type MediaRejectionReason = (typeof MEDIA_REJECTION_REASONS)[number];

export const MEDIA_NONE_REASONS = [
  /** The place has no Wikidata item, so nothing can be tied to it. */
  'no_identity',
  /** The item names no image and no file says it depicts the item. */
  'no_candidates',
  /** Files exist, and every one failed a gate for this frame. */
  'all_rejected',
  /** The image service did not answer. Never stored. */
  'provider_unavailable',
  /** Imagery is switched off for this deployment. */
  'disabled',
] as const;
export type MediaNoneReason = (typeof MEDIA_NONE_REASONS)[number];

const focalSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const mediaSelectionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('selected'),
    version: z.literal(1),
    context: z.enum(MEDIA_CONTEXTS),
    wikidataId: z.string(),
    /**
     * The licence record, exactly as the shared gate minted it. `thumbnailUrl`
     * is the default `src` for this context and `width`/`height` are that
     * rendition's size.
     */
    image: destinationImageSchema,
    origin: z.enum(MEDIA_SOURCES),
    original: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    /** Standard-width renditions for `srcset`, ascending, none wider than the original. */
    sources: z.array(z.object({ width: z.number().int().positive(), url: z.string().url() })).min(1),
    focal: focalSchema,
    /** `attention` = found by sharp's saliency crop; `centre` = assumed, nothing was measured. */
    focalBasis: z.enum(['attention', 'centre']),
    /** Share-alike: shown whole in print (no crop); on screen a CSS crop of the unmodified file. */
    shareAlike: z.boolean(),
    score: z.number(),
    rejected: z.array(z.object({ fileTitle: z.string(), reason: z.enum(MEDIA_REJECTION_REASONS), detail: z.string().optional() })).max(16),
  }),
  z.object({
    status: z.literal('none'),
    version: z.literal(1),
    context: z.enum(MEDIA_CONTEXTS),
    wikidataId: z.string().nullable(),
    reason: z.enum(MEDIA_NONE_REASONS),
    rejected: z.array(z.object({ fileTitle: z.string(), reason: z.enum(MEDIA_REJECTION_REASONS), detail: z.string().optional() })).max(16),
  }),
]);
export type MediaSelection = z.infer<typeof mediaSelectionSchema>;
export type SelectedMedia = Extract<MediaSelection, { status: 'selected' }>;

export interface MediaRejection {
  fileTitle: string;
  reason: MediaRejectionReason;
  detail?: string;
}

// ---------------------------------------------------------------------------
// The visual gate
// ---------------------------------------------------------------------------

/**
 * Words Commons uses for things that are not photographs of a place.
 *
 * Matched as whole words (and plurals) against the file title and its
 * categories. "plan" will not match "planet" or "plantation"; "map" will not
 * match a surname. Maintenance categories ("Files with coordinates…", "Pages
 * with…") are skipped, because they describe the file page, not the picture.
 */
const NOT_A_PHOTOGRAPH =
  /(^|[^\p{L}])(maps?|mapa|carte|karte|diagrams?|flags?|coats? of arms|coat_of_arms|logos?|logotype|wordmarks?|locator|location map|plans?|floor ?plans?|charts?|seals?|stamps?|banknotes?|coins?|posters?|paintings?|drawings?|engravings?|lithographs?|illustrations?|infographics?|information graphics|heraldry|emblems?|icons?|symbols?|screenshots?|postcards?|svg|blazons?|renders?|renderings?|3d models?)([^\p{L}]|$)/iu;

const MAINTENANCE_CATEGORY = /^(pages|files|media|images|photos|uploaded|taken|cc-|self-published|license|licensed|quality images|featured pictures|valued images|pictures of the day|flickr)\b/i;

export function looksLikeNotAPhotograph(fileTitle: string, categories: readonly string[]): string | null {
  const title = fileTitle.replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
  const inTitle = NOT_A_PHOTOGRAPH.exec(title);
  if (inTitle) return `title: ${inTitle[2]}`;
  for (const category of categories) {
    if (MAINTENANCE_CATEGORY.test(category.trim())) continue;
    const hit = NOT_A_PHOTOGRAPH.exec(category);
    if (hit) return `category: ${category}`.slice(0, 120);
  }
  return null;
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const fold = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * IS THIS FILE OF THIS PLACE? THE CROSS-CHECK ON TOP OF THE IDENTIFIER TIE.
 *
 * A depicts statement is only as good as whoever added it, and a live recording
 * for a country item included a lighthouse in another country. So:
 *
 * - any file that states where it was taken must be inside the place's extent
 *   (radius × 1.5 + 25 km), whatever tied it to the item;
 * - a depicts-only file that states no location must at least name the place
 *   in its title or categories. Not a search — the file was already found by
 *   identifier — but a second, independent witness.
 *
 * Files the item itself names (P18, P948, P8592) without a location are the
 * item editors' own choice and are not second-guessed.
 */
export function locationVerdict(candidate: MediaCandidate, subject: MediaSubject): MediaRejection | null {
  if (subject.center && candidate.coordinates.length > 0) {
    const limit = (subject.radiusKm && subject.radiusKm > 0 ? subject.radiusKm : 40) * 1.5 + 25;
    const nearest = Math.min(...candidate.coordinates.map((point) => distanceKm(point, subject.center!)));
    if (nearest > limit) return { fileTitle: candidate.fileTitle, reason: 'outside_place', detail: `${Math.round(nearest)} km from the place's centre` };
    return null;
  }
  if (candidate.source !== 'P180') return null;
  const name = fold(subject.name);
  if (!name) return { fileTitle: candidate.fileTitle, reason: 'unverified_location' };
  const haystack = ` ${fold([candidate.fileTitle, ...candidate.categories].join(' | '))} `;
  if (haystack.includes(` ${name} `)) return null;
  return { fileTitle: candidate.fileTitle, reason: 'unverified_location', detail: 'no location, and the place is not named' };
}

/** Why this file cannot fill this frame, or null when it can. */
export function visualVerdict(candidate: MediaCandidate, context: MediaContext): MediaRejection | null {
  const spec = MEDIA_CONTEXT_SPECS[context];
  const mime = candidate.mediaType.trim().toLowerCase().split(';')[0];
  /* "It is a flag map" is a more useful thing to have written down than "it is a PNG". */
  const symbol = looksLikeNotAPhotograph(candidate.fileTitle, candidate.categories);
  if (symbol) return { fileTitle: candidate.fileTitle, reason: 'not_a_photograph', detail: symbol };
  if (mime !== 'image/jpeg') return { fileTitle: candidate.fileTitle, reason: 'not_jpeg', detail: mime || 'none' };
  const { width, height } = candidate;
  if (!(width > 0) || !(height > 0)) return { fileTitle: candidate.fileTitle, reason: 'too_small', detail: `${width}x${height}` };
  const aspect = width / height;
  if (aspect < spec.sourceAspect[0] || aspect > spec.sourceAspect[1]) {
    return { fileTitle: candidate.fileTitle, reason: 'wrong_shape', detail: `${width}x${height}` };
  }
  if (width < spec.minSourceWidth || Math.min(width, height) < spec.minSourceShortEdge) {
    return { fileTitle: candidate.fileTitle, reason: 'too_small', detail: `${width}x${height}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// URLs at standard widths
// ---------------------------------------------------------------------------

const COMMONS_THUMB = /^(https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/thumb\/[^?#]+\/)(\d+)px-([^/?#]+)$/;

/**
 * The URL of this file at a standard width.
 *
 * Derived only by rewriting the width segment of a thumbnail URL the API
 * itself returned (the pattern `commons-thumbnail.ts` already relies on), and
 * only to a width on the standard list. A request at or above the original
 * width is the original, because Wikimedia does not render a thumbnail wider
 * than its source.
 */
export function renditionUrl(candidate: Pick<MediaCandidate, 'originalUrl' | 'thumbUrl' | 'width'>, width: number): string | null {
  if (!COMMONS_STANDARD_WIDTHS.includes(width as (typeof COMMONS_STANDARD_WIDTHS)[number])) return null;
  if (width >= candidate.width) return candidate.originalUrl;
  const match = candidate.thumbUrl ? COMMONS_THUMB.exec(candidate.thumbUrl) : null;
  if (!match) return null;
  return `${match[1]}${width}px-${match[3]}`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * How much each relationship is worth in each frame.
 *
 * The item's own image (P18) is the editors' choice for "what this place looks
 * like" and leads everywhere except the strip, where the travel wiki's banner
 * was cut for exactly that shape. An aerial view is the better hero for a
 * region than for a town. A depicts statement is a real tie, but a weaker
 * editorial signal than the item choosing the file itself.
 */
const SOURCE_WEIGHT: Record<MediaContext, Record<MediaSource, number>> = {
  hero: { P18: 0.3, P8592: 0.28, P180: 0.18, P948: 0.1 },
  card: { P18: 0.3, P8592: 0.24, P180: 0.18, P948: 0.05 },
  thumb: { P18: 0.3, P8592: 0.18, P180: 0.18, P948: 0.02 },
  strip: { P948: 0.4, P18: 0.24, P8592: 0.24, P180: 0.14 },
};

export function rankScore(candidate: MediaCandidate, context: MediaContext, subject: MediaSubject, modifiable: boolean): number {
  const spec = MEDIA_CONTEXT_SPECS[context];
  const source = SOURCE_WEIGHT[context][candidate.source] + (candidate.source === 'P8592' && subject.scale === 'region' ? 0.06 : 0);
  const resolution = Math.min(1, candidate.width / (spec.minSourceWidth * 2)) * 0.2;
  const shape = (1 - cropLoss(candidate.width / candidate.height, spec.aspect)) * 0.3;
  const licence = modifiable ? 0.04 : 0;
  const order = Math.max(0, 0.03 - candidate.order * 0.005);
  return Math.round((source + resolution + shape + licence + order) * 1000) / 1000;
}

const BASIS_OF: Record<MediaSource, SubjectMatchBasis> = {
  P18: 'wikidata_image_property',
  P948: 'wikidata_image_property',
  P8592: 'wikidata_image_property',
  /*
   * A depicts statement on the file is "a bounded lookup against a stable
   * identity we already held" — the identity is the QID itself, never a name.
   */
  P180: 'bounded_identity_search',
};

export interface SelectOptions {
  /** Injected so the record's `retrievedAt` is a decision rather than a side effect. */
  retrievedAt: string;
  provider: string;
}

/**
 * The best file for one frame, or a typed "none" with every refusal.
 */
export function selectMedia(
  subject: MediaSubject,
  candidates: readonly MediaCandidate[],
  context: MediaContext,
  options: SelectOptions,
): MediaSelection {
  const rejected: MediaRejection[] = [];
  const none = (reason: MediaNoneReason): MediaSelection => ({
    status: 'none',
    version: 1,
    context,
    wikidataId: subject.wikidataId || null,
    reason,
    rejected: rejected.slice(0, 16),
  });
  if (!/^Q\d+$/.test(subject.wikidataId)) return none('no_identity');
  if (candidates.length === 0) return none('no_candidates');

  const imageSubject: ImageSubject = {
    kind: 'destination',
    id: `media:${subject.wikidataId}`,
    name: subject.name,
    wikidataId: subject.wikidataId,
    hierarchy: [],
  };

  let best: SelectedMedia | null = null;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.fileTitle)) continue;
    seen.add(candidate.fileTitle);

    const visual = locationVerdict(candidate, subject) ?? visualVerdict(candidate, context);
    if (visual) {
      rejected.push(visual);
      continue;
    }

    const widths = srcsetWidthsFor(context, candidate.width);
    const sources = widths
      .map((width) => ({ width, url: renditionUrl(candidate, width) }))
      .filter((entry): entry is { width: number; url: string } => entry.url !== null);
    /* A file narrower than every standard width the frame wants still has its original. */
    if (sources.length === 0) {
      const fallbackWidth = standardWidthAtMost(candidate.width);
      const url = fallbackWidth ? renditionUrl(candidate, fallbackWidth) : null;
      if (url && fallbackWidth) sources.push({ width: fallbackWidth >= candidate.width ? candidate.width : fallbackWidth, url });
    }
    const primary = sources[sources.length - 1];
    if (!primary) {
      rejected.push({ fileTitle: candidate.fileTitle, reason: 'too_small', detail: 'no rendition at a standard width' });
      continue;
    }
    const renderedWidth = primary.width >= candidate.width ? candidate.width : primary.width;
    const renderedHeight = Math.max(1, Math.round((renderedWidth * candidate.height) / candidate.width));

    const licence = evaluateImageCandidate(
      imageSubject,
      {
        fileTitle: candidate.fileTitle,
        filePageUrl: candidate.filePageUrl,
        thumbnailUrl: primary.url,
        width: renderedWidth,
        height: renderedHeight,
        mediaType: candidate.mediaType,
        metadata: candidate.metadata,
        match: {
          basis: BASIS_OF[candidate.source],
          relationship: `${subject.wikidataId}|${candidate.source === 'P180' ? 'commons-depicts' : candidate.source}`,
        },
      },
      { provider: options.provider, contractVersion: IMAGERY_CONTRACT_VERSION, retrievedAt: options.retrievedAt },
    );
    if (licence.status === 'rejected') {
      rejected.push({
        fileTitle: candidate.fileTitle,
        reason: 'licence_gate',
        detail: `${licence.rejection.reason}${licence.rejection.detail ? `: ${licence.rejection.detail}` : ''}`.slice(0, 200),
      });
      continue;
    }

    const modifiable = licence.image.useTier === 'modifiable';
    const score = rankScore(candidate, context, subject, modifiable);
    if (best && (score < best.score || (score === best.score && candidate.fileTitle >= best.image.fileTitle))) continue;
    best = {
      status: 'selected',
      version: 1,
      context,
      wikidataId: subject.wikidataId,
      image: licence.image,
      origin: candidate.source,
      original: { width: candidate.width, height: candidate.height },
      sources: sources.map((entry) => ({ width: entry.width >= candidate.width ? candidate.width : entry.width, url: entry.url })),
      focal: CENTRE,
      focalBasis: 'centre',
      shareAlike: !modifiable,
      score,
      rejected: [],
    };
  }

  if (!best) return none('all_rejected');
  return { ...best, rejected: rejected.slice(0, 16) };
}

/** All four contexts from one candidate pool — one set of lookups serves every frame. */
export function selectAllContexts(
  subject: MediaSubject,
  candidates: readonly MediaCandidate[],
  options: SelectOptions,
): Record<MediaContext, MediaSelection> {
  return Object.fromEntries(MEDIA_CONTEXTS.map((context) => [context, selectMedia(subject, candidates, context, options)])) as Record<MediaContext, MediaSelection>;
}

/** Attach a measured focal point to a selection. */
export function withFocal(selection: MediaSelection, focal: FocalPoint | null): MediaSelection {
  if (selection.status !== 'selected' || !focal) return selection;
  return { ...selection, focal: { x: clamp(focal.x), y: clamp(focal.y) }, focalBasis: 'attention' };
}

const clamp = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);

/** One line for a credit: "Author · CC BY-SA 4.0". The full record stays on `image.attributionText`. */
export function creditLine(image: { creator: string; licenceName: string }): string {
  return `${image.creator} · ${shortLicence(image.licenceName)}`;
}

export function shortLicence(name: string): string {
  return name
    .replace(/Creative Commons Attribution-ShareAlike\s*/i, 'CC BY-SA ')
    .replace(/Creative Commons Attribution\s*/i, 'CC BY ')
    .replace(/Creative Commons Zero|CC0 1\.0 Universal(?: Public Domain Dedication)?/i, 'CC0')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
