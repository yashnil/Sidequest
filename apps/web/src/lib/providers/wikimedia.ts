import 'server-only';
import { z } from 'zod';
import {
  IMAGERY_CONTRACT_VERSION,
  evaluateImageCandidate,
  imagerySubjectKey,
  type ImageryOutcome,
  type ImageSubject,
  type RawImageCandidate,
  type RawLicenceMetadata,
  type SubjectMatchBasis,
} from '@sidequest/core';
import { providerUserAgent } from '../net/user-agent';

/**
 * WIKIMEDIA COMMONS, AS THE ONLY PLACE A PHOTOGRAPH MAY COME FROM.
 *
 * The lookup key was already in the data model before this file existed:
 * `DestinationIndexEntry.wikidataId` is populated from the place catalogue's own
 * `wikidata` field, and the backbone already treats a shared Wikidata id as
 * linkage evidence. So imagery is not a new identifier problem — it is the
 * existing identifier, followed one hop further, to a corpus whose licences are
 * published as structured fields rather than inferred from a footer.
 *
 * ---
 *
 * THE RESOLUTION LADDER, AND WHY IT IS AN ORDER RATHER THAN A SEARCH.
 *
 * A search returns *a picture of something with this name*. Almost every
 * destination name on earth is shared by a village, a river, a football club and
 * a brand of beer, and the failure mode of "search and take the first result" is
 * not a slightly worse picture — it is confidently illustrating one country with
 * a photograph taken in another. So the ladder is four *relationships between
 * identifiers*, tried strongest first, and a free-text query is never one of
 * them:
 *
 *   (a) **The entity states its own image.** P948 (page banner — curated for
 *       exactly this use by the travel wiki), then P18, then P3451 (night view).
 *       Never P1943/P242/P41/P94/P154: location maps, flags, coats of arms and
 *       logos are visually wrong for a hero *and* carry the highest trademark
 *       exposure of anything on the site.
 *
 *   (b) **The entity's linked encyclopedia article leads with an image.** The
 *       article is linked by sitelink, not matched by title, so this is still an
 *       identifier relationship. The file name comes from the article; the
 *       licence is still read from Commons, which is the rule that matters —
 *       some projects host non-free files under a fair-use exemption that
 *       belongs to them and not to us, and such a file simply is not on Commons,
 *       so the licence read fails and we fall through.
 *
 *   (c) **The entity states a media category**, and the file is filed *directly*
 *       in it. A statement about a group rather than about a photograph, hence
 *       moderate confidence and no hero.
 *
 *   (d) **A bounded search against an identity we already hold** — the indexed
 *       name plus its administrative parents, never a sentence a traveller
 *       typed, and never run at all unless we hold a parent to corroborate
 *       against. More than one plausible result is an `ambiguous_subject`
 *       refusal rather than a coin toss.
 *
 *   (e) **The deliberate fallback**, which is not this file's business: the
 *       outcome comes back as a refusal with a reason, and the component draws a
 *       designed graphic from the coordinates.
 *
 * ---
 *
 * THREE OPERATIONAL RULES, EACH OF WHICH HAS A CONCRETE FAILURE BEHIND IT.
 *
 * **The User-Agent is contractual.** Wikimedia's Terms of Use incorporate the
 * User-Agent Policy by reference, and a non-compliant client drops from 200
 * requests a minute to 10 — a twentyfold loss that presents as "the image
 * service is slow" rather than as a policy breach. `providerUserAgent()` exists
 * because a placeholder agent string already cost this product every Overpass
 * response with a 406.
 *
 * **Thumbnail URLs are taken, never constructed.** Wikimedia rejects direct
 * requests at non-standard sizes, so a URL built by string concatenation works
 * against a warm cache in development and is refused in production. We ask for a
 * standard width and store whatever `thumburl` comes back.
 *
 * **Nothing here decides whether an image may be shown.** Every candidate goes
 * through `evaluateImageCandidate`, in `@sidequest/core`, which is pure and
 * shared. A provider that could accept its own output would be a provider that
 * could quietly widen the licence allow-list.
 */

export const IMAGERY_PROVIDER = 'wikimedia-commons';

const WIKIDATA_ENDPOINT = 'https://www.wikidata.org/w/api.php';
const COMMONS_ENDPOINT = 'https://commons.wikimedia.org/w/api.php';
const WIKIPEDIA_ENDPOINT = 'https://en.wikipedia.org/w/api.php';

/**
 * One of the standard widths Wikimedia serves. Anything else is refused at the
 * edge, which is why this is a constant and not a prop.
 */
const THUMB_WIDTH = 960;

/** Read-only lookups. A slow answer is a missing picture, never a failed build. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * The whole budget for one subject, across every rung of the ladder.
 *
 * A ceiling rather than an ambition. Imagery is the least important thing a
 * compilation does, and a subject that has consumed six requests without
 * producing a licensable photograph has answered the question.
 */
const MAX_CALLS_PER_SUBJECT = 6;

/** Bounded search: five results is enough to notice ambiguity and few enough to read. */
const MAX_SEARCH_RESULTS = 5;

/** Direct members of a stated category, in the order the category lists them. */
const MAX_CATEGORY_FILES = 8;

const USER_AGENT = providerUserAgent('destination imagery');

/**
 * Image properties, in preference order.
 *
 * P948 first because it is the page banner property, curated by the travel wiki
 * for precisely the "wide image at the top of a destination page" use this
 * product has. P18 is the general one. P3451 is a night view, kept last because
 * a night photograph is a poor default for a place somebody is deciding whether
 * to visit.
 */
const IMAGE_PROPERTIES = ['P948', 'P18', 'P3451'] as const;

/** The extensions the record schema can render. P18's own constraint permits `pdf` and `djvu`. */
const RENDERABLE_EXTENSION = /\.(jpe?g|png|webp)$/i;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

const snakSchema = z.object({
  mainsnak: z
    .object({
      snaktype: z.string().optional(),
      datavalue: z.object({ value: z.unknown() }).optional(),
    })
    .optional(),
});

const entitiesSchema = z.object({
  entities: z
    .record(
      z.string(),
      z.object({
        missing: z.unknown().optional(),
        claims: z.record(z.string(), z.array(snakSchema)).optional(),
        sitelinks: z.record(z.string(), z.object({ title: z.string() })).optional(),
      }),
    )
    .optional(),
});

const extmetadataSchema = z.record(z.string(), z.object({ value: z.unknown() }).partial());

const imageInfoSchema = z.object({
  query: z
    .object({
      pages: z
        .record(
          z.string(),
          z.object({
            title: z.string().optional(),
            missing: z.unknown().optional(),
            imageinfo: z
              .array(
                z.object({
                  descriptionurl: z.string().optional(),
                  thumburl: z.string().optional(),
                  thumbwidth: z.number().optional(),
                  thumbheight: z.number().optional(),
                  width: z.number().optional(),
                  height: z.number().optional(),
                  mime: z.string().optional(),
                  extmetadata: extmetadataSchema.optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const categoryMembersSchema = z.object({
  query: z
    .object({
      categorymembers: z.array(z.object({ title: z.string(), ns: z.number().optional() })).optional(),
    })
    .optional(),
});

const searchSchema = z.object({
  query: z
    .object({
      search: z
        .array(z.object({ title: z.string(), snippet: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

const pageImagesSchema = z.object({
  query: z
    .object({
      pages: z
        .record(z.string(), z.object({ pageimage: z.string().optional() }))
        .optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ImageryCache {
  read: (key: string) => ImageryOutcome | null;
  write: (key: string, value: ImageryOutcome) => void;
}

export interface ResolveImageOptions {
  fetchImpl?: typeof fetch;
  /** Injected so the record's `retrievedAt` is a decision rather than a side effect. */
  now?: Date;
  /**
   * Persisted metadata, read back before anything is requested.
   *
   * The store is the cache. There is no second in-memory layer, because the
   * expensive thing is not the round trip — it is asking a volunteer-run service
   * a question somebody already answered and wrote down.
   */
  cache?: ImageryCache;
}

export interface ResolveImageResult {
  outcome: ImageryOutcome;
  calls: number;
  cacheHit: boolean;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

interface FileLead {
  /** Canonical `File:…` title. The provider's primary key for a photograph. */
  title: string;
  basis: SubjectMatchBasis;
  relationship: string;
  ambiguousWith?: number;
  nameSimilarityOnly?: boolean;
}

/**
 * Resolve one subject to one image record, or to one recorded refusal.
 *
 * Never throws and never rejects. Losing imagery costs a picture; a compilation
 * that fell over because a read-only wiki was busy would be a worse product than
 * one that showed a coordinate-derived graphic — which is a design this codebase
 * already committed to when it drew the fallback as a designed object rather
 * than as an absence.
 */
export async function resolveDestinationImage(
  subject: ImageSubject,
  options: ResolveImageOptions = {},
): Promise<ResolveImageResult> {
  const key = imagerySubjectKey(subject);
  const cached = options.cache?.read(key) ?? null;
  if (cached) return { outcome: cached, calls: 0, cacheHit: true };

  const context = {
    provider: IMAGERY_PROVIDER,
    contractVersion: IMAGERY_CONTRACT_VERSION,
    retrievedAt: (options.now ?? new Date()).toISOString(),
  };
  const doFetch = options.fetchImpl ?? fetch;
  const budget = { calls: 0 };

  let firstRejection: ImageryOutcome | null = null;

  try {
    for await (const lead of leads(subject, doFetch, budget)) {
      const info = await fileInfo(lead.title, doFetch, budget);
      if (!info) continue;

      const candidate: RawImageCandidate = {
        fileTitle: lead.title,
        filePageUrl: info.filePageUrl,
        thumbnailUrl: info.thumbnailUrl,
        width: info.width,
        height: info.height,
        mediaType: info.mediaType,
        metadata: info.metadata,
        match: {
          basis: lead.basis,
          relationship: lead.relationship,
          ...(lead.ambiguousWith === undefined ? {} : { ambiguousWith: lead.ambiguousWith }),
          ...(lead.nameSimilarityOnly ? { nameSimilarityOnly: true } : {}),
        },
      };

      const outcome = evaluateImageCandidate(subject, candidate, context);
      if (outcome.status === 'accepted') {
        options.cache?.write(key, outcome);
        return { outcome, calls: budget.calls, cacheHit: false };
      }
      /*
       * Keep the *first* refusal, which came from the strongest rung of the
       * ladder. "The place's own stated image is non-commercial" is a more
       * useful thing to have written down than "the fourth search result was
       * ambiguous", and the weaker rungs are still tried underneath it.
       */
      firstRejection ??= outcome;
    }
  } catch {
    /*
     * An abort, a DNS failure, a 503 behind a proxy that returns HTML. All of
     * them mean the same thing here and all of them are recorded as the same
     * thing, so that a subject skipped because a service was down is
     * distinguishable from one skipped because its photograph was unlicensable.
     */
    return { outcome: unavailable(subject, context), calls: budget.calls, cacheHit: false };
  }

  const outcome =
    firstRejection ??
    /*
     * No lead at all. Recorded as `provider_unavailable` rather than invented as
     * a more specific reason: we did not refuse a file, there was no file.
     */
    unavailable(subject, context);
  options.cache?.write(key, outcome);
  return { outcome, calls: budget.calls, cacheHit: false };
}

function unavailable(
  subject: ImageSubject,
  context: { provider: string; contractVersion: string; retrievedAt: string },
): ImageryOutcome {
  return {
    status: 'rejected',
    rejection: {
      schemaVersion: 1,
      subject,
      reason: 'provider_unavailable',
      provider: context.provider,
      contractVersion: context.contractVersion,
      retrievedAt: context.retrievedAt,
    },
  };
}

/**
 * The ladder, as a generator, so a rung is only paid for if the ones above it
 * produced nothing usable.
 */
async function* leads(
  subject: ImageSubject,
  doFetch: typeof fetch,
  budget: { calls: number },
): AsyncGenerator<FileLead> {
  const entity = subject.wikidataId
    ? await wikidataEntity(subject.wikidataId, doFetch, budget)
    : null;

  // (a) the entity's own stated image.
  if (entity && subject.wikidataId) {
    for (const property of IMAGE_PROPERTIES) {
      const filename = firstFilenameClaim(entity.claims?.[property]);
      if (!filename) continue;
      yield {
        title: `File:${filename}`,
        basis: 'wikidata_image_property',
        relationship: `${subject.wikidataId}|${property}`,
      };
    }
  }

  // (b) the linked Wikimedia identity: a directly linked file, then the linked
  //     article's own lead image.
  if (entity && subject.wikidataId) {
    const commonsTitle = entity.sitelinks?.commonswiki?.title;
    if (commonsTitle?.startsWith('File:') && RENDERABLE_EXTENSION.test(commonsTitle)) {
      yield {
        title: commonsTitle,
        basis: 'linked_wikimedia_identity',
        relationship: `${subject.wikidataId}|commonswiki:${commonsTitle}`,
      };
    }

    const article = entity.sitelinks?.enwiki?.title;
    if (article) {
      const filename = await articleLeadImage(article, doFetch, budget);
      if (filename && RENDERABLE_EXTENSION.test(filename)) {
        yield {
          title: `File:${filename}`,
          basis: 'linked_wikimedia_identity',
          relationship: `${subject.wikidataId}|enwiki:${article}`,
        };
      }
    }
  }

  // (c) a category the entity itself states.
  const statedCategory =
    entity?.sitelinks?.commonswiki?.title?.startsWith('Category:') === true
      ? entity.sitelinks.commonswiki.title
      : categoryClaim(entity?.claims?.P373);
  if (statedCategory && subject.wikidataId) {
    for (const title of await categoryFiles(statedCategory, doFetch, budget)) {
      yield {
        title,
        basis: 'verified_commons_category',
        relationship: `${subject.wikidataId}|commons:${statedCategory}`,
      };
    }
  }

  // (d) a bounded search against an identity we already hold.
  //
  //     Refused outright without a parent to corroborate against: a bare name
  //     with nothing to check it by is a free-text query wearing a lookup's
  //     clothes, and that is the thing the whole ladder exists to avoid.
  const parents = subject.hierarchy.filter((entry) => entry !== subject.name);
  if (parents.length > 0) {
    yield* searchLeads(subject, parents, doFetch, budget);
  }
}

// ---------------------------------------------------------------------------
// Individual lookups
// ---------------------------------------------------------------------------

interface Entity {
  claims?: Record<string, z.infer<typeof snakSchema>[]>;
  sitelinks?: Record<string, { title: string }>;
}

async function wikidataEntity(
  id: string,
  doFetch: typeof fetch,
  budget: { calls: number },
): Promise<Entity | null> {
  const url = new URL(WIKIDATA_ENDPOINT);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', id);
  url.searchParams.set('props', 'claims|sitelinks');
  url.searchParams.set('sitefilter', 'commonswiki|enwiki');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const parsed = await requestJson(url, entitiesSchema, doFetch, budget);
  const entity = parsed?.entities?.[id];
  if (!entity || entity.missing !== undefined) return null;
  return entity;
}

/**
 * The lead image of a linked article.
 *
 * `piprop=name` returns a bare file name and nothing else — no URL, no licence,
 * no author. That is deliberate on our side as well as theirs: the *only* thing
 * taken from a Wikipedia is the name of a file, and everything that decides
 * whether it may be shown is read from Commons afterwards.
 */
async function articleLeadImage(
  title: string,
  doFetch: typeof fetch,
  budget: { calls: number },
): Promise<string | null> {
  const url = new URL(WIKIPEDIA_ENDPOINT);
  url.searchParams.set('action', 'query');
  url.searchParams.set('prop', 'pageimages');
  url.searchParams.set('piprop', 'name');
  url.searchParams.set('titles', title);
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const parsed = await requestJson(url, pageImagesSchema, doFetch, budget);
  for (const page of Object.values(parsed?.query?.pages ?? {})) {
    if (page.pageimage) return page.pageimage;
  }
  return null;
}

async function categoryFiles(
  category: string,
  doFetch: typeof fetch,
  budget: { calls: number },
): Promise<string[]> {
  const url = new URL(COMMONS_ENDPOINT);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'categorymembers');
  url.searchParams.set('cmtitle', category);
  url.searchParams.set('cmtype', 'file');
  url.searchParams.set('cmlimit', String(MAX_CATEGORY_FILES));
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const parsed = await requestJson(url, categoryMembersSchema, doFetch, budget);
  return (parsed?.query?.categorymembers ?? [])
    .map((member) => member.title)
    .filter((title) => RENDERABLE_EXTENSION.test(title))
    .slice(0, 2);
}

/**
 * The bounded search, and the ambiguity check that is the point of it.
 *
 * The query is built from the indexed name and one administrative parent — both
 * of them values this product already holds and can check a result against. A
 * result whose title or snippet mentions no parent is flagged
 * `nameSimilarityOnly`, and the gate refuses it: two towns of the same name in
 * two countries is the single most likely way to put the wrong photograph on a
 * page, and "the names matched" is exactly the evidence that cannot tell them
 * apart.
 */
async function* searchLeads(
  subject: ImageSubject,
  parents: readonly string[],
  doFetch: typeof fetch,
  budget: { calls: number },
): AsyncGenerator<FileLead> {
  const url = new URL(COMMONS_ENDPOINT);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srnamespace', '6');
  url.searchParams.set('srlimit', String(MAX_SEARCH_RESULTS));
  url.searchParams.set('srsearch', `"${subject.name}" "${parents[0]}"`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const parsed = await requestJson(url, searchSchema, doFetch, budget);
  const results = (parsed?.query?.search ?? []).filter((result) =>
    RENDERABLE_EXTENSION.test(result.title),
  );
  if (results.length === 0) return;

  /*
   * The subject's own name is removed from the haystack before the parent is
   * looked for, and that removal is the whole check rather than a tidy-up.
   *
   * Administrative hierarchies nest their names — a city inside a region of
   * almost the same name is the normal case, not the exception. Without this,
   * a file titled "<name> football club squad photo" corroborates against its
   * own parent, because the parent is a substring of the subject's name and the
   * title contains the subject's name by construction. Every search result
   * would then look corroborated and the rung would be a free-text search with
   * a check that could not fail.
   */
  const withoutSubjectName = (value: string): string =>
    value.toLowerCase().split(subject.name.toLowerCase()).join(' ');

  const corroborated = results.filter((result) => {
    const haystack = withoutSubjectName(`${result.title} ${result.snippet ?? ''}`);
    return parents.some((parent) => haystack.includes(parent.toLowerCase()));
  });

  if (corroborated.length === 0) {
    // Something matched the name and nothing confirmed the place. Yielded rather
    // than dropped, so the refusal is *recorded* with `weak_name_match` instead
    // of the subject silently having no imagery history at all.
    const first = results[0];
    if (!first) return;
    yield {
      title: first.title,
      basis: 'bounded_identity_search',
      relationship: `${subject.id}|commons-search`,
      nameSimilarityOnly: true,
    };
    return;
  }

  const first = corroborated[0];
  if (!first) return;
  yield {
    title: first.title,
    basis: 'bounded_identity_search',
    relationship: `${subject.id}|commons-search:${parents[0]}`,
    ambiguousWith: distinctSubjectCount({ results, corroborated, subject, parents }),
  };
}

/**
 * HOW MANY DIFFERENT PLACES THESE FILES ARE ABOUT — NOT HOW MANY FILES THERE ARE.
 *
 * `ambiguousWith` is documented in the gate as "how many equally plausible
 * subjects shared this name", and two or more is fatal. It used to be handed
 * `corroborated.length`, which is a count of *files*. A Commons category holding
 * five photographs of one building therefore read as five competing buildings,
 * and the last rung of the ladder refused almost everything it found — the
 * opposite of the failure the check exists to prevent, and invisible because a
 * refusal looks like an absence.
 *
 * The count is built the other way round. Files that this subject's own
 * administrative hierarchy corroborated are, by construction, about this
 * subject: they matched the name *and* a place we already know contains it. All
 * of them together are **one** subject, however many of them there are.
 *
 * The genuine competitor is the file that matched the name and could not be tied
 * to this place at all — the second Springfield. Those are grouped by the
 * disambiguating context their titles carry, so five photographs of one other
 * town count once and two other towns count twice. The grouping is deliberately
 * coarse: it errs towards *merging* competitors, because a false merge costs one
 * image on one card and a false split silently suppresses every image the rung
 * would ever have found.
 *
 * Generic by construction: nothing here knows any place name. The subject's own
 * name and its ancestors come from the caller, and the qualifier vocabulary is
 * about photographs rather than about geography.
 */
export function distinctSubjectCount(input: {
  results: readonly { title: string; snippet?: string }[];
  corroborated: readonly { title: string; snippet?: string }[];
  subject: ImageSubject;
  parents: readonly string[];
}): number {
  const corroboratedTitles = new Set(input.corroborated.map((result) => result.title));
  const competitors = input.results.filter((result) => !corroboratedTitles.has(result.title));

  const clusters = clusterBySharedWord(
    competitors.map((result) => contextWordsOf(result.title, input.subject.name)),
  );

  // One for this subject when anything corroborated it, plus one per distinct
  // competing place. Zero corroboration never reaches here.
  return (input.corroborated.length > 0 ? 1 : 0) + clusters;
}

/**
 * Two titles are about the same place if they share any qualifying word.
 *
 * Greedy single-linkage, which is the *merging* direction on purpose. "<other
 * town> town hall" and "<other town> riverfront in winter" share the qualifier
 * and become one competitor; two genuinely different towns share nothing and stay
 * two. Getting this wrong by merging costs at most one accepted image; getting it
 * wrong by splitting suppresses every image this rung would ever find, which is
 * the defect being corrected.
 *
 * Titles with no qualifier at all form a single cluster between them rather than
 * one each, for the same reason.
 */
function clusterBySharedWord(wordSets: readonly Set<string>[]): number {
  const clusters: Set<string>[] = [];
  const unqualified = wordSets.filter((words) => words.size === 0).length;

  for (const words of wordSets) {
    if (words.size === 0) continue;
    const joined = clusters.filter((cluster) => [...words].some((word) => cluster.has(word)));
    if (joined.length === 0) {
      clusters.push(new Set(words));
      continue;
    }
    // Merge every cluster this one touches, so a title that bridges two earlier
    // clusters collapses them rather than creating a third.
    const merged = new Set<string>(words);
    for (const cluster of joined) for (const word of cluster) merged.add(word);
    for (const cluster of joined) clusters.splice(clusters.indexOf(cluster), 1);
    clusters.push(merged);
  }

  return clusters.length + (unqualified > 0 ? 1 : 0);
}

/**
 * Words that describe a photograph rather than a place.
 *
 * Stripped before two titles are compared, so "<other town> town hall" and
 * "<other town> aerial view 2019" group together instead of counting twice.
 * Extending this list makes the count more conservative, which is the safe
 * direction.
 */
const PHOTOGRAPHIC_VOCABULARY = new Set([
  'aerial', 'view', 'views', 'panorama', 'panoramic', 'photo', 'photograph', 'image',
  'picture', 'jpg', 'jpeg', 'png', 'webp', 'file', 'the', 'and', 'from', 'with', 'near',
  'looking', 'seen', 'towards', 'toward', 'over', 'across', 'detail', 'closeup', 'close',
  'up', 'north', 'south', 'east', 'west', 'centre', 'center', 'general', 'overview',
]);

/**
 * The part of a file title that says *which* place it is about.
 *
 * The subject's own name is removed first — every result contains it, so leaving
 * it in would make every title look alike. Digits go because a year is not a
 * place. What is left is the qualifier: the second town's region, the country in
 * brackets, the disambiguator an editor added precisely so a human could tell
 * them apart.
 *
 * A title left with nothing is not dropped: every such title joins one shared
 * bucket, because "we cannot tell what this is about" is a single kind of unknown
 * and splitting it per file would reintroduce the file count this replaces.
 */
function contextWordsOf(title: string, subjectName: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(subjectName.toLowerCase())
      .join(' ')
      .replace(/[^\p{L}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !PHOTOGRAPHIC_VOCABULARY.has(word)),
  );
}

interface FileInfo {
  filePageUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  mediaType: string;
  metadata: RawLicenceMetadata;
}

/**
 * The licence read. Always against Commons, whatever named the file.
 *
 * `iiextmetadatafilter` is set because the API's own help says `extmetadata` is
 * "an expensive property to request", and asking for eleven named fields instead
 * of the whole block is the difference between a polite client and one that gets
 * throttled.
 */
async function fileInfo(
  title: string,
  doFetch: typeof fetch,
  budget: { calls: number },
): Promise<FileInfo | null> {
  const url = new URL(COMMONS_ENDPOINT);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', title);
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|size|mime|extmetadata');
  url.searchParams.set('iiurlwidth', String(THUMB_WIDTH));
  url.searchParams.set(
    'iiextmetadatafilter',
    [
      'License',
      'LicenseShortName',
      'LicenseUrl',
      'Artist',
      'Credit',
      'Attribution',
      'AttributionRequired',
      'Restrictions',
      'NonFree',
      'DeletionReason',
    ].join('|'),
  );
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const parsed = await requestJson(url, imageInfoSchema, doFetch, budget);
  for (const page of Object.values(parsed?.query?.pages ?? {})) {
    if (page.missing !== undefined) continue;
    const info = page.imageinfo?.[0];
    if (!info) continue;

    /*
     * `thumburl` when there is one, and the description URL is required: a file
     * with no canonical page is a file whose attribution obligation we could not
     * discharge even if the licence were perfect.
     */
    const thumbnailUrl = info.thumburl;
    if (!thumbnailUrl || !info.descriptionurl) continue;

    return {
      filePageUrl: info.descriptionurl,
      thumbnailUrl,
      width: Math.trunc(info.thumbwidth ?? info.width ?? 0),
      height: Math.trunc(info.thumbheight ?? info.height ?? 0),
      mediaType: info.mime ?? '',
      metadata: readMetadata(info.extmetadata),
    };
  }
  return null;
}

/**
 * `extmetadata`, flattened into strings and nothing else.
 *
 * Every value is coerced with `String()` and left otherwise untouched — no
 * trimming, no tag stripping, no unescaping. Sanitation belongs to the gate, in
 * one place, and a provider that cleaned values on the way past would be a
 * second sanitiser with a slightly different opinion, which is how the one that
 * matters stops being the one that runs.
 */
function readMetadata(
  raw: z.infer<typeof extmetadataSchema> | undefined,
): RawLicenceMetadata {
  const read = (field: string): string | undefined => {
    const value = raw?.[field]?.value;
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  };
  return {
    ...maybe('licenceShortName', read('LicenseShortName')),
    ...maybe('licence', read('License')),
    ...maybe('licenceUrl', read('LicenseUrl')),
    ...maybe('artist', read('Artist')),
    ...maybe('credit', read('Credit')),
    ...maybe('attribution', read('Attribution')),
    ...maybe('attributionRequired', read('AttributionRequired')),
    ...maybe('restrictions', read('Restrictions')),
    ...maybe('nonFree', read('NonFree')),
    ...maybe('deletionReason', read('DeletionReason')),
  };
}

function maybe<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function firstFilenameClaim(claims: z.infer<typeof snakSchema>[] | undefined): string | null {
  for (const claim of claims ?? []) {
    if (claim.mainsnak?.snaktype !== 'value') continue;
    const value = claim.mainsnak.datavalue?.value;
    if (typeof value !== 'string') continue;
    if (!RENDERABLE_EXTENSION.test(value)) continue;
    return value;
  }
  return null;
}

function categoryClaim(claims: z.infer<typeof snakSchema>[] | undefined): string | null {
  for (const claim of claims ?? []) {
    if (claim.mainsnak?.snaktype !== 'value') continue;
    const value = claim.mainsnak.datavalue?.value;
    if (typeof value !== 'string' || !value.trim()) continue;
    return value.startsWith('Category:') ? value : `Category:${value}`;
  }
  return null;
}

/**
 * One request, budgeted, timed out, and parsed or discarded.
 *
 * Returns null on every failure mode rather than distinguishing them, because
 * the caller does the same thing with all of them: drop down a rung. Throwing
 * would be the wrong shape — the ladder is *designed* to have rungs that produce
 * nothing.
 */
async function requestJson<T>(
  url: URL,
  schema: z.ZodType<T>,
  doFetch: typeof fetch,
  budget: { calls: number },
): Promise<T | null> {
  if (budget.calls >= MAX_CALLS_PER_SUBJECT) return null;
  budget.calls += 1;

  const response = await doFetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const parsed = schema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Which resolver a deployment runs
// ---------------------------------------------------------------------------

export type ImageryMode = 'off' | 'wikimedia' | 'fixture';

/**
 * Live imagery is **opt-in**, and that is a decision rather than an oversight.
 *
 * Two things are still unresolved and both of them are infrastructure rather
 * than code: where ingested bytes would live if we stopped pointing browsers at
 * `upload.wikimedia.org`, and whether to register for the authenticated request
 * tier before a cold-start seeding run. Until those are answered, a deployment
 * that has not said it wants live imagery gets deliberate fallbacks, which are
 * designed objects and not a degraded state.
 *
 * Unset, the mode follows the compiler: a deployment running its whole stack on
 * fixtures must not be the one deployment that reaches a live volunteer service.
 * That is what makes the browser suite offline without a second switch.
 */
export function imageryMode(): ImageryMode {
  const explicit = process.env.SIDEQUEST_IMAGERY_PROVIDER?.trim().toLowerCase();
  if (explicit === 'wikimedia' || explicit === 'fixture' || explicit === 'off') return explicit;
  return process.env.SIDEQUEST_COMPILER_PROVIDER?.trim().toLowerCase() === 'fixture'
    ? 'fixture'
    : 'off';
}

/**
 * The fixture resolver: deterministic, offline, and still gated.
 *
 * It builds a raw candidate and puts it through `evaluateImageCandidate` exactly
 * as the live path does, so a fixture cannot produce a record the gate would
 * have refused — which is what stops the browser suite proving that a screen
 * renders something the real provider could never legally have supplied.
 *
 * One subject in three is refused, because a page where every card has a
 * photograph is not the page this product will ever actually show.
 */
export function fixtureImage(subject: ImageSubject, now: Date): ImageryOutcome {
  const context = {
    provider: IMAGERY_PROVIDER,
    contractVersion: IMAGERY_CONTRACT_VERSION,
    retrievedAt: now.toISOString(),
  };
  const key = imagerySubjectKey(subject);
  let seed = 0;
  for (let index = 0; index < key.length; index += 1) seed = (seed * 31 + key.charCodeAt(index)) >>> 0;

  if (seed % 3 === 0) {
    return {
      status: 'rejected',
      rejection: {
        schemaVersion: 1,
        subject,
        reason: 'unsupported_licence',
        detail: 'fixture: refused so the fallback path is exercised',
        provider: IMAGERY_PROVIDER,
        contractVersion: IMAGERY_CONTRACT_VERSION,
        retrievedAt: context.retrievedAt,
      },
    };
  }

  const slug = `${(seed % 97) + 1}`;
  const shareAlike = seed % 2 === 0;
  return evaluateImageCandidate(
    subject,
    {
      fileTitle: `File:Fixture ${slug}.jpg`,
      filePageUrl: `https://commons.wikimedia.org/wiki/File:Fixture_${slug}.jpg`,
      thumbnailUrl: `https://upload.wikimedia.org/wikipedia/commons/thumb/f/ff/Fixture_${slug}.jpg/960px-Fixture_${slug}.jpg`,
      width: 960,
      height: 640,
      mediaType: 'image/jpeg',
      metadata: {
        licenceShortName: shareAlike ? 'CC BY-SA 4.0' : 'CC BY 4.0',
        artist: `Fixture contributor ${slug}`,
        attributionRequired: 'true',
      },
      match: {
        basis: subject.wikidataId ? 'wikidata_image_property' : 'verified_commons_category',
        relationship: `${subject.wikidataId ?? subject.id}|fixture`,
      },
    },
    context,
  );
}

/**
 * The one entry point everything else uses.
 *
 * Callers do not choose a provider; the deployment does. That keeps the mode
 * check in one place rather than at each of the three call sites, which is where
 * "this screen reached a live service and the other two did not" comes from.
 */
export async function resolveImagery(
  subject: ImageSubject,
  options: ResolveImageOptions = {},
): Promise<ResolveImageResult> {
  const now = options.now ?? new Date();
  const mode = imageryMode();

  if (mode === 'off') {
    return {
      outcome: unavailable(subject, {
        provider: IMAGERY_PROVIDER,
        contractVersion: IMAGERY_CONTRACT_VERSION,
        retrievedAt: now.toISOString(),
      }),
      calls: 0,
      cacheHit: false,
    };
  }

  if (mode === 'fixture') {
    const cached = options.cache?.read(imagerySubjectKey(subject)) ?? null;
    if (cached) return { outcome: cached, calls: 0, cacheHit: true };
    const outcome = fixtureImage(subject, now);
    options.cache?.write(imagerySubjectKey(subject), outcome);
    return { outcome, calls: 0, cacheHit: false };
  }

  return resolveDestinationImage(subject, { ...options, now });
}

/**
 * The batch entry point, for callers that hold a set of subjects at once.
 *
 * **Sequential, and capped.** Fanning twenty concurrent requests at a
 * volunteer-run service is the pattern its API etiquette explicitly asks clients
 * not to build, and the cap exists because imagery is the least important thing
 * any caller of this is doing — a compilation that spent two extra minutes on
 * photographs would have spent it on the wrong thing.
 *
 * Never throws. A subject whose lookup fell over is skipped; the others carry
 * on; and the caller's own work is never at risk from a picture.
 */
export async function resolveImageryForSubjects(
  subjects: readonly ImageSubject[],
  options: ResolveImageOptions & { limit?: number } = {},
): Promise<{ resolved: number; accepted: number; calls: number }> {
  const limit = options.limit ?? 12;
  let resolved = 0;
  let accepted = 0;
  let calls = 0;

  for (const subject of subjects.slice(0, limit)) {
    try {
      const result = await resolveImagery(subject, options);
      resolved += 1;
      calls += result.calls;
      if (result.outcome.status === 'accepted') accepted += 1;
    } catch (error) {
      console.error('Imagery lookup failed', { subject: subject.id, error });
    }
  }
  return { resolved, accepted, calls };
}
