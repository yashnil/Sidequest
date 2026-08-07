import { z } from 'zod';
import { coordinatesSchema, httpUrlSchema } from './common';

/**
 * A PHOTOGRAPH SOMEBODY ELSE OWNS, ON A PAGE WE ARE SELLING.
 *
 * Every other durable artifact in this product is built from data whose licence
 * was read before a byte of it was stored. Imagery is the same obligation with a
 * sharper edge: a place record used without attribution is a compliance failure
 * nobody outside the company would notice, and a photograph used without
 * attribution is one the photographer notices personally.
 *
 * So an image is not a URL. It is a **record** — the file, the subject it is
 * claimed to depict, the basis for that claim, the licence, the creator, the
 * exact words that discharge the attribution obligation, the canonical page a
 * reader can check it against, and the moment we looked. A component that
 * receives one has everything it needs to render a lawful credit; a component
 * that receives a bare URL has to remember, and remembering is what fails.
 *
 * ---
 *
 * THREE RULES THAT DECIDE THE SHAPE BELOW.
 *
 * **1. Rejections are records too.** A file refused for its licence is worth
 * storing with its reason. Without it every rebuild re-fetches, re-checks and
 * re-refuses the same file — which is both a waste of somebody else's volunteer
 * bandwidth and a guarantee that the refusal is invisible to anybody debugging
 * why a destination has no picture.
 *
 * **2. Markup never crosses the adapter boundary.** The upstream `extmetadata`
 * fields are HTML, from a wiki anyone on earth can edit. A live `Artist` value
 * is an `<a rel="nofollow" …>` element wrapping a name. This repository has zero
 * `dangerouslySetInnerHTML` and this schema is a large part of why it can stay
 * that way: `creator` is a plain string and `creatorUrl` is an `httpUrlSchema`,
 * and the parse that produces them happens at ingestion, once, in one place.
 *
 * **3. ShareAlike attaches to cropping, not to display.** CC BY-SA 4.0 §1(a)
 * defines Adapted Material as material "modified in a manner requiring
 * permission", and §3(b) fires ShareAlike only on sharing an adaptation.
 * Displaying an unmodified photograph beside our own prose is a collection.
 * Cropping it to a wide hero, grading it, or laying a scrim over it for text
 * legibility is an adaptation — and that is exactly what a travel UI does by
 * default. Hence `useTier`, and hence the fact that the crop-capable surface
 * takes a *different type*: see `CroppableImage` below. A comment saying "do not
 * crop share-alike images" would be obeyed until the week somebody was busy.
 */

export const IMAGERY_RECORD_VERSION = 1 as const;

/**
 * The provider contract this record was produced under.
 *
 * Stored on every row rather than assumed, because the resolution ladder — which
 * property is preferred, which host is approved, which licence strings are
 * accepted — is the thing most likely to change, and a stored record produced
 * under the old ladder must be identifiable as such rather than silently trusted.
 */
export const IMAGERY_CONTRACT_VERSION = 'wikimedia-commons/v1' as const;

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * THE ALLOW-LIST. Nothing outside it is ever displayed.
 *
 * An allow-list rather than a block-list, and the difference is the whole
 * design: a block-list that has not heard of a licence lets it through, and the
 * licences it has not heard of are exactly the unusual ones worth worrying
 * about. An unrecognised string here is a refusal.
 *
 * What is deliberately absent, and why:
 *
 * - **Anything NonCommercial.** Sidequest is a commercial product. There is no
 *   reading of `-NC-` under which a paid travel planner is the permitted use.
 * - **Anything NoDerivatives.** A hero crop is a derivative. `-ND-` would mean
 *   an image that may be displayed at exactly one aspect ratio forever, which is
 *   a rule no layout will keep.
 * - **Fair-use and "non-free" files.** They exist on some Wikimedia projects
 *   under an exemption doctrine that belongs to those projects and not to us.
 */
export const IMAGE_LICENCE_IDS = [
  'CC0-1.0',
  'public-domain',
  'CC-PDM-1.0',
  'CC-BY-2.0',
  'CC-BY-2.5',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC-BY-SA-2.0',
  'CC-BY-SA-3.0',
  'CC-BY-SA-4.0',
] as const;
export const imageLicenceIdSchema = z.enum(IMAGE_LICENCE_IDS);
export type ImageLicenceId = z.infer<typeof imageLicenceIdSchema>;

/**
 * How a licence may be used, expressed as the only two things a surface can do.
 *
 * `modifiable` — the licence permits adaptation, so a surface may crop, grade,
 * scrim or composite. Public domain and plain CC BY.
 *
 * `display_unmodified` — the licence permits display but attaches a reciprocal
 * obligation to any adaptation we publish. Share-alike. The image may be
 * rescaled (rescaling is not an adaptation) and may not be cropped.
 */
export const IMAGE_USE_TIERS = ['modifiable', 'display_unmodified'] as const;
export const imageUseTierSchema = z.enum(IMAGE_USE_TIERS);
export type ImageUseTier = z.infer<typeof imageUseTierSchema>;

export interface ImageLicenceTerms {
  id: ImageLicenceId;
  name: string;
  url?: string;
  /**
   * Whether the licence obliges us to name the creator.
   *
   * True even for the public-domain entries, and that is a product decision
   * rather than a legal one: crediting a photographer who could not compel it
   * costs one line of small text and is the behaviour we would want from
   * somebody using our work.
   */
  attributionRequired: boolean;
  shareAlike: boolean;
  useTier: ImageUseTier;
}

export const IMAGE_LICENCES: Record<ImageLicenceId, ImageLicenceTerms> = {
  'CC0-1.0': {
    id: 'CC0-1.0',
    name: 'CC0 1.0 Universal',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attributionRequired: true,
    shareAlike: false,
    useTier: 'modifiable',
  },
  'public-domain': {
    id: 'public-domain',
    name: 'Public domain',
    attributionRequired: true,
    shareAlike: false,
    useTier: 'modifiable',
  },
  'CC-PDM-1.0': {
    id: 'CC-PDM-1.0',
    name: 'Public Domain Mark 1.0',
    url: 'https://creativecommons.org/publicdomain/mark/1.0/',
    attributionRequired: true,
    shareAlike: false,
    useTier: 'modifiable',
  },
  'CC-BY-2.0': {
    id: 'CC-BY-2.0',
    name: 'Creative Commons Attribution 2.0',
    url: 'https://creativecommons.org/licenses/by/2.0/',
    attributionRequired: true,
    shareAlike: false,
    useTier: 'modifiable',
  },
  'CC-BY-2.5': {
    id: 'CC-BY-2.5',
    name: 'Creative Commons Attribution 2.5',
    url: 'https://creativecommons.org/licenses/by/2.5/',
    attributionRequired: true,
    shareAlike: false,
    useTier: 'modifiable',
  },
  'CC-BY-3.0': {
    id: 'CC-BY-3.0',
    name: 'Creative Commons Attribution 3.0',
    url: 'https://creativecommons.org/licenses/by/3.0/',
    attributionRequired: true,
    shareAlike: false,
    useTier: 'modifiable',
  },
  'CC-BY-4.0': {
    id: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attributionRequired: true,
    shareAlike: false,
    useTier: 'modifiable',
  },
  'CC-BY-SA-2.0': {
    id: 'CC-BY-SA-2.0',
    name: 'Creative Commons Attribution-ShareAlike 2.0',
    url: 'https://creativecommons.org/licenses/by-sa/2.0/',
    attributionRequired: true,
    shareAlike: true,
    useTier: 'display_unmodified',
  },
  'CC-BY-SA-3.0': {
    id: 'CC-BY-SA-3.0',
    name: 'Creative Commons Attribution-ShareAlike 3.0',
    url: 'https://creativecommons.org/licenses/by-sa/3.0/',
    attributionRequired: true,
    shareAlike: true,
    useTier: 'display_unmodified',
  },
  'CC-BY-SA-4.0': {
    id: 'CC-BY-SA-4.0',
    name: 'Creative Commons Attribution-ShareAlike 4.0',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    attributionRequired: true,
    shareAlike: true,
    useTier: 'display_unmodified',
  },
};

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/**
 * What an image is claimed to be a picture of.
 *
 * A *stable identity*, never a search phrase. This distinction is the one that
 * keeps step (d) of the resolution ladder honest: a bounded search against
 * whatever the traveller typed is a free-text query dressed as a lookup, and it
 * is how a product ends up illustrating one town with a photograph of a
 * different town that shares its name. What may be searched is an identity the
 * index already holds and can be checked against — never a sentence a person
 * wrote, and never a name a model produced.
 */
export const IMAGE_SUBJECT_KINDS = ['destination', 'candidate'] as const;
export const imageSubjectKindSchema = z.enum(IMAGE_SUBJECT_KINDS);
export type ImageSubjectKind = z.infer<typeof imageSubjectKindSchema>;

export const imageSubjectSchema = z.object({
  kind: imageSubjectKindSchema,
  /** Our own identifier: a destination index entry id, or a place id. */
  id: z.string().min(1),
  /** The name the identity is published under. Used for checking, never as a query on its own. */
  name: z.string().min(1),
  /** The strongest identity we hold. Its presence is what makes step (a) possible at all. */
  wikidataId: z
    .string()
    .regex(/^Q\d+$/)
    .optional(),
  /** Where it is, when we know. Feeds the coordinate-derived fallback. */
  coordinates: coordinatesSchema.optional(),
  /** Coarse-to-fine administrative names, used to disambiguate a same-name result. */
  hierarchy: z.array(z.string().min(1)).default([]),
});
export type ImageSubject = z.infer<typeof imageSubjectSchema>;

/**
 * A stable key for the subject, so two trips to one place share one lookup.
 *
 * Traveller-independent by construction — a photograph of a mountain is a
 * photograph of a mountain, and there is nothing about who is going that could
 * change which file depicts it. This key is the reason `destination_images` is
 * not keyed on a trip and does not cascade from one.
 */
export function imagerySubjectKey(
  subject: Pick<ImageSubject, 'kind' | 'id' | 'wikidataId'>,
): string {
  /*
   * The Wikidata id when there is one: it survives a reindex that renumbers our
   * own entry ids, so rebuilding the destination index does not orphan every
   * stored image and pay for the whole set again.
   */
  const identity = subject.wikidataId ?? subject.id;
  return `${subject.kind}:${identity}`;
}

// ---------------------------------------------------------------------------
// The basis for believing the picture is of the place
// ---------------------------------------------------------------------------

/**
 * WHY WE BELIEVE THIS FILE DEPICTS THIS SUBJECT, in descending strength.
 *
 * This is the field that stops the whole feature being a lie. Every one of these
 * is a *checkable relationship between two identifiers*; none of them is "the
 * names looked similar", and none of them is "a model picked it". Both of those
 * appear below as rejection reasons rather than as bases, which is the only
 * arrangement that makes the weak case unrepresentable rather than discouraged.
 */
export const SUBJECT_MATCH_BASES = [
  /** The entity itself states this file as its image. The strongest claim available. */
  'wikidata_image_property',
  /** The entity's own linked encyclopedia article leads with this image. */
  'linked_wikimedia_identity',
  /** The entity states a media category, and the file is filed directly in it. */
  'verified_commons_category',
  /** A bounded lookup against a stable identity we already held, corroborated by hierarchy. */
  'bounded_identity_search',
] as const;
export const subjectMatchBasisSchema = z.enum(SUBJECT_MATCH_BASES);
export type SubjectMatchBasis = z.infer<typeof subjectMatchBasisSchema>;

/**
 * How much weight a surface may put on the match.
 *
 * Three categories rather than a number, for the same reason the shortlist shows
 * bands: the inputs do not support a percentage, and a percentage invites a
 * comparison nobody should make. What a surface actually needs to decide is
 * whether to put the picture in a hero, beside a card, or nowhere — and that is
 * three answers.
 */
export const SUBJECT_CONFIDENCES = ['strong', 'moderate', 'weak'] as const;
export const subjectConfidenceSchema = z.enum(SUBJECT_CONFIDENCES);
export type SubjectConfidence = z.infer<typeof subjectConfidenceSchema>;

export const SUBJECT_CONFIDENCE_OF: Record<SubjectMatchBasis, SubjectConfidence> = {
  wikidata_image_property: 'strong',
  linked_wikimedia_identity: 'strong',
  /**
   * A category is a statement about a *group*. "Files about X" reliably contains
   * pictures of X, and also contains its 1904 street plan, a portrait of its
   * founder and a close-up of a plaque. Good enough to sit beside a name, not
   * good enough to headline a page.
   */
  verified_commons_category: 'moderate',
  bounded_identity_search: 'weak',
};

export const SUBJECT_MATCH_BASIS_LABELS: Record<SubjectMatchBasis, string> = {
  wikidata_image_property: 'the place’s own record names this photograph',
  linked_wikimedia_identity: 'the linked encyclopedia article leads with this photograph',
  verified_commons_category: 'filed in the media category the place’s record points at',
  bounded_identity_search: 'matched from an identifier we already held',
};

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

/**
 * EVERY WAY A FILE CAN FAIL, AS A CLOSED SET.
 *
 * Closed because a free-text reason is a reason nobody can count, and the first
 * question anybody asks of this feature is "why does that destination have no
 * picture". A rejection stored with one of these answers it; a rejection stored
 * with `"error"` does not.
 */
export const IMAGE_REJECTION_REASONS = [
  /** No licence field at all, or one we do not recognise. Never displayed. */
  'missing_licence',
  /** A licence we recognise and refuse: NonCommercial, NoDerivatives, non-free, restricted. */
  'unsupported_licence',
  /** A licence that permits use, arriving without a creator we could name. */
  'incomplete_attribution',
  /** Not https, credentials embedded, or otherwise not a plain image link. */
  'unsafe_url',
  /** Points inside a private or link-local range. An SSRF attempt, or a mirror we must not trust. */
  'private_network_url',
  /** A host outside the approved Wikimedia set — which includes every Google image endpoint. */
  'unapproved_host',
  /** Not a raster image media type we can render. */
  'unsupported_media_type',
  /** SVG. Renderable, scriptable, and not worth the exception. */
  'unsupported_svg',
  /** Script, event handler or embedded markup found in metadata that should have been text. */
  'active_content',
  /** Fields missing, wrongly typed, or too long to be a credit line. */
  'malformed_metadata',
  /** Dimensions absent, non-positive, or too small to be anything but an icon. */
  'invalid_dimensions',
  /** More than one equally plausible subject shares this name. Better nothing than the wrong town. */
  'ambiguous_subject',
  /** The only thing linking file to subject was that the names looked alike. */
  'weak_name_match',
  /** A model chose the identity. Never an acceptable basis, at any confidence. */
  'model_selected_identity',
  /** The provider did not answer, or answered with something unparseable. */
  'provider_unavailable',
] as const;
export const imageRejectionReasonSchema = z.enum(IMAGE_REJECTION_REASONS);
export type ImageRejectionReason = z.infer<typeof imageRejectionReasonSchema>;

export const IMAGE_REJECTION_LABELS: Record<ImageRejectionReason, string> = {
  missing_licence: 'no licence was published with the file',
  unsupported_licence: 'the licence does not permit this use',
  incomplete_attribution: 'nobody was named as the creator',
  unsafe_url: 'the file address was not a safe link',
  private_network_url: 'the file address pointed inside a private network',
  unapproved_host: 'the file was not hosted where we accept images from',
  unsupported_media_type: 'the file was not an image we can show',
  unsupported_svg: 'the file was a scalable vector, which we do not accept',
  active_content: 'the description carried markup rather than text',
  malformed_metadata: 'the description could not be read',
  invalid_dimensions: 'the file did not state usable dimensions',
  ambiguous_subject: 'more than one place shares this name',
  weak_name_match: 'only the name matched, which is not enough',
  model_selected_identity: 'the match came from a model rather than from an identifier',
  provider_unavailable: 'the image service did not answer',
};

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * Approved hosts, as data rather than as a regular expression somewhere.
 *
 * Commons' own reuse guidance is explicit that a reuser should check the URL
 * says Commons "and not something else such as en.wikipedia.org", because some
 * projects permit fair use of non-free content under an exemption doctrine that
 * is theirs and not ours. `upload.wikimedia.org` is where accepted file bytes
 * and thumbnails live; `commons.wikimedia.org` is where the file description
 * page a reader can check lives. Nothing else, ever.
 */
export const APPROVED_IMAGE_HOSTS = ['upload.wikimedia.org', 'commons.wikimedia.org'] as const;

/** Media types we will render. Raster only; see `unsupported_svg`. */
export const ACCEPTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Below this, a "photograph" is an icon, and rendering it as a hero is a defect.
 * Chosen against the smallest standard Wikimedia thumbnail width, 330.
 */
export const MIN_IMAGE_EDGE_PX = 320;

/** A credit line longer than this is not a credit line. Caps a hostile `Artist` value. */
export const MAX_ATTRIBUTION_CHARS = 300;

export const destinationImageSchema = z.object({
  schemaVersion: z.literal(IMAGERY_RECORD_VERSION),

  // --- identity of the image itself -------------------------------------
  /** The file's own canonical title, e.g. `File:Something.jpg`. The provider's primary key. */
  fileTitle: z.string().min(1),
  /** The file description page. The link the attribution obligation requires. */
  filePageUrl: httpUrlSchema,
  /**
   * A thumbnail URL **taken from the provider's response**, never constructed.
   *
   * Wikimedia rejects direct requests at non-standard sizes, so a URL we built
   * by string concatenation is a URL that works against a cached file in
   * development and is refused in production. Taking the one the API returned is
   * both correct and free.
   */
  thumbnailUrl: httpUrlSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mediaType: z.enum(ACCEPTED_IMAGE_MEDIA_TYPES),

  // --- identity of what it depicts --------------------------------------
  subject: imageSubjectSchema,
  /** The relationship that produced the match, in the resolver's own vocabulary. */
  matchBasis: subjectMatchBasisSchema,
  subjectConfidence: subjectConfidenceSchema,
  /**
   * The Wikidata/Wikimedia relationship, spelled out.
   *
   * `Q64|P18`, or `Q64|commonswiki:Category:…`. Not decoration: it is what lets
   * somebody check the claim without re-running the resolver, and what makes a
   * wrong picture a traceable mistake rather than a mystery.
   */
  relationship: z.string().min(1),

  // --- the licence and the credit ---------------------------------------
  licenceId: imageLicenceIdSchema,
  licenceName: z.string().min(1),
  licenceUrl: httpUrlSchema.optional(),
  useTier: imageUseTierSchema,
  /** Plain text. Parsed out of upstream HTML at ingestion; never markup. */
  creator: z.string().min(1).max(MAX_ATTRIBUTION_CHARS),
  /** The creator's own page, when the upstream credit linked one and it passed validation. */
  creatorUrl: httpUrlSchema.optional(),
  /**
   * The exact words to render. Data, not copy.
   *
   * Assembled once at ingestion so that every surface discharges the identical
   * obligation. A component that builds its own credit string from the parts is
   * a component that will one day build a different one.
   */
  attributionText: z.string().min(1).max(MAX_ATTRIBUTION_CHARS),

  // --- provenance --------------------------------------------------------
  /** `wikimedia-commons`. One provider today; recorded so a second is distinguishable. */
  provider: z.string().min(1),
  contractVersion: z.string().min(1),
  retrievedAt: z.string().min(1),
});
export type DestinationImage = z.infer<typeof destinationImageSchema>;

/**
 * AN IMAGE A SURFACE IS ALLOWED TO CROP.
 *
 * The ShareAlike rule, as a type. A plain `DestinationImage` is not assignable
 * to this; only a value that has been through `croppable()` is. A hero that
 * crops declares `CroppableImage` in its props, so handing it a share-alike
 * photograph does not compile — which is the difference between a rule and a
 * comment about a rule.
 */
export interface CroppableImage extends DestinationImage {
  useTier: 'modifiable';
}

/** The only way to obtain a `CroppableImage`. Null for share-alike files. */
export function croppable(image: DestinationImage): CroppableImage | null {
  return image.useTier === 'modifiable' ? { ...image, useTier: 'modifiable' } : null;
}

export const rejectedImageSchema = z.object({
  schemaVersion: z.literal(IMAGERY_RECORD_VERSION),
  /** May be absent: a provider that never answered produced no file to name. */
  fileTitle: z.string().min(1).optional(),
  subject: imageSubjectSchema,
  reason: imageRejectionReasonSchema,
  /**
   * What was actually seen, sanitized and capped.
   *
   * The licence string we could not place, the host we refused. Enough to fix
   * the resolver without re-fetching, and never enough to be worth injecting
   * into: it is sanitized on the same path as the creator name, because it comes
   * from the same world-editable field.
   */
  detail: z.string().max(MAX_ATTRIBUTION_CHARS).optional(),
  provider: z.string().min(1),
  contractVersion: z.string().min(1),
  retrievedAt: z.string().min(1),
});
export type RejectedImage = z.infer<typeof rejectedImageSchema>;

// ---------------------------------------------------------------------------
// The deliberate fallback
// ---------------------------------------------------------------------------

/**
 * WHAT IS THERE WHEN THERE IS NO PHOTOGRAPH — which is most of the world.
 *
 * The honest baseline: the great majority of places on earth have no freely
 * licensed photograph whose subject we can verify, and every one of them still
 * has to look like somewhere worth going. A blank rectangle and a broken-image
 * icon are the two outcomes this type exists to make unrepresentable, so the
 * absence of a photograph produces a *designed object* rather than nothing.
 *
 * All three variants are derived from data the record already holds — the
 * coordinates a source published, the cluster structure the compiler computed,
 * the name itself. Nothing here is invented geography, which is what makes it
 * safe to show at a stage where nothing has been verified.
 */
export const IMAGERY_FALLBACK_KINDS = [
  /** Latitude and longitude, drawn as bands and a horizon. For a place with a position. */
  'regional_graphic',
  /** The shape of the trip: how many areas, how spread out. For a scope, not a point. */
  'cluster_graphic',
  /** The name, set large. For a subject with neither position nor structure. */
  'typographic',
] as const;
export const imageryFallbackKindSchema = z.enum(IMAGERY_FALLBACK_KINDS);
export type ImageryFallbackKind = z.infer<typeof imageryFallbackKindSchema>;

export const imageryFallbackSchema = z.object({
  kind: imageryFallbackKindSchema,
  /** The words in the graphic. Always the subject's own name, never a placeholder. */
  label: z.string().min(1),
  /**
   * A deterministic 0–359 hue derived from the subject.
   *
   * Deterministic so that one place is the same colour on the shortlist, on the
   * board and in the hero. A graphic that changed colour between two screens
   * would read as two different places.
   */
  hue: z.number().int().min(0).max(359),
  /** 0–1 positions within the frame, derived from the coordinates when there are any. */
  horizon: z.number().min(0).max(1),
  drift: z.number().min(0).max(1),
  /** How many marks to draw. For a cluster graphic, the cluster count. */
  marks: z.number().int().min(0).max(12),
  /** The screen-reader equivalent. Never "image", never empty. */
  description: z.string().min(1),
});
export type ImageryFallback = z.infer<typeof imageryFallbackSchema>;

/**
 * What the fallback is built from.
 *
 * A structural subset of `ImageSubject` plus the one thing a subject does not
 * carry — how many areas a scope covers. Typed separately rather than taking the
 * whole subject, because the fallback is also drawn for things that are not
 * image subjects at all: a compilation scope has clusters and a name and no
 * Wikidata id, and forcing it to pretend to be one would be a lie in the type
 * system to save a field.
 */
export interface ImagerySubjectFallbackInput {
  kind: ImageSubjectKind | 'scope';
  id: string;
  name: string;
  coordinates?: { lat: number; lng: number };
  /** Two or more produces the cluster graphic instead of the regional one. */
  clusterCount?: number;
}

// ---------------------------------------------------------------------------
// What a resolution produced
// ---------------------------------------------------------------------------

/**
 * The result of asking for a picture: one accepted file, or one refusal.
 *
 * A discriminated union rather than `DestinationImage | null`, because "we
 * looked and found nothing licensable" and "nobody has looked yet" are different
 * facts with different consequences — the first should not be retried for
 * months, and the second should be tried at the first opportunity.
 */
export const imageryOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), image: destinationImageSchema }),
  z.object({ status: z.literal('rejected'), rejection: rejectedImageSchema }),
]);
export type ImageryOutcome = z.infer<typeof imageryOutcomeSchema>;

/**
 * How long an accepted record may be trusted before its licence is checked again.
 *
 * A compliance control rather than a performance one. Wikimedia's guidance
 * encourages caching and states no maximum; what it does not promise is that a
 * file stays licensed the way it was — files are deleted as copyright
 * violations after the fact, sometimes years after. Thirty days bounds how long
 * we could be displaying one of those.
 */
export const IMAGERY_REVALIDATE_DAYS = 30;

/**
 * How long a refusal stands before it is worth asking again.
 *
 * Longer than an acceptance, deliberately. A licence does not usually become
 * acceptable, and the point of storing the refusal was to stop paying for it
 * repeatedly. Ninety days is roughly "once a quarter, somebody may have uploaded
 * a better photograph of this place", which is about the right rate.
 */
export const IMAGERY_RETRY_REJECTED_DAYS = 90;
