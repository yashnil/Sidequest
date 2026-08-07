import {
  ACCEPTED_IMAGE_MEDIA_TYPES,
  APPROVED_IMAGE_HOSTS,
  IMAGERY_RECORD_VERSION,
  IMAGE_LICENCES,
  MAX_ATTRIBUTION_CHARS,
  MIN_IMAGE_EDGE_PX,
  SUBJECT_CONFIDENCE_OF,
  destinationImageSchema,
  type ImageLicenceId,
  type ImageLicenceTerms,
  type ImageRejectionReason,
  type ImagerySubjectFallbackInput,
  type ImageryFallback,
  type ImageryOutcome,
  type ImageSubject,
  type SubjectMatchBasis,
} from '../schemas/imagery';

/**
 * THE GATE EVERY PHOTOGRAPH HAS TO GET THROUGH, AND NOTHING ELSE.
 *
 * Pure. No fetch, no clock, no environment. The adapter goes and gets bytes of
 * JSON from a wiki; this decides whether any of it may be shown to a paying
 * traveller. Keeping the decision here rather than in the adapter is what makes
 * it testable against an adversarial corpus without a network, and what makes it
 * impossible for a second provider to arrive with its own, laxer opinion of what
 * "licensed" means.
 *
 * ---
 *
 * THE ONE THING THIS FILE IS REALLY FOR.
 *
 * `extmetadata` is **HTML written by anyone on earth**. Not a metaphor: the
 * fields arrive as markup, from a wiki with open registration, and a real
 * `Artist` value in production looks like
 *
 *     <a rel="nofollow" class="external text" href="https://…">A Name</a> from …
 *
 * Every downstream consumer of that string is a React text node today and could
 * be an `href`, a PDF, an alt attribute or an email tomorrow. So the boundary is
 * drawn here and drawn hard: **markup never leaves this module.** What comes out
 * is a plain `creator` string with the tags removed, control and bidi characters
 * stripped, NFKC-normalised and length-capped, plus at most one `creatorUrl`
 * that has been through a scheme and credential check. A value carrying a
 * `<script>` or an event handler is not sanitized and shown — it is *refused*,
 * with `active_content` recorded, because a credit line that needed
 * de-weaponising is a credit line nobody should trust the rest of.
 *
 * This repository has zero `dangerouslySetInnerHTML`. This is the file that lets
 * it stay that way after imagery ships.
 */

// ---------------------------------------------------------------------------
// Text sanitation
// ---------------------------------------------------------------------------

/**
 * Characters that are invisible, reorder what follows them, or terminate a line.
 *
 * Bidi overrides are the interesting ones. `U+202E` (RIGHT-TO-LEFT OVERRIDE) in
 * a credit line renders the text after it backwards, which is how a string that
 * reads as one photographer's name in the database reads as another's on screen.
 * A credit that can be made to say something other than what was stored is not a
 * credit.
 */
// The control characters are the point: this is the class that strips them, so
// the lint that warns about writing one into a pattern has nothing to add here.
// eslint-disable-next-line no-control-regex
const INVISIBLE_OR_BIDI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Markup that is *active* rather than merely present.
 *
 * A `<a>` around a name is ordinary Commons practice and gets parsed. A script
 * element, an inline event handler, a `javascript:` scheme or an embedded frame
 * is somebody trying something, and the answer to somebody trying something is
 * not to clean it up and use it anyway.
 */
const ACTIVE_CONTENT =
  /<\s*(script|iframe|object|embed|svg|img|style|link|meta|form)\b|\bon[a-z]+\s*=|javascript\s*:|data\s*:\s*text\/html|&#x?0*(6a|106);?a?v?a?/i;

/** True when a raw metadata value is trying to do something rather than say something. */
export function containsActiveContent(raw: string): boolean {
  return ACTIVE_CONTENT.test(raw);
}

/**
 * A world-editable string reduced to plain, bounded, renderable text.
 *
 * Returns null when nothing survives, which the callers treat as "the field was
 * not supplied" rather than as an empty string — an empty creator that passes a
 * `.min(1)` check by carrying a space is exactly the kind of thing that makes a
 * schema look like it is holding a line it is not.
 */
export function sanitizeMetadataText(raw: string): string | null {
  const withoutTags = raw.replace(/<[^>]*>/g, ' ');
  const decoded = decodeBasicEntities(withoutTags);
  const normalized = decoded
    .normalize('NFKC')
    .replace(INVISIBLE_OR_BIDI, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_ATTRIBUTION_CHARS);
}

/**
 * Only the five entities that appear in ordinary prose.
 *
 * Deliberately not a general HTML entity decoder: a general decoder turns
 * `&#x3C;script&#x3E;` back into a tag, which would mean this function
 * re-creating the exact thing `containsActiveContent` exists to catch. The
 * numeric forms are left as-is; a credit reading `&#8212;` is ugly and harmless.
 */
function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export interface ParsedCreator {
  creator: string;
  creatorUrl?: string;
}

/**
 * `Artist`, turned into a name and at most one link.
 *
 * The href is taken from the *first* anchor only. A value with six links in it
 * is either a multi-author collaboration, which one line cannot credit properly
 * anyway, or somebody padding the field; in both cases the file page carries the
 * full credit and the link here is a convenience.
 */
export function parseArtist(raw: string): ParsedCreator | null {
  if (containsActiveContent(raw)) return null;

  const creator = sanitizeMetadataText(raw);
  if (!creator) return null;

  const href = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1];
  const creatorUrl = href ? safeExternalUrl(href) : null;
  return creatorUrl ? { creator, creatorUrl } : { creator };
}

/**
 * An http(s) URL with no embedded credentials, or nothing.
 *
 * `http://legit@10.0.0.1/` reads as a link to `legit` and resolves to a private
 * address; the same check `httpUrlSchema` makes, applied before the value is
 * anywhere near a schema, because a creator link that fails validation should
 * cost us the link and not the whole photograph.
 */
function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (isPrivateHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Hosts that are never a source of imagery, named so the refusal is legible.
 *
 * Google's imagery is the case worth naming explicitly. Its terms do not permit
 * caching photo bytes or metadata beyond a narrow window, its attribution is
 * carried by a widget rather than by a string, and it is billable per request —
 * every one of which is incompatible with a stored record. A URL from one of
 * these hosts in an imagery record would mean somebody had wired a second
 * provider without reading its terms, so it is refused by name rather than only
 * by absence from the allow-list.
 */
export const REFUSED_IMAGE_HOST_MARKERS = [
  'google.com',
  'googleapis.com',
  'googleusercontent.com',
  'gstatic.com',
  'ggpht.com',
] as const;

/** Hostnames that are not on the public internet, or that resolve to us. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  // IPv6 loopback, unique-local and link-local.
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local, and the address every cloud metadata service
  // lives on. An imagery URL pointing at it is not a photograph.
  if (a === 169 && b === 254) return true;
  return false;
}

export type UrlVerdict =
  | { ok: true; url: string }
  | { ok: false; reason: 'unsafe_url' | 'private_network_url' | 'unapproved_host'; detail: string };

/**
 * Whether a URL from the provider may be stored and rendered.
 *
 * https only — not because http would not load, but because an image address
 * this product hands to a browser is one an intermediary could replace, and
 * there is no version of Wikimedia that requires plaintext.
 */
export function classifyImageUrl(value: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'unsafe_url', detail: 'not a URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'unsafe_url', detail: url.protocol };
  if (url.username || url.password) {
    return { ok: false, reason: 'unsafe_url', detail: 'embedded credentials' };
  }

  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return { ok: false, reason: 'private_network_url', detail: host };
  if (REFUSED_IMAGE_HOST_MARKERS.some((marker) => host === marker || host.endsWith(`.${marker}`))) {
    return { ok: false, reason: 'unapproved_host', detail: host };
  }
  if (!APPROVED_IMAGE_HOSTS.some((approved) => host === approved)) {
    return { ok: false, reason: 'unapproved_host', detail: host };
  }
  return { ok: true, url: url.toString() };
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * The raw licence fields as the provider published them.
 *
 * Every one is optional and every one is untrusted. `attributionRequired`
 * arrives as the **strings** `"true"`/`"false"` rather than as a boolean, which
 * is why it is typed as a string here — a `Boolean(value)` over it would read
 * `"false"` as true, and the direction of that mistake is "stop attributing".
 */
export interface RawLicenceMetadata {
  licenceShortName?: string;
  licence?: string;
  licenceUrl?: string;
  artist?: string;
  credit?: string;
  attribution?: string;
  attributionRequired?: string;
  restrictions?: string;
  nonFree?: string;
  deletionReason?: string;
}

/**
 * Normalised licence tokens to the ids we accept.
 *
 * Normalisation drops everything that is not a letter, a digit or a dot, so
 * `CC BY-SA 4.0`, `cc-by-sa-4.0` and `CC_BY_SA_4.0` all arrive here as
 * `ccbysa4.0` and one entry covers the three spellings the two fields use
 * between them.
 */
const LICENCE_TOKENS: Record<string, ImageLicenceId> = {
  cc0: 'CC0-1.0',
  'cc01.0': 'CC0-1.0',
  cczero: 'CC0-1.0',
  publicdomain: 'public-domain',
  pd: 'public-domain',
  pdold: 'public-domain',
  pdus: 'public-domain',
  publicdomainmark: 'CC-PDM-1.0',
  'publicdomainmark1.0': 'CC-PDM-1.0',
  pdm: 'CC-PDM-1.0',
  'ccpdm1.0': 'CC-PDM-1.0',
  'ccby2.0': 'CC-BY-2.0',
  'ccby2.5': 'CC-BY-2.5',
  'ccby3.0': 'CC-BY-3.0',
  'ccby4.0': 'CC-BY-4.0',
  'ccbysa2.0': 'CC-BY-SA-2.0',
  'ccbysa3.0': 'CC-BY-SA-3.0',
  'ccbysa4.0': 'CC-BY-SA-4.0',
};

function normalizeLicenceToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]/g, '');
}

/**
 * Licence strings that are recognisable and refused.
 *
 * Checked against the raw string with word boundaries rather than against the
 * normalised token, because `NC` and `ND` are two letters that appear inside
 * ordinary words — normalising first and then searching for `nc` would refuse
 * every licence with "Unported" in its name.
 */
const REFUSED_LICENCE_PATTERNS: readonly RegExp[] = [
  /\bNC\b/i,
  /\bND\b/i,
  /non-?commercial/i,
  /no-?deriv/i,
  /fair\s*use/i,
  /non-?free/i,
  /all\s+rights\s+reserved/i,
];

export type LicenceVerdict =
  | { ok: true; licence: ImageLicenceTerms }
  | { ok: false; reason: 'missing_licence' | 'unsupported_licence'; detail: string };

/**
 * Which licence this file is under, if it is under one we accept.
 *
 * The order of the checks is the design. Hard refusals run **before** the
 * allow-list, so a file that is simultaneously tagged `CC BY-SA 4.0` and
 * `Restrictions: personality` is refused rather than accepted on the strength of
 * the first tag. That combination is not hypothetical: it is what a Commons file
 * of a busy square looks like, and `personality` means the people in it did not
 * consent to appearing in an advertisement — which is precisely what a
 * destination hero on a commercial travel product is.
 */
export function evaluateLicence(metadata: RawLicenceMetadata): LicenceVerdict {
  if (truthyFlag(metadata.nonFree)) {
    return { ok: false, reason: 'unsupported_licence', detail: 'marked non-free' };
  }
  if (metadata.deletionReason && metadata.deletionReason.trim()) {
    return { ok: false, reason: 'unsupported_licence', detail: 'nominated for deletion' };
  }
  /*
   * `Restrictions` is a non-copyright obstacle: trademark, a national cultural
   * goods regime, an Indigenous land agreement, a personality right. Commons
   * hosts these files legitimately and states plainly that the reuser carries
   * the restriction. A travel product that is commercial promotion rather than
   * education does not inherit Wikimedia's position, so any value at all here is
   * a refusal.
   */
  if (metadata.restrictions && metadata.restrictions.trim()) {
    const detail = sanitizeMetadataText(metadata.restrictions) ?? 'restricted';
    return { ok: false, reason: 'unsupported_licence', detail: `restricted: ${detail}` };
  }

  const shortName = metadata.licenceShortName?.trim() ?? '';
  const full = metadata.licence?.trim() ?? '';
  if (!shortName && !full) return { ok: false, reason: 'missing_licence', detail: 'no licence field' };

  for (const pattern of REFUSED_LICENCE_PATTERNS) {
    if (pattern.test(shortName) || pattern.test(full)) {
      const detail = sanitizeMetadataText(shortName || full) ?? 'refused licence';
      return { ok: false, reason: 'unsupported_licence', detail };
    }
  }

  const fromShort = shortName ? LICENCE_TOKENS[normalizeLicenceToken(shortName)] : undefined;
  const fromFull = full ? LICENCE_TOKENS[normalizeLicenceToken(full)] : undefined;

  /*
   * Commons states that for multi-licensed files these two values "are currently
   * unreliable". A file whose two licence fields resolve to different licences
   * is one we cannot say which terms apply to, and the honest answer to that is
   * not to pick the more convenient one.
   */
  if (fromShort && fromFull && fromShort !== fromFull) {
    return { ok: false, reason: 'unsupported_licence', detail: `${fromShort} vs ${fromFull}` };
  }

  const resolved = fromShort ?? fromFull;
  if (!resolved) {
    const detail = sanitizeMetadataText(shortName || full) ?? 'unrecognised';
    return { ok: false, reason: 'unsupported_licence', detail };
  }
  return { ok: true, licence: IMAGE_LICENCES[resolved] };
}

/**
 * `AttributionRequired` as it actually arrives — a string, or nothing.
 *
 * Absent and ambiguous both mean **attribute**. The cost of attributing a file
 * that did not require it is one line of small text; the cost of the opposite is
 * a licence breach.
 */
function truthyFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// The candidate
// ---------------------------------------------------------------------------

/**
 * How the resolver says it linked this file to this subject.
 *
 * The three negative flags are not conveniences — they are the shapes of match
 * that must be *representable and refused* rather than unrepresentable. A
 * resolver that could only ever hand over good matches would have to decide what
 * "good" means, which is this module's job; a resolver that hands over what it
 * found and says how it found it puts the decision in one place.
 */
export interface RawSubjectMatch {
  /** Null when the resolver could not establish a checkable relationship at all. */
  basis: SubjectMatchBasis | null;
  /** `Q64|P18`. Stored on the record so the claim can be checked later. */
  relationship: string;
  /**
   * How many equally plausible **subjects** shared this name. Two or more is fatal.
   *
   * Subjects, not files, and the distinction is load-bearing. A resolver that
   * passed a file count here made a Commons category holding five photographs of
   * one building read as five competing buildings, so the rung that produced it
   * refused nearly everything it found — a failure invisible in production,
   * because a refusal and an absence render identically on a card.
   */
  ambiguousWith?: number;
  /** True when the only link between file and subject was that the names looked alike. */
  nameSimilarityOnly?: boolean;
  /** True when a model produced the identity. Fatal at any confidence. */
  modelSelected?: boolean;
}

export interface RawImageCandidate {
  fileTitle: string;
  filePageUrl: string;
  /** From the provider's response. Never a URL we assembled. */
  thumbnailUrl: string;
  width: number;
  height: number;
  mediaType: string;
  metadata: RawLicenceMetadata;
  match: RawSubjectMatch;
}

export interface GateContext {
  provider: string;
  contractVersion: string;
  /** Injected, so the gate stays pure and two runs of one input agree. */
  retrievedAt: string;
}

function reject(
  subject: ImageSubject,
  context: GateContext,
  reason: ImageRejectionReason,
  detail?: string,
  fileTitle?: string,
): ImageryOutcome {
  return {
    status: 'rejected',
    rejection: {
      schemaVersion: IMAGERY_RECORD_VERSION,
      ...(fileTitle ? { fileTitle } : {}),
      subject,
      reason,
      ...(detail ? { detail: detail.slice(0, MAX_ATTRIBUTION_CHARS) } : {}),
      provider: context.provider,
      contractVersion: context.contractVersion,
      retrievedAt: context.retrievedAt,
    },
  };
}

/**
 * THE WHOLE ACCEPTANCE DECISION, IN ONE PLACE AND IN THIS ORDER.
 *
 * Acceptance requires *all* of: a supported licence, a complete attribution, a
 * safe https URL, an approved Wikimedia host, a raster media type we can render,
 * a credible subject relationship, validated dimensions and sanitized metadata.
 * Any one missing is a refusal with a stored reason.
 *
 * The order matters and is chosen so the recorded reason is the *most useful*
 * one rather than the first one a naive sequence would hit. Subject credibility
 * runs first: a file that has nothing to do with the place is not worth a
 * licence complaint, and "we matched the wrong thing" is the failure a developer
 * needs to see. URL and media type run before licence because a refusal we can
 * act on beats a refusal about a file we could never have rendered anyway.
 */
export function evaluateImageCandidate(
  subject: ImageSubject,
  candidate: RawImageCandidate,
  context: GateContext,
): ImageryOutcome {
  const title = candidate.fileTitle.trim();
  if (!title) return reject(subject, context, 'malformed_metadata', 'no file title');

  // --- 1. is it credibly a picture of this place? ------------------------
  if (candidate.match.modelSelected) {
    return reject(subject, context, 'model_selected_identity', candidate.match.relationship, title);
  }
  if (candidate.match.nameSimilarityOnly || candidate.match.basis === null) {
    return reject(subject, context, 'weak_name_match', candidate.match.relationship, title);
  }
  if ((candidate.match.ambiguousWith ?? 0) >= 2) {
    return reject(
      subject,
      context,
      'ambiguous_subject',
      `${candidate.match.ambiguousWith} candidates share this name`,
      title,
    );
  }
  if (!candidate.match.relationship.trim()) {
    return reject(subject, context, 'malformed_metadata', 'no stated relationship', title);
  }

  // --- 2. can we safely point a browser at it? ---------------------------
  const thumb = classifyImageUrl(candidate.thumbnailUrl);
  if (!thumb.ok) return reject(subject, context, thumb.reason, thumb.detail, title);
  const page = classifyImageUrl(candidate.filePageUrl);
  if (!page.ok) return reject(subject, context, page.reason, page.detail, title);

  // --- 3. is it an image we can render? ----------------------------------
  const mediaType = candidate.mediaType.trim().toLowerCase().split(';')[0] ?? '';
  if (mediaType === 'image/svg+xml' || /\.svgz?($|\?)/i.test(thumb.url)) {
    /*
     * SVG is a scripting host that happens to draw pictures. Wikimedia's own
     * rasteriser exists partly for that reason, and accepting the raster while
     * refusing the vector would mean a URL whose extension decides whether the
     * document is inert. Refusing the whole path is one rule instead of two.
     */
    return reject(subject, context, 'unsupported_svg', mediaType || 'svg', title);
  }
  if (!ACCEPTED_IMAGE_MEDIA_TYPES.some((accepted) => accepted === mediaType)) {
    return reject(subject, context, 'unsupported_media_type', mediaType || 'none', title);
  }

  // --- 4. is the metadata text, or is it trying something? ---------------
  const rawValues = [
    candidate.metadata.artist,
    candidate.metadata.credit,
    candidate.metadata.attribution,
    candidate.metadata.licenceShortName,
    candidate.metadata.licence,
  ];
  for (const value of rawValues) {
    if (value && containsActiveContent(value)) {
      return reject(subject, context, 'active_content', 'markup in a text field', title);
    }
  }

  // --- 5. does the licence permit this use? ------------------------------
  const licence = evaluateLicence(candidate.metadata);
  if (!licence.ok) return reject(subject, context, licence.reason, licence.detail, title);

  // --- 6. can we credit somebody? ----------------------------------------
  const artist = candidate.metadata.artist ? parseArtist(candidate.metadata.artist) : null;
  /*
   * When `Attribution` is present Commons asks that it replace Artist + Credit
   * and be honoured verbatim — verbatim meaning the *words*, which is why it
   * still goes through sanitation: the tags were never part of the words.
   */
  const supplied = candidate.metadata.attribution
    ? sanitizeMetadataText(candidate.metadata.attribution)
    : null;
  const creator = artist?.creator ?? supplied;
  if (!creator) {
    return reject(subject, context, 'incomplete_attribution', 'no artist or attribution', title);
  }

  /*
   * BUDGET THE CREDIT AROUND THE LICENCE NAME, NEVER TRUNCATE THROUGH IT.
   *
   * This used to append the licence name and the source and then `.slice()` the
   * whole line to 300 characters. The free-text half is *already* capped at 300
   * by `sanitizeMetadataText`, so a file with a long institutional `Attribution`
   * — museum, collection, accession, photographer, project, which is an ordinary
   * shape on Commons — pushed the licence name off the end. The page then showed
   * a photograph credited to somebody under no licence at all, and a slightly
   * shorter overflow was worse: the line was cut mid-token and asserted a
   * licence that does not exist ("…, Creative Commons Attribution-Share").
   *
   * So the fixed part is reserved first. A credit that cannot fit beside the
   * licence name is an incomplete attribution, which is a rejection rather than
   * something to shorten.
   */
  const fixed = `, ${licence.licence.name}, Wikimedia Commons`;
  const creditParts = supplied
    ? [supplied]
    : [creator, candidate.metadata.credit ? sanitizeMetadataText(candidate.metadata.credit) : null];
  const credit = creditParts.filter(isPresent).join(', ');
  if (credit.length + fixed.length > MAX_ATTRIBUTION_CHARS) {
    return reject(
      subject,
      context,
      'incomplete_attribution',
      'the credit will not fit beside its licence name',
      title,
    );
  }
  const attributionText = `${credit}${fixed}`;

  // --- 7. are the dimensions real? ---------------------------------------
  if (
    !Number.isFinite(candidate.width) ||
    !Number.isFinite(candidate.height) ||
    !Number.isInteger(candidate.width) ||
    !Number.isInteger(candidate.height) ||
    candidate.width <= 0 ||
    candidate.height <= 0
  ) {
    return reject(subject, context, 'invalid_dimensions', `${candidate.width}x${candidate.height}`, title);
  }
  if (Math.max(candidate.width, candidate.height) < MIN_IMAGE_EDGE_PX) {
    return reject(subject, context, 'invalid_dimensions', `${candidate.width}x${candidate.height}`, title);
  }

  const licenceUrl = licence.licence.url ?? safeExternalUrl(candidate.metadata.licenceUrl ?? '');

  const parsed = destinationImageSchema.safeParse({
    schemaVersion: IMAGERY_RECORD_VERSION,
    fileTitle: title,
    filePageUrl: page.url,
    thumbnailUrl: thumb.url,
    width: candidate.width,
    height: candidate.height,
    mediaType,
    subject,
    matchBasis: candidate.match.basis,
    subjectConfidence: SUBJECT_CONFIDENCE_OF[candidate.match.basis],
    relationship: candidate.match.relationship.trim(),
    licenceId: licence.licence.id,
    licenceName: licence.licence.name,
    ...(licenceUrl ? { licenceUrl } : {}),
    useTier: licence.licence.useTier,
    creator,
    ...(artist?.creatorUrl ? { creatorUrl: artist.creatorUrl } : {}),
    attributionText,
    provider: context.provider,
    contractVersion: context.contractVersion,
    retrievedAt: context.retrievedAt,
  });

  /*
   * The last gate is the schema itself, and it is not decoration. Everything
   * above checks one property at a time; this checks that the assembled record
   * is one the rest of the product can read back out of a database column. A
   * record that only fails here is a bug in this function, and the honest thing
   * to store is a refusal rather than a row nothing can parse.
   */
  if (!parsed.success) {
    return reject(subject, context, 'malformed_metadata', parsed.error.issues[0]?.message, title);
  }
  return { status: 'accepted', image: parsed.data };
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// The deliberate fallback
// ---------------------------------------------------------------------------

/**
 * A stable 32-bit hash. Not cryptographic and not trying to be — what it has to
 * be is *the same on every render*, so a place keeps its colour between the
 * shortlist, the board and the hero.
 */
function hash(value: string): number {
  let h = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    h ^= value.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * THE GRAPHIC THAT STANDS IN FOR A PHOTOGRAPH, DERIVED FROM WHAT WE KNOW.
 *
 * Not a placeholder. A placeholder is a grey box that says the system failed; a
 * destination with no free photograph has not failed at anything, and most
 * destinations on earth are in that position. So the absence produces an object
 * with a hue, a horizon and a described meaning, all computed from the subject's
 * own record: the latitude sets how high the horizon sits, the longitude shifts
 * the bands across the frame, and the identity sets the colour. Two different
 * places look different; one place looks the same everywhere it appears.
 *
 * The screen-reader description is part of the object rather than the
 * component's business, because a fallback whose textual equivalent said "image"
 * would be worse than no image at all.
 */
export function imageryFallbackFor(input: ImagerySubjectFallbackInput): ImageryFallback {
  const seed = hash(`${input.kind}:${input.id}`);
  const hue = seed % 360;

  const coordinates = input.coordinates;
  const clusterCount = input.clusterCount ?? 0;

  /*
   * Latitude decides the horizon, and the mapping is deliberately compressed
   * into the middle half of the frame. A pole would otherwise put the horizon on
   * the frame edge, which reads as a rendering fault rather than as a high
   * latitude.
   */
  const horizon = coordinates
    ? clamp01(0.28 + ((90 - coordinates.lat) / 180) * 0.44)
    : 0.5;
  const drift = coordinates ? clamp01((coordinates.lng + 180) / 360) : ((seed >>> 8) % 100) / 100;

  if (clusterCount > 1) {
    return {
      kind: 'cluster_graphic',
      label: input.name,
      hue,
      horizon,
      drift,
      marks: Math.min(clusterCount, 12),
      description: `A generated graphic for ${input.name}, showing the ${clusterCount} areas this trip covers. No freely licensed photograph of it was available.`,
    };
  }

  if (coordinates) {
    return {
      kind: 'regional_graphic',
      label: input.name,
      hue,
      horizon,
      drift,
      marks: 1,
      description: `A generated graphic for ${input.name}, drawn from its position at ${coordinates.lat.toFixed(1)}°, ${coordinates.lng.toFixed(1)}°. No freely licensed photograph of it was available.`,
    };
  }

  return {
    kind: 'typographic',
    label: input.name,
    hue,
    horizon,
    drift,
    marks: 0,
    description: `A generated graphic showing the name ${input.name}. No freely licensed photograph of it was available, and we hold no coordinates to draw from.`,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** The confidence category a basis earns. Exported so a surface can gate on it. */
export function subjectConfidenceFor(basis: SubjectMatchBasis) {
  return SUBJECT_CONFIDENCE_OF[basis];
}
